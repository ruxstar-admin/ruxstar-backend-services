import type { FastifyInstance } from "fastify";
import { MongoServerError, ObjectId, type WithId } from "mongodb";
import { writeAudit } from "../../platform/audit.js";
import type {
  AuditLogDoc,
  Database,
  NotificationDoc,
  TurfActor,
  TurfAddOn,
  TurfBookingDoc,
  TurfCourtDoc,
  TurfGroundDoc,
  TurfOccurrenceDoc,
  TurfSlotDoc,
} from "../../platform/db.js";
import { stamp } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { DAY_MS, dayOf, MAX_ORDER_TOTAL } from "../coaching/rules.js";
import { checkCode, giveBack, redeem } from "../coupons/coupons.js";
import { creditOrder, invoiceTurfBooking } from "../invoices/issue.js";
import { notifyTurf } from "../notifications/notify.js";
import { rupees } from "../pod/orders.js";
import { allocate, nextTurfOrderNo, refundPercent, refundRuleOf, turfLedger, turfSettings, vendorShareOf, type TurfSettings } from "./rules.js";
import { backToBack, slotAt, whenText, type Slot } from "./slots.js";

export interface By {
  kind: TurfActor;
  actor: AuditLogDoc["actor"];
  ip?: string | null;
}
export const SYSTEM: By = { kind: "system", actor: { id: null, kind: "system" } };

type Link = NotificationDoc["link"];
const invalid = (path: string, message: string) => new AppError("ORDER_INVALID", message, [{ path, message }]);
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const bookingLink = (booking: Pick<TurfBookingDoc, "_id">): Link => ({ screen: "turf_order", id: booking._id.toHexString() });
export const boardLink = (groundId: ObjectId): Link => ({ screen: "vendor_ground", id: groundId.toHexString() });
/** Arrivals can be marked from this long before a slot. */
export const ARRIVE_EARLY_MS = 30 * 60_000;
/** And until this long after it ends. */
export const MARK_LATE_MS = DAY_MS;

/** The owner, and team members who see bookings: who hears about the ground's bookings. */
async function groundPeople(db: Database, booking: Pick<TurfBookingDoc, "businessId" | "vendorId" | "groundId">) {
  const team = await db.employments
    .find({ businessId: booking.businessId, status: "active", current: true, permissions: "turf.bookings" }, { projection: { userId: 1 } })
    .toArray();
  return [booking.vendorId, ...team.map((t) => t.userId)].map((userId) => ({ userId, link: boardLink(booking.groundId) }));
}

// Picking slots.

export interface Picked {
  occurrences: { n: number; startAt: Date; endAt: Date; slots: Slot[]; items: number }[];
  addOns: (TurfAddOn & { quantity: number })[];
  items: number;
}

/**
 * Checks a customer's pick against the court: slots of the court, back to back on one day, not started, within how far ahead
 * bookings go, and the same slots each week of a repeat. Prices each date: its slots and the add-ons.
 */
export function pickSlots(
  court: Pick<TurfCourtDoc, "slotMinutes" | "hours" | "prices" | "addOns">,
  rules: Pick<TurfSettings, "maxSlots" | "maxRepeatWeeks" | "bookAheadDays">,
  input: { startAts: string[]; addOns?: { id: string; quantity: number }[] | undefined; weeks?: number | undefined },
  now = new Date(),
): Picked {
  if (input.startAts.length > rules.maxSlots) throw invalid("body/startAts", `Book up to ${count(rules.maxSlots, "slot")} at a time.`);
  const starts = input.startAts.map((s) => new Date(s)).sort((a, b) => a.getTime() - b.getTime());
  if (new Set(starts.map((s) => s.getTime())).size !== starts.length) throw invalid("body/startAts", "Each slot can be picked once.");
  const slots = starts.map((start, i) => {
    const slot = slotAt(court, start);
    if (!slot) throw invalid(`body/startAts/${i}`, "This isn't one of the court's slots. Pick from its slots for the day.");
    return slot;
  });
  if (new Set(slots.map((s) => dayOf(s.startAt))).size > 1 || !backToBack(slots)) {
    throw invalid("body/startAts", "Pick slots next to each other on one day, with no gap between them.");
  }
  const first = slots[0]!;
  if (first.startAt <= now) throw new AppError("CONFLICT", "This slot has started. Pick a later one.");
  if (first.startAt.getTime() > now.getTime() + rules.bookAheadDays * DAY_MS) {
    throw invalid("body/startAts", `Bookings open ${count(rules.bookAheadDays, "day")} ahead. Pick an earlier date.`);
  }
  const weeks = input.weeks ?? 1;
  if (weeks > rules.maxRepeatWeeks) throw invalid("body/weeks", `A weekly booking can be up to ${count(rules.maxRepeatWeeks, "week")}.`);

  const seen = new Set<string>();
  const addOns = (input.addOns ?? []).map((a, i) => {
    const found = court.addOns.find((c) => c.id === a.id);
    if (!found) throw invalid(`body/addOns/${i}/id`, "This add-on isn't offered any more.");
    if (seen.has(a.id)) throw invalid(`body/addOns/${i}/id`, "Each add-on can be picked once; change its quantity instead.");
    seen.add(a.id);
    return { ...found, quantity: a.quantity };
  });

  const occurrences = Array.from({ length: weeks }, (_, k) => {
    const week = slots.map((s, i) => {
      if (k === 0) return s;
      const slot = slotAt(court, new Date(s.startAt.getTime() + k * 7 * DAY_MS));
      if (!slot) throw invalid(`body/startAts/${i}`, `The court isn't open for these slots ${count(k, "week")} later.`);
      return slot;
    });
    const extras = addOns.reduce((sum, a) => sum + a.price * a.quantity * (a.per === "slot" ? week.length : 1), 0);
    return { n: k + 1, startAt: week[0]!.startAt, endAt: week.at(-1)!.endAt, slots: week, items: week.reduce((sum, s) => sum + s.price, 0) + extras };
  });
  return { occurrences, addOns, items: occurrences.reduce((sum, o) => sum + o.items, 0) };
}

