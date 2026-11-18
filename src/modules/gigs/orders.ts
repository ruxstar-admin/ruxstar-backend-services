import type { FastifyInstance } from "fastify";
import { ObjectId, type ClientSession, type WithId } from "mongodb";
import { writeAudit } from "../../platform/audit.js";
import type {
  AuditLogDoc,
  BusinessDoc,
  Database,
  GigActor,
  GigDoc,
  GigFileRef,
  GigOrderDoc,
  GigQuoteDoc,
  GigRefundDoc,
  GigTier,
  NotificationDoc,
  SupportMessageDoc,
  SupportTicketDoc,
} from "../../platform/db.js";
import { stamp } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { checkCode, giveBack, redeem } from "../coupons/coupons.js";
import { creditOrder, invoiceGigOrder } from "../invoices/issue.js";
import { notifyGigs } from "../notifications/notify.js";
import { rupees } from "../pod/orders.js";
import { dueAt, gigOrderContext, nextTicketNo, slaHours } from "../support/tickets.js";
import { expireQuotes, quoteClosed, touchQuote } from "./quotes.js";
import {
  DAY_MS,
  gigLedger,
  gigsSettings,
  HOUR_MS,
  MAX_ORDER_TOTAL,
  maxPartRefundOf,
  MB,
  nextGigOrderNo,
  partRefundLedger,
  PAY_WINDOW_MS,
  refundedOf,
  ruxstarShareOf,
  UNUSED_FILE_MS,
  vendorLeftOf,
  vendorShareOf,
  type GigsSettings,
} from "./rules.js";

export interface By {
  kind: GigActor;
  actor: AuditLogDoc["actor"];
  ip?: string | null;
}
export const SYSTEM: By = { kind: "system", actor: { id: null, kind: "system" } };

type Link = NotificationDoc["link"];

const invalid = (path: string, message: string) => new AppError("ORDER_INVALID", message, [{ path, message }]);
export const when = (at: Date) =>
  at.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
export const orderLink = (o: Pick<GigOrderDoc, "_id">): Link => ({ screen: "gig_order", id: o._id.toHexString() });
export const deskLink = (o: Pick<GigOrderDoc, "_id">): Link => ({ screen: "vendor_gig_order", id: o._id.toHexString() });
/** Orders that are paid and not settled: the freelancer's work, or Ruxstar's decision, is still to come. */
export const OPEN_STATUSES = ["paid", "in_progress", "delivered", "disputed"] as const;

const tellCustomer = (app: FastifyInstance, db: Database, o: GigOrderDoc, actor: ObjectId, title: string, body: string) =>
  notifyGigs(db, app.log, { actor, type: "gigs.updated", title, body, to: [{ userId: o.customerId, link: orderLink(o) }] });
const tellFreelancer = (app: FastifyInstance, db: Database, o: GigOrderDoc, actor: ObjectId, title: string, body: string, type: "gigs.ordered" | "gigs.updated" = "gigs.updated") =>
  notifyGigs(db, app.log, { actor, type, title, body, to: [{ userId: o.vendorId, link: deskLink(o) }] });

function audit(db: Database, by: By, o: GigOrderDoc, action: string, diff: AuditLogDoc["diff"], session?: ClientSession) {
  return writeAudit(db, { actor: by.actor, scope: { module: "gigs", businessId: o.businessId }, action, target: { type: "gig_order", id: o._id }, diff, ip: by.ip ?? null }, session);
}

/** Files a person uploaded and hasn't used yet, for `use`, checked against Ruxstar's count and size limits. */
export async function unusedFiles(
  db: Database,
  userId: ObjectId,
  ids: string[],
  use: "brief" | "delivery",
  limits: Pick<GigsSettings, "deliveryMaxMb" | "maxFiles">,
  path: string,
): Promise<GigFileRef[]> {
  if (!ids.length) return [];
  const maxMb = limits.deliveryMaxMb;
  if (ids.length > limits.maxFiles) throw invalid(path, `Up to ${limits.maxFiles} file${limits.maxFiles === 1 ? "" : "s"}.`);
  const unique = [...new Set(ids)].map((id) => new ObjectId(id));
  const docs = await db.gigFiles.find({ _id: { $in: unique }, userId, use, orderId: null }).toArray();
  if (docs.length !== unique.length) throw invalid(path, "Some of these files are gone or used already. Upload them again.");
  const bytes = docs.reduce((s, f) => s + f.bytes, 0);
  if (bytes > maxMb * MB) throw invalid(path, `Files can add up to ${maxMb} MB.`);
  return docs.map((f) => ({ id: f._id, name: f.name, contentType: f.contentType, bytes: f.bytes }));
}

async function claimFiles(db: Database, files: GigFileRef[], orderId: ObjectId, session: ClientSession) {
  if (!files.length) return;
  const res = await db.gigFiles.updateMany({ _id: { $in: files.map((f) => f.id) }, orderId: null }, { $set: { orderId } }, { session });
  if (res.modifiedCount !== files.length) throw new AppError("CONFLICT", "Some of these files were used already. Upload them again.");
}

