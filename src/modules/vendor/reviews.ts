import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireDatabase } from "../../platform/context.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { findPage } from "../../platform/pagination.js";
import { BusinessReviewParams, ReplyBody, ShopReviewList, ShopReviewOne, ShopReviewsQuery } from "../reviews/contracts.js";
import { authorsOf, removeReply, replyTo, shopReview, shopReviewView } from "../reviews/reviews.js";
import { BusinessParams } from "./contracts.js";
import { ownedBy, requireVendor } from "./businesses.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

/** What customers said about a vendor's print shops, and the shop's replies. */
const reviews: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  async function owned(request: FastifyRequest, id: string, { editing = true } = {}) {
    const doc = await db().businesses.findOne(ownedBy(new ObjectId(id), request.auth!.userId));
    if (!doc) throw new AppError("NOT_FOUND", "Business not found.");
    if (editing && doc.suspension) throw new AppError("BUSINESS_SUSPENDED");
    return doc;
  }

  const answer = async (id: ObjectId) => {
    const doc = (await db().podReviews.findOne({ _id: id }))!;
    return shopReviewView(doc, await authorsOf(db(), [doc]));
  };

  app.get(
    "/businesses/:id/reviews",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Your shop's reviews, newest first",
        description: "Reviews Ruxstar removed aren't listed. The rating is on the business.",
        params: BusinessParams,
        querystring: ShopReviewsQuery,
        response: { 200: ShopReviewList, ...Errors },
        security,
      },
    },
    async (request) => {
      const shop = await owned(request, request.params.id, { editing: false });
      const { items, nextCursor } = await findPage(db().podReviews, {
        filter: { shopId: shop._id, status: "live" },
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
    "/businesses/:id/reviews/:reviewId/reply",
    {
      preHandler: requireVendor,
      config: { rateLimit: { max: 60, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Reply to a review, or change your reply",
        description: "Everyone sees the reply under the review. The customer is told the first time.",
        params: BusinessReviewParams,
        body: ReplyBody,
        response: { 200: ShopReviewOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const shop = await owned(request, request.params.id);
      const review = await shopReview(db(), shop._id, request.params.reviewId);
      await replyTo(db(), review, request.body.text, {
        actor: actorOf(request),
        ip: request.ip,
        log: request.log,
        by: request.auth!.userId,
        shopName: shop.name,
      });
      return ok(request, await answer(review._id));
    },
  );

  app.delete(
    "/businesses/:id/reviews/:reviewId/reply",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Take down your reply to a review",
        params: BusinessReviewParams,
        response: { 200: ShopReviewOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const shop = await owned(request, request.params.id);
      const review = await shopReview(db(), shop._id, request.params.reviewId);
      await removeReply(db(), review, { actor: actorOf(request), ip: request.ip });
      return ok(request, await answer(review._id));
    },
  );
};

export default reviews;
