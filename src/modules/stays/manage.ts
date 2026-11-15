import { randomUUID } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type WithId } from "mongodb";
import type { Static } from "typebox";
import { Errors } from "../../contracts/common.js";
import { actorOf, diffOf, writeAudit } from "../../platform/audit.js";
import { requireDatabase } from "../../platform/context.js";
import { stamp, type AuditLogDoc, type BusinessDoc, type BusinessPhoto, type Database, type StayKind, type StayPropertyDoc, type StayRoomDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { isModuleLive } from "../../platform/module-switch.js";
import { Done } from "../social/contracts.js";
import { toPostPhoto } from "../social/photos.js";
import { ownedBy, photoKeys, requireVendor } from "../vendor/businesses.js";
import { CreatePropertyBody, IdParams, PhotoParams, RoomBody, UpdatePropertyBody, UpdateRoomBody, VendorPropertyList, VendorPropertyOne } from "./contracts.js";
import { refreshProperty, setBeds } from "./orders.js";
import { MAX_PHOTOS, staysSettings, type StaysSettings } from "./rules.js";
import { loadFacilities, missingOf, vendorPropertyView } from "./views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const invalid = (path: string, message: string) => new AppError("VALIDATION_FAILED", message, [{ path, message }]);

type PropertyFields = Static<typeof CreatePropertyBody>;
type RoomFields = Static<typeof RoomBody>;

const KINDS: Record<string, StayKind> = { pg: "pg", hostel: "hostel", coliving: "coliving" };
const NO_RULES: StayPropertyDoc["rules"] = { curfew: null, guests: false, smoking: false, alcohol: false, pets: false, notes: null };
const DEFAULT_NOTICE_DAYS = 30;

const propertyFieldsOf = (doc: StayPropertyDoc): PropertyFields => ({
  name: doc.name,
  kind: doc.kind,
  description: doc.description,
  address: doc.address,
  for: doc.for,
  occupants: doc.occupants,
  food: doc.food,
  facilities: doc.facilities,
  rules: doc.rules,
  noticeDays: doc.noticeDays,
  deposit: doc.deposit,
  nearby: doc.nearby,
  refundDays: doc.refundDays,
});

/** Checks a property's details against Ruxstar's rules and the facilities list. */
export async function shapeProperty(db: Database, body: PropertyFields, rules: StaysSettings, before: StayPropertyDoc | null, businessType: string | undefined) {
  const facilities = await loadFacilities(db);
  (body.facilities ?? []).forEach((key, i) => {
    const facility = facilities.find((f) => f._id === key);
    if (!facility || (!facility.active && !before?.facilities.includes(key))) throw invalid(`body/facilities/${i}`, "Pick facilities from the list.");
  });
  const max = Math.max(rules.maxRefundDays, rules.refundDays);
  const refundDays = body.refundDays ?? before?.refundDays ?? rules.refundDays;
  if (body.refundDays !== undefined && (refundDays < rules.refundDays || refundDays > max)) {
    throw invalid("body/refundDays", `Pick between ${rules.refundDays} and ${max} days. Customers get a full refund until then.`);
  }
  const food = body.food ?? before?.food ?? { type: "none" as const, meals: [] };
  if (food.type === "none" && food.meals.length) throw invalid("body/food/meals", "Leave meals out when no food is served.");
  const address = {
    line: body.address.line.trim(),
    area: body.address.area?.trim() || null,
    city: body.address.city.trim(),
    pincode: body.address.pincode ?? null,
    point: body.address.point ?? null,
  };
  const names = new Set<string>();
  const nearby = (body.nearby ?? []).map((n, i) => {
    const name = n.name.trim();
    if (names.has(name.toLowerCase())) throw invalid(`body/nearby/${i}/name`, "This place is listed twice.");
    names.add(name.toLowerCase());
    return { kind: n.kind, name, km: Math.round(n.km * 10) / 10 };
  });
  const rulesIn = body.rules ?? before?.rules ?? NO_RULES;
  return {
    name: body.name.trim(),
    kind: body.kind ?? before?.kind ?? KINDS[businessType ?? ""] ?? "pg",
    description: body.description?.trim() || null,
    address,
    city: address.city.toLowerCase(),
    area: address.area?.toLowerCase() ?? null,
    for: body.for,
    occupants: body.occupants ?? [],
    food: { type: food.type, meals: food.type === "none" ? [] : food.meals },
    facilities: body.facilities ?? [],
    rules: { ...rulesIn, notes: rulesIn.notes?.trim() || null },
    noticeDays: body.noticeDays ?? before?.noticeDays ?? DEFAULT_NOTICE_DAYS,
    deposit: { amount: body.deposit?.amount ?? 0, note: body.deposit?.note?.trim() || null },
    nearby,
    refundDays,
  } satisfies Partial<StayPropertyDoc>;
}

/** Changes a property's details, from the owner's setup or the desk. New refund days and notice apply to reservations made from now. */
export async function editProperty(
  db: Database,
  before: WithId<StayPropertyDoc>,
  body: Partial<PropertyFields>,
  who: { actor: AuditLogDoc["actor"]; ip: string },
): Promise<WithId<StayPropertyDoc>> {
  const business = await db.businesses.findOne({ _id: before.businessId }, { projection: { type: 1 } });
  const shaped = await shapeProperty(db, { ...propertyFieldsOf(before), ...body } as PropertyFields, await staysSettings(db), before, business?.type);
  const diff = diffOf(before as unknown as Record<string, unknown>, shaped as unknown as Record<string, unknown>);
  if (!Object.keys(diff).length) return before;
  const after = await db.staysProperties.findOneAndUpdate({ _id: before._id }, { $set: { ...shaped, updatedAt: new Date() } }, { returnDocument: "after" });
  await writeAudit(db, {
    actor: who.actor,
    scope: { module: "stays", businessId: before.businessId },
    action: "stay_property.update",
    target: { type: "stay_property", id: before._id },
    diff,
    ip: who.ip,
  });
  if (after!.name !== before.name) {
    await db.staysReservations.updateMany({ propertyId: before._id, status: { $ne: "cancelled" } }, { $set: { propertyName: after!.name } });
  }
  return after!;
}

function roomProblem(body: RoomFields, rules: StaysSettings): { path: string; message: string } | null {
  if (body.prices.month === null && body.prices.night === null) return { path: "body/prices", message: "Give a price per month, per night, or both." };
  if (body.beds > rules.maxBeds) return { path: "body/beds", message: `A room can have up to ${rules.maxBeds} beds.` };
  return null;
}

const roomFieldsOf = (doc: StayRoomDoc): RoomFields => ({
  name: doc.name,
  kind: doc.kind,
  beds: doc.beds,
  wholeRoom: doc.wholeRoom,
  prices: doc.prices,
  features: doc.features,
  status: doc.status === "live" ? "live" : "paused",
});

const shapeRoom = (body: RoomFields, before: StayRoomDoc | null) => ({
  name: body.name.trim(),
  kind: body.kind,
  beds: body.beds,
  wholeRoom: body.kind === "private" ? true : (body.wholeRoom ?? before?.wholeRoom ?? true),
  prices: body.prices,
  features: body.features ?? before?.features ?? [],
  status: body.status ?? (before?.status === "paused" ? ("paused" as const) : ("live" as const)),
});

/** Changes a room's prices, from the owner's setup or the desk. Reservations made keep theirs. */
export async function setRoomPrices(db: Database, room: WithId<StayRoomDoc>, prices: StayRoomDoc["prices"], who: { actor: AuditLogDoc["actor"]; ip: string }) {
  if (prices.month === null && prices.night === null) throw invalid("body/prices", "Give a price per month, per night, or both.");
  const diff = diffOf({ prices: room.prices }, { prices });
  if (!Object.keys(diff).length) return;
  await db.staysRooms.updateOne({ _id: room._id }, { $set: { prices, updatedAt: new Date() } });
  await writeAudit(db, { actor: who.actor, scope: { module: "stays", businessId: room.businessId }, action: "stay_room.prices", target: { type: "stay_room", id: room._id }, diff, ip: who.ip });
  await refreshProperty(db, room.propertyId);
}

/** A stays business's properties, rooms and beds. Only the owner sets them up; the desk can also edit the listing and prices. */
const manage: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  async function business(request: FastifyRequest, id: string | ObjectId): Promise<WithId<BusinessDoc>> {
    const doc = await db().businesses.findOne(ownedBy(new ObjectId(id), request.auth!.userId));
    if (!doc) throw new AppError("NOT_FOUND", "Business not found.");
    if (doc.module !== "stays") throw new AppError("CONFLICT", "Properties are for PG, hostel and co-living businesses.");
    return doc;
  }
  async function owned(request: FastifyRequest, id: string | ObjectId, { editing = true } = {}) {
    const doc = await db().staysProperties.findOne({ _id: new ObjectId(id), vendorId: request.auth!.userId });
    if (!doc) throw new AppError("NOT_FOUND", "Property not found.");
    if (editing) {
      const shop = await db().businesses.findOne({ _id: doc.businessId }, { projection: { suspension: 1 } });
      if (shop?.suspension) throw new AppError("BUSINESS_SUSPENDED");
      if (doc.status === "removed") throw new AppError("CONFLICT", "Ruxstar took this property down.");
    }
    return doc;
  }
  async function ownedRoom(request: FastifyRequest, id: string) {
    const room = await db().staysRooms.findOne({ _id: new ObjectId(id), vendorId: request.auth!.userId, status: { $ne: "removed" } });
    if (!room) throw new AppError("NOT_FOUND", "Room not found.");
    return { room, property: await owned(request, room.propertyId) };
  }
  const view = async (p: WithId<StayPropertyDoc>) => vendorPropertyView(db(), p, await staysSettings(db()));
  const reread = async (id: ObjectId) => view((await db().staysProperties.findOne({ _id: id }))!);
  const audit = (request: FastifyRequest, businessId: ObjectId, action: string, target: { type: string; id: ObjectId }, diff: Record<string, { from: unknown; to: unknown }>) =>
    writeAudit(db(), { actor: actorOf(request), scope: { module: "stays", businessId }, action, target, diff, ip: request.ip });

  app.get(
    "/businesses/:id/properties",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "A stays business's properties, oldest first, with their rooms",
        params: IdParams,
        response: { 200: VendorPropertyList, ...Errors },
        security,
      },
    },
    async (request) => {
      const shop = await business(request, request.params.id);
      const docs = await db().staysProperties.find({ businessId: shop._id }).sort({ createdAt: 1 }).limit(100).toArray();
      const settings = await staysSettings(db());
      return page(request, await Promise.all(docs.map((p) => vendorPropertyView(db(), p, settings))), null);
    },
  );

  app.post(
    "/businesses/:id/properties",
    {
      preHandler: [requireVendor, idempotent],
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Make a PG, hostel or co-living property as a draft",
        description:
          "Add photos and rooms next, then publish it. `kind` defaults to the business's type. Facilities come from GET /v1/stays/facilities. " +
          "Refund days default to Ruxstar's and can only be more (stricter), up to GET /v1/stays/rules' `maxRefundDays`. The deposit is only shown; it's paid to you directly.",
        params: IdParams,
        body: CreatePropertyBody,
        response: { 201: VendorPropertyOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const shop = await business(request, request.params.id);
      if (shop.suspension) throw new AppError("BUSINESS_SUSPENDED");
      if (!(await isModuleLive(db(), "stays"))) throw new AppError("MODULE_OFF");
      const settings = await staysSettings(db());
      if ((await db().staysProperties.countDocuments({ businessId: shop._id, status: { $ne: "removed" } })) >= settings.maxProperties) {
        throw new AppError("CONFLICT", `A business can have up to ${settings.maxProperties} properties.`);
      }
      const doc: StayPropertyDoc = {
        _id: new ObjectId(),
        businessId: shop._id,
        vendorId: shop.ownerId,
        businessName: shop.name,
        ...(await shapeProperty(db(), request.body, settings, null, shop.type)),
        photos: [],
        units: [],
        roomKinds: [],
        priceFrom: { month: null, night: null },
        status: "draft",
        publishedAt: null,
        removal: null,
        ...stamp(),
      };
      await db().staysProperties.insertOne(doc);
      await audit(request, shop._id, "stay_property.create", { type: "stay_property", id: doc._id }, { name: { from: null, to: doc.name } });
      return reply.status(201).send(ok(request, await view(doc)));
    },
  );

  app.get(
    "/properties/:id",
    {
      preHandler: requireVendor,
      schema: { tags: ["vendor"], summary: "One of your properties, with its rooms and what it needs to publish", params: IdParams, response: { 200: VendorPropertyOne, ...Errors }, security },
    },
    async (request) => ok(request, await view(await owned(request, request.params.id, { editing: false }))),
  );

  app.patch(
    "/properties/:id",
    {
      preHandler: requireVendor,
      config: { rateLimit: { max: 60, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Change a property's details, food, facilities, house rules, notice, deposit, nearby places or refund days",
        description: "New refund days and notice apply to reservations made from now; earlier ones keep theirs.",
        params: IdParams,
        body: UpdatePropertyBody,
        response: { 200: VendorPropertyOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const before = await owned(request, request.params.id);
      return ok(request, await view(await editProperty(db(), before, request.body, { actor: actorOf(request), ip: request.ip })));
    },
  );

  app.post(
    "/properties/:id/photos",
    {
      preHandler: requireVendor,
      config: { rateLimit: { max: 60, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Add a photo to the property",
        description: `Send the image itself with Content-Type image/jpeg, image/png or image/webp, up to 8 MB. Up to ${MAX_PHOTOS}; the first is the cover.`,
        consumes: ["image/jpeg", "image/png", "image/webp"],
        params: IdParams,
        response: { 200: VendorPropertyOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const property = await owned(request, request.params.id);
      if (property.photos.length >= MAX_PHOTOS) throw new AppError("CONFLICT", `A property has up to ${MAX_PHOTOS} photos. Remove one first.`);
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw new AppError("PHOTO_INVALID");
      const { full, smaller } = await toPostPhoto(request.body);
      const id = randomUUID();
      const base = `stays-media/${app.config.env}/${property._id.toHexString()}/${id}`;
      const save = async (file: typeof full, suffix: string) => {
        const key = `${base}${suffix}.webp`;
        return { key, url: await app.media.save(key, file.data), width: file.width, height: file.height };
      };
      const [saved, ...copies] = await Promise.all([save(full, ""), ...smaller.map((file) => save(file, `-${file.width}w`))]);
      const photo: BusinessPhoto = { id, ...saved!, smaller: copies };
      const after = await db().staysProperties.findOneAndUpdate(
        { _id: property._id, [`photos.${MAX_PHOTOS - 1}`]: { $exists: false } },
        { $push: { photos: photo }, $set: { updatedAt: new Date() } },
        { returnDocument: "after" },
      );
      if (!after) {
        await Promise.all(photoKeys(photo).map((key) => app.media.remove(key)));
        throw new AppError("CONFLICT", `A property has up to ${MAX_PHOTOS} photos. Remove one first.`);
      }
      return ok(request, await view(after));
    },
  );

  app.delete(
    "/properties/:id/photos/:photoId",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Remove a photo from the property",
        description: "A published property keeps at least one.",
        params: PhotoParams,
        response: { 200: VendorPropertyOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const property = await owned(request, request.params.id);
      const photo = property.photos.find((p) => p.id === request.params.photoId);
      if (!photo) throw new AppError("NOT_FOUND", "Photo not found.");
      if (property.status === "live" && property.photos.length === 1) throw new AppError("CONFLICT", "A published property needs a photo. Add another first.");
      const after = await db().staysProperties.findOneAndUpdate({ _id: property._id }, { $pull: { photos: { id: photo.id } }, $set: { updatedAt: new Date() } }, { returnDocument: "after" });
      await Promise.all(photoKeys(photo).map((key) => app.media.remove(key)));
      return ok(request, await view(after!));
    },
  );

  app.post(
    "/properties/:id/publish",
    {
      preHandler: [requireVendor, idempotent],
      schema: {
        tags: ["vendor"],
        summary: "Put a draft property up for reservations",
        description: "Needs the business published, a photo, and a room open for reservations. Everything missing comes back at once. Ruxstar doesn't check listings first; it can take one down.",
        params: IdParams,
        response: { 200: VendorPropertyOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const property = await owned(request, request.params.id);
      if (property.status !== "draft") throw new AppError("CONFLICT", "This property is published already.");
      const shop = await db().businesses.findOne({ _id: property.businessId });
      const rooms = await db().staysRooms.find({ propertyId: property._id, status: { $ne: "removed" } }).toArray();
      const missing = missingOf(property, rooms, shop?.status === "live");
      if (missing.length) throw new AppError("BUSINESS_INCOMPLETE", missing.join(". "), missing.map((message) => ({ path: "body", message })));
      if (!(await isModuleLive(db(), "stays"))) throw new AppError("MODULE_OFF");
      const now = new Date();
      const after = await db().staysProperties.findOneAndUpdate(
        { _id: property._id, status: "draft" },
        { $set: { status: "live", publishedAt: now, businessName: shop!.name, updatedAt: now } },
        { returnDocument: "after" },
      );
      if (!after) throw new AppError("CONFLICT");
      await audit(request, property.businessId, "stay_property.publish", { type: "stay_property", id: property._id }, { status: { from: "draft", to: "live" } });
      return ok(request, await view(after));
    },
  );

  app.delete(
    "/properties/:id",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Delete a draft property, with its rooms, beds and photos",
        description: "Published properties stay; pause their rooms instead.",
        params: IdParams,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const property = await owned(request, request.params.id, { editing: false });
      if (property.status !== "draft") throw new AppError("CONFLICT", "Only drafts can be deleted. Pause its rooms instead.");
      if (await db().staysReservations.findOne({ propertyId: property._id }, { projection: { _id: 1 } })) throw new AppError("CONFLICT", "This property has had reservations, so it stays.");
      const res = await db().staysProperties.deleteOne({ _id: property._id, status: "draft" });
      if (!res.deletedCount) throw new AppError("CONFLICT");
      await Promise.all([db().staysRooms.deleteMany({ propertyId: property._id }), db().staysBeds.deleteMany({ propertyId: property._id })]);
      await Promise.all(property.photos.flatMap(photoKeys).map((key) => app.media.remove(key)));
      await audit(request, property.businessId, "stay_property.delete", { type: "stay_property", id: property._id }, { name: { from: property.name, to: null } });
      return ok(request, { done: true as const });
    },
  );

  // Rooms.

  app.post(
    "/properties/:id/rooms",
    {
      preHandler: [requireVendor, idempotent],
      config: { rateLimit: { max: 120, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Add a room to the property, with its beds",
        description:
          "A shared room is priced per bed; customers reserve a bed, or every bed together when `wholeRoom`. A private room is priced and reserved whole. " +
          "Beds are labelled A, B, C… Give a price per month (PG, co-living), per night (hostel), or both.",
        params: IdParams,
        body: RoomBody,
        response: { 201: VendorPropertyOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const property = await owned(request, request.params.id);
      const settings = await staysSettings(db());
      const problem = roomProblem(request.body, settings);
      if (problem) throw invalid(problem.path, problem.message);
      const rooms = await db().staysRooms.find({ propertyId: property._id, status: { $ne: "removed" } }, { projection: { order: 1 } }).toArray();
      if (rooms.length >= settings.maxRooms) throw new AppError("CONFLICT", `A property can have up to ${settings.maxRooms} rooms.`);
      const doc: StayRoomDoc = {
        _id: new ObjectId(),
        propertyId: property._id,
        businessId: property.businessId,
        vendorId: property.vendorId,
        ...shapeRoom(request.body, null),
        order: Math.max(0, ...rooms.map((r) => r.order)) + 1,
        ...stamp(),
      };
      await db().staysRooms.insertOne(doc);
      await setBeds(db(), doc, doc.beds);
      await audit(request, property.businessId, "stay_room.create", { type: "stay_room", id: doc._id }, { name: { from: null, to: doc.name }, beds: { from: 0, to: doc.beds } });
      await refreshProperty(db(), property._id);
      return reply.status(201).send(ok(request, await reread(property._id)));
    },
  );

  app.patch(
    "/rooms/:id",
    {
      preHandler: requireVendor,
      config: { rateLimit: { max: 120, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Change a room: name, kind, beds, prices, features, or pause it",
        description:
          "Fewer beds only if the beds dropped (from the end) aren't reserved now or later. A room with reservations to come can't change between private and shared. " +
          "Reservations made keep their prices. Pausing marks it full: no new reservations, existing ones stay.",
        params: IdParams,
        body: UpdateRoomBody,
        response: { 200: VendorPropertyOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { room, property } = await ownedRoom(request, request.params.id);
      const body = { ...roomFieldsOf(room), ...request.body } as RoomFields;
      const problem = roomProblem(body, await staysSettings(db()));
      if (problem) throw invalid(problem.path, problem.message);
      const shaped = shapeRoom(body, room);
      const diff = diffOf(room as unknown as Record<string, unknown>, shaped as unknown as Record<string, unknown>);
      if (!Object.keys(diff).length) return ok(request, await view(property));
      if (diff.kind) {
        const now = new Date();
        const ahead = await db().staysReservations.findOne(
          { roomId: room._id, status: { $in: ["awaiting_payment", "confirmed", "moved_in"] }, $or: [{ until: null }, { until: { $gt: now } }] },
          { projection: { _id: 1 } },
        );
        if (ahead) throw new AppError("CONFLICT", "This room has reservations to come, so it can't change between private and shared.");
      }
      if (diff.beds) await setBeds(db(), room, shaped.beds);
      await db().staysRooms.updateOne({ _id: room._id }, { $set: { ...shaped, updatedAt: new Date() } });
      await audit(request, property.businessId, "stay_room.update", { type: "stay_room", id: room._id }, diff);
      if (shaped.name !== room.name) {
        await db().staysReservations.updateMany({ roomId: room._id, status: { $ne: "cancelled" } }, { $set: { roomName: shaped.name } });
      }
      await refreshProperty(db(), property._id);
      return ok(request, await reread(property._id));
    },
  );

  app.delete(
    "/rooms/:id",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Remove a room",
        description: "Not while it has reservations not cancelled or ended: cancel them or mark the move-out from the desk first.",
        params: IdParams,
        response: { 200: VendorPropertyOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { room, property } = await ownedRoom(request, request.params.id);
      const now = new Date();
      const ahead = await db().staysReservations.countDocuments({
        roomId: room._id,
        status: { $in: ["awaiting_payment", "confirmed", "moved_in"] },
        $or: [{ until: null }, { until: { $gt: now } }],
      });
      if (ahead) throw new AppError("CONFLICT", `This room has ${ahead === 1 ? "a reservation" : `${ahead} reservations`} still on. Cancel or end ${ahead === 1 ? "it" : "them"} first.`);
      const used = await db().staysReservations.findOne({ roomId: room._id }, { projection: { _id: 1 } });
      if (used) {
        await db().staysRooms.updateOne({ _id: room._id }, { $set: { status: "removed", updatedAt: now } });
        await db().staysBeds.updateMany({ roomId: room._id }, { $set: { status: "removed", updatedAt: now }, $inc: { seq: 1 } });
      } else {
        await db().staysRooms.deleteOne({ _id: room._id });
        await db().staysBeds.deleteMany({ roomId: room._id });
      }
      await audit(request, property.businessId, "stay_room.delete", { type: "stay_room", id: room._id }, { name: { from: room.name, to: null } });
      await refreshProperty(db(), property._id);
      return ok(request, await reread(property._id));
    },
  );
};

export default manage;
