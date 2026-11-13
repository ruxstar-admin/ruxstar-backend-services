import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, writeAudit } from "../../platform/audit.js";
import { requireDatabase } from "../../platform/context.js";
import { requireAuth } from "../../platform/auth.js";
import { stamp, type BusinessDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { isModuleLive } from "../../platform/module-switch.js";
import { Done } from "../social/contracts.js";
import { POST_PHOTO_MAX_BYTES } from "../social/photos.js";
import { businessView, emptyPod, liveModules, missingOf, ownedBy, photoKeys, requireVendor, toLocation } from "./businesses.js";
import { addPhoto, editDetails, editPod, incomplete, removePhoto, setOpen } from "./shop-edits.js";
import { CATEGORIES, MAX_POD_CITIES, MAX_PRICE_TIERS, MAX_TURNAROUND_DAYS, PRODUCTS, TYPES, typeOf } from "./catalog.js";
import {
  BusinessList,
  BusinessOne,
  BusinessParams,
  Catalog,
  CreateBusinessBody,
  DESCRIPTION_MAX,
  MAX_BUSINESS_PHOTOS,
  MAX_BUSINESSES,
  PhotoParams,
  PodSetupBody,
  UpdateBusinessBody,
  type Business,
} from "./contracts.js";
import activity from "./activity.js";
import coupons from "./coupons.js";
import { INDIA } from "./india.js";
import orders from "./orders.js";
import payments from "./payments.js";
import team from "./team.js";
import { endPlacesFor } from "../team/team.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const limit = (perMinutes: number, max: number) => ({ rateLimit: { max, timeWindow: perMinutes * 60_000 } });

const by = (request: FastifyRequest) => ({ actor: actorOf(request), ip: request.ip });

/** The vendor portal: a verified person's businesses, one module each, and how they get paid. */
const vendor: FastifyPluginAsyncTypebox = async (app) => {
  app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: POST_PHOTO_MAX_BYTES }, (_request, body, done) => done(null, body));
  await app.register(payments);
  await app.register(orders);
  await app.register(coupons);
  await app.register(team);
  await app.register(activity);

  const db = () => requireDatabase(app.db);

  async function owned(request: { auth: { userId: ObjectId } | null }, id: string, { editing = true } = {}) {
    const doc = await db().businesses.findOne(ownedBy(new ObjectId(id), request.auth!.userId));
    if (!doc) throw new AppError("NOT_FOUND", "Business not found.");
    if (editing && doc.suspension) throw new AppError("BUSINESS_SUSPENDED");
    return doc;
  }

  const answer = async (doc: BusinessDoc) => businessView(doc, await isModuleLive(db(), doc.module));
  const reload = async (id: ObjectId) => answer((await db().businesses.findOne({ _id: id }))!);

  app.get(
    "/catalog",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["vendor"],
        summary: "Categories, types, states and cities, and print products to choose from",
        description: "Each category is one module, with whether it is live and taking new businesses. The Ruxstar console reads it for labels.",
        response: { 200: Catalog, ...Errors },
        security,
      },
    },
    async (request) => {
      const docs = await db().moduleSettings.find({ module: { $in: CATEGORIES.map((c) => c.module) } }).toArray();
      return ok(request, {
        categories: CATEGORIES.map((category) => {
          const doc = docs.find((d) => d.module === category.module);
          return {
            ...category,
            live: doc?.live ?? false,
            signupsOpen: Boolean(doc?.live && doc.signupsOpen),
            types: TYPES.filter((t) => t.module === category.module).map(({ module: _module, ...type }) => type),
          };
        }),
        states: INDIA.map(([name, cities]) => ({ name, cities: [...cities] })),
        podProducts: PRODUCTS.map(({ options, ...product }) => ({
          ...product,
          options: Object.entries(options).map(([option, values]) => ({ option, values: [...values] })),
        })),
        limits: {
          businesses: MAX_BUSINESSES,
          photos: MAX_BUSINESS_PHOTOS,
          description: DESCRIPTION_MAX,
          cities: MAX_POD_CITIES,
          turnaroundDays: MAX_TURNAROUND_DAYS,
          tiers: MAX_PRICE_TIERS,
        },
      });
    },
  );

  app.get(
    "/businesses",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Your businesses, newest first",
        response: { 200: BusinessList, ...Errors },
        security,
      },
    },
    async (request) => {
      const [docs, live] = await Promise.all([
        db().businesses.find({ ownerId: request.auth!.userId }).sort({ createdAt: -1 }).limit(MAX_BUSINESSES).toArray(),
        liveModules(db()),
      ]);
      return page(request, docs.map((doc) => businessView(doc, live.has(doc.module))), null);
    },
  );

  app.post(
    "/businesses",
    {
      preHandler: [requireVendor, idempotent],
      config: limit(60, 20),
      schema: {
        tags: ["vendor"],
        summary: "Start a business: its category (module), type and profile",
        description:
          `It starts as a draft. Add the cover photo next, then (for print on demand) the setup, then publish it. The type must belong to ` +
          `the module, and the module must be live and taking new businesses; up to ${MAX_BUSINESSES} businesses each.`,
        body: CreateBusinessBody,
        response: { 201: BusinessOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const database = db();
      const ownerId = request.auth!.userId;
      const { module, type, name, phone, description } = request.body;
      if (typeOf(type).module !== module) throw new AppError("VALIDATION_FAILED", undefined, [{ path: "body/type", message: "Pick a type in this category." }]);
      const location = toLocation(request.body.location);
      const settings = await database.moduleSettings.findOne({ module });
      if (!settings?.live) throw new AppError("MODULE_OFF");
      if (!settings.signupsOpen) throw new AppError("SIGNUPS_CLOSED");
      if ((await database.businesses.countDocuments({ ownerId })) >= MAX_BUSINESSES) {
        throw new AppError("CONFLICT", `You can have up to ${MAX_BUSINESSES} businesses.`);
      }
      const doc: BusinessDoc = {
        _id: new ObjectId(),
        ownerId,
        module,
        type,
        name: name.trim(),
        description: description?.trim() || null,
        phone,
        location,
        pod: module === "pod" ? emptyPod() : null,
        gstin: null,
        photos: [],
        status: "draft",
        open: false,
        publishedAt: null,
        ...stamp(),
      };
      await database.businesses.insertOne(doc);
      return reply.status(201).send(ok(request, businessView(doc, true)));
    },
  );

  app.get(
    "/businesses/:id",
    {
      preHandler: requireVendor,
      schema: { tags: ["vendor"], summary: "One of your businesses", params: BusinessParams, response: { 200: BusinessOne, ...Errors }, security },
    },
    async (request) => ok(request, await answer(await owned(request, request.params.id, { editing: false }))),
  );

  app.patch(
    "/businesses/:id",
    {
      preHandler: requireVendor,
      config: limit(60, 60),
      schema: {
        tags: ["vendor"],
        summary: "Change a business's details",
        description: "Send only what changes; null clears an optional field. A new GSTIN is checked with the GST network.",
        params: BusinessParams,
        body: UpdateBusinessBody,
        response: { 200: BusinessOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const doc = await owned(request, request.params.id);
      await editDetails(app, db(), doc, request.body, by(request));
      return ok(request, await reload(doc._id));
    },
  );

  app.patch(
    "/businesses/:id/pod",
    {
      preHandler: requireVendor,
      config: limit(60, 60),
      schema: {
        tags: ["vendor"],
        summary: "Change a print on demand business's setup: products, area and prices",
        description:
          "Send only what changes. `prices` replaces the prices of the products it names, and a product must be offered before it is priced; " +
          "dropping a product drops its price. A live business must keep at least one product, an area and a price for each product.",
        params: BusinessParams,
        body: PodSetupBody,
        response: { 200: BusinessOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const doc = await owned(request, request.params.id);
      await editPod(db(), doc, request.body, by(request));
      return ok(request, await reload(doc._id));
    },
  );

  app.post(
    "/businesses/:id/photos",
    {
      preHandler: requireVendor,
      config: limit(60, 30),
      schema: {
        tags: ["vendor"],
        summary: `Add a photo to a business, up to ${MAX_BUSINESS_PHOTOS}`,
        description:
          "Send the image itself with Content-Type image/jpeg, image/png or image/webp, up to 8 MB. It is saved like a post photo: " +
          "WebP, at most 1440 pixels on its long side, without its metadata. The first photo is the cover.",
        consumes: ["image/jpeg", "image/png", "image/webp"],
        params: BusinessParams,
        response: { 201: BusinessOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const doc = await owned(request, request.params.id);
      await addPhoto(app, db(), doc, request.body, by(request));
      return reply.status(201).send(ok(request, await reload(doc._id)));
    },
  );

  app.delete(
    "/businesses/:id/photos/:photoId",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Remove a photo from a business",
        description: "A live business keeps at least one photo.",
        params: PhotoParams,
        response: { 200: BusinessOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const doc = await owned(request, request.params.id);
      await removePhoto(app, db(), doc, request.params.photoId, by(request));
      return ok(request, await reload(doc._id));
    },
  );

  app.post(
    "/businesses/:id/publish",
    {
      preHandler: [requireVendor, idempotent],
      schema: {
        tags: ["vendor"],
        summary: "Publish a draft so customers can find it",
        description:
          "Needs a cover photo, a phone number and the state and city; print on demand also needs products, an area and a price for each product. " +
          "Everything still missing comes back at once. It opens straight away.",
        params: BusinessParams,
        response: { 200: BusinessOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const doc = await owned(request, request.params.id);
      if (doc.status === "live") throw new AppError("CONFLICT", "This business is already live.");
      const missing = missingOf(doc);
      if (missing.length) throw incomplete(missing);
      if (!(await isModuleLive(database, doc.module))) throw new AppError("MODULE_OFF");
      await database.transaction(async (session) => {
        const now = new Date();
        const res = await database.businesses.updateOne(
          { _id: doc._id, status: "draft", suspension: { $exists: false } },
          { $set: { status: "live", open: true, publishedAt: now, updatedAt: now } },
          { session },
        );
        if (res.matchedCount === 0) throw new AppError("CONFLICT");
        await writeAudit(
          database,
          {
            actor: actorOf(request),
            scope: { module: doc.module, businessId: doc._id },
            action: "business.publish",
            target: { type: "business", id: doc._id },
            diff: { status: { from: "draft", to: "live" } },
            ip: request.ip,
          },
          session,
        );
      });
      return ok(request, await reload(doc._id));
    },
  );

  for (const open of [true, false]) {
    app.post(
      `/businesses/:id/${open ? "open" : "close"}`,
      {
        preHandler: requireVendor,
        schema: {
          tags: ["vendor"],
          summary: open ? "Start taking orders and bookings" : "Stop taking orders and bookings for now",
          description: open ? "Only a live business opens, and only while its module is live." : "Customers still see it, marked closed.",
          params: BusinessParams,
          response: { 200: BusinessOne, ...Errors },
          security,
        },
      },
      async (request) => {
        const doc = await owned(request, request.params.id);
        await setOpen(db(), doc, open, () => isModuleLive(db(), doc.module), by(request));
        return ok(request, await reload(doc._id));
      },
    );
  }

  app.delete(
    "/businesses/:id",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Delete a draft business and its photos",
        description: "Live businesses can't be deleted; close them instead.",
        params: BusinessParams,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const doc = await owned(request, request.params.id);
      if (doc.status !== "draft") throw new AppError("CONFLICT", "Live businesses can't be deleted. Close it instead.");
      const res = await db().businesses.deleteOne({ _id: doc._id, status: "draft", suspension: { $exists: false } });
      if (res.deletedCount === 0) throw new AppError("CONFLICT");
      await endPlacesFor(db(), { businessId: doc._id }, "owner");
      await Promise.all(doc.photos.flatMap(photoKeys).map((key) => app.media.remove(key)));
      return ok(request, { done: true as const });
    },
  );
};

export default vendor;
