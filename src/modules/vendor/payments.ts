import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyInstance } from "fastify";
import type { Static } from "typebox";
import { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, writeAudit } from "../../platform/audit.js";
import { requireDatabase } from "../../platform/context.js";
import type { AuditLogDoc, Database, PayoutDoc, PayoutMethodDoc, PodOrderDoc, PodRefundDoc, Stamped } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { seal } from "../../platform/sealed.js";
import { loadCase, NAME_MATCHES, verificationId } from "../kyc/cases.js";
import { releaseShare } from "../pod/order-rules.js";
import { refundsOf, shopShareLeft } from "../pod/orders.js";
import { payoutMethodView, requireVendor } from "./businesses.js";
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
      preHandler: requireVendor,
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
      await settleDue(app, db(), vendorId, now);
      const [method, payouts, paid, ledger, holding, rules] = await Promise.all([
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
        payoutRules(db()),
      ]);
      const sum = (bucket: "pending" | "withdrawable") => ledger.find((row) => row._id === bucket)?.total ?? 0;
      const paidOut = paid[0]?.total ?? 0;
      return ok(request, {
        // Released after the hold, less withdrawals (they leave the ledger when asked for); pending is paid orders not released yet.
        balance: { available: Math.max(0, sum("withdrawable")), pending: Math.max(0, sum("pending")), paidOut },
        upcoming: holding.map((o) => ({
          orderId: o._id.toHexString(),
          orderNo: o.orderNo,
          amount: shopShareLeft(o),
          availableAt: o.releaseAt!.toISOString(),
          held: o.problem?.status === "open",
        })),
        withdrawal: rules,
        payoutMethod: method ? payoutMethodView(method) : null,
        payouts: payouts.map(payoutView),
      });
    },
  );

  app.post(
    "/payouts",
    {
      preHandler: [requireVendor, idempotent],
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
      preHandler: requireVendor,
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
      const ids = (type: "pod_order" | "payout") => items.filter((e) => e.source.type === type).map((e) => e.source.id);
      const [orders, payouts] = await Promise.all([
        database.podOrders
          .find(
            { _id: { $in: ids("pod_order") } },
            { projection: { orderNo: 1, shopId: 1, productLabel: 1, "address.name": 1, "price.total": 1, payment: 1, refund: 1, refunds: 1 } },
          )
          .toArray(),
        database.payouts.find({ _id: { $in: ids("payout") } }, { projection: { to: 1, fee: 1, status: 1, utr: 1 } }).toArray(),
      ]);
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
        const order = orders.find((o) => o._id.equals(entry.source.id));
        if (!order) return [];
        const shop = shops.find((s) => s._id.equals(order.shopId));
        const kind = entry.kind === "payment" ? "paid" : entry.kind === "release" ? "available" : entry.kind === "rider_pay" ? "delivery" : "refund";
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
            refund: kind === "refund" ? refundView(refundOf(order, entry.txnId)) : null,
            payout: null,
          },
        ];
      });
      return page(request, lines, nextCursor);
    },
  );

  app.get(
    "/payout-method",
    {
      preHandler: requireVendor,
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
      preHandler: requireVendor,
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
