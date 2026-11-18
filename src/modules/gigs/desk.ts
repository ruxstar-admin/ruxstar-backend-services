import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type Filter } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, writeAudit } from "../../platform/audit.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { GigOrderDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { DeliverBody, DeskOrdersQuery, GigOrderList, GigOrderOne, IdParams, QuoteOne, VendorCancelBody } from "./contracts.js";
import { acceptOrder, cancelOrder, deliverOrder, type By } from "./orders.js";
import { quoteStatus, touchQuote } from "./quotes.js";
import { orderViews } from "./views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

/** The freelancer's desk: orders to accept, deliver or cancel, and withdrawing custom offers. Freelancers work alone, so it's the owner's only. */
const desk: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const byOf = (request: FastifyRequest): By => ({ kind: "vendor", actor: actorOf(request), ip: request.ip });

  async function mine(request: FastifyRequest, id: string, { acting = true }: { acting?: boolean } = {}) {
    const o = await db().gigOrders.findOne({ _id: new ObjectId(id), vendorId: request.auth!.userId });
    if (!o || !o.payment.paidAt) throw new AppError("NOT_FOUND", "Order not found.");
    if (acting) {
      const business = await db().businesses.findOne({ _id: o.businessId }, { projection: { suspension: 1 } });
      if (business?.suspension) throw new AppError("BUSINESS_SUSPENDED");
    }
    return o;
  }
  const one = async (request: FastifyRequest, o: GigOrderDoc) => ok(request, (await orderViews(app, db(), request, [o], "freelancer"))[0]!);

  app.get(
    "/orders",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["gigs"],
        summary: "Orders for your gigs and offers, newest first",
        description: "Paid ones only. Filter by status: `paid` waits for you to accept.",
        querystring: DeskOrdersQuery,
        response: { 200: GigOrderList, ...Errors },
        security,
      },
    },
    async (request) => {
      const filter: Filter<GigOrderDoc> = { vendorId: request.auth!.userId, "payment.paidAt": { $type: "date" } };
      if (request.query.status) filter.status = request.query.status;
      const { items, nextCursor } = await findPage(db().gigOrders, { filter, sortField: "createdAt", cursor: request.query.cursor, limit: request.query.limit });
      return page(request, await orderViews(app, db(), request, items, "freelancer"), nextCursor);
    },
  );

  app.get(
    "/orders/:id",
    {
      preHandler: requireAuth,
      schema: { tags: ["gigs"], summary: "One order: the brief, files, deliveries and your share", params: IdParams, response: { 200: GigOrderOne, ...Errors }, security },
    },
    async (request) => one(request, await mine(request, request.params.id, { acting: false })),
  );

  app.post(
    "/orders/:id/accept",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["gigs"],
        summary: "Accept a paid order",
        description: "Within Ruxstar's accept hours of payment, or the customer is refunded. It's due the package's delivery days from now.",
        params: IdParams,
        response: { 200: GigOrderOne, ...Errors },
        security,
      },
    },
    async (request) => one(request, await acceptOrder(app, db(), await mine(request, request.params.id), byOf(request))),
  );

  app.post(
    "/orders/:id/decline",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["gigs"],
        summary: "Turn down a paid order",
        description: "The customer gets everything back and is told why.",
        params: IdParams,
        body: VendorCancelBody,
        response: { 200: GigOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const o = await mine(request, request.params.id);
      if (o.status !== "paid") throw new AppError("ORDER_STATE", "Only orders waiting for you to accept can be turned down. Cancel it instead.");
      return one(request, await cancelOrder(app, db(), o, byOf(request), { reason: `${o.businessName} turned it down: ${request.body.reason.trim()}` }));
    },
  );

  app.post(
    "/orders/:id/deliver",
    {
      preHandler: [requireAuth, idempotent],
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["gigs"],
        summary: "Deliver an order: a message, links and files",
        description:
          "Upload the files first with POST /v1/gigs/files?use=delivery. They add up to at most Ruxstar's delivery size. " +
          "The customer then approves it, asks for a revision while the package has them, or reports a problem; unanswered, it completes by itself.",
        params: IdParams,
        body: DeliverBody,
        response: { 200: GigOrderOne, ...Errors },
        security,
      },
    },
    async (request) => one(request, await deliverOrder(app, db(), await mine(request, request.params.id), byOf(request), request.body)),
  );

  app.post(
    "/orders/:id/cancel",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["gigs"],
        summary: "Cancel an order you can't finish",
        description: "Any time until it completes, unless a problem was reported. The customer gets everything back and is told why.",
        params: IdParams,
        body: VendorCancelBody,
        response: { 200: GigOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const o = await mine(request, request.params.id);
      return one(request, await cancelOrder(app, db(), o, byOf(request), { reason: `${o.businessName} cancelled it: ${request.body.reason.trim()}` }));
    },
  );

  app.post(
    "/quotes/:id/withdraw",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["gigs"],
        summary: "Withdraw a custom offer you sent",
        description: "Until it's paid. The offer in the chat shows it was withdrawn.",
        params: IdParams,
        response: { 200: QuoteOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const q = await database.gigQuotes.findOne({ _id: new ObjectId(request.params.id), vendorId: request.auth!.userId });
      if (!q) throw new AppError("NOT_FOUND", "Offer not found.");
      const view = (d: typeof q) => ({
        id: d._id.toHexString(),
        status: quoteStatus(d),
        chatId: d.conversationId.toHexString(),
        orderId: d.orderId?.toHexString() ?? null,
        withdrawnAt: d.withdrawnAt?.toISOString() ?? null,
      });
      if (q.status === "withdrawn") return ok(request, view(q));
      const status = quoteStatus(q);
      if (status !== "open") throw new AppError("CONFLICT", status === "paid" ? "This offer is paid for, so it can't be withdrawn. Cancel the order instead." : "This offer has expired already.");
      const now = new Date();
      const after = await database.gigQuotes.findOneAndUpdate(
        { _id: q._id, status: "open" },
        { $set: { status: "withdrawn", withdrawnAt: now, updatedAt: now } },
        { returnDocument: "after" },
      );
      if (!after) throw new AppError("CONFLICT", "This offer changed. Try again.");
      await touchQuote(database, after);
      await writeAudit(database, {
        actor: actorOf(request),
        scope: { module: "gigs", businessId: q.businessId },
        action: "gig_quote.withdraw",
        target: { type: "gig_quote", id: q._id },
        diff: { status: { from: "open", to: "withdrawn" } },
        ip: request.ip,
      });
      return ok(request, view(after));
    },
  );
};

export default desk;
