import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { publicCache, requireAuth, signedInIfPossible } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { Database, ReviewDoc, ReviewModule } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { findPage } from "../../platform/pagination.js";
import { Done, MyReviewOne, ReviewBody, ReviewList, ReviewParams, ReviewReportBody, ShopReviewsQuery } from "./contracts.js";
import { authorsOf, deleteReview, myReviewView, reportReview, reviewView, writeReview, type Reviewable } from "./reviews.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const signedInOrNot: Record<string, string[]>[] = [{}, { bearer: [] }, { cookie: [] }];
const limit = (perMinutes: number, max: number) => ({ rateLimit: { max, timeWindow: perMinutes * 60_000 } });

/** How a module plugs into reviews. */
export interface ReviewSource {
  module: ReviewModule;
  /** The OpenAPI tag, usually the module's. */
  tag: string;
  /** What its orders are called to customers: "booking", "enrolment". */
  noun: string;
  /** When its orders open for a review, in a sentence for the route docs. */
  rule: string;
  /** The signed-in customer's own order, described for reviews; NOT_FOUND when it isn't theirs. */
  order: (app: FastifyInstance, db: Database, userId: ObjectId, id: string) => Promise<Reviewable>;
  /** The listing customers read reviews of, by its id: whether it is public now. */
  listing: { type: NonNullable<ReviewDoc["listing"]>["type"]; label: string; visible: (db: Database, id: ObjectId) => Promise<boolean> };
}

/**
 * A module's customer review routes, mounted under its prefix: the customer's review of an order (read, write or change,
 * delete), a listing's reviews for anyone, and reporting a review. Replies and Ruxstar's moderation are shared already.
 */
export function reviewRoutes(source: ReviewSource): FastifyPluginAsyncTypebox {
  return async (app) => {
    const db = () => requireDatabase(app.db);
    const tags = [source.tag];

    app.get(
      "/orders/:id/review",
      {
        preHandler: requireAuth,
        schema: {
          tags,
          summary: `Your review of one of your ${source.noun}s`,
          description: "Null until you review it. One Ruxstar removed comes back with its reason; it can't be changed or written again.",
          params: ReviewParams,
          response: { 200: MyReviewOne, ...Errors },
          security,
        },
      },
      async (request) => {
        const item = await source.order(app, db(), request.auth!.userId, request.params.id);
        const doc = await db().reviews.findOne({ orderId: item.orderId });
        return ok(request, doc ? myReviewView(doc, await authorsOf(db(), [doc])) : null);
      },
    );

    app.put(
      "/orders/:id/review",
      {
        preHandler: requireAuth,
        config: limit(60, 30),
        schema: {
          tags,
          summary: `Review a ${source.noun}, or change your review`,
          description:
            `${source.rule} 1 to 5 stars and, if you like, a few words; one review per ${source.noun}. ` +
            "Leaving out `text` keeps what you wrote; null or blank clears it. The business is told about a new review.",
          params: ReviewParams,
          body: ReviewBody,
          response: { 200: MyReviewOne, ...Errors },
          security,
        },
      },
      async (request) => {
        const item = await source.order(app, db(), request.auth!.userId, request.params.id);
        const doc = await writeReview(db(), item, request.body, { actor: actorOf(request), ip: request.ip, log: request.log });
        return ok(request, myReviewView(doc, await authorsOf(db(), [doc])));
      },
    );

    app.delete(
      "/orders/:id/review",
      {
        preHandler: requireAuth,
        schema: {
          tags,
          summary: `Delete your review of a ${source.noun}`,
          description: `You can review the ${source.noun} again while it is still open for reviews.`,
          params: ReviewParams,
          response: { 200: Done, ...Errors },
          security,
        },
      },
      async (request) => {
        const item = await source.order(app, db(), request.auth!.userId, request.params.id);
        await deleteReview(db(), item.orderId, { actor: actorOf(request), ip: request.ip });
        return ok(request, { done: true as const });
      },
    );

    app.get(
      "/:id/reviews",
      {
        preHandler: signedInIfPossible,
        schema: {
          tags,
          summary: `A ${source.listing.label}'s reviews, newest first`,
          description: "No sign-in needed. The business's rating covers all its reviews and is on the detail.",
          params: ReviewParams,
          querystring: ShopReviewsQuery,
          response: { 200: ReviewList, ...Errors },
          security: signedInOrNot,
        },
      },
      async (request, reply) => {
        const id = new ObjectId(request.params.id);
        if (!(await source.listing.visible(db(), id))) throw new AppError("NOT_FOUND", `This ${source.listing.label} isn't on Ruxstar.`);
        const { items, nextCursor } = await findPage(db().reviews, {
          filter: { "listing.id": id, status: "live" },
          sortField: "createdAt",
          cursor: request.query.cursor,
          limit: request.query.limit,
        });
        const people = await authorsOf(db(), items);
        publicCache(request, reply);
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
          tags,
          summary: "Report a review to Ruxstar",
          description: "One open report per review you report; reporting it again while it is open changes nothing. The writer isn't told.",
          params: ReviewParams,
          body: ReviewReportBody,
          response: { 200: Done, ...Errors },
          security,
        },
      },
      async (request) => {
        await reportReview(db(), request.auth!.userId, request.params.id, request.body);
        return ok(request, { done: true as const });
      },
    );
  };
}
