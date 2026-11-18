import type { FastifyInstance } from "fastify";
import type { ObjectId, WithId } from "mongodb";
import type { BusinessDoc, BusinessPhoto, Database, GigDoc, GigFileRef, GigOrderDoc, UserDoc } from "../../platform/db.js";
import { appliedView } from "../coupons/coupons.js";
import { invoiceRefs } from "../invoices/views.js";
import { REVIEW_DAYS } from "../reviews/contracts.js";
import { eligibility, openUntil, ratingOf, type Reviewable } from "../reviews/reviews.js";
import { gigFileLinks } from "./checkout.js";
import type { GigCard, GigDetail, GigOrder, MyGig } from "./contracts.js";
import { customerCanCancel } from "./orders.js";
import { categoryLabel, daysText, refundedOf, revisionsText, vendorLeftOf, type GigsSettings } from "./rules.js";

type Request = { protocol: string; host: string };
const iso = (at: Date | null | undefined) => at?.toISOString() ?? null;

export const photoView = (p: BusinessPhoto) => ({ id: p.id, url: p.smaller?.at(-1)?.url ?? p.url, width: p.width, height: p.height });
const fullPhoto = (p: BusinessPhoto) => ({ id: p.id, url: p.url, width: p.width, height: p.height });

export const ORDER_RULES =
  "You pay now. The freelancer accepts within a day or you get everything back. Approve the delivery, ask for a revision while the package has them, " +
  "or report a problem and Ruxstar decides. Cancel for a full refund before it's accepted, or once it's late.";

type Owner = Pick<UserDoc, "_id" | "avatar" | "username">;
const avatarOf = (owner: Owner | undefined) => owner?.avatar ?? null;

export async function ownersOf(db: Database, ids: ObjectId[]): Promise<Map<string, Owner>> {
  if (!ids.length) return new Map();
  const users = await db.users.find({ _id: { $in: ids } }, { projection: { avatar: 1, username: 1 } }).toArray();
  return new Map(users.map((u) => [u._id.toHexString(), u]));
}

function cardOf(g: WithId<GigDoc>, business: BusinessDoc | undefined, owner: Owner | undefined, settings: GigsSettings): GigCard {
  return {
    id: g._id.toHexString(),
    title: g.title,
    category: g.category,
    categoryLabel: categoryLabel(settings, g.category),
    photo: g.photos[0] ? photoView(g.photos[0]) : null,
    priceFrom: g.priceFrom,
    fastestDays: Math.min(...g.packages.map((p) => p.deliveryDays)),
    freelancer: {
      businessId: g.businessId.toHexString(),
      userId: g.vendorId.toHexString(),
      username: owner?.username ?? null,
      name: business?.name ?? g.businessName,
      headline: business?.freelancer?.headline ?? "",
      city: business?.freelancer?.city ?? null,
      avatarUrl: avatarOf(owner),
    },
    ...(g.rating ? { rating: ratingOf(g) } : {}),
  };
}

/** Gig cards with their freelancers, in two reads. */
export async function gigCards(db: Database, gigs: WithId<GigDoc>[], settings: GigsSettings): Promise<GigCard[]> {
  if (!gigs.length) return [];
  const businesses = await db.businesses.find({ _id: { $in: gigs.map((g) => g.businessId) } }).toArray();
  const owners = await ownersOf(db, gigs.map((g) => g.vendorId));
  return gigs.map((g) =>
    cardOf(
      g,
      businesses.find((b) => b._id.equals(g.businessId)),
      owners.get(g.vendorId.toHexString()),
      settings,
    ),
  );
}

/** Why a gig can't be ordered right now, or null. */
export function orderProblem(g: GigDoc, business: BusinessDoc | null, settings: Pick<GigsSettings, "live">): string | null {
  if (!settings.live) return "Freelancing isn't on Ruxstar yet.";
  if (!business || business.suspension) return "This freelancer isn't on Ruxstar right now.";
  if (g.status === "paused") return "The freelancer isn't taking orders for this gig right now.";
  if (g.status !== "live") return "This gig isn't on Ruxstar.";
  return null;
}

