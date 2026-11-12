import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ObjectId, type ClientSession } from "mongodb";
import { PDFDocument } from "pdf-lib";
import { writeAudit } from "../../platform/audit.js";
import type { AuditLogDoc, BusinessDoc, Database, LedgerEntryDoc, PodOrderDoc, PodOrderStatus, PrintFileDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { isModuleLive } from "../../platform/module-switch.js";
import { notifyOrder } from "../notifications/notify.js";
import { unpricedOf } from "../vendor/businesses.js";
import { productOf, type PodProduct } from "../vendor/catalog.js";
import type { Order, ShopOrder } from "./contracts.js";
import { visibleShops } from "./shops.js";

/** Cashfree takes up to ₹5,00,000 in one payment. */
const MAX_ORDER_TOTAL = 5_00_000_00;

export const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const invalid = (path: string, message: string) => new AppError("ORDER_INVALID", message, [{ path, message }]);

// Files.

const EXTENSION: Record<PrintFileDoc["contentType"], string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };

/** The type from the first bytes, whatever the upload claimed. */
export function sniff(data: Buffer): PrintFileDoc["contentType"] | null {
  if (data.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  return null;
}

export async function countPages(data: Buffer, type: PrintFileDoc["contentType"]): Promise<number> {
  if (type !== "application/pdf") return 1;
  try {
    const pdf = await PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false });
    const pages = pdf.getPageCount();
    if (pages < 1) throw new Error("no pages");
    return pages;
  } catch {
    throw new AppError("FILE_INVALID", "This PDF can't be opened. Save it again and retry.");
  }
}

export const fileKey = (userId: ObjectId, fileId: ObjectId, type: PrintFileDoc["contentType"]) =>
  `print/${userId.toHexString()}/${fileId.toHexString()}.${EXTENSION[type]}`;

/** Names are kept for the shop, without paths or control characters. */
export function cleanName(header: unknown, type: PrintFileDoc["contentType"]): string {
  let name = typeof header === "string" ? header : "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // Keep it as sent.
  }
  name = name
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 120);
  return name || `file.${EXTENSION[type]}`;
}

/** The customer's own files, not yet in another order. */
export async function filesFor(db: Database, userId: ObjectId, ids: string[]): Promise<PrintFileDoc[]> {
  if (!ids.length) return [];
  const objectIds = ids.map((id) => new ObjectId(id));
  const docs = await db.printFiles.find({ _id: { $in: objectIds }, userId, orderId: null }).toArray();
  const byId = new Map(docs.map((d) => [d._id.toHexString(), d]));
  return ids.map((id, i) => {
    const doc = byId.get(id);
    if (!doc) throw invalid(`body/fileIds/${i}`, "This file is gone. Upload it again.");
    return doc;
  });
}

// Shops and prices.

export async function orderableShop(db: Database, shopId: string, customerId: ObjectId): Promise<BusinessDoc> {
  const shop = await db.businesses.findOne({ ...visibleShops, _id: new ObjectId(shopId) });
  if (!shop?.pod || !(await isModuleLive(db, "pod"))) throw new AppError("NOT_FOUND", "This shop is not on Ruxstar right now.");
  if (shop.ownerId.equals(customerId)) throw invalid("body/shopId", "You can't order from your own shop.");
  return shop;
}

export function deliversTo(shop: BusinessDoc, city: string): boolean {
  const name = city.trim().toLowerCase();
  return !!shop.pod && (shop.pod.serveAll || shop.pod.cities.includes(name) || shop.location?.city.toLowerCase() === name);
}

export interface Choice {
  product: PodProduct;
  options: Record<string, string>;
  colour?: "bw" | "color" | undefined;
  quantity: number;
}

export async function chargesOf(db: Database): Promise<{ commissionBps: number; platformFee: number }> {
  const settings = await db.moduleSettings.findOne({ module: "pod" });
  return { commissionBps: settings?.commissionBps ?? 0, platformFee: settings?.platformFee ?? 0 };
}

/**
 * What an order costs. A unit is a piece, or a page of one copy for documents. The bulk tier with the
 * highest `from` the order reaches sets the unit price when it is lower; extras for the chosen
 * option values are added per unit; Ruxstar's platform fee is added once.
 */