// Placing and paying.

export type Source =
  | { kind: "gig"; gig: WithId<GigDoc>; tier: GigTier; answers: { questionId: string; answer: string }[] }
  | { kind: "quote"; quote: WithId<GigQuoteDoc> };

/**
 * Makes an order for one package of a gig, or for a custom offer, waiting 20 minutes for its payment. A gig's order waits for
 * the freelancer to accept once paid; an offer's is accepted already.
 */
export async function placeOrder(
  app: FastifyInstance,
  db: Database,
  input: {
    source: Source;
    business: WithId<BusinessDoc>;
    customer: { id: ObjectId; phone: string; name: string | null };
    fileIds: string[];
    note: string | null;
    coupon?: string;
  },
): Promise<GigOrderDoc> {
  const { source, business, customer } = input;
  const settings = await gigsSettings(db);
  const now = new Date();
  if (business.ownerId.equals(customer.id)) throw invalid("body", "You can't order from yourself.");
  if (!customer.name) throw invalid("body", "Add your name to your profile first.");

  let title: string;
  let category: string;
  let pack: GigOrderDoc["package"];
  let answers: GigOrderDoc["answers"] = [];
  if (source.kind === "gig") {
    const { gig } = source;
    const chosen = gig.packages.find((p) => p.tier === source.tier);
    if (!chosen) throw invalid("body/tier", "This gig doesn't have that package.");
    for (const q of gig.questions) {
      const given = source.answers.find((a) => a.questionId === q.id)?.answer.trim() ?? "";
      if (q.required && !given) throw invalid("body/answers", `Answer "${q.text}".`);
      if (given.length > settings.maxAnswer) throw invalid("body/answers", `Keep the answer to "${q.text}" to ${settings.maxAnswer} characters.`);
      if (given) answers.push({ questionId: q.id, question: q.text, answer: given });
    }
    title = gig.title;
    category = gig.category;
    pack = { tier: chosen.tier, name: chosen.name, description: chosen.description, deliveryDays: chosen.deliveryDays, revisions: chosen.revisions };
  } else {
    const { quote } = source;
    if (!quote.customerId.equals(customer.id)) throw new AppError("NOT_FOUND", "Offer not found.");
    const closed = quoteClosed(quote, now.getTime());
    if (closed) throw new AppError("CONFLICT", closed);
    title = quote.title;
    category = quote.category;
    pack = { tier: null, name: "Custom offer", description: quote.description, deliveryDays: quote.deliveryDays, revisions: quote.revisions };
    answers = [];
  }
  const items = source.kind === "gig" ? source.gig.packages.find((p) => p.tier === source.tier)!.price : source.quote.price;
  const files = await unusedFiles(db, customer.id, input.fileIds, "brief", settings, "body/fileIds");

  let coupon: GigOrderDoc["price"]["coupon"] = null;
  let discount = 0;
  if (input.coupon) {
    const check = await checkCode(db, input.coupon, { module: "gigs", shop: { id: business._id, name: business.name }, customerId: customer.id, items });
    if (check.problem !== null) throw new AppError("COUPON_INVALID", check.problem, [{ path: "body/coupon", message: check.problem }]);
    coupon = { id: check.coupon._id, code: check.coupon.code, fundedBy: check.coupon.fundedBy };
    discount = check.discount;
  }
  const platformFee = settings.platformFee;
  const charged = coupon?.fundedBy === "vendor" ? items - discount : items;
  const total = items - discount + platformFee;
  if (total > MAX_ORDER_TOTAL) throw invalid("body", "Payments over ₹5,00,000 can't be made online.");

  const id = new ObjectId();
  const order: GigOrderDoc = {
    _id: id,
    orderNo: 0,
    customerId: customer.id,
    customerName: customer.name,
    businessId: business._id,
    vendorId: business.ownerId,
    businessName: business.name,
    gigId: source.kind === "gig" ? source.gig._id : null,
    quoteId: source.kind === "quote" ? source.quote._id : null,
    title,
    category,
    package: pack,
    answers,
    files,
    note: input.note?.trim() || null,
    price: { items, platformFee, discount, coupon, total, commissionBps: settings.commissionBps, commission: Math.round((charged * settings.commissionBps) / 10_000) },
    status: "awaiting_payment",
    timeline: [{ status: "awaiting_payment", at: now, by: "customer" }],
    payment: { gatewayOrderId: `rxg_${id.toHexString()}`, sessionId: "", paymentId: null, paidAt: null },
    holdUntil: new Date(now.getTime() + PAY_WINDOW_MS),
    acceptBy: null,
    acceptedAt: null,
    dueAt: null,
    revisionsUsed: 0,
    deliveries: [],
    deliveredAt: null,
    autoCompleteAt: null,
    completedAt: null,
    dispute: null,
    refunds: [],
    cancellation: null,
    releasedAt: null,
    filesUntil: null,
    filesDeletedAt: null,
    ...stamp(now),
  };
  await db.transaction(async (session) => {
    order.orderNo = await nextGigOrderNo(db, session);
    await db.gigOrders.insertOne(order, { session });
    await claimFiles(db, files, id, session);
  });

  if (total === 0) return confirmOrder(app, db, order, null);
  try {
    const origin = app.config.apiUrl;
    const { sessionId } = await app.payments.createOrder({
      orderId: order.payment.gatewayOrderId,
      amount: total,
      customer: { id: customer.id.toHexString(), phone: customer.phone.slice(-10), name: customer.name },
      note: `${title}: ${pack.name}`,
      returnUrl: origin ? `${origin}/pay/gigs/${id.toHexString()}/done` : null,
      notifyUrl: origin ? `${origin}/webhooks/cashfree` : null,
    });
    return (await db.gigOrders.findOneAndUpdate({ _id: id }, { $set: { "payment.sessionId": sessionId } }, { returnDocument: "after" })) ?? order;
  } catch (err) {
    await cancelOrder(app, db, order, SYSTEM, { reason: "The payment couldn't be set up.", gatewayKnown: false, quiet: true });
    throw err;
  }
}

