import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyInstance } from "fastify";
import type { Static } from "typebox";
import { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, writeAudit } from "../../platform/audit.js";
import { requireDatabase } from "../../platform/context.js";
import type { AuditLogDoc, Database, InvoiceRefDoc, PayoutDoc, PayoutMethodDoc, PodOrderDoc, PodRefundDoc, Stamped } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { seal } from "../../platform/sealed.js";
import { loadCase, NAME_MATCHES, verificationId } from "../kyc/cases.js";
import { releaseCoachingShares } from "../coaching/orders.js";
import { releaseTurfShares } from "../turf/orders.js";
import { keptOf } from "../turf/rules.js";
import { releaseStayShares } from "../stays/orders.js";
import { vendorShareOf as stayShare } from "../stays/rules.js";
import { vendorLeftOf } from "../gigs/rules.js";
import { releaseShopShares } from "../shop/orders.js";
import { vendorLeftOf as storeShareLeft } from "../shop/rules.js";
import { vendorShare as coachingShare } from "../coaching/rules.js";
import { releaseEventShares } from "../events/orders.js";
import { invoiceRefs } from "../invoices/views.js";
import { vendorShare } from "../events/rules.js";
import { releaseShare } from "../pod/order-rules.js";
import { refundsOf, shopShareLeft } from "../pod/orders.js";
import { payoutMethodView, requireEarner } from "./businesses.js";
import { PayoutMethodBody, PayoutMethodResult, PayoutResult, Payments, Statement, StatementQuery, type Payout, type StatementLine } from "./contracts.js";
import { failureText, methodsOf, payeeFilter, payoutRules, settleDue, withdraw, type Payee } from "./payouts.js";

export const payoutView = (p: PayoutDoc): Payout => ({
  id: p._id.toHexString(),
  amount: p.amount,
  fee: p.fee ?? 0,
  status: p.status,
  to: p.to,
  utr: p.utr,
  paidAt: p.paidAt?.toISOString() ?? null,
  failure: p.status === "failed" ? failureText(p.failure ?? null) : null,
  createdAt: p.createdAt.toISOString(),
});

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

/** A partial refund's ledger lines carry its ID (`refund:<order>:<refund>`); a full refund's (`refund:<order>`) don't. */
function refundOf(order: Pick<PodOrderDoc, "refund" | "refunds">, txnId: string): PodRefundDoc | null {
  const refunds = refundsOf(order as PodOrderDoc);
  const id = txnId.split(":")[2];
  return (id ? refunds.find((r) => r.refundId === id) : refunds.find((r) => r.kind === "full")) ?? null;
}
const refundView = (r: PodRefundDoc | null) => (r ? { id: r.refundId, reason: r.reason, by: r.by } : null);

/** The sale's GST invoice on a paid line, its credit note on a refund line. */
function invoiceOf(refs: InvoiceRefDoc[] | undefined, kind: StatementLine["kind"], refundId: string | null) {
  const sale = (refs ?? []).filter((r) => r.role === "supply");
  const found = kind === "paid" ? sale.find((r) => r.kind !== "credit_note") : kind === "refund" ? sale.find((r) => r.refundId === refundId) : undefined;
  return found ? invoiceRefs([found])[0]! : null;
}
/** UPI answers MATCH where bank checks grade the name. */
const PAYOUT_NAME_MATCHES = new Set([...NAME_MATCHES, "MATCH"]);

const failed = (path: string, message: string) => new AppError("KYC_CHECK_FAILED", message, [{ path, message }]);

/**
 * Checks a bank account or UPI ID with Cashfree, in the name on the person's Aadhaar, and saves it as where they are
 * paid as a vendor or as a delivery partner, replacing the one they had.
 */
