import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type Filter, type WithId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { publicCache, requireAuth, signedInIfPossible } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { BusinessDoc, Database, GigDoc, GigOrderDoc, GigQuoteDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { checkCode, offersFor } from "../coupons/coupons.js";
import { safeReturn } from "../pod/orders.js";
import { escapeRegex } from "../pod/shops.js";
import { reviewRoutes } from "../reviews/routes.js";
import { gigCheckoutUrl } from "./checkout.js";
import {
  ApproveBody,
  CancelBody,
  CheckoutLinkOne,
  FreelancerOne,
  GigList,
  GigOne,
  GigOrderList,
  GigOrderOne,
  GigsQuery,
  GigsRulesOne,
  IdParams,
  MyOrdersQuery,
  NoteBody,
  OffersOne,
  OffersQuery,
  OrderBody,
  PayBody,
  PlacedOrder,
  ProblemBody,
  QuoteOne,
  QuotePayBody,
} from "./contracts.js";
import desk from "./desk.js";
import files from "./files.js";
import manage from "./manage.js";
import { askRevision, cancelOrder, completeOrder, placeOrder, reportProblem, syncGigPayment, type By, type Source } from "./orders.js";
import { quoteStatus } from "./quotes.js";
import { gigsSettings } from "./rules.js";
import { gigCards, gigDetail, gigReviewable, orderProblem, orderViews, ownersOf, profileView } from "./views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const signedInOrNot: Record<string, string[]>[] = [{}, { bearer: [] }, { cookie: [] }];

/** Freelancers customers can see: live, not on hold. The module being off hides them all. */
const visibleFreelancers: Filter<BusinessDoc> = { module: "gigs", status: "live", suspension: { $exists: false } };

async function visibleGig(db: Database, id: ObjectId) {
  const gig = await db.gigs.findOne({ _id: id, status: { $in: ["live", "paused"] } }, { projection: { businessId: 1 } });
  if (!gig) return false;
  return Boolean(await db.businesses.findOne({ _id: gig.businessId, ...visibleFreelancers }, { projection: { _id: 1 } }));
}

/**
 * Freelancers for customers: gigs by category and city, a freelancer's page, ordering a package and paying, offers from chats,
 * their orders, approving, revisions, problems and reviews. Freelancers' own profile and gigs are under /me, their orders under /desk.
 */
const gigs: FastifyPluginAsyncTypebox = async (app) => {
  await app.register(manage, { prefix: "/me" });
  await app.register(desk, { prefix: "/desk" });
  await app.register(files);
  await app.register(
    reviewRoutes({
      module: "gigs",
      tag: "gigs",
      noun: "freelance order",
      rule: "Once it's complete, until 30 days after; not orders refunded in full.",
      order: async (_app, db, userId, id) => {
        const order = await db.gigOrders.findOne({ _id: new ObjectId(id), customerId: userId });
        if (!order) throw new AppError("NOT_FOUND", "Order not found.");
        return gigReviewable(order);
      },
      listing: { type: "gig", label: "gig", visible: visibleGig },
    }),
  );
  const db = () => requireDatabase(app.db);
  const byOf = (request: FastifyRequest): By => ({ kind: "customer", actor: actorOf(request), ip: request.ip });

  async function mine(userId: ObjectId, id: string) {
    const doc = await db().gigOrders.findOne({ _id: new ObjectId(id), customerId: userId });
    if (!doc) throw new AppError("NOT_FOUND", "Order not found.");
    return doc;
  }
  async function customerOf(request: FastifyRequest) {
    const userId = request.auth!.userId;
    const user = await db().users.findOne({ _id: userId }, { projection: { phone: 1, name: 1 } });
    if (!user) throw new AppError("UNAUTHENTICATED");
    return { id: userId, phone: user.phone, name: user.name?.trim() || null };
  }
  /** A gig and its freelancer, when customers can order it now. */
  async function orderable(id: string) {
    const gig = await db().gigs.findOne({ _id: new ObjectId(id) });
    if (!gig || gig.status === "draft" || gig.status === "removed") throw new AppError("NOT_FOUND", "This gig isn't on Ruxstar.");
    const business = await db().businesses.findOne({ _id: gig.businessId, ...visibleFreelancers });
    if (!business) throw new AppError("NOT_FOUND", "This gig isn't on Ruxstar.");
    const settings = await gigsSettings(db());
    if (!settings.live) throw new AppError("MODULE_OFF");
    const problem = orderProblem(gig, business, settings);
    if (problem) throw new AppError("ORDER_STATE", problem);
    return { gig, business };
  }
  const one = async (request: FastifyRequest, o: GigOrderDoc) => ok(request, (await orderViews(app, db(), request, [o], "customer"))[0]!);
  const quoteView = (q: WithId<GigQuoteDoc>) => ({
    id: q._id.toHexString(),
    status: quoteStatus(q),
    chatId: q.conversationId.toHexString(),
    orderId: q.orderId?.toHexString() ?? null,
    withdrawnAt: q.withdrawnAt?.toISOString() ?? null,
  });

  app.get(
    "/rules",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["gigs"],
        summary: "Ruxstar's rules for freelancing: categories, prices, delivery days, revisions, file sizes, timers and fees",
        description: "No sign-in needed.",
        response: { 200: GigsRulesOne, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      publicCache(request, reply);
      const settings = await gigsSettings(db());
      return ok(request, { ...settings, categories: settings.categories.filter((c) => !c.hidden).map((c) => ({ key: c.key, label: c.label })) });
    },
  );

  app.get(
    "/",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["gigs"],
        summary: "Gigs, newest first",
        description: "No sign-in needed. Filter by category, city and words in the title. Empty while Ruxstar has freelancing switched off.",
        querystring: GigsQuery,
        response: { 200: GigList, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      publicCache(request, reply);
      const settings = await gigsSettings(db());
      if (!settings.live) return page(request, [], null);
      const q = request.query;
      const filters: Filter<GigDoc>[] = [{ status: "live" }];
      if (q.category) filters.push({ category: q.category });
      if (q.city) filters.push({ city: q.city.trim().toLowerCase() });
      if (q.q?.trim()) filters.push({ $or: [{ title: { $regex: escapeRegex(q.q.trim()), $options: "i" } }, { businessName: { $regex: escapeRegex(q.q.trim()), $options: "i" } }] });
      const { items, nextCursor } = await findPage(db().gigs, { filter: { $and: filters }, sortField: "publishedAt", cursor: q.cursor, limit: q.limit });
      const live = await db()
        .businesses.find({ _id: { $in: items.map((g) => g.businessId) }, ...visibleFreelancers }, { projection: { _id: 1 } })
        .toArray();
      return page(request, await gigCards(db(), items.filter((g) => live.some((b) => b._id.equals(g.businessId))), settings), nextCursor);
    },
  );

  app.get(
    "/freelancers/:id",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["gigs"],
        summary: "A freelancer's page: profile, portfolio and live gigs",
        description: "No sign-in needed. `id` is the freelancer's business id, as on a gig.",
        params: IdParams,
        response: { 200: FreelancerOne, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      const settings = await gigsSettings(db());
      const doc = await db().businesses.findOne({ _id: new ObjectId(request.params.id), ...visibleFreelancers });
      if (!doc?.freelancer || !settings.live) throw new AppError("NOT_FOUND", "This freelancer isn't on Ruxstar.");
      const [owners, items] = await Promise.all([
        ownersOf(db(), [doc.ownerId]),
        db().gigs.find({ businessId: doc._id, status: "live" }).sort({ publishedAt: -1, _id: -1 }).limit(50).toArray(),
      ]);
      const owner = owners.get(doc.ownerId.toHexString());
      publicCache(request, reply);
      return ok(request, {
        ...profileView(doc, owner, settings),
        userId: doc.ownerId.toHexString(),
        username: owner?.username ?? null,
        gigs: await gigCards(db(), items, settings),
        memberSince: doc.createdAt.toISOString(),
      });
    },
  );

  // The customer's orders.

  app.get(
    "/orders",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["gigs"],
        summary: "Your freelance orders, newest first",
        description: "current: waiting for payment, the freelancer, you or Ruxstar. past: completed or cancelled.",
        querystring: MyOrdersQuery,
        response: { 200: GigOrderList, ...Errors },
        security,
      },
    },
    async (request) => {
      const view = request.query.view ?? "current";
      const filter: Filter<GigOrderDoc> = {
        customerId: request.auth!.userId,
        status: view === "past" ? { $in: ["completed", "cancelled"] } : { $nin: ["completed", "cancelled"] },
      };
      const { items, nextCursor } = await findPage(db().gigOrders, { filter, sortField: "createdAt", cursor: request.query.cursor, limit: request.query.limit });
      return page(request, await orderViews(app, db(), request, items, "customer"), nextCursor);
    },
  );

  app.get(
    "/orders/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["gigs"],
        summary: "One order: the package, your brief, deliveries, revisions, refunds and invoices",
        description: "While it waits for payment, Cashfree is asked whether it was paid. File links work for 10 minutes; open the order again for fresh ones.",
        params: IdParams,
        response: { 200: GigOrderOne, ...Errors },
        security,
      },
    },
    async (request) => one(request, await syncGigPayment(app, db(), await mine(request.auth!.userId, request.params.id))),
  );

  app.post(
    "/orders/:id/pay",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["gigs"],
        summary: "A fresh checkout link for an order waiting for payment",
        params: IdParams,
        body: PayBody,
        response: { 200: CheckoutLinkOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const back = safeReturn(app, request.body.returnTo);
      const o = await syncGigPayment(app, db(), await mine(request.auth!.userId, request.params.id));
      if (o.status !== "awaiting_payment") throw new AppError("ORDER_STATE", o.status === "cancelled" ? "This order was cancelled." : "This order is paid.");
      return ok(request, { checkoutUrl: gigCheckoutUrl(app, request, o, back) });
    },
  );

  app.post(
    "/orders/:id/cancel",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["gigs"],
        summary: "Cancel an order for a full refund",
        description: "Before the freelancer accepts it, or once it's past its due date with nothing delivered. Everything comes back, platform fee included.",
        params: IdParams,
        body: CancelBody,
        response: { 200: GigOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const o = await mine(request.auth!.userId, request.params.id);
      const reason =
        request.body.reason?.trim() ||
        (o.status === "awaiting_payment" ? "You cancelled before paying." : o.status === "paid" ? "You cancelled before it was accepted." : "You cancelled it because it was late.");
      return one(request, await cancelOrder(app, db(), o, byOf(request), { reason }));
    },
  );

  app.post(
    "/orders/:id/approve",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["gigs"],
        summary: "Approve the delivery",
        description: "The order completes and the freelancer is paid. You can then review it.",
        params: IdParams,
        body: ApproveBody,
        response: { 200: GigOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const o = await mine(request.auth!.userId, request.params.id);
      return one(request, await completeOrder(app, db(), o, byOf(request), request.body.note?.trim() || null));
    },
  );

  app.post(
    "/orders/:id/revision",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["gigs"],
        summary: "Ask for a revision",
        description: "While the package has revisions left. The order goes back to the freelancer with your note; its due date stays.",
        params: IdParams,
        body: NoteBody,
        response: { 200: GigOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const o = await mine(request.auth!.userId, request.params.id);
      return one(request, await askRevision(app, db(), o, byOf(request), request.body.note.trim()));
    },
  );

  app.post(
    "/orders/:id/problem",
    {
      preHandler: [requireAuth, idempotent],
      config: { rateLimit: { max: 5, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["gigs"],
        summary: "Report a problem with the delivery",
        description: "Opens a help ticket about the order. The money is held until Ruxstar decides a full, part or no refund.",
        params: IdParams,
        body: ProblemBody,
        response: { 200: GigOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const o = await mine(request.auth!.userId, request.params.id);
      return one(request, await reportProblem(app, db(), o, byOf(request), request.body.reason.trim()));
    },
  );

  // Custom offers.

  async function myQuote(request: FastifyRequest, id: string) {
    const q = await db().gigQuotes.findOne({ _id: new ObjectId(id) });
    const userId = request.auth!.userId;
    if (!q || !(q.customerId.equals(userId) || q.vendorId.equals(userId))) throw new AppError("NOT_FOUND", "Offer not found.");
    return q;
  }

  app.get(
    "/quotes/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["gigs"],
        summary: "Where a custom offer stands",
        description: "For the customer it was sent to and the freelancer. The offer's terms are on its chat message.",
        params: IdParams,
        response: { 200: QuoteOne, ...Errors },
        security,
      },
    },
    async (request) => ok(request, quoteView(await myQuote(request, request.params.id))),
  );

  app.post(
    "/quotes/:id/pay",
    {
      preHandler: [requireAuth, idempotent],
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["gigs"],
        summary: "Accept and pay for a custom offer",
        description:
          "Only the customer it was sent to, while it's open. The order is accepted already: it's due the offer's delivery days after payment. " +
          "Asking again while an order for it waits for payment gives that order's checkout link.",
        params: IdParams,
        body: QuotePayBody,
        response: { 201: PlacedOrder, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const back = safeReturn(app, request.body.returnTo);
      const q = await myQuote(request, request.params.id);
      const customer = await customerOf(request);
      if (!q.customerId.equals(customer.id)) throw new AppError("FORBIDDEN", "Only the customer the offer was sent to can pay for it.");
      const waiting = await db().gigOrders.findOne({ quoteId: q._id, customerId: customer.id, status: "awaiting_payment" });
      if (waiting) {
        const fresh = await syncGigPayment(app, db(), waiting);
        if (fresh.status === "awaiting_payment") {
          return reply.status(201).send(ok(request, { order: (await orderViews(app, db(), request, [fresh], "customer"))[0]!, checkoutUrl: gigCheckoutUrl(app, request, fresh, back) }));
        }
      }
      const settings = await gigsSettings(db());
      if (!settings.live) throw new AppError("MODULE_OFF");
      const business = await db().businesses.findOne({ _id: q.businessId, module: "gigs", suspension: { $exists: false } });
      if (!business) throw new AppError("ORDER_STATE", "This freelancer isn't on Ruxstar right now.");
      const current = (await db().gigQuotes.findOne({ _id: q._id }))!;
      const source: Source = { kind: "quote", quote: current };
      const o = await placeOrder(app, db(), { source, business, customer, fileIds: request.body.fileIds ?? [], note: request.body.note ?? null, coupon: request.body.coupon });
      return reply.status(201).send(
        ok(request, { order: (await orderViews(app, db(), request, [o], "customer"))[0]!, checkoutUrl: o.status === "awaiting_payment" ? gigCheckoutUrl(app, request, o, back) : null }),
      );
    },
  );

  // One gig.

  app.get(
    "/:id/offers",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["gigs"],
        summary: "Coupons that work for one of a gig's packages, and checking a code",
        params: IdParams,
        querystring: OffersQuery,
        response: { 200: OffersOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { gig, business } = await orderable(request.params.id);
      const chosen = gig.packages.find((p) => p.tier === request.query.tier);
      if (!chosen) throw new AppError("VALIDATION_FAILED", "This gig doesn't have that package.", [{ path: "querystring/tier", message: "Not one of its packages" }]);
      const ctx = { module: "gigs" as const, shop: { id: business._id, name: business.name }, customerId: request.auth!.userId, items: chosen.price };
      const code = request.query.code;
      const [offers, check] = await Promise.all([offersFor(db(), ctx), code ? checkCode(db(), code, ctx) : null]);
      return ok(request, { offers, checked: check ? { code: code!.trim().toUpperCase(), discount: check.problem === null ? check.discount : 0, problem: check.problem } : null });
    },
  );

  app.post(
    "/:id/order",
    {
      preHandler: [requireAuth, idempotent],
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["gigs"],
        summary: "Order one of a gig's packages",
        description:
          "Answer its required questions; attach files uploaded with POST /v1/gigs/files?use=brief. Returns a checkout link, open for 20 minutes. " +
          "Once paid, the freelancer has Ruxstar's accept hours to accept or you get everything back.",
        params: IdParams,
        body: OrderBody,
        response: { 201: PlacedOrder, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const back = safeReturn(app, request.body.returnTo);
      const { gig, business } = await orderable(request.params.id);
      const body = request.body;
      const o = await placeOrder(app, db(), {
        source: { kind: "gig", gig, tier: body.tier, answers: body.answers },
        business,
        customer: await customerOf(request),
        fileIds: body.fileIds ?? [],
        note: body.note ?? null,
        coupon: body.coupon,
      });
      return reply.status(201).send(
        ok(request, { order: (await orderViews(app, db(), request, [o], "customer"))[0]!, checkoutUrl: o.status === "awaiting_payment" ? gigCheckoutUrl(app, request, o, back) : null }),
      );
    },
  );

  app.get(
    "/:id",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["gigs"],
        summary: "One gig: photos, packages, the questions asked when ordering, and the order rules",
        description: "No sign-in needed. Drafts and gigs Ruxstar took down are only found by their freelancer.",
        params: IdParams,
        response: { 200: GigOne, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      const gig = await db().gigs.findOne({ _id: new ObjectId(request.params.id) });
      const own = Boolean(request.auth && gig?.vendorId.equals(request.auth.userId));
      if (!gig || (!own && !(await visibleGig(db(), gig._id)))) throw new AppError("NOT_FOUND", "This gig isn't on Ruxstar.");
      const settings = await gigsSettings(db());
      if (!own && !settings.live) throw new AppError("NOT_FOUND", "This gig isn't on Ruxstar.");
      const view = await gigDetail(db(), gig, settings);
      if (!own) publicCache(request, reply);
      return ok(request, own ? { ...view, canOrder: false, whyNot: "This is your gig." } : view);
    },
  );
};

export default gigs;
