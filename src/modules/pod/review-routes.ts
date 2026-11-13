import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { isModuleLive } from "../../platform/module-switch.js";
import { findPage } from "../../platform/pagination.js";
import { Done, MyReviewOne, ReviewBody, ReviewList, ReviewParams, ReviewReportBody, ShopReviewsQuery } from "../reviews/contracts.js";
import { authorsOf, deleteReview, myReviewView, reviewView, writeReview } from "../reviews/reviews.js";
import { OrderParams, ShopParams } from "./contracts.js";
import { applyDue } from "./order-rules.js";
import { visibleShops } from "./shops.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const limit = (perMinutes: number, max: number) => ({ rateLimit: { max, timeWindow: perMinutes * 60_000 } });

/** Customers rate the shops they ordered from, one review per delivered order, and read other customers' reviews. */
const reviews: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  const mine = async (userId: ObjectId, id: string) => {
    const doc = await db().podOrders.findOne({ _id: new ObjectId(id), customerId: userId });
    if (!doc) throw new AppError("NOT_FOUND", "Order not found.");
    return applyDue(app, db(), doc);
  };

  app.get(
    "/orders/:id/review",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["pod"],
        summary: "Your review of one of your orders",
        description: "Null until you review it. One Ruxstar removed comes back with its reason; it can't be changed or written again.",
        params: OrderParams,
        response: { 200: MyReviewOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const order = await mine(request.auth!.userId, request.params.id);
      const doc = await db().podReviews.findOne({ orderId: order._id });
      return ok(request, doc ? myReviewView(doc, await authorsOf(db(), [doc])) : null);
    },
  );

  app.put(
    "/orders/:id/review",
    {
      preHandler: requireAuth,
      config: limit(60, 30),
      schema: {
        tags: ["pod"],
        summary: "Review an order, or change your review",
        description:
          "Once it's delivered and for 30 days after: 1 to 5 stars and, if you like, a few words. Orders cancelled or refunded in full can't be reviewed. " +
          "Leaving out `text` keeps what you wrote; null or blank clears it. The shop is told about a new review.",
        params: OrderParams,
        body: ReviewBody,
        response: { 200: MyReviewOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const order = await mine(request.auth!.userId, request.params.id);
      const doc = await writeReview(db(), order, request.body, { actor: actorOf(request), ip: request.ip, log: request.log });
      return ok(request, myReviewView(doc, await authorsOf(db(), [doc])));
    },
  );

  app.delete(
    "/orders/:id/review",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["pod"],
        summary: "Delete your review of an order",
        description: "You can review the order again while it is still open for reviews.",
        params: OrderParams,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const order = await mine(request.auth!.userId, request.params.id);
      await deleteReview(db(), order, { actor: actorOf(request), ip: request.ip });
      return ok(request, { done: true as const });
    },
  );

  app.get(
    "/shops/:id/reviews",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["pod"],
        summary: "A print shop's reviews, newest first",
        description: "The shop's rating is on the shop itself.",
        params: ShopParams,
        querystring: ShopReviewsQuery,
        response: { 200: ReviewList, ...Errors },
        security,
      },
    },
    async (request) => {
      const shop = await db().businesses.findOne({ ...visibleShops, _id: new ObjectId(request.params.id) }, { projection: { _id: 1 } });
      if (!shop || !(await isModuleLive(db(), "pod"))) throw new AppError("NOT_FOUND", "This shop is not on Ruxstar right now.");
      const { items, nextCursor } = await findPage(db().podReviews, {
        filter: { shopId: shop._id, status: "live" },
        sortField: "createdAt",
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      const people = await authorsOf(db(), items);
      return page(
        request,
        items.map((r) => reviewView(r, people)),
        nextCursor,
      );
    },
  );

  app.post(
    "/reviews/:id/report",
    {
      preHandler: requireAuth,
      config: limit(60, 20),
      schema: {
        tags: ["pod"],
        summary: "Report a review to Ruxstar",
        description: "One open report per review you report; reporting it again while it is open changes nothing. The writer isn't told.",
        params: ReviewParams,
        body: ReviewReportBody,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const review = await db().podReviews.findOne({ _id: new ObjectId(request.params.id), status: "live" }, { projection: { customerId: 1 } });
      if (!review) throw new AppError("NOT_FOUND", "Review not found.");
      if (review.customerId.equals(userId)) {
        throw new AppError("VALIDATION_FAILED", "You can't report your own review.", [{ path: "params/id", message: "That is yours" }]);
      }
      await db().reviewReports.updateOne(
        { reviewId: review._id, reporterId: userId, status: "open" },
        { $setOnInsert: { reason: request.body.reason, note: request.body.note?.trim() || null, createdAt: new Date() } },
        { upsert: true },
      );
      return ok(request, { done: true as const });
    },
  );
};

export default reviews;
