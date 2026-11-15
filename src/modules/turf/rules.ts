import type { ClientSession } from "mongodb";
import type { Database, LedgerEntryDoc, TurfBookingDoc, TurfOccurrenceDoc, TurfRules, TurfSportDoc } from "../../platform/db.js";
import { HOUR_MS } from "../coaching/rules.js";

export const DEFAULT_TURF_RULES: TurfRules = {
  refundFullHours: 6,
  refundHalfHours: 2,
  halfPercent: 50,
  minFullHours: 2,
  maxFullHours: 72,
  maxRepeatWeeks: 12,
  holdMinutes: 15,
  slotLengths: [30, 60, 90],
  maxSlots: 12,
  bookAheadDays: 30,
  maxGrounds: 10,
  maxCourts: 20,
  maxAddOns: 10,
};

/** The sports grounds can pick until Ruxstar changes the list. */
export const DEFAULT_SPORTS: readonly { key: string; name: string }[] = [
  { key: "football", name: "Football & futsal" },
  { key: "box_cricket", name: "Box cricket" },
  { key: "cricket_nets", name: "Cricket nets" },
  { key: "badminton", name: "Badminton" },
  { key: "pickleball", name: "Pickleball" },
  { key: "tennis", name: "Tennis" },
  { key: "basketball", name: "Basketball" },
  { key: "volleyball", name: "Volleyball" },
  { key: "table_tennis", name: "Table tennis" },
  { key: "swimming", name: "Swimming" },
];

/** ₹1,00,000 for one slot or add-on. */
export const MAX_PRICE = 1_00_000_00;
export const MAX_PHOTOS = 8;
export const MAX_PEAKS = 5;
/** Turf bookings are numbered from here, apart from the other modules' orders. */
const FIRST_ORDER_NO = 70_000_000;

export const nextTurfOrderNo = async (db: Database, session?: ClientSession) => FIRST_ORDER_NO + (await db.nextNumber("turf-booking", session));

export type TurfSettings = TurfRules & { commissionBps: number; platformFee: number; live: boolean };

export async function turfSettings(db: Database): Promise<TurfSettings> {
  const doc = await db.moduleSettings.findOne({ module: "turf" }, { projection: { turfRules: 1, commissionBps: 1, platformFee: 1, live: 1 } });
  return { ...DEFAULT_TURF_RULES, ...doc?.turfRules, commissionBps: doc?.commissionBps ?? 0, platformFee: doc?.platformFee ?? 0, live: Boolean(doc?.live) };
}

/** What doesn't fit together in a set of rules, if anything. */
export function turfRulesProblem(rules: TurfRules): { field: keyof TurfRules; message: string } | null {
  if (rules.minFullHours > rules.maxFullHours) return { field: "minFullHours", message: "The lowest full-refund hours can't be above the highest." };
  if (rules.refundFullHours < rules.minFullHours || rules.refundFullHours > rules.maxFullHours) {
    return { field: "refundFullHours", message: "The default full-refund hours must be within the limits." };
  }
  if (rules.refundHalfHours > rules.refundFullHours) return { field: "refundHalfHours", message: "The partial refund must start nearer the slot than the full refund." };
  return null;
}

export const turfRulesView = (rules: TurfRules) => ({ ...rules, slotLengths: rules.slotLengths as (30 | 60 | 90)[] });

/** A ground's refund hours held to Ruxstar's limits, with the middle tier's share. */
export function refundRuleOf(refunds: { fullHours: number; halfHours: number }, rules: TurfRules): TurfBookingDoc["refundRule"] {
  const fullHours = Math.min(Math.max(refunds.fullHours, rules.minFullHours), rules.maxFullHours);
  return { fullHours, halfHours: Math.min(refunds.halfHours, fullHours), halfPercent: rules.halfPercent };
}

/** The share a customer gets back cancelling a slot that starts at `startAt`. */
export function refundPercent(rule: TurfBookingDoc["refundRule"], startAt: Date, now = new Date()): number {
  const left = startAt.getTime() - now.getTime();
  if (left <= 0) return 0;
  if (left >= rule.fullHours * HOUR_MS) return 100;
  if (rule.halfHours < rule.fullHours && left >= rule.halfHours * HOUR_MS) return rule.halfPercent;
  return 0;
}

