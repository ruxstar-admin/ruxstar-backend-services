import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import { stamp, type PodOrderDoc, type PrintFileDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import {
  CheckoutLink,
  CreateOrderBody,
  FileLink,
  OrderFileParams,
  OrderList,
  OrderOne,
  OrderParams,
  OrdersQuery,
  PayBody,
  PlacedOrder,
  PRINT_FILE_MAX_BYTES,
  PrintFileHeaders,
  PrintFileOne,
  QuoteBody,
  QuoteOne,
} from "./contracts.js";
import {
  chargesOf,
  checkoutUrl,
  cleanName,
  countPages,
  deliversTo,
  fileKey,
  fileLink,
  filesFor,
  moveOrder,
  orderableShop,
  orderView,
  priceOf,
  safeReturn,
  signingKey,
  sniff,
  syncPayment,
} from "./orders.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const FILE_TYPES = ["application/pdf", "image/jpeg", "image/png", "application/octet-stream"];
const DAY_MS = 24 * 60 * 60_000;

/** A customer's print orders: upload files, see the price, pay, follow the order. */
const orders: FastifyPluginAsyncTypebox = async (app) => {
  app.addContentTypeParser(FILE_TYPES, { parseAs: "buffer", bodyLimit: PRINT_FILE_MAX_BYTES }, (_request, body, done) => done(null, body));
  const db = () => requireDatabase(app.db);
  const key = signingKey(app);

  const mine = async (userId: ObjectId, id: string) => {
    const doc = await db().podOrders.findOne({ _id: new ObjectId(id), customerId: userId });
    if (!doc) throw new AppError("NOT_FOUND", "Order not found.");
    return doc;
  };

  app.post(
    "/files",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 40, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["pod"],
        summary: "Upload a file to print",
        description:
          "Send the file's bytes as the body with its Content-Type (PDF, JPEG or PNG, up to 25 MB) and its name in X-File-Name. " +
          "PDF pages are counted for pricing. Files only the shop you order from can open; ones not ordered within a day are deleted.",
        headers: PrintFileHeaders,
        response: { 201: PrintFileOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const data = request.body;
      if (!Buffer.isBuffer(data) || !data.length) throw new AppError("FILE_INVALID");
      const type = sniff(data);
      if (!type) throw new AppError("FILE_INVALID");
      const pages = await countPages(data, type);
      const userId = request.auth!.userId;
      const id = new ObjectId();
      const doc: PrintFileDoc = {
        _id: id,
        userId,
        key: fileKey(userId, id, type),
        name: cleanName(request.headers["x-file-name"], type),
        contentType: type,
        bytes: data.length,
        pages,
        orderId: null,
        createdAt: new Date(),
      };
      await app.printFiles.save(doc.key, data, type);
      await db().printFiles.insertOne(doc);

      const stale = await db()
        .printFiles.find({ userId, orderId: null, createdAt: { $lt: new Date(Date.now() - DAY_MS) } })
        .limit(50)
        .toArray();
      if (stale.length) {
        await Promise.all(stale.map((f) => app.printFiles.remove(f.key)));
        await db().printFiles.deleteMany({ _id: { $in: stale.map((f) => f._id) }, orderId: null });
      }

      reply.code(201);
      return ok(request, { id: id.toHexString(), name: doc.name, contentType: type, bytes: doc.bytes, pages });
    },
  );

  app.post(
    "/quote",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["pod"],
        summary: "What an order would cost",
        description: "The same checks and prices as placing it, so a quote that passes can be ordered.",
        body: QuoteBody,
        response: { 200: QuoteOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const body = request.body;
      const shop = await orderableShop(db(), body.shopId, userId);
      const files = await filesFor(db(), userId, body.fileIds);
      const pages = files.reduce((sum, f) => sum + f.pages, 0);
      const priced = priceOf(shop, body, pages, await chargesOf(db()));
      const { units, unitPrice, extrasPerUnit, items, platformFee, total } = priced.price;
      return ok(request, { units, unitPrice, extrasPerUnit, items, platformFee, total, pages, minOrder: priced.minOrder, turnaroundDays: priced.turnaroundDays });
    },
  );

  app.post(
    "/orders",
    {
      preHandler: [requireAuth, idempotent],
      config: { rateLimit: { max: 20, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["pod"],
        summary: "Place a print order",
        description:
          "Prices the order, sets it up with Cashfree and returns a checkout link. The shop sees it once it is paid. " +
          "An order not paid when Cashfree's checkout expires is cancelled.",
        body: CreateOrderBody,
        response: { 201: PlacedOrder, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const database = db();
      const userId = request.auth!.userId;
      const body = request.body;
      const back = safeReturn(app, body.returnTo);
      const shop = await orderableShop(database, body.shopId, userId);
      if (!shop.open) throw new AppError("SHOP_CLOSED");
      if (!deliversTo(shop, body.address.city)) {
        throw new AppError("ORDER_INVALID", `${shop.name} doesn't deliver to ${body.address.city}.`, [
          { path: "body/address/city", message: "Not delivered here" },
        ]);
      }
      const files = await filesFor(database, userId, body.fileIds);
      const priced = priceOf(shop, body, files.reduce((sum, f) => sum + f.pages, 0), await chargesOf(database));
      const user = await database.users.findOne({ _id: userId }, { projection: { phone: 1, name: 1 } });

      const id = new ObjectId();
      const gatewayOrderId = `rx_${id.toHexString()}`;
      const origin = app.config.apiUrl;
      const { sessionId } = await app.payments.createOrder({
        orderId: gatewayOrderId,
        amount: priced.price.total,
        customer: { id: userId.toHexString(), phone: (user?.phone ?? `+91${body.address.phone}`).slice(-10), name: user?.name ?? body.address.name },
        note: `${priced.label} from ${shop.name}`,
        returnUrl: origin ? `${origin}/pay/${id.toHexString()}/done` : null,
        notifyUrl: origin ? `${origin}/webhooks/cashfree` : null,
      });

      const now = new Date();
      const doc = await database.transaction(async (session) => {
        const claimed = await database.printFiles.updateMany(
          { _id: { $in: files.map((f) => f._id) }, userId, orderId: null },
          { $set: { orderId: id } },
          { session },
        );
        if (claimed.modifiedCount !== files.length) throw new AppError("ORDER_INVALID", "One of these files is in another order. Upload it again.");
        const order: PodOrderDoc = {
          _id: id,
          orderNo: await database.nextNumber("pod-order", session),
          customerId: userId,
          shopId: shop._id,
          vendorId: shop.ownerId,
          shopName: shop.name,
          product: body.product,
          productLabel: priced.label,
          pricing: priced.pricing,
          options: priced.options,
          colour: priced.colour,
          quantity: body.quantity,
          files: files.map((f) => ({ id: f._id, key: f.key, name: f.name, contentType: f.contentType, bytes: f.bytes, pages: f.pages })),
          price: priced.price,
          address: { ...body.address, name: body.address.name.trim(), line: body.address.line.trim(), city: body.address.city.trim() },
          note: body.note?.trim() || null,
          status: "awaiting_payment",
          timeline: [{ status: "awaiting_payment", at: now, by: "customer" }],
          payment: { gatewayOrderId, sessionId, paymentId: null, paidAt: null },
          refund: null,
          reason: null,
          ...stamp(now),
        };
        await database.podOrders.insertOne(order, { session });
        return order;
      });

      reply.code(201);
      return ok(request, { order: orderView(doc), checkoutUrl: checkoutUrl(app, key, request, id.toHexString(), back) });
    },
  );

  app.post(
    "/orders/:id/pay",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["pod"],
        summary: "A fresh checkout link for an unpaid order",
        params: OrderParams,
        body: PayBody,
        response: { 200: CheckoutLink, ...Errors },
        security,
      },
    },
    async (request) => {
      const back = safeReturn(app, request.body.returnTo);
      const order = await syncPayment(app, db(), await mine(request.auth!.userId, request.params.id));
      if (order.status !== "awaiting_payment") throw new AppError("ORDER_STATE");
      return ok(request, { checkoutUrl: checkoutUrl(app, key, request, order._id.toHexString(), back) });
    },
  );

  app.get(
    "/orders",
    {
      preHandler: requireAuth,
      schema: { tags: ["pod"], summary: "Your print orders, newest first", querystring: OrdersQuery, response: { 200: OrderList, ...Errors }, security },
    },
    async (request) => {
      const { items, nextCursor } = await findPage(db().podOrders, {
        filter: { customerId: request.auth!.userId },
        sortField: "createdAt",
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      return page(request, items.map(orderView), nextCursor);
    },
  );

  app.get(
    "/orders/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["pod"],
        summary: "One of your print orders",
        description: "While it waits for payment, Cashfree is asked whether it was paid.",
        params: OrderParams,
        response: { 200: OrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const order = await syncPayment(app, db(), await mine(request.auth!.userId, request.params.id));
      return ok(request, orderView(order));
    },
  );

  app.post(
    "/orders/:id/cancel",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["pod"],
        summary: "Cancel an order the shop has not accepted yet",
        description: "A paid order is refunded in full.",
        params: OrderParams,
        response: { 200: OrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      let order = await syncPayment(app, database, await mine(request.auth!.userId, request.params.id));
      if (order.status === "awaiting_payment") {
        // Closed at Cashfree first, so a payment can't arrive after the cancel. If it already did, the order is placed and refunded below.
        const closed = await app.payments.terminate(order.payment.gatewayOrderId).then(
          () => true,
          () => false,
        );
        if (!closed) order = await syncPayment(app, database, order);
        if (!closed && order.status === "awaiting_payment") throw new AppError("PAYMENTS_UNAVAILABLE");
      }
      if (order.status === "cancelled") return ok(request, orderView(order));
      if (order.status !== "awaiting_payment" && order.status !== "placed") {
        throw new AppError("ORDER_STATE", "The shop has started on this order, so it can't be cancelled here. Contact the shop.");
      }
      const moved = await moveOrder(app, database, order, "cancelled", { kind: "customer", actor: actorOf(request), ip: request.ip });
      return ok(request, orderView(moved));
    },
  );

  app.get(
    "/orders/:id/files/:fileId",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["pod"],
        summary: "A link to one of your order's files",
        params: OrderFileParams,
        response: { 200: FileLink, ...Errors },
        security,
      },
    },
    async (request) => {
      const order = await mine(request.auth!.userId, request.params.id);
      if (!order.files.some((f) => f.id.toHexString() === request.params.fileId)) throw new AppError("NOT_FOUND", "File not found.");
      return ok(request, fileLink(app, key, request, request.params.id, request.params.fileId));
    },
  );
};

export default orders;
