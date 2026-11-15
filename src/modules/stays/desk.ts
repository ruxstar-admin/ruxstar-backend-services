import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type Filter, type WithId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, writeAudit } from "../../platform/audit.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { StayPropertyDoc, StayReservationDoc, TeamPermission } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { addDays } from "../coaching/rules.js";
import { teamAccess } from "../team/team.js";
import {
  BedOne,
  BedStatusBody,
  Board,
  BoardQuery,
  DeskPropertyList,
  DeskReservationList,
  DeskReservationOne,
  DeskReservationsQuery,
  IdParams,
  MoveOutBody,
  OwnerCancelBody,
  RoomPricesBody,
  RoomStatusBody,
  UpdatePropertyBody,
  VendorPropertyOne,
} from "./contracts.js";
import { editProperty, setRoomPrices } from "./manage.js";
import { cancelStay, endStay, freshStays, markMovedIn, overlapping, ownerCanCancel, refreshProperty, type By } from "./orders.js";
import { staysSettings, startOf, today } from "./rules.js";
import { deskReservationViews, vendorPropertyView } from "./views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const STAYS_PERMISSIONS: TeamPermission[] = ["stays.reservations", "stays.movein", "stays.beds", "stays.cancel", "stays.listing"];

interface Desk {
  property: WithId<StayPropertyDoc>;
  owner: boolean;
  permissions: TeamPermission[];
}

