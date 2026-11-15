import type { FastifyInstance } from "fastify";
import { ObjectId, type ClientSession, type Filter, type WithId } from "mongodb";
import { writeAudit } from "../../platform/audit.js";
import type {
  AuditLogDoc,
  Database,
  NotificationDoc,
  StayActor,
  StayBedDoc,
  StayPropertyDoc,
  StayReservationDoc,
  StayRoomDoc,
  StayUnit,
} from "../../platform/db.js";
import { stamp } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { addDays, dayOf, HOUR_MS, MAX_ORDER_TOTAL } from "../coaching/rules.js";
import { checkCode, giveBack, redeem } from "../coupons/coupons.js";
import { creditOrder, invoiceStayReservation } from "../invoices/issue.js";
import { notifyStays } from "../notifications/notify.js";
import { rupees } from "../pod/orders.js";
import { fullRefundNow, nextStayOrderNo, refundDaysOf, staysLedger, staysSettings, startOf, today, vendorShareOf, type StaysSettings } from "./rules.js";

export interface By {
  kind: StayActor;
  actor: AuditLogDoc["actor"];
  ip?: string | null;
}
export const SYSTEM: By = { kind: "system", actor: { id: null, kind: "system" } };

type Link = NotificationDoc["link"];
const invalid = (path: string, message: string) => new AppError("ORDER_INVALID", message, [{ path, message }]);
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const reservationLink = (r: Pick<StayReservationDoc, "_id">): Link => ({ screen: "stay_order", id: r._id.toHexString() });
export const boardLink = (propertyId: ObjectId): Link => ({ screen: "vendor_property", id: propertyId.toHexString() });
export const propertyLink = (propertyId: ObjectId): Link => ({ screen: "stay_property", id: propertyId.toHexString() });
const DAY_TEXT = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" });
/** "Sun, 1 Dec". */
export const dayText = (day: string) => DAY_TEXT.format(startOf(day));
const whenText = (r: Pick<StayReservationDoc, "unit" | "units" | "moveIn">) =>
  `moving in ${dayText(r.moveIn)}${r.unit === "night" ? ` for ${count(r.units, "night")}` : r.units > 1 ? `, ${r.units} months paid` : ""}`;
const placeText = (r: Pick<StayReservationDoc, "roomName" | "bedLabels" | "whole" | "roomKind">) =>
  r.roomKind === "shared" && !r.whole ? `${r.roomName}, bed ${r.bedLabels.join(", ")}` : r.roomName;

/** Reservations that hold their beds: anything not cancelled. */
const HOLDING: StayReservationDoc["status"][] = ["awaiting_payment", "confirmed", "moved_in", "moved_out"];

/** The owner, and team members who see reservations: who hears about the property's reservations. */
async function propertyPeople(db: Database, r: Pick<StayReservationDoc, "businessId" | "vendorId" | "propertyId">) {
  const team = await db.employments
    .find({ businessId: r.businessId, status: "active", current: true, permissions: "stays.reservations" }, { projection: { userId: 1 } })
    .toArray();
  return [r.vendorId, ...team.map((t) => t.userId)].map((userId) => ({ userId, link: boardLink(r.propertyId) }));
}

// Dates.

/** When a stay occupies its beds: from move-in day; hostel nights until the checkout day, months with no end until notice. */
export function stayWindow(moveIn: string, unit: StayUnit, units: number): { from: Date; until: Date | null } {
  return { from: startOf(moveIn), until: unit === "night" ? startOf(addDays(moveIn, units)) : null };
}

/** Reservations of these beds that overlap a window. */
export function overlapping(bedIds: ObjectId[], from: Date, until: Date | null): Filter<StayReservationDoc> {
  return {
    bedIds: { $in: bedIds },
    status: { $in: HOLDING },
    ...(until ? { from: { $lt: until } } : {}),
    $or: [{ until: null }, { until: { $gt: from } }],
  };
}

/** Checks the stay asked for against the rules: the move-in day, and months or nights. */
export function pickStay(
  room: Pick<StayRoomDoc, "prices">,
  rules: Pick<StaysSettings, "maxMonths" | "maxNights" | "bookAheadDays">,
  input: { moveIn: string; stay?: StayUnit | undefined; months?: number | undefined; nights?: number | undefined },
  now = new Date(),
) {
  const unit = input.stay ?? "month";
  if (unit === "month" && input.nights !== undefined) throw invalid("body/nights", "Nights are for stay=night. Send months instead.");
  if (unit === "night" && input.months !== undefined) throw invalid("body/months", "Months are for stay=month. Send nights instead.");
  const units = unit === "month" ? (input.months ?? 1) : (input.nights ?? 1);
  if (unit === "month" && units > rules.maxMonths) throw invalid("body/months", `Pay for up to ${count(rules.maxMonths, "month")} now.`);
  if (unit === "night" && units > rules.maxNights) throw invalid("body/nights", `Reserve up to ${count(rules.maxNights, "night")} at a time.`);
  const unitPrice = room.prices[unit];
  if (unitPrice === null) throw invalid("body/stay", unit === "month" ? "This room isn't let by the month." : "This room isn't let by the night.");
  const first = today(now);
  if (input.moveIn < first) throw invalid("body/moveIn", "Move-in can't be in the past. Pick today or later.");
  if (input.moveIn > addDays(first, rules.bookAheadDays)) throw invalid("body/moveIn", `Reservations open ${count(rules.bookAheadDays, "day")} ahead. Pick an earlier move-in.`);
  return { unit, units, unitPrice, ...stayWindow(input.moveIn, unit, units) };
}

