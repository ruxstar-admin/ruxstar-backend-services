import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type Filter, type WithId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { publicCache, requireAuth, signedInIfPossible } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { BusinessDoc, ShopOrderDoc, ShopProductDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { isModuleLive } from "../../platform/module-switch.js";
import { findPage } from "../../platform/pagination.js";
import { checkCode, offersFor } from "../coupons/coupons.js";
import { safeReturn } from "../pod/orders.js";
import { escapeRegex } from "../pod/shops.js";
import { Done, MyReviewOne, ReviewBody, ReviewList, ReviewReportBody, ShopReviewsQuery } from "../reviews/contracts.js";
import { authorsOf, deleteReview, myReviewView, reportReview, reviewView, writeReview } from "../reviews/reviews.js";
import { shopCheckoutUrl } from "./checkout.js";
import {
  CancelBody,
  CheckoutLinkOne,
  IdParams,
  MyOrdersQuery,
  OrderReviewParams,
  PayBody,
  PlacedShopOrder,
  PlaceOrderBody,
  ProductList,
  ProductOne,
  ProductsQuery,
  QuoteBody,
  QuoteOne,
  ReturnBody,
  ShopOrderList,
  ShopOrderOne,
  ShopRulesOne,
  StoreList,
  StoreOne,
  StoresQuery,
} from "./contracts.js";
import desk from "./desk.js";
import { cancelShopOrder, freshShop, orderProblem, placeShopOrder, priceCart, requestReturn, syncShopPayment, type By } from "./orders.js";
import { shopSettings } from "./rules.js";
import { addressOf, orderViews, productCard, productDetail, productProblem, productReviewable, setupView, shopReturnText, storeCard } from "./views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const signedInOrNot: Record<string, string[]>[] = [{}, { bearer: [] }, { cookie: [] }];

/** Customers see a local shop while it is live and not on hold; the module being off hides them all. */
const visibleStores: Filter<BusinessDoc> = { module: "shop", status: "live", suspension: { $exists: false } };

/** Local shops for customers: shops and products by city, a product's variants, the cart's price, ordering and paying, their orders, returns and reviews. The shop's own work is under /desk. */
const shop: FastifyPluginAsyncTypebox = async (app) => {
  await app.register(desk, { prefix: "/desk" });
  const db = () => requireDatabase(app.db);
  const byOf = (request: FastifyRequest): By => ({ kind: "customer", actor: actorOf(request), ip: request.ip });

  async function store(id: string | ObjectId) {
    const doc = await db().businesses.findOne({ _id: new ObjectId(id), ...visibleStores });
    if (!doc) throw new AppError("NOT_FOUND", "This shop isn't on Ruxstar.");
    return doc;
  }
  /** A shop customers can order from now. */
  async function orderable(id: string) {
    const doc = await store(id);
    if (!(await isModuleLive(db(), "shop"))) throw new AppError("MODULE_OFF");
    const problem = orderProblem(doc);
    if (problem) throw new AppError("SHOP_CLOSED", problem);
    return doc;
  }
  async function mine(userId: ObjectId, id: string) {
    const doc = await db().shopOrders.findOne({ _id: new ObjectId(id), customerId: userId });
    if (!doc) throw new AppError("NOT_FOUND", "Order not found.");
    return doc;
  }
  async function customerOf(request: FastifyRequest) {
    const userId = request.auth!.userId;
    const user = await db().users.findOne({ _id: userId }, { projection: { phone: 1, name: 1 } });
    if (!user) throw new AppError("UNAUTHENTICATED");
    return { id: userId, phone: user.phone, name: user.name?.trim() || null };
  }
  async function visibleProduct(id: ObjectId) {
    const p = await db().shopProducts.findOne({ _id: id, status: "live" }, { projection: { businessId: 1 } });
    if (!p) return false;
    return Boolean(await db().businesses.findOne({ _id: p.businessId, ...visibleStores }, { projection: { _id: 1 } }));
  }
  const one = async (o: ShopOrderDoc) => (await orderViews(db(), [o]))[0]!;

  app.get(
    "/rules",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["shop"],
        summary: "Ruxstar's rules for local shops: return days, options per product, when shops are paid, checkout time and fees",
        description: "No sign-in needed.",
        response: { 200: ShopRulesOne, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      publicCache(request, reply);
      const { live: _live, deliveryEnabled: _delivery, ...rules } = await shopSettings(db());
      return ok(request, rules);
    },
  );

  app.get(
    "/",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["shop"],
        summary: "Local shops, newest first",
        description: "No sign-in needed. Filter by city, type and name. Empty while Ruxstar has local shops switched off.",
        querystring: StoresQuery,
        response: { 200: StoreList, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      publicCache(request, reply);
      if (!(await isModuleLive(db(), "shop"))) return page(request, [], null);
      const q = request.query;
      const filters: Filter<BusinessDoc>[] = [visibleStores];
      if (q.city) filters.push({ "location.city": { $regex: `^${escapeRegex(q.city.trim())}$`, $options: "i" } });
      if (q.type) filters.push({ type: q.type as BusinessDoc["type"] });
      if (q.q?.trim()) filters.push({ name: { $regex: escapeRegex(q.q.trim()), $options: "i" } });
      const { items, nextCursor } = await findPage(db().businesses, { filter: { $and: filters }, sortField: "publishedAt", cursor: q.cursor, limit: q.limit });
      const settings = await shopSettings(db());
      return page(
        request,
        items.map((b) => storeCard(b, settings)),
        nextCursor,
      );
    },
  );

  app.get(
    "/products",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["shop"],
        summary: "Products for sale at local shops, newest first",
        description: "No sign-in needed. Filter by city, one shop, words in the title, and in stock. A shop's own page lists its products with `shop`.",
        querystring: ProductsQuery,
        response: { 200: ProductList, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      publicCache(request, reply);
      if (!(await isModuleLive(db(), "shop"))) return page(request, [], null);
      const q = request.query;
      const filters: Filter<ShopProductDoc>[] = [{ status: "live" }];
      if (q.city) filters.push({ city: q.city.trim().toLowerCase() });
      if (q.shop) filters.push({ businessId: new ObjectId(q.shop) });
      if (q.q?.trim()) filters.push({ title: { $regex: escapeRegex(q.q.trim()), $options: "i" } });
      if (q.inStock !== undefined) filters.push({ inStock: q.inStock });
      const { items, nextCursor } = await findPage(db().shopProducts, { filter: { $and: filters }, sortField: "createdAt", cursor: q.cursor, limit: q.limit });
      const live = await db()
        .businesses.find({ _id: { $in: items.map((p) => p.businessId) }, ...visibleStores }, { projection: { _id: 1 } })
        .toArray();
      return page(
        request,
        items.filter((p) => live.some((b) => b._id.equals(p.businessId))).map(productCard),
        nextCursor,
      );
    },
  );

  app.get(
    "/products/:id",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["shop"],
        summary: "One product: its photo, options and every variant's price, MRP and stock, for the variant picker",
        description: "No sign-in needed. A combination missing from `variants` isn't sold. Products the shop hid or Ruxstar took down aren't found, except by the shop's owner.",
        params: IdParams,
        response: { 200: ProductOne, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      const p = await db().shopProducts.findOne({ _id: new ObjectId(request.params.id) });
      const own = Boolean(request.auth && p?.vendorId.equals(request.auth.userId));
      if (!p || (p.status !== "live" && !own)) throw new AppError("NOT_FOUND", "This product isn't on Ruxstar.");
      const business = await db().businesses.findOne({ _id: p.businessId });
      if (!business || ((business.suspension || business.status !== "live") && !own)) throw new AppError("NOT_FOUND", "This product isn't on Ruxstar.");
      const [settings, live] = await Promise.all([shopSettings(db()), isModuleLive(db(), "shop")]);
      const shopProblem = !live ? "Ruxstar isn't taking local shop orders right now." : own ? "This is your shop." : orderProblem(business);
      publicCache(request, reply);
      return ok(request, productDetail(p, business, settings, productProblem(p, shopProblem)));
    },
  );

  app.get(
    "/products/:id/reviews",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["shop"],
        summary: "A product's reviews, newest first",
        description: "No sign-in needed. The product's rating is on its detail.",
        params: IdParams,
        querystring: ShopReviewsQuery,
        response: { 200: ReviewList, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      const id = new ObjectId(request.params.id);
      if (!(await visibleProduct(id))) throw new AppError("NOT_FOUND", "This product isn't on Ruxstar.");
      const { items, nextCursor } = await findPage(db().reviews, { filter: { "listing.id": id, status: "live" }, sortField: "createdAt", cursor: request.query.cursor, limit: request.query.limit });
      const people = await authorsOf(db(), items);
      publicCache(request, reply);
      return page(
        request,
        items.map((r) => reviewView(r, people)),
        nextCursor,
      );
    },
  );

  app.get(
    "/orders",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["shop"],
        summary: "Your local shop orders, newest first",
        description: "current: waiting for payment, the shop, or delivery. past: delivered or cancelled.",
        querystring: MyOrdersQuery,
        response: { 200: ShopOrderList, ...Errors },
        security,
      },
    },
    async (request) => {
      const view = request.query.view ?? "all";
      const filter: Filter<ShopOrderDoc> = { customerId: request.auth!.userId };
      if (view === "current") filter.status = { $nin: ["delivered", "cancelled"] };
      if (view === "past") filter.status = { $in: ["delivered", "cancelled"] };
      const { items, nextCursor } = await findPage(db().shopOrders, { filter, sortField: "createdAt", cursor: request.query.cursor, limit: request.query.limit });
      return page(request, await orderViews(db(), await freshShop(app, db(), items)), nextCursor);
    },
  );

  app.get(
    "/orders/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["shop"],
        summary: "One order: items, tracking, the rider's drop code, return, refunds and invoices",
        description: "While it waits for payment, Cashfree is asked whether it was paid.",
        params: IdParams,
        response: { 200: ShopOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const o = await syncShopPayment(app, db(), await mine(request.auth!.userId, request.params.id));
      const [fresh] = await freshShop(app, db(), [o]);
      return ok(request, await one(fresh!));
    },
  );

  app.post(
    "/orders/:id/pay",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["shop"],
        summary: "A fresh checkout link for an order waiting for payment",
        params: IdParams,
        body: PayBody,
        response: { 200: CheckoutLinkOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const back = safeReturn(app, request.body.returnTo);
      const o = await syncShopPayment(app, db(), await mine(request.auth!.userId, request.params.id));
      if (o.status !== "awaiting_payment") throw new AppError("ORDER_STATE", o.status === "cancelled" ? "This order was cancelled." : "This order is paid.");
      return ok(request, { checkoutUrl: shopCheckoutUrl(app, request, o, back) });
    },
  );

  app.post(
    "/orders/:id/cancel",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["shop"],
        summary: "Cancel an order before the shop packs it",
        description: "Unpaid: the checkout closes. Paid and not packed yet: everything back, platform fee included, and the stock goes back. Once packed, ask for a return after delivery instead.",
        params: IdParams,
        body: CancelBody,
        response: { 200: ShopOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const o = await mine(request.auth!.userId, request.params.id);
      const reason = request.body.reason?.trim() || (o.status === "awaiting_payment" ? "You cancelled before paying." : "You cancelled it.");
      return ok(request, await one(await cancelShopOrder(app, db(), o, byOf(request), reason)));
    },
  );

  app.post(
    "/orders/:id/return",
    {
      preHandler: [requireAuth, idempotent],
      config: { rateLimit: { max: 10, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["shop"],
        summary: "Ask to return some or all of a delivered order",
        description:
          "Within the shop's return window (see `returnUntil`); not for shops with \"No returns\". Once per order. " +
          "The shop pays the trip back when it sent the wrong item or it arrived damaged; otherwise one delivery fee comes off the refund. " +
          "You're refunded once the shop has the items back. The shop's money for the order waits until it's settled.",
        params: IdParams,
        body: ReturnBody,
        response: { 200: ShopOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const o = await mine(request.auth!.userId, request.params.id);
      return ok(request, await one(await requestReturn(app, db(), o, byOf(request), request.body)));
    },
  );

  async function reviewable(request: FastifyRequest & { params: { id: string; productId: string } }) {
    const o = await mine(request.auth!.userId, request.params.id);
    const item = productReviewable(o, new ObjectId(request.params.productId));
    if (!item) throw new AppError("NOT_FOUND", "This product isn't in the order.");
    return item;
  }

  app.get(
    "/orders/:id/products/:productId/review",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["shop"],
        summary: "Your review of a product you bought in this order",
        description: "Null until you review it. One Ruxstar removed comes back with its reason; it can't be changed or written again.",
        params: OrderReviewParams,
        response: { 200: MyReviewOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const item = await reviewable(request);
      const doc = await db().reviews.findOne({ orderId: item.orderId });
      return ok(request, doc ? myReviewView(doc, await authorsOf(db(), [doc])) : null);
    },
  );

  app.put(
    "/orders/:id/products/:productId/review",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["shop"],
        summary: "Review a product you bought, or change your review",
        description:
          "Once the order is delivered (or picked up), until 30 days after. 1 to 5 stars and, if you like, a few words; one review per product per order. " +
          "Leaving out `text` keeps what you wrote; null or blank clears it. The shop is told about a new review.",
        params: OrderReviewParams,
        body: ReviewBody,
        response: { 200: MyReviewOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const item = await reviewable(request);
      const doc = await writeReview(db(), item, request.body, { actor: actorOf(request), ip: request.ip, log: request.log });
      return ok(request, myReviewView(doc, await authorsOf(db(), [doc])));
    },
  );

  app.delete(
    "/orders/:id/products/:productId/review",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["shop"],
        summary: "Delete your review of a product",
        description: "You can review it again while the order is still open for reviews.",
        params: OrderReviewParams,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const item = await reviewable(request);
      await deleteReview(db(), item.orderId, { actor: actorOf(request), ip: request.ip });
      return ok(request, { done: true as const });
    },
  );

  app.post(
    "/reviews/:id/report",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 20, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["shop"],
        summary: "Report a review to Ruxstar",
        description: "One open report per review you report; reporting it again while it is open changes nothing. The writer isn't told.",
        params: IdParams,
        body: ReviewReportBody,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      await reportReview(db(), request.auth!.userId, request.params.id, request.body);
      return ok(request, { done: true as const });
    },
  );

  app.post(
    "/:id/quote",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["shop"],
        summary: "Price a cart at one shop: each line, delivery or pickup, the platform fee, and the coupons that work",
        description:
          "The cart is kept on the device; this prices it as it is now. Nothing is held: stock is only taken when an order is paid. " +
          "A line from another shop, a sold-out variant or too few left is an error naming the item. With `code`, that coupon is checked too.",
        params: IdParams,
        body: QuoteBody,
        response: { 200: QuoteOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const doc = await orderable(request.params.id);
      const settings = await shopSettings(db());
      const cart = await priceCart(app, db(), doc, request.body, settings);
      const ctx = { module: "shop" as const, shop: { id: doc._id, name: doc.name }, customerId: request.auth!.userId, items: cart.items };
      const [offers, check] = await Promise.all([offersFor(db(), ctx), request.body.code ? checkCode(db(), request.body.code, ctx) : null]);
      const discount = check && check.problem === null ? check.discount : 0;
      const stock = await db()
        .shopProducts.find({ _id: { $in: cart.lines.map((l) => l.productId) } }, { projection: { variants: 1 } })
        .toArray();
      return ok(request, {
        lines: cart.lines.map((l) => ({
          productId: l.productId.toHexString(),
          variantId: l.variantId.toHexString(),
          title: l.title,
          options: l.options,
          unitPrice: l.unitPrice,
          mrp: l.mrp,
          quantity: l.quantity,
          total: l.unitPrice * l.quantity,
          stock: stock.find((p) => p._id.equals(l.productId))?.variants.find((v) => v.id.equals(l.variantId))?.stock ?? 0,
        })),
        items: cart.items,
        delivery: cart.delivery,
        deliveryKm: cart.deliveryKm,
        platformFee: settings.platformFee,
        discount,
        total: cart.items - discount + cart.delivery + settings.platformFee,
        returnRule: shopReturnText(doc, settings),
        offers,
        checked: check ? { code: request.body.code!.trim().toUpperCase(), discount: check.discount, problem: check.problem } : null,
      });
    },
  );

  app.post(
    "/:id/orders",
    {
      preHandler: [requireAuth, idempotent],
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["shop"],
        summary: "Order from one shop: delivery to an address in its city, or pickup",
        description:
          "Every line must be from this shop. Stock is checked now and taken when the payment goes through; if something sold out meanwhile, " +
          "the order is cancelled and refunded in full at once. Returns a checkout link, open for the rules' `holdMinutes`. " +
          "Once paid, the shop has the rules' `acceptHours` to accept or you're refunded.",
        params: IdParams,
        body: PlaceOrderBody,
        response: { 201: PlacedShopOrder, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const back = safeReturn(app, request.body.returnTo);
      const doc = await orderable(request.params.id);
      const o = await placeShopOrder(app, db(), doc, await customerOf(request), request.body);
      return reply.status(201).send(ok(request, { order: await one(o), checkoutUrl: shopCheckoutUrl(app, request, o, back) }));
    },
  );

  app.get(
    "/:id/reviews",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["shop"],
        summary: "A shop's product reviews, newest first",
        description: "No sign-in needed. The shop's rating covers all of them and is on its detail.",
        params: IdParams,
        querystring: ShopReviewsQuery,
        response: { 200: ReviewList, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      const doc = await store(request.params.id);
      const { items, nextCursor } = await findPage(db().reviews, { filter: { shopId: doc._id, status: "live" }, sortField: "createdAt", cursor: request.query.cursor, limit: request.query.limit });
      const people = await authorsOf(db(), items);
      publicCache(request, reply);
      return page(
        request,
        items.map((r) => reviewView(r, people)),
        nextCursor,
      );
    },
  );

  app.get(
    "/:id",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["shop"],
        summary: "One local shop: photos, address, delivery or pickup, delivery fee, smallest order and return rule",
        description: "No sign-in needed. Its products come from /products?shop={id}.",
        params: IdParams,
        response: { 200: StoreOne, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      const doc: WithId<BusinessDoc> = await store(request.params.id);
      const [settings, live, products] = await Promise.all([
        shopSettings(db()),
        isModuleLive(db(), "shop"),
        db().shopProducts.countDocuments({ businessId: doc._id, status: "live" }),
      ]);
      const own = Boolean(request.auth?.userId.equals(doc.ownerId));
      const whyNot = !live ? "Ruxstar isn't taking local shop orders right now." : own ? "This is your shop." : orderProblem(doc);
      const empty = { delivery: false, pickup: false, radiusKm: null, deliveryFee: { base: 0, includedKm: 0, perKm: 0 }, minOrder: 0, returns: false, notes: null };
      publicCache(request, reply);
      return ok(request, {
        ...storeCard(doc, settings),
        description: doc.description,
        photos: doc.photos.map((p) => ({ url: p.url, width: p.width, height: p.height })),
        phone: doc.phone,
        address: addressOf(doc.location),
        point: doc.location?.point ?? null,
        setup: setupView(doc) ?? empty,
        returnDays: doc.shop?.returns ? settings.returnDays : null,
        canOrder: !whyNot,
        whyNot,
        products,
      });
    },
  );
};

export default shop;
