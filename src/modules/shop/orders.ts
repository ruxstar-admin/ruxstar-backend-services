import type { FastifyInstance } from "fastify";
import { ObjectId, type ClientSession, type WithId } from "mongodb";
import { writeAudit } from "../../platform/audit.js";
import {
  stamp,
  type AuditLogDoc,
  type BusinessDoc,
  type Database,
  type NotificationDoc,
  type ShopActor,
  type ShopOrderDoc,
  type ShopOrderLineDoc,
  type ShopOrderStatus,
  type ShopProductDoc,
  type ShopRefundDoc,
  type ShopReturnReason,
  type ShopVariantDoc,
  type TeamPermission,
} from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { MAX_ORDER_TOTAL } from "../coaching/rules.js";
import { checkCode, giveBack, redeem } from "../coupons/coupons.js";
import { rateFor, roadKm } from "../delivery/rates.js";
import { stopTrip, tripActive } from "../delivery/stop.js";
import { creditOrder, invoiceShopOrder } from "../invoices/issue.js";
import { notifyRider, notifyShop } from "../notifications/notify.js";
import { dropPoint, rupees } from "../pod/orders.js";
import {
  DAY_MS,
  HOUR_MS,
  nextShopOrderNo,
  refundedOf,
  releaseAtOf,
  returnLedger,
  returnSplit,
  ruxstarShareOf,
  shopLedger,
  shopSettings,
  vendorLeftOf,
  vendorShareOf,
  type ShopSettings,
} from "./rules.js";

export interface By {
  kind: ShopActor;
  actor: AuditLogDoc["actor"];
  ip?: string | null;
}
export const SYSTEM: By = { kind: "system", actor: { id: null, kind: "system" } };

type Link = NotificationDoc["link"];
const invalid = (path: string, message: string) => new AppError("ORDER_INVALID", message, [{ path, message }]);
export const orderLink = (o: Pick<ShopOrderDoc, "_id">): Link => ({ screen: "store_order", id: o._id.toHexString() });
export const deskLink = (o: Pick<ShopOrderDoc, "_id">): Link => ({ screen: "vendor_store_order", id: o._id.toHexString() });
export const storeLink = (businessId: ObjectId): Link => ({ screen: "store", id: businessId.toHexString() });
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "T-shirt (M, Red)". */
export const variantLabel = (p: Pick<ShopProductDoc, "title">, v: Pick<ShopVariantDoc, "values">) => (v.values.length ? `${p.title} (${v.values.join(", ")})` : p.title);
const lineLabel = (l: Pick<ShopOrderLineDoc, "title" | "options">) => (l.options.length ? `${l.title} (${l.options.map((o) => o.value).join(", ")})` : l.title);
/** "T-shirt (M, Red) × 2 and 1 more". */
export const itemsText = (o: Pick<ShopOrderDoc, "lines">) => {
  const first = o.lines[0]!;
  return `${lineLabel(first)} × ${first.quantity}${o.lines.length > 1 ? ` and ${count(o.lines.length - 1, "more item")}` : ""}`;
};

/** Every unit across the order's lines, for the rider. */
export const unitsOf = (o: Pick<ShopOrderDoc, "lines">) => o.lines.reduce((sum, line) => sum + line.quantity, 0);

/** The owner, and verified team members with `permission`: who hears about the shop's orders. */
export async function shopPeople(db: Database, o: Pick<ShopOrderDoc, "_id" | "businessId" | "vendorId">, permission: TeamPermission = "store.orders") {
  const places = await db.employments.find({ businessId: o.businessId, status: "active", current: true, permissions: permission }, { projection: { userId: 1 } }).toArray();
  const verified = places.length
    ? await db.users.find({ _id: { $in: places.map((p) => p.userId) }, status: "active", "kyc.base": "approved" }, { projection: { _id: 1 } }).toArray()
    : [];
  return [o.vendorId, ...verified.map((u) => u._id)].map((userId) => ({ userId, link: deskLink(o) }));
}

const audit = (db: Database, by: By, o: Pick<ShopOrderDoc, "_id" | "businessId">, action: string, diff: Record<string, { from: unknown; to: unknown }>, session?: ClientSession) =>
  writeAudit(db, { actor: by.actor, scope: { module: "shop", businessId: o.businessId }, action, target: { type: "shop_order", id: o._id }, diff, ip: by.ip ?? null }, session);

// The cart.

export interface CartLine {
  productId: string;
  variantId: string;
  quantity: number;
}
export interface DropInput {
  line?: string | undefined;
  city?: string | undefined;
  pincode?: string | undefined;
  point?: { lat: number; lng: number } | null | undefined;
}
export interface CartInput {
  lines: CartLine[];
  method: "delivery" | "pickup";
  address?: DropInput | undefined;
}

/** Whether customers can order from the shop now, and why not. */
export function orderProblem(shop: Pick<BusinessDoc, "module" | "status" | "open" | "suspension" | "shop" | "name">): string | null {
  if (shop.module !== "shop" || shop.status !== "live" || shop.suspension) return "This shop isn't on Ruxstar.";
  if (!shop.shop || (!shop.shop.delivery && !shop.shop.pickup)) return `${shop.name} hasn't set up delivery or pickup yet.`;
  if (!shop.open) return `${shop.name} is closed right now. Try again when it opens.`;
  return null;
}

/**
 * Prices a cart at one shop as it is now: each line's variant, its price and whether there's enough stock, the delivery fee by
 * road distance or nothing for pickup. Nothing is held: stock is only taken when the order is paid.
 */