/** The beds a reservation takes: one bed of a shared room, or all of them; a private room is always whole. */
export function pickBeds(room: Pick<StayRoomDoc, "kind" | "wholeRoom">, beds: WithId<StayBedDoc>[], input: { bedId?: string | undefined; whole?: boolean | undefined }) {
  const active = beds.filter((b) => b.status !== "removed");
  if (room.kind === "private") {
    if (input.bedId) throw invalid("body/bedId", "A private room is reserved whole. Leave the bed out.");
    return { beds: active, whole: true };
  }
  if (input.whole) {
    if (input.bedId) throw invalid("body/bedId", "Send a bed or the whole room, not both.");
    if (!room.wholeRoom) throw invalid("body/whole", "This room's beds are reserved one by one.");
    return { beds: active, whole: true };
  }
  if (!input.bedId) throw invalid("body/bedId", "Pick a bed, or reserve the whole room.");
  const bed = active.find((b) => b._id.toHexString() === input.bedId);
  if (!bed) throw invalid("body/bedId", "This bed isn't in the room.");
  return { beds: [bed], whole: false };
}

// Reserving.

/** Unpaid reservations whose hold is up are checked with Cashfree and, unpaid, give their beds back. */
async function freeLapsedHolds(app: FastifyInstance, db: Database, bedIds: ObjectId[], from: Date, until: Date | null, now: Date) {
  const lapsed = await db.staysReservations.find({ ...overlapping(bedIds, from, until), status: "awaiting_payment", holdUntil: { $lte: now } }).limit(20).toArray();
  for (const r of lapsed) await syncStayPayment(app, db, r).catch(() => r);
}

export interface Customer {
  id: ObjectId;
  phone: string;
  name: string | null;
  verified: boolean;
}

/** Tenants need base KYC before reserving. The error says where to get it. */
export function requireTenantKyc(customer: Pick<Customer, "verified">) {
  if (customer.verified) return;
  const message = "Get verified before reserving. It takes a few minutes, and the owner sees you're verified.";
  throw new AppError("KYC_REQUIRED", message, [{ path: "body", message, reason: "tenant_kyc", link: { screen: "verification", id: "base" } }]);
}

/** The price of a stay before coupons and the platform fee. */
export const priceOf = (room: Pick<StayRoomDoc, "kind">, beds: number, unitPrice: number, units: number) => {
  const quantity = room.kind === "private" ? 1 : beds;
  return { quantity, items: unitPrice * quantity * units };
};

/**
 * Reserves one bed of a shared room, or a whole room, from a move-in day: checks the stay, holds the beds for the checkout
 * and saves the reservation. Every bed's lock is written in the same transaction as the overlap check, so two people
 * reserving the same bed at once can't both get it: one waits for the other and then sees its reservation.
 */
export async function reserveStay(
  app: FastifyInstance,
  db: Database,
  input: {
    property: WithId<StayPropertyDoc>;
    room: WithId<StayRoomDoc>;
    customer: Customer;
    body: { bedId?: string | undefined; whole?: boolean | undefined; moveIn: string; stay?: StayUnit | undefined; months?: number | undefined; nights?: number | undefined; coupon?: string | undefined };
  },
): Promise<StayReservationDoc> {
  const { property, room, customer, body } = input;
  const settings = await staysSettings(db);
  const now = new Date();
  if (property.status !== "live" || room.status !== "live" || !room.propertyId.equals(property._id)) throw new AppError("NOT_FOUND", "This room isn't taking reservations.");
  if (property.vendorId.equals(customer.id)) throw invalid("body", "You can't reserve at your own property. Mark beds full on your board instead.");
  requireTenantKyc(customer);
  const stay = pickStay(room, settings, body, now);
  const beds = await db.staysBeds.find({ roomId: room._id, status: { $ne: "removed" } }).sort({ order: 1 }).toArray();
  const picked = pickBeds(room, beds, body);
  if (!picked.beds.length) throw new AppError("CONFLICT", "This room has no beds to reserve.");
  const closed = picked.beds.find((b) => b.status !== "open");
  if (closed) throw new AppError("CONFLICT", room.kind === "private" || picked.whole ? "This room is marked full. Pick another room." : `Bed ${closed.label} is marked full. Pick another bed.`);
  const { quantity, items } = priceOf(room, picked.beds.length, stay.unitPrice, stay.units);

  let coupon: StayReservationDoc["price"]["coupon"] = null;
  let discount = 0;
  if (body.coupon) {
    const check = await checkCode(db, body.coupon, { module: "stays", shop: { id: property.businessId, name: property.businessName }, customerId: customer.id, items });
    if (check.problem !== null) throw new AppError("COUPON_INVALID", check.problem, [{ path: "body/coupon", message: check.problem }]);
    coupon = { id: check.coupon._id, code: check.coupon.code, fundedBy: check.coupon.fundedBy };
    discount = check.discount;
  }
  const platformFee = settings.platformFee;
  const charged = coupon?.fundedBy === "vendor" ? items - discount : items;
  const total = items - discount + platformFee;
  if (total > MAX_ORDER_TOTAL) throw invalid("body", "Payments over ₹5,00,000 can't be made online. Reserve fewer months or nights.");
  const commission = Math.round((charged * settings.commissionBps) / 10_000);

  const id = new ObjectId();
  const bedIds = picked.beds.map((b) => b._id);
  const reservation: StayReservationDoc = {
    _id: id,
    orderNo: 0,
    propertyId: property._id,
    roomId: room._id,
    bedIds,
    bedLabels: picked.beds.map((b) => b.label),
    whole: picked.whole,
    businessId: property.businessId,
    vendorId: property.vendorId,
    customerId: customer.id,
    customerName: customer.name ?? "Customer",
    propertyName: property.name,
    roomName: room.name,
    businessName: property.businessName,
    kind: property.kind,
    roomKind: room.kind,
    unit: stay.unit,
    units: stay.units,
    moveIn: body.moveIn,
    from: stay.from,
    until: stay.until,
    price: { unitPrice: stay.unitPrice, quantity, items, platformFee, total, commissionBps: settings.commissionBps, commission, discount, coupon },
    deposit: property.deposit,
    noticeDays: property.noticeDays,
    refundRule: { days: refundDaysOf(property.refundDays, settings) },
    tenantVerified: customer.verified,
    status: "awaiting_payment",
    timeline: [{ status: "awaiting_payment", at: now, by: "customer" }],
    payment: { gatewayOrderId: `rxt_${id.toHexString()}`, sessionId: "", paymentId: null, paidAt: null },
    holdUntil: new Date(now.getTime() + settings.holdMinutes * 60_000),
    refund: null,
    reason: null,
    cancellation: null,
    movedIn: null,
    objectionUntil: null,
    objection: null,
    moveOut: null,
    releaseAt: null,
    releasedAt: null,
    ...stamp(now),
  };

  await freeLapsedHolds(app, db, bedIds, stay.from, stay.until, now);
  await db.transaction(async (session) => {
    for (const bed of picked.beds) {
      const locked = await db.staysBeds.findOneAndUpdate({ _id: bed._id, status: "open" }, { $inc: { seq: 1 } }, { session, projection: { _id: 1 } });
      if (!locked) throw new AppError("CONFLICT", `Bed ${bed.label} was just marked full. Pick another.`);
    }
    const clash = await db.staysReservations.findOne(overlapping(bedIds, stay.from, stay.until), { session, projection: { bedIds: 1 } });
    if (clash) {
      const taken = picked.beds.find((b) => clash.bedIds.some((x) => x.equals(b._id)));
      throw new AppError(
        "CONFLICT",
        picked.whole && picked.beds.length > 1
          ? "Some beds in this room are taken for these dates. Reserve a free bed, or pick other dates."
          : `${room.kind === "private" ? "This room" : `Bed ${taken?.label ?? ""}`.trim()} is taken for these dates. Pick another${room.kind === "private" ? " room" : " bed"} or other dates.`,
      );
    }
    reservation.orderNo = await nextStayOrderNo(db, session);
    await db.staysReservations.insertOne(reservation, { session });
  });

  try {
    const origin = app.config.apiUrl;
    const { sessionId } = await app.payments.createOrder({
      orderId: reservation.payment!.gatewayOrderId,
      amount: total,
      customer: { id: customer.id.toHexString(), phone: customer.phone.slice(-10), name: customer.name ?? "Customer" },
      note: `${property.name}, ${placeText(reservation)}`,
      returnUrl: origin ? `${origin}/pay/stays/${id.toHexString()}/done` : null,
      notifyUrl: origin ? `${origin}/webhooks/cashfree` : null,
    });
    const saved = await db.staysReservations.findOneAndUpdate({ _id: id }, { $set: { "payment.sessionId": sessionId } }, { returnDocument: "after" });
    return saved ?? reservation;
  } catch (err) {
    await cancelStay(app, db, reservation, SYSTEM, { reason: "The payment couldn't be set up.", gatewayKnown: false, quiet: true });
    throw err;
  }
}

