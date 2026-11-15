import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId, type Filter } from "mongodb";
import { Type } from "typebox";
import { Errors, PageQuery, Strict } from "../../contracts/common.js";
import { actorOf, diffOf, writeAudit } from "../../platform/audit.js";
import { requireRuxstar } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import { stamp, type TurfGroundDoc, type TurfSportDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { escapeRegex } from "../pod/shops.js";
import {
  ConsoleGroundList,
  ConsoleGroundOne,
  ConsoleSportList,
  ConsoleSportOne,
  CreateSportBody,
  IdParams,
  SportParams,
  TakeDownBody,
  TakeDownResult,
  UpdateSportBody,
} from "../turf/contracts.js";
import { takeDownGround } from "../turf/orders.js";
import { turfSettings } from "../turf/rules.js";
import { groundCards, loadSports, vendorGroundView } from "../turf/views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const Query = Strict({
  ...PageQuery,
  status: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("live"), Type.Literal("removed")])),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "Words in the ground's or business's name" })),
});
const sportView = (s: TurfSportDoc) => ({ key: s._id, name: s.name, active: s.active, order: s.order });

/** Grounds and the sports list in the console. Grounds go live without review; staff can take one down, which refunds every booking still to come. */
const turf: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  app.get(
    "/turf/grounds",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: { tags: ["ruxstar"], summary: "Every ground, newest first", querystring: Query, response: { 200: ConsoleGroundList, ...Errors }, security },
    },
    async (request) => {
      const { status, q, cursor, limit } = request.query;
      const filter: Filter<TurfGroundDoc> = {};
      if (status) filter.status = status;
      if (q?.trim()) {
        const words = { $regex: escapeRegex(q.trim()), $options: "i" };
        filter.$or = [{ name: words }, { businessName: words }];
      }
      const { items, nextCursor } = await findPage(db().turfGrounds, { filter, sortField: "createdAt", cursor, limit });
      const cards = await groundCards(db(), items);
      return page(
        request,
        items.map((g, i) => ({
          ...cards[i]!,
          status: g.status,
          vendorId: g.vendorId.toHexString(),
          removal: g.removal ? { reason: g.removal.reason, at: g.removal.at.toISOString() } : null,
          createdAt: g.createdAt.toISOString(),
        })),
        nextCursor,
      );
    },
  );

  app.get(
    "/turf/grounds/:id",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: { tags: ["ruxstar"], summary: "One ground, with its courts and booking counts", params: IdParams, response: { 200: ConsoleGroundOne, ...Errors }, security },
    },
    async (request) => {
      const ground = await db().turfGrounds.findOne({ _id: new ObjectId(request.params.id) });
      if (!ground) throw new AppError("NOT_FOUND", "Ground not found.");
      const [view, upcoming, total, cancelled] = await Promise.all([
        vendorGroundView(db(), ground, await turfSettings(db()), ground.status === "removed" ? "Ruxstar took this ground down." : "Seen from the console."),
        db().turfBookings.countDocuments({ groundId: ground._id, status: "confirmed", lastEndsAt: { $gt: new Date() } }),
        db().turfBookings.countDocuments({ groundId: ground._id, status: { $ne: "awaiting_payment" } }),
        db().turfBookings.countDocuments({ groundId: ground._id, status: "cancelled" }),
      ]);
      return ok(request, { ground: view, bookings: { upcoming, total, cancelled } });
    },
  );

  app.post(
    "/turf/grounds/:id/take-down",
    {
      preHandler: [requireRuxstar("businesses.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Take a ground down",
        description:
          "It leaves the listings, and every booking with a date still to come is cancelled: those dates are refunded in full, platform fee included, and the owner " +
          "and customers are told why. Dates already played aren't refunded automatically. It can't be undone.",
        params: IdParams,
        body: TakeDownBody,
        response: { 200: TakeDownResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const ground = await db().turfGrounds.findOne({ _id: new ObjectId(request.params.id) });
      if (!ground) throw new AppError("NOT_FOUND", "Ground not found.");
      const refunded = await takeDownGround(app, db(), ground, { kind: "staff", actor: actorOf(request), ip: request.ip }, request.body.reason.trim());
      const after = (await db().turfGrounds.findOne({ _id: ground._id }))!;
      return ok(request, { ground: await vendorGroundView(db(), after, await turfSettings(db())), refunded });
    },
  );

  app.get(
    "/turf/sports",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: { tags: ["ruxstar"], summary: "The sports list, inactive ones too, in order", response: { 200: ConsoleSportList, ...Errors }, security },
    },
    async (request) => page(request, (await loadSports(db())).map(sportView), null),
  );

  app.post(
    "/turf/sports",
    {
      preHandler: [requireRuxstar("modules.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Add a sport grounds can offer",
        description: "The key can't change later. Audited.",
        body: CreateSportBody,
        response: { 201: ConsoleSportOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const sports = await loadSports(db());
      if (sports.some((s) => s._id === request.body.key)) throw new AppError("CONFLICT", "A sport with this key is on the list already.");
      const doc: TurfSportDoc = {
        _id: request.body.key,
        name: request.body.name.trim(),
        active: true,
        order: request.body.order ?? Math.max(0, ...sports.map((s) => s.order)) + 10,
        ...stamp(),
      };
      try {
        await db().turfSports.insertOne(doc);
      } catch (err) {
        if ((err as { code?: number }).code === 11000) throw new AppError("CONFLICT", "A sport with this key is on the list already.");
        throw err;
      }
      await writeAudit(db(), {
        actor: actorOf(request),
        scope: { module: "turf" },
        action: "turf_sport.create",
        target: { type: "turf_sport", id: doc._id },
        diff: { name: { from: null, to: doc.name } },
        ip: request.ip,
      });
      return reply.status(201).send(ok(request, sportView(doc)));
    },
  );

  app.patch(
    "/turf/sports/:key",
    {
      preHandler: requireRuxstar("modules.manage"),
      schema: {
        tags: ["ruxstar"],
        summary: "Rename a sport, reorder it, or stop it being picked",
        description: "Inactive sports stay on the courts that have them. Audited.",
        params: SportParams,
        body: UpdateSportBody,
        response: { 200: ConsoleSportOne, ...Errors },
        security,
      },
    },
    async (request) => {
      await loadSports(db());
      const before = await db().turfSports.findOne({ _id: request.params.key });
      if (!before) throw new AppError("NOT_FOUND", "Sport not found.");
      const changes = { ...request.body, ...(request.body.name ? { name: request.body.name.trim() } : {}) };
      const diff = diffOf(before as unknown as Record<string, unknown>, changes as Record<string, unknown>);
      if (!Object.keys(diff).length) return ok(request, sportView(before));
      const after = await db().turfSports.findOneAndUpdate({ _id: before._id }, { $set: { ...changes, updatedAt: new Date() } }, { returnDocument: "after" });
      await writeAudit(db(), {
        actor: actorOf(request),
        scope: { module: "turf" },
        action: "turf_sport.update",
        target: { type: "turf_sport", id: before._id },
        diff,
        ip: request.ip,
      });
      return ok(request, sportView(after!));
    },
  );
};

export default turf;