/** Slots held for checkouts whose time is up: their bookings are checked with Cashfree and, unpaid, give them back. */
async function freeLapsedHolds(app: FastifyInstance, db: Database, courtId: ObjectId, starts: Date[], now: Date) {
  const lapsed = await db.turfSlots
    .find({ courtId, startAt: { $in: starts }, status: "held", holdUntil: { $lte: now } }, { projection: { bookingId: 1 } })
    .toArray();
  const ids = [...new Set(lapsed.flatMap((s) => (s.bookingId ? [s.bookingId.toHexString()] : [])))];
  for (const id of ids) {
    const booking = await db.turfBookings.findOne({ _id: new ObjectId(id) });
    if (booking) await syncTurfPayment(app, db, booking).catch(() => booking);
    else await db.turfSlots.deleteMany({ bookingId: new ObjectId(id), status: "held" });
  }
}

/** Says which of the slots someone else has: "Sat, 21 Nov, 7–8 pm is booked." */
async function takenText(db: Database, courtId: ObjectId, starts: Date[]): Promise<string> {
  const taken = await db.turfSlots.find({ courtId, startAt: { $in: starts } }).sort({ startAt: 1 }).limit(1).toArray();
  const slot = taken[0];
  if (!slot) return "Someone just booked one of these slots. Pick another time.";
  return `${whenText(slot.startAt, slot.endAt)} is ${slot.status === "blocked" ? "not available" : "booked"}. Pick another time.`;
}

/**
 * Books back-to-back slots of a court, for one date or the same slots several weeks running: checks the pick and every date
 * is free, holds the slots for the checkout and saves the booking. The unique court and start of each slot is what stops two
 * people getting the same one.
 */