/**
 * The payment went through: the money waits in pending until the order completes. A gig's order now waits `acceptHours` for
 * the freelancer; an offer's starts at once, unless the offer was withdrawn meanwhile, which refunds it. Safe to repeat.
 */
export async function confirmOrder(app: FastifyInstance, db: Database, order: GigOrderDoc, paymentId: string | null): Promise<GigOrderDoc> {
  const now = new Date();
  const settings = await gigsSettings(db);
  const offer = order.quoteId !== null;
  let offerGone = false;
  const after = await db.transaction(async (session) => {
    const set = offer
      ? { status: "in_progress" as const, acceptedAt: now, dueAt: new Date(now.getTime() + order.package.deliveryDays * DAY_MS) }
      : { status: "paid" as const, acceptBy: new Date(now.getTime() + settings.acceptHours * HOUR_MS) };
    const done = await db.gigOrders.findOneAndUpdate(
      { _id: order._id, status: "awaiting_payment" },
      {
        $set: { ...set, "payment.paymentId": paymentId, "payment.paidAt": now, holdUntil: null, updatedAt: now },
        $push: { timeline: { $each: [{ status: "paid", at: now, by: "system" }, ...(offer ? [{ status: "in_progress" as const, at: now, by: "system" as const }] : [])] } },
      },
      { session, returnDocument: "after" },
    );
    if (!done) return null;
    for (const entry of gigLedger("payment", done, now)) await db.ledgerEntries.insertOne(entry, { session });
    await redeem(db, done, session);
    const issued = await invoiceGigOrder(db, done, session);
    if (issued.length) done.invoices = [...(done.invoices ?? []), ...issued];
    if (offer) {
      // An offer that ran out while its checkout was open is still honoured; a withdrawn one isn't.
      const claimed = await db.gigQuotes.updateOne(
        { _id: done.quoteId!, $or: [{ status: "open" }, { status: "expired", expiresAt: { $gt: order.createdAt } }] },
        { $set: { status: "paid", orderId: done._id, updatedAt: now } },
        { session },
      );
      offerGone = !claimed.modifiedCount;
    }
    return done;
  });
  if (!after) return (await db.gigOrders.findOne({ _id: order._id })) ?? order;
  if (offer) {
    const quote = await db.gigQuotes.findOne({ _id: after.quoteId! }, { projection: { messageId: 1, conversationId: 1 } });
    if (quote) await touchQuote(db, quote);
  }
  if (offerGone) {
    return cancelOrder(app, db, after, SYSTEM, { reason: "The freelancer withdrew this offer before your payment went through." });
  }
  const share = vendorShareOf(after);
  await tellCustomer(
    app,
    db,
    after,
    after.customerId,
    `Order placed: ${after.title}`,
    offer
      ? `${after.businessName} has started. Due ${when(after.dueAt!)}.`
      : `${after.businessName} has until ${when(after.acceptBy!)} to accept, or you get everything back.`,
  );
  await tellFreelancer(
    app,
    db,
    after,
    after.customerId,
    offer ? `Your offer was paid: #${after.orderNo}` : `New order #${after.orderNo}`,
    offer
      ? `${after.customerName}, ${after.title}. Deliver by ${when(after.dueAt!)}. ${rupees(share)} to you when it completes.`
      : `${after.customerName}, ${after.title} (${after.package.name}). Accept by ${when(after.acceptBy!)}. ${rupees(share)} to you when it completes.`,
    "gigs.ordered",
  );
  return after;
}