/** The payment went through: the beds are the tenant's, and the money waits in pending until they've moved in. Safe to repeat. */
export async function confirmStay(app: FastifyInstance, db: Database, r: StayReservationDoc, paymentId: string | null): Promise<StayReservationDoc> {
  const now = new Date();
  const after = await db.transaction(async (session) => {
    const done = await db.staysReservations.findOneAndUpdate(
      { _id: r._id, status: "awaiting_payment" },
      {
        $set: { status: "confirmed", "payment.paymentId": paymentId, "payment.paidAt": now, holdUntil: null, updatedAt: now },
        $push: { timeline: { status: "confirmed", at: now, by: "system" } },
      },
      { session, returnDocument: "after" },
    );
    if (!done) return null;
    for (const entry of staysLedger("payment", done, now)) await db.ledgerEntries.insertOne(entry, { session });
    await redeem(db, done, session);
    const issued = await invoiceStayReservation(db, done, session);
    if (issued.length) done.invoices = [...(done.invoices ?? []), ...issued];
    return done;
  });
  if (!after) return (await db.staysReservations.findOne({ _id: r._id })) ?? r;
  await notifyStays(db, app.log, {
    actor: after.customerId,
    type: "stays.reserved",
    title: `Reserved: ${after.propertyName}`,
    body: `${placeText(after)}, ${whenText(after)}. Reservation #${after.orderNo}.${after.deposit.amount ? ` Deposit of ${rupees(after.deposit.amount)} is paid to the owner at move-in.` : ""}`,
    to: [{ userId: after.customerId, link: reservationLink(after) }],
  });
  const share = vendorShareOf(after);
  await notifyStays(db, app.log, {
    actor: after.customerId,
    type: "stays.reserved",
    title: `New reservation #${after.orderNo}`,
    body: `${after.customerName} (verified): ${placeText(after)}, ${whenText(after)}.${share > 0 ? ` ${rupees(share)} to you after they move in.` : ""}`,
    to: await propertyPeople(db, after),
  });
  return after;
}

// Cancelling.

/** Whether the customer can cancel: unpaid, or paid and not moved in. */
export const customerCanCancel = (r: Pick<StayReservationDoc, "status">) => r.status === "awaiting_payment" || r.status === "confirmed";
/** Whether the property or Ruxstar can cancel: paid, and the money not released yet. */
export const ownerCanCancel = (r: Pick<StayReservationDoc, "status" | "releasedAt">) => (r.status === "confirmed" || r.status === "moved_in") && !r.releasedAt;