export async function gigDetail(db: Database, g: WithId<GigDoc>, settings: GigsSettings): Promise<GigDetail> {
  const business = await db.businesses.findOne({ _id: g.businessId });
  const owners = await ownersOf(db, [g.vendorId]);
  const whyNot = orderProblem(g, business, settings);
  return {
    ...cardOf(g, business ?? undefined, owners.get(g.vendorId.toHexString()), settings),
    description: g.description,
    photos: g.photos.map(fullPhoto),
    packages: g.packages,
    questions: g.questions,
    platformFee: settings.platformFee,
    status: g.status,
    canOrder: whyNot === null,
    whyNot,
    rules: ORDER_RULES,
  };
}

/** What publishing a gig still needs, in words. */
export function missingOf(g: GigDoc, verified: boolean): string[] {
  const missing: string[] = [];
  if (!verified) missing.push("Get verified");
  if (!g.photos.length) missing.push("Add a photo");
  return missing;
}

export async function myGigViews(db: Database, gigs: WithId<GigDoc>[], settings: GigsSettings, verified: boolean): Promise<MyGig[]> {
  if (!gigs.length) return [];
  const counts = await db.gigOrders
    .aggregate<{ _id: ObjectId; n: number }>([{ $match: { gigId: { $in: gigs.map((g) => g._id) }, "payment.paidAt": { $type: "date" } } }, { $group: { _id: "$gigId", n: { $sum: 1 } } }])
    .toArray();
  return Promise.all(
    gigs.map(async (g) => ({
      ...(await gigDetail(db, g, settings)),
      publishedAt: iso(g.publishedAt),
      removal: g.removal ? { reason: g.removal.reason, at: g.removal.at.toISOString() } : null,
      missing: g.status === "draft" ? missingOf(g, verified) : [],
      orders: counts.find((c) => c._id.equals(g._id))?.n ?? 0,
      createdAt: g.createdAt.toISOString(),
      updatedAt: g.updatedAt.toISOString(),
    })),
  );
}

/** The profile fields every view of a freelancer shares. */
export function profileView(b: WithId<BusinessDoc>, owner: Owner | undefined, settings: GigsSettings) {
  const f = b.freelancer!;
  return {
    businessId: b._id.toHexString(),
    name: b.name,
    headline: f.headline,
    bio: b.description,
    category: f.category,
    categoryLabel: categoryLabel(settings, f.category),
    skills: f.skills,
    languages: f.languages,
    city: f.city,
    avatarUrl: avatarOf(owner),
    portfolio: { photos: f.portfolio.photos.map(fullPhoto), links: f.portfolio.links },
    ...(b.rating ? { rating: ratingOf(b) } : {}),
  };
}

/** A sentence for a package, for notifications and the console. */
export const packageLine = (p: { name: string; deliveryDays: number; revisions: number }) => `${p.name}: ${daysText(p.deliveryDays)}, ${revisionsText(p.revisions).toLowerCase()}`;

// Orders.

/**
 * A completed order opens for a review, until 30 days after it completed. Orders refunded in full, cancelled ones, and ones
 * still under way can't be reviewed. Custom offers are reviewed for the freelancer, not a gig.
 */
export function gigReviewable(o: GigOrderDoc, now = Date.now()): Reviewable {
  const refundedAll = o.price.total > 0 && refundedOf(o) >= o.price.total;
  const open = o.status === "completed" && !!o.completedAt && !refundedAll;
  return {
    module: "gigs",
    orderType: "gig_order",
    orderId: o._id,
    orderNo: o.orderNo,
    businessId: o.businessId,
    businessName: o.businessName,
    vendorId: o.vendorId,
    customerId: o.customerId,
    label: o.title,
    listing: o.gigId ? { type: "gig", id: o.gigId } : null,
    until: open ? openUntil(o.completedAt!, now) : null,
    closed: o.status !== "completed" ? "You can review the order once it's complete." : open ? `Reviews close ${REVIEW_DAYS} days after it completed.` : "Orders refunded in full can't be reviewed.",
  };
}

type Role = GigOrder["role"];

