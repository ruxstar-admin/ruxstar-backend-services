import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId, type Filter } from "mongodb";
import { Type } from "typebox";
import { Errors, Strict } from "../../contracts/common.js";
import { actorOf, diffOf, writeAudit } from "../../platform/audit.js";
import { requireRuxstar } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import { stamp, type StayFacilityDoc, type StayPropertyDoc, type StayReservationDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { escapeRegex } from "../pod/shops.js";
import {
  ConsoleFacilityList,
  ConsoleFacilityOne,
  ConsolePropertiesQuery,
  ConsolePropertyList,
  ConsolePropertyOne,
  ConsoleReservationList,
  ConsoleReservationOne,
  CreateFacilityBody,
  DecideObjectionBody,
  FacilityParams,
  IdParams,
  ObjectionsQuery,
  TakeDownBody,
  TakeDownResult,
  UpdateFacilityBody,
} from "../stays/contracts.js";
import { decideObjection, freshStays, takeDownProperty } from "../stays/orders.js";
import { staysSettings } from "../stays/rules.js";
import { consoleReservationViews, loadFacilities, propertyCards, vendorPropertyView } from "../stays/views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const Query = Strict({
  ...ConsolePropertiesQuery.properties,
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "Words in the property's or business's name" })),
});
const facilityView = (f: StayFacilityDoc) => ({ key: f._id, name: f.name, active: f.active, order: f.order });