export async function placeBooking(
  app: FastifyInstance,
  db: Database,
  input: {
    ground: WithId<TurfGroundDoc>;
    court: WithId<TurfCourtDoc>;
    customer: { id: ObjectId; phone: string; name: string | null };
    body: { startAts: string[]; sport?: string | undefined; addOns?: { id: string; quantity: number }[] | undefined; weeks?: number | undefined; coupon?: string | undefined };
  },
): Promise<TurfBookingDoc> {
  const { ground, court, customer, body } = input;
  const settings = await turfSettings(db);
  const now = new Date();
  if (ground.status !== "live" || court.status !== "live" || !court.groundId.equals(ground._id)) throw new AppError("NOT_FOUND", "This court isn't taking bookings.");
  if (ground.vendorId.equals(customer.id)) throw invalid("body", "You can't book your own ground. Block the slots on your board instead.");
  if (body.sport && !court.sports.includes(body.sport)) throw invalid("body/sport", "This court isn't set up for that sport.");
  const sport = body.sport ?? (court.sports.length === 1 ? court.sports[0]! : null);
  const picked = pickSlots(court, settings, body, now);
  const starts = picked.occurrences.flatMap((o) => o.slots.map((s) => s.startAt));

  let coupon: TurfBookingDoc["price"]["coupon"] = null;
  let discount = 0;
  if (body.coupon) {
    const check = await checkCode(db, body.coupon, { module: "turf", shop: { id: ground.businessId, name: ground.businessName }, customerId: customer.id, items: picked.items });
    if (check.problem !== null) throw new AppError("COUPON_INVALID", check.problem, [{ path: "body/coupon", message: check.problem }]);
    coupon = { id: check.coupon._id, code: check.coupon.code, fundedBy: check.coupon.fundedBy };
    discount = check.discount;
  }
  const { items } = picked;
  const platformFee = settings.platformFee;
  const vendorFunded = coupon?.fundedBy === "vendor";
  const charged = vendorFunded ? items - discount : items;
  const total = items - discount + platformFee;
  if (total > MAX_ORDER_TOTAL) throw invalid("body", "Payments over ₹5,00,000 can't be made online. Book fewer weeks or slots.");
  const commission = Math.round((charged * settings.commissionBps) / 10_000);

  const weights = picked.occurrences.map((o) => o.items);
  const discounts = allocate(discount, weights);
  const fees = allocate(platformFee, weights);
  const commissions = allocate(commission, weights);
  const occurrences: TurfOccurrenceDoc[] = picked.occurrences.map((o, i) => {
    const paid = o.items - discounts[i]! + fees[i]!;
    const vendorShare = o.items - (vendorFunded ? discounts[i]! : 0) - commissions[i]!;
    return {
      n: o.n,
      startAt: o.startAt,
      endAt: o.endAt,
      slots: o.slots.map((s) => ({ startAt: s.startAt, endAt: s.endAt, price: s.price, peak: s.peak })),
      items: o.items,
      discount: discounts[i]!,
      platformFee: fees[i]!,
      paid,
      vendorShare,
      ruxstarShare: paid - vendorShare,
      status: "booked",
      cancellation: null,
      arrival: null,
      releasedAt: null,
    };
  });

  const id = new ObjectId();
  const holdUntil = new Date(now.getTime() + settings.holdMinutes * 60_000);
  const booking: TurfBookingDoc = {
    _id: id,
    orderNo: 0,
    groundId: ground._id,
    courtId: court._id,
    businessId: ground.businessId,
    vendorId: ground.vendorId,
    customerId: customer.id,
    customerName: customer.name ?? "Customer",
    groundName: ground.name,
    courtName: court.name,
    businessName: ground.businessName,
    sport,
    slotMinutes: court.slotMinutes,
    addOns: picked.addOns,
    weeks: occurrences.length,
    occurrences,
    firstAt: occurrences[0]!.startAt,
    lastEndsAt: occurrences.at(-1)!.endAt,
    price: { items, platformFee, total, commissionBps: settings.commissionBps, commission, discount, coupon },
    refundRule: refundRuleOf(ground.refunds, settings),
    status: "awaiting_payment",
    timeline: [{ status: "awaiting_payment", at: now, by: "customer" }],
    payment: { gatewayOrderId: `rxt_${id.toHexString()}`, sessionId: "", paymentId: null, paidAt: null },
    holdUntil,
    refunds: [],
    reason: null,
    releaseAt: null,
    ...stamp(now),
  };

  await freeLapsedHolds(app, db, court._id, starts, now);
  try {
    await db.transaction(async (session) => {
      for (const o of occurrences) {
        for (const s of o.slots) {
          const slot: TurfSlotDoc = {
            _id: new ObjectId(),
            courtId: court._id,
            groundId: ground._id,
            businessId: ground.businessId,
            startAt: s.startAt,
            endAt: s.endAt,
            status: "held",
            bookingId: id,
            holdUntil,
            note: null,
            by: null,
            createdAt: now,
          };
          await db.turfSlots.insertOne(slot, { session });
        }
      }
      booking.orderNo = await nextTurfOrderNo(db, session);
      await db.turfBookings.insertOne(booking, { session });
    });
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 11000) throw new AppError("CONFLICT", await takenText(db, court._id, starts));
    throw err;
  }

  try {
    const origin = app.config.apiUrl;
    const { sessionId } = await app.payments.createOrder({
      orderId: booking.payment!.gatewayOrderId,
      amount: total,
      customer: { id: customer.id.toHexString(), phone: customer.phone.slice(-10), name: customer.name ?? "Customer" },
      note: `${ground.name}, ${court.name}${booking.weeks > 1 ? `, ${booking.weeks} weeks` : ""}`,
      returnUrl: origin ? `${origin}/pay/turf/${id.toHexString()}/done` : null,
      notifyUrl: origin ? `${origin}/webhooks/cashfree` : null,
    });
    const saved = await db.turfBookings.findOneAndUpdate({ _id: id }, { $set: { "payment.sessionId": sessionId } }, { returnDocument: "after" });
    return saved ?? booking;
  } catch (err) {
    await cancelBooking(app, db, booking, SYSTEM, { reason: "The payment couldn't be set up.", gatewayKnown: false, quiet: true });
    throw err;
  }
}

const datesText = (booking: Pick<TurfBookingDoc, "weeks">, first: Pick<TurfOccurrenceDoc, "startAt" | "endAt">) =>
  `${whenText(first.startAt, first.endAt)}${booking.weeks > 1 ? `, every week for ${booking.weeks} weeks` : ""}`;

async function tellBooked(app: FastifyInstance, db: Database, booking: TurfBookingDoc) {
  const first = booking.occurrences[0]!;
  await notifyTurf(db, app.log, {
    actor: booking.customerId,
    type: "turf.booked",
    title: `Booked: ${booking.groundName}`,
    body: `${booking.courtName}, ${datesText(booking, first)}. Booking #${booking.orderNo}.`,
    to: [{ userId: booking.customerId, link: bookingLink(booking) }],
  });
  const share = vendorShareOf(booking);
  await notifyTurf(db, app.log, {
    actor: booking.customerId,
    type: "turf.booked",
    title: `New booking #${booking.orderNo}`,
    body: `${booking.customerName}: ${booking.courtName}, ${datesText(booking, first)}.${share > 0 ? ` ${rupees(share)} to you after play.` : ""}`,
    to: await groundPeople(db, booking),
  });
}