/** Orders ready to show: the customer's, the freelancer's or the console's view. File links are only made for those three. */
export async function orderViews(app: FastifyInstance, db: Database, request: Request, orders: GigOrderDoc[], role: Role): Promise<GigOrder[]> {
  if (!orders.length) return [];
  const link = gigFileLinks(app, request);
  const now = new Date();
  const [reviews, owners] = await Promise.all([
    role === "customer" ? eligibility(db, orders.map((o) => gigReviewable(o, now.getTime()))) : new Map(),
    ownersOf(db, [...new Map(orders.map((o) => [o.vendorId.toHexString(), o.vendorId])).values()]),
  ]);
  const fileView = (o: GigOrderDoc) => (f: GigFileRef) => ({
    id: f.id.toHexString(),
    name: f.name,
    contentType: f.contentType,
    bytes: f.bytes,
    url: o.filesDeletedAt ? null : link(f.id),
  });
  return orders.map((o): GigOrder => {
    const files = fileView(o);
    const customer = role === "customer";
    const freelancer = role === "freelancer";
    const late = o.status === "in_progress" && !!o.dueAt && o.dueAt <= now && o.deliveries.length === 0;
    const owner = owners.get(o.vendorId.toHexString());
    return {
      id: o._id.toHexString(),
      orderNo: o.orderNo,
      status: o.status,
      role,
      title: o.title,
      category: o.category,
      gigId: o.gigId?.toHexString() ?? null,
      quoteId: o.quoteId?.toHexString() ?? null,
      freelancer: {
        businessId: o.businessId.toHexString(),
        userId: o.vendorId.toHexString(),
        username: owner?.username ?? null,
        name: o.businessName,
        avatarUrl: avatarOf(owner),
      },
      customer: { id: o.customerId.toHexString(), name: o.customerName },
      package: o.package,
      answers: o.answers.map((a) => ({ question: a.question, answer: a.answer })),
      files: o.files.map(files),
      note: o.note,
      price: { items: o.price.items, discount: o.price.discount, platformFee: o.price.platformFee, total: o.price.total },
      coupon: appliedView(o.price.coupon),
      share: customer ? null : vendorLeftOf(o),
      refunds: o.refunds.map((r) => ({ kind: r.kind, amount: r.amount, status: r.status, reason: r.reason, at: r.at.toISOString() })),
      payBy: o.status === "awaiting_payment" ? iso(o.holdUntil) : null,
      paidAt: iso(o.payment.paidAt),
      acceptBy: o.status === "paid" ? iso(o.acceptBy) : null,
      acceptedAt: iso(o.acceptedAt),
      dueAt: iso(o.dueAt),
      late,
      revisions: { included: o.package.revisions, used: o.revisionsUsed, left: Math.max(0, o.package.revisions - o.revisionsUsed) },
      deliveries: o.deliveries.map((d) => ({
        id: d.id.toHexString(),
        message: d.message,
        links: d.links,
        files: d.files.map(files),
        at: d.at.toISOString(),
        answer: d.answer ? { kind: d.answer.kind, note: d.answer.note, at: d.answer.at.toISOString() } : null,
      })),
      autoCompleteAt: o.status === "delivered" ? iso(o.autoCompleteAt) : null,
      completedAt: iso(o.completedAt),
      dispute: o.dispute
        ? {
            reason: o.dispute.reason,
            openedAt: o.dispute.openedAt.toISOString(),
            ticketId: o.dispute.ticketId.toHexString(),
            decision: o.dispute.decision
              ? { outcome: o.dispute.decision.outcome, amount: o.dispute.decision.amount, note: o.dispute.decision.note, at: o.dispute.decision.at.toISOString() }
              : null,
          }
        : null,
      cancellation: o.cancellation ? { by: o.cancellation.by, reason: o.cancellation.reason, at: o.cancellation.at.toISOString() } : null,
      timeline: o.timeline.map((t) => ({ status: t.status, at: t.at.toISOString(), by: t.by })),
      filesDeleted: Boolean(o.filesDeletedAt),
      can: {
        pay: customer && o.status === "awaiting_payment",
        cancel: customer ? customerCanCancel(o, now) : freelancer && ["paid", "in_progress", "delivered"].includes(o.status),
        accept: freelancer && o.status === "paid",
        decline: freelancer && o.status === "paid",
        deliver: freelancer && o.status === "in_progress",
        approve: customer && o.status === "delivered",
        revise: customer && o.status === "delivered" && o.revisionsUsed < o.package.revisions,
        report: customer && o.status === "delivered",
      },
      invoices: invoiceRefs(o.invoices),
      ...(customer ? reviews.get(o._id.toHexString()) : {}),
      createdAt: o.createdAt.toISOString(),
    };
  });
}
