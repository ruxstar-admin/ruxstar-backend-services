import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId, type WithId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireRuxstar } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { PayoutDoc, PodOrderDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { releaseRiderPay, riderPayHeld } from "../delivery/pay.js";
import { dueApplied, releaseEarly } from "../pod/order-rules.js";
import { shopShareLeft } from "../pod/orders.js";
import { failureText, payeeOf, settlePayout } from "../vendor/payouts.js";
import {
  HeldList,
  HeldParams,
  HeldQuery,
  PayoutParams,
  PayoutsQuery,
  ReleaseBody,
  ReleaseResult,
  StaffPayoutList,
  StaffPayoutOne,
  type HeldOrder,
  type StaffPayout,
} from "./contracts.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;

/** Vendors' and partners' withdrawals and the order shares still on hold, for the Ruxstar team. */
const payouts: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  async function names(ids: ObjectId[]) {
    const users = await db()
      .users.find({ _id: { $in: ids } }, { projection: { name: 1 } })
      .toArray();
    return (id: ObjectId) => ({ id: id.toHexString(), name: users.find((u) => u._id.equals(id))?.name || "Deleted account" });
  }

  async function payoutRows(docs: WithId<PayoutDoc>[]): Promise<StaffPayout[]> {
    const vendor = await names(docs.map((d) => d.vendorId));
    return docs.map((doc) => ({
      id: doc._id.toHexString(),
      payee: payeeOf(doc) === "rider" ? ("partner" as const) : ("vendor" as const),
      vendor: vendor(doc.vendorId),
      amount: doc.amount,
      fee: doc.fee,
      status: doc.status,
      to: doc.to,
      transferId: doc.transferId,
      utr: doc.utr,
      failure: doc.status === "failed" ? { code: doc.failure ?? "UNKNOWN", text: failureText(doc.failure) } : null,
      attempts: doc.attempts,
      checkedAt: iso(doc.checkedAt),
      paidAt: iso(doc.paidAt),
      createdAt: doc.createdAt.toISOString(),
    }));
  }

  async function heldRows(docs: PodOrderDoc[]): Promise<HeldOrder[]> {
    const [vendor, shops] = await Promise.all([
      names(docs.map((d) => d.vendorId)),
      db()
        .businesses.find({ _id: { $in: docs.map((d) => d.shopId) } }, { projection: { name: 1 } })
        .toArray(),
    ]);
    return docs.map((doc) => {
      const shop = shops.find((s) => s._id.equals(doc.shopId));
      const delivery = doc.delivery;
      const partnerHeld = delivery?.rider && delivery.releaseAt && !delivery.releasedAt;
      return {
        id: doc._id.toHexString(),
        orderNo: doc.orderNo,
        module: "pod" as const,
        business: shop ? { id: shop._id.toHexString(), name: shop.name } : null,
        vendor: vendor(doc.vendorId),
        amount: shopShareLeft(doc),
        deliveredAt: iso(doc.deliveredAt),
        releaseAt: doc.releaseAt!.toISOString(),
        problemOpen: doc.problem?.status === "open",
        partner: partnerHeld
          ? {
              rider: { id: delivery.rider!.id.toHexString(), name: delivery.rider!.name },
              amount: delivery.pay,
              releaseAt: delivery.releaseAt!.toISOString(),
              held: riderPayHeld(doc),
            }
          : null,
      };
    });
  }

  app.get(
    "/payouts",
    {
      preHandler: requireRuxstar("payouts.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "Vendors' and delivery partners' withdrawals, newest first",
        description: "`pending` is on the way, `failed` came back to the payee's balance, `paid` reached their account. `payee` says whose it is.",
        querystring: PayoutsQuery,
        response: { 200: StaffPayoutList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { status = "pending", cursor, limit } = request.query;
      const { items, nextCursor } = await findPage(db().payouts, { filter: { status }, sortField: "createdAt", cursor, limit });
      return page(request, await payoutRows(items), nextCursor);
    },
  );

  app.post(
    "/payouts/:id/check",
    {
      preHandler: requireRuxstar("payouts.manage"),
      schema: {
        tags: ["ruxstar"],
        summary: "Ask Cashfree about a withdrawal on the way now",
        description: "Settles it if Cashfree knows how it went, and sends it again only if Cashfree never got it. Safe to repeat.",
        params: PayoutParams,
        response: { 200: StaffPayoutOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const doc = await db().payouts.findOne({ _id: new ObjectId(request.params.id) });
      if (!doc) throw new AppError("NOT_FOUND", "Payout not found.");
      if (doc.status !== "pending") throw new AppError("CONFLICT", doc.status === "paid" ? "This payout was already paid." : "This payout already failed.");
      const [row] = await payoutRows([await settlePayout(app, db(), doc)]);
      return ok(request, row!);
    },
  );

  app.get(
    "/held-orders",
    {
      preHandler: requireRuxstar("payouts.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "Delivered orders whose share is still on hold, latest release date first",
        description:
          "Print orders wait 48 hours after delivery, and while a reported problem is open. A Ruxstar partner's pay for the delivery " +
          "waits 48 hours too, and longer only while a report that it never arrived is open.",
        querystring: HeldQuery,
        response: { 200: HeldList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { orderNo, cursor, limit } = request.query;
      const { items, nextCursor } = await findPage(db().podOrders, {
        filter: { status: "delivered", releasedAt: null, releaseAt: { $ne: null }, ...(orderNo ? { orderNo } : {}) },
        sortField: "releaseAt",
        cursor,
        limit,
      });
      const now = new Date();
      const current = (await dueApplied(app, db(), items)).filter((o) => !o.releasedAt);
      for (const order of current) {
        if (order.delivery && (await releaseRiderPay(db(), order, now))) order.delivery = { ...order.delivery, releasedAt: now };
      }
      return page(request, await heldRows(current), nextCursor);
    },
  );

  app.post(
    "/held-orders/:id/release",
    {
      preHandler: [requireRuxstar("payouts.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Release one order's share before its hold is over",
        description: "The vendor can withdraw it at once and is told. The reason goes to the audit log. A reported problem has to be settled first.",
        params: HeldParams,
        body: ReleaseBody,
        response: { 200: ReleaseResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const order = await db().podOrders.findOne({ _id: new ObjectId(request.params.id) });
      if (!order) throw new AppError("NOT_FOUND", "Order not found.");
      const done = await releaseEarly(app, db(), order, {
        reason: request.body.reason.trim(),
        staff: { actor: actorOf(request), userId: request.auth!.userId, ip: request.ip },
      });
      return ok(request, { id: done._id.toHexString(), orderNo: done.orderNo, amount: shopShareLeft(done), releasedAt: done.releasedAt!.toISOString() });
    },
  );
};

export default payouts;