/** The payment went through: the slots are the customer's, and the money waits in pending until each date ends. Safe to repeat. */
export async function confirmBooking(app: FastifyInstance, db: Database, booking: TurfBookingDoc, paymentId: string | null): Promise<TurfBookingDoc> {
  const now = new Date();
  const after = await db.transaction(async (session) => {
    const done = await db.turfBookings.findOneAndUpdate(
      { _id: booking._id, status: "awaiting_payment" },
      {
        $set: {
          status: "confirmed",
          "payment.paymentId": paymentId,
          "payment.paidAt": now,
          holdUntil: null,
          releaseAt: booking.occurrences[0]!.endAt,
          updatedAt: now,
        },
        $push: { timeline: { status: "confirmed", at: now, by: "system" } },
      },
      { session, returnDocument: "after" },
    );
    if (!done) return null;
    await db.turfSlots.updateMany({ bookingId: booking._id, status: "held" }, { $set: { status: "booked", holdUntil: null } }, { session });
    for (const entry of turfLedger(done, now, { kind: "payment" })) await db.ledgerEntries.insertOne(entry, { session });
    await redeem(db, done, session);
    const issued = await invoiceTurfBooking(db, done, session);
    if (issued.length) done.invoices = [...(done.invoices ?? []), ...issued];
    return done;
  });
  if (!after) return (await db.turfBookings.findOne({ _id: booking._id })) ?? booking;
  await tellBooked(app, db, after);
  return after;
}

/**
 * Cancels a booking. Unpaid: its payment is stopped at Cashfree and the slots go back; if it was paid meanwhile, it is
 * confirmed instead. Paid: the dates asked for (every one still to come when left out) are cancelled and refunded, by the
 * booking's tiers when the customer does it and in full, platform fee included, when the ground or Ruxstar does.
 */
export async function cancelBooking(
  app: FastifyInstance,
  db: Database,
  booking: TurfBookingDoc,
  by: By,
  opts: { reason: string; occurrences?: number[] | undefined; gatewayKnown?: boolean; quiet?: boolean },
): Promise<TurfBookingDoc> {
  if (booking.status === "cancelled") throw new AppError("ORDER_STATE", "This booking is cancelled already.");
  if (booking.status === "awaiting_payment" && booking.payment && opts.gatewayKnown !== false) {
    try {
      await app.payments.terminate(booking.payment.gatewayOrderId);
    } catch {
      const now = await syncTurfPayment(app, db, booking, { noExpiry: true });
      if (now.status !== "confirmed") throw new AppError("PAYMENTS_UNAVAILABLE");
      if (by.kind === "customer" || by.kind === "system") return now;
      booking = now;
    }
  }
  return booking.status === "awaiting_payment" ? dropUnpaid(app, db, booking, by, opts) : cancelDates(app, db, booking, by, opts);
}

async function dropUnpaid(app: FastifyInstance, db: Database, booking: TurfBookingDoc, by: By, opts: { reason: string; quiet?: boolean }) {
  const now = new Date();
  const after = await db.transaction(async (session) => {
    const done = await db.turfBookings.findOneAndUpdate(
      { _id: booking._id, status: "awaiting_payment" },
      {
        $set: { status: "cancelled", reason: opts.reason, holdUntil: null, "occurrences.$[].status": "cancelled", updatedAt: now },
        $push: { timeline: { status: "cancelled", at: now, by: by.kind } },
      },
      { session, returnDocument: "after" },
    );
    if (!done) return null;
    await db.turfSlots.deleteMany({ bookingId: booking._id }, { session });
    return done;
  });
  if (!after) {
    const current = await db.turfBookings.findOne({ _id: booking._id });
    if (current?.status === "cancelled") return current;
    if (current?.status === "confirmed") return current;
    throw new AppError("ORDER_STATE");
  }
  if (!opts.quiet && by.kind === "system") {
    await notifyTurf(db, app.log, {
      actor: booking.customerId,
      type: "turf.updated",
      title: "Booking not completed",
      body: `The payment for ${booking.groundName} didn't finish in time, so the slots went back. Book again any time.`,
      to: [{ userId: booking.customerId, link: { screen: "turf_ground", id: booking.groundId.toHexString() } }],
    });
  }
  return after;
}

/** The dates that can be cancelled now: booked and not settled; for the customer, not started; for the ground, not ended. */
export function cancellable(booking: Pick<TurfBookingDoc, "status" | "occurrences">, kind: TurfActor, now = new Date()): TurfOccurrenceDoc[] {
  if (booking.status !== "confirmed") return [];
  return booking.occurrences.filter((o) => o.status === "booked" && !o.releasedAt && (kind === "customer" ? o.startAt > now : o.endAt > now));
}

