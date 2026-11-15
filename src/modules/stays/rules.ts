import type { ClientSession } from "mongodb";
import type { Database, LedgerEntryDoc, StayFacilityDoc, StayReservationDoc, StaysRules } from "../../platform/db.js";
import { DAY_MS, atTime, dayOf } from "../coaching/rules.js";

export const DEFAULT_STAYS_RULES: StaysRules = {
  refundDays: 3,
  maxRefundDays: 30,
  objectionHours: 24,
  maxMonths: 1,
  maxNights: 30,
  holdMinutes: 15,
  bookAheadDays: 60,
  maxProperties: 10,
  maxRooms: 50,
  maxBeds: 12,
};

/** The facilities properties can pick until Ruxstar changes the list. */
export const DEFAULT_FACILITIES: readonly { key: string; name: string }[] = [
  { key: "wifi", name: "Wi-Fi" },
  { key: "ac", name: "Air conditioning" },
  { key: "power_backup", name: "Power backup" },
  { key: "laundry", name: "Laundry" },
  { key: "housekeeping", name: "Housekeeping" },
  { key: "hot_water", name: "Hot water" },
  { key: "ro_water", name: "RO drinking water" },
  { key: "parking", name: "Parking" },
  { key: "cctv", name: "CCTV" },
  { key: "security", name: "Security guard" },
  { key: "lift", name: "Lift" },
  { key: "gym", name: "Gym" },
  { key: "tv", name: "TV" },
  { key: "fridge", name: "Fridge" },
  { key: "kitchen", name: "Kitchen" },
  { key: "study_table", name: "Study table" },
  { key: "wardrobe", name: "Wardrobe" },
];

/** ₹5,00,000 a month or night for one bed or room. */
export const MAX_PRICE = 5_00_000_00;
/** ₹10,00,000 deposit. */
export const MAX_DEPOSIT = 10_00_000_00;
export const MAX_PHOTOS = 10;
export const MAX_NEARBY = 15;
export const MAX_NOTICE_DAYS = 90;
/** Stays reservations are numbered from here, apart from the other modules' orders. */
const FIRST_ORDER_NO = 80_000_000;

export const nextStayOrderNo = async (db: Database, session?: ClientSession) => FIRST_ORDER_NO + (await db.nextNumber("stays-reservation", session));

export type StaysSettings = StaysRules & { commissionBps: number; platformFee: number; live: boolean };

export async function staysSettings(db: Database): Promise<StaysSettings> {
  const doc = await db.moduleSettings.findOne({ module: "stays" }, { projection: { staysRules: 1, commissionBps: 1, platformFee: 1, live: 1 } });
  return { ...DEFAULT_STAYS_RULES, ...doc?.staysRules, commissionBps: doc?.commissionBps ?? 0, platformFee: doc?.platformFee ?? 0, live: Boolean(doc?.live) };
}

/** What doesn't fit together in a set of rules, if anything. */
export function staysRulesProblem(rules: StaysRules): { field: keyof StaysRules; message: string } | null {
  if (rules.refundDays > rules.maxRefundDays) return { field: "refundDays", message: "The refund days can't be above the most a property can ask for." };
  return null;
}

/** A property's refund days held to Ruxstar's limits, which may have changed since it set them. */
export function refundDaysOf(days: number, rules: StaysRules): number {
  return Math.min(Math.max(days, rules.refundDays), Math.max(rules.maxRefundDays, rules.refundDays));
}

/** The last moment a customer can cancel with a full refund. */
export function refundUntil(rule: StayReservationDoc["refundRule"], from: Date): Date {
  return new Date(from.getTime() - rule.days * DAY_MS);
}

/** Whether cancelling now gets everything back. */
export function fullRefundNow(rule: StayReservationDoc["refundRule"], from: Date, now = new Date()): boolean {
  return now.getTime() <= refundUntil(rule, from).getTime();
}

/** "Full refund until 3 days before move-in. No refund after that." */
export function refundText(rule: StayReservationDoc["refundRule"]): string {
  const when = rule.days === 0 ? "until move-in day" : `until ${rule.days} day${rule.days === 1 ? "" : "s"} before move-in`;
  return `Full refund ${when}. No refund after that. If the property cancels, you get everything back.`;
}

/** The start of a day in India. */
export const startOf = (day: string) => atTime(day, "00:00");
export const today = (now = new Date()) => dayOf(now);

export const facilitiesOf = (docs: Pick<StayFacilityDoc, "_id" | "name">[], keys: string[]) =>
  keys.map((key) => ({ key, name: docs.find((d) => d._id === key)?.name ?? key }));

// Money.

const discountFrom = (r: Pick<StayReservationDoc, "price">, fundedBy: "ruxstar" | "vendor") =>
  r.price.coupon?.fundedBy === fundedBy ? (r.price.discount ?? 0) : 0;
/** The owner's share: the rent less their own coupon and Ruxstar's commission. */
export const vendorShareOf = (r: Pick<StayReservationDoc, "price">) => r.price.items - discountFrom(r, "vendor") - r.price.commission;
/** Ruxstar's commission and platform fee, less a Ruxstar coupon it pays for. */
const ruxstarShareOf = (r: Pick<StayReservationDoc, "price">) => r.price.commission + r.price.platformFee - discountFrom(r, "ruxstar");

const vendorAccount = (r: StayReservationDoc) => `vendor:${r.vendorId.toHexString()}`;
type Row = [string, LedgerEntryDoc["bucket"], number];

/**
 * A paid reservation: the owner's share and Ruxstar's wait in pending until the tenant has moved in and the objection window
 * has passed. A refund before then takes all of it back out; nothing is refunded after the release.
 */
export function staysLedger(kind: "payment" | "release" | "refund", r: StayReservationDoc, at: Date): LedgerEntryDoc[] {
  const shop = vendorShareOf(r);
  const ruxstar = ruxstarShareOf(r);
  const rows: Row[] =
    kind === "payment"
      ? [
          [vendorAccount(r), "pending", shop],
          ["ruxstar", "pending", ruxstar],
          ["gateway", "withdrawable", -r.price.total],
        ]
      : kind === "release"
        ? [
            [vendorAccount(r), "pending", -shop],
            [vendorAccount(r), "withdrawable", shop],
            ["ruxstar", "pending", -ruxstar],
            ["ruxstar", "withdrawable", ruxstar],
          ]
        : [
            [vendorAccount(r), "pending", -shop],
            ["ruxstar", "pending", -ruxstar],
            ["gateway", "withdrawable", shop + ruxstar],
          ];
  return rows
    .filter(([, , paise]) => paise !== 0)
    .map(([accountId, bucket, signedPaise]) => ({
      txnId: `${kind}:${r._id.toHexString()}`,
      kind,
      accountId,
      bucket,
      signedPaise,
      source: { type: "stay_reservation" as const, id: r._id },
      at,
    }));
}
