import { randomUUID } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, writeAudit } from "../../platform/audit.js";
import { requireDatabase } from "../../platform/context.js";
import { stamp, type BusinessDoc, type BusinessModule, type BusinessPhoto } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { isModuleLive } from "../../platform/module-switch.js";
import { Done } from "../social/contracts.js";
import { POST_PHOTO_MAX_BYTES, toPostPhoto } from "../social/photos.js";
import { businessView, liveModules, missingOf, ownedBy, photoKeys, requireVendor } from "./businesses.js";
import {
  BusinessList,
  BusinessOne,
  BusinessParams,
  CreateBusinessBody,
  MAX_BUSINESS_PHOTOS,
  MAX_BUSINESSES,
  ModuleChoices,
  PhotoParams,
  UpdateBusinessBody,
} from "./contracts.js";
import payments from "./payments.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const limit = (perMinutes: number, max: number) => ({ rateLimit: { max, timeWindow: perMinutes * 60_000 } });
const MODULES: BusinessModule[] = ["pod", "events", "coaching", "stays"];

const failed = (path: string, message: string) => new AppError("KYC_CHECK_FAILED", message, [{ path, message }]);
const incomplete = (missing: string[]) =>
  new AppError(
    "BUSINESS_INCOMPLETE",
    undefined,
    missing.map((field) => ({ path: `body/${field}`, message: field === "photo" ? "Add at least one photo" : `Add the ${field}` })),
  );

/** The vendor portal: a verified person's businesses, one module each, and how they get paid. */
const vendor: FastifyPluginAsyncTypebox = async (app) => {
  app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: POST_PHOTO_MAX_BYTES }, (_request, body, done) => done(null, body));
  await app.register(payments);

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
    "/modules",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "The modules a business can be opened in, and which are taking new businesses",
        response: { 200: ModuleChoices, ...Errors },
        security,
      },
    },
    async (request) => {
      const docs = await db().moduleSettings.find({ module: { $in: MODULES } }).toArray();
      const choices = MODULES.map((module) => {
        const doc = docs.find((d) => d.module === module);
        return { module, live: doc?.live ?? false, signupsOpen: Boolean(doc?.live && doc.signupsOpen) };
      });
      return page(request, choices, null);
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
        summary: "Start a business in one module",
        description:
          `It starts as a draft. Fill in the details and photos, then publish it. The module must be live and taking new businesses; ` +
          `up to ${MAX_BUSINESSES} businesses each.`,
        body: CreateBusinessBody,
        response: { 201: BusinessOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const database = db();
      const ownerId = request.auth!.userId;
      const { module, name } = request.body;
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
        name: name.trim(),
        description: null,
        phone: null,
        email: null,
        address: null,
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
      const body = request.body;
      const set: Partial<BusinessDoc> = {};
      if (body.name !== undefined) set.name = body.name.trim();
      if (body.description !== undefined) set.description = body.description?.trim() || null;
      if (body.phone !== undefined) set.phone = body.phone;
      if (body.email !== undefined) set.email = body.email?.trim().toLowerCase() || null;
      if (body.address !== undefined) {
        set.address = body.address ? { ...body.address, line1: body.address.line1.trim(), line2: body.address.line2?.trim() || null } : null;
      }
      if (body.gstin !== undefined && body.gstin !== doc.gstin?.number) {
        if (body.gstin === null) set.gstin = null;
        else {
          const result = await app.verifier.gstin(body.gstin, set.name ?? doc.name);
          if (!result.valid) throw failed("body/gstin", "We could not find this GSTIN. Check it, or leave it empty.");
          if (result.status && result.status.toLowerCase() !== "active") throw failed("body/gstin", "This GSTIN is not active.");
          set.gstin = { number: body.gstin, legalName: result.legalName, status: result.status };
        }
      }
      if (doc.status === "live") {
        const missing = missingOf({ ...doc, ...set });
        if (missing.length) throw incomplete(missing);
      }
      await db().businesses.updateOne({ _id: doc._id }, { $set: { ...set, updatedAt: new Date() } });
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
      const full = `Up to ${MAX_BUSINESS_PHOTOS} photos. Remove one first.`;
      if (doc.photos.length >= MAX_BUSINESS_PHOTOS) throw new AppError("CONFLICT", full);
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw new AppError("PHOTO_INVALID");
      const { full: big, smaller } = await toPostPhoto(request.body);
      const id = randomUUID();
      const base = `business-media/${app.config.env}/${doc._id.toHexString()}/${id}`;
      const save = async (file: typeof big, suffix: string) => {
        const key = `${base}${suffix}.webp`;
        return { key, url: await app.media.save(key, file.data), width: file.width, height: file.height };
      };
      const [saved, ...copies] = await Promise.all([save(big, ""), ...smaller.map((file) => save(file, `-${file.width}w`))]);
      const photo: BusinessPhoto = { id, ...saved!, smaller: copies };
      const res = await db().businesses.updateOne(
        { _id: doc._id, suspension: { $exists: false }, [`photos.${MAX_BUSINESS_PHOTOS - 1}`]: { $exists: false } },
        { $push: { photos: photo }, $set: { updatedAt: new Date() } },
      );
      if (res.matchedCount === 0) {
        await Promise.all(photoKeys(photo).map((key) => app.media.remove(key)));
        throw new AppError("CONFLICT", full);
      }
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
      const photo = doc.photos.find((p) => p.id === request.params.photoId);
      if (!photo) throw new AppError("NOT_FOUND", "Photo not found.");
      if (doc.status === "live" && doc.photos.length === 1) throw incomplete(["photo"]);
      await db().businesses.updateOne({ _id: doc._id }, { $pull: { photos: { id: photo.id } }, $set: { updatedAt: new Date() } });
      await Promise.all(photoKeys(photo).map((key) => app.media.remove(key)));
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
        description: "Needs a description of at least 20 characters, a phone number, an address and a photo. It opens straight away.",
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
        if (doc.status !== "live") throw new AppError("CONFLICT", "Publish this business first.");
        if (open && !(await isModuleLive(db(), doc.module))) throw new AppError("MODULE_OFF");
        if (doc.open !== open) await db().businesses.updateOne({ _id: doc._id }, { $set: { open, updatedAt: new Date() } });
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
      await Promise.all(doc.photos.flatMap(photoKeys).map((key) => app.media.remove(key)));
      return ok(request, { done: true as const });
    },
  );
};

export default vendor;