async function cancelDates(
  app: FastifyInstance,
  db: Database,
  booking: TurfBookingDoc,
  by: By,
  opts: { reason: string; occurrences?: number[] | undefined; quiet?: boolean },
): Promise<TurfBookingDoc> {
  const now = new Date();
  const result = await db.transaction(async (session) => {
    const current = await db.turfBookings.findOne({ _id: booking._id }, { session });
    if (!current || current.status !== "confirmed") throw new AppError("ORDER_STATE", "This booking can't be cancelled now.");
    const open = cancellable(current, by.kind, now);
    const asked = opts.occurrences ?? open.map((o) => o.n);
    for (const n of asked) {
      const o = current.occurrences.find((x) => x.n === n);
      if (!o) throw invalid("body/occurrences", `This booking has no date ${n}.`);
      if (!open.includes(o)) {
        const why = o.status === "cancelled" ? "is cancelled already" : by.kind === "customer" ? "has started" : "is over";
        throw new AppError("ORDER_STATE", `${whenText(o.startAt, o.endAt)} ${why}, so it can't be cancelled.`);
      }
    }
    if (!asked.length) throw new AppError("ORDER_STATE", by.kind === "customer" ? "Every date has started or is cancelled, so there's nothing to cancel." : "Every date is over or cancelled.");

    const k = current.refunds.length + 1;
    const vendorFunded = current.price.coupon?.fundedBy === "vendor";
    let refund = 0;
    let vendorBack = 0;
    let supply = 0;
    let fee = 0;
    const occurrences = current.occurrences.map((o): TurfOccurrenceDoc => {
      if (!asked.includes(o.n)) return o;
      const percent = by.kind === "customer" ? refundPercent(current.refundRule, o.startAt, now) : 100;
      const back = Math.round((o.paid * percent) / 100);
      const vBack = Math.round((o.vendorShare * percent) / 100);
      refund += back;
      vendorBack += vBack;
      supply += Math.round(((o.items - (vendorFunded ? o.discount : 0)) * percent) / 100);
      fee += Math.round((o.platformFee * percent) / 100);
      return {
        ...o,
        status: "cancelled",
        cancellation: { by: by.kind, actorId: by.actor.id, reason: opts.reason, percent, refund: back, vendorBack: vBack, at: now },
        releasedAt: percent === 100 ? now : null,
      };
    });
    const allCancelled = occurrences.every((o) => o.status === "cancelled");
    const pending = occurrences.filter((o) => !o.releasedAt).map((o) => o.endAt.getTime());
    const entry = refund > 0 ? { refundId: `rft_${current._id.toHexString()}_${k}`, occurrences: asked, amount: refund, reason: opts.reason, by: by.kind, status: "pending" as const, at: now } : null;
    const push = {
      ...(entry ? { refunds: entry } : {}),
      ...(allCancelled ? { timeline: { status: "cancelled" as const, at: now, by: by.kind } } : {}),
    };
    const done = await db.turfBookings.findOneAndUpdate(
      { _id: current._id, updatedAt: current.updatedAt },
      {
        $set: {
          occurrences,
          status: allCancelled ? "cancelled" : "confirmed",
          releaseAt: pending.length ? new Date(Math.min(...pending)) : null,
          ...(allCancelled ? { reason: opts.reason } : {}),
          updatedAt: now,
        },
        ...(Object.keys(push).length ? { $push: push } : {}),
      },
      { session, returnDocument: "after" },
    );
    if (!done) throw new AppError("CONFLICT", "This booking just changed. Try again.");
    const freed = current.occurrences.filter((o) => asked.includes(o.n)).flatMap((o) => o.slots.map((s) => s.startAt));
    await db.turfSlots.deleteMany({ bookingId: current._id, startAt: { $in: freed } }, { session });
    if (entry) {
      for (const line of turfLedger(done, now, { kind: "refund", n: k, refund, vendorBack })) await db.ledgerEntries.insertOne(line, { session });
      const credited = await creditOrder(db, "turf_booking", done._id, { id: entry.refundId, reason: entry.reason, amount: supply, fee }, session);
      if (credited.length) done.invoices = [...(done.invoices ?? []), ...credited];
    }
    if (allCancelled && occurrences.every((o) => o.cancellation?.percent === 100)) await giveBack(db, done, session);
    if (by.kind !== "system") {
      await writeAudit(
        db,
        {
          actor: by.actor,
          scope: { module: "turf", businessId: current.businessId },
          action: "turf_booking.cancel",
          target: { type: "turf_booking", id: current._id },
          diff: { occurrences: { from: null, to: asked }, refund: { from: 0, to: refund }, reason: { from: null, to: opts.reason } },
          ip: by.ip ?? null,
        },
        session,
      );
    }
    return { done, refund, asked: current.occurrences.filter((o) => asked.includes(o.n)) };
  });
  const after = result.refund > 0 ? await askTurfRefund(app, db, result.done) : result.done;

  if (!opts.quiet) {
    const first = result.asked[0]!;
    const which = `${whenText(first.startAt, first.endAt)}${result.asked.length > 1 ? ` and ${count(result.asked.length - 1, "more date")}` : ""}`;
    if (by.kind === "customer") {
      await notifyTurf(db, app.log, {
        actor: booking.customerId,
        type: "turf.updated",
        title: `#${booking.orderNo} cancelled`,
        body: `${booking.customerName} cancelled ${booking.courtName}, ${which}. The slots are free again.`,
        to: await groundPeople(db, booking),
      });
    } else {
      await notifyTurf(db, app.log, {
        actor: by.actor.id ?? booking.vendorId,
        type: "turf.updated",
        title: `${booking.groundName}: booking cancelled`,
        body: `${booking.courtName}, ${which}. ${opts.reason}${result.refund > 0 ? ` Your ${rupees(result.refund)} is being refunded.` : ""}`,
        to: [{ userId: booking.customerId, link: bookingLink(booking) }],
      });
    }
  }
  return after;
}