/** What cancelling now gives back: everything, or nothing once the refund window has closed. The property and Ruxstar always refund in full. */
export function refundIfCancelled(r: Pick<StayReservationDoc, "status" | "refundRule" | "from" | "price" | "releasedAt">, kind: StayActor, now = new Date()): number | null {
  if (kind === "customer") {
    if (r.status === "awaiting_payment") return 0;
    if (r.status !== "confirmed") return null;
    return fullRefundNow(r.refundRule, r.from, now) ? r.price.total : 0;
  }
  return ownerCanCancel(r) ? r.price.total : null;
}

/**
 * Cancels a reservation. Unpaid: its payment is stopped at Cashfree and the beds go back; if it was paid meanwhile, it is
 * confirmed instead. Paid: the beds go back, refunded in full while the refund window is open (or when the property or
 * Ruxstar cancels); a customer cancelling after it gets nothing back and the owner's share is released.
 */
export async function cancelStay(
  app: FastifyInstance,
  db: Database,
  r: StayReservationDoc,
  by: By,
  opts: { reason: string; gatewayKnown?: boolean; quiet?: boolean; objection?: { note: string } },
): Promise<StayReservationDoc> {
  if (r.status === "cancelled") throw new AppError("ORDER_STATE", "This reservation is cancelled already.");
  if (r.status === "awaiting_payment" && r.payment && opts.gatewayKnown !== false) {
    try {
      await app.payments.terminate(r.payment.gatewayOrderId);
    } catch {
      const now = await syncStayPayment(app, db, r, { noExpiry: true });
      if (now.status !== "confirmed") throw new AppError("PAYMENTS_UNAVAILABLE");
      if (by.kind === "customer" || by.kind === "system") return now;
      r = now;
    }
  }
  return r.status === "awaiting_payment" ? dropUnpaid(app, db, r, by, opts) : cancelPaid(app, db, r, by, opts);
}

async function dropUnpaid(app: FastifyInstance, db: Database, r: StayReservationDoc, by: By, opts: { reason: string; quiet?: boolean }) {
  const now = new Date();
  const done = await db.staysReservations.findOneAndUpdate(
    { _id: r._id, status: "awaiting_payment" },
    {
      $set: { status: "cancelled", reason: opts.reason, holdUntil: null, cancellation: { by: by.kind, actorId: by.actor.id, reason: opts.reason, refund: 0, at: now }, updatedAt: now },
      $push: { timeline: { status: "cancelled", at: now, by: by.kind } },
    },
    { returnDocument: "after" },
  );
  if (!done) {
    const current = await db.staysReservations.findOne({ _id: r._id });
    if (current?.status === "cancelled" || current?.status === "confirmed") return current;
    throw new AppError("ORDER_STATE");
  }
  if (!opts.quiet && by.kind === "system") {
    await notifyStays(db, app.log, {
      actor: r.customerId,
      type: "stays.updated",
      title: "Reservation not completed",
      body: `The payment for ${r.propertyName} didn't finish in time, so the bed went back. Reserve again any time.`,
      to: [{ userId: r.customerId, link: propertyLink(r.propertyId) }],
    });
  }
  return done;
}

async function cancelPaid(
  app: FastifyInstance,
  db: Database,
  r: StayReservationDoc,
  by: By,
  opts: { reason: string; quiet?: boolean; objection?: { note: string } },
): Promise<StayReservationDoc> {
  const now = new Date();
  const result = await db.transaction(async (session) => {
    const current = await db.staysReservations.findOne({ _id: r._id }, { session });
    if (!current) throw new AppError("NOT_FOUND", "Reservation not found.");
    const refund = refundIfCancelled(current, by.kind, now);
    if (refund === null) {
      if (by.kind === "customer") {
        throw new AppError("ORDER_STATE", current.status === "moved_in" ? "You've moved in, so this can't be cancelled. Give notice instead, or object if something's wrong." : "This reservation can't be cancelled now.");
      }
      throw new AppError("ORDER_STATE", current.releasedAt ? "The money for this stay has been released, so it can't be cancelled. Mark the move-out instead." : "This reservation can't be cancelled now.");
    }
    const entry = refund > 0 ? { refundId: `rft_${current._id.toHexString()}_1`, amount: refund, reason: opts.reason, by: by.kind, status: "pending" as const, at: now } : null;
    const objection = current.objection?.status === "open" ? { ...current.objection, status: "refunded" as const, note: opts.objection?.note ?? null, resolvedAt: now, resolvedBy: by.actor.id } : current.objection;
    const done = await db.staysReservations.findOneAndUpdate(
      { _id: current._id, updatedAt: current.updatedAt },
      {
        $set: {
          status: "cancelled",
          reason: opts.reason,
          cancellation: { by: by.kind, actorId: by.actor.id, reason: opts.reason, refund, at: now },
          refund: entry,
          objection,
          releaseAt: null,
          ...(entry ? {} : { releasedAt: now }),
          updatedAt: now,
        },
        $push: { timeline: { status: "cancelled", at: now, by: by.kind } },
      },
      { session, returnDocument: "after" },
    );
    if (!done) throw new AppError("CONFLICT", "This reservation just changed. Try again.");
    if (entry) {
      for (const line of staysLedger("refund", done, now)) await db.ledgerEntries.insertOne(line, { session });
      const credited = await creditOrder(db, "stay_reservation", done._id, { id: entry.refundId, reason: entry.reason, amount: null }, session);
      if (credited.length) done.invoices = [...(done.invoices ?? []), ...credited];
      await giveBack(db, done, session);
    } else {
      for (const line of staysLedger("release", done, now)) await db.ledgerEntries.insertOne(line, { session });
    }
    if (by.kind !== "system") {
      await writeAudit(
        db,
        {
          actor: by.actor,
          scope: { module: "stays", businessId: current.businessId },
          action: "stay_reservation.cancel",
          target: { type: "stay_reservation", id: current._id },
          diff: { status: { from: current.status, to: "cancelled" }, refund: { from: 0, to: refund }, reason: { from: null, to: opts.reason } },
          ip: by.ip ?? null,
        },
        session,
      );
    }
    return { done, refund };
  });
  const after = result.refund > 0 ? await askStayRefund(app, db, result.done) : result.done;

  if (!opts.quiet) {
    if (by.kind === "customer") {
      await notifyStays(db, app.log, {
        actor: r.customerId,
        type: "stays.updated",
        title: `#${r.orderNo} cancelled`,
        body: `${r.customerName} cancelled ${placeText(r)}, ${whenText(r)}. The bed is free again.${result.refund === 0 ? ` ${rupees(vendorShareOf(r))} moves to your balance.` : ""}`,
        to: await propertyPeople(db, r),
      });
    } else {
      await notifyStays(db, app.log, {
        actor: by.actor.id ?? r.vendorId,
        type: "stays.updated",
        title: `${r.propertyName}: reservation cancelled`,
        body: `${placeText(r)}, ${whenText(r)}. ${opts.reason}${result.refund > 0 ? ` Your ${rupees(result.refund)} is being refunded.` : ""}`,
        to: [{ userId: r.customerId, link: reservationLink(r) }],
      });
      if (by.kind === "staff") {
        await notifyStays(db, app.log, {
          actor: by.actor.id ?? r.vendorId,
          type: "stays.updated",
          title: `#${r.orderNo} cancelled by Ruxstar`,
          body: `${placeText(r)} for ${r.customerName}. ${opts.reason}`,
          to: await propertyPeople(db, r),
        });
      }
    }
  }
  return after;
}

