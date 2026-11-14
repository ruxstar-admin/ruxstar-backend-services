import type { FastifyInstance } from "fastify";
import { ObjectId, type ClientSession, type WithId } from "mongodb";
import type { Static } from "typebox";
import { writeAudit } from "../../platform/audit.js";
import type { AuditLogDoc, Database, EventDoc, EventOrderDoc, EventTicketDoc, EventWaitDoc } from "../../platform/db.js";
import { stamp } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { notifyEvent } from "../notifications/notify.js";
import { rupees, signingKey } from "../pod/orders.js";
import type { CreateTicketsBody } from "./contracts.js";
import {
  eventLedger,
  eventSettings,
  HOUR_MS,
  MAX_ORDER_TOTAL,
  MAX_PER_ORDER,
  newCode,
  nextEventOrderNo,
  PAY_WINDOW_MS,
  sha256,
  ticketQr,
  vendorShare,
} from "./rules.js";

export interface By {
  kind: "customer" | "vendor" | "staff" | "system";
  actor: AuditLogDoc["actor"];
  ip?: string | null;
}
export const SYSTEM: By = { kind: "system", actor: { id: null, kind: "system" } };

const invalid = (path: string, message: string) => new AppError("ORDER_INVALID", message, [{ path, message }]);
const when = (at: Date) =>
  at.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Line = EventOrderDoc["lines"][number];

/** Takes `quantity` off each line's ticket type, or puts it back with `sign` 1. */
function seatUpdate(lines: Pick<Line, "tierId" | "quantity">[], sign: 1 | -1) {
  const $inc: Record<string, number> = {};
  const arrayFilters = lines.map((line, i) => {
    $inc[`tiers.$[t${i}].left`] = sign * line.quantity;
    return { [`t${i}.id`]: line.tierId };
  });
  return { update: { $inc }, arrayFilters };
}

const returnSeats = (db: Database, order: { eventId: ObjectId; lines: Pick<Line, "tierId" | "quantity">[] }, session: ClientSession) => {
  const { update, arrayFilters } = seatUpdate(order.lines, 1);
  return db.events.updateOne({ _id: order.eventId }, update, { session, arrayFilters });
};

async function freshCodes(db: Database, eventId: ObjectId, n: number): Promise<string[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const codes = [...new Set(Array.from({ length: n }, newCode))];
    if (codes.length < n) continue;
    const taken = await db.eventTickets.countDocuments({ eventId, code: { $in: codes } });
    if (!taken) return codes;
  }
  throw new AppError("CONFLICT", "Couldn't issue tickets just now. Try again.");
}

/**
 * Books tickets: checks the people and answers, takes the seats (or uses the ones a waitlist offer held), and saves the order
 * with one ticket per person. Free orders are confirmed at once; paid ones wait for the payment, holding the seats for 20 minutes.
 */
