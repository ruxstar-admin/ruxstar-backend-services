import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import type { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import { ok, page } from "../../platform/envelope.js";
import { findPage } from "../../platform/pagination.js";
import { BusinessReviewParams, ReplyBody, ShopReviewList, ShopReviewOne, ShopReviewsQuery } from "../reviews/contracts.js";
import { authorsOf, removeReply, replyTo, shopReview, shopReviewView } from "../reviews/reviews.js";
import { WorkParams } from "../team/contracts.js";
import { teamAccess } from "../team/team.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

/** The reviews of the shop someone works at, for those the owner lets reply. */
const reviews: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const at = (request: FastifyRequest, placeId: string) => teamAccess(db(), request.auth!, { placeId }, "reviews.reply");
  const answer = async (id: ObjectId) => {
    const doc = (await db().podReviews.findOne({ _id: id }))!;
    return shopReviewView(doc, await authorsOf(db(), [doc]));
  };

  app.get(
    "/:id/reviews",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["employment"],
        summary: "The shop's reviews, newest first",
        description: 'Needs "Reply to reviews".',
        params: WorkParams,
        querystring: ShopReviewsQuery,
        response: { 200: ShopReviewList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { business } = await at(request, request.params.id);
      const { items, nextCursor } = await findPage(db().podReviews, {
        filter: { shopId: business._id, status: "live" },
        sortField: "createdAt",
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      const people = await authorsOf(db(), items);
      return page(
        request,
        items.map((r) => shopReviewView(r, people)),
        nextCursor,
      );
    },
  );

  app.put(
    "/:id/reviews/:reviewId/reply",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["employment"],
        summary: "Reply to a review for the shop, or change the reply",
        description: 'Needs "Reply to reviews". The reply is the shop\'s, so anyone allowed can change it. The customer is told the first time.',
        params: BusinessReviewParams,
        body: ReplyBody,
        response: { 200: ShopReviewOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { business } = await at(request, request.params.id);
      const review = await shopReview(db(), business._id, request.params.reviewId);
      await replyTo(db(), review, request.body.text, {
        actor: actorOf(request),
        ip: request.ip,
        log: request.log,
        by: request.auth!.userId,
        shopName: business.name,
      });
      return ok(request, await answer(review._id));
    },
  );

  app.delete(
    "/:id/reviews/:reviewId/reply",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["employment"],
        summary: "Take down the shop's reply to a review",
        description: 'Needs "Reply to reviews".',
        params: BusinessReviewParams,
        response: { 200: ShopReviewOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { business } = await at(request, request.params.id);
      const review = await shopReview(db(), business._id, request.params.reviewId);
      await removeReply(db(), review, { actor: actorOf(request), ip: request.ip });
      return ok(request, await answer(review._id));
    },
  );
};

export default reviews;
