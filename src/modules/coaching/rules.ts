import { randomInt } from "node:crypto";
import type { ClientSession } from "mongodb";
import type { CoachingOrderDoc, CoachingRules, CoachingSlot, CourseCategory, Database, LedgerEntryDoc } from "../../platform/db.js";

export const DEFAULT_COACHING_RULES: CoachingRules = {
  certificatePercent: 75,
  minimumHours: 24,
  maxBatchSize: 100,
  maxClasses: 200,
  maxBatches: 20,
  maxDemoFee: 1_000_00,
  maxDemoSeats: 5,
  joinMinutes: 15,
};

export const COURSE_CATEGORIES: readonly CourseCategory[] = ["tuition", "exam_prep", "music", "dance", "sports", "fitness", "art", "languages", "tech", "other"];

export const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;
/** A seat waits this long for its payment before it goes back. */
export const PAY_WINDOW_MS = 20 * 60_000;
/** Cashfree takes up to ₹5,00,000 in one payment. */
export const MAX_ORDER_TOTAL = 5_00_000_00;
/** ₹2,00,000 for one batch. */
export const MAX_FEE = 2_00_000_00;
/** Batches start within a year and run for up to a year. */
export const MAX_AHEAD_DAYS = 366;
/** Attendance can be marked from this long before a class starts. */
export const MARK_EARLY_MS = 30 * 60_000;
/** Coaching orders are numbered from here, apart from print and ticket orders. */
const FIRST_ORDER_NO = 60_000_000;

export const nextCoachingOrderNo = async (db: Database, session?: ClientSession) => FIRST_ORDER_NO + (await db.nextNumber("coaching-order", session));

export async function coachingSettings(db: Database): Promise<CoachingRules & { commissionBps: number; platformFee: number; live: boolean }> {
  const doc = await db.moduleSettings.findOne({ module: "coaching" }, { projection: { coachingRules: 1, commissionBps: 1, platformFee: 1, live: 1 } });
  return { ...DEFAULT_COACHING_RULES, ...doc?.coachingRules, commissionBps: doc?.commissionBps ?? 0, platformFee: doc?.platformFee ?? 0, live: Boolean(doc?.live) };
}

// Days and times, in India.