export async function bookTickets(
  app: FastifyInstance,
  db: Database,
  event: WithId<EventDoc>,
  customer: { id: ObjectId; phone: string; name: string | null },
  body: Static<typeof CreateTicketsBody>,
): Promise<EventOrderDoc> {
  const settings = await eventSettings(db);
  const now = new Date();
  if (event.status !== "live") throw new AppError("NOT_FOUND", "This event isn't taking bookings.");
  if (event.startsAt <= now) throw new AppError("CONFLICT", "Bookings closed when the event started.");
  if (event.vendorId.equals(customer.id)) throw invalid("body/tickets", "You can't book your own event.");

  const tierOf = (id: string, path: string) => {
    const tier = event.tiers.find((t) => t.id === id);
    if (!tier) throw invalid(path, "This ticket type isn't on sale any more.");
    return tier;
  };
  let lines: Line[];
  if (event.team) {
    if (!body.team) throw invalid("body/team", "Name your team and pick its entry.");
    const tier = tierOf(body.team.tierId, "body/team/tierId");
    const { min, max } = event.team;
    if (body.tickets.length < min || body.tickets.length > max) {
      throw invalid("body/tickets", min === max ? `A team has ${min} players.` : `A team has ${min} to ${max} players.`);
    }
    lines = [{ tierId: tier.id, name: tier.name, quantity: 1, unitPrice: tier.price }];
  } else {
    if (body.team) throw invalid("body/team", "This event doesn't take team entries.");
    if (body.tickets.length > MAX_PER_ORDER) throw invalid("body/tickets", `Up to ${MAX_PER_ORDER} tickets in one booking.`);
    const byTier = new Map<string, Line>();
    body.tickets.forEach((t, i) => {
      const tier = tierOf(t.tierId, `body/tickets/${i}/tierId`);
      const line = byTier.get(tier.id) ?? { tierId: tier.id, name: tier.name, quantity: 0, unitPrice: tier.price };
      line.quantity++;
      byTier.set(tier.id, line);
    });
    lines = event.tiers.flatMap((t) => byTier.get(t.id) ?? []);
  }

  const holders = body.tickets.map((t, i) => {
    const answers = event.questions.flatMap((q) => {
      const given = t.answers?.find((a) => a.id === q.id)?.answer.trim();
      if (!given && q.required) throw invalid(`body/tickets/${i}/answers`, `Answer "${q.label}" for ${t.name.trim()}.`);
      return given ? [{ id: q.id, label: q.label, answer: given }] : [];
    });
    const unknown = t.answers?.find((a) => !event.questions.some((q) => q.id === a.id));
    if (unknown) throw invalid(`body/tickets/${i}/answers`, "That question isn't asked any more. Refresh and try again.");
    return { tierId: event.team ? lines[0]!.tierId : t.tierId, name: t.name.trim(), phone: t.phone, answers };
  });

  let wait: WithId<EventWaitDoc> | null = null;
  if (body.waitlistId) {
    wait = await db.eventWaits.findOne({ _id: new ObjectId(body.waitlistId), eventId: event._id, customerId: customer.id });
    if (!wait || wait.status !== "offered" || !wait.offeredUntil || wait.offeredUntil <= now) {
      throw invalid("body/waitlistId", "These held tickets aren't yours to book any more.");
    }
    const asked = lines.reduce((sum, l) => sum + l.quantity, 0);
    if (lines.some((l) => l.tierId !== wait!.tierId) || asked > wait.quantity) {
      throw invalid("body/tickets", `The held tickets are ${count(wait.quantity, "ticket")} of one type.`);
    }
  }

  const items = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
  const platformFee = items > 0 ? settings.platformFee : 0;
  const total = items + platformFee;
  if (total > MAX_ORDER_TOTAL) throw invalid("body/tickets", "Bookings over ₹5,00,000 can't be paid online. Split it up.");
  const price = { items, platformFee, total, commissionBps: settings.commissionBps, commission: Math.round((items * settings.commissionBps) / 10_000) };
  const free = total === 0;

  const id = new ObjectId();
  const key = signingKey(app);
  const codes = await freshCodes(db, event._id, holders.length);
  const order: EventOrderDoc = {
    _id: id,
    orderNo: 0,
    eventId: event._id,
    businessId: event.businessId,
    vendorId: event.vendorId,
    customerId: customer.id,
    eventTitle: event.title,
    businessName: event.businessName,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    lines,
    team: event.team && body.team ? { name: body.team.name.trim() } : null,
    price,
    status: free ? "confirmed" : "awaiting_payment",
    timeline: [
      { status: "awaiting_payment", at: now, by: "customer" },
      ...(free ? [{ status: "confirmed" as const, at: now, by: "customer" as const }] : []),
    ],
    payment: free ? null : { gatewayOrderId: `rxe_${id.toHexString()}`, sessionId: "", paymentId: null, paidAt: null },
    holdUntil: free ? null : new Date(now.getTime() + PAY_WINDOW_MS),
    waitlistId: wait?._id ?? null,
    refund: null,
    reason: null,
    releaseAt: null,
    releasedAt: null,
    ...stamp(now),
  };
  const tickets: EventTicketDoc[] = holders.map((h, i) => {
    const ticketId = new ObjectId();
    return {
      _id: ticketId,
      orderId: id,
      eventId: event._id,
      businessId: event.businessId,
      customerId: customer.id,
      tierId: h.tierId,
      tierName: lines.find((l) => l.tierId === h.tierId)!.name,
      holder: { name: h.name, phone: h.phone },
      answers: h.answers,
      team: order.team?.name ?? null,
      code: codes[i]!,
      hash: sha256(ticketQr(key, ticketId)),
      status: free ? "valid" : "awaiting_payment",
      checkIns: [],
      clashes: [],
      createdAt: now,
      updatedAt: now,
    };
  });

  await db.transaction(async (session) => {
    if (wait) {
      const res = await db.eventWaits.updateOne(
        { _id: wait._id, status: "offered" },
        { $set: { status: "booked", updatedAt: now }, $unset: { open: "" } },
        { session },
      );
      if (!res.modifiedCount) throw invalid("body/waitlistId", "These held tickets aren't yours to book any more.");
      const extra = wait.quantity - lines[0]!.quantity;
      if (extra > 0) await returnSeats(db, { eventId: event._id, lines: [{ ...lines[0]!, quantity: extra }] }, session);
    } else {
      const { update, arrayFilters } = seatUpdate(lines, -1);
      const res = await db.events.updateOne(
        { _id: event._id, status: "live", tiers: { $all: lines.map((l) => ({ $elemMatch: { id: l.tierId, left: { $gte: l.quantity } } })) } },
        update,
        { session, arrayFilters },
      );
      if (!res.modifiedCount) {
        throw new AppError("CONFLICT", event.team ? "No team entries left. Join the waitlist." : "Not enough tickets left. Join the waitlist or pick fewer.");
      }
    }
    order.orderNo = await nextEventOrderNo(db, session);
    await db.eventOrders.insertOne(order, { session });
    // One at a time: the driver refuses insertMany inside a transaction with a timeout.
    for (const ticket of tickets) await db.eventTickets.insertOne(ticket, { session });
  });

  if (free) {
    await tellBooked(app, db, order, tickets.length);
    return order;
  }
  try {
    const origin = app.config.apiUrl;
    const { sessionId } = await app.payments.createOrder({
      orderId: order.payment!.gatewayOrderId,
      amount: total,
      customer: { id: customer.id.toHexString(), phone: customer.phone.slice(-10), name: customer.name ?? holders[0]!.name },
      note: `${count(tickets.length, "ticket")} for ${event.title}`,
      returnUrl: origin ? `${origin}/pay/events/${id.toHexString()}/done` : null,
      notifyUrl: origin ? `${origin}/webhooks/cashfree` : null,
    });
    const saved = await db.eventOrders.findOneAndUpdate({ _id: id }, { $set: { "payment.sessionId": sessionId } }, { returnDocument: "after" });
    return saved ?? order;
  } catch (err) {
    await cancelTickets(app, db, order, SYSTEM, { reason: "The payment couldn't be set up.", gatewayKnown: false, quiet: true });
    throw err;
  }
}

