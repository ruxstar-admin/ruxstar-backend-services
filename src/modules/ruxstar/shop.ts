import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type Filter } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, diffOf, writeAudit } from "../../platform/audit.js";
import { requireRuxstar } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import { stamp, type BusinessDoc, type ShopBannedDoc, type ShopOrderDoc, type ShopProductDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { notifyShop } from "../notifications/notify.js";
import { escapeRegex } from "../pod/shops.js";
import {
  BannedList,
  BannedOne,
  BannedParams,
  ConsoleCancelBody,
  ConsoleOrderList,
  ConsoleOrderOne,
  ConsoleOrdersQuery,
  ConsoleProductList,
  ConsoleProductOne,
  ConsoleProductsQuery,
  ConsoleReturnBody,
  ConsoleStoreList,
  ConsoleStoreOne,
  ConsoleStoresQuery,
  CreateBannedBody,
  IdParams,
  TakeDownBody,
  UpdateBannedBody,
} from "../shop/contracts.js";
import { cancelShopOrder, decideReturn, freshShop, refundReturn, storeLink, type By } from "../shop/orders.js";
import { loadBanned } from "../shop/products.js";
import { shopSettings, type ShopSettings } from "../shop/rules.js";
import { consoleOrderViews, setupView, storeCard, vendorProduct } from "../shop/views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const bannedView = (b: ShopBannedDoc) => ({ key: b._id, name: b.name, words: b.words, active: b.active, updatedAt: b.updatedAt.toISOString() });
const cleanWords = (words: string[]) => [...new Set(words.map((w) => w.trim().toLowerCase().replace(/\s+/g, " ")).filter((w) => w.length >= 2))];
const OPEN = ["paid", "accepted", "packed", "out_for_delivery", "ready_for_pickup"] as const;

/** Local shops in the console: shops and products, take-downs, the banned categories list, orders and returns. Shops and products go live without review. */
const shop: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const byOf = (request: FastifyRequest): By => ({ kind: "staff", actor: actorOf(request), ip: request.ip });

  async function storeViews(docs: BusinessDoc[], settings: ShopSettings) {
    const ids = docs.map((d) => d._id);
    const group = { $group: { _id: "$businessId", n: { $sum: 1 } } };
    const [products, orders] = await Promise.all([
      db().shopProducts.aggregate<{ _id: ObjectId; n: number }>([{ $match: { businessId: { $in: ids }, status: { $ne: "removed" } } }, group]).toArray(),
      db().shopOrders.aggregate<{ _id: ObjectId; n: number }>([{ $match: { businessId: { $in: ids }, "payment.paidAt": { $type: "date" } } }, group]).toArray(),
    ]);
    return docs.map((d) => ({
      ...storeCard(d, settings),
      ownerId: d.ownerId.toHexString(),
      status: d.status,
      suspended: Boolean(d.suspension),
      products: products.find((c) => c._id.equals(d._id))?.n ?? 0,
      orders: orders.find((c) => c._id.equals(d._id))?.n ?? 0,
      createdAt: d.createdAt.toISOString(),
    }));
  }
  async function productView(p: ShopProductDoc) {
    const business = (await db().businesses.findOne({ _id: p.businessId }))!;
    return { ...vendorProduct(p, business, await shopSettings(db()), p.status === "removed" ? "Ruxstar took this product down." : "Seen from the console."), vendorId: p.vendorId.toHexString() };
  }
  async function order(id: string) {
    const o = await db().shopOrders.findOne({ _id: new ObjectId(id) });
    if (!o) throw new AppError("NOT_FOUND", "Order not found.");
    return o;
  }
  const oneOrder = async (o: ShopOrderDoc) => (await consoleOrderViews(db(), await freshShop(app, db(), [o])))[0]!;

  app.get(
    "/shop/stores",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: { tags: ["ruxstar"], summary: "Every local shop, newest first, with its product and order counts", querystring: ConsoleStoresQuery, response: { 200: ConsoleStoreList, ...Errors }, security },
    },
    async (request) => {
      const { city, q, cursor, limit } = request.query;
      const filter: Filter<BusinessDoc> = { module: "shop" };
      if (city) filter["location.city"] = { $regex: `^${escapeRegex(city.trim())}$`, $options: "i" };
      if (q?.trim()) filter.name = { $regex: escapeRegex(q.trim()), $options: "i" };
      const { items, nextCursor } = await findPage(db().businesses, { filter, sortField: "createdAt", cursor, limit });
      return page(request, await storeViews(items, await shopSettings(db())), nextCursor);
    },
  );

  app.get(
    "/shop/stores/:id",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: { tags: ["ruxstar"], summary: "One local shop: its setup, open orders and open returns", params: IdParams, response: { 200: ConsoleStoreOne, ...Errors }, security },
    },
    async (request) => {
      const doc = await db().businesses.findOne({ _id: new ObjectId(request.params.id), module: "shop" });
      if (!doc) throw new AppError("NOT_FOUND", "Shop not found.");
      const [[store], openOrders, openReturns] = await Promise.all([
        storeViews([doc], await shopSettings(db())),
        db().shopOrders.countDocuments({ businessId: doc._id, status: { $in: [...OPEN] } }),
        db().shopOrders.countDocuments({ businessId: doc._id, "return.status": { $in: ["requested", "approved"] } }),
      ]);
      return ok(request, { store: store!, setup: setupView(doc), openOrders, openReturns });
    },
  );

  app.get(
    "/shop/products",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: { tags: ["ruxstar"], summary: "Every local shop product, newest first", querystring: ConsoleProductsQuery, response: { 200: ConsoleProductList, ...Errors }, security },
    },
    async (request) => {
      const { status, shop: shopId, city, q, cursor, limit } = request.query;
      const filter: Filter<ShopProductDoc> = {};
      if (status) filter.status = status;
      if (shopId) filter.businessId = new ObjectId(shopId);
      if (city) filter.city = city.trim().toLowerCase();
      if (q?.trim()) filter.title = { $regex: escapeRegex(q.trim()), $options: "i" };
      const { items, nextCursor } = await findPage(db().shopProducts, { filter, sortField: "createdAt", cursor, limit });
      const settings = await shopSettings(db());
      const shops = await db().businesses.find({ _id: { $in: items.map((p) => p.businessId) } }).toArray();
      return page(
        request,
        items.map((p) => ({ ...vendorProduct(p, shops.find((s) => s._id.equals(p.businessId))!, settings), vendorId: p.vendorId.toHexString() })),
        nextCursor,
      );
    },
  );

  app.get(
    "/shop/products/:id",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: { tags: ["ruxstar"], summary: "One local shop product, with every variant", params: IdParams, response: { 200: ConsoleProductOne, ...Errors }, security },
    },
    async (request) => {
      const p = await db().shopProducts.findOne({ _id: new ObjectId(request.params.id) });
      if (!p) throw new AppError("NOT_FOUND", "Product not found.");
      return ok(request, await productView(p));
    },
  );

  app.post(
    "/shop/products/:id/take-down",
    {
      preHandler: [requireRuxstar("businesses.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Take a product down",
        description: "It leaves the listings and can't be changed or sold again; the shop is told why. Orders already placed go on. Audited.",
        params: IdParams,
        body: TakeDownBody,
        response: { 200: ConsoleProductOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const p = await db().shopProducts.findOne({ _id: new ObjectId(request.params.id) });
      if (!p) throw new AppError("NOT_FOUND", "Product not found.");
      if (p.status === "removed") throw new AppError("CONFLICT", "This product is down already.");
      const reason = request.body.reason.trim();
      const now = new Date();
      const after = await db().shopProducts.findOneAndUpdate(
        { _id: p._id, status: { $ne: "removed" } },
        { $set: { status: "removed", removal: { actorId: request.auth!.userId, reason, at: now }, updatedAt: now }, $inc: { seq: 1 } },
        { returnDocument: "after" },
      );
      if (!after) throw new AppError("CONFLICT", "This product is down already.");
      await writeAudit(db(), {
        actor: actorOf(request),
        scope: { module: "shop", businessId: p.businessId },
        action: "shop_product.take_down",
        target: { type: "shop_product", id: p._id },
        diff: { status: { from: p.status, to: "removed" }, reason: { from: null, to: reason } },
        ip: request.ip,
      });
      await notifyShop(db(), request.log, {
        actor: request.auth!.userId,
        type: "shop.updated",
        title: `Ruxstar took down ${p.title}`,
        body: `${reason} Contact support if you think this is a mistake.`,
        to: [{ userId: p.vendorId, link: storeLink(p.businessId) }],
      });
      return ok(request, await productView(after));
    },
  );

  app.get(
    "/shop/banned",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "The banned categories list: words and phrases products can't use",
        description: "Starts with Ruxstar's defaults the first time it's read.",
        response: { 200: BannedList, ...Errors },
        security,
      },
    },
    async (request) => page(request, (await loadBanned(db())).map(bannedView), null),
  );

  app.post(
    "/shop/banned",
    {
      preHandler: [requireRuxstar("modules.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Add a banned category",
        description: "New and changed products using one of its words are refused from now; products saved before stay until taken down. The key can't change later. Audited.",
        body: CreateBannedBody,
        response: { 201: BannedOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const list = await loadBanned(db());
      if (list.some((b) => b._id === request.body.key)) throw new AppError("CONFLICT", "A category with this key is on the list already.");
      const words = cleanWords(request.body.words);
      if (!words.length) throw new AppError("VALIDATION_FAILED", "Add at least one word.", [{ path: "body/words", message: "Empty" }]);
      const doc: ShopBannedDoc = { _id: request.body.key, name: request.body.name.trim(), words, active: true, ...stamp() };
      try {
        await db().shopBanned.insertOne(doc);
      } catch (err) {
        if ((err as { code?: number }).code === 11000) throw new AppError("CONFLICT", "A category with this key is on the list already.");
        throw err;
      }
      await writeAudit(db(), {
        actor: actorOf(request),
        scope: { module: "shop" },
        action: "shop_banned.create",
        target: { type: "shop_banned", id: doc._id },
        diff: { name: { from: null, to: doc.name }, words: { from: null, to: words } },
        ip: request.ip,
      });
      return reply.status(201).send(ok(request, bannedView(doc)));
    },
  );

  app.patch(
    "/shop/banned/:key",
    {
      preHandler: requireRuxstar("modules.manage"),
      schema: {
        tags: ["ruxstar"],
        summary: "Rename a banned category, change its words, or stop checking it",
        description: "Audited.",
        params: BannedParams,
        body: UpdateBannedBody,
        response: { 200: BannedOne, ...Errors },
        security,
      },
    },
    async (request) => {
      await loadBanned(db());
      const before = await db().shopBanned.findOne({ _id: request.params.key });
      if (!before) throw new AppError("NOT_FOUND", "Category not found.");
      const changes: Partial<Pick<ShopBannedDoc, "name" | "words" | "active">> = {};
      if (request.body.name !== undefined) changes.name = request.body.name.trim();
      if (request.body.words !== undefined) {
        changes.words = cleanWords(request.body.words);
        if (!changes.words.length) throw new AppError("VALIDATION_FAILED", "Add at least one word.", [{ path: "body/words", message: "Empty" }]);
      }
      if (request.body.active !== undefined) changes.active = request.body.active;
      const diff = diffOf(before, changes);
      if (!Object.keys(diff).length) return ok(request, bannedView(before));
      const after = await db().shopBanned.findOneAndUpdate({ _id: before._id }, { $set: { ...changes, updatedAt: new Date() } }, { returnDocument: "after" });
      await writeAudit(db(), { actor: actorOf(request), scope: { module: "shop" }, action: "shop_banned.update", target: { type: "shop_banned", id: before._id }, diff, ip: request.ip });
      return ok(request, bannedView(after!));
    },
  );

  app.get(
    "/shop/orders",
    {
      preHandler: requireRuxstar("orders.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "Local shop orders, newest first",
        description: "Filter by shop, status, or returns: open ones hold the shop's money; rejected ones can still be approved here.",
        querystring: ConsoleOrdersQuery,
        response: { 200: ConsoleOrderList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { shop: shopId, status, returns, cursor, limit } = request.query;
      const filter: Filter<ShopOrderDoc> = {};
      if (shopId) filter.businessId = new ObjectId(shopId);
      if (status) filter.status = status;
      if (returns) filter["return.status"] = returns === "open" ? { $in: ["requested", "approved"] } : "rejected";
      const { items, nextCursor } = await findPage(db().shopOrders, { filter, sortField: "createdAt", cursor, limit });
      return page(request, await consoleOrderViews(db(), await freshShop(app, db(), items)), nextCursor);
    },
  );

  app.get(
    "/shop/orders/:id",
    {
      preHandler: requireRuxstar("orders.view"),
      schema: { tags: ["ruxstar"], summary: "One local shop order", params: IdParams, response: { 200: ConsoleOrderOne, ...Errors }, security },
    },
    async (request) => ok(request, await oneOrder(await order(request.params.id))),
  );

  app.post(
    "/shop/orders/:id/cancel",
    {
      preHandler: [requireRuxstar("orders.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Cancel an order before delivery and refund it in full",
        description: "The stock goes back and a rider's trip is stopped. The customer and the shop are told. Audited.",
        params: IdParams,
        body: ConsoleCancelBody,
        response: { 200: ConsoleOrderOne, ...Errors },
        security,
      },
    },
    async (request) => ok(request, await oneOrder(await cancelShopOrder(app, db(), await order(request.params.id), byOf(request), request.body.reason.trim()))),
  );

  app.post(
    "/shop/orders/:id/return",
    {
      preHandler: [requireRuxstar("orders.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Decide a return: approve, reject, or refund it now",
        description: "Ruxstar can approve or refund one the shop turned down. Refund pays the customer out of the shop's pending share. Both sides are told. Audited.",
        params: IdParams,
        body: ConsoleReturnBody,
        response: { 200: ConsoleOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const o = await order(request.params.id);
      const note = request.body.note.trim();
      const done =
        request.body.decision === "refund" ? await refundReturn(app, db(), o, byOf(request), note) : await decideReturn(app, db(), o, byOf(request), request.body.decision, note);
      return ok(request, await oneOrder(done));
    },
  );
};

export default shop;
