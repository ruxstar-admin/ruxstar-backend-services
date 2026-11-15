import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type Filter, type WithId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { BusinessDoc, ShopOrderDoc, ShopProductDoc, TeamPermission } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { AssignBody, DeliveryOptions } from "../delivery/contracts.js";
import { escapeRegex } from "../pod/shops.js";
import { teamAccess } from "../team/team.js";
import {
  DecideReturnBody,
  DeskOrderList,
  DeskOrderOne,
  DeskOrdersQuery,
  DeskStoreList,
  IdParams,
  MoveBody,
  OwnerCancelBody,
  ReceivedBody,
  StockBody,
  UpdateProductBody,
  VendorProductList,
  VendorProductOne,
  VendorProductsQuery,
} from "./contracts.js";
import { cancelShopOrder, decideReturn, freshShop, refundReturn, shopMove, type By } from "./orders.js";
import { editProduct, setStock } from "./products.js";
import { shopSettings } from "./rules.js";
import { assignShopTrip, cancelShopTrip, shopDeliveryOptions } from "./trips.js";
import { deskOrderViews, vendorProduct } from "./views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
export const STORE_PERMISSIONS: TeamPermission[] = ["store.orders", "store.move", "store.cancel", "store.returns", "store.stock", "store.products"];

interface Desk {
  shop: WithId<BusinessDoc>;
  owner: boolean;
  permissions: TeamPermission[];
}