/** Asks Cashfree for each pending refund, or how it's going. Safe to repeat; a failure is retried by the next sweep. */
export async function askGigRefund(app: FastifyInstance, db: Database, o: GigOrderDoc): Promise<GigOrderDoc> {
  let current = o;
  for (const refund of o.refunds.filter((r) => r.status === "pending")) {
    try {
      const { status } = await app.payments.refund(o.payment.gatewayOrderId, refund.refundId, refund.amount, `Ruxstar freelance order #${o.orderNo}`);
      if (status !== "done") continue;
      const after = await db.gigOrders.findOneAndUpdate(
        { _id: o._id },
        { $set: { "refunds.$[r].status": "done", updatedAt: new Date() } },
        { arrayFilters: [{ "r.refundId": refund.refundId }], returnDocument: "after" },
      );
      if (after) current = after;
    } catch (err) {
      app.log.error({ err: (err as Error).message, order: o._id.toHexString() }, "Freelance refund not started; it is retried on the next sweep");
    }
  }
  return current;
}

/** While an order waits for payment, asks Cashfree whether it was paid; once the 20 minutes are up, an unpaid one is cancelled. */
export async function syncGigPayment(app: FastifyInstance, db: Database, o: GigOrderDoc, { noExpiry = false }: { noExpiry?: boolean } = {}): Promise<GigOrderDoc> {
  if (o.status !== "awaiting_payment") return o.refunds.some((r) => r.status === "pending") ? askGigRefund(app, db, o) : o;
  let answer: Awaited<ReturnType<typeof app.payments.status>>;
  try {
    answer = await app.payments.status(o.payment.gatewayOrderId);
  } catch {
    return o;
  }
  if (answer.status === "paid") return confirmOrder(app, db, o, answer.paymentId);
  if (noExpiry) return o;
  if (answer.status === "expired" || answer.status === "terminated") return cancelOrder(app, db, o, SYSTEM, { reason: "The payment didn't go through.", gatewayKnown: false });
  if (o.holdUntil && o.holdUntil.getTime() <= Date.now()) return cancelOrder(app, db, o, SYSTEM, { reason: "The payment didn't finish in time." });
  return o;
}

// Cancelling.

/** Whether the customer can cancel for a full refund themselves: before it's accepted, or once it's late with nothing delivered. */
export function customerCanCancel(o: Pick<GigOrderDoc, "status" | "dueAt" | "deliveries">, now = new Date()): boolean {
  if (o.status === "awaiting_payment" || o.status === "paid") return true;
  return o.status === "in_progress" && !!o.dueAt && o.dueAt <= now && o.deliveries.length === 0;
}

/**
 * Cancels an order and refunds what's left of it in full, platform fee included. The customer can before it's accepted, or once
 * it's past its due date with nothing delivered; the freelancer any time until it completes; Ruxstar's decisions and take-downs
 * any time until the money is released. An unpaid order's payment is stopped at Cashfree first; if it was paid meanwhile, it
 * is confirmed instead.
 */
export async function cancelOrder(
  app: FastifyInstance,
  db: Database,
  order: GigOrderDoc,
  by: By,
  opts: { reason: string; gatewayKnown?: boolean; quiet?: boolean; decision?: NonNullable<GigOrderDoc["dispute"]>["decision"] },
): Promise<GigOrderDoc> {
  if (order.status === "cancelled") return order;
  if (order.status === "completed" || order.releasedAt) throw new AppError("ORDER_STATE", "This order is complete, so it can't be cancelled.");
  if (order.status === "disputed" && by.kind !== "staff") throw new AppError("ORDER_STATE", "Ruxstar is looking at the problem reported on this order.");
  if (by.kind === "customer" && !customerCanCancel(order)) {
    throw new AppError(
      "ORDER_STATE",
      order.status === "delivered"
        ? "It's delivered: approve it, ask for a revision or report a problem."
        : "The freelancer has started. You can cancel once it's past its due date, or contact support.",
    );
  }
  if (order.status === "awaiting_payment" && opts.gatewayKnown !== false && order.price.total > 0) {
    try {
      await app.payments.terminate(order.payment.gatewayOrderId);
    } catch {
      const now = await syncGigPayment(app, db, order, { noExpiry: true });
      if (now.status === "awaiting_payment") throw new AppError("PAYMENTS_UNAVAILABLE");
      if (by.kind === "customer" || by.kind === "system") return now;
      order = now;
    }
  }
  const now = new Date();
  const settings = await gigsSettings(db);
  const paid = !!order.payment.paidAt && order.price.total > 0;
  const amount = order.price.total - refundedOf(order);
  const refund: GigRefundDoc | null =
    paid && amount > 0
      ? {
          refundId: `rfg_${order._id.toHexString()}`,
          kind: "full",
          amount,
          vendor: vendorLeftOf(order),
          ruxstar: amount - vendorLeftOf(order),
          reason: opts.reason,
          by: by.kind,
          status: "pending",
          at: now,
        }
      : null;
  const hasFiles = order.files.length > 0 || order.deliveries.some((d) => d.files.length > 0);
  const after = await db.transaction(async (session) => {
    const done = await db.gigOrders.findOneAndUpdate(
      { _id: order._id, status: order.status, releasedAt: null },
      {
        $set: {
          status: "cancelled",
          cancellation: { by: by.kind, actorId: by.actor.id, reason: opts.reason, at: now },
          holdUntil: null,
          acceptBy: null,
          autoCompleteAt: null,
          filesUntil: hasFiles ? new Date(now.getTime() + settings.fileDays * DAY_MS) : null,
          ...(opts.decision ? { "dispute.decision": opts.decision } : {}),
          updatedAt: now,
        },
        $push: { timeline: { status: "cancelled", at: now, by: by.kind }, ...(refund ? { refunds: refund } : {}) },
      },
      { session, returnDocument: "after" },
    );
    if (!done) return null;
    if (paid) {
      for (const entry of gigLedger("refund", order, now)) await db.ledgerEntries.insertOne(entry, { session });
      await giveBack(db, done, session);
    }
    if (refund) {
      const credited = await creditOrder(db, "gig_order", done._id, { id: refund.refundId, reason: refund.reason, amount: null }, session);
      if (credited.length) done.invoices = [...(done.invoices ?? []), ...credited];
    }
    if (by.kind !== "system") {
      await audit(db, by, order, "gig_order.cancel", { status: { from: order.status, to: "cancelled" }, reason: { from: null, to: opts.reason } }, session);
    }
    return done;
  });
  if (!after) {
    const current = await db.gigOrders.findOne({ _id: order._id });
    if (current?.status === "cancelled") return current;
    throw new AppError("ORDER_STATE");
  }
  const result = refund ? await askGigRefund(app, db, after) : after;

  if (!opts.quiet && order.status !== "awaiting_payment") {
    const money = refund ? ` ${rupees(refund.amount)} is being refunded to you.` : "";
    const actor = by.actor.id ?? order.vendorId;
    if (by.kind === "customer") {
      await tellFreelancer(app, db, order, actor, `#${order.orderNo} cancelled`, `${order.customerName} cancelled ${order.title}. ${opts.reason}`);
    } else {
      await tellCustomer(app, db, order, actor, `${order.title}: order cancelled`, `${opts.reason}${money}`);
      if (by.kind !== "vendor") await tellFreelancer(app, db, order, actor, `#${order.orderNo} cancelled`, `${opts.reason} The customer gets everything back.`);
    }
  }
  return result;
}

