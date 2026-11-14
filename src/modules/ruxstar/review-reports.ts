import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId, type Document } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, writeAudit } from "../../platform/audit.js";
import { requireRuxstar } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { ReviewReportReason } from "../../platform/db.js";
import { page, ok } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { DEFAULT_LIMIT, MAX_LIMIT, decodeCursor, encodeCursor } from "../../platform/pagination.js";
import { notifyReview } from "../notifications/notify.js";
import { RemoveReviewBody, ReviewCaseList, ReviewCaseOne, ReviewCaseParams, type ReviewCase } from "../reviews/contracts.js";
import { authorsOf, refreshRating, reviewView } from "../reviews/reviews.js";
import { ReportsQuery } from "./contracts.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

interface Group {
  _id: ObjectId;
  reports: number;
  reasons: ReviewReportReason[];
  notes: { at: Date; note: string | null }[];
  firstAt: Date;
  lastAt: Date;
  closings: { at?: Date; outcome?: "kept" | "removed" }[];
  key: Date;
}

/** Reported shop reviews, one row per review. Ruxstar keeps a review or removes it with a reason the customer is told. */
const reviewReports: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  async function groups(status: "open" | "closed", match: Document, cursor: string | undefined, limit: number) {
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await db()
      .reviewReports.aggregate<Group>([
        { $match: { status, ...match } },
        {
          $group: {
            _id: "$reviewId",
            reports: { $sum: 1 },
            reasons: { $push: "$reason" },
            notes: { $push: { at: "$createdAt", note: "$note" } },
            firstAt: { $min: "$createdAt" },
            lastAt: { $max: "$createdAt" },
            closings: { $push: { at: "$closedAt", outcome: "$outcome" } },
          },
        },
        { $addFields: { key: status === "open" ? "$lastAt" : { $max: "$closings.at" } } },
        ...(after ? [{ $match: { $or: [{ key: { $lt: after.value } }, { key: after.value, _id: { $lt: after.id } }] } }] : []),
        { $sort: { key: -1, _id: -1 } },
        { $limit: limit + 1 },
      ])
      .toArray();
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items: await present(status, items), nextCursor: rows.length > limit && last ? encodeCursor(last.key, last._id) : null };
  }

  async function present(status: "open" | "closed", rows: Group[]): Promise<ReviewCase[]> {
    const reviews = await db()
      .podReviews.find({ _id: { $in: rows.map((r) => r._id) } })
      .toArray();
    const [people, shops] = await Promise.all([
      authorsOf(db(), reviews),
      db()
        .businesses.find({ _id: { $in: reviews.map((r) => r.shopId) } }, { projection: { name: 1 } })
        .toArray(),
    ]);
    return rows.map((row) => {
      const review = reviews.find((r) => r._id.equals(row._id));
      const shop = review && shops.find((s) => s._id.equals(review.shopId));
      const reasons = { spam: 0, fake: 0, abuse: 0, other: 0 };
      for (const r of row.reasons) reasons[r] = (reasons[r] ?? 0) + 1;
      const latest = row.closings.filter((c) => c.at).sort((a, b) => b.at!.getTime() - a.at!.getTime())[0];
      return {
        reviewId: row._id.toHexString(),
        review: review
          ? {
              ...reviewView(review, people),
              status: review.status,
              shop: { id: review.shopId.toHexString(), name: shop?.name ?? "" },
              orderNo: review.orderNo,
              removal: review.removal ? { reason: review.removal.reason, at: review.removal.at.toISOString() } : null,
            }
          : null,
        status,
        reports: row.reports,
        reasons,
        notes: row.notes
          .filter((n): n is { at: Date; note: string } => Boolean(n.note))
          .sort((a, b) => b.at.getTime() - a.at.getTime())
          .slice(0, 5)
          .map((n) => n.note),
        firstAt: row.firstAt.toISOString(),
        lastAt: row.lastAt.toISOString(),
        outcome: latest?.outcome ?? null,
        closedAt: latest?.at?.toISOString() ?? null,
      };
    });
  }

  const latestCase = async (reviewId: ObjectId) => {
    const { items } = await groups("closed", { reviewId }, undefined, 1);
    if (!items[0]) throw new AppError("NOT_FOUND", "Nothing was reported about this review.");
    return items[0];
  };

  app.get(
    "/reports/reviews",
    {
      preHandler: requireRuxstar("reports.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "Reported shop reviews, one row per review",
        description: "`open` (the default) is waiting for a decision, newest report first. `closed` is decided, newest decision first.",
        querystring: ReportsQuery,
        response: { 200: ReviewCaseList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { status = "open", cursor, limit } = request.query;
      const { items, nextCursor } = await groups(status, {}, cursor, Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT));
      return page(request, items, nextCursor);
    },
  );

  app.post(
    "/reports/reviews/:reviewId/keep",
    {
      preHandler: [requireRuxstar("reports.act"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Close the reports about a review and leave it up",
        params: ReviewCaseParams,
        response: { 200: ReviewCaseOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const reviewId = new ObjectId(request.params.reviewId);
      await database.transaction(async (session) => {
        const { modifiedCount } = await database.reviewReports.updateMany(
          { reviewId, status: "open" },
          { $set: { status: "closed", outcome: "kept", closedBy: request.auth!.userId, closedAt: new Date() } },
          { session },
        );
        if (modifiedCount === 0) throw new AppError("CONFLICT", "Nothing is waiting on this review.");
        await writeAudit(
          database,
          {
            actor: actorOf(request),
            scope: { module: "pod" },
            action: "review_report.keep",
            target: { type: "pod_review", id: reviewId },
            diff: { openReports: { from: modifiedCount, to: 0 } },
            ip: request.ip,
          },
          session,
        );
      });
      return ok(request, await latestCase(reviewId));
    },
  );

  app.post(
    "/reports/reviews/:reviewId/remove",
    {
      preHandler: [requireRuxstar("reports.act"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Take a review down",
        description:
          "It leaves the shop's page and rating, and its open reports close. The customer is told the reason and can't write it again; the shop sees it in Activity.",
        params: ReviewCaseParams,
        body: RemoveReviewBody,
        response: { 200: ReviewCaseOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const reviewId = new ObjectId(request.params.reviewId);
      const reason = request.body.reason.trim();
      const review = await database.podReviews.findOne({ _id: reviewId });
      if (!review) throw new AppError("NOT_FOUND", "The customer deleted this review.");
      if (review.status === "removed") throw new AppError("CONFLICT", "This review is already removed.");
      const now = new Date();
      await database.transaction(async (session) => {
        const res = await database.podReviews.updateOne(
          { _id: reviewId, status: "live" },
          { $set: { status: "removed", removal: { by: request.auth!.userId, reason, at: now }, updatedAt: now } },
          { session },
        );
        if (res.modifiedCount === 0) throw new AppError("CONFLICT", "This review is already removed.");
        await database.reviewReports.updateMany(
          { reviewId, status: "open" },
          { $set: { status: "closed", outcome: "removed", closedBy: request.auth!.userId, closedAt: now } },
          { session },
        );
        await writeAudit(
          database,
          {
            actor: actorOf(request),
            scope: { module: "pod", businessId: review.shopId },
            action: "review.remove",
            target: { type: "pod_order", id: review.orderId },
            diff: { status: { from: "live", to: "removed" }, reason: { from: null, to: reason } },
            ip: request.ip,
          },
          session,
        );
      });
      await refreshRating(database, review.shopId);
      await notifyReview(database, request.log, {
        to: review.customerId,
        actor: request.auth!.userId,
        type: "review.removed",
        title: "Your review was removed",
        body: `Ruxstar removed your review of order #${review.orderNo}: ${reason}`,
        link: { screen: "order", id: review.orderId.toHexString() },
      });
      return ok(request, await latestCase(reviewId));
    },
  );
};

export default reviewReports;
