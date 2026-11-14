import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Errors } from "../../contracts/common.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { PodOrderDoc } from "../../platform/db.js";
import { page } from "../../platform/envelope.js";
import { findPage } from "../../platform/pagination.js";
import { refundsOf } from "../pod/orders.js";
import { PaymentList, PaymentsQuery, type Payment } from "./contracts.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

export function paymentView(doc: PodOrderDoc): Payment {
  const refunds = refundsOf(doc);
  const refunded = refunds.reduce((sum, r) => sum + r.amount, 0);
  const status = refunds.some((r) => r.status === "pending")
    ? "refund_pending"
    : refunded >= doc.price.total
      ? "refunded"
      : refunded > 0
        ? "part_refunded"
        : "paid";
  return {
    id: doc._id.toHexString(),
    module: "pod",
    business: { id: doc.shopId.toHexString(), name: doc.shopName },
    order: { id: doc._id.toHexString(), orderNo: doc.orderNo, label: doc.productLabel },
    amount: doc.price.total,
    paidAt: doc.payment.paidAt!.toISOString(),
    paymentId: doc.payment.paymentId,
    status,
    refunded,
    refunds: refunds.map((r) => ({ amount: r.amount, kind: r.kind, reason: r.reason, status: r.status, at: r.at.toISOString() })),
  };
}

/** What a customer paid, at every business, and what came back. */
const payments: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  app.get(
    "/payments",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["account"],
        summary: "Your payments, newest first",
        description: "One per paid order, at every business, with its refunds. Orders never paid for are left out.",
        querystring: PaymentsQuery,
        response: { 200: PaymentList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { items, nextCursor } = await findPage(db().podOrders, {
        filter: { customerId: request.auth!.userId, "payment.paidAt": { $ne: null } },
        sortField: "createdAt",
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      return page(request, items.map(paymentView), nextCursor);
    },
  );
};

export default payments;
