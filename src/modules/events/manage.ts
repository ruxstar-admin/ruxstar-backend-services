import { randomUUID } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type WithId } from "mongodb";
import type { Static } from "typebox";
import { Errors } from "../../contracts/common.js";
import { actorOf, diffOf, writeAudit } from "../../platform/audit.js";
import { requireDatabase } from "../../platform/context.js";
import { stamp, type BusinessPhoto, type Database, type EventDoc, type EventRules, type EventTierDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { isModuleLive } from "../../platform/module-switch.js";
import { findPage } from "../../platform/pagination.js";
import { notifyEvent } from "../notifications/notify.js";
import { toPostPhoto } from "../social/photos.js";
import { Done } from "../social/contracts.js";
import { ownedBy, photoKeys, requireVendor } from "../vendor/businesses.js";
import {
  BookingList,
  BookingsQuery,
  BusinessEventsParams,
  CancelEventBody,
  CreateEventBody,
  EventParams,
  MAX_EVENT_DAYS,
  UpdateEventBody,
  VendorEventList,
  VendorEventOne,
  type Booking,
  type VendorEvent,
} from "./contracts.js";
import { cancelEvent } from "./orders.js";
import { dayOf, ended, eventCard, eventSettings, HOUR_MS, vendorShare } from "./rules.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const invalid = (path: string, message: string) => new AppError("VALIDATION_FAILED", message, [{ path, message }]);
const by = (request: FastifyRequest) => ({ actor: actorOf(request), ip: request.ip });
const when = (at: Date) =>
  at.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

type Fields = Static<typeof CreateEventBody>;
type Shaped = Pick<EventDoc, "title" | "description" | "kind" | "venue" | "online" | "city" | "startsAt" | "endsAt" | "team" | "tiers" | "questions" | "refunds">;

/** Checks an event's details against Ruxstar's limits and what's sold, and keeps each ticket type's sales. */
export function shapeEvent(body: Fields, rules: EventRules, before: EventDoc | null): Shaped {
  if (body.tiers.length > rules.maxTicketTypes) throw invalid("body/tiers", `Up to ${rules.maxTicketTypes} ticket types.`);
  if (body.questions.length > rules.maxQuestions) throw invalid("body/questions", `Up to ${rules.maxQuestions} questions.`);
  if (!body.venue === !body.online) throw invalid("body/venue", "Add the venue, or the link for an online event.");
  const startsAt = new Date(body.startsAt);
  const endsAt = new Date(body.endsAt);
  if (endsAt <= startsAt) throw invalid("body/endsAt", "The end must be after the start.");
  if (endsAt.getTime() - startsAt.getTime() > MAX_EVENT_DAYS * 24 * HOUR_MS) throw invalid("body/endsAt", `An event runs for up to ${MAX_EVENT_DAYS} days.`);
  if (body.team && body.team.min > body.team.max) throw invalid("body/team/max", "The most players can't be fewer than the fewest.");

  const names = new Set<string>();
  const kept = new Set<string>();
  const tiers = body.tiers.map((t, i): EventTierDoc => {
    const name = t.name.trim();
    if (names.has(name.toLowerCase())) throw invalid(`body/tiers/${i}/name`, "Each ticket type needs its own name.");
    names.add(name.toLowerCase());
    const old = t.id ? before?.tiers.find((b) => b.id === t.id) : undefined;
    if (t.id && !old) throw invalid(`body/tiers/${i}/id`, "This ticket type isn't on the event. Refresh and try again.");
    if (!old) return { id: randomUUID().slice(0, 8), name, price: t.price, capacity: t.capacity, left: t.capacity };
    kept.add(old.id);
    const taken = old.capacity - old.left;
    if (t.capacity < taken) throw invalid(`body/tiers/${i}/capacity`, `${taken} of ${old.name} are sold or held, so it can't go below that.`);
    return { id: old.id, name, price: t.price, capacity: t.capacity, left: t.capacity - taken };
  });
  for (const old of before?.tiers ?? []) {
    if (!kept.has(old.id) && old.capacity - old.left > 0) {
      throw invalid("body/tiers", `${old.name} has tickets sold or held, so it can't be removed. Set its capacity to what's sold instead.`);
    }
  }
  const sold = (before?.tiers ?? []).some((t) => t.capacity - t.left > 0);
  if (sold && JSON.stringify(body.team) !== JSON.stringify(before?.team ?? null)) {
    throw invalid("body/team", "Team entries can't change once tickets are sold.");
  }
  if (sold && body.refunds === "none" && before?.refunds === "standard") {
    throw invalid("body/refunds", "People bought tickets expecting refunds, so this can't change to no refunds now.");
  }
  const questions = body.questions.map((q) => {
    const id = q.id && before?.questions.some((b) => b.id === q.id) ? q.id : randomUUID().slice(0, 8);
    return { id, label: q.label.trim(), required: q.required };
  });
  const venue = body.venue
    ? { name: body.venue.name.trim(), address: body.venue.address.trim(), city: body.venue.city.trim(), point: body.venue.point ?? null }
    : null;
  return {
    title: body.title.trim(),
    description: body.description?.trim() || null,
    kind: body.kind,
    venue,
    online: body.online ? { link: body.online.link.trim() } : null,
    city: venue ? venue.city.toLowerCase() : null,
    startsAt,
    endsAt,
    team: body.team ?? null,
    tiers,
    questions,
    refunds: body.refunds,
  };
}

const fieldsOf = (doc: EventDoc): Fields => ({
  title: doc.title,
  description: doc.description,
  kind: doc.kind,
  venue: doc.venue,
  online: doc.online,
  startsAt: doc.startsAt.toISOString(),
  endsAt: doc.endsAt.toISOString(),
  team: doc.team,
  tiers: doc.tiers.map(({ id, name, price, capacity }) => ({ id, name, price, capacity })),
  questions: doc.questions,
  refunds: doc.refunds,
});

function missingOf(event: EventDoc, businessLive: boolean, now = Date.now()): string[] {
  const missing: string[] = [];
  if (!businessLive) missing.push("Publish your business first");
  if (event.startsAt.getTime() <= now) missing.push("Set a start time in the future");
  if (!event.venue && !event.online) missing.push("Add the venue, or the link for an online event");
  if (!event.tiers.length) missing.push("Add a ticket type");
  return missing;
}

/** Each event with its sales, today's check-ins and waitlist, in four reads however many there are. */
export async function vendorViews(db: Database, events: WithId<EventDoc>[], businessLive: (id: ObjectId) => boolean): Promise<VendorEvent[]> {
  if (!events.length) return [];
  const ids = events.map((e) => e._id);
  const today = dayOf(new Date());
  const [tickets, inToday, waits, sales] = await Promise.all([
    db.eventTickets.aggregate<{ _id: ObjectId; n: number }>([{ $match: { eventId: { $in: ids }, status: "valid" } }, { $group: { _id: "$eventId", n: { $sum: 1 } } }]).toArray(),
    db.eventTickets
      .aggregate<{ _id: ObjectId; n: number }>([{ $match: { eventId: { $in: ids }, status: "valid", "checkIns.day": today } }, { $group: { _id: "$eventId", n: { $sum: 1 } } }])
      .toArray(),
    db.eventWaits.aggregate<{ _id: ObjectId; n: number }>([{ $match: { eventId: { $in: ids }, open: true } }, { $group: { _id: "$eventId", n: { $sum: "$quantity" } } }]).toArray(),
    db.eventOrders
      .aggregate<{ _id: ObjectId; items: number; share: number; lines: { tierId: string; quantity: number }[][] }>([
        { $match: { eventId: { $in: ids }, status: "confirmed" } },
        { $group: { _id: "$eventId", items: { $sum: "$price.items" }, share: { $sum: { $subtract: ["$price.items", "$price.commission"] } }, lines: { $push: "$lines" } } },
      ])
      .toArray(),
  ]);
  const n = (rows: { _id: ObjectId; n: number }[], id: ObjectId) => rows.find((r) => r._id.equals(id))?.n ?? 0;
  const settings = await eventSettings(db);
  return events.map((e) => {
    const money = sales.find((s) => s._id.equals(e._id));
    const soldOf = (tierId: string) => (money?.lines ?? []).flat().reduce((sum, l) => sum + (l.tierId === tierId ? l.quantity : 0), 0);
    return {
      ...eventCard(e),
      description: e.description,
      venue: e.venue,
      onlineLink: e.online?.link ?? null,
      teamSize: e.team,
      tiers: e.tiers.map((t) => {
        const sold = soldOf(t.id);
        return { id: t.id, name: t.name, price: t.price, capacity: t.capacity, sold, held: Math.max(0, t.capacity - t.left - sold), left: t.left };
      }),
      questions: e.questions,
      refunds: e.refunds,
      status: e.status === "live" && ended(e) ? "ended" : e.status,
      publishedAt: e.publishedAt?.toISOString() ?? null,
      cancellation: e.cancellation ? { by: e.cancellation.by, reason: e.cancellation.reason, at: e.cancellation.at.toISOString() } : null,
      counts: { tickets: n(tickets, e._id), checkedIn: n(inToday, e._id), waiting: n(waits, e._id) },
      money: { sales: money?.items ?? 0, share: money?.share ?? 0, commissionBps: settings.commissionBps },
      missing: e.status === "draft" ? missingOf(e, businessLive(e.businessId)) : [],
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    };
  });
}

/** An organiser's events: making them, selling tickets, and the bookings. Only the business's owner manages them. */
const manage: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  async function business(request: FastifyRequest, id: string) {
    const doc = await db().businesses.findOne(ownedBy(new ObjectId(id), request.auth!.userId));
    if (!doc) throw new AppError("NOT_FOUND", "Business not found.");
    if (doc.module !== "events") throw new AppError("CONFLICT", "Events are for events businesses.");
    return doc;
  }
  async function owned(request: FastifyRequest, id: string, { editing = true } = {}) {
    const doc = await db().events.findOne({ _id: new ObjectId(id), vendorId: request.auth!.userId });
    if (!doc) throw new AppError("NOT_FOUND", "Event not found.");
    if (editing) {
      const shop = await db().businesses.findOne({ _id: doc.businessId }, { projection: { suspension: 1 } });
      if (shop?.suspension) throw new AppError("BUSINESS_SUSPENDED");
      if (doc.status === "cancelled") throw new AppError("CONFLICT", "This event is cancelled.");
    }
    return doc;
  }
  async function view(event: WithId<EventDoc>) {
    const shop = await db().businesses.findOne({ _id: event.businessId }, { projection: { status: 1 } });
    return (await vendorViews(db(), [event], () => shop?.status === "live"))[0]!;
  }

  app.get(
    "/businesses/:id/events",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "A business's events, soonest first, then past ones",
        params: BusinessEventsParams,
        response: { 200: VendorEventList, ...Errors },
        security,
      },
    },
    async (request) => {
      const shop = await business(request, request.params.id);
      const docs = await db().events.find({ businessId: shop._id }).sort({ startsAt: -1 }).limit(100).toArray();
      const now = Date.now();
      const upcoming = docs.filter((d) => d.endsAt.getTime() > now).reverse();
      const past = docs.filter((d) => d.endsAt.getTime() <= now);
      return page(request, await vendorViews(db(), [...upcoming, ...past], () => shop.status === "live"), null);
    },
  );

  app.post(
    "/businesses/:id/events",
    {
      preHandler: [requireVendor, idempotent],
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Make an event as a draft",
        description: "Add a poster next if you like, then publish it. Ticket types, questions and limits follow GET /v1/events/rules.",
        params: BusinessEventsParams,
        body: CreateEventBody,
        response: { 201: VendorEventOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const shop = await business(request, request.params.id);
      if (shop.suspension) throw new AppError("BUSINESS_SUSPENDED");
      if (!(await isModuleLive(db(), "events"))) throw new AppError("MODULE_OFF");
      const shaped = shapeEvent(request.body, await eventSettings(db()), null);
      const doc: EventDoc = {
        _id: new ObjectId(),
        businessId: shop._id,
        vendorId: shop.ownerId,
        businessName: shop.name,
        ...shaped,
        photo: null,
        status: "draft",
        publishedAt: null,
        cancellation: null,
        ...stamp(),
      };
      await db().events.insertOne(doc);
      await writeAudit(db(), {
        ...by(request),
        scope: { module: "events", businessId: shop._id },
        action: "event.create",
        target: { type: "event", id: doc._id },
        diff: { title: { from: null, to: doc.title } },
      });
      return reply.status(201).send(ok(request, await view(doc)));
    },
  );

  app.get(
    "/events/:id",
    {
      preHandler: requireVendor,
      schema: { tags: ["vendor"], summary: "One of your events, with its sales", params: EventParams, response: { 200: VendorEventOne, ...Errors }, security },
    },
    async (request) => ok(request, await view(await owned(request, request.params.id, { editing: false }))),
  );

  app.patch(
    "/events/:id",
    {
      preHandler: requireVendor,
      config: { rateLimit: { max: 60, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Change an event",
        params: EventParams,
        body: UpdateEventBody,
        response: { 200: VendorEventOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const before = await owned(request, request.params.id);
      if (ended(before)) throw new AppError("CONFLICT", "This event is over, so it can't change.");
      const merged = { ...fieldsOf(before), ...request.body } as Fields;
      const shaped = shapeEvent(merged, await eventSettings(db()), before);
      if (before.status === "live" && shaped.startsAt.getTime() <= Date.now() && shaped.startsAt.getTime() !== before.startsAt.getTime()) {
        throw invalid("body/startsAt", "Pick a start time in the future.");
      }
      const diff = diffOf(before as unknown as Record<string, unknown>, shaped as unknown as Record<string, unknown>);
      if (!Object.keys(diff).length) return ok(request, await view(before));
      const now = new Date();
      // Bookings change the seats left, so the change only lands on the ticket types as they were read.
      const after = await db().events.findOneAndUpdate(
        { _id: before._id, status: before.status, tiers: before.tiers },
        { $set: { ...shaped, updatedAt: now } },
        { returnDocument: "after" },
      );
      if (!after) throw new AppError("CONFLICT", "Tickets were just booked. Check the numbers and save again.");
      await writeAudit(db(), { ...by(request), scope: { module: "events", businessId: before.businessId }, action: "event.update", target: { type: "event", id: before._id }, diff });

      const moved = after.startsAt.getTime() !== before.startsAt.getTime() || after.endsAt.getTime() !== before.endsAt.getTime();
      const elsewhere = JSON.stringify(after.venue) !== JSON.stringify(before.venue) || JSON.stringify(after.online) !== JSON.stringify(before.online);
      if (moved) {
        await db().eventOrders.updateMany({ eventId: after._id }, { $set: { startsAt: after.startsAt, endsAt: after.endsAt, updatedAt: now } });
        await db().eventOrders.updateMany({ eventId: after._id, status: "confirmed", releasedAt: null, "payment.paidAt": { $ne: null } }, { $set: { releaseAt: after.endsAt } });
      }
      if (after.title !== before.title) await db().eventOrders.updateMany({ eventId: after._id }, { $set: { eventTitle: after.title } });
      if (after.status === "live" && (moved || elsewhere)) {
        const orders = await db().eventOrders.find({ eventId: after._id, status: "confirmed" }, { projection: { customerId: 1 } }).toArray();
        const where = after.venue ? `${after.venue.name}, ${after.venue.city}` : "online";
        await notifyEvent(db(), request.log, {
          actor: request.auth!.userId,
          type: "event.updated",
          title: `Changed: ${after.title}`,
          body: `Now ${when(after.startsAt)}, ${where}. Your tickets still work.`,
          to: orders.map((o) => ({ userId: o.customerId, link: { screen: "event_order" as const, id: o._id.toHexString() } })),
        });
      }
      return ok(request, await view(after));
    },
  );

  app.post(
    "/events/:id/photo",
    {
      preHandler: requireVendor,
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Set the event's poster",
        description: "Send the image itself with Content-Type image/jpeg, image/png or image/webp, up to 8 MB. It replaces the one there was.",
        consumes: ["image/jpeg", "image/png", "image/webp"],
        params: EventParams,
        response: { 200: VendorEventOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const event = await owned(request, request.params.id);
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw new AppError("PHOTO_INVALID");
      const { full, smaller } = await toPostPhoto(request.body);
      const id = randomUUID();
      const base = `event-media/${app.config.env}/${event._id.toHexString()}/${id}`;
      const save = async (file: typeof full, suffix: string) => {
        const key = `${base}${suffix}.webp`;
        return { key, url: await app.media.save(key, file.data), width: file.width, height: file.height };
      };
      const [saved, ...copies] = await Promise.all([save(full, ""), ...smaller.map((file) => save(file, `-${file.width}w`))]);
      const photo: BusinessPhoto = { id, ...saved!, smaller: copies };
      const after = await db().events.findOneAndUpdate({ _id: event._id }, { $set: { photo, updatedAt: new Date() } }, { returnDocument: "after" });
      if (event.photo) await Promise.all(photoKeys(event.photo).map((key) => app.media.remove(key)));
      return ok(request, await view(after!));
    },
  );

  app.post(
    "/events/:id/publish",
    {
      preHandler: [requireVendor, idempotent],
      schema: {
        tags: ["vendor"],
        summary: "Put a draft event on sale",
        description: "Needs the business published, a start in the future, the venue or online link, and a ticket type. Everything missing comes back at once.",
        params: EventParams,
        response: { 200: VendorEventOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const event = await owned(request, request.params.id);
      if (event.status !== "draft") throw new AppError("CONFLICT", "This event is on sale already.");
      const shop = await db().businesses.findOne({ _id: event.businessId });
      const missing = missingOf(event, shop?.status === "live");
      if (missing.length) {
        throw new AppError("BUSINESS_INCOMPLETE", missing.join(". "), missing.map((message) => ({ path: "body", message })));
      }
      if (!(await isModuleLive(db(), "events"))) throw new AppError("MODULE_OFF");
      const now = new Date();
      const after = await db().events.findOneAndUpdate(
        { _id: event._id, status: "draft" },
        { $set: { status: "live", publishedAt: now, businessName: shop!.name, updatedAt: now } },
        { returnDocument: "after" },
      );
      if (!after) throw new AppError("CONFLICT");
      await writeAudit(db(), {
        ...by(request),
        scope: { module: "events", businessId: event.businessId },
        action: "event.publish",
        target: { type: "event", id: event._id },
        diff: { status: { from: "draft", to: "live" } },
      });
      return ok(request, await view(after));
    },
  );

  app.post(
    "/events/:id/cancel",
    {
      preHandler: [requireVendor, idempotent],
      schema: {
        tags: ["vendor"],
        summary: "Cancel an event",
        description: "Every booking is cancelled and refunded in full, platform fee included, and every ticket holder is told why. It can't be undone.",
        params: EventParams,
        body: CancelEventBody,
        response: { 200: VendorEventOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const event = await owned(request, request.params.id);
      if (event.status === "draft") throw new AppError("CONFLICT", "Drafts aren't on sale. Delete it instead.");
      await cancelEvent(app, db(), event, { kind: "vendor", ...by(request) }, request.body.reason.trim());
      return ok(request, await view((await db().events.findOne({ _id: event._id }))!));
    },
  );

  app.delete(
    "/events/:id",
    {
      preHandler: requireVendor,
      schema: { tags: ["vendor"], summary: "Delete a draft event", params: EventParams, response: { 200: Done, ...Errors }, security },
    },
    async (request) => {
      const event = await owned(request, request.params.id, { editing: false });
      if (event.status !== "draft") throw new AppError("CONFLICT", "Only drafts can be deleted. Cancel it instead.");
      const res = await db().events.deleteOne({ _id: event._id, status: "draft" });
      if (!res.deletedCount) throw new AppError("CONFLICT");
      if (event.photo) await Promise.all(photoKeys(event.photo).map((key) => app.media.remove(key)));
      return ok(request, { done: true as const });
    },
  );

  app.get(
    "/events/:id/bookings",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Who booked, newest first, with each person's ticket and answers",
        params: EventParams,
        querystring: BookingsQuery,
        response: { 200: BookingList, ...Errors },
        security,
      },
    },
    async (request) => {
      const event = await owned(request, request.params.id, { editing: false });
      const { status, cursor, limit } = request.query;
      const { items, nextCursor } = await findPage(db().eventOrders, {
        filter: { eventId: event._id, status: status ?? { $in: ["confirmed", "cancelled"] } },
        sortField: "createdAt",
        cursor,
        limit,
      });
      const tickets = await db().eventTickets.find({ orderId: { $in: items.map((o) => o._id) } }).toArray();
      const bookings = items.map(
        (o): Booking => ({
          id: o._id.toHexString(),
          orderNo: o.orderNo,
          status: o.status,
          team: o.team?.name ?? null,
          total: o.price.total,
          share: o.status === "confirmed" ? vendorShare(o) : 0,
          refunded: o.refund?.amount ?? 0,
          tickets: tickets
            .filter((t) => t.orderId.equals(o._id))
            .map((t) => ({
              id: t._id.toHexString(),
              name: t.holder.name,
              phone: t.holder.phone,
              tier: t.tierName,
              code: t.code,
              answers: t.answers.map(({ label, answer }) => ({ label, answer })),
              status: t.status,
              lastIn: t.checkIns.at(-1)?.at.toISOString() ?? null,
            })),
          createdAt: o.createdAt.toISOString(),
        }),
      );
      return page(request, bookings, nextCursor);
    },
  );
};

export default manage;