export async function priceCart(app: FastifyInstance, db: Database, shop: WithId<BusinessDoc>, input: CartInput, settings: ShopSettings) {
  const setup = shop.shop!;
  if (!input.lines.length) throw invalid("body/lines", "Add something to the cart first.");
  if (input.lines.length > settings.maxLines) throw invalid("body/lines", `Up to ${settings.maxLines} different items in one order.`);
  const seen = new Set<string>();
  input.lines.forEach((l, i) => {
    if (seen.has(l.variantId)) throw invalid(`body/lines/${i}/variantId`, "This item is in the cart twice. Change its quantity instead.");
    seen.add(l.variantId);
    if (l.quantity > settings.maxQuantity) throw invalid(`body/lines/${i}/quantity`, `Up to ${settings.maxQuantity} of one item in an order.`);
  });
  const ids = [...new Set(input.lines.map((l) => l.productId))].map((id) => new ObjectId(id));
  const products = await db.shopProducts.find({ _id: { $in: ids } }).toArray();
  const lines = input.lines.map((l, i): ShopOrderLineDoc => {
    const p = products.find((x) => x._id.toHexString() === l.productId);
    if (!p || p.status !== "live") throw invalid(`body/lines/${i}/productId`, "This product isn't for sale any more. Remove it from the cart.");
    if (!p.businessId.equals(shop._id)) {
      throw invalid(`body/lines/${i}/productId`, `An order is from one shop. ${p.title} is from ${p.businessName}, so order it separately.`);
    }
    const v = p.variants.find((x) => x.id.toHexString() === l.variantId);
    if (!v) throw invalid(`body/lines/${i}/variantId`, `This option of ${p.title} isn't sold any more. Pick another.`);
    if (v.stock < l.quantity) {
      const message = v.stock === 0 ? `${variantLabel(p, v)} is sold out.` : `Only ${v.stock} of ${variantLabel(p, v)} left.`;
      throw new AppError("CONFLICT", message, [{ path: `body/lines/${i}/quantity`, message }]);
    }
    return {
      id: new ObjectId(),
      productId: p._id,
      variantId: v.id,
      title: p.title,
      options: p.options.map((o, k) => ({ name: o.name, value: v.values[k]! })),
      photo: p.photo?.url ?? null,
      sku: v.sku,
      unitPrice: v.price,
      mrp: v.mrp,
      quantity: l.quantity,
      tax: p.tax,
    };
  });
  const items = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  if (items < setup.minOrder) throw invalid("body/lines", `${shop.name}'s smallest order is ${rupees(setup.minOrder)}.`);

  let delivery = 0;
  let deliveryKm: number | null = null;
  let point: { lat: number; lng: number } | null = null;
  if (input.method === "delivery") {
    if (!setup.delivery) throw invalid("body/method", `${shop.name} doesn't deliver. Pick it up from the shop instead.`);
    const city = shop.location?.city;
    if (input.address?.city && city && input.address.city.trim().toLowerCase() !== city.trim().toLowerCase()) {
      throw invalid("body/address/city", `${shop.name} delivers in ${city} only.`);
    }
    point = await dropPoint(app, input.address);
    deliveryKm = roadKm(shop.location?.point, point);
    if (setup.radiusKm !== null && deliveryKm !== null && deliveryKm > setup.radiusKm) {
      throw invalid("body/address", `${shop.name} delivers up to ${setup.radiusKm} km away. This address is about ${deliveryKm} km.`);
    }
    delivery = rateFor(setup.deliveryFee, deliveryKm);
  } else if (!setup.pickup) {
    throw invalid("body/method", `${shop.name} doesn't do pickup. Choose delivery.`);
  }
  return { lines, items, delivery, deliveryKm, point };
}

export interface Customer {
  id: ObjectId;
  phone: string;
  name: string | null;
}

export interface PlaceInput extends CartInput {
  address?: (DropInput & { name: string; phone: string; line: string; city: string; pincode: string }) | undefined;
  coupon?: string | undefined;
  note?: string | undefined;
}