async function tellBooked(app: FastifyInstance, db: Database, order: EventOrderDoc, tickets: number) {
  const share = vendorShare(order);
  await notifyEvent(db, app.log, {
    actor: order.customerId,
    type: "event.ticket",
    title: `You're in: ${order.eventTitle}`,
    body: `${count(tickets, "ticket")} for ${when(order.startsAt)}. Show the QR codes at the gate.`,
    to: [{ userId: order.customerId, link: { screen: "event_order", id: order._id.toHexString() } }],
  });
  await notifyEvent(db, app.log, {
    actor: order.customerId,
    type: "event.updated",
    title: `New booking #${order.orderNo}`,
    body: `${count(tickets, "ticket")} for ${order.eventTitle}.${share > 0 ? ` ${rupees(share)} to you after the event.` : ""}`,
    to: [{ userId: order.vendorId, link: { screen: "vendor_event", id: order.eventId.toHexString() } }],
  });
}

/** The payment went through: the tickets work, and the money waits in pending until the event ends. Safe to repeat. */
export async function confirmTickets(app: FastifyInstance, db: Database, order: EventOrderDoc, paymentId: string | null): Promise<EventOrderDoc> {
  const now = new Date();
  const after = await db.transaction(async (session) => {
    const done = await db.eventOrders.findOneAndUpdate(
      { _id: order._id, status: "awaiting_payment" },
      {
        $set: { status: "confirmed", "payment.paymentId": paymentId, "payment.paidAt": now, holdUntil: null, releaseAt: order.endsAt, updatedAt: now },
        $push: { timeline: { status: "confirmed", at: now, by: "system" } },
      },
      { session, returnDocument: "after" },
    );
    if (!done) return null;
    await db.eventTickets.updateMany({ orderId: order._id, status: "awaiting_payment" }, { $set: { status: "valid", updatedAt: now } }, { session });
    for (const entry of eventLedger("payment", done, now)) await db.ledgerEntries.insertOne(entry, { session });
    return done;
  });
  if (!after) return (await db.eventOrders.findOne({ _id: order._id })) ?? order;
  await tellBooked(app, db, after, await db.eventTickets.countDocuments({ orderId: after._id }));
  return after;
}

