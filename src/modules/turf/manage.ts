import { randomUUID } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type WithId } from "mongodb";
import type { Static } from "typebox";
import { Errors } from "../../contracts/common.js";
import { actorOf, diffOf, writeAudit } from "../../platform/audit.js";
import { requireDatabase } from "../../platform/context.js";
import { stamp, type BusinessPhoto, type TurfAddOn, type TurfCourtDoc, type TurfGroundDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { isModuleLive } from "../../platform/module-switch.js";
import { Done } from "../social/contracts.js";
import { toPostPhoto } from "../social/photos.js";
import { ownedBy, photoKeys, requireVendor } from "../vendor/businesses.js";
import {
  CourtBody,
  CreateGroundBody,
  IdParams,
  PhotoParams,
  UpdateCourtBody,
  UpdateGroundBody,
  VendorGroundList,
  VendorGroundOne,
  type Prices,
} from "./contracts.js";
import { refreshGround } from "./orders.js";
import { MAX_PHOTOS, turfSettings, type TurfSettings } from "./rules.js";
import { minutesOf, slotAt, standing, whenText } from "./slots.js";
import { loadSports, missingOf, vendorGroundView } from "./views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const invalid = (path: string, message: string) => new AppError("VALIDATION_FAILED", message, [{ path, message }]);

type GroundFields = Static<typeof CreateGroundBody>;
type CourtFields = Static<typeof CourtBody>;
type AddOnInput = NonNullable<CourtFields["addOns"]>[number];

/** What's wrong with a court's prices, if anything: peak windows must end after they start and not overlap on a day. */
export function pricesProblem(prices: Static<typeof Prices>): { path: string; message: string } | null {
  for (const [i, p] of prices.peak.entries()) {
    if (minutesOf(p.end) <= minutesOf(p.start)) return { path: `body/prices/peak/${i}/end`, message: "A peak window must end after it starts." };
    const clash = prices.peak.findIndex(
      (q, j) => j < i && q.days.some((d) => p.days.includes(d)) && minutesOf(q.start) < minutesOf(p.end) && minutesOf(p.start) < minutesOf(q.end),
    );
    if (clash >= 0) return { path: `body/prices/peak/${i}`, message: "Two peak windows overlap on the same day." };
  }
  return null;
}

/** Add-ons with their ids: ones sent with an id keep it, new ones get one. Names must differ. */
export function withAddOnIds(input: AddOnInput[], before: TurfAddOn[]): TurfAddOn[] {
  const names = new Set<string>();
  return input.map((a, i) => {
    const name = a.name.trim();
    if (names.has(name.toLowerCase())) throw invalid(`body/addOns/${i}/name`, "Two add-ons have this name.");
    names.add(name.toLowerCase());
    const kept = a.id ? before.find((b) => b.id === a.id) : undefined;
    if (a.id && !kept) throw invalid(`body/addOns/${i}/id`, "This add-on isn't on the court. Leave the id out for a new one.");
    return { id: kept?.id ?? randomUUID().slice(0, 8), name, price: a.price, per: a.per };
  });
}

function hoursProblem(hours: CourtFields["hours"], slotMinutes: number): { path: string; message: string } | null {
  const days = new Set<number>();
  for (const [i, h] of hours.entries()) {
    if (days.has(h.day)) return { path: `body/hours/${i}/day`, message: "Give each weekday once." };
    days.add(h.day);
    if (h.open === "24:00") return { path: `body/hours/${i}/open`, message: "Opening can't be midnight at the end of the day." };
    if (minutesOf(h.close) - minutesOf(h.open) < slotMinutes) return { path: `body/hours/${i}/close`, message: "Closing must leave room for at least one slot after opening." };
  }
  return null;
}

function refundsOf(body: GroundFields["refunds"], rules: TurfSettings, before: TurfGroundDoc["refunds"] | null): TurfGroundDoc["refunds"] {
  const refunds = body ?? before ?? { fullHours: rules.refundFullHours, halfHours: rules.refundHalfHours };
  if (refunds.fullHours < rules.minFullHours || refunds.fullHours > rules.maxFullHours) {
    throw invalid("body/refunds/fullHours", `The full refund must start between ${rules.minFullHours} and ${rules.maxFullHours} hours before the slot.`);
  }
  if (refunds.halfHours > refunds.fullHours) throw invalid("body/refunds/halfHours", "The partial refund must start nearer the slot than the full refund.");
  return { fullHours: refunds.fullHours, halfHours: refunds.halfHours };
}

const groundFieldsOf = (doc: TurfGroundDoc): GroundFields => ({
  name: doc.name,
  description: doc.description,
  venue: doc.venue,
  amenities: doc.amenities,
  refunds: doc.refunds,
});

function shapeGround(body: GroundFields, rules: TurfSettings, before: TurfGroundDoc | null) {
  const venue = {
    address: body.venue.address.trim(),
    city: body.venue.city.trim(),
    pincode: body.venue.pincode ?? null,
    point: body.venue.point ?? null,
  };
  return {
    name: body.name.trim(),
    description: body.description?.trim() || null,
    venue,
    city: venue.city.toLowerCase(),
    amenities: body.amenities ?? before?.amenities ?? [],
    refunds: refundsOf(body.refunds, rules, before?.refunds ?? null),
  };
}

const courtFieldsOf = (doc: TurfCourtDoc): CourtFields => ({
  name: doc.name,
  sports: doc.sports,
  slotMinutes: doc.slotMinutes as 30 | 60 | 90,
  hours: doc.hours,
  prices: doc.prices,
  addOns: doc.addOns,
  status: doc.status === "live" ? "live" : "paused",
});

/** A sports ground business's grounds and courts. Only the owner sets them up; prices can also be changed from the desk. */
const manage: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  async function business(request: FastifyRequest, id: string | ObjectId) {
    const doc = await db().businesses.findOne(ownedBy(new ObjectId(id), request.auth!.userId));
    if (!doc) throw new AppError("NOT_FOUND", "Business not found.");
    if (doc.module !== "turf") throw new AppError("CONFLICT", "Grounds are for sports and turf businesses.");
    return doc;
  }
  async function owned(request: FastifyRequest, id: string | ObjectId, { editing = true } = {}) {
    const doc = await db().turfGrounds.findOne({ _id: new ObjectId(id), vendorId: request.auth!.userId });
    if (!doc) throw new AppError("NOT_FOUND", "Ground not found.");
    if (editing) {
      const shop = await db().businesses.findOne({ _id: doc.businessId }, { projection: { suspension: 1 } });
      if (shop?.suspension) throw new AppError("BUSINESS_SUSPENDED");
      if (doc.status === "removed") throw new AppError("CONFLICT", "Ruxstar took this ground down.");
    }
    return doc;
  }
  async function ownedCourt(request: FastifyRequest, id: string) {
    const court = await db().turfCourts.findOne({ _id: new ObjectId(id), vendorId: request.auth!.userId, status: { $ne: "removed" } });
    if (!court) throw new AppError("NOT_FOUND", "Court not found.");
    return { court, ground: await owned(request, court.groundId) };
  }
  const view = async (ground: WithId<TurfGroundDoc>) => vendorGroundView(db(), ground, await turfSettings(db()));
  const reread = async (id: ObjectId) => view((await db().turfGrounds.findOne({ _id: id }))!);
  const audit = (request: FastifyRequest, businessId: ObjectId, action: string, target: { type: string; id: ObjectId }, diff: Record<string, { from: unknown; to: unknown }>) =>
    writeAudit(db(), { actor: actorOf(request), scope: { module: "turf", businessId }, action, target, diff, ip: request.ip });

  /** Checks a court against Ruxstar's rules and the sports list. */
  async function shapeCourt(body: CourtFields, rules: TurfSettings, before: TurfCourtDoc | null) {
    if (!rules.slotLengths.includes(body.slotMinutes)) throw invalid("body/slotMinutes", `Slots can be ${rules.slotLengths.join(", ")} minutes long.`);
    const sports = await loadSports(db());
    body.sports.forEach((key, i) => {
      const sport = sports.find((s) => s._id === key);
      if (!sport || (!sport.active && !before?.sports.includes(key))) throw invalid(`body/sports/${i}`, "Pick sports from the list.");
    });
    const hours = hoursProblem(body.hours, body.slotMinutes);
    if (hours) throw invalid(hours.path, hours.message);
    const prices = pricesProblem(body.prices);
    if (prices) throw invalid(prices.path, prices.message);
    const addOns = body.addOns ?? before?.addOns ?? [];
    if (addOns.length > rules.maxAddOns) throw invalid("body/addOns", `A court can have up to ${rules.maxAddOns} add-ons.`);
    return {
      name: body.name.trim(),
      sports: body.sports,
      slotMinutes: body.slotMinutes,
      hours: [...body.hours].sort((a, b) => a.day - b.day),
      prices: body.prices,
      addOns: withAddOnIds(addOns, before?.addOns ?? []),
      status: body.status ?? (before?.status === "paused" ? "paused" : "live"),
    } satisfies Partial<TurfCourtDoc>;
  }

  /** Booked, held and blocked slots still to come must stay slots of the court under new hours or slot length. */
  async function scheduleFits(court: TurfCourtDoc, next: Pick<TurfCourtDoc, "slotMinutes" | "hours" | "prices">) {
    const now = new Date();
    const taken = await db().turfSlots.find({ courtId: court._id, endAt: { $gt: now } }).sort({ startAt: 1 }).toArray();
    const misfit = taken.find((doc) => standing(doc, now) && slotAt(next, doc.startAt)?.endAt.getTime() !== doc.endAt.getTime());
    if (misfit) {
      throw new AppError(
        "CONFLICT",
        `${whenText(misfit.startAt, misfit.endAt)} is ${misfit.status === "blocked" ? "blocked" : "booked"} and wouldn't fit the new hours. ${misfit.status === "blocked" ? "Unblock" : "Cancel"} it first.`,
      );
    }
  }

  app.get(
    "/businesses/:id/grounds",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "A sports business's grounds, oldest first, with their courts",
        params: IdParams,
        response: { 200: VendorGroundList, ...Errors },
        security,
      },
    },
    async (request) => {
      const shop = await business(request, request.params.id);
      const docs = await db().turfGrounds.find({ businessId: shop._id }).sort({ createdAt: 1 }).limit(100).toArray();
      const settings = await turfSettings(db());
      return page(request, await Promise.all(docs.map((g) => vendorGroundView(db(), g, settings))), null);
    },
  );

  app.post(
    "/businesses/:id/grounds",
    {
      preHandler: [requireVendor, idempotent],
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Make a ground as a draft",
        description: "Add photos and courts next, then publish it. Refund hours default to Ruxstar's and must be within GET /v1/turf/rules' limits.",
        params: IdParams,
        body: CreateGroundBody,
        response: { 201: VendorGroundOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const shop = await business(request, request.params.id);
      if (shop.suspension) throw new AppError("BUSINESS_SUSPENDED");
      if (!(await isModuleLive(db(), "turf"))) throw new AppError("MODULE_OFF");
      const settings = await turfSettings(db());
      if ((await db().turfGrounds.countDocuments({ businessId: shop._id, status: { $ne: "removed" } })) >= settings.maxGrounds) {
        throw new AppError("CONFLICT", `A business can have up to ${settings.maxGrounds} grounds.`);
      }
      const doc: TurfGroundDoc = {
        _id: new ObjectId(),
        businessId: shop._id,
        vendorId: shop.ownerId,
        businessName: shop.name,
        ...shapeGround(request.body, settings, null),
        photos: [],
        sports: [],
        priceFrom: null,
        status: "draft",
        publishedAt: null,
        removal: null,
        ...stamp(),
      };
      await db().turfGrounds.insertOne(doc);
      await audit(request, shop._id, "turf_ground.create", { type: "turf_ground", id: doc._id }, { name: { from: null, to: doc.name } });
      return reply.status(201).send(ok(request, await view(doc)));
    },
  );

  app.get(
    "/grounds/:id",
    {
      preHandler: requireVendor,
      schema: { tags: ["vendor"], summary: "One of your grounds, with its courts and what it needs to publish", params: IdParams, response: { 200: VendorGroundOne, ...Errors }, security },
    },
    async (request) => ok(request, await view(await owned(request, request.params.id, { editing: false }))),
  );

  app.patch(
    "/grounds/:id",
    {
      preHandler: requireVendor,
      config: { rateLimit: { max: 60, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Change a ground's details, amenities or refund hours",
        description: "New refund hours apply to bookings made from now; earlier ones keep theirs.",
        params: IdParams,
        body: UpdateGroundBody,
        response: { 200: VendorGroundOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const before = await owned(request, request.params.id);
      const shaped = shapeGround({ ...groundFieldsOf(before), ...request.body } as GroundFields, await turfSettings(db()), before);
      const diff = diffOf(before as unknown as Record<string, unknown>, shaped as unknown as Record<string, unknown>);
      if (!Object.keys(diff).length) return ok(request, await view(before));
      const after = await db().turfGrounds.findOneAndUpdate({ _id: before._id }, { $set: { ...shaped, updatedAt: new Date() } }, { returnDocument: "after" });
      await audit(request, before.businessId, "turf_ground.update", { type: "turf_ground", id: before._id }, diff);
      if (after!.name !== before.name) {
        await db().turfBookings.updateMany({ groundId: before._id, status: { $ne: "cancelled" } }, { $set: { groundName: after!.name } });
      }
      return ok(request, await view(after!));
    },
  );

  app.post(
    "/grounds/:id/photos",
    {
      preHandler: requireVendor,
      config: { rateLimit: { max: 60, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Add a photo to the ground",
        description: `Send the image itself with Content-Type image/jpeg, image/png or image/webp, up to 8 MB. Up to ${MAX_PHOTOS}; the first is the cover.`,
        consumes: ["image/jpeg", "image/png", "image/webp"],
        params: IdParams,
        response: { 200: VendorGroundOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const ground = await owned(request, request.params.id);
      if (ground.photos.length >= MAX_PHOTOS) throw new AppError("CONFLICT", `A ground has up to ${MAX_PHOTOS} photos. Remove one first.`);
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw new AppError("PHOTO_INVALID");
      const { full, smaller } = await toPostPhoto(request.body);
      const id = randomUUID();
      const base = `turf-media/${app.config.env}/${ground._id.toHexString()}/${id}`;
      const save = async (file: typeof full, suffix: string) => {
        const key = `${base}${suffix}.webp`;
        return { key, url: await app.media.save(key, file.data), width: file.width, height: file.height };
      };
      const [saved, ...copies] = await Promise.all([save(full, ""), ...smaller.map((file) => save(file, `-${file.width}w`))]);
      const photo: BusinessPhoto = { id, ...saved!, smaller: copies };
      const after = await db().turfGrounds.findOneAndUpdate(
        { _id: ground._id, [`photos.${MAX_PHOTOS - 1}`]: { $exists: false } },
        { $push: { photos: photo }, $set: { updatedAt: new Date() } },
        { returnDocument: "after" },
      );
      if (!after) {
        await Promise.all(photoKeys(photo).map((key) => app.media.remove(key)));
        throw new AppError("CONFLICT", `A ground has up to ${MAX_PHOTOS} photos. Remove one first.`);
      }
      return ok(request, await view(after));
    },
  );

  app.delete(
    "/grounds/:id/photos/:photoId",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Remove a photo from the ground",
        description: "A published ground keeps at least one.",
        params: PhotoParams,
        response: { 200: VendorGroundOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const ground = await owned(request, request.params.id);
      const photo = ground.photos.find((p) => p.id === request.params.photoId);
      if (!photo) throw new AppError("NOT_FOUND", "Photo not found.");
      if (ground.status === "live" && ground.photos.length === 1) throw new AppError("CONFLICT", "A published ground needs a photo. Add another first.");
      const after = await db().turfGrounds.findOneAndUpdate({ _id: ground._id }, { $pull: { photos: { id: photo.id } }, $set: { updatedAt: new Date() } }, { returnDocument: "after" });
      await Promise.all(photoKeys(photo).map((key) => app.media.remove(key)));
      return ok(request, await view(after!));
    },
  );

  app.post(
    "/grounds/:id/publish",
    {
      preHandler: [requireVendor, idempotent],
      schema: {
        tags: ["vendor"],
        summary: "Put a draft ground up for bookings",
        description: "Needs the business published, a photo, and a court open for bookings with opening hours. Everything missing comes back at once.",
        params: IdParams,
        response: { 200: VendorGroundOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const ground = await owned(request, request.params.id);
      if (ground.status !== "draft") throw new AppError("CONFLICT", "This ground is published already.");
      const shop = await db().businesses.findOne({ _id: ground.businessId });
      const courts = await db().turfCourts.find({ groundId: ground._id, status: { $ne: "removed" } }).toArray();
      const missing = missingOf(ground, courts, shop?.status === "live");
      if (missing.length) throw new AppError("BUSINESS_INCOMPLETE", missing.join(". "), missing.map((message) => ({ path: "body", message })));
      if (!(await isModuleLive(db(), "turf"))) throw new AppError("MODULE_OFF");
      const now = new Date();
      const after = await db().turfGrounds.findOneAndUpdate(
        { _id: ground._id, status: "draft" },
        { $set: { status: "live", publishedAt: now, businessName: shop!.name, updatedAt: now } },
        { returnDocument: "after" },
      );
      if (!after) throw new AppError("CONFLICT");
      await audit(request, ground.businessId, "turf_ground.publish", { type: "turf_ground", id: ground._id }, { status: { from: "draft", to: "live" } });
      return ok(request, await view(after));
    },
  );

  app.delete(
    "/grounds/:id",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Delete a draft ground, with its courts and photos",
        description: "Published grounds stay; pause their courts instead.",
        params: IdParams,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const ground = await owned(request, request.params.id, { editing: false });
      if (ground.status !== "draft") throw new AppError("CONFLICT", "Only drafts can be deleted. Pause its courts instead.");
      if (await db().turfBookings.findOne({ groundId: ground._id }, { projection: { _id: 1 } })) throw new AppError("CONFLICT", "This ground has had bookings, so it stays.");
      const res = await db().turfGrounds.deleteOne({ _id: ground._id, status: "draft" });
      if (!res.deletedCount) throw new AppError("CONFLICT");
      await Promise.all([db().turfCourts.deleteMany({ groundId: ground._id }), db().turfSlots.deleteMany({ groundId: ground._id })]);
      await Promise.all(ground.photos.flatMap(photoKeys).map((key) => app.media.remove(key)));
      await audit(request, ground.businessId, "turf_ground.delete", { type: "turf_ground", id: ground._id }, { name: { from: ground.name, to: null } });
      return ok(request, { done: true as const });
    },
  );

  // Courts.

  app.post(
    "/grounds/:id/courts",
    {
      preHandler: [requireVendor, idempotent],
      config: { rateLimit: { max: 60, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Add a court to the ground",
        description: "Its slots run from opening every `slotMinutes` while a whole slot fits before closing. Sports come from GET /v1/turf/sports.",
        params: IdParams,
        body: CourtBody,
        response: { 201: VendorGroundOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const ground = await owned(request, request.params.id);
      const settings = await turfSettings(db());
      const courts = await db().turfCourts.find({ groundId: ground._id, status: { $ne: "removed" } }, { projection: { order: 1 } }).toArray();
      if (courts.length >= settings.maxCourts) throw new AppError("CONFLICT", `A ground can have up to ${settings.maxCourts} courts.`);
      const doc: TurfCourtDoc = {
        _id: new ObjectId(),
        groundId: ground._id,
        businessId: ground.businessId,
        vendorId: ground.vendorId,
        ...(await shapeCourt(request.body, settings, null)),
        order: Math.max(0, ...courts.map((c) => c.order)) + 1,
        ...stamp(),
      };
      await db().turfCourts.insertOne(doc);
      await audit(request, ground.businessId, "turf_court.create", { type: "turf_court", id: doc._id }, { name: { from: null, to: doc.name } });
      await refreshGround(db(), ground._id);
      return reply.status(201).send(ok(request, await reread(ground._id)));
    },
  );

  app.patch(
    "/courts/:id",
    {
      preHandler: requireVendor,
      config: { rateLimit: { max: 120, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Change a court: name, sports, hours, slot length, prices, add-ons, or pause it",
        description:
          "New hours or slot length must keep every booked and blocked slot still to come; the slot that wouldn't fit comes back as a CONFLICT. " +
          "Bookings already made keep their prices. Pausing stops new bookings; existing ones stay.",
        params: IdParams,
        body: UpdateCourtBody,
        response: { 200: VendorGroundOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { court, ground } = await ownedCourt(request, request.params.id);
      const shaped = await shapeCourt({ ...courtFieldsOf(court), ...request.body } as CourtFields, await turfSettings(db()), court);
      const diff = diffOf(court as unknown as Record<string, unknown>, shaped as unknown as Record<string, unknown>);
      if (!Object.keys(diff).length) return ok(request, await view(ground));
      if (diff.hours || diff.slotMinutes) await scheduleFits(court, shaped);
      await db().turfCourts.updateOne({ _id: court._id }, { $set: { ...shaped, updatedAt: new Date() } });
      await audit(request, ground.businessId, "turf_court.update", { type: "turf_court", id: court._id }, diff);
      if (shaped.name !== court.name) {
        await db().turfBookings.updateMany({ courtId: court._id, status: { $ne: "cancelled" } }, { $set: { courtName: shaped.name } });
      }
      await refreshGround(db(), ground._id);
      return ok(request, await reread(ground._id));
    },
  );

  app.delete(
    "/courts/:id",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Remove a court",
        description: "Not while it has paid or unpaid bookings still to come: cancel them from the desk first. Its future blocks go with it.",
        params: IdParams,
        response: { 200: VendorGroundOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { court, ground } = await ownedCourt(request, request.params.id);
      const now = new Date();
      const upcoming = await db().turfBookings.countDocuments({ courtId: court._id, status: { $in: ["awaiting_payment", "confirmed"] }, lastEndsAt: { $gt: now } });
      if (upcoming) throw new AppError("CONFLICT", `This court has ${upcoming === 1 ? "a booking" : `${upcoming} bookings`} still to come. Cancel ${upcoming === 1 ? "it" : "them"} first.`);
      const used = await db().turfBookings.findOne({ courtId: court._id }, { projection: { _id: 1 } });
      if (used) await db().turfCourts.updateOne({ _id: court._id }, { $set: { status: "removed", updatedAt: now } });
      else await db().turfCourts.deleteOne({ _id: court._id });
      await db().turfSlots.deleteMany({ courtId: court._id, status: "blocked" });
      await audit(request, ground.businessId, "turf_court.delete", { type: "turf_court", id: court._id }, { name: { from: court.name, to: null } });
      await refreshGround(db(), ground._id);
      return ok(request, await reread(ground._id));
    },
  );
};

export default manage;
