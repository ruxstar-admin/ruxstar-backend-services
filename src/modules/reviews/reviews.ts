import type { FastifyBaseLogger } from "fastify";
import { ObjectId, type WithId } from "mongodb";
import { writeAudit } from "../../platform/audit.js";
import { stamp, type AuditLogDoc, type BusinessDoc, type Database, type PodOrderDoc, type PodReviewDoc, type UserDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { notifyReview } from "../notifications/notify.js";
import { RATING_MIN_REVIEWS, REVIEW_DAYS, type MyReview, type Rating, type Review, type ShopReview } from "./contracts.js";

const DAY_MS = 24 * 60 * 60_000;

interface Ctx {
  actor: AuditLogDoc["actor"];
  ip: string | null;
  log: FastifyBaseLogger;
}

/**
 * The last moment the customer can write or change their review: 30 days after delivery. Null when the order can't be reviewed
 * (not delivered yet, cancelled, turned down or refunded in full) or it is too late.
 */
export function reviewUntil(order: Pick<PodOrderDoc, "status" | "deliveredAt">, now = Date.now()): Date | null {
  if (order.status !== "delivered" || !order.deliveredAt) return null;
  const until = new Date(order.deliveredAt.getTime() + REVIEW_DAYS * DAY_MS);
  return now <= until.getTime() ? until : null;
}

export function ratingOf(doc: Pick<BusinessDoc, "rating">): Rating {
  const count = doc.rating?.count ?? 0;
  return { average: count >= RATING_MIN_REVIEWS ? Math.round((doc.rating!.sum / count) * 10) / 10 : null, count };
}

/** Counts the shop's live reviews again, so the rating never drifts from them. */
export async function refreshRating(db: Database, shopId: ObjectId): Promise<void> {
  const [row] = await db.podReviews
    .aggregate<{ count: number; sum: number }>([{ $match: { shopId, status: "live" } }, { $group: { _id: null, count: { $sum: 1 }, sum: { $sum: "$rating" } } }])
    .toArray();
  await db.businesses.updateOne({ _id: shopId }, { $set: { rating: { count: row?.count ?? 0, sum: row?.sum ?? 0 } } });
}

type Person = Pick<UserDoc, "_id" | "name" | "username" | "avatar">;
export type People = Map<string, Person>;

export async function authorsOf(db: Database, reviews: Pick<PodReviewDoc, "customerId">[]): Promise<People> {
  const users = await db.users
    .find({ _id: { $in: reviews.map((r) => r.customerId) } }, { projection: { name: 1, username: 1, avatar: 1 } })
    .toArray();
  return new Map(users.map((u) => [u._id.toHexString(), u]));
}

const iso = (at: Date | null | undefined) => at?.toISOString() ?? null;

export function reviewView(doc: PodReviewDoc, people: People): Review {
  const user = people.get(doc.customerId.toHexString());
  return {
    id: doc._id.toHexString(),
    rating: doc.rating,
    text: doc.text,
    product: doc.productLabel,
    author: user ? { id: user._id.toHexString(), name: user.name || "Someone", username: user.username ?? null, avatarUrl: user.avatar ?? null } : null,
    reply: doc.reply ? { text: doc.reply.text, at: doc.reply.at.toISOString(), editedAt: iso(doc.reply.editedAt) } : null,
    createdAt: doc.createdAt.toISOString(),
    editedAt: iso(doc.editedAt),
  };
}

export const shopReviewView = (doc: PodReviewDoc, people: People): ShopReview => ({
  ...reviewView(doc, people),
  orderId: doc.orderId.toHexString(),
  orderNo: doc.orderNo,
});

export const myReviewView = (doc: PodReviewDoc, people: People): MyReview => ({
  ...reviewView(doc, people),
  orderId: doc.orderId.toHexString(),
  status: doc.status,
  removedReason: doc.removal?.reason ?? null,
});

const audit = (db: Database, review: Pick<PodReviewDoc, "orderId" | "shopId">, action: string, ctx: Pick<Ctx, "actor" | "ip">, diff: AuditLogDoc["diff"]) =>
  writeAudit(db, { actor: ctx.actor, scope: { module: "pod", businessId: review.shopId }, action, target: { type: "pod_order", id: review.orderId }, diff, ip: ctx.ip });

const cleanText = (text: string | null | undefined) => text?.trim() || null;
const removedError = () => new AppError("CONFLICT", "Ruxstar removed your review of this order, so it can't be changed.");

/** Writes the customer's review of their order, or changes it. Writing the same thing again changes nothing. */
export async function writeReview(db: Database, order: PodOrderDoc, input: { rating: number; text?: string | null | undefined }, ctx: Ctx): Promise<PodReviewDoc> {
  if (!reviewUntil(order)) {
    throw new AppError(
      "ORDER_STATE",
      order.status === "delivered" ? `Reviews close ${REVIEW_DAYS} days after delivery.` : "You can review an order once it's delivered.",
    );
  }
  const text = input.text === undefined ? undefined : cleanText(input.text);
  const now = new Date();
  const existing = await db.podReviews.findOne({ orderId: order._id });
  if (existing) {
    if (existing.status === "removed") throw removedError();
    const nextText = text === undefined ? existing.text : text;
    if (existing.rating === input.rating && existing.text === nextText) return existing;
    const after = await db.podReviews.findOneAndUpdate(
      { _id: existing._id, status: "live" },
      { $set: { rating: input.rating, text: nextText, editedAt: now, updatedAt: now } },
      { returnDocument: "after" },
    );
    if (!after) throw removedError();
    const diff: AuditLogDoc["diff"] = {};
    if (existing.rating !== input.rating) diff.rating = { from: existing.rating, to: input.rating };
    if (existing.text !== nextText) diff.text = { from: existing.text, to: nextText };
    await audit(db, existing, "review.update", ctx, diff);
    await refreshRating(db, existing.shopId);
    return after;
  }

  const doc: PodReviewDoc = {
    _id: new ObjectId(),
    orderId: order._id,
    orderNo: order.orderNo,
    shopId: order.shopId,
    vendorId: order.vendorId,
    customerId: order.customerId,
    productLabel: order.productLabel,
    rating: input.rating,
    text: text ?? null,
    status: "live",
    editedAt: null,
    reply: null,
    ...stamp(now),
  };
  try {
    await db.podReviews.insertOne(doc);
  } catch (err) {
    // Sent twice at once: the other one wrote it, so this one changes it.
    if ((err as { code?: number }).code === 11000) return writeReview(db, order, input, ctx);
    throw err;
  }
  await audit(db, doc, "review.create", ctx, { rating: { from: null, to: doc.rating }, ...(doc.text ? { text: { from: null, to: doc.text } } : {}) });
  await refreshRating(db, doc.shopId);
  await tellShop(db, doc, order.shopName, ctx.log);
  return doc;
}

/** The owner, and team members who may reply and are verified, hear about a new review. */
async function tellShop(db: Database, review: PodReviewDoc, shopName: string, log: FastifyBaseLogger) {
  const stars = `${review.rating} star${review.rating === 1 ? "" : "s"}`;
  const body = `${stars} for order #${review.orderNo}${review.text ? `: ${review.text}` : "."}`;
  await notifyReview(db, log, { to: review.vendorId, actor: review.customerId, type: "review.posted", title: "New review", body, link: { screen: "reviews", id: review.shopId.toHexString() } });
  const places = await db.employments
    .find({ businessId: review.shopId, status: "active", current: true, permissions: "reviews.reply" }, { projection: { userId: 1 } })
    .toArray();
  if (!places.length) return;
  const verified = await db.users
    .find({ _id: { $in: places.map((p) => p.userId) }, status: "active", "kyc.base": "approved" }, { projection: { _id: 1 } })
    .toArray();
  for (const place of places.filter((p) => verified.some((u) => u._id.equals(p.userId)))) {
    await notifyReview(db, log, {
      to: place.userId,
      actor: review.customerId,
      type: "review.posted",
      title: `New review at ${shopName}`,
      body,
      link: { screen: "work_reviews", id: place._id.toHexString() },
    });
  }
}

/** The customer takes their review down. One Ruxstar removed stays, so it can't be written again. */
export async function deleteReview(db: Database, order: PodOrderDoc, ctx: Pick<Ctx, "actor" | "ip">): Promise<void> {
  const existing = await db.podReviews.findOne({ orderId: order._id });
  if (!existing) throw new AppError("NOT_FOUND", "You haven't reviewed this order.");
  if (existing.status === "removed") throw removedError();
  const res = await db.podReviews.deleteOne({ _id: existing._id, status: "live" });
  if (res.deletedCount === 0) throw removedError();
  await db.reviewReports.deleteMany({ reviewId: existing._id });
  await audit(db, existing, "review.delete", ctx, { rating: { from: existing.rating, to: null } });
  await refreshRating(db, existing.shopId);
}

/** A live review at the shop. */
export async function shopReview(db: Database, shopId: ObjectId, reviewId: string): Promise<WithId<PodReviewDoc>> {
  const doc = await db.podReviews.findOne({ _id: new ObjectId(reviewId), shopId, status: "live" });
  if (!doc) throw new AppError("NOT_FOUND", "Review not found.");
  return doc;
}

/** The shop answers a review, or changes its answer. The customer is told the first time. */
export async function replyTo(db: Database, review: PodReviewDoc, text: string, ctx: Ctx & { by: ObjectId; shopName: string }): Promise<PodReviewDoc> {
  const clean = text.trim();
  if (clean.length < 2) throw new AppError("VALIDATION_FAILED", "Write a reply.", [{ path: "body/text", message: "Too short" }]);
  if (review.reply?.text === clean) return review;
  const now = new Date();
  const reply = review.reply ? { ...review.reply, text: clean, editedAt: now } : { text: clean, by: ctx.by, at: now, editedAt: null };
  const after = await db.podReviews.findOneAndUpdate({ _id: review._id, status: "live" }, { $set: { reply, updatedAt: now } }, { returnDocument: "after" });
  if (!after) throw new AppError("NOT_FOUND", "Review not found.");
  await audit(db, review, "review.reply", ctx, { reply: { from: review.reply?.text ?? null, to: clean } });
  if (!review.reply) {
    await notifyReview(db, ctx.log, {
      to: review.customerId,
      actor: ctx.by,
      type: "review.replied",
      title: `${ctx.shopName} replied to your review`,
      body: clean,
      link: { screen: "order", id: review.orderId.toHexString() },
    });
  }
  return after;
}

export async function removeReply(db: Database, review: PodReviewDoc, ctx: Pick<Ctx, "actor" | "ip">): Promise<PodReviewDoc> {
  if (!review.reply) throw new AppError("CONFLICT", "There's no reply to remove.");
  const after = await db.podReviews.findOneAndUpdate(
    { _id: review._id, status: "live" },
    { $set: { reply: null, updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!after) throw new AppError("NOT_FOUND", "Review not found.");
  await audit(db, review, "review.reply_delete", ctx, { reply: { from: review.reply.text, to: null } });
  return after;
}