/** The property's desk: its owner, and verified team members with stays permissions. Bed board, reservations, tenants, moving in and out. */
const desk: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const byOf = (request: FastifyRequest): By => ({ kind: "vendor", actor: actorOf(request), ip: request.ip });

  async function access(request: FastifyRequest, propertyId: ObjectId, permission: TeamPermission): Promise<Desk> {
    const property = await db().staysProperties.findOne({ _id: propertyId });
    const business = property ? await db().businesses.findOne({ _id: property.businessId }, { projection: { ownerId: 1, suspension: 1 } }) : null;
    if (!property || !business) throw new AppError("NOT_FOUND", "Property not found.");
    if (business.ownerId.equals(request.auth!.userId)) {
      if (business.suspension) throw new AppError("BUSINESS_SUSPENDED");
      return { property, owner: true, permissions: STAYS_PERMISSIONS };
    }
    const { place } = await teamAccess(db(), request.auth!, { businessId: property.businessId }, permission);
    return { property, owner: false, permissions: place.permissions };
  }
  async function editable(request: FastifyRequest, propertyId: ObjectId, permission: TeamPermission) {
    const desk = await access(request, propertyId, permission);
    if (desk.property.status === "removed") throw new AppError("CONFLICT", "Ruxstar took this property down.");
    return desk;
  }
  async function roomAccess(request: FastifyRequest, roomId: string, permission: TeamPermission) {
    const room = await db().staysRooms.findOne({ _id: new ObjectId(roomId), status: { $ne: "removed" } });
    if (!room) throw new AppError("NOT_FOUND", "Room not found.");
    return { room, ...(await editable(request, room.propertyId, permission)) };
  }
  async function reservationAccess(request: FastifyRequest, id: string, permission: TeamPermission) {
    const r = await db().staysReservations.findOne({ _id: new ObjectId(id) });
    if (!r) throw new AppError("NOT_FOUND", "Reservation not found.");
    await access(request, r.propertyId, permission);
    return r;
  }
  const one = async (r: StayReservationDoc) => (await deskReservationViews(db(), [r]))[0]!;
  const propertyView = async (id: ObjectId) => vendorPropertyView(db(), (await db().staysProperties.findOne({ _id: id }))!, await staysSettings(db()));

  app.get(
    "/properties",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["stays"],
        summary: "Properties you run: your own, and those whose team gave you stays permissions",
        description: "Team members need to be verified to see them.",
        response: { 200: DeskPropertyList, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const [owned, places] = await Promise.all([
        db().businesses.find({ ownerId: userId, module: "stays", suspension: { $exists: false } }, { projection: { _id: 1 } }).toArray(),
        db().employments.find({ userId, status: "active", current: true, permissions: { $in: STAYS_PERMISSIONS } }, { projection: { businessId: 1, permissions: 1 } }).toArray(),
      ]);
      const held = await db().businesses.find({ _id: { $in: places.map((p) => p.businessId) }, suspension: { $exists: true } }, { projection: { _id: 1 } }).toArray();
      const team = request.auth!.kyc.base === "approved" ? places.filter((p) => !held.some((h) => h._id.equals(p.businessId))) : [];
      const properties = await db()
        .staysProperties.find({ businessId: { $in: [...owned.map((b) => b._id), ...team.map((p) => p.businessId)] }, status: { $ne: "removed" } })
        .sort({ createdAt: 1 })
        .limit(100)
        .toArray();
      const ids = properties.map((p) => p._id);
      const [rooms, beds] = await Promise.all([
        db().staysRooms.aggregate<{ _id: ObjectId; n: number }>([{ $match: { propertyId: { $in: ids }, status: { $ne: "removed" } } }, { $group: { _id: "$propertyId", n: { $sum: 1 } } }]).toArray(),
        db().staysBeds.aggregate<{ _id: ObjectId; n: number }>([{ $match: { propertyId: { $in: ids }, status: { $ne: "removed" } } }, { $group: { _id: "$propertyId", n: { $sum: 1 } } }]).toArray(),
      ]);
      return page(
        request,
        properties.map((p) => {
          const mine = owned.some((b) => b._id.equals(p.businessId));
          return {
            id: p._id.toHexString(),
            name: p.name,
            kind: p.kind,
            business: { id: p.businessId.toHexString(), name: p.businessName },
            status: p.status,
            rooms: rooms.find((c) => c._id.equals(p._id))?.n ?? 0,
            beds: beds.find((c) => c._id.equals(p._id))?.n ?? 0,
            owner: mine,
            permissions: mine ? STAYS_PERMISSIONS : (team.find((t) => t.businessId.equals(p.businessId))?.permissions.filter((x) => x.startsWith("stays.")) ?? []),
          };
        }),
        null,
      );
    },
  );

  app.get(
    "/properties/:id/board",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["stays"],
        summary: "The bed board for a day: every room's beds, free, held, reserved, occupied or marked full, with who has them",
        description: "Today in India when `date` is left out. A free bed shows its next reservation. Team members need stays.reservations.",
        params: IdParams,
        querystring: BoardQuery,
        response: { 200: Board, ...Errors },
        security,
      },
    },
    async (request) => {
      const { property } = await access(request, new ObjectId(request.params.id), "stays.reservations");
      const now = new Date();
      const date = request.query.date ?? today(now);
      const dayStart = startOf(date);
      const dayEnd = startOf(addDays(date, 1));
      const [rooms, beds] = await Promise.all([
        db().staysRooms.find({ propertyId: property._id, status: { $ne: "removed" } }).sort({ order: 1, _id: 1 }).toArray(),
        db().staysBeds.find({ propertyId: property._id, status: { $ne: "removed" } }).sort({ order: 1 }).toArray(),
      ]);
      const bedIds = beds.map((b) => b._id);
      const [current, upcoming] = await Promise.all([
        db().staysReservations.find(overlapping(bedIds, dayStart, dayEnd)).toArray(),
        db().staysReservations.find({ bedIds: { $in: bedIds }, status: { $in: ["awaiting_payment", "confirmed"] }, from: { $gte: dayEnd } }).sort({ from: 1 }).limit(500).toArray(),
      ]);
      const live = current.filter((r) => r.status !== "awaiting_payment" || !r.holdUntil || r.holdUntil > now);
      const totals = { beds: 0, free: 0, held: 0, reserved: 0, occupied: 0, closed: 0 };
      const brief = (r: StayReservationDoc) => ({ id: r._id.toHexString(), orderNo: r.orderNo, tenantName: r.customerName, status: r.status, moveIn: r.moveIn, until: r.until?.toISOString() ?? null });
      return ok(request, {
        property: { id: property._id.toHexString(), name: property.name },
        date,
        rooms: rooms.map((room) => ({
          id: room._id.toHexString(),
          name: room.name,
          kind: room.kind,
          status: room.status === "live" ? ("live" as const) : ("paused" as const),
          prices: room.prices,
          beds: beds
            .filter((b) => b.roomId.equals(room._id))
            .map((bed) => {
              const has = (r: StayReservationDoc) => r.bedIds.some((id) => id.equals(bed._id));
              const r = live.find(has) ?? null;
              const state = r
                ? r.status === "awaiting_payment"
                  ? ("held" as const)
                  : r.status === "confirmed"
                    ? ("reserved" as const)
                    : ("occupied" as const)
                : bed.status !== "open" || room.status !== "live"
                  ? ("closed" as const)
                  : ("free" as const);
              totals.beds++;
              totals[state]++;
              const next = r ? null : (upcoming.find(has) ?? null);
              return {
                id: bed._id.toHexString(),
                label: bed.label,
                status: bed.status === "closed" ? ("closed" as const) : ("open" as const),
                state,
                reservation: r ? brief(r) : null,
                next: next ? brief(next) : null,
              };
            }),
        })),
        totals,
      });
    },
  );

  app.get(
    "/properties/:id/reservations",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["stays"],
        summary: "A property's reservations: upcoming ones by move-in, staying tenants, or past and all newest first",
        description: "Team members need stays.reservations.",
        params: IdParams,
        querystring: DeskReservationsQuery,
        response: { 200: DeskReservationList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { property } = await access(request, new ObjectId(request.params.id), "stays.reservations");
      const now = new Date();
      const view = request.query.view ?? "upcoming";
      if (view === "upcoming" || view === "staying") {
        const filter: Filter<StayReservationDoc> =
          view === "upcoming" ? { propertyId: property._id, status: "confirmed" } : { propertyId: property._id, status: "moved_in", $or: [{ until: null }, { until: { $gt: now } }] };
        const docs = await db().staysReservations.find(filter).sort({ from: 1, _id: 1 }).limit(500).toArray();
        const fresh = (await freshStays(app, db(), docs)).filter((r) => r.status === (view === "upcoming" ? "confirmed" : "moved_in"));
        return page(request, await deskReservationViews(db(), fresh), null);
      }
      const filter: Filter<StayReservationDoc> =
        view === "past"
          ? { propertyId: property._id, $or: [{ status: { $in: ["moved_out", "cancelled"] } }, { status: "moved_in", until: { $ne: null, $lte: now } }] }
          : { propertyId: property._id };
      const { items, nextCursor } = await findPage(db().staysReservations, { filter, sortField: "createdAt", cursor: request.query.cursor, limit: request.query.limit });
      return page(request, await deskReservationViews(db(), await freshStays(app, db(), items)), nextCursor);
    },
  );

  app.get(
    "/properties/:id/tenants",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["stays"],
        summary: "Who lives at the property now: tenants moved in and not moved out, by room",
        description: "Each with their phone, whether they're verified, and any notice. Team members need stays.reservations.",
        params: IdParams,
        response: { 200: DeskReservationList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { property } = await access(request, new ObjectId(request.params.id), "stays.reservations");
      const now = new Date();
      const docs = await db()
        .staysReservations.find({ propertyId: property._id, status: "moved_in", $or: [{ until: null }, { until: { $gt: now } }] })
        .sort({ roomName: 1, from: 1 })
        .limit(1000)
        .toArray();
      return page(request, await deskReservationViews(db(), docs), null);
    },
  );

  app.get(
    "/orders/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["stays"],
        summary: "One reservation at your property, with the tenant's phone and whether they're verified",
        description: "Team members need stays.reservations.",
        params: IdParams,
        response: { 200: DeskReservationOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const r = await reservationAccess(request, request.params.id, "stays.reservations");
      const [fresh] = await freshStays(app, db(), [r]);
      return ok(request, await one(fresh!));
    },
  );

  app.post(
    "/orders/:id/moved-in",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["stays"],
        summary: "Mark the tenant moved in",
        description:
          "From the move-in day. The tenant then has the rules' `objectionHours` to object; your share is released once that passes with no objection. " +
          "Team members need stays.movein.",
        params: IdParams,
        response: { 200: DeskReservationOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const r = await reservationAccess(request, request.params.id, "stays.movein");
      return ok(request, await one(await markMovedIn(app, db(), r, byOf(request))));
    },
  );

  app.post(
    "/orders/:id/move-out",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["stays"],
        summary: "Mark when the tenant moves out",
        description:
          "Today when `on` is left out; a day already passed ends the stay now, a later one sets the move-out day (a notice from you). " +
          "The beds open for reservations from that day. A stay can be shortened, never lengthened. Team members need stays.movein.",
        params: IdParams,
        body: MoveOutBody,
        response: { 200: DeskReservationOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const r = await reservationAccess(request, request.params.id, "stays.movein");
      return ok(request, await one(await endStay(app, db(), r, byOf(request), { on: request.body.on, reason: request.body.reason?.trim() || undefined })));
    },
  );

  app.post(
    "/orders/:id/cancel",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["stays"],
        summary: "Cancel a reservation, refunding the tenant in full",
        description: "The platform fee comes back too, and the beds are freed. Not once the money has been released. Team members need stays.cancel.",
        params: IdParams,
        body: OwnerCancelBody,
        response: { 200: DeskReservationOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const r = await reservationAccess(request, request.params.id, "stays.cancel");
      if (r.status === "awaiting_payment") throw new AppError("ORDER_STATE", "This reservation isn't paid yet; it goes back by itself if it isn't.");
      if (!ownerCanCancel(r)) {
        throw new AppError("ORDER_STATE", r.status === "cancelled" ? "This reservation is cancelled already." : r.releasedAt ? "The money for this stay has been released. Mark the move-out instead." : "This stay has ended.");
      }
      return ok(request, await one(await cancelStay(app, db(), r, byOf(request), { reason: request.body.reason.trim() })));
    },
  );

  app.post(
    "/beds/:id/status",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["stays"],
        summary: "Mark a bed free or full",
        description: "A full bed can't be reserved; reservations already made stand. Team members need stays.beds.",
        params: IdParams,
        body: BedStatusBody,
        response: { 200: BedOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const bed = await db().staysBeds.findOne({ _id: new ObjectId(request.params.id), status: { $ne: "removed" } });
      if (!bed) throw new AppError("NOT_FOUND", "Bed not found.");
      await editable(request, bed.propertyId, "stays.beds");
      const { status } = request.body;
      if (bed.status !== status) {
        await db().staysBeds.updateOne({ _id: bed._id, status: { $ne: "removed" } }, { $set: { status, updatedAt: new Date() }, $inc: { seq: 1 } });
        await writeAudit(db(), {
          actor: actorOf(request),
          scope: { module: "stays", businessId: bed.businessId },
          action: "stay_bed.status",
          target: { type: "stay_bed", id: bed._id },
          diff: { status: { from: bed.status, to: status } },
          ip: request.ip,
        });
      }
      return ok(request, { id: bed._id.toHexString(), label: bed.label, status });
    },
  );

  app.post(
    "/rooms/:id/status",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["stays"],
        summary: "Mark a whole room free or full",
        description: "paused: shown as full and not reservable; reservations already made stand. Team members need stays.beds.",
        params: IdParams,
        body: RoomStatusBody,
        response: { 200: VendorPropertyOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { room } = await roomAccess(request, request.params.id, "stays.beds");
      const { status } = request.body;
      if (room.status !== status) {
        await db().staysRooms.updateOne({ _id: room._id }, { $set: { status, updatedAt: new Date() } });
        await writeAudit(db(), {
          actor: actorOf(request),
          scope: { module: "stays", businessId: room.businessId },
          action: "stay_room.status",
          target: { type: "stay_room", id: room._id },
          diff: { status: { from: room.status, to: status } },
          ip: request.ip,
        });
        await refreshProperty(db(), room.propertyId);
      }
      return ok(request, await propertyView(room.propertyId));
    },
  );

  app.patch(
    "/properties/:id",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["stays"],
        summary: "Edit the listing: details, food, facilities, house rules, notice, deposit, nearby places or refund days",
        description: "The same as the owner's edit. Team members need stays.listing.",
        params: IdParams,
        body: UpdatePropertyBody,
        response: { 200: VendorPropertyOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { property } = await editable(request, new ObjectId(request.params.id), "stays.listing");
      const after = await editProperty(db(), property, request.body, { actor: actorOf(request), ip: request.ip });
      return ok(request, await vendorPropertyView(db(), after, await staysSettings(db())));
    },
  );

  app.put(
    "/rooms/:id/prices",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["stays"],
        summary: "Change a room's prices per month and per night",
        description: "Reservations already made keep what they paid. Team members need stays.listing.",
        params: IdParams,
        body: RoomPricesBody,
        response: { 200: VendorPropertyOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { room } = await roomAccess(request, request.params.id, "stays.listing");
      await setRoomPrices(db(), room, request.body.prices, { actor: actorOf(request), ip: request.ip });
      return ok(request, await propertyView(room.propertyId));
    },
  );
};

export default desk;