/** Places an order waiting for payment and sets up its checkout. Stock is checked, not taken. */
export async function placeShopOrder(app: FastifyInstance, db: Database, shop: WithId<BusinessDoc>, customer: Customer, input: PlaceInput): Promise<ShopOrderDoc> {
  const settings = await shopSettings(db);
  if (shop.ownerId.equals(customer.id)) throw invalid("body", "You can't order from your own shop.");
  if (input.method === "delivery" && !input.address) throw invalid("body/address", "Add where it should be delivered.");
  const cart = await priceCart(app, db, shop, input, settings);

  let coupon: ShopOrderDoc["price"]["coupon"] = null;
  let discount = 0;
  if (input.coupon) {
    const check = await checkCode(db, input.coupon, { module: "shop", shop: { id: shop._id, name: shop.name }, customerId: customer.id, items: cart.items });
    if (check.problem !== null) throw new AppError("COUPON_INVALID", check.problem, [{ path: "body/coupon", message: check.problem }]);
    coupon = { id: check.coupon._id, code: check.coupon.code, fundedBy: check.coupon.fundedBy };
    discount = check.discount;
  }
  const platformFee = settings.platformFee;
  const charged = coupon?.fundedBy === "vendor" ? cart.items - discount : cart.items;
  const total = cart.items - discount + cart.delivery + platformFee;
  if (total > MAX_ORDER_TOTAL) throw invalid("body/lines", "Payments over ₹5,00,000 can't be made online. Split it into smaller orders.");
  const commission = Math.round((charged * settings.commissionBps) / 10_000);

  const now = new Date();
  const id = new ObjectId();
  const a = input.method === "delivery" ? input.address! : null;
  const order: ShopOrderDoc = {
    _id: id,
    orderNo: await nextShopOrderNo(db),
    customerId: customer.id,
    customerName: customer.name ?? a?.name ?? "Customer",
    businessId: shop._id,
    vendorId: shop.ownerId,
    businessName: shop.name,
    lines: cart.lines,
    method: input.method,
    address: a ? { name: a.name.trim(), phone: a.phone, line: a.line.trim(), city: a.city.trim(), pincode: a.pincode, point: cart.point } : null,
    price: { items: cart.items, delivery: cart.delivery, deliveryKm: cart.deliveryKm, platformFee, discount, coupon, total, commissionBps: settings.commissionBps, commission },
    returnRule: shop.shop!.returns ? { days: settings.returnDays } : null,
    note: input.note?.trim() || null,
    status: "awaiting_payment",
    timeline: [{ status: "awaiting_payment", at: now, by: "customer" }],
    payment: { gatewayOrderId: `rxt_${id.toHexString()}`, sessionId: "", paymentId: null, paidAt: null },
    holdUntil: new Date(now.getTime() + settings.holdMinutes * 60_000),
    stockTaken: false,
    acceptBy: null,
    delivery: null,
    deliveredAt: null,
    returnUntil: null,
    return: null,
    refunds: [],
    cancellation: null,
    releaseAt: null,
    releasedAt: null,
    ...stamp(now),
  };
  await db.shopOrders.insertOne(order);

  try {
    const origin = app.config.apiUrl;
    const { sessionId } = await app.payments.createOrder({
      orderId: order.payment.gatewayOrderId,
      amount: total,
      customer: { id: customer.id.toHexString(), phone: customer.phone.slice(-10), name: customer.name ?? "Customer" },
      note: `${shop.name}: ${itemsText(order)}`,
      returnUrl: origin ? `${origin}/pay/shop/${id.toHexString()}/done` : null,
      notifyUrl: origin ? `${origin}/webhooks/cashfree` : null,
    });
    return (await db.shopOrders.findOneAndUpdate({ _id: id }, { $set: { "payment.sessionId": sessionId } }, { returnDocument: "after" })) ?? order;
  } catch (err) {
    await db.shopOrders.updateOne(
      { _id: id, status: "awaiting_payment" },
      {
        $set: { status: "cancelled", holdUntil: null, cancellation: { by: "system", actorId: null, reason: "The payment couldn't be set up.", at: new Date() } },
        $push: { timeline: { status: "cancelled", at: new Date(), by: "system" } },
      },
    );
    throw err;
  }
}

// Stock.

class SoldOut extends Error {
  constructor(readonly line: ShopOrderLineDoc) {
    super("sold out");
  }
}

/**
 * Takes each line's quantity off its variant, only while that much is left, in the payment's transaction. Two payments for the
 * last piece write the same product, so one waits for the other and then finds it gone: stock never goes below zero.
 */
async function takeStock(db: Database, o: ShopOrderDoc, session: ClientSession) {
  for (const line of o.lines) {
    const res = await db.shopProducts.updateOne(
      { _id: line.productId, variants: { $elemMatch: { id: line.variantId, stock: { $gte: line.quantity } } } },
      { $inc: { "variants.$.stock": -line.quantity, seq: 1 }, $set: { updatedAt: new Date() } },
      { session },
    );
    if (res.matchedCount === 0) throw new SoldOut(line);
    await db.shopProducts.updateOne({ _id: line.productId, variants: { $not: { $elemMatch: { stock: { $gt: 0 } } } } }, { $set: { inStock: false } }, { session });
  }
}

/** Puts a cancelled order's stock back, on variants that are still there. */
async function returnStock(db: Database, o: ShopOrderDoc, session: ClientSession) {
  for (const line of o.lines) {
    await db.shopProducts.updateOne(
      { _id: line.productId, "variants.id": line.variantId },
      { $inc: { "variants.$.stock": line.quantity, seq: 1 }, $set: { inStock: true, updatedAt: new Date() } },
      { session },
    );
  }
}

// Paying.

/** The payment went through: stock is taken, the money waits in pending, and the shop has `acceptHours` to accept. Safe to repeat. */
export async function confirmShopOrder(app: FastifyInstance, db: Database, o: ShopOrderDoc, paymentId: string | null): Promise<ShopOrderDoc> {
  const settings = await shopSettings(db);
  const now = new Date();
  let after: ShopOrderDoc | null;
  try {
    after = await db.transaction(async (session) => {
      const done = await db.shopOrders.findOneAndUpdate(
        { _id: o._id, status: "awaiting_payment" },
        {
          $set: {
            status: "paid",
            "payment.paymentId": paymentId,
            "payment.paidAt": now,
            holdUntil: null,
            stockTaken: true,
            acceptBy: new Date(now.getTime() + settings.acceptHours * HOUR_MS),
            updatedAt: now,
          },
          $push: { timeline: { status: "paid", at: now, by: "system" } },
        },
        { session, returnDocument: "after" },
      );
      if (!done) return null;
      await takeStock(db, done, session);
      for (const entry of shopLedger("payment", done, now)) await db.ledgerEntries.insertOne(entry, { session });
      await redeem(db, done, session);
      const issued = await invoiceShopOrder(db, done, session);
      if (issued.length) done.invoices = [...(done.invoices ?? []), ...issued];
      return done;
    });
  } catch (err) {
    if (err instanceof SoldOut) return soldOut(app, db, o, paymentId, err.line);
    throw err;
  }
  if (!after) return (await db.shopOrders.findOne({ _id: o._id })) ?? o;

  await notifyShop(db, app.log, {
    actor: after.customerId,
    type: "shop.ordered",
    title: `Order placed: #${after.orderNo}`,
    body: `Waiting for ${after.businessName} to accept it. If they don't within ${count(settings.acceptHours, "hour")}, you're refunded.`,
    to: [{ userId: after.customerId, link: orderLink(after) }],
  });
  await notifyShop(db, app.log, {
    actor: after.customerId,
    type: "shop.ordered",
    title: `New order #${after.orderNo}`,
    body: `${itemsText(after)}, ${after.method === "pickup" ? "for pickup" : `to deliver in ${after.address!.city}`}. Accept it within ${count(settings.acceptHours, "hour")}.`,
    to: await shopPeople(db, after),
  });
  return after;
}

