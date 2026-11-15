import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId, type Filter } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { publicCache, requireAuth, signedInIfPossible } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { Database, TurfBookingDoc, TurfCourtDoc, TurfGroundDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { isModuleLive } from "../../platform/module-switch.js";
import { findPage } from "../../platform/pagination.js";
import { addDays, atTime, dayOf } from "../coaching/rules.js";
import { checkCode, offersFor } from "../coupons/coupons.js";
import { safeReturn } from "../pod/orders.js";
import { escapeRegex } from "../pod/shops.js";
import { ratingOf } from "../reviews/reviews.js";
import { reviewRoutes } from "../reviews/routes.js";
import { turfCheckoutUrl } from "./checkout.js";
import {
  BookBody,
  CancelBody,
  CheckoutLinkOne,
  DaySlots,
  GroundList,
  GroundOne,
  GroundsQuery,
  IdParams,
  MyBookingsQuery,
  OffersBody,
  OffersOne,
  PayBody,
  PlacedBooking,
  SlotsQuery,
  SportList,
  TurfBookingList,
  TurfBookingOne,
  TurfRulesOne,
  type GroundDetail,
} from "./contracts.js";
import desk from "./desk.js";
import { cancelBooking, freshBookings, pickSlots, placeBooking, syncTurfPayment } from "./orders.js";
import { refundRuleOf, refundText, turfRulesView, turfSettings } from "./rules.js";
import { slotsForDay, stateOf } from "./slots.js";
import { bookingViews, courtView, groundCard, groundCards, loadSports, photoView, turfReviewable } from "./views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const signedInOrNot: Record<string, string[]>[] = [{}, { bearer: [] }, { cookie: [] }];

/** A ground's page is public while it's live and its business isn't suspended; drafts and Ruxstar's take-downs aren't. */
async function publicGround(db: Database, id: ObjectId): Promise<boolean> {
  const ground = await db.turfGrounds.findOne({ _id: id }, { projection: { status: 1, businessId: 1 } });
  if (!ground || ground.status !== "live") return false;
  return !(await db.businesses.findOne({ _id: ground.businessId, suspension: { $exists: true } }, { projection: { _id: 1 } }));
}

/** Sports grounds for customers: finding grounds, a court's slots for a day, booking and paying, their bookings. The ground's own work is under /desk. */
const turf: FastifyPluginAsyncTypebox = async (app) => {
  await app.register(desk, { prefix: "/desk" });
  await app.register(
    reviewRoutes({
      module: "turf",
      tag: "turf",
      noun: "booking",
      rule: "Once a date of it has been played (it ended, or the ground marked you arrived), until 30 days after its last date; paid dates not cancelled.",
      order: async (_app, db, userId, id) => {
        const booking = await db.turfBookings.findOne({ _id: new ObjectId(id), customerId: userId });
        if (!booking) throw new AppError("NOT_FOUND", "Booking not found.");
        return turfReviewable(booking);
      },
      listing: { type: "ground", label: "ground", visible: publicGround },
    }),
  );
  const db = () => requireDatabase(app.db);

  async function mine(userId: ObjectId, id: string) {
    const doc = await db().turfBookings.findOne({ _id: new ObjectId(id), customerId: userId });
    if (!doc) throw new AppError("NOT_FOUND", "Booking not found.");
    return doc;
  }
  async function customerOf(userId: ObjectId) {
    const user = await db().users.findOne({ _id: userId }, { projection: { phone: 1, name: 1 } });
    if (!user) throw new AppError("UNAUTHENTICATED");
    return { id: userId, phone: user.phone, name: user.name?.trim() || null };
  }
  /** A court customers can book, with its ground. */
  async function bookable(courtId: string) {
    const court = await db().turfCourts.findOne({ _id: new ObjectId(courtId) });
    const ground = court ? await db().turfGrounds.findOne({ _id: court.groundId }) : null;
    if (!court || !ground || ground.status !== "live" || court.status !== "live") throw new AppError("NOT_FOUND", "This court isn't taking bookings.");
    if (!(await isModuleLive(db(), "turf"))) throw new AppError("MODULE_OFF");
    const business = await db().businesses.findOne({ _id: ground.businessId }, { projection: { suspension: 1 } });
    if (business?.suspension) throw new AppError("BUSINESS_SUSPENDED");
    return { court, ground };
  }
  const one = async (booking: TurfBookingDoc) => (await bookingViews(db(), [booking]))[0]!;

  app.get(
    "/rules",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["turf"],
        summary: "Ruxstar's rules for sports grounds: refund limits, repeat weeks, hold time, slot lengths and fees",
        description: "No sign-in needed.",
        response: { 200: TurfRulesOne, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      publicCache(request, reply);
      const { live: _live, ...rules } = await turfSettings(db());
      return ok(request, turfRulesView(rules));
    },
  );

  app.get(
    "/sports",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["turf"],
        summary: "The sports grounds can offer, for filters and court setup",
        description: "No sign-in needed. Ruxstar keeps the list.",
        response: { 200: SportList, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      publicCache(request, reply);
      const sports = await loadSports(db());
      return page(
        request,
        sports.filter((s) => s.active).map((s) => ({ key: s._id, name: s.name })),
        null,
      );
    },
  );

  app.get(
    "/",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["turf"],
        summary: "Grounds taking bookings, newest first",
        description: "No sign-in needed. Filter by city, sport (a key from /sports) or words in the name. Empty while Ruxstar has turf switched off.",
        querystring: GroundsQuery,
        response: { 200: GroundList, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      publicCache(request, reply);
      if (!(await isModuleLive(db(), "turf"))) return page(request, [], null);
      const { city, sport, q, cursor, limit } = request.query;
      const filters: Filter<TurfGroundDoc>[] = [{ status: "live" }];
      if (city) filters.push({ city: city.trim().toLowerCase() });
      if (sport) filters.push({ sports: sport });
      if (q?.trim()) {
        const words = { $regex: escapeRegex(q.trim()), $options: "i" };
        filters.push({ $or: [{ name: words }, { businessName: words }] });
      }
      const { items, nextCursor } = await findPage(db().turfGrounds, { filter: { $and: filters }, sortField: "publishedAt", cursor, limit });
      const held = await db()
        .businesses.find({ _id: { $in: items.map((g) => g.businessId) }, suspension: { $exists: true } }, { projection: { _id: 1 } })
        .toArray();
      return page(request, await groundCards(db(), items.filter((g) => !held.some((h) => h._id.equals(g.businessId)))), nextCursor);
    },
  );

  app.get(
    "/orders",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["turf"],
        summary: "Your turf bookings: current ones by first date, or past ones newest first",
        description: "Current: unpaid, or paid with a date still to come. Past: everything else.",
        querystring: MyBookingsQuery,
        response: { 200: TurfBookingList, ...Errors },
        security,
      },
    },
    async (request) => {
      const customerId = request.auth!.userId;
      const now = new Date();
      if ((request.query.view ?? "current") === "current") {
        const docs = await db()
          .turfBookings.find({ customerId, status: { $in: ["awaiting_payment", "confirmed"] }, lastEndsAt: { $gt: now } })
          .sort({ firstAt: 1, _id: 1 })
          .limit(100)
          .toArray();
        const fresh = (await freshBookings(app, db(), docs)).filter((b) => b.status !== "cancelled");
        return page(request, await bookingViews(db(), fresh), null);
      }
      const { items, nextCursor } = await findPage(db().turfBookings, {
        filter: { customerId, $or: [{ lastEndsAt: { $lte: now } }, { status: "cancelled" }] },
        sortField: "createdAt",
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      return page(request, await bookingViews(db(), await freshBookings(app, db(), items)), nextCursor);
    },
  );

  app.get(
    "/orders/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["turf"],
        summary: "One booking: its dates and slots, add-ons, what cancelling gives back, refunds and invoices",
        description: "While it waits for payment, Cashfree is asked whether it was paid.",
        params: IdParams,
        response: { 200: TurfBookingOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const booking = await syncTurfPayment(app, db(), await mine(request.auth!.userId, request.params.id));
      const [fresh] = await freshBookings(app, db(), [booking]);
      return ok(request, await one(fresh!));
    },
  );

  app.post(
    "/orders/:id/pay",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["turf"],
        summary: "A fresh checkout link for a booking waiting for payment",
        params: IdParams,
        body: PayBody,
        response: { 200: CheckoutLinkOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const back = safeReturn(app, request.body.returnTo);
      const booking = await syncTurfPayment(app, db(), await mine(request.auth!.userId, request.params.id));
      if (booking.status !== "awaiting_payment") throw new AppError("ORDER_STATE", booking.status === "confirmed" ? "This is paid." : "This was cancelled.");
      return ok(request, { checkoutUrl: turfCheckoutUrl(app, request, booking, back) });
    },
  );

  app.post(
    "/orders/:id/cancel",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["turf"],
        summary: "Cancel a booking, or some of its dates",
        description:
          "Unpaid: the slots go back. Paid: each date is refunded by the booking's tiers, platform fee included (see `refundIfCancelled` on each date). " +
          "Dates that have started can't be cancelled. Leave out `occurrences` for every date still to come.",
        params: IdParams,
        body: CancelBody,
        response: { 200: TurfBookingOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const booking = await mine(request.auth!.userId, request.params.id);
      const done = await cancelBooking(
        app,
        db(),
        booking,
        { kind: "customer", actor: actorOf(request), ip: request.ip },
        {
          reason: request.body.reason?.trim() || (booking.status === "confirmed" ? "You cancelled it." : "You cancelled before paying."),
          occurrences: booking.status === "confirmed" ? request.body.occurrences : undefined,
        },
      );
      return ok(request, await one(done));
    },
  );

  app.get(
    "/courts/:id/slots",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["turf"],
        summary: "A court's slots for one day: free, booked or blocked, with each slot's price",
        description: "No sign-in needed. Today in India when `date` is left out. Slots that have started aren't listed. Peak slots have `peak` true.",
        params: IdParams,
        querystring: SlotsQuery,
        response: { 200: DaySlots, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      const court = await db().turfCourts.findOne({ _id: new ObjectId(request.params.id), status: { $ne: "removed" } });
      if (!court || !(await publicGround(db(), court.groundId))) throw new AppError("NOT_FOUND", "This court isn't on Ruxstar.");
      const now = new Date();
      const date = request.query.date ?? dayOf(now);
      const [settings, live, docs] = await Promise.all([
        turfSettings(db()),
        isModuleLive(db(), "turf"),
        db()
          .turfSlots.find({ courtId: court._id, startAt: { $gte: atTime(date, "00:00"), $lt: atTime(addDays(date, 1), "00:00") } }, { projection: { startAt: 1, status: 1, holdUntil: 1 } })
          .toArray(),
      ]);
      const all = slotsForDay(court, date);
      const ahead = atTime(date, "00:00").getTime() <= now.getTime() + settings.bookAheadDays * 24 * 60 * 60_000;
      publicCache(request, reply);
      return ok(request, {
        court: { id: court._id.toHexString(), name: court.name, slotMinutes: court.slotMinutes, status: court.status === "live" ? ("live" as const) : ("paused" as const) },
        date,
        open: all.length > 0,
        bookable: live && court.status === "live" && ahead && date >= dayOf(now),
        slots: all
          .filter((s) => s.startAt > now)
          .map((s) => {
            const state = stateOf(s, docs, now);
            return {
              startAt: s.startAt.toISOString(),
              endAt: s.endAt.toISOString(),
              start: s.start,
              end: s.end,
              price: s.price,
              peak: s.peak,
              state: state === "free" ? ("free" as const) : state === "blocked" ? ("blocked" as const) : ("booked" as const),
            };
          }),
      });
    },
  );

  app.post(
    "/courts/:id/offers",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["turf"],
        summary: "Coupons that work on these slots, best first",
        description: "Send the slots, add-ons and weeks you're about to book; with `code`, that code is checked too.",
        params: IdParams,
        body: OffersBody,
        response: { 200: OffersOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { court, ground } = await bookable(request.params.id);
      const picked = pickSlots(court, await turfSettings(db()), request.body);
      const ctx = { module: "turf" as const, shop: { id: ground.businessId, name: ground.businessName }, customerId: request.auth!.userId, items: picked.items };
      const [offers, check] = await Promise.all([offersFor(db(), ctx), request.body.code ? checkCode(db(), request.body.code, ctx) : null]);
      return ok(request, {
        offers,
        checked: check ? { code: request.body.code!.trim().toUpperCase(), discount: check.discount, problem: check.problem } : null,
      });
    },
  );

  app.post(
    "/courts/:id/book",
    {
      preHandler: [requireAuth, idempotent],
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["turf"],
        summary: "Book back-to-back slots of a court, with add-ons, once or every week",
        description:
          "Paid in full up front; a weekly repeat pays for every week now, and every date must be free. Returns a checkout link; the slots are held " +
          "for the rules' `holdMinutes` while you pay. Someone else holding or booking one of the slots gets a CONFLICT naming it.",
        params: IdParams,
        body: BookBody,
        response: { 201: PlacedBooking, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const back = safeReturn(app, request.body.returnTo);
      const { court, ground } = await bookable(request.params.id);
      const booking = await placeBooking(app, db(), { ground, court, customer: await customerOf(request.auth!.userId), body: request.body });
      return reply.status(201).send(ok(request, { booking: await one(booking), checkoutUrl: turfCheckoutUrl(app, request, booking, back) }));
    },
  );

  app.get(
    "/:id",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["turf"],
        summary: "One ground: photos, amenities, its courts with hours, prices and add-ons, and the refund rule",
        description: "No sign-in needed; signed out, grounds Ruxstar took down aren't found. Slots come from /courts/{id}/slots.",
        params: IdParams,
        response: { 200: GroundOne, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      const userId = request.auth?.userId ?? null;
      const ground = await db().turfGrounds.findOne({ _id: new ObjectId(request.params.id) });
      const own = Boolean(userId && ground?.vendorId.equals(userId));
      if (!ground || (ground.status === "draft" && !own) || (ground.status === "removed" && !userId)) throw new AppError("NOT_FOUND", "This ground isn't on Ruxstar.");
      const business = await db().businesses.findOne({ _id: ground.businessId }, { projection: { suspension: 1, rating: 1 } });
      if (business?.suspension && !own) throw new AppError("NOT_FOUND", "This ground isn't on Ruxstar.");
      const [settings, live, courts, sports] = await Promise.all([
        turfSettings(db()),
        isModuleLive(db(), "turf"),
        db().turfCourts.find({ groundId: ground._id, status: { $ne: "removed" } }).sort({ order: 1, _id: 1 }).toArray(),
        loadSports(db()),
      ]);
      const liveCourts = courts.filter((c: TurfCourtDoc) => c.status === "live");
      const whyNot =
        ground.status === "removed"
          ? "Ruxstar took this ground down."
          : ground.status === "draft"
            ? "This is your draft. Publish it to take bookings."
            : !live
              ? "Ruxstar isn't taking turf bookings right now."
              : own
                ? "This is your ground."
                : !liveCourts.length
                  ? "No court is taking bookings right now."
                  : null;
      const rule = refundRuleOf(ground.refunds, settings);
      const detail: GroundDetail = {
        ...groundCard(ground, sports, liveCourts.length),
        description: ground.description,
        venue: ground.venue,
        photos: ground.photos.map(photoView),
        courtList: courts.map((c) => courtView(c, sports)),
        refunds: rule,
        refundRule: refundText(rule),
        platformFee: settings.platformFee,
        status: ground.status,
        canBook: whyNot === null,
        whyNot,
        rating: ratingOf(business ?? {}),
      };
      publicCache(request, reply);
      return ok(request, detail);
    },
  );
};

export default turf;
