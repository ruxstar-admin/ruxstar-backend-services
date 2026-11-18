import { randomUUID } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { MongoServerError, ObjectId, type Filter, type WithId } from "mongodb";
import type { Static } from "typebox";
import { Errors } from "../../contracts/common.js";
import { actorOf, diffOf, writeAudit } from "../../platform/audit.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import { stamp, type BusinessDoc, type BusinessPhoto, type GigDoc, type GigPackageDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { Done } from "../social/contracts.js";
import { POST_PHOTO_MAX_BYTES, toPostPhoto } from "../social/photos.js";
import { photoKeys } from "../vendor/businesses.js";
import {
  CreateGigBody,
  IdParams,
  ItemParams,
  MyGigList,
  MyGigOne,
  MyGigsQuery,
  MyProfileOne,
  PhotoParams,
  PortfolioLinkBody,
  StartBody,
  UpdateGigBody,
  UpdateProfileBody,
} from "./contracts.js";
import { termsProblem } from "./quotes.js";
import { gigsSettings, TIER_NAMES, TIERS, type GigsSettings } from "./rules.js";
import { missingOf, myGigViews, ownersOf, profileView } from "./views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const invalid = (path: string, message: string) => new AppError("VALIDATION_FAILED", message, [{ path, message }]);
const isDuplicate = (err: unknown) => err instanceof MongoServerError && err.code === 11000;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const cleanList = (items: string[]) => [...new Map(items.map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean).map((s) => [s.toLowerCase(), s])).values()];

type GigFields = Static<typeof CreateGigBody>;

const portfolioFull = (max: number) => new AppError("CONFLICT", `Your portfolio has room for ${max === 1 ? "one photo or link" : `${max} photos and links`}.`);
const portfolioRoom = (max: number) => ({ $expr: { $lt: [{ $add: [{ $size: "$freelancer.portfolio.photos" }, { $size: "$freelancer.portfolio.links" }] }, max] } });

/** A category that can be picked now: one of Ruxstar's, not hidden (unless it's the one already set). */
function categoryOf(settings: GigsSettings, key: string, path: string, keep?: string) {
  const found = settings.categories.find((c) => c.key === key && (!c.hidden || c.key === keep));
  if (!found) throw invalid(path, "Pick one of the categories.");
  return found.key;
}

/** Checks a gig's packages and questions against Ruxstar's limits: Basic first, then Standard, then Premium. */
export function shapeGig(body: GigFields, settings: GigsSettings, before: GigDoc | null) {
  if (body.packages.length > settings.maxPackages) throw invalid("body/packages", `Up to ${settings.maxPackages} package${settings.maxPackages === 1 ? "" : "s"}.`);
  if (body.questions.length > settings.maxQuestions) {
    throw invalid("body/questions", `Up to ${settings.maxQuestions} question${settings.maxQuestions === 1 ? "" : "s"}.`);
  }
  const packages: GigPackageDoc[] = body.packages.map((p, i) => {
    if (p.tier !== TIERS[i]) throw invalid(`body/packages/${i}/tier`, "Packages go Basic, then Standard, then Premium.");
    const problem = termsProblem(p, settings, `body/packages/${i}`);
    if (problem) throw problem;
    return { tier: p.tier, name: p.name?.trim() || TIER_NAMES[p.tier], description: p.description.trim(), price: p.price, deliveryDays: p.deliveryDays, revisions: p.revisions };
  });
  return {
    title: body.title.trim(),
    category: categoryOf(settings, body.category, "body/category", before?.category),
    description: body.description.trim(),
    packages,
    questions: body.questions.map((q) => ({ id: randomUUID().slice(0, 8), text: q.text.trim(), required: q.required })),
    priceFrom: Math.min(...packages.map((p) => p.price)),
  };
}

const gigFieldsOf = (g: GigDoc): GigFields => ({
  title: g.title,
  category: g.category,
  description: g.description,
  packages: g.packages,
  questions: g.questions.map((q) => ({ text: q.text, required: q.required })),
});