// The freelancer's work.

/** The freelancer takes a paid order on: it is due its package's delivery days from now. */
export async function acceptOrder(app: FastifyInstance, db: Database, order: GigOrderDoc, by: By): Promise<GigOrderDoc> {
  if (order.status === "in_progress" && order.acceptedAt) return order;
  if (order.status !== "paid") throw new AppError("ORDER_STATE", "Only paid orders waiting for you can be accepted.");
  const now = new Date();
  if (order.acceptBy && order.acceptBy <= now) {
    await cancelOrder(app, db, order, SYSTEM, { reason: "The freelancer didn't accept in time." });
    throw new AppError("ORDER_STATE", "The time to accept ran out, so the customer was refunded.");
  }
  const due = new Date(now.getTime() + order.package.deliveryDays * DAY_MS);
  const after = await db.gigOrders.findOneAndUpdate(
    { _id: order._id, status: "paid" },
    { $set: { status: "in_progress", acceptedAt: now, dueAt: due, acceptBy: null, updatedAt: now }, $push: { timeline: { status: "in_progress", at: now, by: by.kind } } },
    { returnDocument: "after" },
  );
  if (!after) {
    const current = await db.gigOrders.findOne({ _id: order._id });
    if (current?.status === "in_progress") return current;
    throw new AppError("ORDER_STATE");
  }
  await audit(db, by, order, "gig_order.accept", { status: { from: "paid", to: "in_progress" } });
  await tellCustomer(app, db, after, order.vendorId, `${order.businessName} accepted your order`, `${order.title}. Due ${when(due)}.`);
  return after;
}

/** A delivery: a message, links and files. The customer then has `autoCompleteDays` to answer before it completes by itself. */
export async function deliverOrder(
  app: FastifyInstance,
  db: Database,
  order: GigOrderDoc,
  by: By,
  input: { message: string; links: string[]; fileIds: string[] },
): Promise<GigOrderDoc> {
  if (order.status !== "in_progress") throw new AppError("ORDER_STATE", order.status === "paid" ? "Accept the order first." : "This order can't take a delivery now.");
  const settings = await gigsSettings(db);
  const links = [...new Set(input.links.map((l) => l.trim()))];
  if (links.length > settings.maxLinks) throw invalid("body/links", `Up to ${settings.maxLinks} link${settings.maxLinks === 1 ? "" : "s"}.`);
  const files = await unusedFiles(db, order.vendorId, input.fileIds, "delivery", settings, "body/fileIds");
  const message = input.message.trim();
  if (!message) throw invalid("body/message", "Say what you're delivering.");
  const now = new Date();
  const autoCompleteAt = new Date(now.getTime() + settings.autoCompleteDays * DAY_MS);
  const delivery = { id: new ObjectId(), message, links, files, at: now, answer: null };
  const after = await db.transaction(async (session) => {
    const done = await db.gigOrders.findOneAndUpdate(
      { _id: order._id, status: "in_progress" },
      {
        $set: { status: "delivered", deliveredAt: now, autoCompleteAt, updatedAt: now },
        $push: { deliveries: delivery, timeline: { status: "delivered", at: now, by: by.kind } },
      },
      { session, returnDocument: "after" },
    );
    if (!done) throw new AppError("ORDER_STATE");
    await claimFiles(db, files, order._id, session);
    await audit(db, by, order, "gig_order.deliver", { status: { from: "in_progress", to: "delivered" }, files: { from: null, to: files.length } }, session);
    return done;
  });
  await tellCustomer(
    app,
    db,
    after,
    order.vendorId,
    `Delivered: ${order.title}`,
    `${order.businessName} delivered your order. Approve it, ask for a revision or report a problem by ${when(autoCompleteAt)}; after that it completes by itself.`,
  );
  return after;
}

