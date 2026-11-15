import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type Filter, type WithId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, diffOf, writeAudit } from "../../platform/audit.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { BusinessDoc, TeamPermission, TurfBookingDoc, TurfCourtDoc, TurfGroundDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { addDays, atTime, dayOf } from "../coaching/rules.js";
import { teamAccess } from "../team/team.js";
import {
  ArrivalBody,
  BlockBody,
  BlockResult,
  Board,
  BoardQuery,
  DeskBookingList,
  DeskBookingOne,
  DeskBookingsQuery,
  DeskGroundList,
  IdParams,
  OwnerCancelBody,
  PricesBody,
  UnblockBody,
  VendorGroundOne,
} from "./contracts.js";
import { pricesProblem, withAddOnIds } from "./manage.js";
import { blockSlots, cancelBooking, cancellable, freshBookings, markArrival, refreshGround, unblockSlots, type By } from "./orders.js";
import { turfSettings } from "./rules.js";
import { slotsForDay, standing } from "./slots.js";
import { deskBookingViews, vendorGroundView } from "./views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const TURF_PERMISSIONS: TeamPermission[] = ["turf.bookings", "turf.block", "turf.cancel", "turf.prices", "turf.arrivals"];

interface Desk {
  ground: WithId<TurfGroundDoc>;
  business: Pick<BusinessDoc, "ownerId">;
  owner: boolean;
  permissions: TeamPermission[];
}

