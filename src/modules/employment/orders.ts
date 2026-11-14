import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type Filter, type WithId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { EmploymentDoc, PodOrderDoc, PodOrderStatus, TeamPermission } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import {
  FileLink,
  OrderFileParams,
  OrderParams,
  ShopRefundBody,
  ShopStatusBody,
  TeamOrderList,
  TeamOrderOne,
  TeamOrdersQuery,
  type TeamOrder,
} from "../pod/contracts.js";
import { notifyTeamMove } from "../notifications/notify.js";
import { applyDue, dueApplied, refundPart } from "../pod/order-rules.js";
import { fileLink, moveOrder, photoLinks, shopCanMove, shopOrderView, signingKey, type PhotoLinks } from "../pod/orders.js";
import { WorkParams } from "../team/contracts.js";
import { teamAccess } from "../team/team.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

const VIEWS: Record<"new" | "active" | "past", PodOrderStatus[]> = {
  new: ["placed"],
  active: ["accepted", "printing", "ready", "out_for_delivery"],
  past: ["delivered", "rejected", "cancelled", "refunded"],
};

/** The shop's order for someone on its team: its money only with "See the shop's earnings", refunds only with permission to refund. */
export function teamOrderView(doc: PodOrderDoc, links: PhotoLinks, place: WithId<EmploymentDoc>): TeamOrder {
  const shop = shopOrderView(doc, links);
  const earnings = place.permissions.includes("earnings.view");
  return {
    ...shop,
    price: earnings ? shop.price : { ...shop.price, commissionBps: null, commission: null, payout: null, payoutLeft: null },
    refundable: place.permissions.includes("orders.refund") ? shop.refundable : 0,
    placeId: place._id.toHexString(),
    permissions: place.permissions,
  };
}

/** Orders to a shop, worked by its team. Everything the owner does to an order, each behind its own permission. */
const orders: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  /** A paid order to a shop you work at, with your place there, if you have `permission`. */
  async function order(request: FastifyRequest, id: string, permission: TeamPermission) {
    const doc = await db().podOrders.findOne({ _id: new ObjectId(id), "payment.paidAt": { $ne: null } });
    if (!doc) throw new AppError("NOT_FOUND", "Order not found.");
    const { place } = await teamAccess(db(), request.auth!, { businessId: doc.shopId }, permission).catch((err: unknown) => {
      // Someone not on the shop's team learns nothing about its orders.
      if (err instanceof AppError && err.code === "NOT_FOUND") throw new AppError("NOT_FOUND", "Order not found.");
      throw err;
    });
    return { doc: await applyDue(app, db(), doc), place };
  }

  app.get(
    "/:id/orders",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["employment"],
        summary: "Orders to a shop you work at, newest first",
        description: 'Needs "See orders". The shop\'s share and commission are null without "See the shop\'s earnings".',
        params: WorkParams,
        querystring: TeamOrdersQuery,
        response: { 200: TeamOrderList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { place } = await teamAccess(db(), request.auth!, { placeId: request.params.id }, "orders.view");
      const { view, cursor, limit } = request.query;
      const filter: Filter<PodOrderDoc> = {
        shopId: place.businessId,
        status: { $in: view ? VIEWS[view] : [...VIEWS.new, ...VIEWS.active, ...VIEWS.past] },
        "payment.paidAt": { $ne: null },
      };
      const { items, nextCursor } = await findPage(db().podOrders, { filter, sortField: "createdAt", cursor, limit });
      const links = photoLinks(app, request);
      return page(request, (await dueApplied(app, db(), items)).map((o) => teamOrderView(o, links, place)), nextCursor);
    },
  );

  app.get(
    "/orders/:id",
    {
      preHandler: requireAuth,
      schema: { tags: ["employment"], summary: "One order to a shop you work at", params: OrderParams, response: { 200: TeamOrderOne, ...Errors }, security },
    },
    async (request) => {
      const { doc, place } = await order(request, request.params.id, "orders.view");
      return ok(request, teamOrderView(doc, photoLinks(app, request), place));
    },
  );

  app.post(
    "/orders/:id/status",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["employment"],
        summary: "Accept or turn down a new order, or move it on",
        description: 'Turning one down needs "Turn down orders"; everything else needs "Accept and move orders". The same rules as the owner.',
        params: OrderParams,
        body: ShopStatusBody,
        response: { 200: TeamOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { status, reason } = request.body;
      const { doc, place } = await order(request, request.params.id, status === "rejected" ? "orders.reject" : "orders.move");
      if (!shopCanMove(doc.status, status)) throw new AppError("ORDER_STATE");
      if (status === "rejected" && !reason?.trim()) {
        throw new AppError("VALIDATION_FAILED", "Tell the customer why.", [{ path: "body/reason", message: "Tell the customer why." }]);
      }
      const moved = await moveOrder(app, db(), doc, status, { kind: "vendor", actor: actorOf(request), ip: request.ip }, { reason: reason?.trim() ?? null });
      await notifyTeamMove(db(), app.log, { owner: moved.vendorId, member: request.auth!.userId, orderId: moved._id, orderNo: moved.orderNo, status });
      return ok(request, teamOrderView(moved, photoLinks(app, request), place));
    },
  );

  app.post(
    "/orders/:id/refund",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["employment"],
        summary: "Refund part of an order",
        description: 'Needs "Refund part of an order". It comes out of the shop\'s share, up to `refundable`, and the order carries on.',
        params: OrderParams,
        body: ShopRefundBody,
        response: { 200: TeamOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { doc, place } = await order(request, request.params.id, "orders.refund");
      const done = await refundPart(app, db(), doc, {
        amount: request.body.amount,
        reason: request.body.reason.trim(),
        by: "vendor",
        actor: actorOf(request),
        ip: request.ip,
      });
      return ok(request, teamOrderView(done, photoLinks(app, request), place));
    },
  );

  app.get(
    "/orders/:id/files/:fileId",
    {
      preHandler: requireAuth,
      schema: { tags: ["employment"], summary: "A link to a file to print", params: OrderFileParams, response: { 200: FileLink, ...Errors }, security },
    },
    async (request) => {
      const { doc } = await order(request, request.params.id, "orders.view");
      if (["rejected", "cancelled", "refunded"].includes(doc.status)) throw new AppError("NOT_FOUND", "This order was closed, so its files are gone.");
      if (!doc.files.some((f) => f.id.toHexString() === request.params.fileId)) throw new AppError("NOT_FOUND", "File not found.");
      return ok(request, fileLink(app, signingKey(app), request, request.params.id, request.params.fileId));
    },
  );
};

export default orders;