/**
 * Cancels an order: its tickets stop working, the seats go back on sale (to the waitlist first) and a paid order is refunded in
 * full. An unpaid order's payment is stopped at Cashfree first; if it was paid meanwhile, it is confirmed instead.
 */
export async function cancelTickets(
  app: FastifyInstance,
  db: Database,
  order: EventOrderDoc,
  by: By,
  opts: { reason: string; gatewayKnown?: boolean; quiet?: boolean; eventCancelled?: boolean },
): Promise<EventOrderDoc> {
  if (order.status === "cancelled") return order;
  if (order.releasedAt) throw new AppError("ORDER_STATE", "This booking is settled already.");
  if (order.status === "awaiting_payment" && order.payment && opts.gatewayKnown !== false) {
    try {
      await app.payments.terminate(order.payment.gatewayOrderId);
    } catch {
      const now = await syncEventPayment(app, db, order, { noExpiry: true });
      if (now.status !== "confirmed") throw new AppError("PAYMENTS_UNAVAILABLE");
      if (by.kind === "customer" || by.kind === "system") return now;
      order = now;
    }
  }
  const now = new Date();
  const paid = order.status === "confirmed" && order.price.total > 0 && !!order.payment?.paidAt;
  const refund: EventOrderDoc["refund"] = paid
    ? { refundId: `rfe_${order._id.toHexString()}`, amount: order.price.total, reason: opts.reason, by: by.kind, status: "pending", at: now }
    : null;
  const after = await db.transaction(async (session) => {
    const done = await db.eventOrders.findOneAndUpdate(
      { _id: order._id, status: order.status, releasedAt: null },
      {
        $set: { status: "cancelled", reason: opts.reason, refund, holdUntil: null, releaseAt: null, updatedAt: now },
        $push: { timeline: { status: "cancelled", at: now, by: by.kind } },
      },
      { session, returnDocument: "after" },
    );
    if (!done) return null;
    await db.eventTickets.updateMany({ orderId: order._id }, { $set: { status: "cancelled", updatedAt: now } }, { session });
    await returnSeats(db, order, session);
    if (paid) for (const entry of eventLedger("refund", done, now)) await db.ledgerEntries.insertOne(entry, { session });
    if (by.kind !== "system") {
      await writeAudit(
        db,
        {
          actor: by.actor,
          scope: { module: "events", businessId: order.businessId },
          action: "event_order.cancel",
          target: { type: "event_order", id: order._id },
          diff: { status: { from: order.status, to: "cancelled" }, reason: { from: null, to: opts.reason } },
          ip: by.ip ?? null,
        },
        session,
      );
    }
    return done;
  });
  if (!after) {
    const current = await db.eventOrders.findOne({ _id: order._id });
    if (current?.status === "cancelled") return current;
    throw new AppError("ORDER_STATE");
  }
  const result = refund ? await askEventRefund(app, db, after) : after;
  if (!opts.eventCancelled) for (const line of order.lines) await offerSeats(app, db, order.eventId, line.tierId);

  if (!opts.quiet) {
    const money = refund ? ` Your ${rupees(refund.amount)} is being refunded.` : "";
    if (by.kind === "customer") {
      await notifyEvent(db, app.log, {
        actor: order.customerId,
        type: "event.updated",
        title: `Booking #${order.orderNo} cancelled`,
        body: `The customer cancelled ${count(order.lines.reduce((s, l) => s + l.quantity, 0), "ticket")} for ${order.eventTitle}.`,
        to: [{ userId: order.vendorId, link: { screen: "vendor_event", id: order.eventId.toHexString() } }],
      });
    } else if (order.status === "awaiting_payment") {
      await notifyEvent(db, app.log, {
        actor: order.customerId,
        type: "event.updated",
        title: "Booking not completed",
        body: `The payment for ${order.eventTitle} didn't finish in time, so the tickets went back on sale. Book again any time.`,
        to: [{ userId: order.customerId, link: { screen: "event", id: order.eventId.toHexString() } }],
      });
    } else {
      await notifyEvent(db, app.log, {
        actor: by.actor.id ?? order.vendorId,
        type: "event.updated",
        title: `Booking #${order.orderNo} cancelled`,
        body: `${opts.reason}${money}`,
        to: [{ userId: order.customerId, link: { screen: "event_order", id: order._id.toHexString() } }],
      });
    }
  }
  return result;
}

