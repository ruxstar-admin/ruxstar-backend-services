import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type Filter, type WithId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, writeAudit } from "../../platform/audit.js";
import { requireRuxstar } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { BusinessDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { notifyBusinessHold } from "../notifications/notify.js";
import { businessView, gstinModules, liveModules, payoutMethodView } from "../vendor/businesses.js";
import { BusinessParams } from "../vendor/contracts.js";
import { BusinessCaseOne, BusinessesQuery, BusinessRows, SuspendBody, type BusinessCase, type BusinessRow } from "./contracts.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const OWNER_PROJECTION = { name: 1, username: 1, phone: 1, avatar: 1, status: 1 } as const;

function matching(q: string | undefined): Filter<BusinessDoc> {
  const term = q?.trim() ?? "";
  if (!term) return {};
  if (/^[0-9a-f]{24}$/i.test(term)) return { $or: [{ _id: new ObjectId(term.toLowerCase()) }, { ownerId: new ObjectId(term.toLowerCase()) }] };
  return { name: { $regex: `(^|\\s)${escape(term)}`, $options: "i" } };
}

const stateFilter = (state: "draft" | "live" | "suspended" | undefined): Filter<BusinessDoc> =>
  state === "suspended" ? { suspension: { $exists: true } } : state ? { status: state, suspension: { $exists: false } } : {};

/** Every vendor's businesses, for the Ruxstar team. Holding one hides it from customers and stops its vendor changing it. */
const businesses: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  async function rows(docs: WithId<BusinessDoc>[]): Promise<BusinessRow[]> {
    const [owners, live, gstin] = await Promise.all([
      db().users.find({ _id: { $in: docs.map((d) => d.ownerId) } }, { projection: OWNER_PROJECTION }).toArray(),
      liveModules(db()),
      gstinModules(db()),
    ]);
    const byId = new Map(owners.map((u) => [u._id.toHexString(), u]));
    return docs.map((doc) => {
      const owner = byId.get(doc.ownerId.toHexString());
      return {
        business: businessView(doc, live.has(doc.module), gstin.has(doc.module)),
        owner: owner
          ? {
              id: owner._id.toHexString(),
              name: owner.name ?? "",
              username: owner.username ?? "",
              phone: owner.phone,
              avatarUrl: owner.avatar ?? null,
              status: owner.status,
            }
          : null,
      };
    });
  }

  async function detail(doc: WithId<BusinessDoc>): Promise<BusinessCase> {
    const [[row], method, suspender] = await Promise.all([
      rows([doc]),
      db().payoutMethods.findOne({ userId: doc.ownerId }),
      doc.suspension ? db().users.findOne({ _id: doc.suspension.by }, { projection: { name: 1 } }) : Promise.resolve(null),
    ]);
    return {
      ...row!,
      payoutMethod: method ? payoutMethodView(method) : null,
      suspendedBy: suspender ? { id: suspender._id.toHexString(), name: suspender.name ?? "" } : null,
    };
  }

  async function target(id: string) {
    const doc = await db().businesses.findOne({ _id: new ObjectId(id) });
    if (!doc) throw new AppError("NOT_FOUND", "Business not found.");
    return doc;
  }

  async function hold(request: FastifyRequest, id: string, held: boolean, reason: string | null) {
    const database = db();
    const doc = await target(id);
    if (held === Boolean(doc.suspension)) throw new AppError("CONFLICT", held ? "This business is already on hold." : "This business isn't on hold.");
    const now = new Date();
    await database.transaction(async (session) => {
      const res = await database.businesses.updateOne(
        { _id: doc._id, suspension: { $exists: !held } },
        held
          ? { $set: { suspension: { by: request.auth!.userId, at: now, reason: reason! }, updatedAt: now } }
          : { $unset: { suspension: "" }, $set: { updatedAt: now } },
        { session },
      );
      if (res.matchedCount === 0) throw new AppError("CONFLICT");
      await writeAudit(
        database,
        {
          actor: actorOf(request),
          scope: { module: doc.module, businessId: doc._id },
          action: held ? "business.suspend" : "business.restore",
          target: { type: "business", id: doc._id },
          diff: held ? { suspended: { from: false, to: true }, reason: { from: null, to: reason } } : { suspended: { from: true, to: false } },
          ip: request.ip,
        },
        session,
      );
    });
    await notifyBusinessHold(database, app.log, { to: doc.ownerId, moderator: request.auth!.userId, businessId: doc._id, name: doc.name, held, reason });
    return ok(request, await detail(await target(id)));
  }

  app.get(
    "/businesses",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "Vendors' businesses, most recently changed first",
        description: "`state` suspended means on hold, whether draft or live; draft and live leave held ones out.",
        querystring: BusinessesQuery,
        response: { 200: BusinessRows, ...Errors },
        security,
      },
    },
    async (request) => {
      const { q, module, state, cursor, limit } = request.query;
      const { items, nextCursor } = await findPage(db().businesses, {
        filter: { ...matching(q), ...(module ? { module } : {}), ...stateFilter(state) },
        sortField: "updatedAt",
        cursor,
        limit,
      });
      return page(request, await rows(items), nextCursor);
    },
  );

  app.get(
    "/businesses/:id",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "One business, its vendor and where they are paid",
        description: "Bank accounts show only their last 4 digits.",
        params: BusinessParams,
        response: { 200: BusinessCaseOne, ...Errors },
        security,
      },
    },
    async (request) => ok(request, await detail(await target(request.params.id))),
  );

  app.post(
    "/businesses/:id/suspend",
    {
      preHandler: [requireRuxstar("businesses.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Put a business on hold",
        description: "Customers stop seeing it and its vendor can't change it until it is restored. The vendor is told why.",
        params: BusinessParams,
        body: SuspendBody,
        response: { 200: BusinessCaseOne, ...Errors },
        security,
      },
    },
    async (request) => hold(request, request.params.id, true, request.body.reason.trim()),
  );

  app.post(
    "/businesses/:id/restore",
    {
      preHandler: [requireRuxstar("businesses.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Lift a hold on a business",
        description: "It comes back as it was: a draft stays a draft, and a live business keeps its open or closed setting.",
        params: BusinessParams,
        response: { 200: BusinessCaseOne, ...Errors },
        security,
      },
    },
    async (request) => hold(request, request.params.id, false, null),
  );
};

export default businesses;