/** "Full refund 6 hours or more before the slot, 50% from 2 hours. No refund after." */
export function refundText(rule: TurfBookingDoc["refundRule"]): string {
  const hours = (n: number) => `${n} hour${n === 1 ? "" : "s"}`;
  const full = rule.fullHours === 0 ? "Full refund until the slot starts." : `Full refund ${hours(rule.fullHours)} or more before the slot.`;
  if (rule.fullHours === 0) return full;
  const half = rule.halfHours < rule.fullHours && rule.halfPercent > 0 ? ` ${rule.halfPercent}% back until ${rule.halfHours === 0 ? "it starts" : `${hours(rule.halfHours)} before`}.` : "";
  return `${full}${half} No refund after that. If the ground cancels, you get everything back.`;
}

/** Splits `total` over `weights` in proportion, whole paise, the remainder on the last. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map((_, i) => (i === weights.length - 1 ? total : 0));
  let left = total;
  return weights.map((w, i) => {
    if (i === weights.length - 1) return left;
    const share = Math.floor((total * w) / sum);
    left -= share;
    return share;
  });
}

export const sportsOf = (docs: Pick<TurfSportDoc, "_id" | "name">[], keys: string[]) =>
  keys.map((key) => ({ key, name: docs.find((d) => d._id === key)?.name ?? key }));

// Money.

const vendorAccount = (booking: TurfBookingDoc) => `vendor:${booking.vendorId.toHexString()}`;
type Row = [string, LedgerEntryDoc["bucket"], number];

/** What of a date stays with the ground and with Ruxstar once its refund, if any, is out. */
export function keptOf(o: TurfOccurrenceDoc) {
  const vendorBack = o.cancellation?.vendorBack ?? 0;
  const refund = o.cancellation?.refund ?? 0;
  return { vendor: o.vendorShare - vendorBack, ruxstar: o.ruxstarShare - (refund - vendorBack) };
}

/**
 * A paid booking: each date's shares wait in pending until it ends. A refund takes its part back out of pending; at the end,
 * what's left moves to withdrawable.
 */
export function turfLedger(
  booking: TurfBookingDoc,
  at: Date,
  move: { kind: "payment" } | { kind: "refund"; n: number; refund: number; vendorBack: number } | { kind: "release"; occurrence: TurfOccurrenceDoc },
): LedgerEntryDoc[] {
  const id = booking._id.toHexString();
  let txnId: string;
  let rows: Row[];
  if (move.kind === "payment") {
    txnId = `payment:${id}`;
    rows = [
      [vendorAccount(booking), "pending", booking.occurrences.reduce((s, o) => s + o.vendorShare, 0)],
      ["ruxstar", "pending", booking.occurrences.reduce((s, o) => s + o.ruxstarShare, 0)],
      ["gateway", "withdrawable", -booking.price.total],
    ];
  } else if (move.kind === "refund") {
    txnId = `refund:${id}:${move.n}`;
    rows = [
      [vendorAccount(booking), "pending", -move.vendorBack],
      ["ruxstar", "pending", -(move.refund - move.vendorBack)],
      ["gateway", "withdrawable", move.refund],
    ];
  } else {
    txnId = `release:${id}:${move.occurrence.n}`;
    const kept = keptOf(move.occurrence);
    rows = [
      [vendorAccount(booking), "pending", -kept.vendor],
      [vendorAccount(booking), "withdrawable", kept.vendor],
      ["ruxstar", "pending", -kept.ruxstar],
      ["ruxstar", "withdrawable", kept.ruxstar],
    ];
  }
  return rows
    .filter(([, , paise]) => paise !== 0)
    .map(([accountId, bucket, signedPaise]) => ({
      txnId,
      kind: move.kind,
      accountId,
      bucket,
      signedPaise,
      source: { type: "turf_booking" as const, id: booking._id },
      at,
    }));
}

/** The ground's share of a booking still to come or kept: what it earns once its dates end. */
export const vendorShareOf = (booking: TurfBookingDoc) => booking.occurrences.reduce((s, o) => s + keptOf(o).vendor, 0);