/** Paid, but something sold out meanwhile: the order is cancelled and the customer refunded in full at once. */
async function soldOut(app: FastifyInstance, db: Database, o: ShopOrderDoc, paymentId: string | null, line: ShopOrderLineDoc): Promise<ShopOrderDoc> {
  const now = new Date();
  const reason = `${lineLabel(line)} sold out while you were paying, so the order was cancelled. Your ${rupees(o.price.total)} is being refunded.`;
  const refund: ShopRefundDoc = {
    refundId: `rfs_${o._id.toHexString()}_full`,
    kind: "full",
    amount: o.price.total,
    vendor: vendorShareOf(o),
    ruxstar: ruxstarShareOf(o),
    reason,
    by: "system",
    status: "pending",
    at: now,
  };
  const done = await db.transaction(async (session) => {
    const after = await db.shopOrders.findOneAndUpdate(
      { _id: o._id, status: "awaiting_payment" },
      {
        $set: {
          status: "cancelled",
          "payment.paymentId": paymentId,
          "payment.paidAt": now,
          holdUntil: null,
          cancellation: { by: "system", actorId: null, reason, at: now },
          updatedAt: now,
        },
        $push: { timeline: { $each: [{ status: "paid" as const, at: now, by: "system" as const }, { status: "cancelled" as const, at: now, by: "system" as const }] }, refunds: refund },
      },
      { session, returnDocument: "after" },
    );
    if (!after) return null;
    for (const entry of [...shopLedger("payment", after, now), ...shopLedger("refund", after, now)]) await db.ledgerEntries.insertOne(entry, { session });
    return after;
  });
  if (!done) return (await db.shopOrders.findOne({ _id: o._id })) ?? o;
  await notifyShop(db, app.log, {
    actor: done.customerId,
    type: "shop.updated",
    title: `Sold out: #${done.orderNo}`,
    body: reason,
    to: [{ userId: done.customerId, link: orderLink(done) }],
  });
  return askShopRefund(app, db, done);
}

/** Asks Cashfree for each pending refund, or how it's going. Safe to repeat; a failure leaves it for the next sweep. */
export async function askShopRefund(app: FastifyInstance, db: Database, o: ShopOrderDoc): Promise<ShopOrderDoc> {
  let current = o;
  for (const refund of o.refunds.filter((r) => r.status === "pending")) {
    try {
      const { status } = await app.payments.refund(o.payment.gatewayOrderId, refund.refundId, refund.amount, `Ruxstar shop order #${o.orderNo}`);
      if (status !== "done") continue;
      const after = await db.shopOrders.findOneAndUpdate(
        { _id: o._id },
        { $set: { "refunds.$[r].status": "done", updatedAt: new Date() } },
        { arrayFilters: [{ "r.refundId": refund.refundId }], returnDocument: "after" },
      );
      if (after) current = after;
    } catch (err) {
      app.log.error({ err: (err as Error).message, order: o._id.toHexString() }, "Shop refund not started; it is retried on the next sweep");
    }
  }
  return current;
}

/** While an order waits for payment, asks Cashfree whether it was paid; once the checkout time is up, an unpaid one is cancelled. */
export async function syncShopPayment(app: FastifyInstance, db: Database, o: ShopOrderDoc, { noExpiry = false }: { noExpiry?: boolean } = {}): Promise<ShopOrderDoc> {
  if (o.status !== "awaiting_payment") return o.refunds.some((r) => r.status === "pending") ? askShopRefund(app, db, o) : o;
  let answer: Awaited<ReturnType<typeof app.payments.status>>;
  try {
    answer = await app.payments.status(o.payment.gatewayOrderId);
  } catch {
    return o;
  }
  if (answer.status === "paid") return confirmShopOrder(app, db, o, answer.paymentId);
  if (noExpiry) return o;
  if (answer.status === "expired" || answer.status === "terminated") return dropUnpaid(app, db, o, SYSTEM, "The payment didn't go through.");
  if (o.holdUntil && o.holdUntil.getTime() <= Date.now()) return cancelShopOrder(app, db, o, SYSTEM, "The payment didn't finish in time.");
  return o;
}

// Cancelling.

const BEFORE_PACKING: ShopOrderStatus[] = ["paid", "accepted"];
const BEFORE_DELIVERY: ShopOrderStatus[] = ["paid", "accepted", "packed", "out_for_delivery", "ready_for_pickup"];

/** Why `by` can't cancel the order now, or null when they can. */
export function cancelProblem(o: Pick<ShopOrderDoc, "status" | "delivery">, by: ShopActor): string | null {
  if (o.status === "cancelled") return "This order is cancelled already.";
  if (o.status === "delivered") return by === "customer" ? "It's delivered. Ask for a return instead, if the shop takes them." : "It's delivered, so it can't be cancelled.";
  if (o.status === "awaiting_payment") return by === "customer" || by === "system" || by === "staff" ? null : "This order isn't paid yet.";
  if (by === "customer") return BEFORE_PACKING.includes(o.status) ? null : "The shop has packed it, so it can't be cancelled now. Ask for a return after delivery, if the shop takes them.";
  if (by === "vendor" && o.delivery?.status === "picked_up") return "The rider has it already. Call them if it must come back.";
  return BEFORE_DELIVERY.includes(o.status) ? null : "This order can't be cancelled now.";
}