/** The ground's desk: its owner, and team members with turf permissions. Board, blocks, bookings, arrivals and prices. */
const desk: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const byOf = (request: FastifyRequest): By => ({ kind: "vendor", actor: actorOf(request), ip: request.ip });

  async function access(request: FastifyRequest, groundId: ObjectId, permission: TeamPermission): Promise<Desk> {
    const ground = await db().turfGrounds.findOne({ _id: groundId });
    const business = ground ? await db().businesses.findOne({ _id: ground.businessId }, { projection: { ownerId: 1, suspension: 1 } }) : null;
    if (!ground || !business) throw new AppError("NOT_FOUND", "Ground not found.");
    if (business.ownerId.equals(request.auth!.userId)) {
      if (business.suspension) throw new AppError("BUSINESS_SUSPENDED");
      return { ground, business, owner: true, permissions: TURF_PERMISSIONS };
    }
    const { place } = await teamAccess(db(), request.auth!, { businessId: ground.businessId }, permission);
    return { ground, business, owner: false, permissions: place.permissions };
  }
  async function courtAccess(request: FastifyRequest, courtId: string, permission: TeamPermission) {
    const court = await db().turfCourts.findOne({ _id: new ObjectId(courtId), status: { $ne: "removed" } });
    if (!court) throw new AppError("NOT_FOUND", "Court not found.");
    return { court, ...(await access(request, court.groundId, permission)) };
  }
  async function bookingAccess(request: FastifyRequest, id: string, permission: TeamPermission) {
    const booking = await db().turfBookings.findOne({ _id: new ObjectId(id) });
    if (!booking) throw new AppError("NOT_FOUND", "Booking not found.");
    await access(request, booking.groundId, permission);
    return booking;
  }
  const one = async (booking: TurfBookingDoc) => (await deskBookingViews(db(), [booking]))[0]!;

  app.get(
    "/grounds",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["turf"],
        summary: "Grounds you run: your own, and those whose team gave you turf permissions",
        description: "Team members need to be verified to see them.",
        response: { 200: DeskGroundList, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const [owned, places] = await Promise.all([
        db().businesses.find({ ownerId: userId, module: "turf", suspension: { $exists: false } }, { projection: { _id: 1 } }).toArray(),
        db().employments.find({ userId, status: "active", current: true, permissions: { $in: TURF_PERMISSIONS } }, { projection: { businessId: 1, permissions: 1 } }).toArray(),
      ]);
      const held = await db().businesses.find({ _id: { $in: places.map((p) => p.businessId) }, suspension: { $exists: true } }, { projection: { _id: 1 } }).toArray();
      const team = request.auth!.kyc.base === "approved" ? places.filter((p) => !held.some((h) => h._id.equals(p.businessId))) : [];
      const grounds = await db()
        .turfGrounds.find({ businessId: { $in: [...owned.map((b) => b._id), ...team.map((p) => p.businessId)] }, status: { $ne: "removed" } })
        .sort({ createdAt: 1 })
        .limit(100)
        .toArray();
      const counts = await db()
        .turfCourts.aggregate<{ _id: ObjectId; n: number }>([{ $match: { groundId: { $in: grounds.map((g) => g._id) }, status: "live" } }, { $group: { _id: "$groundId", n: { $sum: 1 } } }])
        .toArray();
      return page(
        request,
        grounds.map((g) => {
          const mine = owned.some((b) => b._id.equals(g.businessId));
          return {
            id: g._id.toHexString(),
            name: g.name,
            business: { id: g.businessId.toHexString(), name: g.businessName },
            status: g.status,
            courts: counts.find((c) => c._id.equals(g._id))?.n ?? 0,
            owner: mine,
            permissions: mine ? TURF_PERMISSIONS : (team.find((p) => p.businessId.equals(g.businessId))?.permissions.filter((p) => p.startsWith("turf.")) ?? []),
          };
        }),
        null,
      );
    },
  );

  app.get(
    "/grounds/:id/board",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["turf"],
        summary: "The day's board: every court's slots, booked, held, blocked or free, with who booked",
        description: "Today in India when `date` is left out. Team members need turf.bookings.",
        params: IdParams,
        querystring: BoardQuery,
        response: { 200: Board, ...Errors },
        security,
      },
    },
    async (request) => {
      const { ground } = await access(request, new ObjectId(request.params.id), "turf.bookings");
      const now = new Date();
      const date = request.query.date ?? dayOf(now);
      const [courts, docs] = await Promise.all([
        db().turfCourts.find({ groundId: ground._id, status: { $ne: "removed" } }).sort({ order: 1, _id: 1 }).toArray(),
        db().turfSlots.find({ groundId: ground._id, startAt: { $gte: atTime(date, "00:00"), $lt: atTime(addDays(date, 1), "00:00") } }).toArray(),
      ]);
      const live = docs.filter((d) => standing(d, now));
      const bookingIds = [...new Set(live.flatMap((d) => (d.bookingId ? [d.bookingId.toHexString()] : [])))].map((id) => new ObjectId(id));
      const bookings = bookingIds.length ? await db().turfBookings.find({ _id: { $in: bookingIds } }).toArray() : [];
      const people = await db()
        .users.find(
          { _id: { $in: [...bookings.map((b) => b.customerId), ...live.flatMap((d) => (d.by ? [d.by] : []))] } },
          { projection: { phone: 1, name: 1 } },
        )
        .toArray();
      const totals = { booked: 0, blocked: 0, free: 0, arrived: 0, noShow: 0 };
      const counted = new Set<string>();
      const view = courts.map((court) => {
        const slots = slotsForDay(court, date).map((s) => {
          const doc = live.find((d) => d.courtId.equals(court._id) && d.startAt.getTime() === s.startAt.getTime());
          const booking = doc?.bookingId ? bookings.find((b) => b._id.equals(doc.bookingId!)) : undefined;
          const o = booking?.occurrences.find((x) => x.startAt <= s.startAt && s.startAt < x.endAt && x.status === "booked");
          const state = doc ? doc.status : "free";
          if (state === "booked") totals.booked++;
          else if (state === "blocked") totals.blocked++;
          else if (state === "free" && s.startAt > now) totals.free++;
          if (booking && o?.arrival && !counted.has(`${booking._id.toHexString()}:${o.n}`)) {
            counted.add(`${booking._id.toHexString()}:${o.n}`);
            if (o.arrival.status === "arrived") totals.arrived++;
            else totals.noShow++;
          }
          const person = (id: ObjectId | null | undefined) => (id ? people.find((u) => u._id.equals(id)) : undefined);
          return {
            startAt: s.startAt.toISOString(),
            endAt: s.endAt.toISOString(),
            start: s.start,
            end: s.end,
            price: o?.slots.find((x) => x.startAt.getTime() === s.startAt.getTime())?.price ?? s.price,
            peak: s.peak,
            past: s.endAt <= now,
            state,
            booking:
              booking && o
                ? {
                    id: booking._id.toHexString(),
                    orderNo: booking.orderNo,
                    n: o.n,
                    weeks: booking.weeks,
                    customerName: booking.customerName,
                    customerPhone: booking.status === "confirmed" ? (person(booking.customerId)?.phone ?? null) : null,
                    status: booking.status,
                    arrival: o.arrival?.status ?? null,
                    startAt: o.startAt.toISOString(),
                    endAt: o.endAt.toISOString(),
                  }
                : null,
            block: doc?.status === "blocked" ? { note: doc.note, by: person(doc.by)?.name?.trim() || null } : null,
          };
        });
        return {
          id: court._id.toHexString(),
          name: court.name,
          slotMinutes: court.slotMinutes,
          status: court.status === "live" ? ("live" as const) : ("paused" as const),
          open: slots.length > 0,
          slots,
        };
      });
      return ok(request, { ground: { id: ground._id.toHexString(), name: ground.name }, date, courts: view, totals });
    },
  );

  app.post(
    "/slots/block",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["turf"],
        summary: "Block free slots of a court, with a note, so nobody can book them",
        description: "All or none: a slot that's booked, held or blocked already stops the lot with a CONFLICT naming it. Team members need turf.block.",
        body: BlockBody,
        response: { 200: BlockResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const { court } = await courtAccess(request, request.body.courtId, "turf.block");
      const done = await blockSlots(app, db(), court, request.body.startAts, request.body.note?.trim() || null, byOf(request));
      return ok(request, { done });
    },
  );

  app.post(
    "/slots/unblock",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["turf"],
        summary: "Unblock slots of a court",
        description: "Slots that aren't blocked are left as they are; `done` counts the ones freed. Team members need turf.block.",
        body: UnblockBody,
        response: { 200: BlockResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const { court } = await courtAccess(request, request.body.courtId, "turf.block");
      return ok(request, { done: await unblockSlots(db(), court, request.body.startAts, byOf(request)) });
    },
  );

  app.put(
    "/courts/:id/prices",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["turf"],
        summary: "Change a court's prices, peak windows and add-ons",
        description: "Bookings already made keep what they paid. Team members need turf.prices.",
        params: IdParams,
        body: PricesBody,
        response: { 200: VendorGroundOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { court, ground } = await courtAccess(request, request.params.id, "turf.prices");
      const settings = await turfSettings(db());
      const changes: Partial<Pick<TurfCourtDoc, "prices" | "addOns">> = {};
      if (request.body.prices) {
        const problem = pricesProblem(request.body.prices);
        if (problem) throw new AppError("VALIDATION_FAILED", problem.message, [problem]);
        changes.prices = request.body.prices;
      }
      if (request.body.addOns) {
        if (request.body.addOns.length > settings.maxAddOns) {
          throw new AppError("VALIDATION_FAILED", `A court can have up to ${settings.maxAddOns} add-ons.`, [{ path: "body/addOns", message: `Up to ${settings.maxAddOns}.` }]);
        }
        changes.addOns = withAddOnIds(request.body.addOns, court.addOns);
      }
      const now = new Date();
      await db().turfCourts.updateOne({ _id: court._id }, { $set: { ...changes, updatedAt: now } });
      await writeAudit(db(), {
        actor: actorOf(request),
        scope: { module: "turf", businessId: court.businessId },
        action: "turf_court.update",
        target: { type: "turf_court", id: court._id },
        diff: diffOf(court as unknown as Record<string, unknown>, changes as Record<string, unknown>),
        ip: request.ip,
      });
      await refreshGround(db(), ground._id);
      const fresh = (await db().turfGrounds.findOne({ _id: ground._id }))!;
      return ok(request, await vendorGroundView(db(), fresh, settings));
    },
  );

  app.get(
    "/grounds/:id/bookings",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["turf"],
        summary: "A ground's bookings: upcoming ones by first date, or past and all newest first",
        description: "Team members need turf.bookings.",
        params: IdParams,
        querystring: DeskBookingsQuery,
        response: { 200: DeskBookingList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { ground } = await access(request, new ObjectId(request.params.id), "turf.bookings");
      const now = new Date();
      const view = request.query.view ?? "upcoming";
      if (view === "upcoming") {
        const docs = await db()
          .turfBookings.find({ groundId: ground._id, status: "confirmed", lastEndsAt: { $gt: now } })
          .sort({ firstAt: 1, _id: 1 })
          .limit(200)
          .toArray();
        return page(request, await deskBookingViews(db(), await freshBookings(app, db(), docs)), null);
      }
      const filter: Filter<TurfBookingDoc> =
        view === "past"
          ? { groundId: ground._id, status: { $ne: "awaiting_payment" }, $or: [{ lastEndsAt: { $lte: now } }, { status: "cancelled" }] }
          : { groundId: ground._id };
      const { items, nextCursor } = await findPage(db().turfBookings, { filter, sortField: "createdAt", cursor: request.query.cursor, limit: request.query.limit });
      return page(request, await deskBookingViews(db(), await freshBookings(app, db(), items)), nextCursor);
    },
  );

  app.get(
    "/orders/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["turf"],
        summary: "One booking at your ground, with the customer's phone",
        description: "Team members need turf.bookings.",
        params: IdParams,
        response: { 200: DeskBookingOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const booking = await bookingAccess(request, request.params.id, "turf.bookings");
      const [fresh] = await freshBookings(app, db(), [booking]);
      return ok(request, await one(fresh!));
    },
  );

  app.post(
    "/orders/:id/cancel",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["turf"],
        summary: "Cancel a booking, or some of its dates, refunding the customer in full",
        description: "The platform fee comes back too, and the slots are freed. Dates that have ended can't be cancelled. Team members need turf.cancel.",
        params: IdParams,
        body: OwnerCancelBody,
        response: { 200: DeskBookingOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const booking = await bookingAccess(request, request.params.id, "turf.cancel");
      if (booking.status !== "confirmed") throw new AppError("ORDER_STATE", booking.status === "cancelled" ? "This booking is cancelled already." : "This booking isn't paid yet.");
      if (!cancellable(booking, "vendor").length) throw new AppError("ORDER_STATE", "Every date of this booking has ended or been cancelled.");
      const done = await cancelBooking(app, db(), booking, byOf(request), { reason: request.body.reason.trim(), occurrences: request.body.occurrences });
      return ok(request, await one(done));
    },
  );

  app.post(
    "/orders/:id/arrival",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["turf"],
        summary: "Mark whether the customer came for one date",
        description: "Arrived from 30 minutes before the slot; no-show from its start; until a day after it ends. Marking again changes it. Team members need turf.arrivals.",
        params: IdParams,
        body: ArrivalBody,
        response: { 200: DeskBookingOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const booking = await bookingAccess(request, request.params.id, "turf.arrivals");
      return ok(request, await one(await markArrival(db(), booking, request.body.n, request.body.status, byOf(request))));
    },
  );
};

export default desk;
