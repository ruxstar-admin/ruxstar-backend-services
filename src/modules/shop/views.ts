import type { ObjectId } from "mongodb";
import type { BusinessDoc, BusinessLocation, Database, OrderDelivery, PostPhoto, ShopOrderDoc, ShopProductDoc } from "../../platform/db.js";
import { appliedView } from "../coupons/coupons.js";
import { invoiceRefs } from "../invoices/views.js";
import { REVIEW_DAYS } from "../reviews/contracts.js";
import { eligibility, openUntil, ratingOf, type Reviewable } from "../reviews/reviews.js";
import type { ConsoleOrder, DeskOrder, ProductCard, ProductDetail, ShopOrder, StoreCard, VendorProduct } from "./contracts.js";
import { cancelProblem, moveProblem, returnProblem } from "./orders.js";
import { refundedOf, returnText, vendorLeftOf, type ShopSettings } from "./rules.js";

const iso = (at: Date | null | undefined) => at?.toISOString() ?? null;
const photoView = (p: PostPhoto | null | undefined) => (p ? { url: p.url, width: p.width, height: p.height } : null);

export const addressOf = (l: BusinessLocation | null | undefined) =>
  l ? [l.doorNo, l.building, l.street, l.area, l.city, l.pincode].filter(Boolean).join(", ") : "";

/** The shop's return rule as customers read it. */
export const shopReturnText = (shop: Pick<BusinessDoc, "shop">, settings: Pick<ShopSettings, "returnDays">) =>
  returnText(shop.shop?.returns ? { days: settings.returnDays } : null);

export function storeCard(doc: BusinessDoc, settings: ShopSettings): StoreCard {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    type: doc.type,
    photoUrl: doc.photos[0]?.url ?? null,
    city: doc.location?.city ?? "",
    area: doc.location?.area ?? null,
    open: doc.open,
    delivery: Boolean(doc.shop?.delivery),
    pickup: Boolean(doc.shop?.pickup),
    returnRule: shopReturnText(doc, settings),
    rating: ratingOf(doc),
  };
}

export const setupView = (doc: BusinessDoc) => {
  const s = doc.shop;
  return s
    ? { delivery: s.delivery, pickup: s.pickup, radiusKm: s.radiusKm, deliveryFee: s.deliveryFee, minOrder: s.minOrder, returns: s.returns, notes: s.notes }
    : null;
};

const productFields = (p: ShopProductDoc): ProductCard => ({
  id: p._id.toHexString(),
  title: p.title,
  photo: photoView(p.photo),
  business: { id: p.businessId.toHexString(), name: p.businessName },
  city: p.city,
  priceFrom: p.priceFrom,
  mrpFrom: p.mrpFrom,
  inStock: p.inStock,
  rating: ratingOf(p),
});
export const productCard = productFields;

export function productDetail(p: ShopProductDoc, shop: BusinessDoc, settings: ShopSettings, whyNot: string | null): ProductDetail {
  return {
    ...productFields(p),
    description: p.description,
    options: p.options,
    variants: p.variants.map((v) => ({ id: v.id.toHexString(), values: v.values, price: v.price, mrp: v.mrp, stock: v.stock, sku: v.sku })),
    status: p.status,
    canOrder: !whyNot,
    whyNot,
    returnRule: shopReturnText(shop, settings),
    delivery: Boolean(shop.shop?.delivery),
    pickup: Boolean(shop.shop?.pickup),
  };
}