/**
 * Cancels an order. Unpaid: its payment is stopped at Cashfree; if it was paid meanwhile, it goes on as paid for the system and
 * is cancelled and refunded for anyone else. Paid: refunded in full, platform fee included, its stock goes back and a trip that
 * hasn't ended is cancelled.
 */
export async function cancelShopOrder(app: FastifyInstance, db: Database, o: ShopOrderDoc, by: By, reason: string): Promise<ShopOrderDoc> {
  const problem = cancelProblem(o, by.kind);
  if (problem) throw new AppError("ORDER_STATE", problem);
  if (o.status === "awaiting_payment") {
    try {
      await app.payments.terminate(o.payment.gatewayOrderId);
    } catch {
      const now = await syncShopPayment(app, db, o, { noExpiry: true });
      if (now.status === "awaiting_payment") throw new AppError("PAYMENTS_UNAVAILABLE");
      if (by.kind === "system" || now.status === "cancelled") return now;
      o = now;
    }
    if (o.status === "awaiting_payment") return dropUnpaid(app, db, o, by, reason);
  }
  return cancelPaid(app, db, o, by, reason);
}

async function dropUnpaid(app: FastifyInstance, db: Database, o: ShopOrderDoc, by: By, reason: string): Promise<ShopOrderDoc> {
  const now = new Date();
  const done = await db.shopOrders.findOneAndUpdate(
    { _id: o._id, status: "awaiting_payment" },
    {
      $set: { status: "cancelled", holdUntil: null, cancellation: { by: by.kind, actorId: by.actor.id, reason, at: now }, updatedAt: now },
      $push: { timeline: { status: "cancelled", at: now, by: by.kind } },
    },
    { returnDocument: "after" },
  );
  if (!done) {
    const current = await db.shopOrders.findOne({ _id: o._id });
    if (current && current.status !== "awaiting_payment") return current;
    throw new AppError("ORDER_STATE");
  }
  if (by.kind === "system") {
    await notifyShop(db, app.log, {
      actor: o.customerId,
      type: "shop.updated",
      title: "Order not completed",
      body: `The payment for your order at ${o.businessName} didn't finish, so it was cancelled. Order again any time.`,
      to: [{ userId: o.customerId, link: storeLink(o.businessId) }],
    });
  }
  return done;
}

const TRIP_BY: Record<ShopActor, "rider" | "shop" | "system" | "staff"> = { customer: "system", vendor: "shop", staff: "staff", system: "system", rider: "rider" };

async function cancelPaid(app: FastifyInstance, db: Database, o: ShopOrderDoc, by: By, reason: string): Promise<ShopOrderDoc> {
  const now = new Date();
  const result = await db.transaction(async (session) => {
    const current = await db.shopOrders.findOne({ _id: o._id }, { session });
    if (!current) throw new AppError("NOT_FOUND", "Order not found.");
    const problem = cancelProblem(current, by.kind);
    if (problem) throw new AppError("ORDER_STATE", problem);
    const refund: ShopRefundDoc = {
      refundId: `rfs_${current._id.toHexString()}_full`,
      kind: "full",
      amount: current.price.total - refundedOf(current),
      vendor: vendorLeftOf(current),
      ruxstar: ruxstarShareOf(current),
      reason,
      by: by.kind,
      status: "pending",
      at: now,
    };
    const trip = tripActive(current);
    const done = await db.shopOrders.findOneAndUpdate(
      { _id: current._id, status: current.status, updatedAt: current.updatedAt },
      {
        $set: {
          status: "cancelled",
          acceptBy: null,
          stockTaken: false,
          releaseAt: null,
          cancellation: { by: by.kind, actorId: by.actor.id, reason, at: now },
          ...(trip ? { "delivery.status": "cancelled" } : {}),
          updatedAt: now,
        },
        $push: { timeline: { status: "cancelled", at: now, by: by.kind }, refunds: refund },
      },
      { session, returnDocument: "after" },
    );
    if (!done) throw new AppError("CONFLICT", "This order just changed. Try again.");
    if (current.stockTaken) await returnStock(db, current, session);
    for (const line of shopLedger("refund", done, now)) await db.ledgerEntries.insertOne(line, { session });
    const credited = await creditOrder(db, "shop_order", done._id, { id: refund.refundId, reason, amount: null }, session);
    if (credited.length) done.invoices = [...(done.invoices ?? []), ...credited];
    await giveBack(db, done, session);
    if (trip) await stopTrip(db, session, current, TRIP_BY[by.kind], reason);
    if (by.kind !== "system") await audit(db, by, current, "shop_order.cancel", { status: { from: current.status, to: "cancelled" }, reason: { from: null, to: reason } }, session);
    return { done, trip: trip ? current.delivery! : null };
  });
  const after = await askShopRefund(app, db, result.done);
  const no = `#${o.orderNo}`;
  const actor = by.actor.id ?? o.customerId;
  if (result.trip?.rider) {
    await notifyRider(db, app.log, {
      to: [result.trip.rider.id],
      actor,
      type: "delivery.updated",
      jobId: result.trip.jobId,
      title: "Delivery cancelled",
      body: `Order #${o.orderNo} was cancelled. ${result.trip.status === "picked_up" ? "Take it back to the shop." : "You don't need to pick it up."}`,
    });
  }
  if (by.kind !== "customer") {
    await notifyShop(db, app.log, {
      actor,
      type: "shop.updated",
      title: `Order ${no} cancelled`,
      body: `${reason} Your ${rupees(o.price.total)} is being refunded.`,
      to: [{ userId: o.customerId, link: orderLink(o) }],
    });
  }
  if (by.kind !== "vendor") {
    await notifyShop(db, app.log, {
      actor,
      type: "shop.updated",
      title: `Order ${no} cancelled`,
      body: by.kind === "customer" ? `${o.customerName} cancelled it. The stock is back.` : `${reason} The customer is refunded and the stock is back.`,
      to: await shopPeople(db, o),
    });
  }
  return after;
}