export async function setPayoutMethod(
  app: FastifyInstance,
  database: Database,
  userId: ObjectId,
  body: Static<typeof PayoutMethodBody>,
  audit: { actor: AuditLogDoc["actor"]; ip: string | null },
  payee: Payee = "vendor",
): Promise<PayoutMethodDoc> {
  const key = app.config.payoutKey;
  if (body.kind === "bank" && !key) throw new AppError("PAYOUTS_UNAVAILABLE", "Bank accounts can't be added right now. Use a UPI ID.");

  const [base, user] = await Promise.all([loadCase(database, userId, "base"), database.users.findOne({ _id: userId }, { projection: { name: 1 } })]);
  const name = base?.steps.aadhaar?.name ?? user?.name ?? "";
  const result =
    body.kind === "bank"
      ? await app.verifier.bankAccount(body.accountNumber, body.ifsc, name)
      : await app.verifier.upi(verificationId(userId, "upi"), body.vpa, name);
  const path = body.kind === "bank" ? "body/accountNumber" : "body/vpa";
  if (!result.valid) {
    throw failed(path, body.kind === "bank" ? "We couldn't verify this account. Check the number and IFSC." : "We couldn't verify this UPI ID.");
  }
  if (!PAYOUT_NAME_MATCHES.has(result.nameMatch ?? "")) throw failed(path, "This account is in another name. Use one in the name on your Aadhaar.");

  const now = new Date();
  const fields: Omit<PayoutMethodDoc, "_id" | "userId" | keyof Stamped> = {
    kind: body.kind,
    holderName: result.holderName,
    nameMatch: result.nameMatch,
    verifiedAt: now,
    ...(body.kind === "bank"
      ? { bank: { number: seal(body.accountNumber, key!), last4: body.accountNumber.slice(-4), ifsc: body.ifsc, bankName: result.bankName } }
      : { upi: { vpa: body.vpa.toLowerCase() } }),
  };
  const methods = methodsOf(database, payee);
  return database.transaction(async (session) => {
    const before = await methods.findOne({ userId }, { session });
    const after = await methods.findOneAndUpdate(
      { userId },
      {
        $set: { ...fields, updatedAt: now },
        $unset: body.kind === "bank" ? { upi: "" } : { bank: "" },
        $setOnInsert: { _id: new ObjectId(), createdAt: now, schemaVersion: 1 },
      },
      { upsert: true, returnDocument: "after", session },
    );
    await writeAudit(
      database,
      {
        actor: audit.actor,
        scope: { module: payee === "rider" ? "delivery" : "vendor" },
        action: "payout_method.set",
        target: { type: "payout_method", id: after!._id },
        diff: { method: { from: before ? payoutMethodView(before).label : null, to: payoutMethodView(after!).label } },
        ip: audit.ip,
      },
      session,
    );
    return after!;
  });
}

