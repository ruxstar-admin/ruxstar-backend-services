import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireRuxstar } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { PodOrderDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { OrderParams, ProblemsQuery, SettleBody, StaffOrderList, StaffOrderOne, type StaffOrder } from "../pod/contracts.js";
import { applyDue, dismissProblem, dueApplied, refundPart, refundWhole, type Staff } from "../pod/order-rules.js";
import { photoLinks, refundsOf, shopOrderView, type PhotoLinks } from "../pod/orders.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

/** Problems customers reported with print orders. Ruxstar refunds all or part of the order, or answers without a refund. */
const orderProblems: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  async function present(docs: PodOrderDoc[], links: PhotoLinks): Promise<StaffOrder[]> {
    const ids = [...new Set(docs.flatMap((d) => [d.customerId.toHexString(), d.vendorId.toHexString()]))].map((id) => new ObjectId(id));
    const people = await db()
      .users.find({ _id: { $in: ids } }, { projection: { name: 1, username: 1, deletion: 1 } })
      .toArray();
    const person = (id: ObjectId) => people.find((u) => u._id.equals(id));
    return docs.map((doc) => {
      const customer = person(doc.customerId);
      return {
        ...shopOrderView(doc, links),
        customer: {
          id: doc.customerId.toHexString(),
          name: customer?.name || "Deleted account",
          username: customer?.username ?? customer?.deletion?.username ?? null,
        },
        vendor: { id: doc.vendorId.toHexString(), name: person(doc.vendorId)?.name || "Deleted account" },
      };
    });
  }

  const one = async (id: string) => {
    const doc = await db().podOrders.findOne({ _id: new ObjectId(id), problem: { $ne: null } });
    if (!doc) throw new AppError("NOT_FOUND", "No problem was reported on this order.");
    return applyDue(app, db(), doc);
  };

  app.get(
    "/reports/orders",
    {
      preHandler: requireRuxstar("orders.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "Print orders with a reported problem",
        description: "`open` waits for a decision, and holds the shop's share. `resolved` is settled. Both newest report first.",
        querystring: ProblemsQuery,
        response: { 200: StaffOrderList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { status = "open", cursor, limit } = request.query;
      const { items, nextCursor } = await findPage(db().podOrders, { filter: { "problem.status": status }, sortField: "problemAt", cursor, limit });
      return page(request, await present(await dueApplied(app, db(), items), photoLinks(app, request)), nextCursor);
    },
  );

  app.get(
    "/reports/orders/:id",
    {
      preHandler: requireRuxstar("orders.view"),
      schema: { tags: ["ruxstar"], summary: "One order with a reported problem", params: OrderParams, response: { 200: StaffOrderOne, ...Errors }, security },
    },
    async (request) => {
      const [view] = await present([await one(request.params.id)], photoLinks(app, request));
      return ok(request, view!);
    },
  );

  app.post(
    "/reports/orders/:id/settle",
    {
      preHandler: [requireRuxstar("orders.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Settle a reported problem",
        description:
          "`refund_full` refunds what is left of the order and ends it as refunded. `refund_partial` refunds `amount` from the shop's " +
          "share and the order carries on. `dismiss` answers without a refund. Either way the shop's share is released once its hold is over. " +
          "Refunds aren't possible once the share is released.",
        params: OrderParams,
        body: SettleBody,
        response: { 200: StaffOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const order = await one(request.params.id);
      if (order.problem?.status !== "open") throw new AppError("CONFLICT", "This problem was already settled.");
      const { outcome, amount, note } = request.body;
      const staff: Staff = { actor: actorOf(request), userId: request.auth!.userId, ip: request.ip };
      const at = new Date();
      let done: PodOrderDoc;
      if (outcome === "dismiss") {
        done = await dismissProblem(app, database, order, { note: note.trim(), staff });
      } else if (outcome === "refund_partial") {
        if (!amount) throw new AppError("VALIDATION_FAILED", "Enter how much to refund.", [{ path: "body/amount", message: "Required" }]);
        done = await refundPart(app, database, order, {
          amount,
          reason: note.trim(),
          by: "staff",
          actor: staff.actor,
          ip: staff.ip,
          resolve: { outcome: "partial", amount, note: note.trim(), by: staff.userId, at },
        });
      } else {
        const left = order.price.total - refundsOf(order).reduce((s, r) => s + r.amount, 0);
        done = await refundWhole(app, database, order, {
          reason: note.trim(),
          staff,
          resolve: { outcome: "refunded", amount: left, note: note.trim(), by: staff.userId, at },
        });
      }
      const [view] = await present([await applyDue(app, database, done)], photoLinks(app, request));
      return ok(request, view!);
    },
  );
};

export default orderProblems;