// Moving an order on.

const NEXT: Partial<Record<ShopOrderStatus, ShopOrderStatus[]>> = {
  paid: ["accepted"],
  accepted: ["packed"],
  packed: ["out_for_delivery", "ready_for_pickup"],
  out_for_delivery: ["delivered"],
  ready_for_pickup: ["delivered"],
};

/** Why the shop can't move the order to `to`, or null when it can. */
export function moveProblem(o: Pick<ShopOrderDoc, "status" | "method" | "delivery">, to: ShopOrderStatus): string | null {
  if (!NEXT[o.status]?.includes(to)) return o.status === "cancelled" ? "This order is cancelled." : o.status === "delivered" ? "It's delivered already." : "Orders go accepted, packed, then out for delivery or ready for pickup, then delivered.";
  if (to === "out_for_delivery" && o.method === "pickup") return "This order is for pickup. Mark it ready for pickup.";
  if (to === "ready_for_pickup" && o.method === "delivery") return "This order is for delivery. Send it out for delivery.";
  if (tripActive(o) && (to === "out_for_delivery" || to === "delivered")) return "A rider has this delivery. Cancel it first to deliver the order yourself.";
  return null;
}

const NEWS: Partial<Record<ShopOrderStatus, (o: ShopOrderDoc) => [string, string]>> = {
  accepted: (o) => ["Order accepted", `${o.businessName} has your order and is getting it ready.`],
  packed: (o) => ["Packed", o.method === "pickup" ? "Your order is packed." : "Your order is packed and will be on its way soon."],
  out_for_delivery: (o) => ["On the way", `${o.businessName} is delivering your order.`],
  ready_for_pickup: (o) => ["Ready for pickup", `Collect it from ${o.businessName}. Show the order number #${o.orderNo}.`],
  delivered: (o) => [
    o.method === "pickup" ? "Picked up" : "Delivered",
    o.returnRule ? `Something wrong? You can ask for a return within ${count(o.returnRule.days, "day")}. Rate what you bought.` : "Enjoy it, and rate what you bought.",
  ],
};

/**
 * Moves an order on, once: only from the step it was read at. Delivery starts the return window and sets when the shop's
 * money is released.
 */
export async function moveShopOrder(
  app: FastifyInstance,
  db: Database,
  o: ShopOrderDoc,
  to: ShopOrderStatus,
  by: By,
  extra: {
    set?: Record<string, unknown>;
    inside?: (session: ClientSession, after: ShopOrderDoc) => Promise<void>;
    /** What the customer is told instead of the usual line; null tells them nothing. */
    news?: [string, string] | null;
  } = {},
): Promise<ShopOrderDoc> {
  const now = new Date();
  const set: Record<string, unknown> = { ...extra.set, status: to, updatedAt: now };
  if (to === "accepted") set.acceptBy = null;
  if (to === "delivered") {
    const settings = await shopSettings(db);
    set.deliveredAt = now;
    set.returnUntil = o.returnRule ? new Date(now.getTime() + o.returnRule.days * DAY_MS) : null;
    set.releaseAt = releaseAtOf(o, now, settings);
  }
  const moved = await db.transaction(async (session) => {
    const after = await db.shopOrders.findOneAndUpdate(
      { _id: o._id, status: o.status },
      { $set: set, $push: { timeline: { status: to, at: now, by: by.kind } } },
      { session, returnDocument: "after" },
    );
    if (!after) return null;
    if (extra.inside) await extra.inside(session, after);
    if (by.kind !== "system") await audit(db, by, o, "shop_order.status", { status: { from: o.status, to } }, session);
    return after;
  });
  if (!moved) {
    const current = await db.shopOrders.findOne({ _id: o._id });
    if (current?.status === to) return current;
    throw new AppError("ORDER_STATE");
  }
  const news = extra.news !== undefined ? extra.news : (NEWS[to]?.(moved) ?? null);
  if (news) {
    await notifyShop(db, app.log, {
      actor: by.actor.id ?? moved.vendorId,
      type: "shop.updated",
      title: `${news[0]}: #${moved.orderNo}`,
      body: news[1],
      to: [{ userId: moved.customerId, link: orderLink(moved) }],
    });
  }
  return moved;
}

/** The shop moves its order on, step by step. */
export async function shopMove(app: FastifyInstance, db: Database, o: ShopOrderDoc, to: ShopOrderStatus, by: By): Promise<ShopOrderDoc> {
  const problem = moveProblem(o, to);
  if (problem) throw new AppError("ORDER_STATE", problem);
  return moveShopOrder(app, db, o, to, by);
}

// Returns.

const SHOP_FAULT: ShopReturnReason[] = ["wrong_item", "damaged"];

/** Whether the customer can ask for a return now. */
export function returnProblem(o: Pick<ShopOrderDoc, "status" | "returnRule" | "returnUntil" | "return" | "releasedAt">, now = new Date()): string | null {
  if (!o.returnRule) return "This shop doesn't take returns.";
  if (o.status !== "delivered") return "You can ask for a return once it's delivered.";
  if (o.return) return "You've asked for a return already.";
  if (!o.returnUntil || now > o.returnUntil || o.releasedAt) return `Returns close ${count(o.returnRule.days, "day")} after delivery.`;
  return null;
}

/**
 * The customer asks to return some or all of what they got. The shop's money waits until it's settled. When the shop sent the
 * wrong or a damaged item it pays the trip back; otherwise one delivery fee comes off the refund.
 */