const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
/** YYYY-MM-DD in India. */
export const dayOf = (at: Date) => DAY_FORMAT.format(at);
export const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const atTime = (day: string, start: string) => new Date(`${day}T${start}:00+05:30`);

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const clock = (start: string, suffix = true) => {
  const [h, m] = start.split(":").map(Number) as [number, number];
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${suffix ? ` ${h < 12 ? "am" : "pm"}` : ""}`;
};
const span = (start: string, end: string) => {
  const sameHalf = Number(start.slice(0, 2)) < 12 === Number(end.slice(0, 2)) < 12;
  return `${clock(start, !sameHalf)}–${clock(end)}`;
};
/** Monday first; three or more days in a row become a range, all seven "Every day". */
function daysText(days: number[]): string {
  if (days.length === 7) return "Every day";
  const order = [...new Set(days)].map((d) => (d + 6) % 7).sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const d of order) {
    const run = runs.at(-1);
    if (run && run.at(-1) === d - 1) run.push(d);
    else runs.push([d]);
  }
  const name = (d: number) => DAY_NAMES[(d + 1) % 7];
  return runs.flatMap((run) => (run.length >= 3 ? [`${name(run[0]!)}–${name(run.at(-1)!)}`] : run.map(name))).join(", ");
}
const endOf = (slot: CoachingSlot) => {
  const total = Number(slot.start.slice(0, 2)) * 60 + Number(slot.start.slice(3)) + slot.minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};
const minutesOf = (start: string) => Number(start.slice(0, 2)) * 60 + Number(start.slice(3));

/** For example "Mon–Fri 5–6 pm · Sat 10–11:30 am": days sharing a time are grouped. */
export function scheduleText(slots: CoachingSlot[]): string {
  const groups = new Map<string, number[]>();
  for (const slot of [...slots].sort((a, b) => ((a.day + 6) % 7) - ((b.day + 6) % 7) || a.start.localeCompare(b.start))) {
    const key = `${slot.start}|${slot.minutes}`;
    groups.set(key, [...(groups.get(key) ?? []), slot.day]);
  }
  return [...groups.entries()]
    .map(([key, days]) => {
      const [start, minutes] = key.split("|") as [string, string];
      return `${daysText(days)} ${span(start, endOf({ day: 0, start, minutes: Number(minutes) }))}`;
    })
    .join(" · ");
}

/** Two slots on the same day that overlap, if any. */
export function slotClash(slots: CoachingSlot[]): [number, number] | null {
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i]!;
      const b = slots[j]!;
      if (a.day !== b.day) continue;
      const [as, bs] = [minutesOf(a.start), minutesOf(b.start)];
      if (as < bs + b.minutes && bs < as + a.minutes) return [i, j];
    }
  }
  return null;
}

/** The classes a weekly schedule gives, from the start date for `classes` classes or until `endDate`, up to `max` + 1. */
export function planClasses(plan: { slots: CoachingSlot[]; startDate: string; classes: number | null; endDate: string | null }, max: number) {
  const want = plan.classes ?? max + 1;
  const slots = [...plan.slots].sort((a, b) => a.start.localeCompare(b.start));
  const out: { startsAt: Date; endsAt: Date }[] = [];
  for (let i = 0, day = plan.startDate; i <= MAX_AHEAD_DAYS * 2 && out.length < want; i++, day = addDays(day, 1)) {
    if (plan.endDate && day > plan.endDate) break;
    for (const slot of slots) {
      if (slot.day !== weekdayOf(day) || out.length >= want) continue;
      const startsAt = atTime(day, slot.start);
      out.push({ startsAt, endsAt: new Date(startsAt.getTime() + slot.minutes * 60_000) });
    }
  }
  return out;
}

const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const certificateCode = () => Array.from({ length: 8 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join("");

// Money.

const discountFrom = (order: Pick<CoachingOrderDoc, "price">, fundedBy: "ruxstar" | "vendor") =>
  order.price.coupon?.fundedBy === fundedBy ? (order.price.discount ?? 0) : 0;
/** The institute's share: the fee less its own coupon and Ruxstar's commission. */
export const vendorShare = (order: Pick<CoachingOrderDoc, "price">) => order.price.items - discountFrom(order, "vendor") - order.price.commission;
/** Ruxstar's commission and platform fee, less a Ruxstar coupon it pays for. */
const ruxstarShare = (order: Pick<CoachingOrderDoc, "price">) => order.price.commission + order.price.platformFee - discountFrom(order, "ruxstar");

const vendorAccount = (order: CoachingOrderDoc) => `vendor:${order.vendorId.toHexString()}`;
type Row = [string, LedgerEntryDoc["bucket"], number];

/**
 * A paid order: the institute's share and Ruxstar's wait in pending until the first class it covers ends. A refund before then
 * takes all of it back out; nothing is refunded after the release.
 */
export function coachingLedger(kind: "payment" | "release" | "refund", order: CoachingOrderDoc, at: Date): LedgerEntryDoc[] {
  const shop = vendorShare(order);
  const ruxstar = ruxstarShare(order);
  const rows: Row[] =
    kind === "payment"
      ? [
          [vendorAccount(order), "pending", shop],
          ["ruxstar", "pending", ruxstar],
          ["gateway", "withdrawable", -order.price.total],
        ]
      : kind === "release"
        ? [
            [vendorAccount(order), "pending", -shop],
            [vendorAccount(order), "withdrawable", shop],
            ["ruxstar", "pending", -ruxstar],
            ["ruxstar", "withdrawable", ruxstar],
          ]
        : [
            [vendorAccount(order), "pending", -shop],
            ["ruxstar", "pending", -ruxstar],
            ["gateway", "withdrawable", shop + ruxstar],
          ];
  return rows
    .filter(([, , paise]) => paise !== 0)
    .map(([accountId, bucket, signedPaise]) => ({
      txnId: `${kind}:${order._id.toHexString()}`,
      kind,
      accountId,
      bucket,
      signedPaise,
      source: { type: "coaching_order" as const, id: order._id },
      at,
    }));
}