export function priceOf(shop: BusinessDoc, choice: Choice, pages: number, charges: { commissionBps: number; platformFee: number }) {
  const pod = shop.pod!;
  const info = productOf(choice.product);
  const price = pod.prices.find((p) => p.product === choice.product);
  if (!price || !pod.products.includes(choice.product) || unpricedOf(pod).includes(choice.product)) {
    throw invalid("body/product", `${shop.name} doesn't print ${info.label} right now.`);
  }

  const options: Record<string, string> = {};
  for (const [option, value] of Object.entries(choice.options)) {
    const values = info.options[option as keyof typeof info.options];
    if (!values) throw invalid(`body/options/${option}`, `${info.label} has no ${option} option.`);
    if (!values.includes(value)) throw invalid(`body/options/${option}`, `${value} is not a ${option} for ${info.label}.`);
    options[option] = value;
  }
  const perPage = info.pricing === "per_page";
  const required = perPage ? "paperSize" : "size";
  if (info.options[required] && !options[required]) throw invalid(`body/options/${required}`, perPage ? "Choose a paper size." : "Choose a size.");

  let rate = price.basePrice ?? 0;
  let colour: "bw" | "color" | null = null;
  if (perPage) {
    if (!choice.colour) throw invalid("body/colour", "Choose black and white or colour.");
    colour = choice.colour;
    rate = (colour === "bw" ? price.bw : price.color) ?? 0;
    if (rate <= 0) throw invalid("body/colour", colour === "bw" ? "This shop prints in colour only." : "This shop prints in black and white only.");
  }

  const units = perPage ? Math.max(pages, 1) * choice.quantity : choice.quantity;
  const minimum = Math.max(price.minQuantity, info.minQuantity);
  if (units < minimum) throw invalid("body/quantity", perPage ? `The smallest order is ${minimum} pages.` : `The smallest order is ${minimum}.`);

  const tier = [...price.tiers].sort((a, b) => b.from - a.from).find((t) => t.from <= units);
  const unitPrice = tier && tier.unitPrice > 0 ? Math.min(rate, tier.unitPrice) : rate;
  const extrasPerUnit = price.extras.filter((e) => options[e.option] === e.value).reduce((sum, e) => sum + e.price, 0);
  const items = units * (unitPrice + extrasPerUnit);
  if (items < pod.minOrder) throw invalid("body/quantity", `${shop.name}'s smallest order is ${rupees(pod.minOrder)}.`);
  const total = items + charges.platformFee;
  if (total > MAX_ORDER_TOTAL) throw invalid("body/quantity", "Orders over ₹5,00,000 can't be paid online. Split it into smaller orders.");

  return {
    label: info.label,
    pricing: info.pricing,
    options,
    colour,
    turnaroundDays: price.turnaroundDays ?? pod.turnaroundDays,
    minOrder: pod.minOrder,
    price: {
      units,
      unitPrice,
      extrasPerUnit,
      items,
      platformFee: charges.platformFee,
      total,
      commissionBps: charges.commissionBps,
      commission: Math.round((items * charges.commissionBps) / 10_000),
    },
  };
}

// Moving an order.

/** What a shop can move an order to from each step. Later steps can be skipped to; turning down is only before accepting. */
const SHOP_STEPS: PodOrderStatus[] = ["accepted", "printing", "ready", "out_for_delivery", "delivered"];
export function shopCanMove(from: PodOrderStatus, to: PodOrderStatus): boolean {
  if (to === "rejected") return from === "placed";
  if (from === "placed") return to === "accepted";
  const at = SHOP_STEPS.indexOf(from);
  return at >= 0 && SHOP_STEPS.indexOf(to) > at;
}

const vendorAccount = (order: PodOrderDoc) => `vendor:${order.vendorId.toHexString()}`;

