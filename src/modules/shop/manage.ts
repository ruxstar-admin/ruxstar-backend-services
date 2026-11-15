import { randomUUID } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type Filter, type WithId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, diffOf, writeAudit } from "../../platform/audit.js";
import { requireDatabase } from "../../platform/context.js";
import type { BusinessDoc, BusinessPhoto, ShopProductDoc, ShopSetup } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { isModuleLive } from "../../platform/module-switch.js";
import { findPage } from "../../platform/pagination.js";
import { deliveryRules } from "../delivery/rates.js";
import { rupees } from "../pod/orders.js";
import { escapeRegex } from "../pod/shops.js";
import { Done } from "../social/contracts.js";
import { toPostPhoto } from "../social/photos.js";
import { ownedBy, photoKeys, requireVendor } from "../vendor/businesses.js";
import { IdParams, ProductBody, ShopSetupBody, ShopSetupOne, UpdateProductBody, VendorProductList, VendorProductOne, VendorProductsQuery } from "./contracts.js";
import { createProduct, editProduct } from "./products.js";
import { emptyShop, shopSettings } from "./rules.js";
import { vendorProduct } from "./views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const invalid = (path: string, message: string) => new AppError("VALIDATION_FAILED", message, [{ path, message }]);

/** A local shop's delivery, pickup and returns, and its products. Only the owner sets the shop up and adds photos; the desk can edit products and stock. */
const manage: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const who = (request: FastifyRequest) => ({ actor: actorOf(request), ip: request.ip });

  async function business(request: FastifyRequest, id: string | ObjectId): Promise<WithId<BusinessDoc>> {
    const doc = await db().businesses.findOne(ownedBy(new ObjectId(id), request.auth!.userId));
    if (!doc) throw new AppError("NOT_FOUND", "Business not found.");
    if (doc.module !== "shop") throw new AppError("CONFLICT", "Products are for local shop businesses.");
    return doc;
  }
  async function owned(request: FastifyRequest, id: string, { editing = true } = {}) {
    const p = await db().shopProducts.findOne({ _id: new ObjectId(id), vendorId: request.auth!.userId });
    if (!p) throw new AppError("NOT_FOUND", "Product not found.");
    const shop = (await db().businesses.findOne({ _id: p.businessId }))!;
    if (editing) {
      if (shop.suspension) throw new AppError("BUSINESS_SUSPENDED");
      if (p.status === "removed") throw new AppError("CONFLICT", "Ruxstar took this product down, so it can't be changed.");
    }
    return { p, shop };
  }
  const setupOf = async (doc: BusinessDoc) => ({ ...(doc.shop ?? emptyShop()), returnDays: (await shopSettings(db())).returnDays });
  const view = async (p: ShopProductDoc, shop: BusinessDoc) => vendorProduct(p, shop, await shopSettings(db()));

  app.get(
    "/businesses/:id/shop",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "A local shop's delivery, pickup, delivery fee, smallest order and return policy",
        params: IdParams,
        response: { 200: ShopSetupOne, ...Errors },
        security,
      },
    },
    async (request) => ok(request, await setupOf(await business(request, request.params.id))),
  );

  app.put(
    "/businesses/:id/shop",
    {
      preHandler: requireVendor,
      config: { rateLimit: { max: 60, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Set delivery or pickup, how far and for how much you deliver, the smallest order, and returns",
        description:
          "Changes what's sent. Delivery is in your city only, by your team, Ruxstar partners or yourself; `radiusKm` limits it by road km. " +
          "The delivery fee is up to Ruxstar's most (see GET /v1/vendor/catalog). Returns on means within Ruxstar's return days (`returnDays`), off is \"No returns\"; " +
          "orders keep the policy they were placed with.",
        params: IdParams,
        body: ShopSetupBody,
        response: { 200: ShopSetupOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const doc = await business(request, request.params.id);
      if (doc.suspension) throw new AppError("BUSINESS_SUSPENDED");
      const before = doc.shop ?? emptyShop();
      const body = request.body;
      const next: ShopSetup = {
        delivery: body.delivery ?? before.delivery,
        pickup: body.pickup ?? before.pickup,
        radiusKm: body.radiusKm !== undefined ? body.radiusKm : before.radiusKm,
        deliveryFee: body.deliveryFee ? { ...body.deliveryFee } : before.deliveryFee,
        minOrder: body.minOrder ?? before.minOrder,
        returns: body.returns ?? before.returns,
        notes: body.notes !== undefined ? body.notes?.trim() || null : before.notes,
      };
      if (!next.delivery && !next.pickup) throw invalid("body", "Offer delivery, pickup or both.");
      if (body.deliveryFee) {
        const max = (await deliveryRules(db())).shopFeeMax;
        for (const part of ["base", "perKm"] as const) {
          if (body.deliveryFee[part] > max[part]) throw invalid(`body/deliveryFee/${part}`, `Ruxstar allows up to ${rupees(max[part])}${part === "perKm" ? " a km" : ""}.`);
        }
      }
      const diff = diffOf(before, next);
      if (Object.keys(diff).length) {
        await db().businesses.updateOne({ _id: doc._id }, { $set: { shop: next, updatedAt: new Date() } });
        await writeAudit(db(), { actor: actorOf(request), scope: { module: "shop", businessId: doc._id }, action: "shop.setup", target: { type: "business", id: doc._id }, diff, ip: request.ip });
      }
      return ok(request, await setupOf({ ...doc, shop: next }));
    },
  );

  app.get(
    "/businesses/:id/products",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "A local shop's products, newest first, with every variant's price and stock",
        params: IdParams,
        querystring: VendorProductsQuery,
        response: { 200: VendorProductList, ...Errors },
        security,
      },
    },
    async (request) => {
      const shop = await business(request, request.params.id);
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

  app.post(
    "/businesses/:id/products",
    {
      preHandler: [requireVendor, idempotent],
      config: { rateLimit: { max: 120, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Add a product with its variant table",
        description:
          "Up to the rules' `maxOptions` options (such as Size and Colour) and one variant row per combination you sell, each with its price, MRP, stock and SKU. " +
          "Without options, one row. Live as soon as it's saved unless `status` is hidden; add its photo next. " +
          "Words on Ruxstar's banned list are refused, saying which.",
        params: IdParams,
        body: ProductBody,
        response: { 201: VendorProductOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const shop = await business(request, request.params.id);
      if (shop.suspension) throw new AppError("BUSINESS_SUSPENDED");
      if (!(await isModuleLive(db(), "shop"))) throw new AppError("MODULE_OFF");
      const doc = await createProduct(db(), shop, request.body, who(request));
      return reply.status(201).send(ok(request, await view(doc, shop)));
    },
  );

  app.get(
    "/products/:id",
    {
      preHandler: requireVendor,
      schema: { tags: ["vendor"], summary: "One of your products", params: IdParams, response: { 200: VendorProductOne, ...Errors }, security },
    },
    async (request) => {
      const { p, shop } = await owned(request, request.params.id, { editing: false });
      return ok(request, await view(p, shop));
    },
  );

  app.patch(
    "/products/:id",
    {
      preHandler: requireVendor,
      config: { rateLimit: { max: 240, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Change a product: words, options and the variant table, tax, or take it off sale",
        description: "Sending `variants` replaces the table, stock included; if an order took stock since you loaded it, you're asked to refresh. Variants keep their ids by their values.",
        params: IdParams,
        body: UpdateProductBody,
        response: { 200: VendorProductOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { p, shop } = await owned(request, request.params.id);
      return ok(request, await view(await editProduct(db(), p, request.body, who(request)), shop));
    },
  );

  app.delete(
    "/products/:id",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Delete a product",
        description: "Orders keep what was bought. To stop selling it for a while, set `status` to hidden instead.",
        params: IdParams,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const { p } = await owned(request, request.params.id);
      await db().shopProducts.deleteOne({ _id: p._id });
      if (p.photo) await Promise.all(photoKeys(p.photo).map((key) => app.media.remove(key)));
      await writeAudit(db(), {
        actor: actorOf(request),
        scope: { module: "shop", businessId: p.businessId },
        action: "shop_product.delete",
        target: { type: "shop_product", id: p._id },
        diff: { title: { from: p.title, to: null } },
        ip: request.ip,
      });
      return ok(request, { done: true as const });
    },
  );

  app.put(
    "/products/:id/photo",
    {
      preHandler: requireVendor,
      config: { rateLimit: { max: 120, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Set the product's photo",
        description: "Send the image itself with Content-Type image/jpeg, image/png or image/webp, up to 8 MB. One photo per product; a new one replaces it.",
        consumes: ["image/jpeg", "image/png", "image/webp"],
        params: IdParams,
        response: { 200: VendorProductOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { p, shop } = await owned(request, request.params.id);
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw new AppError("PHOTO_INVALID");
      const { full, smaller } = await toPostPhoto(request.body);
      const id = randomUUID();
      const base = `shop-media/${app.config.env}/${p._id.toHexString()}/${id}`;
      const save = async (file: typeof full, suffix: string) => {
        const key = `${base}${suffix}.webp`;
        return { key, url: await app.media.save(key, file.data), width: file.width, height: file.height };
      };
      const [saved, ...copies] = await Promise.all([save(full, ""), ...smaller.map((file) => save(file, `-${file.width}w`))]);
      const photo: BusinessPhoto = { id, ...saved!, smaller: copies };
      const after = await db().shopProducts.findOneAndUpdate({ _id: p._id, status: { $ne: "removed" } }, { $set: { photo, updatedAt: new Date() } }, { returnDocument: "after" });
      if (!after) {
        await Promise.all(photoKeys(photo).map((key) => app.media.remove(key)));
        throw new AppError("CONFLICT", "Ruxstar took this product down, so it can't be changed.");
      }
      if (p.photo) await Promise.all(photoKeys(p.photo).map((key) => app.media.remove(key)));
      return ok(request, await view(after, shop));
    },
  );

  app.delete(
    "/products/:id/photo",
    {
      preHandler: requireVendor,
      schema: { tags: ["vendor"], summary: "Remove the product's photo", params: IdParams, response: { 200: VendorProductOne, ...Errors }, security },
    },
    async (request) => {
      const { p, shop } = await owned(request, request.params.id);
      if (!p.photo) throw new AppError("NOT_FOUND", "This product has no photo.");
      const after = await db().shopProducts.findOneAndUpdate({ _id: p._id }, { $set: { photo: null, updatedAt: new Date() } }, { returnDocument: "after" });
      await Promise.all(photoKeys(p.photo).map((key) => app.media.remove(key)));
      return ok(request, await view(after!, shop));
    },
  );
};

export default manage;