/** Asks Cashfree for each refund still pending, or how it's going. Safe to repeat; a failure leaves it for the next sweep. */
export async function askTurfRefund(app: FastifyInstance, db: Database, booking: TurfBookingDoc): Promise<TurfBookingDoc> {
  if (!booking.payment || !booking.refunds.some((r) => r.status === "pending")) return booking;
  let changed = false;
  for (const refund of booking.refunds.filter((r) => r.status === "pending")) {
    try {
      const { status } = await app.payments.refund(booking.payment.gatewayOrderId, refund.refundId, refund.amount, `Ruxstar turf #${booking.orderNo}`);
      if (status !== "done") continue;
      await db.turfBookings.updateOne(
        { _id: booking._id },
        { $set: { "refunds.$[r].status": "done", updatedAt: new Date() } },
        { arrayFilters: [{ "r.refundId": refund.refundId, "r.status": "pending" }] },
      );
      changed = true;
    } catch (err) {
      app.log.error({ err: (err as Error).message, booking: booking._id.toHexString() }, "Turf refund not started; it is retried on the next sweep");
    }
  }
  return changed ? ((await db.turfBookings.findOne({ _id: booking._id })) ?? booking) : booking;
}

/** While a booking waits for payment, asks Cashfree whether it was paid; once the hold is up, an unpaid one gives its slots back. */
export async function syncTurfPayment(
  app: FastifyInstance,
  db: Database,
  booking: TurfBookingDoc,
  { noExpiry = false }: { noExpiry?: boolean } = {},
): Promise<TurfBookingDoc> {
  if (booking.status !== "awaiting_payment" || !booking.payment) return askTurfRefund(app, db, booking);
  let answer: Awaited<ReturnType<typeof app.payments.status>>;
  try {
    answer = await app.payments.status(booking.payment.gatewayOrderId);
  } catch {
    return booking;
  }
  if (answer.status === "paid") return confirmBooking(app, db, booking, answer.paymentId);
  if (noExpiry) return booking;
  if (answer.status === "expired" || answer.status === "terminated") {
    return cancelBooking(app, db, booking, SYSTEM, { reason: "The payment didn't go through.", gatewayKnown: false });
  }
  if (booking.holdUntil && booking.holdUntil.getTime() <= Date.now()) {
    return cancelBooking(app, db, booking, SYSTEM, { reason: "The payment didn't finish in time." });
  }
  return booking;
}

/** Once a date ends, what the ground keeps of it moves to its available balance, and Ruxstar's share to Ruxstar's. */
export async function releaseTurfShares(app: FastifyInstance, db: Database, filter: { vendorId?: ObjectId; _id?: ObjectId }, now = new Date()): Promise<number> {
  const due = await db.turfBookings.find({ ...filter, releaseAt: { $lte: now } }).limit(100).toArray();
  let released = 0;
  for (const booking of due) {
    released += await db
      .transaction(async (session) => {
        const current = await db.turfBookings.findOne({ _id: booking._id }, { session });
        if (!current) return 0;
        const ready = current.occurrences.filter((o) => !o.releasedAt && o.endAt <= now);
        if (!ready.length) return 0;
        for (const o of ready) for (const entry of turfLedger(current, now, { kind: "release", occurrence: o })) await db.ledgerEntries.insertOne(entry, { session });
        const occurrences = current.occurrences.map((o) => (ready.includes(o) ? { ...o, releasedAt: now } : o));
        const pending = occurrences.filter((o) => !o.releasedAt).map((o) => o.endAt.getTime());
        const res = await db.turfBookings.updateOne(
          { _id: current._id, updatedAt: current.updatedAt },
          { $set: { occurrences, releaseAt: pending.length ? new Date(Math.min(...pending)) : null, updatedAt: now } },
          { session },
        );
        if (!res.modifiedCount) throw new AppError("CONFLICT");
        return ready.length;
      })
      .catch((err: unknown) => {
        app.log.warn({ err: (err as Error).message, booking: booking._id.toHexString() }, "Turf share not released; the next sweep retries it");
        return 0;
      });
  }
  return released;
}