/** Money each side is owed: the shop its items less commission, Ruxstar the commission and fee. */
function ledgerFor(kind: LedgerEntryDoc["kind"], order: PodOrderDoc, at: Date): LedgerEntryDoc[] {
  const shop = order.price.items - order.price.commission;
  const ruxstar = order.price.commission + order.price.platformFee;
  const rows: [string, LedgerEntryDoc["bucket"], number][] =
    kind === "payment"
      ? [
          [vendorAccount(order), "pending", shop],
          ["ruxstar", "pending", ruxstar],
          ["gateway", "withdrawable", -order.price.total],
        ]
      : kind === "release"
        ? [
            [vendorAccount(order), "pending", -shop],
            [vendorAccount(order), "withdrawable", shop],
            ["ruxstar", "pending", -ruxstar],
            ["ruxstar", "withdrawable", ruxstar],
          ]
        : [
            [vendorAccount(order), "pending", -shop],
            ["ruxstar", "pending", -ruxstar],
            ["gateway", "withdrawable", order.price.total],
          ];
  const txnId = `${kind}:${order._id.toHexString()}`;
  return rows
    .filter(([, , paise]) => paise !== 0)
    .map(([accountId, bucket, signedPaise]) => ({ txnId, kind, accountId, bucket, signedPaise, source: { type: "pod_order", id: order._id }, at }));
}

const CUSTOMER_NEWS: Partial<Record<PodOrderStatus, [string, string]>> = {
  accepted: ["Order accepted", "The shop has your order and will start soon."],
  printing: ["Being printed", "The shop is printing your order."],
  ready: ["Order ready", "Your order is ready and will be on its way soon."],
  out_for_delivery: ["On the way", "The shop is delivering your order."],
  delivered: ["Delivered", "Your order was delivered. Thanks for ordering on Ruxstar."],
};

/**
 * Moves an order on, once: the move only happens from the step it was read at. Money moves in the same
 * transaction. Refunds are asked for afterwards, and files start their 30-day countdown when an order ends.
 */
export async function moveOrder(
  app: FastifyInstance,
  db: Database,
  order: PodOrderDoc,
  to: PodOrderStatus,
  by: { kind: "customer" | "vendor" | "system"; actor: AuditLogDoc["actor"]; ip?: string | null },
  extra: { reason?: string | null; paymentId?: string | null } = {},
): Promise<PodOrderDoc> {
  const now = new Date();
  const refunding = order.status === "placed" && (to === "rejected" || to === "cancelled");
  const set: Partial<PodOrderDoc> = { status: to, updatedAt: now };
  if (to === "placed") {
    set.payment = { ...order.payment, paymentId: extra.paymentId ?? order.payment.paymentId, paidAt: now };
  }
  if (refunding) set.refund = { refundId: `rf_${order._id.toHexString()}`, amount: order.price.total, status: "pending", at: now };
  if (to === "rejected") set.reason = extra.reason ?? null;

  const moved = await db.transaction(async (session: ClientSession) => {
    const after = await db.podOrders.findOneAndUpdate(
      { _id: order._id, status: order.status },
      { $set: set, $push: { timeline: { status: to, at: now, by: by.kind } } },
      { session, returnDocument: "after" },
    );
    if (!after) return null;
    const kind = to === "placed" ? "payment" : to === "delivered" ? "release" : refunding ? "refund" : null;
    // One at a time: the driver refuses insertMany inside a transaction with a timeout.
    if (kind) for (const entry of ledgerFor(kind, after, now)) await db.ledgerEntries.insertOne(entry, { session });
    if (by.kind !== "system") {
      await writeAudit(
        db,
        {
          actor: by.actor,
          scope: { module: "pod", businessId: order.shopId },
          action: "pod_order.status",
          target: { type: "pod_order", id: order._id },
          diff: { status: { from: order.status, to } },
          ip: by.ip ?? null,
        },
        session,
      );
    }
    return after;
  });
  if (!moved) {
    const current = await db.podOrders.findOne({ _id: order._id });
    // A webhook and the customer's own check can confirm the same payment at once; both see it placed.
    if (current?.status === to) return current;
    throw new AppError("ORDER_STATE");
  }

  const result = refunding ? await askForRefund(app, db, moved) : moved;
  if (to === "delivered" || to === "rejected" || to === "cancelled") {
    await Promise.all(moved.files.map((f) => app.printFiles.expire(f.key)));
  }

  const actor = by.actor.id ?? moved.customerId;
  const no = `#${moved.orderNo}`;
  if (to === "placed") {
    await notifyOrder(db, app.log, {
      to: moved.vendorId,
      actor,
      orderId: moved._id,
      type: "order.placed",
      forShop: true,
      title: `New order ${no}`,
      body: `${moved.productLabel} × ${moved.quantity} for ${moved.address.city}. ${rupees(moved.price.items - moved.price.commission)} to you.`,
    });
  } else if (to === "cancelled" && refunding) {
    await notifyOrder(db, app.log, {
      to: moved.vendorId,
      actor,
      orderId: moved._id,
      type: "order.updated",
      forShop: true,
      title: `Order ${no} cancelled`,
      body: "The customer cancelled before you accepted it.",
    });
  } else if (to === "rejected") {
    await notifyOrder(db, app.log, {
      to: moved.customerId,
      actor,
      orderId: moved._id,
      type: "order.updated",
      forShop: false,
      title: `${moved.shopName} couldn't take order ${no}`,
      body: `${extra.reason ?? "The shop turned it down."} Your ${rupees(moved.price.total)} is being refunded.`,
    });
  } else if (CUSTOMER_NEWS[to]) {
    const [title, body] = CUSTOMER_NEWS[to]!;
    await notifyOrder(db, app.log, { to: moved.customerId, actor, orderId: moved._id, type: "order.updated", forShop: false, title: `${title}: ${no}`, body });
  }
  return result;
}

