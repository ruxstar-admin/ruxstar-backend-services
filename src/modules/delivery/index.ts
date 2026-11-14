import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireDeliveryKyc } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { DeliveryJobDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { PRIVATE_PHOTO_MAX_BYTES } from "../../platform/private-photo.js";
import { payoutMethodView } from "../vendor/businesses.js";
import { PayoutMethodBody, PayoutMethodResult, PayoutResult } from "../vendor/contracts.js";
import { payoutView, setPayoutMethod } from "../vendor/payments.js";
import { payeeFilter, payoutRules, settleDue, withdraw } from "../vendor/payouts.js";
import {
  DeliverBody,
  Earnings,
  JobList,
  JobOne,
  JobParams,
  JobsQuery,
  OnlineBody,
  Rider,
  RiderCancelBody,
  RiderStatement,
  RiderStatementQuery,
  type RiderStatementLine,
} from "./contracts.js";
import { heldRiderPay, releaseRiderPayFor, riderPayHeld } from "./pay.js";
import { deliveryRules } from "./rates.js";
import { acceptJob, addProof, deliver, jobFor, jobView, offersFor, passJob, pickUp, riderCancel, riderProfile } from "./trips.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const limit = (perMinutes: number, max: number) => ({ rateLimit: { max, timeWindow: perMinutes * 60_000 } });
const ACTIVE: DeliveryJobDoc["status"][] = ["accepted", "picked_up"];
const PAST: DeliveryJobDoc["status"][] = ["delivered", "cancelled"];
const IST_MS = 5.5 * 60 * 60_000;

/** Midnight in India, as a moment, `daysBack` days ago. */
function startOfDay(daysBack = 0, now = new Date()) {
  const local = new Date(now.getTime() + IST_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - IST_MS - daysBack * 24 * 60 * 60_000);
}

/**
 * The Ruxstar Delivery app (decision 57): delivery partners go online, take offers, and carry an order from the shop to the door.
 * Everything here needs delivery verification approved.
 */
const delivery: FastifyPluginAsyncTypebox = async (app) => {
  app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: PRIVATE_PHOTO_MAX_BYTES }, (_request, body, done) => done(null, body));
  const db = () => requireDatabase(app.db);

  const riderAccount = (riderId: ObjectId) => `rider:${riderId.toHexString()}`;
  const earnedSince = async (riderId: ObjectId, since: Date) => {
    const [row] = await db()
      .ledgerEntries.aggregate<{ total: number }>([
        { $match: { accountId: riderAccount(riderId), kind: "rider_pay", at: { $gte: since } } },
        { $group: { _id: null, total: { $sum: "$signedPaise" } } },
      ])
      .toArray();
    return row?.total ?? 0;
  };

  async function me(riderId: ObjectId) {
    const [profile, state, active, rules, trips, earned, places] = await Promise.all([
      riderProfile(db(), riderId),
      db().riderStates.findOne({ _id: riderId }),
      db().deliveryJobs.findOne({ riderId, busy: true }),
      deliveryRules(db()),
      db().deliveryJobs.countDocuments({ riderId, status: "delivered", updatedAt: { $gte: startOfDay() } }),
      earnedSince(riderId, startOfDay()),
      db().employments.find({ userId: riderId, status: "active", current: true, permissions: "orders.deliver" }).toArray(),
    ]);
    if (!profile) throw new AppError("KYC_REQUIRED");
    const businesses = await db()
      .businesses.find({ _id: { $in: places.map((p) => p.businessId) } }, { projection: { name: 1 } })
      .toArray();
    return {
      name: profile.name,
      avatarUrl: profile.avatar,
      vehicle: profile.vehicle,
      online: !!state?.online,
      city: state?.city ?? null,
      partnerOffers: rules.partners,
      active: active ? jobView(active, riderId) : null,
      today: { trips, earned },
      teams: places.map((p) => ({
        placeId: p._id.toHexString(),
        business: businesses.find((b) => b._id.equals(p.businessId))?.name ?? "A shop",
      })),
    };
  }

  app.get(
    "/me",
    {
      preHandler: requireDeliveryKyc,
      schema: { tags: ["delivery"], summary: "You as a rider: online or not, the trip under way, and today", response: { 200: Rider, ...Errors }, security },
    },
    async (request) => ok(request, await me(request.auth!.userId)),
  );

  app.post(
    "/online",
    {
      preHandler: requireDeliveryKyc,
      config: limit(1, 20),
      schema: {
        tags: ["delivery"],
        summary: "Go online for Ruxstar partner offers in your city, or go offline",
        description: "Going online needs your location, or the city you are in. Offers from shops you deliver for come either way.",
        body: OnlineBody,
        response: { 200: Rider, ...Errors },
        security,
      },
    },
    async (request) => {
      const riderId = request.auth!.userId;
      const { online, point, city } = request.body;
      const now = new Date();
      if (!online) {
        await db().riderStates.updateOne({ _id: riderId }, { $set: { online: false, updatedAt: now } }, { upsert: true });
      } else {
        let place = city?.trim() || null;
        if (point) place = (await app.geocoder.cityAt(point.lat, point.lng).catch(() => null)) ?? place;
        if (!place) throw new AppError("VALIDATION_FAILED", "Share your location, or type the city you are in.", [{ path: "body/city", message: "Needed to go online" }]);
        await db().riderStates.updateOne(
          { _id: riderId },
          { $set: { online: true, city: place.toLowerCase(), point: point ?? null, updatedAt: now } },
          { upsert: true },
        );
      }
      return ok(request, await me(riderId));
    },
  );

  app.get(
    "/offers",
    {
      preHandler: requireDeliveryKyc,
      schema: {
        tags: ["delivery"],
        summary: "Deliveries you can take now, newest first",
        description: "Ruxstar partner offers in your city while you are online (the first to accept gets it), and offers from shops you deliver for.",
        response: { 200: JobList, ...Errors },
        security,
      },
    },
    async (request) => {
      const riderId = request.auth!.userId;
      const jobs = await offersFor(db(), riderId);
      return page(request, jobs.map((j) => jobView(j, riderId)), null);
    },
  );

  app.get(
    "/jobs",
    {
      preHandler: requireDeliveryKyc,
      schema: {
        tags: ["delivery"],
        summary: "Your deliveries, newest activity first",
        querystring: JobsQuery,
        response: { 200: JobList, ...Errors },
        security,
      },
    },
    async (request) => {
      const riderId = request.auth!.userId;
      const { view = "active", cursor, limit: size } = request.query;
      const { items, nextCursor } = await findPage(db().deliveryJobs, {
        filter: { riderId, status: { $in: view === "active" ? ACTIVE : PAST } },
        sortField: "updatedAt",
        cursor,
        limit: size,
      });
      return page(request, items.map((j) => jobView(j, riderId)), nextCursor);
    },
  );

  app.get(
    "/jobs/:id",
    {
      preHandler: requireDeliveryKyc,
      schema: { tags: ["delivery"], summary: "One delivery", params: JobParams, response: { 200: JobOne, ...Errors }, security },
    },
    async (request) => {
      const riderId = request.auth!.userId;
      return ok(request, jobView(await jobFor(db(), request.params.id, riderId), riderId));
    },
  );

  const step = (
    path: string,
    summary: string,
    description: string,
    run: (job: DeliveryJobDoc, riderId: ObjectId) => Promise<DeliveryJobDoc>,
  ) =>
    app.post(
      `/jobs/:id/${path}`,
      {
        preHandler: [requireDeliveryKyc, idempotent],
        config: limit(1, 30),
        schema: { tags: ["delivery"], summary, description, params: JobParams, response: { 200: JobOne, ...Errors }, security },
      },
      async (request) => {
        const riderId = request.auth!.userId;
        const job = await jobFor(db(), request.params.id, riderId);
        return ok(request, jobView(await run(job, riderId), riderId));
      },
    );

  step(
    "accept",
    "Take a delivery",
    "One at a time. A Ruxstar partner offer goes to whoever accepts first; you need to be online for those.",
    (job, riderId) => acceptJob(app, db(), job, riderId),
  );
  step(
    "pass",
    "Skip an offer",
    "A Ruxstar partner offer stops showing to you. One from a shop you deliver for goes back to the shop to pick someone else.",
    (job, riderId) => passJob(app, db(), job, riderId),
  );
  step(
    "pickup",
    "Picked up from the shop",
    "The order is out for delivery, and the customer is sent the code to give you at the door.",
    (job, riderId) => pickUp(app, db(), job, riderId),
  );

  app.put(
    "/jobs/:id/photo",
    {
      preHandler: requireDeliveryKyc,
      config: limit(60, 20),
      schema: {
        tags: ["delivery"],
        summary: "A photo of the parcel at the door",
        description: "Needed before the code. Send the image with Content-Type image/jpeg, image/png or image/webp, up to 8 MB. Kept privately for 30 days.",
        consumes: ["image/jpeg", "image/png", "image/webp"],
        params: JobParams,
        response: { 200: JobOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const riderId = request.auth!.userId;
      const job = await jobFor(db(), request.params.id, riderId);
      return ok(request, jobView(await addProof(app, db(), job, riderId, request.body), riderId));
    },
  );

  app.post(
    "/jobs/:id/deliver",
    {
      preHandler: [requireDeliveryKyc, idempotent],
      config: limit(10, 20),
      schema: {
        tags: ["delivery"],
        summary: "Delivered: the customer's code",
        description: "Needs the photo at the door. Five wrong codes stop it; then call the customer or hand the delivery back.",
        params: JobParams,
        body: DeliverBody,
        response: { 200: JobOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const riderId = request.auth!.userId;
      const job = await jobFor(db(), request.params.id, riderId);
      return ok(request, jobView(await deliver(app, db(), job, riderId, request.body.code), riderId));
    },
  );

  app.post(
    "/jobs/:id/cancel",
    {
      preHandler: [requireDeliveryKyc, idempotent],
      schema: {
        tags: ["delivery"],
        summary: "Hand a delivery back to the shop",
        description: "The shop is told why and picks another way to deliver it. After pickup, take the parcel back to the shop.",
        params: JobParams,
        body: RiderCancelBody,
        response: { 200: JobOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const riderId = request.auth!.userId;
      const job = await jobFor(db(), request.params.id, riderId);
      return ok(request, jobView(await riderCancel(app, db(), job, riderId, request.body.reason.trim()), riderId));
    },
  );

  app.get(
    "/earnings",
    {
      preHandler: requireDeliveryKyc,
      schema: {
        tags: ["delivery"],
        summary: "What you earned as a Ruxstar partner, and your withdrawals",
        description:
          "Pay for each delivery is added when it is delivered and can be withdrawn 48 hours later. It waits longer only while the " +
          "customer's report that it never arrived is open. Shops pay their own team outside Ruxstar.",
        response: { 200: Earnings, ...Errors },
        security,
      },
    },
    async (request) => {
      const riderId = request.auth!.userId;
      const now = new Date();
      await releaseRiderPayFor(db(), riderId, now);
      await settleDue(app, db(), riderId, now);
      const [ledger, today, week, trips, recent, holding, rules, method, payouts, paid] = await Promise.all([
        db()
          .ledgerEntries.aggregate<{ _id: "pending" | "withdrawable"; total: number }>([
            { $match: { accountId: riderAccount(riderId) } },
            { $group: { _id: "$bucket", total: { $sum: "$signedPaise" } } },
          ])
          .toArray(),
        earnedSince(riderId, startOfDay()),
        earnedSince(riderId, startOfDay(6)),
        db().deliveryJobs.countDocuments({ riderId, status: "delivered", carrier: "partner" }),
        db().deliveryJobs.find({ riderId, status: "delivered", carrier: "partner" }).sort({ updatedAt: -1 }).limit(20).toArray(),
        db().podOrders.find(heldRiderPay(riderId)).sort({ "delivery.releaseAt": 1 }).limit(20).toArray(),
        payoutRules(db(), "rider"),
        db().riderPayoutMethods.findOne({ userId: riderId }),
        db()
          .payouts.find({ vendorId: riderId, ...payeeFilter("rider") })
          .sort({ createdAt: -1, _id: -1 })
          .limit(20)
          .toArray(),
        db()
          .payouts.aggregate<{ total: number }>([
            { $match: { vendorId: riderId, status: "paid", ...payeeFilter("rider") } },
            { $group: { _id: null, total: { $sum: "$amount" } } },
          ])
          .toArray(),
      ]);
      const sum = (bucket: "pending" | "withdrawable") => Math.max(0, ledger.find((row) => row._id === bucket)?.total ?? 0);
      return ok(request, {
        balance: { available: sum("withdrawable"), pending: sum("pending"), paidOut: paid[0]?.total ?? 0 },
        today,
        week,
        trips,
        recent: recent.map((j) => ({ jobId: j._id.toHexString(), orderNo: j.orderNo, pay: j.pay, at: j.updatedAt.toISOString() })),
        upcoming: holding.map((o) => ({
          orderId: o._id.toHexString(),
          orderNo: o.orderNo,
          amount: o.delivery!.pay,
          availableAt: o.delivery!.releaseAt!.toISOString(),
          held: riderPayHeld(o),
        })),
        withdrawal: rules,
        payoutMethod: method ? payoutMethodView(method) : null,
        payouts: payouts.map(payoutView),
      });
    },
  );

  app.post(
    "/payouts",
    {
      preHandler: [requireDeliveryKyc, idempotent],
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
      schema: {
        tags: ["delivery"],
        summary: "Withdraw everything available to your payout account",
        description:
          "Takes the whole available balance, at least the minimum, and sends it less the payout fee. One withdrawal at a time, " +
          "counting one from your shop earnings if you have a shop too. Until Cashfree confirms it, it shows as pending; if it fails, " +
          "the amount is back in your balance. Send an Idempotency-Key.",
        response: { 200: PayoutResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const payout = await withdraw(app, db(), request.auth!.userId, actorOf(request), request.ip, "rider");
      return ok(request, payoutView(payout));
    },
  );

  app.get(
    "/earnings/statement",
    {
      preHandler: requireDeliveryKyc,
      schema: {
        tags: ["delivery"],
        summary: "Every change to your delivery earnings, newest first",
        description: "One line per money movement: a delivery's pay arriving (on hold), its hold ending, withdrawals, and failed withdrawals coming back.",
        querystring: RiderStatementQuery,
        response: { 200: RiderStatement, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const { items, nextCursor } = await findPage(database.ledgerEntries, {
        // A release moves pay from on hold to available; its pending side would only repeat the line.
        filter: { accountId: riderAccount(request.auth!.userId), $nor: [{ kind: "rider_release", bucket: "pending" }] },
        sortField: "at",
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      const ids = (type: "pod_order" | "payout") => items.filter((e) => e.source.type === type).map((e) => e.source.id);
      const [orders, payouts] = await Promise.all([
        database.podOrders.find({ _id: { $in: ids("pod_order") } }, { projection: { orderNo: 1 } }).toArray(),
        database.payouts.find({ _id: { $in: ids("payout") } }, { projection: { to: 1 } }).toArray(),
      ]);
      const lines = items.flatMap((entry): RiderStatementLine[] => {
        const base = { id: entry._id.toHexString(), amount: entry.signedPaise, at: entry.at.toISOString() };
        if (entry.source.type === "payout") {
          const payout = payouts.find((p) => p._id.equals(entry.source.id));
          if (!payout) return [];
          const kind = entry.kind === "payout" ? "withdrawal" : "returned";
          return [{ ...base, kind, order: null, payout: { id: payout._id.toHexString(), to: payout.to } }];
        }
        const order = orders.find((o) => o._id.equals(entry.source.id));
        if (!order) return [];
        // Pay from before the hold arrived straight in the available balance, so it reads as earned too.
        const kind = entry.kind === "rider_release" ? "available" : "earned";
        return [{ ...base, kind, order: { id: order._id.toHexString(), orderNo: order.orderNo }, payout: null }];
      });
      return page(request, lines, nextCursor);
    },
  );

  app.get(
    "/payout-method",
    {
      preHandler: requireDeliveryKyc,
      schema: { tags: ["delivery"], summary: "Where your delivery earnings are paid", response: { 200: PayoutMethodResult, ...Errors }, security },
    },
    async (request) => {
      const method = await db().riderPayoutMethods.findOne({ userId: request.auth!.userId });
      return ok(request, method ? payoutMethodView(method) : null);
    },
  );

  app.put(
    "/payout-method",
    {
      preHandler: requireDeliveryKyc,
      config: { rateLimit: { max: 5, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["delivery"],
        summary: "Set the bank account or UPI ID your delivery earnings are paid to",
        description:
          "Checked with Cashfree before it is saved, and it must be in the name on your Aadhaar. Replaces the one you had; " +
          "the account your shop is paid to doesn't change. Only the last 4 digits of a bank account are ever shown again.",
        body: PayoutMethodBody,
        response: { 200: PayoutMethodResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const saved = await setPayoutMethod(app, db(), request.auth!.userId, request.body, { actor: actorOf(request), ip: request.ip }, "rider");
      return ok(request, payoutMethodView(saved));
    },
  );
};

export default delivery;