/** Your freelancer profile and your gigs: starting, the profile and portfolio, making and publishing gigs. */
const manage: FastifyPluginAsyncTypebox = async (app) => {
  app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: POST_PHOTO_MAX_BYTES }, (_request, body, done) => done(null, body));
  const db = () => requireDatabase(app.db);
  const by = (request: FastifyRequest) => ({ actor: actorOf(request), ip: request.ip });

  async function verified(userId: ObjectId) {
    const user = await db().users.findOne({ _id: userId }, { projection: { kyc: 1 } });
    return user?.kyc.base === "approved";
  }
  async function mine(request: FastifyRequest, { editing = true }: { editing?: boolean } = {}): Promise<WithId<BusinessDoc>> {
    const doc = await db().businesses.findOne({ ownerId: request.auth!.userId, module: "gigs" });
    if (!doc?.freelancer) throw new AppError("NOT_FOUND", "Start freelancing first.");
    if (editing && doc.suspension) throw new AppError("BUSINESS_SUSPENDED");
    return doc;
  }
  async function myGig(request: FastifyRequest, id: string, opts: { editing?: boolean } = {}) {
    const business = await mine(request, opts);
    const gig = await db().gigs.findOne({ _id: new ObjectId(id), businessId: business._id });
    if (!gig) throw new AppError("NOT_FOUND", "Gig not found.");
    if (opts.editing !== false && gig.status === "removed") throw new AppError("CONFLICT", "Ruxstar took this gig down, so it can't be changed.");
    return { business, gig };
  }
  async function profile(request: FastifyRequest, doc: WithId<BusinessDoc>) {
    const settings = await gigsSettings(db());
    const [owners, total, live, isVerified] = await Promise.all([
      ownersOf(db(), [doc.ownerId]),
      db().gigs.countDocuments({ businessId: doc._id, status: { $ne: "removed" } }),
      db().gigs.countDocuments({ businessId: doc._id, status: "live" }),
      verified(doc.ownerId),
    ]);
    return ok(request, {
      ...profileView(doc, owners.get(doc.ownerId.toHexString()), settings),
      status: doc.status,
      verified: isVerified,
      suspended: Boolean(doc.suspension),
      hold: doc.suspension ? { reason: doc.suspension.reason, at: doc.suspension.at.toISOString() } : null,
      gigs: { total, live, max: settings.maxGigs },
      createdAt: doc.createdAt.toISOString(),
    });
  }
  async function gigView(request: FastifyRequest, gig: WithId<GigDoc>) {
    const [view] = await myGigViews(db(), [gig], await gigsSettings(db()), await verified(gig.vendorId));
    return ok(request, view!);
  }
  async function savePhoto(prefix: string, body: unknown): Promise<BusinessPhoto> {
    if (!Buffer.isBuffer(body) || body.length === 0) throw new AppError("PHOTO_INVALID");
    const { full, smaller } = await toPostPhoto(body);
    const id = randomUUID();
    const base = `gigs-media/${app.config.env}/${prefix}/${id}`;
    const save = async (file: typeof full, suffix: string) => {
      const key = `${base}${suffix}.webp`;
      return { key, url: await app.media.save(key, file.data), width: file.width, height: file.height };
    };
    const [saved, ...copies] = await Promise.all([save(full, ""), ...smaller.map((file) => save(file, `-${file.width}w`))]);
    return { id, ...saved!, smaller: copies };
  }
  const dropPhoto = (photo: BusinessPhoto) => Promise.all(photoKeys(photo).map((key) => app.media.remove(key)));

  app.post(
    "/",
    {
      preHandler: [requireAuth, idempotent],
      config: { rateLimit: { max: 10, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["gigs"],
        summary: "Start freelancing: your freelancer profile",
        description:
          "Anyone signed in can, once; one profile per person. It stays a draft until your first gig is published, which needs base verification. " +
          "A payout account is only needed to withdraw. Freelancers work on their own; there's no team.",
        body: StartBody,
        response: { 201: MyProfileOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const database = db();
      const ownerId = request.auth!.userId;
      const settings = await gigsSettings(database);
      if (!settings.live) throw new AppError("MODULE_OFF");
      if (!settings.signupsOpen) throw new AppError("SIGNUPS_CLOSED", "Ruxstar isn't taking new freelancers right now.");
      if (await database.businesses.findOne({ ownerId, module: "gigs" }, { projection: { _id: 1 } })) throw new AppError("CONFLICT", "You've started freelancing already.");
      const body = request.body;
      const now = new Date();
      const doc: BusinessDoc = {
        _id: new ObjectId(),
        ownerId,
        module: "gigs",
        type: "freelancer",
        name: body.name.trim(),
        description: body.bio?.trim() || null,
        phone: null,
        location: null,
        pod: null,
        freelancer: {
          headline: body.headline.trim(),
          category: categoryOf(settings, body.category, "body/category"),
          skills: cleanList(body.skills),
          languages: cleanList(body.languages),
          city: body.city?.trim().toLowerCase() || null,
          portfolio: { photos: [], links: [] },
        },
        gstin: null,
        photos: [],
        status: "draft",
        open: false,
        publishedAt: null,
        ...stamp(now),
      };
      try {
        await database.businesses.insertOne(doc);
      } catch (err) {
        if (isDuplicate(err)) throw new AppError("CONFLICT", "You've started freelancing already.");
        throw err;
      }
      await writeAudit(database, { ...by(request), scope: { module: "gigs", businessId: doc._id }, action: "freelancer.start", target: { type: "business", id: doc._id }, diff: {} });
      return reply.status(201).send(await profile(request, doc));
    },
  );

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: { tags: ["gigs"], summary: "Your freelancer profile", description: "NOT_FOUND until you start freelancing.", response: { 200: MyProfileOne, ...Errors }, security },
    },
    async (request) => profile(request, await mine(request, { editing: false })),
  );

  app.patch(
    "/",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: 60 * 60_000 } },
      schema: { tags: ["gigs"], summary: "Change your freelancer profile", body: UpdateProfileBody, response: { 200: MyProfileOne, ...Errors }, security },
    },
    async (request) => {
      const before = await mine(request);
      const settings = await gigsSettings(db());
      const body = request.body;
      const f = before.freelancer!;
      const next: Partial<BusinessDoc> = {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.bio !== undefined ? { description: body.bio?.trim() || null } : {}),
        freelancer: {
          ...f,
          ...(body.headline !== undefined ? { headline: body.headline.trim() } : {}),
          ...(body.category !== undefined ? { category: categoryOf(settings, body.category, "body/category", f.category) } : {}),
          ...(body.skills !== undefined ? { skills: cleanList(body.skills) } : {}),
          ...(body.languages !== undefined ? { languages: cleanList(body.languages) } : {}),
          ...(body.city !== undefined ? { city: body.city?.trim().toLowerCase() || null } : {}),
        },
      };
      const now = new Date();
      const after = await db().businesses.findOneAndUpdate({ _id: before._id }, { $set: { ...next, updatedAt: now } }, { returnDocument: "after" });
      if (after!.name !== before.name || after!.freelancer!.city !== f.city) {
        await db().gigs.updateMany({ businessId: before._id }, { $set: { businessName: after!.name, city: after!.freelancer!.city, updatedAt: now } });
      }
      const diff = diffOf<Partial<BusinessDoc>>({ name: before.name, description: before.description, freelancer: f }, next);
      if (Object.keys(diff).length) {
        await writeAudit(db(), { ...by(request), scope: { module: "gigs", businessId: before._id }, action: "freelancer.update", target: { type: "business", id: before._id }, diff });
      }
      return profile(request, after!);
    },
  );

  app.post(
    "/portfolio/photos",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["gigs"],
        summary: "Add a photo to your portfolio",
        description: "Send the image itself with Content-Type image/jpeg, image/png or image/webp, up to 8 MB. Up to GET /v1/gigs/rules `limits.portfolio` photos and links together.",
        consumes: PHOTO_TYPES,
        response: { 200: MyProfileOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const before = await mine(request);
      const { maxPortfolio } = await gigsSettings(db());
      const p = before.freelancer!.portfolio;
      if (p.photos.length + p.links.length >= maxPortfolio) throw portfolioFull(maxPortfolio);
      const photo = await savePhoto(`portfolio/${before._id.toHexString()}`, request.body);
      const after = await db().businesses.findOneAndUpdate(
        { _id: before._id, ...portfolioRoom(maxPortfolio) },
        { $push: { "freelancer.portfolio.photos": photo }, $set: { updatedAt: new Date() } },
        { returnDocument: "after" },
      );
      if (!after) {
        await dropPhoto(photo);
        throw portfolioFull(maxPortfolio);
      }
      return profile(request, after);
    },
  );

  app.delete(
    "/portfolio/photos/:itemId",
    {
      preHandler: requireAuth,
      schema: { tags: ["gigs"], summary: "Remove a portfolio photo", params: ItemParams, response: { 200: MyProfileOne, ...Errors }, security },
    },
    async (request) => {
      const before = await mine(request);
      const photo = before.freelancer!.portfolio.photos.find((p) => p.id === request.params.itemId);
      if (!photo) throw new AppError("NOT_FOUND", "Photo not found.");
      const after = await db().businesses.findOneAndUpdate(
        { _id: before._id },
        { $pull: { "freelancer.portfolio.photos": { id: photo.id } }, $set: { updatedAt: new Date() } },
        { returnDocument: "after" },
      );
      await dropPhoto(photo);
      return profile(request, after!);
    },
  );

  app.post(
    "/portfolio/links",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["gigs"],
        summary: "Add a link to your portfolio",
        description: "Up to GET /v1/gigs/rules `limits.portfolio` photos and links together.",
        body: PortfolioLinkBody,
        response: { 200: MyProfileOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const before = await mine(request);
      const { maxPortfolio } = await gigsSettings(db());
      const link = { id: randomUUID().slice(0, 8), title: request.body.title.trim(), url: request.body.url.trim() };
      const after = await db().businesses.findOneAndUpdate(
        { _id: before._id, ...portfolioRoom(maxPortfolio) },
        { $push: { "freelancer.portfolio.links": link }, $set: { updatedAt: new Date() } },
        { returnDocument: "after" },
      );
      if (!after) throw portfolioFull(maxPortfolio);
      return profile(request, after);
    },
  );

  app.delete(
    "/portfolio/links/:itemId",
    {
      preHandler: requireAuth,
      schema: { tags: ["gigs"], summary: "Remove a portfolio link", params: ItemParams, response: { 200: MyProfileOne, ...Errors }, security },
    },
    async (request) => {
      const before = await mine(request);
      if (!before.freelancer!.portfolio.links.some((l) => l.id === request.params.itemId)) throw new AppError("NOT_FOUND", "Link not found.");
      const after = await db().businesses.findOneAndUpdate(
        { _id: before._id },
        { $pull: { "freelancer.portfolio.links": { id: request.params.itemId } }, $set: { updatedAt: new Date() } },
        { returnDocument: "after" },
      );
      return profile(request, after!);
    },
  );

  // Gigs.

  app.get(
    "/gigs",
    {
      preHandler: requireAuth,
      schema: { tags: ["gigs"], summary: "Your gigs, newest first, drafts included", querystring: MyGigsQuery, response: { 200: MyGigList, ...Errors }, security },
    },
    async (request) => {
      const business = await mine(request, { editing: false });
      const filter: Filter<GigDoc> = { businessId: business._id, ...(request.query.status ? { status: request.query.status } : {}) };
      const { items, nextCursor } = await findPage(db().gigs, { filter, sortField: "createdAt", cursor: request.query.cursor, limit: request.query.limit });
      return page(request, await myGigViews(db(), items, await gigsSettings(db()), await verified(business.ownerId)), nextCursor);
    },
  );

  app.post(
    "/gigs",
    {
      preHandler: [requireAuth, idempotent],
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["gigs"],
        summary: "Make a gig",
        description: "It starts as a draft. Add at least one photo, then publish it. Up to Ruxstar's gigs per freelancer, drafts included.",
        body: CreateGigBody,
        response: { 201: MyGigOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const business = await mine(request);
      const settings = await gigsSettings(db());
      if ((await db().gigs.countDocuments({ businessId: business._id, status: { $ne: "removed" } })) >= settings.maxGigs) {
        throw new AppError("CONFLICT", `You can have up to ${settings.maxGigs} gigs.`);
      }
      const shaped = shapeGig(request.body, settings, null);
      const gig: GigDoc = {
        _id: new ObjectId(),
        businessId: business._id,
        vendorId: business.ownerId,
        businessName: business.name,
        ...shaped,
        photos: [],
        city: business.freelancer!.city,
        status: "draft",
        publishedAt: null,
        removal: null,
        ...stamp(),
      };
      await db().gigs.insertOne(gig);
      await writeAudit(db(), { ...by(request), scope: { module: "gigs", businessId: business._id }, action: "gig.create", target: { type: "gig", id: gig._id }, diff: {} });
      return reply.status(201).send(await gigView(request, gig));
    },
  );

  app.get(
    "/gigs/:id",
    { preHandler: requireAuth, schema: { tags: ["gigs"], summary: "One of your gigs", params: IdParams, response: { 200: MyGigOne, ...Errors }, security } },
    async (request) => gigView(request, (await myGig(request, request.params.id, { editing: false })).gig),
  );

  app.patch(
    "/gigs/:id",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: 60 * 60_000 } },
      schema: { tags: ["gigs"], summary: "Change a gig", params: IdParams, body: UpdateGigBody, response: { 200: MyGigOne, ...Errors }, security },
    },
    async (request) => {
      const { business, gig } = await myGig(request, request.params.id);
      const settings = await gigsSettings(db());
      const merged = { ...gigFieldsOf(gig), ...request.body };
      const shaped = shapeGig(merged, settings, gig);
      if (!request.body.questions) shaped.questions = gig.questions;
      const after = await db().gigs.findOneAndUpdate({ _id: gig._id }, { $set: { ...shaped, updatedAt: new Date() } }, { returnDocument: "after" });
      const diff = diffOf(gigFieldsOf(gig), request.body);
      if (Object.keys(diff).length) {
        await writeAudit(db(), { ...by(request), scope: { module: "gigs", businessId: business._id }, action: "gig.update", target: { type: "gig", id: gig._id }, diff });
      }
      return gigView(request, after!);
    },
  );

  app.delete(
    "/gigs/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["gigs"],
        summary: "Delete a gig",
        description: "Only gigs never ordered. Pause one that has orders instead.",
        params: IdParams,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const { business, gig } = await myGig(request, request.params.id);
      if (await db().gigOrders.findOne({ gigId: gig._id }, { projection: { _id: 1 } })) throw new AppError("CONFLICT", "This gig has orders. Pause it instead.");
      await db().gigs.deleteOne({ _id: gig._id });
      await Promise.all(gig.photos.map(dropPhoto));
      await writeAudit(db(), { ...by(request), scope: { module: "gigs", businessId: business._id }, action: "gig.delete", target: { type: "gig", id: gig._id }, diff: {} });
      return ok(request, { done: true as const });
    },
  );

  app.post(
    "/gigs/:id/photos",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["gigs"],
        summary: "Add a photo to a gig",
        description:
          "Send the image itself with Content-Type image/jpeg, image/png or image/webp, up to 8 MB. Up to GET /v1/gigs/rules `limits.gigPhotos`; the first is the cover.",
        consumes: PHOTO_TYPES,
        params: IdParams,
        response: { 200: MyGigOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { gig } = await myGig(request, request.params.id);
      const { maxGigPhotos } = await gigsSettings(db());
      const full = () => new AppError("CONFLICT", `A gig has up to ${maxGigPhotos} photo${maxGigPhotos === 1 ? "" : "s"}.`);
      if (gig.photos.length >= maxGigPhotos) throw full();
      const photo = await savePhoto(gig._id.toHexString(), request.body);
      const after = await db().gigs.findOneAndUpdate(
        { _id: gig._id, [`photos.${maxGigPhotos - 1}`]: { $exists: false } },
        { $push: { photos: photo }, $set: { updatedAt: new Date() } },
        { returnDocument: "after" },
      );
      if (!after) {
        await dropPhoto(photo);
        throw full();
      }
      return gigView(request, after);
    },
  );

  app.delete(
    "/gigs/:id/photos/:photoId",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["gigs"],
        summary: "Remove a photo from a gig",
        description: "A live gig keeps at least one.",
        params: PhotoParams,
        response: { 200: MyGigOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { gig } = await myGig(request, request.params.id);
      const photo = gig.photos.find((p) => p.id === request.params.photoId);
      if (!photo) throw new AppError("NOT_FOUND", "Photo not found.");
      if (gig.status !== "draft" && gig.photos.length === 1) throw new AppError("CONFLICT", "A published gig needs a photo. Add another first.");
      const after = await db().gigs.findOneAndUpdate({ _id: gig._id }, { $pull: { photos: { id: photo.id } }, $set: { updatedAt: new Date() } }, { returnDocument: "after" });
      await dropPhoto(photo);
      return gigView(request, after!);
    },
  );

  app.post(
    "/gigs/:id/publish",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["gigs"],
        summary: "Publish a gig, or take orders for a paused one again",
        description: "Needs base verification and a photo. Your first published gig puts your freelancer profile on Ruxstar.",
        params: IdParams,
        response: { 200: MyGigOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { business, gig } = await myGig(request, request.params.id);
      const settings = await gigsSettings(db());
      if (!settings.live) throw new AppError("MODULE_OFF");
      if (gig.status === "live") return gigView(request, gig);
      if (!(await verified(business.ownerId))) throw new AppError("KYC_REQUIRED", "Get verified to publish gigs.");
      const missing = missingOf(gig, true);
      if (missing.length) throw new AppError("CONFLICT", `${missing.join(". ")} first.`);
      const now = new Date();
      const after = await db().gigs.findOneAndUpdate(
        { _id: gig._id, status: { $in: ["draft", "paused"] } },
        { $set: { status: "live", publishedAt: gig.publishedAt ?? now, updatedAt: now } },
        { returnDocument: "after" },
      );
      if (!after) throw new AppError("CONFLICT");
      if (business.status !== "live") {
        await db().businesses.updateOne({ _id: business._id, status: "draft" }, { $set: { status: "live", open: true, publishedAt: now, updatedAt: now } });
      }
      await writeAudit(db(), {
        ...by(request),
        scope: { module: "gigs", businessId: business._id },
        action: "gig.publish",
        target: { type: "gig", id: gig._id },
        diff: { status: { from: gig.status, to: "live" } },
      });
      return gigView(request, after);
    },
  );

  app.post(
    "/gigs/:id/pause",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["gigs"],
        summary: "Stop taking orders for a gig",
        description: "It leaves the listings; orders already placed go on. Publish it again to take orders.",
        params: IdParams,
        response: { 200: MyGigOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { business, gig } = await myGig(request, request.params.id, { editing: false });
      if (gig.status === "paused") return gigView(request, gig);
      if (gig.status !== "live") throw new AppError("CONFLICT", "Only live gigs can be paused.");
      const after = await db().gigs.findOneAndUpdate({ _id: gig._id, status: "live" }, { $set: { status: "paused", updatedAt: new Date() } }, { returnDocument: "after" });
      if (!after) throw new AppError("CONFLICT");
      await writeAudit(db(), {
        ...by(request),
        scope: { module: "gigs", businessId: business._id },
        action: "gig.pause",
        target: { type: "gig", id: gig._id },
        diff: { status: { from: "live", to: "paused" } },
      });
      return gigView(request, after);
    },
  );
};

export default manage;