/** Asks the gateway for a refund, or how it is going. Safe to repeat; a failure leaves it pending for the next look. */
export async function askForRefund(app: FastifyInstance, db: Database, order: PodOrderDoc): Promise<PodOrderDoc> {
  if (!order.refund || order.refund.status === "done") return order;
  try {
    const { status } = await app.payments.refund(order.payment.gatewayOrderId, order.refund.refundId, order.refund.amount, `Ruxstar order #${order.orderNo}`);
    if (status === "pending") return order;
    const after = await db.podOrders.findOneAndUpdate(
      { _id: order._id, "refund.status": "pending" },
      { $set: { "refund.status": "done", updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    return after ?? order;
  } catch (err) {
    app.log.error({ err: (err as Error).message, order: order._id.toHexString() }, "Refund not started; it is retried when the order is next opened");
    return order;
  }
}

/** While an order waits for payment, asks the gateway whether it was paid, and places or cancels it. */
export async function syncPayment(app: FastifyInstance, db: Database, order: PodOrderDoc): Promise<PodOrderDoc> {
  if (order.status !== "awaiting_payment") return order.refund?.status === "pending" ? askForRefund(app, db, order) : order;
  let answer: Awaited<ReturnType<typeof app.payments.status>>;
  try {
    answer = await app.payments.status(order.payment.gatewayOrderId);
  } catch {
    return order;
  }
  const system = { kind: "system" as const, actor: { id: null, kind: "system" as const } };
  if (answer.status === "paid") return moveOrder(app, db, order, "placed", system, { paymentId: answer.paymentId });
  if (answer.status === "expired" || answer.status === "terminated") return moveOrder(app, db, order, "cancelled", system);
  return order;
}

// The checkout link.

const CHECKOUT_TTL_SECONDS = 60 * 60;
const FALLBACK_KEY = randomBytes(32);
/** Signs checkout and file links. Without a JWT secret nobody can sign in anyway, so links only need to work until a restart. */
export const signingKey = (app: FastifyInstance): Uint8Array => app.config.jwtSecret ?? FALLBACK_KEY;

/** Where the checkout page may send a customer back to: Ruxstar's sites and the app's own links. */
export function safeReturn(app: FastifyInstance, returnTo: string): string {
  let url: URL;
  try {
    url = new URL(returnTo);
  } catch {
    throw new AppError("VALIDATION_FAILED", "returnTo must be a full link.", [{ path: "body/returnTo", message: "Not a link" }]);
  }
  const origins = new Set([app.config.siteUrl, ...app.config.corsOrigins]);
  const appLink = ["exp:", "exps:", "ruxstar:"].includes(url.protocol);
  if (!appLink && !origins.has(url.origin)) {
    throw new AppError("VALIDATION_FAILED", "returnTo must be on Ruxstar.", [{ path: "body/returnTo", message: "Not allowed" }]);
  }
  return url.toString();
}

export function checkoutToken(key: Uint8Array, orderId: string, back: string, exp: number): string {
  return createHmac("sha256", key).update(`${orderId}.${exp}.${back}`).digest("base64url");
}

export function checkoutTokenValid(key: Uint8Array, orderId: string, back: string, exp: number, token: string): boolean {
  if (!Number.isInteger(exp) || exp * 1000 < Date.now()) return false;
  const expected = Buffer.from(checkoutToken(key, orderId, back, exp));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** This API's own origin: the configured one, or the one the caller reached it on. */
export const apiOrigin = (app: FastifyInstance, request: { protocol: string; host: string }) =>
  app.config.apiUrl ?? `${request.protocol}://${request.host}`;

export function checkoutUrl(app: FastifyInstance, key: Uint8Array, request: { protocol: string; host: string }, orderId: string, back: string): string {
  const exp = Math.floor(Date.now() / 1000) + CHECKOUT_TTL_SECONDS;
  const query = new URLSearchParams({ exp: String(exp), back, t: checkoutToken(key, orderId, back, exp) });
  return `${apiOrigin(app, request)}/pay/${orderId}?${query.toString()}`;
}

// File links: short-lived and signed, so a browser can open a file without the API's headers.

const FILE_LINK_SECONDS = 10 * 60;
const fileSignature = (key: Uint8Array, orderId: string, fileId: string, exp: number) =>
  createHmac("sha256", key).update(`file.${orderId}.${fileId}.${exp}`).digest("base64url");

export function fileLink(app: FastifyInstance, key: Uint8Array, request: { protocol: string; host: string }, orderId: string, fileId: string) {
  const exp = Math.floor(Date.now() / 1000) + FILE_LINK_SECONDS;
  const query = new URLSearchParams({ exp: String(exp), t: fileSignature(key, orderId, fileId, exp) });
  return { url: `${apiOrigin(app, request)}/print-files/${orderId}/${fileId}?${query.toString()}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function fileLinkValid(key: Uint8Array, orderId: string, fileId: string, exp: number, token: string): boolean {
  if (!Number.isInteger(exp) || exp * 1000 < Date.now()) return false;
  const expected = Buffer.from(fileSignature(key, orderId, fileId, exp));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const withOrder = (back: string, orderId: string) => {
  const url = new URL(back);
  url.searchParams.set("order", orderId);
  return url.toString();
};

// Views.

const core = (doc: PodOrderDoc) => ({
  id: doc._id.toHexString(),
  orderNo: doc.orderNo,
  shop: { id: doc.shopId.toHexString(), name: doc.shopName },
  product: doc.product,
  productLabel: doc.productLabel,
  pricing: doc.pricing,
  options: doc.options,
  colour: doc.colour,
  quantity: doc.quantity,
  files: doc.files.map((f) => ({ id: f.id.toHexString(), name: f.name, contentType: f.contentType, bytes: f.bytes, pages: f.pages })),
  address: doc.address,
  note: doc.note,
  status: doc.status,
  timeline: doc.timeline.map((t) => ({ status: t.status, at: t.at.toISOString() })),
  paidAt: doc.payment.paidAt?.toISOString() ?? null,
  refund: doc.refund ? { amount: doc.refund.amount, status: doc.refund.status } : null,
  reason: doc.reason,
  createdAt: doc.createdAt.toISOString(),
  updatedAt: doc.updatedAt.toISOString(),
});

const customerPrice = ({ units, unitPrice, extrasPerUnit, items, platformFee, total }: PodOrderDoc["price"]) => ({
  units,
  unitPrice,
  extrasPerUnit,
  items,
  platformFee,
  total,
});

export const orderView = (doc: PodOrderDoc): Order => ({ ...core(doc), price: customerPrice(doc.price) });

export const shopOrderView = (doc: PodOrderDoc): ShopOrder => ({
  ...core(doc),
  price: {
    ...customerPrice(doc.price),
    commissionBps: doc.price.commissionBps,
    commission: doc.price.commission,
    payout: doc.price.items - doc.price.commission,
  },
});