/** Asks Cashfree for the refund, or how it's going. Safe to repeat; a failure leaves it for the next sweep. */
export async function askStayRefund(app: FastifyInstance, db: Database, r: StayReservationDoc): Promise<StayReservationDoc> {
  if (!r.payment || r.refund?.status !== "pending") return r;
  try {
    const { status } = await app.payments.refund(r.payment.gatewayOrderId, r.refund.refundId, r.refund.amount, `Ruxstar stay #${r.orderNo}`);
    if (status !== "done") return r;
    return (await db.staysReservations.findOneAndUpdate({ _id: r._id, "refund.status": "pending" }, { $set: { "refund.status": "done", updatedAt: new Date() } }, { returnDocument: "after" })) ?? r;
  } catch (err) {
    app.log.error({ err: (err as Error).message, reservation: r._id.toHexString() }, "Stay refund not started; it is retried on the next sweep");
    return r;
  }
}

/** While a reservation waits for payment, asks Cashfree whether it was paid; once the hold is up, an unpaid one gives its beds back. */
export async function syncStayPayment(app: FastifyInstance, db: Database, r: StayReservationDoc, { noExpiry = false }: { noExpiry?: boolean } = {}): Promise<StayReservationDoc> {
  if (r.status !== "awaiting_payment" || !r.payment) return askStayRefund(app, db, r);
  let answer: Awaited<ReturnType<typeof app.payments.status>>;
  try {
    answer = await app.payments.status(r.payment.gatewayOrderId);
  } catch {
    return r;
  }
  if (answer.status === "paid") return confirmStay(app, db, r, answer.paymentId);
  if (noExpiry) return r;
  if (answer.status === "expired" || answer.status === "terminated") {
    return cancelStay(app, db, r, SYSTEM, { reason: "The payment didn't go through.", gatewayKnown: false });
  }
  if (r.holdUntil && r.holdUntil.getTime() <= Date.now()) return cancelStay(app, db, r, SYSTEM, { reason: "The payment didn't finish in time." });
  return r;
}

// Moving in and out.

/** Whether the property can mark "Moved in" now: paid, from move-in day, before a hostel stay ends. */
export const canMoveIn = (r: Pick<StayReservationDoc, "status" | "from" | "until">, now = new Date()) =>
  r.status === "confirmed" && now >= r.from && (!r.until || now < r.until);

/**
 * The property marks the tenant moved in. The tenant can object until the window closes; after that, the owner's share is
 * released.
 */
export async function markMovedIn(app: FastifyInstance, db: Database, r: StayReservationDoc, by: By): Promise<StayReservationDoc> {
  const now = new Date();
  if (r.status !== "confirmed") throw new AppError("ORDER_STATE", r.status === "moved_in" ? "This tenant is marked moved in already." : "Only paid reservations can be marked moved in.");
  if (now < r.from) throw new AppError("ORDER_STATE", `Mark the move-in from ${dayText(r.moveIn)}, the move-in day.`);
  if (r.until && now >= r.until) throw new AppError("ORDER_STATE", "This stay is over.");
  const settings = await staysSettings(db);
  const objectionUntil = new Date(now.getTime() + settings.objectionHours * HOUR_MS);
  const after = await db.transaction(async (session) => {
    const done = await db.staysReservations.findOneAndUpdate(
      { _id: r._id, status: "confirmed" },
      {
        $set: { status: "moved_in", movedIn: { at: now, by: by.actor.id! }, objectionUntil, releaseAt: objectionUntil, updatedAt: now },
        $push: { timeline: { status: "moved_in", at: now, by: by.kind } },
      },
      { session, returnDocument: "after" },
    );
    if (!done) throw new AppError("ORDER_STATE");
    await audit(db, by, done, "stay_reservation.moved_in", { status: { from: "confirmed", to: "moved_in" } }, session);
    return done;
  });
  await notifyStays(db, app.log, {
    actor: by.actor.id ?? r.vendorId,
    type: "stays.updated",
    title: `Welcome to ${r.propertyName}`,
    body: `${r.propertyName} marked you moved in. Something wrong? Tell us within ${count(settings.objectionHours, "hour")} and the owner isn't paid until it's sorted.`,
    to: [{ userId: r.customerId, link: reservationLink(r) }],
  });
  return after;
}