export async function requestReturn(
  app: FastifyInstance,
  db: Database,
  o: ShopOrderDoc,
  by: By,
  input: { reason: ShopReturnReason; note?: string | undefined; lines?: { lineId: string; quantity: number }[] | undefined },
): Promise<ShopOrderDoc> {
  const now = new Date();
  const problem = returnProblem(o, now);
  if (problem) throw new AppError("ORDER_STATE", problem);
  const picked = (input.lines ?? o.lines.map((l) => ({ lineId: l.id.toHexString(), quantity: l.quantity }))).map((p, i) => {
    const line = o.lines.find((l) => l.id.toHexString() === p.lineId);
    if (!line) throw invalid(`body/lines/${i}/lineId`, "This isn't in the order.");
    if (p.quantity > line.quantity) throw invalid(`body/lines/${i}/quantity`, `You got ${line.quantity} of ${lineLabel(line)}.`);
    return { lineId: line.id, quantity: p.quantity };
  });
  if (new Set(picked.map((p) => p.lineId.toHexString())).size !== picked.length) throw invalid("body/lines", "Each item once, with how many.");
  const tripPaidBy = SHOP_FAULT.includes(input.reason) ? "shop" : "customer";
  const split = returnSplit(o, picked, tripPaidBy);
  const done = await db.shopOrders.findOneAndUpdate(
    { _id: o._id, status: "delivered", return: null, releasedAt: null, returnUntil: { $gte: now } },
    {
      $set: {
        return: {
          reason: input.reason,
          note: input.note?.trim() || null,
          lines: picked,
          status: "requested",
          tripPaidBy,
          tripFee: split.tripFee,
          amount: split.amount,
          requestedAt: now,
          decision: null,
          receivedAt: null,
        },
        updatedAt: now,
      },
    },
    { returnDocument: "after" },
  );
  if (!done) throw new AppError("ORDER_STATE", "Returns for this order have closed.");
  await audit(db, by, done, "shop_order.return_request", { return: { from: null, to: input.reason } });
  await notifyShop(db, app.log, {
    actor: o.customerId,
    type: "shop.updated",
    title: `Return asked: #${o.orderNo}`,
    body: `${o.customerName}: ${input.reason.replace(/_/g, " ")}${input.note ? `, "${input.note.trim()}"` : ""}. ${rupees(split.amount)} back once you receive it. Your money for this order waits until it's settled.`,
    to: await shopPeople(db, o, "store.returns"),
  });
  return done;
}