/** The shop's desk: its owner, and verified team members with store permissions. Orders, delivery, returns, stock. */
const desk: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const byOf = (request: FastifyRequest): By => ({ kind: "vendor", actor: actorOf(request), ip: request.ip });
  const who = (request: FastifyRequest) => ({ actor: actorOf(request), ip: request.ip });

  async function access(request: FastifyRequest, businessId: ObjectId, permission: TeamPermission): Promise<Desk> {
    const shop = await db().businesses.findOne({ _id: businessId, module: "shop" });
    if (!shop) throw new AppError("NOT_FOUND", "Shop not found.");
    if (shop.ownerId.equals(request.auth!.userId)) {
      if (shop.suspension) throw new AppError("BUSINESS_SUSPENDED");
      return { shop, owner: true, permissions: STORE_PERMISSIONS };
    }
    const { place } = await teamAccess(db(), request.auth!, { businessId }, permission);
    return { shop, owner: false, permissions: place.permissions };
  }
  async function orderAccess(request: FastifyRequest, id: string, permission: TeamPermission) {
    const o = await db().shopOrders.findOne({ _id: new ObjectId(id) });
    if (!o || !o.payment.paidAt) throw new AppError("NOT_FOUND", "Order not found.");
    await access(request, o.businessId, permission);
    return o;
  }
  async function productAccess(request: FastifyRequest, id: string, permission: TeamPermission) {
    const p = await db().shopProducts.findOne({ _id: new ObjectId(id) });
    if (!p) throw new AppError("NOT_FOUND", "Product not found.");
    const { shop } = await access(request, p.businessId, permission);
    return { p, shop };
  }
  const one = async (o: ShopOrderDoc) => (await deskOrderViews(db(), [o]))[0]!;

  app.get(
    "/stores",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["shop"],
        summary: "Local shops you run: your own, and those whose team gave you store permissions",
        description: "With the orders waiting and returns open at each. Team members need to be verified to see them.",
        response: { 200: DeskStoreList, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const [owned, places] = await Promise.all([
        db().businesses.find({ ownerId: userId, module: "shop", suspension: { $exists: false } }).toArray(),
        db().employments.find({ userId, status: "active", current: true, permissions: { $in: STORE_PERMISSIONS } }, { projection: { businessId: 1, permissions: 1 } }).toArray(),
      ]);
      const verified = request.auth!.kyc.base === "approved";
      const team = verified && places.length ? await db().businesses.find({ _id: { $in: places.map((p) => p.businessId) }, module: "shop", suspension: { $exists: false } }).toArray() : [];
      const shops = [...owned, ...team.filter((t) => !owned.some((o) => o._id.equals(t._id)))];
      const ids = shops.map((s) => s._id);
      const count = (match: Filter<ShopOrderDoc>) =>
        db().shopOrders.aggregate<{ _id: ObjectId; n: number }>([{ $match: { ...match, businessId: { $in: ids } } }, { $group: { _id: "$businessId", n: { $sum: 1 } } }]).toArray();
      const [open, returns] = await Promise.all([
        count({ status: { $in: ["paid", "accepted", "packed", "out_for_delivery", "ready_for_pickup"] } }),
        count({ "return.status": { $in: ["requested", "approved"] } }),
      ]);
      return page(
        request,
        shops.map((s) => {
          const mine = s.ownerId.equals(userId);
          return {
            id: s._id.toHexString(),
            name: s.name,
            owner: mine,
            permissions: mine ? STORE_PERMISSIONS : (places.find((p) => p.businessId.equals(s._id))?.permissions.filter((x) => x.startsWith("store.") || x === "orders.deliver") ?? []),
            open: open.find((c) => c._id.equals(s._id))?.n ?? 0,
            returns: returns.find((c) => c._id.equals(s._id))?.n ?? 0,
          };
        }),
        null,
      );
    },
  );

  app.get(
    "/stores/:id/orders",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["shop"],
        summary: "The shop's paid orders, newest first: the queue to accept, pack and send",
        description: "Team members need store.orders. Orders waiting for payment aren't shown.",
        params: IdParams,
        querystring: DeskOrdersQuery,
        response: { 200: DeskOrderList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { shop } = await access(request, new ObjectId(request.params.id), "store.orders");
      const view = request.query.view ?? "open";
      const filter: Filter<ShopOrderDoc> = { businessId: shop._id, "payment.paidAt": { $type: "date" } };
      if (view === "open") filter.status = { $in: ["paid", "accepted", "packed", "out_for_delivery", "ready_for_pickup"] };
      if (view === "returns") filter["return.status"] = { $in: ["requested", "approved"] };
      if (view === "done") filter.status = { $in: ["delivered", "cancelled"] };
      const { items, nextCursor } = await findPage(db().shopOrders, { filter, sortField: "createdAt", cursor: request.query.cursor, limit: request.query.limit });
      return page(request, await deskOrderViews(db(), await freshShop(app, db(), items)), nextCursor);
    },
  );

  app.get(
    "/orders/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["shop"],
        summary: "One order: items with their variants and SKUs, the customer, delivery, return and your share",
        description: "Team members need store.orders.",
        params: IdParams,
        response: { 200: DeskOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const o = await orderAccess(request, request.params.id, "store.orders");
      const [fresh] = await freshShop(app, db(), [o]);
      return ok(request, await one(fresh!));
    },
  );

  app.post(
    "/orders/:id/move",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["shop"],
        summary: "Move an order on: accept, packed, out for delivery or ready for pickup, delivered",
        description:
          "One step at a time (see `next`). Out for delivery and delivered are for delivering it yourself; a rider's trip moves it by itself. " +
          "Delivered (or picked up) starts the return window, and your share is released at the later of its end and the rules' `releaseHours`. Team members need store.move.",
        params: IdParams,
        body: MoveBody,
        response: { 200: DeskOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const o = await orderAccess(request, request.params.id, "store.move");
      return ok(request, await one(await shopMove(app, db(), o, request.body.status, byOf(request))));
    },
  );

  app.post(
    "/orders/:id/cancel",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["shop"],
        summary: "Cancel a paid order: the customer gets everything back and the stock goes back",
        description: "Before delivery; not once a rider has picked it up. Team members need store.cancel.",
        params: IdParams,
        body: OwnerCancelBody,
        response: { 200: DeskOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const o = await orderAccess(request, request.params.id, "store.cancel");
      return ok(request, await one(await cancelShopOrder(app, db(), o, byOf(request), request.body.reason.trim())));
    },
  );

  app.get(
    "/orders/:id/delivery",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["shop"],
        summary: "Who can deliver a packed order: your team, or a Ruxstar partner and what they'd be paid",
        description: "You can always deliver it yourself instead. Team members need store.move.",
        params: IdParams,
        response: { 200: DeliveryOptions, ...Errors },
        security,
      },
    },
    async (request) => {
      const o = await orderAccess(request, request.params.id, "store.move");
      return ok(request, await shopDeliveryOptions(db(), o));
    },
  );

  app.post(
    "/orders/:id/delivery",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["shop"],
        summary: "Hand a packed order to someone on your team, or offer it to Ruxstar partners nearby",
        description:
          "A partner offer goes to partners online in your city; the first to accept gets it, and their pay comes out of your share at delivery. " +
          "The customer gets a code to give the rider at the door. Team members need store.move.",
        params: IdParams,
        body: AssignBody,
        response: { 200: DeskOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const o = await orderAccess(request, request.params.id, "store.move");
      return ok(request, await one(await assignShopTrip(app, db(), o, request.body, who(request))));
    },
  );

  app.delete(
    "/orders/:id/delivery",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["shop"],
        summary: "Take the delivery back before the rider picks it up",
        description: "The order stays packed. Team members need store.move.",
        params: IdParams,
        response: { 200: DeskOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const o = await orderAccess(request, request.params.id, "store.move");
      return ok(request, await one(await cancelShopTrip(app, db(), o, who(request))));
    },
  );

  app.post(
    "/orders/:id/return/decide",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["shop"],
        summary: "Accept a return or turn it down",
        description: "Turning it down needs a note; the customer can still take it to Ruxstar. Team members need store.returns.",
        params: IdParams,
        body: DecideReturnBody,
        response: { 200: DeskOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const o = await orderAccess(request, request.params.id, "store.returns");
      const note = request.body.note?.trim() || null;
      if (request.body.decision === "reject" && !note) throw new AppError("VALIDATION_FAILED", "Say why you're turning it down.", [{ path: "body/note", message: "Needed to reject" }]);
      return ok(request, await one(await decideReturn(app, db(), o, byOf(request), request.body.decision, note)));
    },
  );

  app.post(
    "/orders/:id/return/received",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["shop"],
        summary: "The returned items are back: refund the customer",
        description: "The refund comes out of your share for the order; the rest is released when it's due. Returned stock isn't added back by itself. Team members need store.returns.",
        params: IdParams,
        body: ReceivedBody,
        response: { 200: DeskOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const o = await orderAccess(request, request.params.id, "store.returns");
      return ok(request, await one(await refundReturn(app, db(), o, byOf(request), request.body.note?.trim() || null)));
    },
  );

  app.get(
    "/stores/:id/products",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["shop"],
        summary: "The shop's products with every variant's stock, newest first",
        description: "Team members need store.stock. `lowStock` lists products with a variant at or under that many left.",
        params: IdParams,
        querystring: VendorProductsQuery,
        response: { 200: VendorProductList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { shop } = await access(request, new ObjectId(request.params.id), "store.stock");
      const q = request.query;
      const filter: Filter<ShopProductDoc> = { businessId: shop._id };
      if (q.status) filter.status = q.status;
      if (q.q?.trim()) filter.title = { $regex: escapeRegex(q.q.trim()), $options: "i" };
      if (q.lowStock !== undefined) filter["variants.stock"] = { $lte: q.lowStock };
      const { items, nextCursor } = await findPage(db().shopProducts, { filter, sortField: "createdAt", cursor: q.cursor, limit: q.limit });
      const settings = await shopSettings(db());
      return page(
        request,
        items.map((p) => vendorProduct(p, shop, settings)),
        nextCursor,
      );
    },
  );

  app.patch(
    "/products/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["shop"],
        summary: "Change a product: its words, options and variant table, tax, or take it off sale",
        description: "Sending `variants` replaces the table, stock included. The photo is the owner's, from /v1/vendor. Team members need store.products.",
        params: IdParams,
        body: UpdateProductBody,
        response: { 200: VendorProductOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { p, shop } = await productAccess(request, request.params.id, "store.products");
      const after = await editProduct(db(), p, request.body, who(request));
      return ok(request, vendorProduct(after, shop, await shopSettings(db())));
    },
  );

  app.put(
    "/products/:id/stock",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["shop"],
        summary: "Set how many are left of some variants",
        description: "Each variant sent is set to its number, as counted on the shelf. Team members need store.stock.",
        params: IdParams,
        body: StockBody,
        response: { 200: VendorProductOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { p, shop } = await productAccess(request, request.params.id, "store.stock");
      const after = await setStock(db(), p, request.body.variants, who(request));
      return ok(request, vendorProduct(after, shop, await shopSettings(db())));
    },
  );
};

export default desk;
