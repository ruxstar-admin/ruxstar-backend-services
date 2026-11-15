import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type Filter } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { publicCache, requireAuth, signedInIfPossible } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { Database, StayPropertyDoc, StayReservationDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { isModuleLive } from "../../platform/module-switch.js";
import { findPage } from "../../platform/pagination.js";
import { addDays } from "../coaching/rules.js";
import { checkCode, offersFor } from "../coupons/coupons.js";
import { safeReturn } from "../pod/orders.js";
import { escapeRegex } from "../pod/shops.js";
import { ratingOf } from "../reviews/reviews.js";
import { reviewRoutes } from "../reviews/routes.js";
import { staysCheckoutUrl } from "./checkout.js";
import {
  Availability,
  AvailabilityQuery,
  CancelBody,
  CheckoutLinkOne,
  FacilityList,
  IdParams,
  MyStaysQuery,
  NoticeBody,
  ObjectionBody,
  OffersBody,
  OffersOne,
  PayBody,
  PlacedReservation,
  PropertiesQuery,
  PropertyList,
  PropertyOne,
  ReserveBody,
  StayReservationList,
  StayReservationOne,
  StaysRulesOne,
} from "./contracts.js";
import desk from "./desk.js";
import {
  cancelStay,
  endStay,
  freshStays,
  objectStay,
  overlapping,
  pickBeds,
  pickStay,
  priceOf,
  reserveStay,
  stayWindow,
  syncStayPayment,
  withdrawObjection,
  type By,
} from "./orders.js";
import { staysSettings, today } from "./rules.js";
import { loadFacilities, propertyCards, propertyDetail, reservationViews, staysReviewable } from "./views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const signedInOrNot: Record<string, string[]>[] = [{}, { bearer: [] }, { cookie: [] }];

/** A property's page is public while it's live and its business isn't suspended; drafts and Ruxstar's take-downs aren't. */
async function publicProperty(db: Database, id: ObjectId): Promise<boolean> {
  const property = await db.staysProperties.findOne({ _id: id }, { projection: { status: 1, businessId: 1 } });
  if (!property || property.status !== "live") return false;
  return !(await db.businesses.findOne({ _id: property.businessId, suspension: { $exists: true } }, { projection: { _id: 1 } }));
}

const list = (csv: string | undefined) => (csv ? [...new Set(csv.split(","))] : []);

/** PGs, hostels and co-living for customers: search, a property's rooms and beds, reserving and paying, their stays. The property's own work is under /desk. */
const stays: FastifyPluginAsyncTypebox = async (app) => {
  await app.register(desk, { prefix: "/desk" });
  await app.register(
    reviewRoutes({
      module: "stays",
      tag: "stays",
      noun: "reservation",
      rule: "Once the property has marked you moved in, while you stay and until 30 days after you move out.",
      order: async (_app, db, userId, id) => {
        const r = await db.staysReservations.findOne({ _id: new ObjectId(id), customerId: userId });
        if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
        return staysReviewable(r);
      },
      listing: { type: "property", label: "property", visible: publicProperty },
    }),
  );
  const db = () => requireDatabase(app.db);
  const byOf = (request: FastifyRequest): By => ({ kind: "customer", actor: actorOf(request), ip: request.ip });

  async function mine(userId: ObjectId, id: string) {
    const doc = await db().staysReservations.findOne({ _id: new ObjectId(id), customerId: userId });
    if (!doc) throw new AppError("NOT_FOUND", "Reservation not found.");
    return doc;
  }
  async function customerOf(request: FastifyRequest) {
    const userId = request.auth!.userId;
    const user = await db().users.findOne({ _id: userId }, { projection: { phone: 1, name: 1, kyc: 1 } });
    if (!user) throw new AppError("UNAUTHENTICATED");
    return { id: userId, phone: user.phone, name: user.name?.trim() || null, verified: user.kyc?.base === "approved" };
  }
  /** A room customers can reserve, with its property. */
  async function reservable(roomId: string) {
    const room = await db().staysRooms.findOne({ _id: new ObjectId(roomId) });
    const property = room ? await db().staysProperties.findOne({ _id: room.propertyId }) : null;
    if (!room || !property || property.status !== "live" || room.status === "removed") throw new AppError("NOT_FOUND", "This room isn't taking reservations.");
    if (room.status !== "live") throw new AppError("CONFLICT", "This room is full right now. Pick another room.");
    if (!(await isModuleLive(db(), "stays"))) throw new AppError("MODULE_OFF");
    const business = await db().businesses.findOne({ _id: property.businessId }, { projection: { suspension: 1 } });
    if (business?.suspension) throw new AppError("BUSINESS_SUSPENDED");
    return { room, property };
  }
  const one = async (r: StayReservationDoc) => (await reservationViews(db(), [r]))[0]!;

  app.get(
    "/rules",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["stays"],
        summary: "Ruxstar's rules for PGs and hostels: the refund rule, objection window, months and nights per reservation, hold time and fees",
        description: "No sign-in needed.",
        response: { 200: StaysRulesOne, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      publicCache(request, reply);
      const { live: _live, ...rules } = await staysSettings(db());
      return ok(request, rules);
    },
  );

  app.get(
    "/facilities",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["stays"],
        summary: "The facilities properties can list, for filters and setup",
        description: "No sign-in needed. Ruxstar keeps the list.",
        response: { 200: FacilityList, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      publicCache(request, reply);
      const facilities = await loadFacilities(db());
      return page(
        request,
        facilities.filter((f) => f.active).map((f) => ({ key: f._id, name: f.name })),
        null,
      );
    },
  );

  app.get(
    "/",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["stays"],
        summary: "PGs, hostels and co-living taking reservations, newest first",
        description:
          "No sign-in needed. Filter by place, who it's for, food, facilities (keys from /facilities), how it's let, price, room kind, what's nearby, notice period and house rules. " +
          "Empty while Ruxstar has stays switched off.",
        querystring: PropertiesQuery,
        response: { 200: PropertyList, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      publicCache(request, reply);
      if (!(await isModuleLive(db(), "stays"))) return page(request, [], null);
      const q = request.query;
      const filters: Filter<StayPropertyDoc>[] = [{ status: "live" }];
      if (q.city) filters.push({ city: q.city.trim().toLowerCase() });
      if (q.area) filters.push({ area: q.area.trim().toLowerCase() });
      if (q.q?.trim()) {
        const words = { $regex: escapeRegex(q.q.trim()), $options: "i" };
        filters.push({ $or: [{ name: words }, { businessName: words }] });
      }
      if (q.kind) filters.push({ kind: q.kind });
      if (q.for) filters.push({ for: { $in: [q.for, "any"] } });
      if (q.occupant) filters.push({ $or: [{ occupants: q.occupant }, { occupants: { $size: 0 } }] });
      if (q.food) filters.push(q.food === "any" ? { "food.type": { $ne: "none" } } : { "food.type": q.food });
      const meals = list(q.meals);
      if (meals.length) filters.push({ "food.meals": { $all: meals as StayPropertyDoc["food"]["meals"] } });
      const facilities = list(q.facilities);
      if (facilities.length) filters.push({ facilities: { $all: facilities } });
      if (q.stay) filters.push({ units: q.stay });
      if (q.priceMax !== undefined) filters.push({ [`priceFrom.${q.stay ?? "month"}`]: { $lte: q.priceMax } });
      if (q.room) filters.push({ roomKinds: q.room });
      if (q.near?.trim()) filters.push({ "nearby.name": { $regex: escapeRegex(q.near.trim()), $options: "i" } });
      if (q.noticeMax !== undefined) filters.push({ noticeDays: { $lte: q.noticeMax } });
      for (const rule of list(q.allows)) {
        if (rule === "late_entry") filters.push({ "rules.curfew": null });
        else if (rule === "guests" || rule === "smoking" || rule === "alcohol" || rule === "pets") filters.push({ [`rules.${rule}`]: true });
      }
      const { items, nextCursor } = await findPage(db().staysProperties, { filter: { $and: filters }, sortField: "publishedAt", cursor: q.cursor, limit: q.limit });
      const held = await db()
        .businesses.find({ _id: { $in: items.map((p) => p.businessId) }, suspension: { $exists: true } }, { projection: { _id: 1 } })
        .toArray();
      return page(request, await propertyCards(db(), items.filter((p) => !held.some((h) => h._id.equals(p.businessId)))), nextCursor);
    },
  );

  app.get(
    "/orders",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["stays"],
        summary: "Your stays: current ones by move-in, or past ones newest first",
        description: "Current: unpaid, paid and waiting for move-in, or moved in and not moved out. Past: everything else.",
        querystring: MyStaysQuery,
        response: { 200: StayReservationList, ...Errors },
        security,
      },
    },
    async (request) => {
      const customerId = request.auth!.userId;
      const now = new Date();
      if ((request.query.view ?? "current") === "current") {
        const docs = await db()
          .staysReservations.find({
            customerId,
            $or: [{ status: { $in: ["awaiting_payment", "confirmed"] } }, { status: "moved_in", $or: [{ until: null }, { until: { $gt: now } }] }],
          })
          .sort({ from: 1, _id: 1 })
          .limit(100)
          .toArray();
        const fresh = (await freshStays(app, db(), docs)).filter((r) => r.status !== "cancelled" && r.status !== "moved_out");
        return page(request, await reservationViews(db(), fresh), null);
      }
      const { items, nextCursor } = await findPage(db().staysReservations, {
        filter: { customerId, $or: [{ status: { $in: ["moved_out", "cancelled"] } }, { status: "moved_in", until: { $ne: null, $lte: now } }] },
        sortField: "createdAt",
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      return page(request, await reservationViews(db(), await freshStays(app, db(), items)), nextCursor);
    },
  );

  app.get(
    "/orders/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["stays"],
        summary: "One reservation: the room and beds, dates, what cancelling gives back, objection, notice, refund and invoices",
        description: "While it waits for payment, Cashfree is asked whether it was paid.",
        params: IdParams,
        response: { 200: StayReservationOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const r = await syncStayPayment(app, db(), await mine(request.auth!.userId, request.params.id));
      const [fresh] = await freshStays(app, db(), [r]);
      return ok(request, await one(fresh!));
    },
  );

  app.post(
    "/orders/:id/pay",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["stays"],
        summary: "A fresh checkout link for a reservation waiting for payment",
        params: IdParams,
        body: PayBody,
        response: { 200: CheckoutLinkOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const back = safeReturn(app, request.body.returnTo);
      const r = await syncStayPayment(app, db(), await mine(request.auth!.userId, request.params.id));
      if (r.status !== "awaiting_payment") throw new AppError("ORDER_STATE", r.status === "cancelled" ? "This was cancelled." : "This is paid.");
      return ok(request, { checkoutUrl: staysCheckoutUrl(app, request, r, back) });
    },
  );

  app.post(
    "/orders/:id/cancel",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["stays"],
        summary: "Cancel a reservation before moving in",
        description:
          "Unpaid: the beds go back. Paid: everything back, platform fee included, until the refund rule's day (see `refundIfCancelled` and `refundUntil`); " +
          "nothing back after it, though the bed is freed. Once moved in, give notice instead.",
        params: IdParams,
        body: CancelBody,
        response: { 200: StayReservationOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const r = await mine(request.auth!.userId, request.params.id);
      const done = await cancelStay(app, db(), r, byOf(request), {
        reason: request.body.reason?.trim() || (r.status === "awaiting_payment" ? "You cancelled before paying." : "You cancelled it."),
      });
      return ok(request, await one(done));
    },
  );

  app.post(
    "/orders/:id/objection",
    {
      preHandler: [requireAuth, idempotent],
      config: { rateLimit: { max: 10, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["stays"],
        summary: "Object after the property marked you moved in",
        description:
          "Within the rules' `objectionHours` of \"Moved in\" (see `objectionUntil`), for example if you didn't actually move in or the room isn't as listed. " +
          "The property isn't paid until Ruxstar decides. Once per reservation.",
        params: IdParams,
        body: ObjectionBody,
        response: { 200: StayReservationOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const r = await mine(request.auth!.userId, request.params.id);
      return ok(request, await one(await objectStay(app, db(), r, byOf(request), request.body.reason.trim())));
    },
  );

  app.delete(
    "/orders/:id/objection",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["stays"],
        summary: "Take back your objection",
        description: "The property is paid once the objection window would have closed.",
        params: IdParams,
        response: { 200: StayReservationOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const r = await mine(request.auth!.userId, request.params.id);
      return ok(request, await one(await withdrawObjection(db(), r, byOf(request))));
    },
  );

  app.post(
    "/orders/:id/notice",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["stays"],
        summary: "Give notice on a monthly stay",
        description: "Sets your move-out day: the notice period from today (see `noticeFrom`), or a later day. The bed opens for others from then.",
        params: IdParams,
        body: NoticeBody,
        response: { 200: StayReservationOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const r = await mine(request.auth!.userId, request.params.id);
      return ok(request, await one(await endStay(app, db(), r, byOf(request), { on: request.body.on })));
    },
  );

  app.get(
    "/:id/availability",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["stays"],
        summary: "Which beds are free for a stay: each room's beds, and the price of a bed or the whole room",
        description:
          "No sign-in needed. A monthly stay needs the bed free from move-in onwards, as it has no end until notice; a hostel stay only for its nights. " +
          "Beds held for someone's checkout show as taken.",
        params: IdParams,
        querystring: AvailabilityQuery,
        response: { 200: Availability, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      const propertyId = new ObjectId(request.params.id);
      if (!(await publicProperty(db(), propertyId))) throw new AppError("NOT_FOUND", "This property isn't on Ruxstar.");
      const property = (await db().staysProperties.findOne({ _id: propertyId }))!;
      const now = new Date();
      const { moveIn } = request.query;
      const unit = request.query.stay ?? "month";
      const units = unit === "month" ? (request.query.months ?? 1) : (request.query.nights ?? 1);
      const { from, until } = stayWindow(moveIn, unit, units);
      const [settings, live, rooms] = await Promise.all([
        staysSettings(db()),
        isModuleLive(db(), "stays"),
        db().staysRooms.find({ propertyId, status: { $ne: "removed" } }).sort({ order: 1, _id: 1 }).toArray(),
      ]);
      const beds = await db().staysBeds.find({ propertyId, status: { $ne: "removed" } }).sort({ order: 1 }).toArray();
      const taken = await db()
        .staysReservations.find({ ...overlapping(beds.map((b) => b._id), from, until), propertyId }, { projection: { bedIds: 1, status: 1, holdUntil: 1 } })
        .toArray();
      const busy = new Set(
        taken.filter((r) => r.status !== "awaiting_payment" || !r.holdUntil || r.holdUntil > now).flatMap((r) => r.bedIds.map((id) => id.toHexString())),
      );
      const first = today(now);
      publicCache(request, reply);
      return ok(request, {
        property: { id: property._id.toHexString(), name: property.name },
        moveIn,
        stay: unit,
        until: unit === "night" ? addDays(moveIn, units) : null,
        reservable: live && moveIn >= first && moveIn <= addDays(first, settings.bookAheadDays),
        rooms: rooms.map((room) => {
          const mine = beds.filter((b) => b.roomId.equals(room._id));
          const state = (b: (typeof mine)[number]) =>
            b.status !== "open" || room.status !== "live" ? ("closed" as const) : busy.has(b._id.toHexString()) ? ("taken" as const) : ("free" as const);
          const states = mine.map((b) => ({ id: b._id.toHexString(), label: b.label, state: state(b) }));
          const price = room.prices[unit];
          const allFree = states.length > 0 && states.every((s) => s.state === "free");
          return {
            id: room._id.toHexString(),
            name: room.name,
            kind: room.kind,
            status: room.status === "live" ? ("live" as const) : ("paused" as const),
            beds: states,
            bedTotal: room.kind === "shared" && price !== null && states.some((s) => s.state === "free") ? priceOf(room, 1, price, units).items : null,
            roomTotal: (room.kind === "private" || room.wholeRoom) && price !== null && allFree ? priceOf(room, states.length, price, units).items : null,
          };
        }),
      });
    },
  );

  app.post(
    "/rooms/:id/offers",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["stays"],
        summary: "Coupons that work on this stay, best first",
        description: "Send the bed or whole room, move-in and months or nights you're about to reserve; with `code`, that code is checked too.",
        params: IdParams,
        body: OffersBody,
        response: { 200: OffersOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { room, property } = await reservable(request.params.id);
      const stay = pickStay(room, await staysSettings(db()), request.body);
      const beds = await db().staysBeds.find({ roomId: room._id, status: { $ne: "removed" } }).toArray();
      const picked = pickBeds(room, beds, request.body);
      const { items } = priceOf(room, picked.beds.length, stay.unitPrice, stay.units);
      const ctx = { module: "stays" as const, shop: { id: property.businessId, name: property.businessName }, customerId: request.auth!.userId, items };
      const [offers, check] = await Promise.all([offersFor(db(), ctx), request.body.code ? checkCode(db(), request.body.code, ctx) : null]);
      return ok(request, {
        offers,
        checked: check ? { code: request.body.code!.trim().toUpperCase(), discount: check.discount, problem: check.problem } : null,
      });
    },
  );

  app.post(
    "/rooms/:id/reserve",
    {
      preHandler: [requireAuth, idempotent],
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["stays"],
        summary: "Reserve a bed or a whole room from a move-in day",
        description:
          "Needs base KYC: without it, a KYC_REQUIRED error whose detail has `reason: tenant_kyc` and a `link` to the verification screen. " +
          "PG and co-living pay the first months now (stay=month); hostels pay the nights (stay=night). The security deposit is paid to the owner, not here. " +
          "Returns a checkout link; the beds are held for the rules' `holdMinutes` while you pay. A bed someone else holds or has for these dates is a CONFLICT.",
        params: IdParams,
        body: ReserveBody,
        response: { 201: PlacedReservation, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const back = safeReturn(app, request.body.returnTo);
      const { room, property } = await reservable(request.params.id);
      const r = await reserveStay(app, db(), { property, room, customer: await customerOf(request), body: request.body });
      return reply.status(201).send(ok(request, { reservation: await one(r), checkoutUrl: staysCheckoutUrl(app, request, r, back) }));
    },
  );

  app.get(
    "/:id",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["stays"],
        summary: "One property: photos, rooms with prices and beds, food, facilities, house rules, notice, deposit, nearby places and the refund rule",
        description: "No sign-in needed; signed out, properties Ruxstar took down aren't found. Which beds are free comes from /{id}/availability.",
        params: IdParams,
        response: { 200: PropertyOne, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      const userId = request.auth?.userId ?? null;
      const property = await db().staysProperties.findOne({ _id: new ObjectId(request.params.id) });
      const own = Boolean(userId && property?.vendorId.equals(userId));
      if (!property || (property.status === "draft" && !own) || (property.status === "removed" && !userId)) throw new AppError("NOT_FOUND", "This property isn't on Ruxstar.");
      const business = await db().businesses.findOne({ _id: property.businessId }, { projection: { suspension: 1, rating: 1 } });
      if (business?.suspension && !own) throw new AppError("NOT_FOUND", "This property isn't on Ruxstar.");
      const [settings, live, rooms] = await Promise.all([
        staysSettings(db()),
        isModuleLive(db(), "stays"),
        db().staysRooms.countDocuments({ propertyId: property._id, status: "live" }),
      ]);
      const whyNot =
        property.status === "removed"
          ? "Ruxstar took this property down."
          : property.status === "draft"
            ? "This is your draft. Publish it to take reservations."
            : !live
              ? "Ruxstar isn't taking PG and hostel reservations right now."
              : own
                ? "This is your property."
                : !rooms
                  ? "Every room is full right now."
                  : null;
      publicCache(request, reply);
      return ok(request, await propertyDetail(db(), property, settings, { whyNot, rating: ratingOf(business ?? {}) }));
    },
  );
};

export default stays;