/** Approving a delivery, or it completing by itself: the freelancer's share and Ruxstar's move to their available balances. */
export async function completeOrder(app: FastifyInstance, db: Database, order: GigOrderDoc, by: By, note: string | null = null): Promise<GigOrderDoc> {
  if (order.status === "completed") return order;
  if (order.status !== "delivered") throw new AppError("ORDER_STATE", "Only delivered orders can be approved.");
  const now = new Date();
  const settings = await gigsSettings(db);
  const last = order.deliveries.length - 1;
  const after = await db.transaction(async (session) => {
    const done = await db.gigOrders.findOneAndUpdate(
      { _id: order._id, status: "delivered", releasedAt: null },
      {
        $set: {
          status: "completed",
          completedAt: now,
          releasedAt: now,
          autoCompleteAt: null,
          filesUntil: new Date(now.getTime() + settings.fileDays * DAY_MS),
          ...(by.kind === "customer" && last >= 0 ? { [`deliveries.${last}.answer`]: { kind: "approved", note, at: now } } : {}),
          updatedAt: now,
        },
        $push: { timeline: { status: "completed", at: now, by: by.kind } },
      },
      { session, returnDocument: "after" },
    );
    if (!done) return null;
    for (const entry of gigLedger("release", done, now)) await db.ledgerEntries.insertOne(entry, { session });
    if (by.kind !== "system") await audit(db, by, order, "gig_order.approve", { status: { from: "delivered", to: "completed" } }, session);
    return done;
  });
  if (!after) {
    const current = await db.gigOrders.findOne({ _id: order._id });
    if (current?.status === "completed") return current;
    throw new AppError("ORDER_STATE");
  }
  const share = vendorLeftOf(after);
  await tellFreelancer(
    app,
    db,
    after,
    order.customerId,
    `#${order.orderNo} complete`,
    `${by.kind === "customer" ? `${order.customerName} approved your delivery.` : "It completed by itself."} ${rupees(share)} is in your available balance.`,
  );
  if (by.kind === "system") await tellCustomer(app, db, after, order.vendorId, `${order.title}: complete`, "The order completed by itself. You can still rate it.");
  return after;
}

/** The customer asks for changes while revisions remain: back to work, with the due date as it was. */
export async function askRevision(app: FastifyInstance, db: Database, order: GigOrderDoc, by: By, note: string): Promise<GigOrderDoc> {
  if (order.status !== "delivered") throw new AppError("ORDER_STATE", "You can ask for a revision once it's delivered.");
  if (order.revisionsUsed >= order.package.revisions) {
    throw new AppError("ORDER_STATE", order.package.revisions ? "All the revisions in this package are used. Approve it or report a problem." : "This package has no revisions.");
  }
  const now = new Date();
  const last = order.deliveries.length - 1;
  const after = await db.gigOrders.findOneAndUpdate(
    { _id: order._id, status: "delivered", revisionsUsed: order.revisionsUsed },
    {
      $set: { status: "in_progress", autoCompleteAt: null, [`deliveries.${last}.answer`]: { kind: "revision", note, at: now }, updatedAt: now },
      $inc: { revisionsUsed: 1 },
      $push: { timeline: { status: "in_progress", at: now, by: by.kind } },
    },
    { returnDocument: "after" },
  );
  if (!after) throw new AppError("ORDER_STATE");
  await audit(db, by, order, "gig_order.revision", { revisionsUsed: { from: order.revisionsUsed, to: after.revisionsUsed } });
  const left = after.package.revisions - after.revisionsUsed;
  await tellFreelancer(app, db, after, order.customerId, `Revision asked: #${order.orderNo}`, `${note} (${left} revision${left === 1 ? "" : "s"} left)`);
  return after;
}

/**
 * The customer reports a problem with a delivery: a help ticket about the order, and the money is held until Ruxstar decides a
 * full, part or no refund.
 */