/** Asks Cashfree for the refund, or how it's going. Safe to repeat; a failure leaves it pending for the next sweep. */
export async function askEventRefund(app: FastifyInstance, db: Database, order: EventOrderDoc): Promise<EventOrderDoc> {
  if (order.refund?.status !== "pending" || !order.payment) return order;
  try {
    const { status } = await app.payments.refund(order.payment.gatewayOrderId, order.refund.refundId, order.refund.amount, `Ruxstar tickets #${order.orderNo}`);
    if (status === "pending") return order;
    return (
      (await db.eventOrders.findOneAndUpdate(
        { _id: order._id, "refund.status": "pending" },
        { $set: { "refund.status": "done", updatedAt: new Date() } },
        { returnDocument: "after" },
      )) ?? order
    );
  } catch (err) {
    app.log.error({ err: (err as Error).message, order: order._id.toHexString() }, "Ticket refund not started; it is retried on the next sweep");
    return order;
  }
}

/** While an order waits for payment, asks Cashfree whether it was paid; once the 20 minutes are up, an unpaid one gives its seats back. */
export async function syncEventPayment(
  app: FastifyInstance,
  db: Database,
  order: EventOrderDoc,
  { noExpiry = false }: { noExpiry?: boolean } = {},
): Promise<EventOrderDoc> {
  if (order.status !== "awaiting_payment" || !order.payment) return order.refund?.status === "pending" ? askEventRefund(app, db, order) : order;
  let answer: Awaited<ReturnType<typeof app.payments.status>>;
  try {
    answer = await app.payments.status(order.payment.gatewayOrderId);
  } catch {
    return order;
  }
  if (answer.status === "paid") return confirmTickets(app, db, order, answer.paymentId);
  if (noExpiry) return order;
  if (answer.status === "expired" || answer.status === "terminated") {
    return cancelTickets(app, db, order, SYSTEM, { reason: "The payment didn't go through.", gatewayKnown: false });
  }
  if (order.holdUntil && order.holdUntil.getTime() <= Date.now()) {
    return cancelTickets(app, db, order, SYSTEM, { reason: "The payment didn't finish in time." });
  }
  return order;
}

// The waitlist.

