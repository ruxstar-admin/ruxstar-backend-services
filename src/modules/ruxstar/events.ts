import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId, type Filter } from "mongodb";
import { Type } from "typebox";
import { Errors, ObjectIdString, PageQuery, Strict } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireRuxstar } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { EventDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { escapeRegex } from "../pod/shops.js";
import { VendorEventList, VendorEventOne } from "../events/contracts.js";
import { vendorViews } from "../events/manage.js";
import { cancelEvent } from "../events/orders.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const Query = Strict({
  ...PageQuery,
  status: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("live"), Type.Literal("cancelled")])),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "Words in the title or the organiser's name" })),
});
const Params = Strict({ id: ObjectIdString });
const TakeDownBody = Strict({ reason: Type.String({ minLength: 5, maxLength: 300, description: "The organiser and every ticket holder see it" }) });

/** Events in the console. They go live without review; staff can take one down, which cancels it and refunds everyone. */
const events: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const views = async (docs: EventDoc[]) => {
    const live = await db()
      .businesses.find({ _id: { $in: docs.map((d) => d.businessId) }, status: "live" }, { projection: { _id: 1 } })
      .toArray();
    return vendorViews(db(), docs, (id) => live.some((b) => b._id.equals(id)));
  };

  app.get(
    "/events",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: { tags: ["ruxstar"], summary: "Every event, newest first", querystring: Query, response: { 200: VendorEventList, ...Errors }, security },
    },
    async (request) => {
      const { status, q, cursor, limit } = request.query;
      const filter: Filter<EventDoc> = {};
      if (status) filter.status = status;
      if (q?.trim()) {
        const words = { $regex: escapeRegex(q.trim()), $options: "i" };
        filter.$or = [{ title: words }, { businessName: words }];
      }
      const { items, nextCursor } = await findPage(db().events, { filter, sortField: "createdAt", cursor, limit });
      return page(request, await views(items), nextCursor);
    },
  );

  app.get(
    "/events/:id",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: { tags: ["ruxstar"], summary: "One event, with its sales", params: Params, response: { 200: VendorEventOne, ...Errors }, security },
    },
    async (request) => {
      const doc = await db().events.findOne({ _id: new ObjectId(request.params.id) });
      if (!doc) throw new AppError("NOT_FOUND", "Event not found.");
      return ok(request, (await views([doc]))[0]!);
    },
  );

  app.post(
    "/events/:id/take-down",
    {
      preHandler: [requireRuxstar("businesses.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Take an event down",
        description: "Cancels it: every booking is refunded in full and every ticket holder and the organiser are told why. It can't be undone.",
        params: Params,
        body: TakeDownBody,
        response: { 200: VendorEventOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const doc = await db().events.findOne({ _id: new ObjectId(request.params.id) });
      if (!doc) throw new AppError("NOT_FOUND", "Event not found.");
      await cancelEvent(app, db(), doc, { kind: "staff", actor: actorOf(request), ip: request.ip }, request.body.reason.trim());
      return ok(request, (await views([(await db().events.findOne({ _id: doc._id }))!]))[0]!);
    },
  );
};

export default events;