export async function reportProblem(app: FastifyInstance, db: Database, order: GigOrderDoc, by: By, reason: string): Promise<GigOrderDoc> {
  if (order.status !== "delivered") throw new AppError("ORDER_STATE", "Problems are reported on a delivery. Before that, cancel or contact support.");
  const now = new Date();
  const hours = await slaHours(db);
  const last = order.deliveries.length - 1;
  const after = await db.transaction(async (session) => {
    const ticket: SupportTicketDoc = {
      _id: new ObjectId(),
      ticketNo: await nextTicketNo(db, session),
      requesterId: order.customerId,
      category: "orders",
      subject: `Problem with freelance order #${order.orderNo}`.slice(0, 80),
      context: gigOrderContext(order),
      status: "open",
      priority: "high",
      assigneeId: null,
      awaitingSince: now,
      slaDueAt: dueAt(now, "high", hours),
      lastAt: now,
      lastFrom: "customer",
      seenAt: now,
      resolvedAt: null,
      reopenUntil: null,
      ...stamp(now),
    };
    const message: SupportMessageDoc = { _id: new ObjectId(), ticketId: ticket._id, authorId: order.customerId, from: "customer", text: reason, photos: [], internal: false, at: now };
    const done = await db.gigOrders.findOneAndUpdate(
      { _id: order._id, status: "delivered" },
      {
        $set: {
          status: "disputed",
          autoCompleteAt: null,
          dispute: { ticketId: ticket._id, reason, openedAt: now, decision: null },
          [`deliveries.${last}.answer`]: { kind: "problem", note: reason, at: now },
          updatedAt: now,
        },
        $push: { timeline: { status: "disputed", at: now, by: by.kind } },
      },
      { session, returnDocument: "after" },
    );
    if (!done) throw new AppError("ORDER_STATE");
    await db.supportTickets.insertOne(ticket, { session });
    await db.supportMessages.insertOne(message, { session });
    await audit(db, by, order, "gig_order.dispute", { status: { from: "delivered", to: "disputed" } }, session);
    return done;
  });
  await tellFreelancer(
    app,
    db,
    after,
    order.customerId,
    `Problem reported: #${order.orderNo}`,
    `${order.customerName} reported a problem with your delivery. Ruxstar will look at it and decide; your money waits until then.`,
  );
  return after;
}

/**
 * Ruxstar decides a reported problem. Full: everything back to the customer. Part: `amount` back, out of the freelancer's share,
 * and the rest released to them. None: all of it released. A note goes on the help ticket.
 */
export async function decideDispute(
  app: FastifyInstance,
  db: Database,
  order: GigOrderDoc,
  by: By & { kind: "staff" },
  input: { outcome: "full" | "part" | "none"; amount?: number; note: string },
): Promise<GigOrderDoc> {
  if (order.status !== "disputed" || !order.dispute || order.dispute.decision) throw new AppError("ORDER_STATE", "There's no problem waiting for a decision on this order.");
  const now = new Date();
  const note = input.note.trim();
  const settings = await gigsSettings(db);
  const max = maxPartRefundOf(order);
  const amount = input.outcome === "full" ? order.price.total - refundedOf(order) : input.outcome === "part" ? (input.amount ?? 0) : 0;
  if (input.outcome === "part" && (amount < 1 || amount > max)) {
    throw new AppError("VALIDATION_FAILED", `A part refund is from ₹0.01 to ${rupees(max)}, out of the freelancer's share.`, [
      { path: "body/amount", message: `Up to ${rupees(max)}` },
    ]);
  }
  const decision = { outcome: input.outcome, amount, note, by: by.actor.id!, at: now };
  const ticketId = order.dispute.ticketId;
  const noteOnTicket = () =>
    db.supportMessages.insertOne({
      _id: new ObjectId(),
      ticketId,
      authorId: by.actor.id!,
      from: "staff",
      text: `Decided on #${order.orderNo}: ${input.outcome === "full" ? `full refund of ${rupees(amount)}` : input.outcome === "part" ? `part refund of ${rupees(amount)}` : "no refund"}. ${note}`,
      photos: [],
      internal: true,
      at: now,
    });
  if (input.outcome === "full") {
    const done = await cancelOrder(app, db, order, by, { reason: `Ruxstar decided the problem you reported: a full refund. ${note}`, decision, quiet: true });
    await audit(db, by, order, "gig_order.decide", { outcome: { from: null, to: "full" }, amount: { from: null, to: amount } });
    await noteOnTicket();
    await tellCustomer(app, db, done, by.actor.id!, `${order.title}: full refund`, `Ruxstar looked at the problem you reported. ${rupees(amount)} is being refunded to you. ${note}`);
    await tellFreelancer(app, db, done, by.actor.id!, `#${order.orderNo}: refunded in full`, `Ruxstar looked at the problem reported and refunded the customer in full. ${note}`);
    return done;
  }

  const refund: GigRefundDoc | null =
    input.outcome === "part" ? { refundId: `rfg_${order._id.toHexString()}_part`, kind: "part", amount, vendor: amount, ruxstar: 0, reason: note, by: "staff", status: "pending", at: now } : null;
  const after = await db.transaction(async (session) => {
    const done = await db.gigOrders.findOneAndUpdate(
      { _id: order._id, status: "disputed", "dispute.decision": null, releasedAt: null },
      {
        $set: {
          status: "completed",
          completedAt: now,
          releasedAt: now,
          filesUntil: new Date(now.getTime() + settings.fileDays * DAY_MS),
          "dispute.decision": decision,
          updatedAt: now,
        },
        $push: { timeline: { status: "completed", at: now, by: "staff" }, ...(refund ? { refunds: refund } : {}) },
      },
      { session, returnDocument: "after" },
    );
    if (!done) return null;
    if (refund) {
      for (const entry of partRefundLedger(done, refund)) await db.ledgerEntries.insertOne(entry, { session });
      const credited = await creditOrder(db, "gig_order", done._id, { id: refund.refundId, reason: note, amount }, session);
      if (credited.length) done.invoices = [...(done.invoices ?? []), ...credited];
    }
    for (const entry of gigLedger("release", done, now)) await db.ledgerEntries.insertOne(entry, { session });
    await audit(db, by, order, "gig_order.decide", { outcome: { from: null, to: input.outcome }, amount: { from: null, to: amount } }, session);
    return done;
  });
  if (!after) throw new AppError("ORDER_STATE");
  await noteOnTicket();
  const result = refund ? await askGigRefund(app, db, after) : after;
  const share = vendorLeftOf(after);
  await tellCustomer(
    app,
    db,
    after,
    by.actor.id!,
    `${order.title}: problem decided`,
    refund ? `Ruxstar looked at the problem you reported. ${rupees(amount)} is being refunded to you. ${note}` : `Ruxstar looked at the problem you reported and found no refund was due. ${note}`,
  );
  await tellFreelancer(
    app,
    db,
    after,
    by.actor.id!,
    `#${order.orderNo}: problem decided`,
    `${refund ? `Ruxstar refunded the customer ${rupees(amount)} of your share.` : "Ruxstar found no refund was due."} ${rupees(share)} is in your available balance. ${note}`,
  );
  return result;
}