/** PGs and hostels in the console: properties, take-downs, the facilities list and tenants' objections. Properties go live without review. */
const stays: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  const consoleViews = (list: StayReservationDoc[]) => consoleReservationViews(db(), list);

  app.get(
    "/stays/properties",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: { tags: ["ruxstar"], summary: "Every PG, hostel and co-living property, newest first", querystring: Query, response: { 200: ConsolePropertyList, ...Errors }, security },
    },
    async (request) => {
      const { status, city, q, cursor, limit } = request.query;
      const filter: Filter<StayPropertyDoc> = {};
      if (status) filter.status = status;
      if (city) filter.city = city.trim().toLowerCase();
      if (q?.trim()) {
        const words = { $regex: escapeRegex(q.trim()), $options: "i" };
        filter.$or = [{ name: words }, { businessName: words }];
      }
      const { items, nextCursor } = await findPage(db().staysProperties, { filter, sortField: "createdAt", cursor, limit });
      const cards = await propertyCards(db(), items);
      return page(
        request,
        items.map((p, i) => ({
          ...cards[i]!,
          status: p.status,
          vendorId: p.vendorId.toHexString(),
          removal: p.removal ? { reason: p.removal.reason, at: p.removal.at.toISOString() } : null,
          createdAt: p.createdAt.toISOString(),
        })),
        nextCursor,
      );
    },
  );

  app.get(
    "/stays/properties/:id",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: { tags: ["ruxstar"], summary: "One property, with its rooms and reservation counts", params: IdParams, response: { 200: ConsolePropertyOne, ...Errors }, security },
    },
    async (request) => {
      const property = await db().staysProperties.findOne({ _id: new ObjectId(request.params.id) });
      if (!property) throw new AppError("NOT_FOUND", "Property not found.");
      const now = new Date();
      const [view, upcoming, staying, total, cancelled, objections] = await Promise.all([
        vendorPropertyView(db(), property, await staysSettings(db()), property.status === "removed" ? "Ruxstar took this property down." : "Seen from the console."),
        db().staysReservations.countDocuments({ propertyId: property._id, status: "confirmed" }),
        db().staysReservations.countDocuments({ propertyId: property._id, status: "moved_in", $or: [{ until: null }, { until: { $gt: now } }] }),
        db().staysReservations.countDocuments({ propertyId: property._id, status: { $ne: "awaiting_payment" } }),
        db().staysReservations.countDocuments({ propertyId: property._id, status: "cancelled" }),
        db().staysReservations.countDocuments({ propertyId: property._id, "objection.status": "open" }),
      ]);
      return ok(request, { property: view, reservations: { upcoming, staying, total, cancelled, objections } });
    },
  );

  app.post(
    "/stays/properties/:id/take-down",
    {
      preHandler: [requireRuxstar("businesses.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Take a property down",
        description:
          "It leaves the listings, and every reservation not moved in yet is cancelled and refunded in full, platform fee included; the owner and tenants are told why. " +
          "Tenants who moved in stay as they are. It can't be undone.",
        params: IdParams,
        body: TakeDownBody,
        response: { 200: TakeDownResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const property = await db().staysProperties.findOne({ _id: new ObjectId(request.params.id) });
      if (!property) throw new AppError("NOT_FOUND", "Property not found.");
      const refunded = await takeDownProperty(app, db(), property, { kind: "staff", actor: actorOf(request), ip: request.ip }, request.body.reason.trim());
      const after = (await db().staysProperties.findOne({ _id: property._id }))!;
      return ok(request, { property: await vendorPropertyView(db(), after, await staysSettings(db())), refunded });
    },
  );

  app.get(
    "/stays/objections",
    {
      preHandler: requireRuxstar("orders.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "Tenants' objections after \"Moved in\", newest first",
        description: "Open ones hold the owner's money until decided.",
        querystring: ObjectionsQuery,
        response: { 200: ConsoleReservationList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { items, nextCursor } = await findPage(db().staysReservations, {
        filter: { "objection.status": request.query.status ?? "open" },
        sortField: "updatedAt",
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      return page(request, await consoleViews(items), nextCursor);
    },
  );

  app.post(
    "/stays/reservations/:id/objection",
    {
      preHandler: [requireRuxstar("orders.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Decide a tenant's objection",
        description: "release: the owner is paid now. refund: the tenant gets everything back, platform fee included, and the stay ends. Both sides are told. Audited.",
        params: IdParams,
        body: DecideObjectionBody,
        response: { 200: ConsoleReservationOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const r = await db().staysReservations.findOne({ _id: new ObjectId(request.params.id) });
      if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
      const done = await decideObjection(app, db(), r, { kind: "staff", actor: actorOf(request), ip: request.ip }, request.body.decision, request.body.note.trim());
      const [fresh] = await freshStays(app, db(), [done]);
      return ok(request, (await consoleViews([fresh!]))[0]!);
    },
  );

  app.get(
    "/stays/facilities",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: { tags: ["ruxstar"], summary: "The facilities list, inactive ones too, in order", response: { 200: ConsoleFacilityList, ...Errors }, security },
    },
    async (request) => page(request, (await loadFacilities(db())).map(facilityView), null),
  );

  app.post(
    "/stays/facilities",
    {
      preHandler: [requireRuxstar("modules.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Add a facility properties can list",
        description: "The key can't change later. Audited.",
        body: CreateFacilityBody,
        response: { 201: ConsoleFacilityOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const facilities = await loadFacilities(db());
      if (facilities.some((f) => f._id === request.body.key)) throw new AppError("CONFLICT", "A facility with this key is on the list already.");
      const doc: StayFacilityDoc = {
        _id: request.body.key,
        name: request.body.name.trim(),
        active: true,
        order: request.body.order ?? Math.max(0, ...facilities.map((f) => f.order)) + 10,
        ...stamp(),
      };
      try {
        await db().staysFacilities.insertOne(doc);
      } catch (err) {
        if ((err as { code?: number }).code === 11000) throw new AppError("CONFLICT", "A facility with this key is on the list already.");
        throw err;
      }
      await writeAudit(db(), {
        actor: actorOf(request),
        scope: { module: "stays" },
        action: "stay_facility.create",
        target: { type: "stay_facility", id: doc._id },
        diff: { name: { from: null, to: doc.name } },
        ip: request.ip,
      });
      return reply.status(201).send(ok(request, facilityView(doc)));
    },
  );

  app.patch(
    "/stays/facilities/:key",
    {
      preHandler: requireRuxstar("modules.manage"),
      schema: {
        tags: ["ruxstar"],
        summary: "Rename a facility, reorder it, or stop it being picked",
        description: "Inactive facilities stay on the properties that have them. Audited.",
        params: FacilityParams,
        body: UpdateFacilityBody,
        response: { 200: ConsoleFacilityOne, ...Errors },
        security,
      },
    },
    async (request) => {
      await loadFacilities(db());
      const before = await db().staysFacilities.findOne({ _id: request.params.key });
      if (!before) throw new AppError("NOT_FOUND", "Facility not found.");
      const changes = { ...request.body, ...(request.body.name ? { name: request.body.name.trim() } : {}) };
      const diff = diffOf(before as unknown as Record<string, unknown>, changes as Record<string, unknown>);
      if (!Object.keys(diff).length) return ok(request, facilityView(before));
      const after = await db().staysFacilities.findOneAndUpdate({ _id: before._id }, { $set: { ...changes, updatedAt: new Date() } }, { returnDocument: "after" });
      await writeAudit(db(), {
        actor: actorOf(request),
        scope: { module: "stays" },
        action: "stay_facility.update",
        target: { type: "stay_facility", id: before._id },
        diff,
        ip: request.ip,
      });
      return ok(request, facilityView(after!));
    },
  );
};

export default stays;
