import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyInstance } from "fastify";
import { ObjectId, type Filter, type WithId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { Database, EventDoc, EventOrderDoc, EventWaitDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { isModuleLive } from "../../platform/module-switch.js";
import { decodeCursor, encodeCursor, findPage } from "../../platform/pagination.js";
import { safeReturn, signingKey } from "../pod/orders.js";
import { escapeRegex } from "../pod/shops.js";
import { Done } from "../social/contracts.js";
import { eventCheckoutUrl } from "./checkout.js";
import {
  CheckoutLinkOne,
  CreateTicketsBody,
  EventList,
  EventOne,
  EventParams,
  EventRulesOne,
  EventsQuery,
  JoinWaitlistBody,
  MAX_EVENT_DAYS,
  MyTicketsQuery,
  PayTicketsBody,
  PlacedTickets,
  TicketOrderList,
  TicketOrderOne,
  WaitOne,
  WaitParams,
  type EventDetail,
} from "./contracts.js";
import desk from "./desk.js";
import { bookTickets, cancelTickets, endWait, syncEventPayment } from "./orders.js";
import { cancelUntil, eventCard, eventSettings, MAX_PER_ORDER, ticketOrderView } from "./rules.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

async function waitView(db: Database, wait: WithId<EventWaitDoc>) {
  const ahead =
    wait.status === "waiting"
      ? await db.eventWaits.countDocuments({ eventId: wait.eventId, tierId: wait.tierId, status: "waiting", createdAt: { $lt: wait.createdAt } })
      : 0;
  return {
    id: wait._id.toHexString(),
    tierId: wait.tierId,
    quantity: wait.quantity,
    status: wait.status as "waiting" | "offered",
    position: wait.status === "waiting" ? ahead + 1 : null,
    offeredUntil: wait.status === "offered" ? (wait.offeredUntil?.toISOString() ?? null) : null,
  };
}

/** Orders with their events and tickets, ready to show. */
export async function ticketOrders(app: FastifyInstance, db: Database, orders: EventOrderDoc[]) {
  const [events, tickets, rules] = await Promise.all([
    db.events.find({ _id: { $in: orders.map((o) => o.eventId) } }).toArray(),
    db.eventTickets.find({ orderId: { $in: orders.map((o) => o._id) } }).sort({ _id: 1 }).toArray(),
    eventSettings(db),
  ]);
  const key = signingKey(app);
  return orders.map((o) =>
    ticketOrderView(
      o,
      events.find((e) => e._id.equals(o.eventId)) ?? null,
      tickets.filter((t) => t.orderId.equals(o._id)),
      { key, rules },
    ),
  );
}

/** Events for customers: finding them, booking tickets, the waitlist and their own tickets. Scanning at the gate is under /desk. */
const events: FastifyPluginAsyncTypebox = async (app) => {
  await app.register(desk, { prefix: "/desk" });
  const db = () => requireDatabase(app.db);

  /** Live businesses only: events from one on hold are hidden. */
  async function heldBusinesses(ids: ObjectId[]) {
    const held = await db().businesses.find({ _id: { $in: ids }, suspension: { $exists: true } }, { projection: { _id: 1 } }).toArray();
    return new Set(held.map((b) => b._id.toHexString()));
  }

  async function mine(userId: ObjectId, id: string) {
    const doc = await db().eventOrders.findOne({ _id: new ObjectId(id), customerId: userId });
    if (!doc) throw new AppError("NOT_FOUND", "Booking not found.");
    return doc;
  }

  app.get(
    "/rules",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["events"],
        summary: "Ruxstar's rules for events: refunds, the waitlist and limits",
        response: { 200: EventRulesOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const s = await eventSettings(db());
      return ok(request, {
        refundHours: s.refundHours,
        waitlistHours: s.waitlistHours,
        maxTicketTypes: s.maxTicketTypes,
        maxQuestions: s.maxQuestions,
        maxPerOrder: MAX_PER_ORDER,
        maxDays: MAX_EVENT_DAYS,
        commissionBps: s.commissionBps,
        platformFee: s.platformFee,
      });
    },
  );

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["events"],
        summary: "Events on sale, soonest first",
        description: "Including ones under way. With `city`, events there and online ones. Empty while Ruxstar has events switched off.",
        querystring: EventsQuery,
        response: { 200: EventList, ...Errors },
        security,
      },
    },
    async (request) => {
      if (!(await isModuleLive(db(), "events"))) return page(request, [], null);
      const { city, kind, q, cursor } = request.query;
      const limit = Math.min(request.query.limit ?? 20, 50);
      const filters: Filter<EventDoc>[] = [{ status: "live", endsAt: { $gt: new Date() } }];
      if (city) filters.push({ $or: [{ city: city.trim().toLowerCase() }, { online: { $ne: null } }] });
      if (kind) filters.push({ kind });
      if (q?.trim()) {
        const words = { $regex: escapeRegex(q.trim()), $options: "i" };
        filters.push({ $or: [{ title: words }, { businessName: words }] });
      }
      if (cursor) {
        const { value, id } = decodeCursor(cursor);
        filters.push({ $or: [{ startsAt: { $gt: value as Date } }, { startsAt: value as Date, _id: { $gt: id } }] });
      }
      const rows = await db().events.find({ $and: filters }).sort({ startsAt: 1, _id: 1 }).limit(limit + 1).toArray();
      const items = rows.slice(0, limit);
      const held = await heldBusinesses([...new Set(items.map((e) => e.businessId.toHexString()))].map((id) => new ObjectId(id)));
      const last = items.at(-1);
      const next = rows.length > limit && last ? encodeCursor(last.startsAt, last._id) : null;
      return page(request, items.filter((e) => !held.has(e.businessId.toHexString())).map((e) => eventCard(e)), next);
    },
  );

  app.get(
    "/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["events"],
        summary: "One event: tickets left, the questions asked, refunds, and your bookings and waitlist places",
        params: EventParams,
        response: { 200: EventOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const event = await db().events.findOne({ _id: new ObjectId(request.params.id) });
      const own = event?.vendorId.equals(userId);
      if (!event || (event.status === "draft" && !own)) throw new AppError("NOT_FOUND", "This event isn't on Ruxstar.");
      const [business, settings, live, orders, waits] = await Promise.all([
        db().businesses.findOne({ _id: event.businessId }, { projection: { suspension: 1, photos: { $slice: 1 } } }),
        eventSettings(db()),
        isModuleLive(db(), "events"),
        db().eventOrders.find({ eventId: event._id, customerId: userId }).sort({ createdAt: -1 }).limit(20).toArray(),
        db().eventWaits.find({ eventId: event._id, customerId: userId, open: true }).toArray(),
      ]);
      if (business?.suspension && !own) throw new AppError("NOT_FOUND", "This event isn't on Ruxstar.");
      const now = Date.now();
      const tickets = orders.length
        ? await db().eventTickets.countDocuments({ orderId: { $in: orders.filter((o) => o.status === "confirmed").map((o) => o._id) } })
        : 0;
      const counts = await db()
        .eventTickets.aggregate<{ _id: ObjectId; n: number }>([{ $match: { orderId: { $in: orders.map((o) => o._id) } } }, { $group: { _id: "$orderId", n: { $sum: 1 } } }])
        .toArray();
      const over = event.endsAt.getTime() <= now;
      const whyNot =
        event.status === "cancelled"
          ? "This event was cancelled."
          : event.status === "draft"
            ? "This is your draft. Publish it to sell tickets."
            : over
              ? "This event is over."
              : event.startsAt.getTime() <= now
                ? "Bookings closed when the event started."
                : !live
                  ? "Ruxstar isn't taking event bookings right now."
                  : own
                    ? "This is your event."
                    : null;
      const until = cancelUntil(event, settings);
      const photo = business?.photos?.[0] ? { url: business.photos[0].url, width: business.photos[0].width, height: business.photos[0].height } : null;
      const detail: EventDetail = {
        ...eventCard(event, photo),
        description: event.description,
        venue: event.venue,
        onlineLink: tickets > 0 ? (event.online?.link ?? null) : null,
        teamSize: event.team,
        tiers: event.tiers.map((t) => ({ id: t.id, name: t.name, price: t.price, left: Math.max(0, t.left), soldOut: t.left <= 0 })),
        questions: event.questions,
        refunds: { policy: event.refunds, until: until?.toISOString() ?? null, hours: settings.refundHours },
        platformFee: settings.platformFee,
        status: event.status === "cancelled" ? "cancelled" : over ? "ended" : "live",
        cancelReason: event.cancellation?.reason ?? null,
        canBuy: whyNot === null,
        whyNot,
        myOrders: orders.map((o) => ({
          id: o._id.toHexString(),
          orderNo: o.orderNo,
          status: o.status,
          tickets: counts.find((c) => c._id.equals(o._id))?.n ?? 0,
        })),
        myWaits: await Promise.all(waits.map((w) => waitView(db(), w))),
        maxPerOrder: MAX_PER_ORDER,
      };
      return ok(request, detail);
    },
  );

  app.post(
    "/:id/tickets",
    {
      preHandler: [requireAuth, idempotent],
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["events"],
        summary: "Book tickets: one per person, each with a name and phone number",
        description:
          "Free bookings are confirmed at once. Paid ones return a checkout link and hold the seats for 20 minutes; unpaid, they go back on sale. " +
          "For a team entry, send `team` and one ticket per player. With `waitlistId`, the seats held for you are used.",
        params: EventParams,
        body: CreateTicketsBody,
        response: { 201: PlacedTickets, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const database = db();
      const userId = request.auth!.userId;
      const back = safeReturn(app, request.body.returnTo);
      if (!(await isModuleLive(database, "events"))) throw new AppError("MODULE_OFF");
      const event = await database.events.findOne({ _id: new ObjectId(request.params.id) });
      if (!event) throw new AppError("NOT_FOUND", "This event isn't on Ruxstar.");
      const business = await database.businesses.findOne({ _id: event.businessId }, { projection: { suspension: 1 } });
      if (business?.suspension) throw new AppError("BUSINESS_SUSPENDED");
      const user = await database.users.findOne({ _id: userId }, { projection: { phone: 1, name: 1 } });
      const order = await bookTickets(app, database, event, { id: userId, phone: user?.phone ?? request.body.tickets[0]!.phone, name: user?.name ?? null }, request.body);
      const [view] = await ticketOrders(app, database, [order]);
      const checkoutUrl = order.status === "awaiting_payment" ? eventCheckoutUrl(app, request, order, back) : null;
      return reply.status(201).send(ok(request, { order: view!, checkoutUrl }));
    },
  );

  app.post(
    "/:id/waitlist",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["events"],
        summary: "Join the waitlist for a sold-out ticket type",
        description: "When tickets come back, the next person gets them held for Ruxstar's waitlist hours and a notification. One place per ticket type.",
        params: EventParams,
        body: JoinWaitlistBody,
        response: { 201: WaitOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const userId = request.auth!.userId;
      const event = await db().events.findOne({ _id: new ObjectId(request.params.id), status: "live" });
      if (!event || event.startsAt.getTime() <= Date.now()) throw new AppError("NOT_FOUND", "This event isn't taking bookings.");
      if (event.vendorId.equals(userId)) throw new AppError("CONFLICT", "This is your event.");
      const tier = event.tiers.find((t) => t.id === request.body.tierId);
      if (!tier) throw new AppError("VALIDATION_FAILED", "This ticket type isn't on sale.", [{ path: "body/tierId", message: "Not found" }]);
      const quantity = event.team ? 1 : request.body.quantity;
      if (tier.left >= quantity) throw new AppError("CONFLICT", "Those tickets are available. Book them now.");
      const now = new Date();
      const doc: EventWaitDoc = {
        _id: new ObjectId(),
        eventId: event._id,
        tierId: tier.id,
        customerId: userId,
        quantity,
        status: "waiting",
        open: true,
        offeredUntil: null,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await db().eventWaits.insertOne(doc);
      } catch (err) {
        if ((err as { code?: number }).code === 11000) throw new AppError("CONFLICT", "You're on this waitlist already.");
        throw err;
      }
      return reply.status(201).send(ok(request, await waitView(db(), doc)));
    },
  );

  app.delete(
    "/waitlist/:id",
    {
      preHandler: requireAuth,
      schema: { tags: ["events"], summary: "Leave a waitlist, or let held tickets go", params: WaitParams, response: { 200: Done, ...Errors }, security },
    },
    async (request) => {
      const wait = await db().eventWaits.findOne({ _id: new ObjectId(request.params.id), customerId: request.auth!.userId, open: true });
      if (!wait) throw new AppError("NOT_FOUND", "You're not on this waitlist.");
      await endWait(app, db(), wait, "left");
      return ok(request, { done: true as const });
    },
  );

  app.get(
    "/orders",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["events"],
        summary: "Your tickets: upcoming soonest first, or past ones newest first",
        querystring: MyTicketsQuery,
        response: { 200: TicketOrderList, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const now = new Date();
      if ((request.query.view ?? "upcoming") === "upcoming") {
        const docs = await db()
          .eventOrders.find({ customerId: userId, endsAt: { $gt: now }, status: { $in: ["confirmed", "awaiting_payment"] } })
          .sort({ startsAt: 1, _id: 1 })
          .limit(50)
          .toArray();
        return page(request, await ticketOrders(app, db(), docs), null);
      }
      const { items, nextCursor } = await findPage(db().eventOrders, {
        filter: { customerId: userId, $or: [{ endsAt: { $lte: now } }, { status: "cancelled" }] },
        sortField: "startsAt",
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      return page(request, await ticketOrders(app, db(), items), nextCursor);
    },
  );

  app.get(
    "/orders/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["events"],
        summary: "One booking with its tickets and QR codes",
        description: "While it waits for payment, Cashfree is asked whether it was paid.",
        params: EventParams,
        response: { 200: TicketOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const order = await syncEventPayment(app, db(), await mine(request.auth!.userId, request.params.id));
      return ok(request, (await ticketOrders(app, db(), [order]))[0]!);
    },
  );

  app.post(
    "/orders/:id/pay",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["events"],
        summary: "A fresh checkout link for a booking waiting for payment",
        params: EventParams,
        body: PayTicketsBody,
        response: { 200: CheckoutLinkOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const back = safeReturn(app, request.body.returnTo);
      const order = await syncEventPayment(app, db(), await mine(request.auth!.userId, request.params.id));
      if (order.status !== "awaiting_payment") throw new AppError("ORDER_STATE", order.status === "confirmed" ? "This booking is paid." : "This booking was cancelled.");
      return ok(request, { checkoutUrl: eventCheckoutUrl(app, request, order, back) });
    },
  );

  app.post(
    "/orders/:id/cancel",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["events"],
        summary: "Cancel a booking",
        description:
          "Unpaid: the seats go back on sale. Paid: a full refund until Ruxstar's refund hours before the start, unless the organiser chose no refunds.",
        params: EventParams,
        response: { 200: TicketOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const order = await mine(request.auth!.userId, request.params.id);
      if (order.status === "cancelled") throw new AppError("ORDER_STATE", "This booking is cancelled already.");
      const event = await db().events.findOne({ _id: order.eventId });
      if (order.status === "confirmed") {
        const until = event ? cancelUntil(event, await eventSettings(db())) : null;
        if (!until) throw new AppError("ORDER_STATE", "The organiser doesn't give refunds for this event.");
        if (until.getTime() <= Date.now()) throw new AppError("ORDER_STATE", "Refunds closed before the event. You can't cancel now.");
      }
      const done = await cancelTickets(
        app,
        db(),
        order,
        { kind: "customer", actor: actorOf(request), ip: request.ip },
        { reason: order.status === "confirmed" ? "You cancelled it." : "You cancelled before paying." },
      );
      return ok(request, (await ticketOrders(app, db(), [done]))[0]!);
    },
  );
};

export default events;