const audit = (db: Database, by: By, r: StayReservationDoc, action: string, diff: Record<string, { from: unknown; to: unknown }>, session?: ClientSession) =>
  writeAudit(
    db,
    { actor: by.actor, scope: { module: "stays", businessId: r.businessId }, action, target: { type: "stay_reservation", id: r._id }, diff, ip: by.ip ?? null },
    session,
  );

/** Whether the tenant can object now: moved in, within the window, nothing objected yet and the money not released. */
export const canObject = (r: Pick<StayReservationDoc, "status" | "objectionUntil" | "objection" | "releasedAt">, now = new Date()) =>
  r.status !== "cancelled" && Boolean(r.objectionUntil && now < r.objectionUntil) && !r.objection && !r.releasedAt;

/** The tenant says something's wrong after "Moved in": the owner's money waits until Ruxstar decides. */
export async function objectStay(app: FastifyInstance, db: Database, r: StayReservationDoc, by: By, reason: string): Promise<StayReservationDoc> {
  const now = new Date();
  if (!canObject(r, now)) {
    throw new AppError(
      "ORDER_STATE",
      r.objection ? "You've objected to this stay already." : !r.objectionUntil ? "You can object once the property marks you moved in." : "The time to object has passed. Contact support.",
    );
  }
  const done = await db.staysReservations.findOneAndUpdate(
    { _id: r._id, objection: null, releasedAt: null, objectionUntil: { $gt: now } },
    { $set: { objection: { reason, at: now, status: "open", note: null, resolvedAt: null, resolvedBy: null }, releaseAt: null, updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!done) throw new AppError("ORDER_STATE", "The time to object has passed. Contact support.");
  await audit(db, by, done, "stay_reservation.objection", { objection: { from: null, to: "open" } });
  await notifyStays(db, app.log, {
    actor: r.customerId,
    type: "stays.updated",
    title: `#${r.orderNo}: tenant objected`,
    body: `${r.customerName} says: "${reason}". Ruxstar will look into it; the payment waits until then.`,
    to: await propertyPeople(db, r),
  });
  return done;
}

/** The tenant takes their objection back: the owner's money is released once the window would have closed. */
export async function withdrawObjection(db: Database, r: StayReservationDoc, by: By): Promise<StayReservationDoc> {
  if (r.objection?.status !== "open") throw new AppError("ORDER_STATE", "There's no open objection on this stay.");
  const now = new Date();
  const releaseAt = r.objectionUntil && r.objectionUntil > now ? r.objectionUntil : now;
  const done = await db.staysReservations.findOneAndUpdate(
    { _id: r._id, "objection.status": "open" },
    { $set: { "objection.status": "withdrawn", "objection.resolvedAt": now, "objection.resolvedBy": by.actor.id, releaseAt, updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!done) throw new AppError("ORDER_STATE", "There's no open objection on this stay.");
  await audit(db, by, done, "stay_reservation.objection_withdraw", { objection: { from: "open", to: "withdrawn" } });
  return done;
}

/** Ruxstar decides an objection: pay the owner, or refund the tenant in full and end the stay. */
export async function decideObjection(
  app: FastifyInstance,
  db: Database,
  r: StayReservationDoc,
  by: By & { kind: "staff" },
  decision: "release" | "refund",
  note: string,
): Promise<StayReservationDoc> {
  if (r.objection?.status !== "open") throw new AppError("ORDER_STATE", "This objection has been decided already.");
  if (decision === "refund") return cancelStay(app, db, r, by, { reason: `Ruxstar upheld your objection: ${note}`, objection: { note } });
  const now = new Date();
  const done = await db.staysReservations.findOneAndUpdate(
    { _id: r._id, "objection.status": "open" },
    { $set: { "objection.status": "released", "objection.note": note, "objection.resolvedAt": now, "objection.resolvedBy": by.actor.id, releaseAt: now, updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!done) throw new AppError("ORDER_STATE", "This objection has been decided already.");
  await audit(db, by, done, "stay_reservation.objection_decide", { objection: { from: "open", to: "released" }, note: { from: null, to: note } });
  await releaseStayShares(app, db, { _id: r._id }, now);
  await notifyStays(db, app.log, {
    actor: by.actor.id ?? r.vendorId,
    type: "stays.updated",
    title: `${r.propertyName}: objection closed`,
    body: `Ruxstar looked into your objection and paid the property. ${note}`,
    to: [{ userId: r.customerId, link: reservationLink(r) }],
  });
  return (await db.staysReservations.findOne({ _id: r._id })) ?? done;
}

/** Whether a stay has no end date yet, so a notice can set one. */
export const canGiveNotice = (r: Pick<StayReservationDoc, "status" | "unit" | "until">) => r.status === "moved_in" && r.unit === "month" && r.until === null;

/**
 * Sets when a stay ends. The tenant gives notice on a monthly stay: the beds are free from `noticeDays` after today, or a
 * later day they pick. The property marks a move-out on any day from move-in, today when left out; a day already passed
 * ends the stay now. A stay can be shortened this way, never lengthened.
 */
export async function endStay(
  app: FastifyInstance,
  db: Database,
  r: StayReservationDoc,
  by: By,
  input: { on?: string | undefined; reason?: string | undefined },
): Promise<StayReservationDoc> {
  const now = new Date();
  const first = today(now);
  const tenant = by.kind === "customer";
  if (r.status !== "moved_in") {
    throw new AppError("ORDER_STATE", r.status === "moved_out" ? "This stay has ended already." : tenant ? "Notice can be given once you've moved in. Cancel instead." : "Mark the tenant moved in first, or cancel the reservation.");
  }
  let on: string;
  if (tenant) {
    if (!canGiveNotice(r)) throw new AppError("ORDER_STATE", r.unit === "night" ? "Hostel stays end on their checkout day." : "You've given notice already.");
    const earliest = addDays(first, r.noticeDays);
    on = input.on ?? earliest;
    if (on < earliest) throw invalid("body/on", `The notice period is ${count(r.noticeDays, "day")}, so the earliest move-out is ${dayText(earliest)}.`);
  } else {
    on = input.on ?? first;
    if (on < r.moveIn) throw invalid("body/on", "The move-out can't be before the move-in day.");
  }
  const until = startOf(on);
  if (r.until && until > r.until) throw invalid("body/on", `This stay already ends on ${dayText(dayOf(r.until))}. Pick that day or earlier.`);
  const ended = on <= first;
  const kind = ended ? "move_out" : "notice";
  const done = await db.staysReservations.findOneAndUpdate(
    { _id: r._id, status: "moved_in", updatedAt: r.updatedAt },
    {
      $set: {
        until,
        moveOut: { on, kind, by: by.kind, actorId: by.actor.id, at: now },
        ...(ended ? { status: "moved_out" as const } : {}),
        updatedAt: now,
      },
      ...(ended ? { $push: { timeline: { status: "moved_out" as const, at: now, by: by.kind } } } : {}),
    },
    { returnDocument: "after" },
  );
  if (!done) throw new AppError("CONFLICT", "This stay just changed. Try again.");
  await audit(db, by, done, tenant ? "stay_reservation.notice" : "stay_reservation.move_out", {
    until: { from: r.until?.toISOString() ?? null, to: done.until?.toISOString() ?? null },
    ...(input.reason ? { reason: { from: null, to: input.reason } } : {}),
  });
  const what = ended ? `moved out today` : `moves out on ${dayText(on)}`;
  if (tenant) {
    await notifyStays(db, app.log, {
      actor: r.customerId,
      type: "stays.updated",
      title: `#${r.orderNo}: notice given`,
      body: `${r.customerName} (${placeText(r)}) ${what}. The bed opens for reservations from then.`,
      to: await propertyPeople(db, r),
    });
  } else {
    await notifyStays(db, app.log, {
      actor: by.actor.id ?? r.vendorId,
      type: "stays.updated",
      title: `${r.propertyName}: move-out`,
      body: `The property marked that you ${what}.${input.reason ? ` ${input.reason}` : ""}`,
      to: [{ userId: r.customerId, link: reservationLink(r) }],
    });
  }
  return done;
}

/** Stays whose end date has passed are marked moved out. */
export async function closeEndedStays(db: Database, filter: Filter<StayReservationDoc> = {}, now = new Date()) {
  const res = await db.staysReservations.updateMany(
    { ...filter, status: "moved_in", until: { $ne: null, $lte: now } },
    { $set: { status: "moved_out", updatedAt: now }, $push: { timeline: { status: "moved_out", at: now, by: "system" } } },
  );
  return res.modifiedCount;
}

/** Once the tenant has moved in and the objection window has passed, the owner's share moves to their available balance. */
export async function releaseStayShares(app: FastifyInstance, db: Database, filter: { vendorId?: ObjectId; _id?: ObjectId }, now = new Date()): Promise<number> {
  const due = await db.staysReservations.find({ ...filter, releaseAt: { $lte: now }, releasedAt: null, status: { $in: ["moved_in", "moved_out"] } }).limit(100).toArray();
  let released = 0;
  for (const r of due) {
    released += await db
      .transaction(async (session) => {
        const done = await db.staysReservations.findOneAndUpdate(
          { _id: r._id, releaseAt: { $lte: now }, releasedAt: null, "objection.status": { $ne: "open" } },
          { $set: { releasedAt: now, releaseAt: null, updatedAt: now } },
          { session, returnDocument: "after" },
        );
        if (!done) return 0;
        for (const entry of staysLedger("release", done, now)) await db.ledgerEntries.insertOne(entry, { session });
        return 1;
      })
      .catch((err: unknown) => {
        app.log.warn({ err: (err as Error).message, reservation: r._id.toHexString() }, "Stay share not released; the next sweep retries it");
        return 0;
      });
  }
  return released;
}

// Properties, rooms and beds.

/** A property's search fields follow its live rooms: how they're let, their kinds and the lowest prices. */
export async function refreshProperty(db: Database, propertyId: ObjectId): Promise<void> {
  const rooms = await db.staysRooms.find({ propertyId, status: "live" }, { projection: { kind: 1, prices: 1 } }).toArray();
  const lowest = (unit: StayUnit) => {
    const prices = rooms.flatMap((r) => (r.prices[unit] === null ? [] : [r.prices[unit]!]));
    return prices.length ? Math.min(...prices) : null;
  };
  const priceFrom = { month: lowest("month"), night: lowest("night") };
  const units = (["month", "night"] as const).filter((u) => priceFrom[u] !== null);
  const roomKinds = (["private", "shared"] as const).filter((k) => rooms.some((r) => r.kind === k));
  await db.staysProperties.updateOne({ _id: propertyId }, { $set: { priceFrom, units, roomKinds } });
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Gives a room `count` beds: new ones get the first free letters; extra ones go from the end, only if nobody holds them
 * now or later. Beds that were ever reserved are kept as removed for old reservations.
 */
export async function setBeds(db: Database, room: Pick<StayRoomDoc, "_id" | "propertyId" | "businessId">, count: number): Promise<void> {
  const beds = await db.staysBeds.find({ roomId: room._id, status: { $ne: "removed" } }).sort({ order: 1 }).toArray();
  const now = new Date();
  if (beds.length < count) {
    const used = new Set(beds.map((b) => b.label));
    const free = [...LETTERS].filter((l) => !used.has(l));
    let order = Math.max(0, ...beds.map((b) => b.order));
    const added: StayBedDoc[] = free.slice(0, count - beds.length).map((label) => ({
      _id: new ObjectId(),
      roomId: room._id,
      propertyId: room.propertyId,
      businessId: room.businessId,
      label,
      status: "open",
      seq: 0,
      order: ++order,
      createdAt: now,
      updatedAt: now,
    }));
    if (added.length) await db.staysBeds.insertMany(added);
    return;
  }
  const extra = beds.slice(count);
  if (!extra.length) return;
  const held = await db.staysReservations.findOne(
    { bedIds: { $in: extra.map((b) => b._id) }, status: { $in: HOLDING }, $or: [{ until: null }, { until: { $gt: now } }] },
    { projection: { bedIds: 1 } },
  );
  if (held) {
    const bed = extra.find((b) => held.bedIds.some((x) => x.equals(b._id)));
    throw new AppError("CONFLICT", `${bed ? `Bed ${bed.label}` : "A bed"} is reserved, so the room can't have fewer beds. Cancel or end that stay first.`);
  }
  for (const bed of extra) {
    const used = await db.staysReservations.findOne({ bedIds: bed._id }, { projection: { _id: 1 } });
    if (used) await db.staysBeds.updateOne({ _id: bed._id }, { $set: { status: "removed", updatedAt: now }, $inc: { seq: 1 } });
    else await db.staysBeds.deleteOne({ _id: bed._id });
  }
}

/** Every reservation at a property not moved in yet: unpaid ones are dropped, paid ones refunded in full. */
async function cancelPropertyReservations(app: FastifyInstance, db: Database, propertyId: ObjectId, by: By, reason: string) {
  let refunded = 0;
  for (const r of await db.staysReservations.find({ propertyId, status: { $in: ["awaiting_payment", "confirmed"] } }).toArray()) {
    try {
      const done = await cancelStay(app, db, r, by, { reason });
      if (r.status === "confirmed" && done.refund) refunded++;
    } catch (err) {
      app.log.error({ err: (err as Error).message, reservation: r._id.toHexString() }, "Stay reservation not cancelled with its property");
    }
  }
  return refunded;
}

/** Ruxstar takes a property down: it leaves the listings, and every reservation not moved in yet is cancelled and refunded in full. */
export async function takeDownProperty(app: FastifyInstance, db: Database, property: WithId<StayPropertyDoc>, by: By & { kind: "staff" }, reason: string) {
  if (property.status === "removed") throw new AppError("CONFLICT", "This property is taken down already.");
  const now = new Date();
  const res = await db.staysProperties.updateOne(
    { _id: property._id, status: property.status },
    { $set: { status: "removed", removal: { actorId: by.actor.id!, reason, at: now }, updatedAt: now } },
  );
  if (!res.modifiedCount) throw new AppError("CONFLICT");
  await writeAudit(db, {
    actor: by.actor,
    scope: { module: "stays", businessId: property.businessId },
    action: "stay_property.take_down",
    target: { type: "stay_property", id: property._id },
    diff: { status: { from: property.status, to: "removed" }, reason: { from: null, to: reason } },
    ip: by.ip ?? null,
  });
  const refunded = await cancelPropertyReservations(app, db, property._id, by, `Ruxstar took down ${property.name}: ${reason}`);
  await notifyStays(db, app.log, {
    actor: by.actor.id ?? property.vendorId,
    type: "stays.updated",
    title: `Ruxstar took down ${property.name}`,
    body: `${reason} ${count(refunded, "reservation")} refunded. Tenants who moved in stay as they are. Contact support if you think this is wrong.`,
    to: [{ userId: property.vendorId, link: boardLink(property._id) }],
  });
  return refunded;
}

/** The stays timers: unpaid holds past their time, stays that ended, shares due, refunds to retry. */
export async function sweepStays(app: FastifyInstance, db: Database) {
  const now = new Date();
  let holds = 0;
  for (const r of await db.staysReservations.find({ status: "awaiting_payment", holdUntil: { $lte: now } }).limit(100).toArray()) {
    const after = await syncStayPayment(app, db, r).catch(() => r);
    if (after.status !== "awaiting_payment") holds++;
  }
  const ended = await closeEndedStays(db, {}, now);
  const releases = await releaseStayShares(app, db, {}, now);
  let refunds = 0;
  for (const r of await db.staysReservations.find({ "refund.status": "pending" }).limit(100).toArray()) {
    const after = await askStayRefund(app, db, r);
    if (after.refund?.status === "done") refunds++;
  }
  return { staysHolds: holds, staysEnded: ended, staysReleases: releases, staysRefunds: refunds };
}

/** Reads catch a reservation up themselves, so a missed sweep doesn't leave a hold, an ended stay or a share waiting. */
export async function freshStays(app: FastifyInstance, db: Database, list: StayReservationDoc[]): Promise<StayReservationDoc[]> {
  const now = new Date();
  const out: StayReservationDoc[] = [];
  for (const r of list) {
    let current = r;
    if (current.status === "awaiting_payment" && current.holdUntil && current.holdUntil <= now) current = await syncStayPayment(app, db, current).catch(() => current);
    const ended = current.status === "moved_in" && current.until && current.until <= now;
    const due = current.releaseAt && current.releaseAt <= now && !current.releasedAt;
    if (ended || due) {
      if (ended) await closeEndedStays(db, { _id: current._id }, now);
      if (due) await releaseStayShares(app, db, { _id: current._id }, now);
      current = (await db.staysReservations.findOne({ _id: current._id })) ?? current;
    }
    out.push(current);
  }
  return out;
}
