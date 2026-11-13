import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireRuxstar } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import { ok } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { Done } from "../social/contracts.js";
import { MemberParams, RemoveBody, TeamOne, TeamParams } from "../team/contracts.js";
import { endPlace, memberOf, teamView } from "../team/team.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

/** A business's team in the console, and removing someone from it. */
const teams: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  async function business(id: string) {
    const doc = await db().businesses.findOne({ _id: new ObjectId(id) }, { projection: { _id: 1 } });
    if (!doc) throw new AppError("NOT_FOUND", "Business not found.");
    return doc;
  }

  app.get(
    "/businesses/:id/team",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: { tags: ["ruxstar"], summary: "A business's team and open invites", params: TeamParams, response: { 200: TeamOne, ...Errors }, security },
    },
    async (request) => ok(request, await teamView(db(), (await business(request.params.id))._id)),
  );

  app.post(
    "/businesses/:id/team/:memberId/remove",
    {
      preHandler: [requireRuxstar("businesses.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Remove someone from a business's team",
        description: "The reason goes to the audit log, and the person and the owner both see it.",
        params: MemberParams,
        body: RemoveBody,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const doc = await business(request.params.id);
      const member = await memberOf(db(), doc._id, request.params.memberId);
      await endPlace(db(), member, {
        actor: actorOf(request),
        ip: request.ip,
        log: request.log,
        by: "ruxstar",
        actorId: request.auth!.userId,
        reason: request.body.reason.trim(),
      });
      return ok(request, { done: true as const });
    },
  );
};

export default teams;
