import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import type { Database, SupportCategory, SupportMessageDoc, SupportPriority, SupportTicketDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { apiOrigin, signingKey } from "../pod/orders.js";
import { REOPEN_DAYS, type SlaHours, type SupportMessage, type Ticket, type TicketDetail } from "./contracts.js";

const HOUR_MS = 60 * 60_000;
export const SLA_SETTING = "support.sla";
/** The reply-by times until the Ruxstar admin changes them. */
export const DEFAULT_SLA_HOURS: SlaHours = { urgent: 2, high: 8, normal: 24, low: 72 };
/** Tickets are numbered from here, so the first reads RX-1001. */
const FIRST_NUMBER = 1000;

export const ticketNumber = (no: number) => `RX-${no}`;
export const nextTicketNo = async (db: Database, session?: Parameters<Database["nextNumber"]>[1]) =>
  FIRST_NUMBER + (await db.nextNumber("support-ticket", session));

/** Refunds and safety start ahead of the rest. */
export const startingPriority = (category: SupportCategory): SupportPriority => (category === "refunds" || category === "safety" ? "high" : "normal");

export async function slaHours(db: Database): Promise<SlaHours & { updatedAt: Date | null }> {
  const doc = await db.platformSettings.findOne({ key: SLA_SETTING });
  return { ...DEFAULT_SLA_HOURS, ...(doc?.value as Partial<SlaHours> | undefined), updatedAt: doc?.updatedAt ?? null };
}

export const dueAt = (since: Date | null, priority: SupportPriority, hours: SlaHours) =>
  since ? new Date(since.getTime() + hours[priority] * HOUR_MS) : null;

export const reopenUntil = (at: Date) => new Date(at.getTime() + REOPEN_DAYS * 24 * HOUR_MS);

export const statusOf = (doc: Pick<SupportTicketDoc, "status" | "reopenUntil">, now = new Date()) =>
  doc.status === "resolved" && doc.reopenUntil && doc.reopenUntil <= now ? ("closed" as const) : doc.status;

// Photo links: short-lived and signed, so an image tag can open them without the API's headers.

const LINK_SECONDS = 10 * 60;
const signature = (key: Uint8Array, ticketId: string, photoId: string, exp: number) =>
  createHmac("sha256", key).update(`support.${ticketId}.${photoId}.${exp}`).digest("base64url");

export type SupportPhotoLinks = (ticketId: string, photoId: string) => string;

/** Signs links to a ticket's photos for one response. Only views for its customer or Ruxstar staff get one. */
export function supportPhotoLinks(app: FastifyInstance, request: { protocol: string; host: string }): SupportPhotoLinks {
  const key = signingKey(app);
  const origin = apiOrigin(app, request);
  const exp = Math.floor(Date.now() / 1000) + LINK_SECONDS;
  return (ticketId, photoId) =>
    `${origin}/support-photos/${ticketId}/${photoId}?${new URLSearchParams({ exp: String(exp), t: signature(key, ticketId, photoId, exp) }).toString()}`;
}

export function supportPhotoLinkValid(key: Uint8Array, ticketId: string, photoId: string, exp: number, token: string): boolean {
  if (!Number.isInteger(exp) || exp * 1000 < Date.now()) return false;
  const expected = Buffer.from(signature(key, ticketId, photoId, exp));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const supportPhotoKey = (ticketId: ObjectId, photoId: ObjectId) => `support/${ticketId.toHexString()}/${photoId.toHexString()}.jpg`;

// What a ticket is about.

const oid = (id: string) => {
  if (!ObjectId.isValid(id) || id.length !== 24) throw new AppError("VALIDATION_FAILED", "That link isn't right.", [{ path: "body/context/id", message: "Invalid id" }]);
  return new ObjectId(id);
};
const notYours = (what: string) => new AppError("NOT_FOUND", `We couldn't find that ${what} on your account.`);

/** Checks the thing a ticket is about belongs to the person (any post will do, for reports) and names it. */
export async function resolveContext(
  db: Database,
  userId: ObjectId,
  context: { type: NonNullable<SupportTicketDoc["context"]>["type"]; id: string },
): Promise<NonNullable<SupportTicketDoc["context"]>> {
  switch (context.type) {
    case "order": {
      const order = await db.podOrders.findOne({ _id: oid(context.id), $or: [{ customerId: userId }, { vendorId: userId }] }, { projection: { orderNo: 1 } });
      if (!order) throw notYours("order");
      return { type: "order", id: context.id, label: `Order #${order.orderNo}` };
    }
    case "business": {
      const business = await db.businesses.findOne({ _id: oid(context.id), ownerId: userId }, { projection: { name: 1 } });
      if (!business) throw notYours("business");
      return { type: "business", id: context.id, label: business.name };
    }
    case "coupon": {
      const coupon = await db.coupons.findOne({ _id: oid(context.id), vendorId: userId }, { projection: { code: 1 } });
      if (!coupon) throw notYours("coupon");
      return { type: "coupon", id: context.id, label: `Coupon ${coupon.code}` };
    }
    case "post": {
      const post = await db.posts.findOne({ _id: oid(context.id) }, { projection: { authorId: 1 } });
      if (!post) throw new AppError("NOT_FOUND", "We couldn't find that post.");
      const author = await db.users.findOne({ _id: post.authorId }, { projection: { username: 1 } });
      return { type: "post", id: context.id, label: author?.username ? `Post by @${author.username}` : "A post" };
    }
    case "verification": {
      if (context.id !== "base" && context.id !== "delivery") {
        throw new AppError("VALIDATION_FAILED", "Verification is base or delivery.", [{ path: "body/context/id", message: "base or delivery" }]);
      }
      const found = await db.kycCases.findOne({ userId, track: context.id }, { projection: { _id: 1 } });
      if (!found) throw notYours("verification");
      return { type: "verification", id: context.id, label: context.id === "delivery" ? "Delivery verification" : "Identity verification" };
    }
    case "delivery": {
      const job = await db.deliveryJobs.findOne({ _id: oid(context.id), riderId: userId }, { projection: { orderNo: 1 } });
      if (!job) throw notYours("delivery");
      return { type: "delivery", id: context.id, label: `Delivery for Order #${job.orderNo}` };
    }
  }
}

// Views.

const iso = (at: Date | null | undefined) => at?.toISOString() ?? null;

export const unreadFor = (doc: SupportTicketDoc) => doc.lastFrom === "staff" && (!doc.seenAt || doc.seenAt < doc.lastAt);

export const ticketView = (doc: SupportTicketDoc, now = new Date()): Ticket => ({
  id: doc._id.toHexString(),
  number: ticketNumber(doc.ticketNo),
  category: doc.category,
  subject: doc.subject,
  status: statusOf(doc, now),
  context: doc.context,
  createdAt: doc.createdAt.toISOString(),
  lastAt: doc.lastAt.toISOString(),
  resolvedAt: iso(doc.resolvedAt),
  reopenUntil: iso(doc.reopenUntil),
  unread: unreadFor(doc),
});

export const photoViews = (message: SupportMessageDoc, links: SupportPhotoLinks) =>
  message.photos.map((p) => ({ id: p.id.toHexString(), url: links(message.ticketId.toHexString(), p.id.toHexString()) }));

export const customerMessageView = (message: SupportMessageDoc, viewer: ObjectId, links: SupportPhotoLinks): SupportMessage => ({
  id: message._id.toHexString(),
  from: message.from,
  text: message.text,
  photos: photoViews(message, links),
  at: message.at.toISOString(),
  mine: message.authorId.equals(viewer),
});

export const detailView = (doc: SupportTicketDoc, messages: SupportMessageDoc[], viewer: ObjectId, links: SupportPhotoLinks): TicketDetail => ({
  ...ticketView(doc),
  messages: messages.map((m) => customerMessageView(m, viewer, links)),
});

/** Messages the customer may see, oldest first. Long tickets show their latest 200. */
export async function customerMessages(db: Database, ticketId: ObjectId): Promise<SupportMessageDoc[]> {
  const latest = await db.supportMessages.find({ ticketId, internal: false }).sort({ at: -1 }).limit(200).toArray();
  return latest.reverse();
}