/** Offers freed seats of one type to the waitlist, oldest first, holding them for the next person for Ruxstar's waitlist hours. */
export async function offerSeats(app: FastifyInstance, db: Database, eventId: ObjectId, tierId: string): Promise<void> {
  const settings = await eventSettings(db);
  for (let i = 0; i < 20; i++) {
    const next = await db.eventWaits.find({ eventId, tierId, status: "waiting" }).sort({ createdAt: 1, _id: 1 }).limit(1).next();
    if (!next) return;
    const now = new Date();
    const event = await db.events.findOne({ _id: eventId }, { projection: { title: 1, startsAt: 1, tiers: 1, status: 1 } });
    if (!event || event.status !== "live" || event.startsAt <= now) return;
    const until = new Date(Math.min(now.getTime() + settings.waitlistHours * HOUR_MS, event.startsAt.getTime()));
    const took = await db
      .transaction(async (session) => {
        const res = await db.events.updateOne(
          { _id: eventId, status: "live", tiers: { $elemMatch: { id: tierId, left: { $gte: next.quantity } } } },
          { $inc: { "tiers.$.left": -next.quantity } },
          { session },
        );
        if (!res.modifiedCount) return false;
        const offered = await db.eventWaits.updateOne(
          { _id: next._id, status: "waiting" },
          { $set: { status: "offered", offeredUntil: until, updatedAt: now } },
          { session },
        );
        if (!offered.modifiedCount) throw new AppError("CONFLICT");
        return true;
      })
      .catch(() => false);
    if (!took) return;
    const tier = event.tiers.find((t) => t.id === tierId);
    await notifyEvent(db, app.log, {
      actor: next.customerId,
      type: "event.updated",
      title: `Tickets free for you: ${event.title}`,
      body: `${count(next.quantity, `${tier?.name ?? ""} ticket`.trim())} held for you until ${when(until)}. Book before then.`,
      to: [{ userId: next.customerId, link: { screen: "event", id: eventId.toHexString() } }],
    });
  }
}

/** Gives back the seats held for someone who left the waitlist or let the offer run out, and offers them to the next person. */
export async function endWait(app: FastifyInstance, db: Database, wait: EventWaitDoc, status: "left" | "expired" | "closed"): Promise<void> {
  const now = new Date();
  const freed = await db.transaction(async (session) => {
    const res = await db.eventWaits.updateOne(
      { _id: wait._id, status: wait.status },
      { $set: { status, updatedAt: now }, $unset: { open: "" } },
      { session },
    );
    if (!res.modifiedCount) return false;
    if (wait.status === "offered") await returnSeats(db, { eventId: wait.eventId, lines: [{ tierId: wait.tierId, quantity: wait.quantity }] }, session);
    return wait.status === "offered";
  });
  if (freed && status !== "closed") await offerSeats(app, db, wait.eventId, wait.tierId);
}

// The whole event.