/** Marks whether the customer came for one date: arrived from 30 minutes before it, no-show from its start, until a day after it ends. */
export async function markArrival(db: Database, booking: TurfBookingDoc, n: number, status: "arrived" | "no_show", by: By): Promise<TurfBookingDoc> {
  const o = booking.occurrences.find((x) => x.n === n);
  if (!o) throw invalid("body/n", `This booking has no date ${n}.`);
  if (booking.status !== "confirmed" || o.status !== "booked") throw new AppError("ORDER_STATE", "Only paid dates that aren't cancelled can be marked.");
  const now = Date.now();
  const from = status === "arrived" ? o.startAt.getTime() - ARRIVE_EARLY_MS : o.startAt.getTime();
  if (now < from) throw new AppError("ORDER_STATE", status === "arrived" ? "Mark arrivals from 30 minutes before the slot." : "Mark a no-show once the slot has started.");
  if (now > o.endAt.getTime() + MARK_LATE_MS) throw new AppError("ORDER_STATE", "Arrivals can be marked until a day after the slot.");
  const at = new Date(now);
  const after = await db.transaction(async (session) => {
    const done = await db.turfBookings.findOneAndUpdate(
      { _id: booking._id, status: "confirmed" },
      { $set: { "occurrences.$[o].arrival": { status, by: by.actor.id!, at }, updatedAt: at } },
      { session, returnDocument: "after", arrayFilters: [{ "o.n": n, "o.status": "booked" }] },
    );
    if (!done) throw new AppError("ORDER_STATE");
    await writeAudit(
      db,
      {
        actor: by.actor,
        scope: { module: "turf", businessId: booking.businessId },
        action: "turf_booking.arrival",
        target: { type: "turf_booking", id: booking._id },
        diff: { arrival: { from: o.arrival?.status ?? null, to: status }, n: { from: null, to: n } },
        ip: by.ip ?? null,
      },
      session,
    );
    return done;
  });
  return after;
}

// Blocks.

/** Blocks free slots of a court so nobody can book them, with a note. All or none: one taken slot stops the lot. */
export async function blockSlots(app: FastifyInstance, db: Database, court: WithId<TurfCourtDoc>, startAts: string[], note: string | null, by: By): Promise<number> {
  const now = new Date();
  const slots = startAts.map((s, i) => {
    const slot = slotAt(court, new Date(s));
    if (!slot) throw invalid(`body/startAts/${i}`, "This isn't one of the court's slots.");
    if (slot.endAt <= now) throw invalid(`body/startAts/${i}`, "This slot is over.");
    return slot;
  });
  const starts = slots.map((s) => s.startAt);
  await freeLapsedHolds(app, db, court._id, starts, now);
  try {
    await db.transaction(async (session) => {
      for (const s of slots) {
        await db.turfSlots.insertOne(
          {
            _id: new ObjectId(),
            courtId: court._id,
            groundId: court.groundId,
            businessId: court.businessId,
            startAt: s.startAt,
            endAt: s.endAt,
            status: "blocked",
            bookingId: null,
            holdUntil: null,
            note,
            by: by.actor.id,
            createdAt: now,
          },
          { session },
        );
      }
      await writeAudit(
        db,
        {
          actor: by.actor,
          scope: { module: "turf", businessId: court.businessId },
          action: "turf_slot.block",
          target: { type: "turf_court", id: court._id },
          diff: { slots: { from: 0, to: slots.length }, ...(note ? { note: { from: null, to: note } } : {}) },
          ip: by.ip ?? null,
        },
        session,
      );
    });
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 11000) {
      const taken = await db.turfSlots.find({ courtId: court._id, startAt: { $in: starts } }).sort({ startAt: 1 }).limit(1).toArray();
      const slot = taken[0];
      throw new AppError("CONFLICT", slot ? `${whenText(slot.startAt, slot.endAt)} is ${slot.status === "blocked" ? "blocked already" : "booked"}. Leave it out.` : "One of these slots was just taken.");
    }
    throw err;
  }
  return slots.length;
}

export async function unblockSlots(db: Database, court: WithId<TurfCourtDoc>, startAts: string[], by: By): Promise<number> {
  const starts = startAts.map((s) => new Date(s));
  const res = await db.turfSlots.deleteMany({ courtId: court._id, startAt: { $in: starts }, status: "blocked" });
  if (res.deletedCount) {
    await writeAudit(db, {
      actor: by.actor,
      scope: { module: "turf", businessId: court.businessId },
      action: "turf_slot.unblock",
      target: { type: "turf_court", id: court._id },
      diff: { slots: { from: 0, to: res.deletedCount } },
      ip: by.ip ?? null,
    });
  }
  return res.deletedCount;
}

