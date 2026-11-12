import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId, type Filter } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireDatabase } from "../../platform/context.js";
import type { PodOrderDoc, PodOrderStatus } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { FileLink, OrderFileParams, OrderParams, ShopOrderList, ShopOrderOne, ShopOrdersQuery, ShopStatusBody } from "../pod/contracts.js";
import { fileLink, moveOrder, shopCanMove, shopOrderView, signingKey } from "../pod/orders.js";
import { requireVendor } from "./businesses.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

const VIEWS: Record<"new" | "active" | "past", PodOrderStatus[]> = {
  new: ["placed"],
  active: ["accepted", "printing", "ready", "out_for_delivery"],
  past: ["delivered", "rejected", "cancelled"],
};

/** Orders to a vendor's shops. Orders still waiting for payment, or cancelled before it, are the customer's alone. */
const orders: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  const theirs = async (vendorId: ObjectId, id: string) => {
    const doc = await db().podOrders.findOne({ _id: new ObjectId(id), vendorId, "payment.paidAt": { $ne: null } });
    if (!doc) throw new AppError("NOT_FOUND", "Order not found.");
    return doc;
  };

  app.get(
    "/orders",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Orders to your shops, newest first",
        querystring: ShopOrdersQuery,
        response: { 200: ShopOrderList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { business, view, cursor, limit } = request.query;
      const filter: Filter<PodOrderDoc> = {
        vendorId: request.auth!.userId,
        status: { $in: view ? VIEWS[view] : [...VIEWS.new, ...VIEWS.active, ...VIEWS.past] },
        "payment.paidAt": { $ne: null },
        ...(business ? { shopId: new ObjectId(business) } : {}),
      };
      const { items, nextCursor } = await findPage(db().podOrders, { filter, sortField: "createdAt", cursor, limit });
      return page(request, items.map(shopOrderView), nextCursor);
    },
  );

  app.get(
    "/orders/:id",
    {
      preHandler: requireVendor,
      schema: { tags: ["vendor"], summary: "One order to your shop", params: OrderParams, response: { 200: ShopOrderOne, ...Errors }, security },
    },
    async (request) => ok(request, shopOrderView(await theirs(request.auth!.userId, request.params.id))),
  );

  app.post(
    "/orders/:id/status",
    {
      preHandler: [requireVendor, idempotent],
      schema: {
        tags: ["vendor"],
        summary: "Accept or turn down a new order, or move it on",
        description:
          "A new order is accepted or turned down (with a reason; the customer is refunded in full). After that it moves through printing, " +
          "ready, out for delivery and delivered; steps can be skipped. On delivery your share moves to your available balance.",
        params: OrderParams,
        body: ShopStatusBody,
        response: { 200: ShopOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const order = await theirs(request.auth!.userId, request.params.id);
      const { status, reason } = request.body;
      if (!shopCanMove(order.status, status)) throw new AppError("ORDER_STATE");
      if (status === "rejected" && !reason?.trim()) {
        throw new AppError("VALIDATION_FAILED", "Tell the customer why.", [{ path: "body/reason", message: "Tell the customer why." }]);
      }
      if (status === "accepted") {
        const shop = await database.businesses.findOne({ _id: order.shopId }, { projection: { suspension: 1 } });
        if (shop?.suspension) throw new AppError("BUSINESS_SUSPENDED");
      }
      const moved = await moveOrder(app, database, order, status, { kind: "vendor", actor: actorOf(request), ip: request.ip }, { reason: reason?.trim() ?? null });
      return ok(request, shopOrderView(moved));
    },
  );

  app.get(
    "/orders/:id/files/:fileId",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "A link to a file to print",
        params: OrderFileParams,
        response: { 200: FileLink, ...Errors },
        security,
      },
    },
    async (request) => {
      const order = await theirs(request.auth!.userId, request.params.id);
      if (order.status === "rejected" || order.status === "cancelled") throw new AppError("NOT_FOUND", "This order was closed, so its files are gone.");
      if (!order.files.some((f) => f.id.toHexString() === request.params.fileId)) throw new AppError("NOT_FOUND", "File not found.");
      return ok(request, fileLink(app, signingKey(app), request, request.params.id, request.params.fileId));
    },
  );
};

export default orders;