/** The shop (or Ruxstar) agrees to a return, or turns it down. A turned-down return can still be taken to Ruxstar. */
export async function decideReturn(app: FastifyInstance, db: Database, o: ShopOrderDoc, by: By, decision: "approve" | "reject", note: string | null): Promise<ShopOrderDoc> {
  const from = o.return?.status;
  const open = from === "requested" || (by.kind === "staff" && from === "rejected" && decision === "approve");
  if (!o.return || !open) throw new AppError("ORDER_STATE", o.return ? "This return has been settled already." : "There's no return on this order.");
  const now = new Date();
  const status = decision === "approve" ? "approved" : "rejected";
  const done = await db.shopOrders.findOneAndUpdate(
    { _id: o._id, "return.status": from!, releasedAt: null },
    { $set: { "return.status": status, "return.decision": { by: by.kind, actorId: by.actor.id, note, at: now }, updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!done) throw new AppError("ORDER_STATE");
  await audit(db, by, done, "shop_order.return_decide", { return: { from, to: status }, ...(note ? { note: { from: null, to: note } } : {}) });
  const who = by.kind === "staff" ? "Ruxstar" : o.businessName;
  await notifyShop(db, app.log, {
    actor: by.actor.id ?? o.vendorId,
    type: "shop.updated",
    title: decision === "approve" ? `Return accepted: #${o.orderNo}` : `Return turned down: #${o.orderNo}`,
    body:
      decision === "approve"
        ? `${who} will take it back${o.return.tripPaidBy === "shop" ? " and pays for the trip" : ""}. ${rupees(o.return.amount)} is refunded once they have it.${note ? ` ${note}` : ""}`
        : `${who}: ${note ?? "The return was turned down."}${by.kind === "staff" ? "" : " If you think that's wrong, contact Ruxstar support."}`,
    to: [{ userId: o.customerId, link: orderLink(o) }],
  });
  if (by.kind === "staff") {
    await notifyShop(db, app.log, {
      actor: by.actor.id ?? o.vendorId,
      type: "shop.updated",
      title: `Ruxstar ${decision === "approve" ? "accepted" : "turned down"} return #${o.orderNo}`,
      body: note ?? "",
      to: await shopPeople(db, o, "store.returns"),
    });
  }
  return done;
}

/** The returned items are back at the shop: the customer is refunded, out of the shop's pending share and Ruxstar's. */
export async function refundReturn(app: FastifyInstance, db: Database, o: ShopOrderDoc, by: By, note: string | null = null): Promise<ShopOrderDoc> {
  const from = o.return?.status;
  const allowed = from === "requested" || from === "approved" || (by.kind === "staff" && from === "rejected");
  if (!o.return || !allowed) throw new AppError("ORDER_STATE", o.return ? "This return has been settled already." : "There's no return on this order.");
  if (o.releasedAt) throw new AppError("ORDER_STATE", "The money for this order has been released, so the return can't be refunded here. Contact support.");
  const now = new Date();
  const split = returnSplit(o, o.return.lines, o.return.tripPaidBy);
  const refund: ShopRefundDoc | null =
    split.amount > 0
      ? { refundId: `rfs_${o._id.toHexString()}_return`, kind: "return", amount: split.amount, vendor: split.vendor, ruxstar: split.ruxstar, reason: o.return.reason, by: by.kind, status: "pending", at: now }
      : null;
  const done = await db.transaction(async (session) => {
    const after = await db.shopOrders.findOneAndUpdate(
      { _id: o._id, "return.status": from!, releasedAt: null },
      {
        $set: {
          "return.status": "refunded",
          "return.receivedAt": now,
          ...(o.return!.decision ? {} : { "return.decision": { by: by.kind, actorId: by.actor.id, note, at: now } }),
          updatedAt: now,
        },
        ...(refund ? { $push: { refunds: refund } } : {}),
      },
      { session, returnDocument: "after" },
    );
    if (!after) throw new AppError("ORDER_STATE");
    if (refund) {
      for (const entry of returnLedger(after, refund)) await db.ledgerEntries.insertOne(entry, { session });
      const credited = await creditOrder(db, "shop_order", after._id, { id: refund.refundId, reason: refund.reason, amount: refund.amount }, session);
      if (credited.length) after.invoices = [...(after.invoices ?? []), ...credited];
    }
    await audit(db, by, after, "shop_order.return_refund", { return: { from, to: "refunded" }, refund: { from: 0, to: split.amount } }, session);
    return after;
  });
  const after = refund ? await askShopRefund(app, db, done) : done;
  await notifyShop(db, app.log, {
    actor: by.actor.id ?? o.vendorId,
    type: "shop.updated",
    title: `Return refunded: #${o.orderNo}`,
    body: refund ? `${rupees(split.amount)} is on its way back to you${split.tripFee ? `, less ${rupees(split.tripFee)} for the trip back` : ""}.` : "The return is settled.",
    to: [{ userId: o.customerId, link: orderLink(o) }],
  });
  await releaseShopShares(app, db, { _id: o._id }, now);
  return (await db.shopOrders.findOne({ _id: o._id })) ?? after;
}

// Money and timers.

const OPEN_RETURN = ["requested", "approved"];

/** Delivered orders past their release time, with no return open, pay the shop's share into its available balance. */
export async function releaseShopShares(app: FastifyInstance, db: Database, filter: { vendorId?: ObjectId; _id?: ObjectId }, now = new Date()): Promise<number> {
  const due = await db.shopOrders
    .find({ ...filter, status: "delivered", releaseAt: { $lte: now }, releasedAt: null, "return.status": { $nin: OPEN_RETURN } })
    .limit(100)
    .toArray();
  let released = 0;
  for (const o of due) {
    released += await db
      .transaction(async (session) => {
        const done = await db.shopOrders.findOneAndUpdate(
          { _id: o._id, releaseAt: { $lte: now }, releasedAt: null, "return.status": { $nin: OPEN_RETURN } },
          { $set: { releasedAt: now, releaseAt: null, updatedAt: now } },
          { session, returnDocument: "after" },
        );
        if (!done) return 0;
        for (const entry of shopLedger("release", done, now)) await db.ledgerEntries.insertOne(entry, { session });
        return 1;
      })
      .catch((err: unknown) => {
        app.log.warn({ err: (err as Error).message, order: o._id.toHexString() }, "Shop share not released; the next sweep retries it");
        return 0;
      });
  }
  return released;
}

/** The shop timers: unpaid checkouts past their time, paid orders not accepted in time, shares due, refunds to retry. */
export async function sweepShop(app: FastifyInstance, db: Database) {
  const now = new Date();
  let holds = 0;
  for (const o of await db.shopOrders.find({ status: "awaiting_payment", holdUntil: { $lte: now } }).limit(100).toArray()) {
    const after = await syncShopPayment(app, db, o).catch(() => o);
    if (after.status !== "awaiting_payment") holds++;
  }
  let unaccepted = 0;
  for (const o of await db.shopOrders.find({ status: "paid", acceptBy: { $lte: now } }).limit(100).toArray()) {
    try {
      await cancelShopOrder(app, db, o, SYSTEM, `${o.businessName} didn't accept it in time.`);
      unaccepted++;
    } catch (err) {
      app.log.warn({ err: (err as Error).message, order: o._id.toHexString() }, "Unaccepted shop order not cancelled; the next sweep retries it");
    }
  }
  const releases = await releaseShopShares(app, db, {}, now);
  let refunds = 0;
  for (const o of await db.shopOrders.find({ "refunds.status": "pending" }).limit(100).toArray()) {
    const after = await askShopRefund(app, db, o);
    if (!after.refunds.some((r) => r.status === "pending")) refunds++;
  }
  return { shopHolds: holds, shopUnaccepted: unaccepted, shopReleases: releases, shopRefunds: refunds };
}

/** Reads catch an order up themselves, so a missed sweep doesn't leave a checkout, an unaccepted order or a share waiting. */
export async function freshShop(app: FastifyInstance, db: Database, list: ShopOrderDoc[]): Promise<ShopOrderDoc[]> {
  const now = new Date();
  const out: ShopOrderDoc[] = [];
  for (const o of list) {
    let current = o;
    if (current.status === "awaiting_payment" && current.holdUntil && current.holdUntil <= now) current = await syncShopPayment(app, db, current).catch(() => current);
    if (current.status === "paid" && current.acceptBy && current.acceptBy <= now) {
      current = await cancelShopOrder(app, db, current, SYSTEM, `${current.businessName} didn't accept it in time.`).catch(() => current);
    }
    if (current.status === "delivered" && current.releaseAt && current.releaseAt <= now && !current.releasedAt) {
      await releaseShopShares(app, db, { _id: current._id }, now);
      current = (await db.shopOrders.findOne({ _id: current._id })) ?? current;
    }
    out.push(current);
  }
  return out;
}