/** Cancels an event and every booking for it, refunding each in full, platform fee included. */
export async function cancelEvent(app: FastifyInstance, db: Database, event: WithId<EventDoc>, by: By & { kind: "vendor" | "staff" }, reason: string) {
  if (event.status === "cancelled") throw new AppError("CONFLICT", "This event is cancelled already.");
  if (event.status === "live" && event.endsAt.getTime() <= Date.now()) throw new AppError("CONFLICT", "This event is over, so it can't be cancelled.");
  const now = new Date();
  const res = await db.events.updateOne(
    { _id: event._id, status: event.status },
    { $set: { status: "cancelled", cancellation: { by: by.kind, actorId: by.actor.id!, reason, at: now }, updatedAt: now } },
  );
  if (!res.modifiedCount) throw new AppError("CONFLICT");
  await writeAudit(db, {
    actor: by.actor,
    scope: { module: "events", businessId: event.businessId },
    action: by.kind === "staff" ? "event.take_down" : "event.cancel",
    target: { type: "event", id: event._id },
    diff: { status: { from: event.status, to: "cancelled" }, reason: { from: null, to: reason } },
    ip: by.ip ?? null,
  });
  await db.eventWaits.updateMany({ eventId: event._id, open: true }, { $set: { status: "closed", updatedAt: now }, $unset: { open: "" } });

  const told: { userId: ObjectId; link: { screen: "event_order"; id: string } }[] = [];
  const orders = db.eventOrders.find({ eventId: event._id, status: { $in: ["awaiting_payment", "confirmed"] } });
  for await (const order of orders) {
    try {
      const done = await cancelTickets(app, db, order, by, { reason, quiet: true, eventCancelled: true });
      if (order.status === "confirmed") told.push({ userId: done.customerId, link: { screen: "event_order", id: done._id.toHexString() } });
    } catch (err) {
      app.log.error({ err: (err as Error).message, order: order._id.toHexString() }, "Booking not cancelled with its event; the sweep retries it");
    }
  }
  await notifyEvent(db, app.log, {
    actor: by.actor.id ?? event.vendorId,
    type: "event.updated",
    title: `Cancelled: ${event.title}`,
    body: `${reason} Paid tickets are refunded in full.`,
    to: told,
  });
  if (by.kind === "staff") {
    await notifyEvent(db, app.log, {
      actor: by.actor.id ?? event.vendorId,
      type: "event.updated",
      title: `Ruxstar took down ${event.title}`,
      body: `${reason} Every booking was refunded. Contact support if you think this is wrong.`,
      to: [{ userId: event.vendorId, link: { screen: "vendor_event", id: event._id.toHexString() } }],
    });
  }
}

/** Once an event ends, the organiser's share of each paid booking moves to their available balance. */
export async function releaseEventShares(app: FastifyInstance, db: Database, filter: { vendorId?: ObjectId }, now = new Date()): Promise<number> {
  const due = await db.eventOrders
    .find({ ...filter, status: "confirmed", releasedAt: null, releaseAt: { $lte: now } })
    .limit(100)
    .toArray();
  let released = 0;
  for (const order of due) {
    const done = await db.transaction(async (session) => {
      const after = await db.eventOrders.findOneAndUpdate(
        { _id: order._id, status: "confirmed", releasedAt: null },
        { $set: { releasedAt: now, updatedAt: now } },
        { session, returnDocument: "after" },
      );
      if (!after) return false;
      for (const entry of eventLedger("release", after, now)) await db.ledgerEntries.insertOne(entry, { session });
      return true;
    });
    if (done) released++;
  }
  return released;
}

/** The events timers: unpaid bookings past their 20 minutes, waitlist offers that ran out, shares due, refunds to retry, bookings of cancelled events. */
export async function sweepEvents(app: FastifyInstance, db: Database) {
  const now = new Date();
  let holds = 0;
  for (const order of await db.eventOrders.find({ status: "awaiting_payment", holdUntil: { $lte: now } }).limit(100).toArray()) {
    const after = await syncEventPayment(app, db, order).catch(() => order);
    if (after.status !== "awaiting_payment") holds++;
  }
  let offers = 0;
  for (const wait of await db.eventWaits.find({ status: "offered", offeredUntil: { $lte: now } }).limit(100).toArray()) {
    await endWait(app, db, wait, "expired");
    offers++;
  }
  const releases = await releaseEventShares(app, db, {}, now);
  let refunds = 0;
  for (const order of await db.eventOrders.find({ "refund.status": "pending" }).limit(100).toArray()) {
    if ((await askEventRefund(app, db, order)).refund?.status === "done") refunds++;
  }
  const cancelled = await db.events.find({ status: "cancelled", "cancellation.at": { $gte: new Date(now.getTime() - 7 * 24 * HOUR_MS) } }, { projection: { _id: 1 } }).toArray();
  for (const order of await db.eventOrders
    .find({ eventId: { $in: cancelled.map((e) => e._id) }, status: { $in: ["awaiting_payment", "confirmed"] } })
    .limit(100)
    .toArray()) {
    await cancelTickets(app, db, order, SYSTEM, { reason: "The event was cancelled.", eventCancelled: true }).catch(() => undefined);
  }
  return { eventHolds: holds, eventOffers: offers, eventReleases: releases, eventRefunds: refunds };
}