export const vendorProduct = (p: ShopProductDoc, shop: BusinessDoc, settings: ShopSettings, whyNot: string | null = null): VendorProduct => ({
  ...productDetail(p, shop, settings, whyNot),
  hsn: p.tax.hsn,
  gstRateBps: p.tax.rateBps,
  removal: p.removal ? { reason: p.removal.reason, at: p.removal.at.toISOString() } : null,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

/** Why a product can't be ordered now, or null. */
export function productProblem(p: Pick<ShopProductDoc, "status" | "inStock">, shopProblem: string | null): string | null {
  if (p.status === "removed") return "Ruxstar took this product down.";
  if (p.status === "hidden") return "The shop isn't selling this right now.";
  if (shopProblem) return shopProblem;
  return p.inStock ? null : "Sold out.";
}

// Reviews: each product in a delivered order is reviewed on its own.

/** One reviewable per product of the order. The review is keyed by the product's first line, with the order as its parent. */
export function productReviewables(o: ShopOrderDoc): Reviewable[] {
  const firsts = o.lines.filter((l, i) => o.lines.findIndex((x) => x.productId.equals(l.productId)) === i);
  const until = o.status === "delivered" && o.deliveredAt ? openUntil(o.deliveredAt) : null;
  const closed = o.status === "delivered" ? `Reviews close ${REVIEW_DAYS} days after delivery.` : "You can review what you bought once it's delivered.";
  return firsts.map((l) => ({
    module: "shop",
    orderType: "shop_order",
    orderId: l.id,
    parentId: o._id,
    orderNo: o.orderNo,
    businessId: o.businessId,
    businessName: o.businessName,
    vendorId: o.vendorId,
    customerId: o.customerId,
    label: l.title,
    listing: { type: "product", id: l.productId },
    until,
    closed,
  }));
}

export function productReviewable(o: ShopOrderDoc, productId: ObjectId): Reviewable | null {
  return productReviewables(o).find((r) => r.listing!.id.equals(productId)) ?? null;
}

// Orders.

const deliveryCore = (d: OrderDelivery) => ({
  carrier: d.carrier,
  status: d.status,
  rider: d.rider ? { name: d.rider.name, avatarUrl: d.rider.avatar, phone: d.rider.phone, vehicle: d.rider.vehicle } : null,
});
const tripOpen = (d: OrderDelivery) => d.status !== "delivered" && d.status !== "cancelled";

function core(o: ShopOrderDoc, shop: Pick<BusinessDoc, "location" | "phone"> | undefined) {
  return {
    id: o._id.toHexString(),
    orderNo: o.orderNo,
    status: o.status,
    business: { id: o.businessId.toHexString(), name: o.businessName },
    lines: o.lines.map((l) => ({
      id: l.id.toHexString(),
      productId: l.productId.toHexString(),
      variantId: l.variantId.toHexString(),
      title: l.title,
      options: l.options,
      photoUrl: l.photo,
      sku: l.sku,
      unitPrice: l.unitPrice,
      mrp: l.mrp,
      quantity: l.quantity,
      total: l.unitPrice * l.quantity,
    })),
    method: o.method,
    address: o.address,
    pickupAt: o.method === "pickup" ? { address: addressOf(shop?.location), point: shop?.location?.point ?? null, phone: shop?.phone ?? null } : null,
    price: { items: o.price.items, delivery: o.price.delivery, deliveryKm: o.price.deliveryKm, platformFee: o.price.platformFee, discount: o.price.discount, total: o.price.total },
    coupon: appliedView(o.price.coupon),
    note: o.note,
    timeline: o.timeline.map((t) => ({ status: t.status, at: t.at.toISOString(), by: t.by })),
    payBy: o.status === "awaiting_payment" ? iso(o.holdUntil) : null,
    paidAt: iso(o.payment.paidAt),
    acceptBy: o.status === "paid" ? iso(o.acceptBy) : null,
    deliveredAt: iso(o.deliveredAt),
    returnRule: returnText(o.returnRule),
    returnUntil: iso(o.returnUntil),
    return: o.return
      ? {
          reason: o.return.reason,
          note: o.return.note,
          lines: o.return.lines.map((l) => ({ lineId: l.lineId.toHexString(), quantity: l.quantity })),
          status: o.return.status,
          tripPaidBy: o.return.tripPaidBy,
          tripFee: o.return.tripFee,
          amount: o.return.amount,
          requestedAt: o.return.requestedAt.toISOString(),
          decision: o.return.decision ? { by: o.return.decision.by, note: o.return.decision.note, at: o.return.decision.at.toISOString() } : null,
          receivedAt: iso(o.return.receivedAt),
        }
      : null,
    refunds: o.refunds.map((r) => ({ kind: r.kind, amount: r.amount, reason: r.reason, status: r.status, at: r.at.toISOString() })),
    refunded: refundedOf(o),
    cancellation: o.cancellation ? { by: o.cancellation.by, reason: o.cancellation.reason, at: o.cancellation.at.toISOString() } : null,
    invoices: invoiceRefs(o.invoices),
    createdAt: o.createdAt.toISOString(),
  };
}

async function shopsOf(db: Database, docs: ShopOrderDoc[]) {
  const ids = docs.filter((o) => o.method === "pickup").map((o) => o.businessId);
  const shops = ids.length ? await db.businesses.find({ _id: { $in: ids } }, { projection: { location: 1, phone: 1 } }).toArray() : [];
  return new Map(shops.map((s) => [s._id.toHexString(), s]));
}

/** Orders as their customer sees them, with what they can do now. */
export async function orderViews(db: Database, docs: ShopOrderDoc[]): Promise<ShopOrder[]> {
  const shops = await shopsOf(db, docs);
  const items = docs.map((o) => ({ o, reviewables: productReviewables(o) }));
  const allowed = await eligibility(db, items.flatMap((i) => i.reviewables));
  return items.map(({ o, reviewables }) => {
    const per = reviewables.map((r) => ({ productId: r.listing!.id.toHexString(), title: r.label, ...allowed.get(r.orderId.toHexString())! }));
    const open = per.filter((p) => p.canReview);
    return {
      ...core(o, shops.get(o.businessId.toHexString())),
      delivery: o.delivery ? { ...deliveryCore(o.delivery), dropCode: tripOpen(o.delivery) ? o.delivery.dropCode : null } : null,
      canCancel: !cancelProblem(o, "customer"),
      canReturn: !returnProblem(o),
      reviewable: per,
      canReview: open.length > 0,
      reviewUntil: open[0]?.reviewUntil ?? null,
    };
  });
}

const OPEN_RETURN = new Set(["requested", "approved"]);
const payoutOf = (o: ShopOrderDoc): DeskOrder["payout"] =>
  o.releasedAt ? "released" : o.status === "cancelled" || !o.payment.paidAt ? "none" : o.return && OPEN_RETURN.has(o.return.status) ? "return" : "waiting";

const NEXT_STEPS = ["accepted", "packed", "out_for_delivery", "ready_for_pickup", "delivered"] as const;

function deskCore(o: ShopOrderDoc, shop: Pick<BusinessDoc, "location" | "phone"> | undefined, phone: string | null) {
  return {
    ...core(o, shop),
    customer: { name: o.customerName, phone: o.payment.paidAt ? (o.address?.phone ?? phone) : null },
    delivery: o.delivery
      ? { ...deliveryCore(o.delivery), jobId: o.delivery.jobId.toHexString(), pay: o.delivery.pay, offerUntil: o.delivery.status === "offered" ? iso(o.delivery.offerUntil) : null }
      : null,
    commission: o.price.commission,
    vendorShare: o.status === "cancelled" || !o.payment.paidAt ? 0 : Math.max(0, vendorLeftOf(o)),
    payout: payoutOf(o),
    releaseAt: iso(o.releaseAt),
    next: NEXT_STEPS.filter((to) => !moveProblem(o, to)),
    canCancel: !cancelProblem(o, "vendor") && o.status !== "awaiting_payment",
  };
}

async function phonesOf(db: Database, docs: ShopOrderDoc[]) {
  const ids = docs.filter((o) => o.payment.paidAt && !o.address).map((o) => o.customerId);
  const users = ids.length ? await db.users.find({ _id: { $in: ids } }, { projection: { phone: 1 } }).toArray() : [];
  return new Map(users.map((u) => [u._id.toHexString(), u.phone]));
}

/** Orders as the shop and its team see them. */
export async function deskOrderViews(db: Database, docs: ShopOrderDoc[]): Promise<DeskOrder[]> {
  const [shops, phones] = await Promise.all([shopsOf(db, docs), phonesOf(db, docs)]);
  return docs.map((o) => deskCore(o, shops.get(o.businessId.toHexString()), phones.get(o.customerId.toHexString()) ?? null));
}

export async function consoleOrderViews(db: Database, docs: ShopOrderDoc[]): Promise<ConsoleOrder[]> {
  const desk = await deskOrderViews(db, docs);
  return docs.map((o, i) => ({ ...desk[i]!, customerId: o.customerId.toHexString(), vendorId: o.vendorId.toHexString(), releasedAt: iso(o.releasedAt) }));
}
