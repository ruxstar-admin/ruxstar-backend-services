import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type Filter, type WithId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, writeAudit } from "../../platform/audit.js";
import { requireRuxstar } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { BusinessDoc, GigDoc, GigOrderDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { notifyGigs } from "../notifications/notify.js";
import { escapeRegex } from "../pod/shops.js";
import {
  ConsoleFreelancerList,
  ConsoleFreelancerOne,
  ConsoleFreelancersQuery,
  ConsoleGigList,
  ConsoleGigOne,
  ConsoleGigsQuery,
  ConsoleOrdersQuery,
  DecideBody,
  GigOrderList,
  GigOrderOne,
  IdParams,
  TakeDownBody,
} from "../gigs/contracts.js";
import { decideDispute, syncGigPayment, type By } from "../gigs/orders.js";
import { gigsSettings } from "../gigs/rules.js";
import { myGigViews, orderViews, ownersOf, profileView } from "../gigs/views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

/**
 * Freelancers in the console: profiles, gigs and take-downs, orders, and deciding reported problems. Profiles and gigs go live
 * without review; a freelancer is held with the shared business suspend. Disputes are in the help desk queue too.
 */
const gigs: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const byOf = (request: FastifyRequest): By & { kind: "staff" } => ({ kind: "staff", actor: actorOf(request), ip: request.ip });

  async function freelancerViews(docs: WithId<BusinessDoc>[]) {
    if (!docs.length) return [];
    const ids = docs.map((d) => d._id);
    const group = { $group: { _id: "$businessId", n: { $sum: 1 } } };
    const [settings, owners, users, gigCounts, orders] = await Promise.all([
      gigsSettings(db()),
      ownersOf(db(), docs.map((d) => d.ownerId)),
      db().users.find({ _id: { $in: docs.map((d) => d.ownerId) } }, { projection: { kyc: 1 } }).toArray(),
      db().gigs.aggregate<{ _id: ObjectId; n: number }>([{ $match: { businessId: { $in: ids }, status: { $ne: "removed" } } }, group]).toArray(),
      db().gigOrders.aggregate<{ _id: ObjectId; n: number }>([{ $match: { businessId: { $in: ids }, "payment.paidAt": { $type: "date" } } }, group]).toArray(),
    ]);
    return docs.map((d) => ({
      ...profileView(d, owners.get(d.ownerId.toHexString()), settings),
      ownerId: d.ownerId.toHexString(),
      status: d.status,
      verified: users.find((u) => u._id.equals(d.ownerId))?.kyc.base === "approved",
      suspended: Boolean(d.suspension),
      gigs: gigCounts.find((c) => c._id.equals(d._id))?.n ?? 0,
      orders: orders.find((c) => c._id.equals(d._id))?.n ?? 0,
      createdAt: d.createdAt.toISOString(),
    }));
  }
  async function gigViews(docs: WithId<GigDoc>[]) {
    const settings = await gigsSettings(db());
    const users = await db().users.find({ _id: { $in: docs.map((g) => g.vendorId) } }, { projection: { kyc: 1 } }).toArray();
    const views = await Promise.all(
      docs.map(async (g) => (await myGigViews(db(), [g], settings, users.find((u) => u._id.equals(g.vendorId))?.kyc.base === "approved"))[0]!),
    );
    return views.map((v, i) => ({ ...v, vendorId: docs[i]!.vendorId.toHexString() }));
  }
  async function order(id: string) {
    const o = await db().gigOrders.findOne({ _id: new ObjectId(id) });
    if (!o) throw new AppError("NOT_FOUND", "Order not found.");
    return o;
  }
  const oneOrder = async (request: FastifyRequest, o: GigOrderDoc) => ok(request, (await orderViews(app, db(), request, [o], "staff"))[0]!);

  app.get(
    "/gigs/freelancers",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "Every freelancer, newest first, with their gig and order counts",
        querystring: ConsoleFreelancersQuery,
        response: { 200: ConsoleFreelancerList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { q, cursor, limit } = request.query;
      const filter: Filter<BusinessDoc> = { module: "gigs" };
      if (q?.trim()) filter.name = { $regex: escapeRegex(q.trim()), $options: "i" };
      const { items, nextCursor } = await findPage(db().businesses, { filter, sortField: "createdAt", cursor, limit });
      return page(request, await freelancerViews(items), nextCursor);
    },
  );

  app.get(
    "/gigs/freelancers/:id",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: { tags: ["ruxstar"], summary: "One freelancer", params: IdParams, response: { 200: ConsoleFreelancerOne, ...Errors }, security },
    },
    async (request) => {
      const doc = await db().businesses.findOne({ _id: new ObjectId(request.params.id), module: "gigs" });
      if (!doc?.freelancer) throw new AppError("NOT_FOUND", "Freelancer not found.");
      return ok(request, (await freelancerViews([doc]))[0]!);
    },
  );

  app.get(
    "/gigs/listings",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: { tags: ["ruxstar"], summary: "Every gig, newest first, drafts included", querystring: ConsoleGigsQuery, response: { 200: ConsoleGigList, ...Errors }, security },
    },
    async (request) => {
      const { status, freelancer, q, cursor, limit } = request.query;
      const filter: Filter<GigDoc> = {};
      if (status) filter.status = status;
      if (freelancer) filter.businessId = new ObjectId(freelancer);
      if (q?.trim()) filter.title = { $regex: escapeRegex(q.trim()), $options: "i" };
      const { items, nextCursor } = await findPage(db().gigs, { filter, sortField: "createdAt", cursor, limit });
      return page(request, await gigViews(items), nextCursor);
    },
  );

  app.get(
    "/gigs/listings/:id",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: { tags: ["ruxstar"], summary: "One gig", params: IdParams, response: { 200: ConsoleGigOne, ...Errors }, security },
    },
    async (request) => {
      const g = await db().gigs.findOne({ _id: new ObjectId(request.params.id) });
      if (!g) throw new AppError("NOT_FOUND", "Gig not found.");
      return ok(request, (await gigViews([g]))[0]!);
    },
  );

  app.post(
    "/gigs/listings/:id/take-down",
    {
      preHandler: [requireRuxstar("businesses.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Take a gig down",
        description: "It leaves the listings and can't be changed or ordered again; the freelancer is told why. Orders already placed go on. Audited.",
        params: IdParams,
        body: TakeDownBody,
        response: { 200: ConsoleGigOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const g = await db().gigs.findOne({ _id: new ObjectId(request.params.id) });
      if (!g) throw new AppError("NOT_FOUND", "Gig not found.");
      if (g.status === "removed") throw new AppError("CONFLICT", "This gig is down already.");
      const reason = request.body.reason.trim();
      const now = new Date();
      const after = await db().gigs.findOneAndUpdate(
        { _id: g._id, status: { $ne: "removed" } },
        { $set: { status: "removed", removal: { actorId: request.auth!.userId, reason, at: now }, updatedAt: now } },
        { returnDocument: "after" },
      );
      if (!after) throw new AppError("CONFLICT", "This gig is down already.");
      await writeAudit(db(), {
        actor: actorOf(request),
        scope: { module: "gigs", businessId: g.businessId },
        action: "gig.take_down",
        target: { type: "gig", id: g._id },
        diff: { status: { from: g.status, to: "removed" }, reason: { from: null, to: reason } },
        ip: request.ip,
      });
      await notifyGigs(db(), request.log, {
        actor: request.auth!.userId,
        type: "gigs.updated",
        title: `Ruxstar took down ${g.title}`,
        body: `${reason} Contact support if you think this is a mistake.`,
        to: [{ userId: g.vendorId, link: { screen: "gig", id: g._id.toHexString() } }],
      });
      return ok(request, (await gigViews([after]))[0]!);
    },
  );

  app.get(
    "/gigs/orders",
    {
      preHandler: requireRuxstar("orders.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "Freelance orders, newest first",
        description: "Search by order number or words in the title; filter by status and freelancer. `disputed` ones wait for a refund decision.",
        querystring: ConsoleOrdersQuery,
        response: { 200: GigOrderList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { status, freelancer, q, cursor, limit } = request.query;
      const filter: Filter<GigOrderDoc> = {};
      if (status) filter.status = status;
      if (freelancer) filter.businessId = new ObjectId(freelancer);
      const words = q?.trim().replace(/^#/, "");
      if (words) filter.$or = /^\d+$/.test(words) ? [{ orderNo: Number(words) }] : [{ title: { $regex: escapeRegex(words), $options: "i" } }];
      const { items, nextCursor } = await findPage(db().gigOrders, { filter, sortField: "createdAt", cursor, limit });
      return page(request, await orderViews(app, db(), request, items, "staff"), nextCursor);
    },
  );

  app.get(
    "/gigs/orders/:id",
    {
      preHandler: requireRuxstar("orders.view"),
      schema: { tags: ["ruxstar"], summary: "One freelance order, with its files, deliveries and any dispute", params: IdParams, response: { 200: GigOrderOne, ...Errors }, security },
    },
    async (request) => oneOrder(request, await syncGigPayment(app, db(), await order(request.params.id))),
  );

  app.post(
    "/gigs/orders/:id/decide",
    {
      preHandler: [requireRuxstar("orders.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Decide a problem reported on an order: a full, part or no refund",
        description:
          "Full: everything back to the customer, platform fee included. Part: `amount` back, out of the freelancer's share, and the rest paid to them. " +
          "None: the freelancer is paid. The order completes (or is cancelled, for full), both sides are told, and the note goes on the help ticket. Audited.",
        params: IdParams,
        body: DecideBody,
        response: { 200: GigOrderOne, ...Errors },
        security,
      },
    },
    async (request) => oneOrder(request, await decideDispute(app, db(), await order(request.params.id), byOf(request), request.body)),
  );
};

export default gigs;
