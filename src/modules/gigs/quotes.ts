import type { Static } from "typebox";
import { ObjectId, type ClientSession, type WithId } from "mongodb";
import type { BusinessDoc, Database, GigQuoteDoc, GigsRules } from "../../platform/db.js";
import { stamp } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { isModuleLive } from "../../platform/module-switch.js";
import { rupees } from "../pod/orders.js";
import type { QuoteCard, SendQuote } from "../social/chat-contracts.js";
import { wake } from "../social/chat-live.js";
import { DAY_MS, gigsSettings } from "./rules.js";

const invalid = (path: string, message: string) => new AppError("VALIDATION_FAILED", message, [{ path, message }]);

/** What a quote's card says now: an open one past its days reads as expired before the sweep gets to it. */
export const quoteStatus = (q: Pick<GigQuoteDoc, "status" | "expiresAt">, now = Date.now()): GigQuoteDoc["status"] =>
  q.status === "open" && q.expiresAt.getTime() <= now ? "expired" : q.status;

export function quoteCard(q: WithId<GigQuoteDoc>, viewer: ObjectId, now = Date.now()): QuoteCard {
  const status = quoteStatus(q, now);
  const customer = q.customerId.equals(viewer);
  return {
    id: q._id.toHexString(),
    status,
    title: q.title,
    description: q.description,
    category: q.category,
    price: q.price,
    deliveryDays: q.deliveryDays,
    revisions: q.revisions,
    expiresAt: q.expiresAt.toISOString(),
    freelancer: { businessId: q.businessId.toHexString(), name: q.businessName },
    orderId: customer && q.orderId ? q.orderId.toHexString() : null,
    canPay: customer && status === "open",
    canWithdraw: q.vendorId.equals(viewer) && status === "open",
  };
}

export async function quoteCards(db: Database, ids: ObjectId[], viewer: ObjectId): Promise<Map<string, QuoteCard>> {
  if (!ids.length) return new Map();
  const docs = await db.gigQuotes.find({ _id: { $in: ids } }).toArray();
  const now = Date.now();
  return new Map(docs.map((q) => [q._id.toHexString(), quoteCard(q, viewer, now)]));
}

/** The price, days and revisions of a package or an offer, against Ruxstar's limits. */
export function termsProblem(
  terms: { price: number; deliveryDays: number; revisions: number },
  rules: Pick<GigsRules, "minPrice" | "maxPrice" | "minDays" | "maxDays" | "maxRevisions">,
  path: string,
): AppError | null {
  if (terms.price < rules.minPrice || terms.price > rules.maxPrice) {
    return invalid(`${path}/price`, `The price must be from ${rupees(rules.minPrice)} to ${rupees(rules.maxPrice)}.`);
  }
  if (terms.deliveryDays < rules.minDays || terms.deliveryDays > rules.maxDays) {
    return invalid(`${path}/deliveryDays`, `Delivery must be in ${rules.minDays} to ${rules.maxDays} days.`);
  }
  if (terms.revisions > rules.maxRevisions) return invalid(`${path}/revisions`, `Up to ${rules.maxRevisions} revisions.`);
  return null;
}

/** The freelancer profile of someone who can sell: live module, not on hold, verified. */
export async function sellingProfile(db: Database, userId: ObjectId): Promise<WithId<BusinessDoc>> {
  if (!(await isModuleLive(db, "gigs"))) throw new AppError("MODULE_OFF");
  const [business, user] = await Promise.all([
    db.businesses.findOne({ ownerId: userId, module: "gigs" }),
    db.users.findOne({ _id: userId }, { projection: { kyc: 1 } }),
  ]);
  if (!business) throw new AppError("FORBIDDEN", "Start freelancing first: POST /v1/gigs/me.");
  if (business.suspension) throw new AppError("BUSINESS_SUSPENDED");
  if (user?.kyc.base !== "approved") throw new AppError("KYC_REQUIRED", "Get verified to sell as a freelancer.");
  return business;
}

/** Checks a custom offer before it is sent; `saveQuote` writes it with its message. */
export async function draftQuote(
  db: Database,
  input: { senderId: ObjectId; customerId: ObjectId; conversationId: ObjectId; body: Static<typeof SendQuote> },
): Promise<GigQuoteDoc> {
  const business = await sellingProfile(db, input.senderId);
  const rules = await gigsSettings(db);
  const { body } = input;
  const category = rules.categories.find((c) => c.key === body.category && !c.hidden);
  if (!category) throw invalid("body/category", "Pick one of the categories.");
  const problem = termsProblem(body, rules, "body");
  if (problem) throw problem;
  const now = new Date();
  return {
    _id: new ObjectId(),
    conversationId: input.conversationId,
    messageId: new ObjectId(),
    businessId: business._id,
    vendorId: input.senderId,
    businessName: business.name,
    customerId: input.customerId,
    title: body.title.trim(),
    description: body.description.trim(),
    category: category.key,
    price: body.price,
    deliveryDays: body.deliveryDays,
    revisions: body.revisions,
    status: "open",
    expiresAt: new Date(now.getTime() + rules.quoteDays * DAY_MS),
    orderId: null,
    withdrawnAt: null,
    ...stamp(now),
  };
}

export const saveQuote = async (db: Database, quote: GigQuoteDoc, session: ClientSession) => {
  await db.gigQuotes.insertOne(quote, { session });
};

/** The offer's card changed: open chats pick its message up in `updated`. */
export async function touchQuote(db: Database, quote: Pick<GigQuoteDoc, "messageId" | "conversationId">, session?: ClientSession): Promise<void> {
  const now = new Date();
  await db.chatMessages.updateOne({ _id: quote.messageId }, { $set: { touchedAt: now } }, { session });
  await db.conversations.updateOne({ _id: quote.conversationId }, { $set: { pulseAt: now } }, { session });
  wake(quote.conversationId);
}

/** Open offers past their days read as expired; this writes it down so lists and the console agree. */
export async function expireQuotes(db: Database, now = new Date()): Promise<number> {
  let expired = 0;
  for (const quote of await db.gigQuotes.find({ status: "open", expiresAt: { $lte: now } }).limit(200).toArray()) {
    const res = await db.gigQuotes.updateOne({ _id: quote._id, status: "open" }, { $set: { status: "expired", updatedAt: now } });
    if (!res.modifiedCount) continue;
    await touchQuote(db, quote);
    expired++;
  }
  return expired;
}
