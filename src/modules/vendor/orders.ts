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
import {
  FileLink,
  OrderFileParams,
  OrderParams,
  ShopOrderList,
  ShopOrderOne,
  ShopOrdersQuery,
  ShopRefundBody,
  ShopStatusBody,
} from "../pod/contracts.js";
import { applyDue, dueApplied, refundPart } from "../pod/order-rules.js";
import { fileLink, moveOrder, photoLinks, shopCanMove, shopOrderView, signingKey } from "../pod/orders.js";
import { AssignBody, DeliveryOptions } from "../delivery/contracts.js";
import { riderHasIt } from "../delivery/stop.js";
import { assignTrip, cancelTrip, deliveryOptions } from "../delivery/trips.js";
import { requireVendor } from "./businesses.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

const VIEWS: Record<"new" | "active" | "past", PodOrderStatus[]> = {
  new: ["placed"],
  active: ["accepted", "printing", "ready", "out_for_delivery"],
  past: ["delivered", "rejected", "cancelled", "refunded"],
};

/** Orders to a vendor's shops. Orders still waiting for payment, or cancelled before it, are the customer's alone. */
const orders: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  const theirs = async (vendorId: ObjectId, id: string) => {
    const doc = await db().podOrders.findOne({ _id: new ObjectId(id), vendorId, "payment.paidAt": { $ne: null } });
    if (!doc) throw new AppError("NOT_FOUND", "Order not found.");
    return applyDue(app, db(), doc);
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
      const links = photoLinks(app, request);
      return page(request, (await dueApplied(app, db(), items)).map((o) => shopOrderView(o, links)), nextCursor);
    },
  );

  app.get(
    "/orders/:id",
    {
      preHandler: requireVendor,
      schema: { tags: ["vendor"], summary: "One order to your shop", params: OrderParams, response: { 200: ShopOrderOne, ...Errors }, security },
    },
    async (request) => ok(request, shopOrderView(await theirs(request.auth!.userId, request.params.id), photoLinks(app, request))),
  );

  app.post(
    "/orders/:id/status",
    {
      preHandler: [requireVendor, idempotent],
      schema: {
        tags: ["vendor"],
        summary: "Accept or turn down a new order, or move it on",
        description:
          "A new order is accepted or turned down (with a reason; the customer is refunded in full). One not accepted within 6 hours " +
          "of payment is cancelled and refunded. After that it moves through printing, ready, out for delivery and delivered; steps " +
          "can be skipped. Your share becomes available 48 hours after delivery, unless the customer reports a problem first.",
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
      riderHasIt(order, status);
      if (status === "rejected" && !reason?.trim()) {
        throw new AppError("VALIDATION_FAILED", "Tell the customer why.", [{ path: "body/reason", message: "Tell the customer why." }]);
      }
      if (status === "accepted") {
        const shop = await database.businesses.findOne({ _id: order.shopId }, { projection: { suspension: 1 } });
        if (shop?.suspension) throw new AppError("BUSINESS_SUSPENDED");
      }
      const moved = await moveOrder(app, database, order, status, { kind: "vendor", actor: actorOf(request), ip: request.ip }, { reason: reason?.trim() ?? null });
      return ok(request, shopOrderView(moved, photoLinks(app, request)));
    },
  );

  app.post(
    "/orders/:id/refund",
    {
      preHandler: [requireVendor, idempotent],
      schema: {
        tags: ["vendor"],
        summary: "Refund part of an order",
        description:
          "For when part of an order can't be made, or to put something right. It comes out of your share, up to `refundable`, " +
          "and the order carries on. Not possible once your share is released.",
        params: OrderParams,
        body: ShopRefundBody,
        response: { 200: ShopOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const order = await theirs(request.auth!.userId, request.params.id);
      const done = await refundPart(app, db(), order, {
        amount: request.body.amount,
        reason: request.body.reason.trim(),
        by: "vendor",
        actor: actorOf(request),
        ip: request.ip,
      });
      return ok(request, shopOrderView(done, photoLinks(app, request)));
    },
  );

  app.get(
    "/orders/:id/delivery",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Who can deliver an order: your team, or a Ruxstar partner and what they'd be paid",
        description: "Delivering it yourself needs nothing here: mark it out for delivery and delivered as usual.",
        params: OrderParams,
        response: { 200: DeliveryOptions, ...Errors },
        security,
      },
    },
    async (request) => ok(request, await deliveryOptions(db(), await theirs(request.auth!.userId, request.params.id))),
  );

  app.post(
    "/orders/:id/delivery",
    {
      preHandler: [requireVendor, idempotent],
      schema: {
        tags: ["vendor"],
        summary: "Send a ready order with someone on your team, or offer it to Ruxstar partners",
        description:
          'Someone on the team needs "Deliver orders" and delivery verification, and accepts it in the Ruxstar Delivery app. A partner offer ' +
          "goes to the partners online in your city; the first to accept gets it, and their pay comes out of your share at delivery.",
        params: OrderParams,
        body: AssignBody,
        response: { 200: ShopOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const order = await theirs(request.auth!.userId, request.params.id);
      const updated = await assignTrip(app, db(), order, request.body, { actor: actorOf(request), ip: request.ip });
      return ok(request, shopOrderView(updated, photoLinks(app, request)));
    },
  );

  app.delete(
    "/orders/:id/delivery",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Cancel a delivery before it is picked up",
        params: OrderParams,
        response: { 200: ShopOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const order = await theirs(request.auth!.userId, request.params.id);
      const updated = await cancelTrip(app, db(), order, { actor: actorOf(request), ip: request.ip });
      return ok(request, shopOrderView(updated, photoLinks(app, request)));
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
      if (["rejected", "cancelled", "refunded"].includes(order.status)) throw new AppError("NOT_FOUND", "This order was closed, so its files are gone.");
      if (!order.files.some((f) => f.id.toHexString() === request.params.fileId)) throw new AppError("NOT_FOUND", "File not found.");
      return ok(request, fileLink(app, signingKey(app), request, request.params.id, request.params.fileId));
    },
  );
};

export default orders;
