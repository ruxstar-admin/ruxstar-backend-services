import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId, type Filter } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { requireRuxstar } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { AuditLogDoc } from "../../platform/db.js";
import { page } from "../../platform/envelope.js";
import { findPage } from "../../platform/pagination.js";
import { AuditList, AuditQuery } from "./contracts.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

/** Who changed what, newest first. Entries are never edited or deleted. */
const auditLog: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/audit",
    {
      preHandler: requireRuxstar("audit.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "The audit log",
        description: "Filter by module, action, who did it (`actor`, a user id) or what it was done to (`target`).",
        querystring: AuditQuery,
        response: { 200: AuditList, ...Errors },
        security,
      },
    },
    async (request) => {
      const db = requireDatabase(app.db);
      const { module, action, actor, target, cursor, limit } = request.query;
      const filter: Filter<AuditLogDoc> = {
        ...(module ? { "scope.module": module } : {}),
        ...(action ? { action } : {}),
        ...(actor ? { "actor.id": new ObjectId(actor) } : {}),
        ...(target ? { "target.id": /^[0-9a-f]{24}$/.test(target) ? new ObjectId(target) : target } : {}),
      };
      const { items, nextCursor } = await findPage(db.auditLogs, { filter, sortField: "at", cursor, limit });
      const actorIds = items.flatMap((e) => (e.actor.id ? [e.actor.id] : []));
      const people = await db.users.find({ _id: { $in: actorIds } }, { projection: { name: 1, username: 1 } }).toArray();
      return page(
        request,
        items.map((e) => {
          const who = e.actor.id && people.find((p) => p._id.equals(e.actor.id!));
          return {
            id: e._id.toHexString(),
            at: e.at.toISOString(),
            actor: { id: e.actor.id?.toHexString() ?? null, kind: e.actor.kind, name: who ? (who.name ?? "") : null, username: who ? (who.username ?? "") : null },
            module: e.scope.module,
            action: e.action,
            target: { type: e.target.type, id: typeof e.target.id === "string" ? e.target.id : e.target.id.toHexString() },
            diff: e.diff,
            ip: e.ip,
          };
        }),
        nextCursor,
      );
    },
  );
};

export default auditLog;