// Files.

/** Deletes files from the bucket and their records: uploads never used after a day, and every file of orders past `filesUntil`. */
export async function cleanFiles(app: FastifyInstance, db: Database, now = new Date()): Promise<{ unused: number; orders: number }> {
  const stale = await db.gigFiles.find({ orderId: null, createdAt: { $lte: new Date(now.getTime() - UNUSED_FILE_MS) } }).limit(200).toArray();
  await Promise.all(stale.map((f) => app.printFiles.remove(f.key)));
  if (stale.length) await db.gigFiles.deleteMany({ _id: { $in: stale.map((f) => f._id) }, orderId: null });
  let orders = 0;
  for (const order of await db.gigOrders.find({ filesUntil: { $lte: now }, filesDeletedAt: null }).limit(50).toArray()) {
    const files = await db.gigFiles.find({ orderId: order._id }).toArray();
    await Promise.all(files.map((f) => app.printFiles.remove(f.key)));
    await db.gigFiles.deleteMany({ orderId: order._id });
    await db.gigOrders.updateOne({ _id: order._id }, { $set: { filesDeletedAt: now, filesUntil: null, updatedAt: now } });
    orders++;
  }
  return { unused: stale.length, orders };
}

// The timers.

/** Unpaid orders past their 20 minutes, orders not accepted in time, deliveries not answered, refunds to retry, offers, files. */
export async function sweepGigs(app: FastifyInstance, db: Database) {
  const now = new Date();
  let holds = 0;
  for (const order of await db.gigOrders.find({ status: "awaiting_payment", holdUntil: { $lte: now } }).limit(100).toArray()) {
    const after = await syncGigPayment(app, db, order).catch(() => order);
    if (after.status !== "awaiting_payment") holds++;
  }
  let timeouts = 0;
  for (const order of await db.gigOrders.find({ status: "paid", acceptBy: { $lte: now } }).limit(100).toArray()) {
    const done = await cancelOrder(app, db, order, SYSTEM, { reason: `${order.businessName} didn't accept in time.` }).catch(() => null);
    if (done?.status === "cancelled") timeouts++;
  }
  let completed = 0;
  for (const order of await db.gigOrders.find({ status: "delivered", autoCompleteAt: { $lte: now } }).limit(100).toArray()) {
    const done = await completeOrder(app, db, order, SYSTEM).catch(() => null);
    if (done?.status === "completed") completed++;
  }
  let refunds = 0;
  for (const order of await db.gigOrders.find({ "refunds.status": "pending" }).limit(100).toArray()) {
    const after = await askGigRefund(app, db, order);
    if (!after.refunds.some((r) => r.status === "pending")) refunds++;
  }
  const quotes = await expireQuotes(db, now);
  const files = await cleanFiles(app, db, now);
  return {
    gigHolds: holds,
    gigAcceptTimeouts: timeouts,
    gigAutoCompleted: completed,
    gigRefunds: refunds,
    gigQuotesExpired: quotes,
    gigFilesUnused: files.unused,
    gigFilesCleaned: files.orders,
  };
}

/** The share each side keeps, for the desk and the console. */
export const sharesOf = (o: GigOrderDoc) => ({ vendor: vendorShareOf(o), ruxstar: ruxstarShareOf(o), refunded: refundedOf(o) });