/** Where a vendor is paid, and what they have earned and been paid. */
const payments: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  app.get(
    "/payments",
    {
      preHandler: requireEarner,
      schema: {
        tags: ["vendor"],
        summary: "Your balance, payout account and latest payouts",
        description:
          "Pending is your share of paid orders, less partial refunds. It becomes available 48 hours after delivery, " +
          "or once Ruxstar settles a problem the customer reported.",
        response: { 200: Payments, ...Errors },
        security,
      },
    },
    async (request) => {
      const vendorId = request.auth!.userId;
      const now = new Date();
      const due = await db()
        .podOrders.find({ vendorId, status: "delivered", releaseAt: { $lte: now }, releasedAt: null, "problem.status": { $ne: "open" } })
        .limit(50)
        .toArray();
      for (const order of due) await releaseShare(app, db(), order, now);
      await releaseEventShares(app, db(), { vendorId }, now);
      await releaseCoachingShares(app, db(), { vendorId }, now);
      await releaseTurfShares(app, db(), { vendorId }, now);
      await releaseStayShares(app, db(), { vendorId }, now);
      await releaseShopShares(app, db(), { vendorId }, now);
      await settleDue(app, db(), vendorId, now);
      const [method, payouts, paid, ledger, holding, tickets, places, slots, stays, stores, gigs, rules] = await Promise.all([
        db().payoutMethods.findOne({ userId: vendorId }),
        db()
          .payouts.find({ vendorId, ...payeeFilter("vendor") })
          .sort({ createdAt: -1, _id: -1 })
          .limit(20)
          .toArray(),
        db()
          .payouts.aggregate<{ total: number }>([
            { $match: { vendorId, status: "paid", ...payeeFilter("vendor") } },
            { $group: { _id: null, total: { $sum: "$amount" } } },
          ])
          .toArray(),
        db()
          .ledgerEntries.aggregate<{ _id: "pending" | "withdrawable"; total: number }>([
            { $match: { accountId: `vendor:${vendorId.toHexString()}` } },
            { $group: { _id: "$bucket", total: { $sum: "$signedPaise" } } },
          ])
          .toArray(),
        db().podOrders.find({ vendorId, status: "delivered", releasedAt: null, releaseAt: { $ne: null } }).sort({ releaseAt: 1 }).limit(20).toArray(),
        db()
          .eventOrders.find({ vendorId, status: "confirmed", releasedAt: null, releaseAt: { $ne: null } }, { projection: { orderNo: 1, price: 1, releaseAt: 1 } })
          .sort({ releaseAt: 1 })
          .limit(20)
          .toArray(),
        db()
          .coachingOrders.find({ vendorId, status: "confirmed", releasedAt: null, releaseAt: { $ne: null } }, { projection: { orderNo: 1, price: 1, releaseAt: 1 } })
          .sort({ releaseAt: 1 })
          .limit(20)
          .toArray(),
        db()
          .turfBookings.find({ vendorId, releaseAt: { $type: "date" } }, { projection: { orderNo: 1, occurrences: 1, releaseAt: 1 } })
          .sort({ releaseAt: 1 })
          .limit(20)
          .toArray(),
        db()
          .staysReservations.find(
            { vendorId, status: { $in: ["confirmed", "moved_in", "moved_out"] }, releasedAt: null, refund: null },
            { projection: { orderNo: 1, price: 1, releaseAt: 1, objection: 1 } },
          )
          .sort({ from: 1 })
          .limit(20)
          .toArray(),
        db()
          .shopOrders.find({ vendorId, status: "delivered", releasedAt: null, releaseAt: { $type: "date" } }, { projection: { orderNo: 1, price: 1, delivery: 1, refunds: 1, releaseAt: 1, return: 1 } })
          .sort({ releaseAt: 1 })
          .limit(20)
          .toArray(),
        db()
          .gigOrders.find({ vendorId, status: { $in: ["delivered", "disputed"] }, releasedAt: null }, { projection: { orderNo: 1, price: 1, refunds: 1, status: 1, autoCompleteAt: 1 } })
          .sort({ createdAt: 1 })
          .limit(20)
          .toArray(),
        payoutRules(db()),
      ]);
      const sum = (bucket: "pending" | "withdrawable") => ledger.find((row) => row._id === bucket)?.total ?? 0;
      const paidOut = paid[0]?.total ?? 0;
      return ok(request, {
        // Released after the hold, less withdrawals (they leave the ledger when asked for); pending is paid orders not released yet.
        balance: { available: Math.max(0, sum("withdrawable")), pending: Math.max(0, sum("pending")), paidOut },
        upcoming: [
          ...holding.map((o) => ({
            orderId: o._id.toHexString(),
            orderNo: o.orderNo,
            amount: shopShareLeft(o),
            availableAt: o.releaseAt!.toISOString(),
            held: o.problem?.status === "open",
          })),
          ...tickets
            .filter((o) => vendorShare(o) > 0)
            .map((o) => ({ orderId: o._id.toHexString(), orderNo: o.orderNo, amount: vendorShare(o), availableAt: o.releaseAt!.toISOString(), held: false })),
          ...places
            .filter((o) => coachingShare(o) > 0)
            .map((o) => ({ orderId: o._id.toHexString(), orderNo: o.orderNo, amount: coachingShare(o), availableAt: o.releaseAt!.toISOString(), held: false })),
          ...slots.flatMap((b) =>
            b.occurrences
              .filter((o) => !o.releasedAt && keptOf(o).vendor > 0)
              .map((o) => ({ orderId: b._id.toHexString(), orderNo: b.orderNo, amount: keptOf(o).vendor, availableAt: o.endAt.toISOString(), held: false })),
          ),
          // A stay waiting for "Moved in" has no date yet; it's listed once the objection window is running, and held during an objection.
          ...stays
            .filter((r) => stayShare(r) > 0 && (r.releaseAt || r.objection?.status === "open"))
            .map((r) => ({
              orderId: r._id.toHexString(),
              orderNo: r.orderNo,
              amount: stayShare(r),
              availableAt: (r.releaseAt ?? now).toISOString(),
              held: r.objection?.status === "open",
            })),
          ...stores
            .filter((o) => storeShareLeft(o) > 0)
            .map((o) => ({
              orderId: o._id.toHexString(),
              orderNo: o.orderNo,
              amount: storeShareLeft(o),
              availableAt: o.releaseAt!.toISOString(),
              held: o.return?.status === "requested" || o.return?.status === "approved",
            })),
          // A delivered freelance order is paid out when the customer approves it or it completes by itself; a reported problem holds it.
          ...gigs
            .filter((o) => vendorLeftOf(o) > 0)
            .map((o) => ({
              orderId: o._id.toHexString(),
              orderNo: o.orderNo,
              amount: vendorLeftOf(o),
              availableAt: (o.autoCompleteAt ?? now).toISOString(),
              held: o.status === "disputed",
            })),
        ]
          .sort((a, b) => a.availableAt.localeCompare(b.availableAt))
          .slice(0, 20),
        withdrawal: rules,
        payoutMethod: method ? payoutMethodView(method) : null,
        payouts: payouts.map(payoutView),
      });
    },
  );

  app.post(
    "/payouts",
    {
      preHandler: [requireEarner, idempotent],
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Withdraw everything available to your payout account",
        description:
          "Takes the whole available balance, at least the minimum, and sends it less the payout fee. One withdrawal at a time. " +
          "It usually arrives within minutes; until Cashfree confirms it, it shows as pending. If it fails, the amount is back in your balance. " +
          "Send an Idempotency-Key.",
        response: { 200: PayoutResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const payout = await withdraw(app, db(), request.auth!.userId, actorOf(request), request.ip);
      return ok(request, payoutView(payout));
    },
  );

  app.get(
    "/payments/statement",
    {
      preHandler: requireEarner,
      schema: {
        tags: ["vendor"],
        summary: "Every change to your earnings, newest first",
        description:
          "One line per money movement: an order's share arriving (pending), its hold ending (available), refunds out of your " +
          "share, withdrawals, and failed withdrawals coming back.",
        querystring: StatementQuery,
        response: { 200: Statement, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const { items, nextCursor } = await findPage(database.ledgerEntries, {
        // A release moves money from pending to available; its pending side would only repeat the line.
        filter: { accountId: `vendor:${request.auth!.userId.toHexString()}`, $nor: [{ kind: "release", bucket: "pending" }] },
        sortField: "at",
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      const ids = (type: "pod_order" | "event_order" | "coaching_order" | "turf_booking" | "stay_reservation" | "shop_order" | "gig_order" | "payout") =>
        items.filter((e) => e.source.type === type).map((e) => e.source.id);
      const [orders, payouts, eventOrders, coachingOrders, turfBookings, stayReservations, storeOrders, gigOrders] = await Promise.all([
        database.podOrders
          .find(
            { _id: { $in: ids("pod_order") } },
            { projection: { orderNo: 1, shopId: 1, productLabel: 1, "address.name": 1, "price.total": 1, payment: 1, refund: 1, refunds: 1, invoices: 1 } },
          )
          .toArray(),
        database.payouts.find({ _id: { $in: ids("payout") } }, { projection: { to: 1, fee: 1, status: 1, utr: 1 } }).toArray(),
        database.eventOrders
          .find(
            { _id: { $in: ids("event_order") } },
            { projection: { orderNo: 1, businessId: 1, businessName: 1, eventTitle: 1, lines: 1, "price.total": 1, payment: 1, refund: 1, invoices: 1 } },
          )
          .toArray(),
        database.coachingOrders
          .find(
            { _id: { $in: ids("coaching_order") } },
            {
              projection: { orderNo: 1, kind: 1, businessId: 1, businessName: 1, courseTitle: 1, batchName: 1, student: 1, "price.total": 1, payment: 1, refund: 1, invoices: 1 },
            },
          )
          .toArray(),
        database.turfBookings
          .find(
            { _id: { $in: ids("turf_booking") } },
            {
              projection: { orderNo: 1, businessId: 1, businessName: 1, groundName: 1, courtName: 1, customerName: 1, weeks: 1, "price.total": 1, payment: 1, refunds: 1, invoices: 1 },
            },
          )
          .toArray(),
        database.staysReservations
          .find(
            { _id: { $in: ids("stay_reservation") } },
            { projection: { orderNo: 1, businessId: 1, businessName: 1, propertyName: 1, roomName: 1, customerName: 1, "price.total": 1, payment: 1, refund: 1, invoices: 1 } },
          )
          .toArray(),
        database.shopOrders
          .find(
            { _id: { $in: ids("shop_order") } },
            { projection: { orderNo: 1, businessId: 1, businessName: 1, lines: 1, customerName: 1, "price.total": 1, payment: 1, refunds: 1, invoices: 1 } },
          )
          .toArray(),
        database.gigOrders
          .find(
            { _id: { $in: ids("gig_order") } },
            { projection: { orderNo: 1, businessId: 1, businessName: 1, title: 1, "package.name": 1, customerName: 1, "price.total": 1, payment: 1, refunds: 1, invoices: 1 } },
          )
          .toArray(),
      ]);
      const holders = await database.eventTickets
        .find({ orderId: { $in: eventOrders.map((o) => o._id) } }, { projection: { orderId: 1, "holder.name": 1 } })
        .sort({ _id: 1 })
        .toArray();
      const shops = await database.businesses
        .find({ _id: { $in: orders.map((o) => o.shopId) } }, { projection: { name: 1 } })
        .toArray();
      const lines = items.flatMap((entry): StatementLine[] => {
        const base = { id: entry._id.toHexString(), amount: entry.signedPaise, at: entry.at.toISOString() };
        if (entry.source.type === "payout") {
          const payout = payouts.find((p) => p._id.equals(entry.source.id));
          if (!payout) return [];
          const kind = entry.kind === "payout" ? "withdrawal" : "returned";
          return [
            {
              ...base,
              kind,
              module: "ledger",
              order: null,
              refund: null,
              payout: { id: payout._id.toHexString(), to: payout.to, fee: payout.fee ?? 0, status: payout.status, utr: payout.utr },
            },
          ];
        }
        if (entry.source.type === "event_order") {
          const order = eventOrders.find((o) => o._id.equals(entry.source.id));
          if (!order) return [];
          const kind = entry.kind === "payment" ? "paid" : entry.kind === "release" ? "available" : "refund";
          const count = order.lines.reduce((sum, l) => sum + l.quantity, 0);
          return [
            {
              ...base,
              kind,
              module: "events",
              order: {
                id: order._id.toHexString(),
                orderNo: order.orderNo,
                business: { id: order.businessId.toHexString(), name: order.businessName },
                label: `${order.eventTitle}, ${count} ${count === 1 ? "ticket" : "tickets"}`,
                customer: holders.find((h) => h.orderId.equals(order._id))?.holder.name ?? "",
                total: order.price.total,
                paymentId: order.payment?.paymentId ?? null,
                paidAt: order.payment?.paidAt?.toISOString() ?? null,
              },
              refund: kind === "refund" && order.refund ? { id: order.refund.refundId, reason: order.refund.reason, by: order.refund.by } : null,
              payout: null,
              invoice: invoiceOf(order.invoices, kind, order.refund?.refundId ?? null),
            },
          ];
        }
        if (entry.source.type === "coaching_order") {
          const order = coachingOrders.find((o) => o._id.equals(entry.source.id));
          if (!order) return [];
          const kind = entry.kind === "payment" ? "paid" : entry.kind === "release" ? "available" : "refund";
          return [
            {
              ...base,
              kind,
              module: "coaching",
              order: {
                id: order._id.toHexString(),
                orderNo: order.orderNo,
                business: { id: order.businessId.toHexString(), name: order.businessName },
                label: `${order.courseTitle}, ${order.kind === "demo" ? "demo class" : order.batchName}`,
                customer: order.student.name,
                total: order.price.total,
                paymentId: order.payment?.paymentId ?? null,
                paidAt: order.payment?.paidAt?.toISOString() ?? null,
              },
              refund: kind === "refund" && order.refund ? { id: order.refund.refundId, reason: order.refund.reason, by: order.refund.by } : null,
              payout: null,
              invoice: invoiceOf(order.invoices, kind, order.refund?.refundId ?? null),
            },
          ];
        }
        if (entry.source.type === "turf_booking") {
          const order = turfBookings.find((o) => o._id.equals(entry.source.id));
          if (!order) return [];
          const kind = entry.kind === "payment" ? "paid" : entry.kind === "release" ? "available" : "refund";
          // Refund lines carry the refund's place in the booking: `refund:<booking>:<k>`.
          const refund = kind === "refund" ? (order.refunds[Number(entry.txnId.split(":")[2]) - 1] ?? null) : null;
          return [
            {
              ...base,
              kind,
              module: "turf",
              order: {
                id: order._id.toHexString(),
                orderNo: order.orderNo,
                business: { id: order.businessId.toHexString(), name: order.businessName },
                label: `${order.groundName}, ${order.courtName}${order.weeks > 1 ? `, ${order.weeks} weeks` : ""}`,
                customer: order.customerName,
                total: order.price.total,
                paymentId: order.payment?.paymentId ?? null,
                paidAt: order.payment?.paidAt?.toISOString() ?? null,
              },
              refund: refund ? { id: refund.refundId, reason: refund.reason, by: refund.by } : null,
              payout: null,
              invoice: invoiceOf(order.invoices, kind, refund?.refundId ?? null),
            },
          ];
        }
        if (entry.source.type === "stay_reservation") {
          const order = stayReservations.find((o) => o._id.equals(entry.source.id));
          if (!order) return [];
          const kind = entry.kind === "payment" ? "paid" : entry.kind === "release" ? "available" : "refund";
          return [
            {
              ...base,
              kind,
              module: "stays",
              order: {
                id: order._id.toHexString(),
                orderNo: order.orderNo,
                business: { id: order.businessId.toHexString(), name: order.businessName },
                label: `${order.propertyName}, ${order.roomName}`,
                customer: order.customerName,
                total: order.price.total,
                paymentId: order.payment?.paymentId ?? null,
                paidAt: order.payment?.paidAt?.toISOString() ?? null,
              },
              refund: kind === "refund" && order.refund ? { id: order.refund.refundId, reason: order.refund.reason, by: order.refund.by } : null,
              payout: null,
              invoice: invoiceOf(order.invoices, kind, order.refund?.refundId ?? null),
            },
          ];
        }
        if (entry.source.type === "shop_order") {
          const order = storeOrders.find((o) => o._id.equals(entry.source.id));
          if (!order) return [];
          const kind = entry.kind === "payment" ? "paid" : entry.kind === "release" ? "available" : entry.kind === "rider_pay" ? "delivery" : "refund";
          // A return's refund line carries its refund id: `refund:<order>:<refundId>`; a full refund's is `refund:<order>`.
          const refundId = entry.txnId.split(":")[2];
          const refund = kind === "refund" ? (order.refunds.find((r) => (refundId ? r.refundId === refundId : r.kind === "full")) ?? null) : null;
          const first = order.lines[0]!;
          return [
            {
              ...base,
              kind,
              module: "shop",
              order: {
                id: order._id.toHexString(),
                orderNo: order.orderNo,
                business: { id: order.businessId.toHexString(), name: order.businessName },
                label: order.lines.length > 1 ? `${first.title} and ${order.lines.length - 1} more` : first.title,
                customer: order.customerName,
                total: order.price.total,
                paymentId: order.payment.paymentId,
                paidAt: order.payment.paidAt?.toISOString() ?? null,
              },
              refund: refund ? { id: refund.refundId, reason: refund.reason, by: refund.by === "rider" ? "system" : refund.by } : null,
              payout: null,
              invoice: invoiceOf(order.invoices, kind, refund?.refundId ?? null),
            },
          ];
        }
        if (entry.source.type === "gig_order") {
          const order = gigOrders.find((o) => o._id.equals(entry.source.id));
          if (!order) return [];
          const kind = entry.kind === "payment" ? "paid" : entry.kind === "release" ? "available" : "refund";
          // A part refund's line carries its refund id: `refund:<order>:<refundId>`; a full refund's is `refund:<order>`.
          const refundId = entry.txnId.split(":")[2];
          const refund = kind === "refund" ? (order.refunds.find((r) => (refundId ? r.refundId === refundId : r.kind === "full")) ?? null) : null;
          return [
            {
              ...base,
              kind,
              module: "gigs",
              order: {
                id: order._id.toHexString(),
                orderNo: order.orderNo,
                business: { id: order.businessId.toHexString(), name: order.businessName },
                label: `${order.title}: ${order.package.name}`,
                customer: order.customerName,
                total: order.price.total,
                paymentId: order.payment.paymentId,
                paidAt: order.payment.paidAt?.toISOString() ?? null,
              },
              refund: refund ? { id: refund.refundId, reason: refund.reason, by: refund.by } : null,
              payout: null,
              invoice: invoiceOf(order.invoices, kind, refund?.refundId ?? null),
            },
          ];
        }
        const order = orders.find((o) => o._id.equals(entry.source.id));
        if (!order) return [];
        const shop = shops.find((s) => s._id.equals(order.shopId));
        const kind = entry.kind === "payment" ? "paid" : entry.kind === "release" ? "available" : entry.kind === "rider_pay" ? "delivery" : "refund";
        const refund = kind === "refund" ? refundOf(order, entry.txnId) : null;
        return [
          {
            ...base,
            kind,
            module: "pod",
            order: {
              id: order._id.toHexString(),
              orderNo: order.orderNo,
              business: shop ? { id: shop._id.toHexString(), name: shop.name } : null,
              label: order.productLabel,
              customer: order.address.name,
              total: order.price.total,
              paymentId: order.payment.paymentId,
              paidAt: order.payment.paidAt?.toISOString() ?? null,
            },
            refund: refundView(refund),
            payout: null,
            invoice: invoiceOf(order.invoices, kind, refund?.refundId ?? null),
          },
        ];
      });
      return page(request, lines, nextCursor);
    },
  );

  app.get(
    "/payout-method",
    {
      preHandler: requireEarner,
      schema: { tags: ["vendor"], summary: "Where you are paid", response: { 200: PayoutMethodResult, ...Errors }, security },
    },
    async (request) => {
      const method = await db().payoutMethods.findOne({ userId: request.auth!.userId });
      return ok(request, method ? payoutMethodView(method) : null);
    },
  );

  app.put(
    "/payout-method",
    {
      preHandler: requireEarner,
      config: { rateLimit: { max: 5, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Set the bank account or UPI ID you are paid to",
        description:
          "Checked with Cashfree before it is saved, and it must be in the name on your Aadhaar. Replaces the one you had. " +
          "Only the last 4 digits of a bank account are ever shown again.",
        body: PayoutMethodBody,
        response: { 200: PayoutMethodResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const saved = await setPayoutMethod(app, db(), request.auth!.userId, request.body, { actor: actorOf(request), ip: request.ip });
      return ok(request, payoutMethodView(saved));
    },
  );
};

export default payments;
