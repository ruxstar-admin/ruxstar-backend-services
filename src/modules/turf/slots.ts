import type { TurfCourtDoc, TurfSlotDoc } from "../../platform/db.js";
import { atTime, dayOf, weekdayOf } from "../coaching/rules.js";

type Court = Pick<TurfCourtDoc, "slotMinutes" | "hours" | "prices">;

export interface Slot {
  startAt: Date;
  endAt: Date;
  /** HH:MM in India. */
  start: string;
  end: string;
  price: number;
  peak: boolean;
}

export type SlotState = "free" | "held" | "booked" | "blocked";

export const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
export const clockOf = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
export const isWeekend = (weekday: number) => weekday === 0 || weekday === 6;

/** One slot's price: a peak window it starts in, else the weekend price on Saturday and Sunday, else the base price. */
export function priceAt(prices: TurfCourtDoc["prices"], weekday: number, startMinutes: number): { price: number; peak: boolean } {
  const peak = prices.peak.find((p) => p.days.includes(weekday) && minutesOf(p.start) <= startMinutes && startMinutes < minutesOf(p.end === "00:00" ? "24:00" : p.end));
  if (peak) return { price: peak.price, peak: true };
  if (isWeekend(weekday) && prices.weekend !== null) return { price: prices.weekend, peak: false };
  return { price: prices.base, peak: false };
}

/** A court's slots on one day in India: from opening, every `slotMinutes`, while a whole slot fits before closing. */
export function slotsForDay(court: Court, day: string): Slot[] {
  const weekday = weekdayOf(day);
  const hours = court.hours.find((h) => h.day === weekday);
  if (!hours) return [];
  const midnight = atTime(day, "00:00").getTime();
  const open = minutesOf(hours.open);
  const close = minutesOf(hours.close);
  const out: Slot[] = [];
  for (let start = open; start + court.slotMinutes <= close; start += court.slotMinutes) {
    const end = start + court.slotMinutes;
    out.push({
      startAt: new Date(midnight + start * 60_000),
      endAt: new Date(midnight + end * 60_000),
      start: clockOf(start),
      end: end === 24 * 60 ? "24:00" : clockOf(end),
      ...priceAt(court.prices, weekday, start),
    });
  }
  return out;
}

/** The slot of a court starting exactly at `startAt`, or null when there isn't one. */
export function slotAt(court: Court, startAt: Date): Slot | null {
  return slotsForDay(court, dayOf(startAt)).find((s) => s.startAt.getTime() === startAt.getTime()) ?? null;
}

/** Whether a slot document stands: a hold whose time is up counts as free. */
export const standing = (doc: Pick<TurfSlotDoc, "status" | "holdUntil">, now: Date) => doc.status !== "held" || !doc.holdUntil || doc.holdUntil > now;

export function stateOf(slot: Pick<Slot, "startAt">, docs: Pick<TurfSlotDoc, "startAt" | "status" | "holdUntil">[], now: Date): SlotState {
  const doc = docs.find((d) => d.startAt.getTime() === slot.startAt.getTime());
  return doc && standing(doc, now) ? doc.status : "free";
}

/** Slots in order, each starting where the last ended. */
export function backToBack(slots: Pick<Slot, "startAt" | "endAt">[]): boolean {
  return slots.every((s, i) => i === 0 || slots[i - 1]!.endAt.getTime() === s.startAt.getTime());
}

/** "7–8:30 pm" or "11:30 am–1 pm". */
export function spanText(start: string, end: string): string {
  const parts = (clock: string) => {
    const minutes = minutesOf(clock);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return { text: `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}`, pm: h >= 12 && h < 24 };
  };
  const a = parts(start);
  const b = parts(end);
  return a.pm === b.pm ? `${a.text}–${b.text} ${b.pm ? "pm" : "am"}` : `${a.text} ${a.pm ? "pm" : "am"}–${b.text} ${b.pm ? "pm" : "am"}`;
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" });
const CLOCK_FORMAT = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export const clockAt = (at: Date) => CLOCK_FORMAT.format(at);

/** "Sat, 21 Nov, 7–8:30 pm". */
export function whenText(startAt: Date, endAt: Date): string {
  const end = clockAt(endAt);
  return `${DAY_FORMAT.format(startAt)}, ${spanText(clockAt(startAt), end === "00:00" ? "24:00" : end)}`;
}