// Grounds.

/** A ground's listing fields follow its live courts: the sports offered and the lowest base price. */
export async function refreshGround(db: Database, groundId: ObjectId): Promise<void> {
  const courts = await db.turfCourts.find({ groundId, status: "live" }, { projection: { sports: 1, prices: 1 } }).toArray();
  const sports = [...new Set(courts.flatMap((c) => c.sports))];
  const priceFrom = courts.length ? Math.min(...courts.map((c) => c.prices.base)) : null;
  await db.turfGrounds.updateOne({ _id: groundId }, { $set: { sports, priceFrom } });
}

/** Every booking at a ground with a date still to come: unpaid ones are dropped, paid ones refunded in full for those dates. */
async function cancelGroundBookings(app: FastifyInstance, db: Database, filter: { groundId?: ObjectId; courtId?: ObjectId }, by: By, reason: string) {
  const now = new Date();
  let refunded = 0;
  for (const booking of await db.turfBookings.find({ ...filter, status: { $in: ["awaiting_payment", "confirmed"] }, lastEndsAt: { $gt: now } }).toArray()) {
    if (booking.status === "confirmed" && !cancellable(booking, by.kind, now).length) continue;
    try {
      const done = await cancelBooking(app, db, booking, by, { reason });
      if (booking.status === "confirmed" && done.refunds.length > booking.refunds.length) refunded++;
    } catch (err) {
      app.log.error({ err: (err as Error).message, booking: booking._id.toHexString() }, "Turf booking not cancelled with its ground");
    }
  }
  return refunded;
}

/** Ruxstar takes a ground down: it leaves the listings, and every booking still to come is cancelled and refunded in full. */
export async function takeDownGround(app: FastifyInstance, db: Database, ground: WithId<TurfGroundDoc>, by: By & { kind: "staff" }, reason: string) {
  if (ground.status === "removed") throw new AppError("CONFLICT", "This ground is taken down already.");
  const now = new Date();
  const res = await db.turfGrounds.updateOne(
    { _id: ground._id, status: ground.status },
    { $set: { status: "removed", removal: { actorId: by.actor.id!, reason, at: now }, updatedAt: now } },
  );
  if (!res.modifiedCount) throw new AppError("CONFLICT");
  await writeAudit(db, {
    actor: by.actor,
    scope: { module: "turf", businessId: ground.businessId },
    action: "turf_ground.take_down",
    target: { type: "turf_ground", id: ground._id },
    diff: { status: { from: ground.status, to: "removed" }, reason: { from: null, to: reason } },
    ip: by.ip ?? null,
  });
  const refunded = await cancelGroundBookings(app, db, { groundId: ground._id }, by, `Ruxstar took down ${ground.name}: ${reason}`);
  await db.turfSlots.deleteMany({ groundId: ground._id, status: "blocked", endAt: { $gt: now } });
  await notifyTurf(db, app.log, {
    actor: by.actor.id ?? ground.vendorId,
    type: "turf.updated",
    title: `Ruxstar took down ${ground.name}`,
    body: `${reason} ${count(refunded, "booking")} refunded. Contact support if you think this is wrong.`,
    to: [{ userId: ground.vendorId, link: boardLink(ground._id) }],
  });
  return refunded;
}

/** The turf timers: unpaid holds past their time, shares due, refunds to retry. */
export async function sweepTurf(app: FastifyInstance, db: Database) {
  const now = new Date();
  let holds = 0;
  for (const booking of await db.turfBookings.find({ status: "awaiting_payment", holdUntil: { $lte: now } }).limit(100).toArray()) {
    const after = await syncTurfPayment(app, db, booking).catch(() => booking);
    if (after.status !== "awaiting_payment") holds++;
  }
  const releases = await releaseTurfShares(app, db, {}, now);
  let refunds = 0;
  for (const booking of await db.turfBookings.find({ "refunds.status": "pending" }).limit(100).toArray()) {
    const after = await askTurfRefund(app, db, booking);
    refunds += after.refunds.filter((r) => r.status === "done").length - booking.refunds.filter((r) => r.status === "done").length;
  }
  return { turfHolds: holds, turfReleases: releases, turfRefunds: refunds };
}

/** Reads catch a booking up themselves, so a missed sweep doesn't leave a hold or a share waiting. */
export async function freshBookings(app: FastifyInstance, db: Database, bookings: TurfBookingDoc[]): Promise<TurfBookingDoc[]> {
  const now = new Date();
  const out: TurfBookingDoc[] = [];
  for (const b of bookings) {
    let current = b;
    if (current.status === "awaiting_payment" && current.holdUntil && current.holdUntil <= now) current = await syncTurfPayment(app, db, current).catch(() => current);
    if (current.releaseAt && current.releaseAt <= now) {
      await releaseTurfShares(app, db, { _id: current._id }, now);
      current = (await db.turfBookings.findOne({ _id: current._id })) ?? current;
    }
    out.push(current);
  }
  return out;
}
