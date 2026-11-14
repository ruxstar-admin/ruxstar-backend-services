import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireDatabase } from "../../platform/context.js";
import { ok } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { Done } from "../social/contracts.js";
import { InviteBody, MAX_TEAM, MemberParams, PermissionsBody, TeamMemberOne, TeamOne, TeamParams, INVITE_DAYS } from "../team/contracts.js";
import { endPlace, invite, memberOf, teamOf, teamView, updateMember } from "../team/team.js";
import { ownedBy, requireVendor } from "./businesses.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

/** An owner's team at one business: inviting people, what each may do, and removing them. Only the owner manages the team. */
const team: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  async function owned(request: { auth: { userId: ObjectId } | null }, id: string) {
    const doc = await db().businesses.findOne(ownedBy(new ObjectId(id), request.auth!.userId));
    if (!doc) throw new AppError("NOT_FOUND", "Business not found.");
    return doc;
  }

  const memberView = async (businessId: ObjectId, memberId: ObjectId) => (await teamOf(db(), businessId)).find((m) => m.id === memberId.toHexString())!;

  app.get(
    "/businesses/:id/team",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "A business's team and open invites, with what can be given",
        params: TeamParams,
        response: { 200: TeamOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const business = await owned(request, request.params.id);
      return ok(request, await teamView(db(), business._id));
    },
  );

  app.post(
    "/businesses/:id/team",
    {
      preHandler: [requireVendor, idempotent],
      config: { rateLimit: { max: 60, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Invite someone to the team by their username",
        description:
          `They get a notification and have ${INVITE_DAYS} days to accept. Nothing works for them until their identity verification is approved. ` +
          `A team holds up to ${MAX_TEAM} people, invites included. Permissions that need "See orders" bring it with them. ` +
          "Pay is optional and shown to them with the invite, so they can compare offers. " +
          "Withdrawals, payment details, publishing, deleting and the team itself stay with the owner.",
        params: TeamParams,
        body: InviteBody,
        response: { 201: TeamMemberOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const business = await owned(request, request.params.id);
      const doc = await invite(db(), business, request.body, { actor: actorOf(request), ip: request.ip, log: request.log, by: request.auth!.userId });
      return reply.status(201).send(ok(request, await memberView(business._id, doc._id)));
    },
  );

  app.patch(
    "/businesses/:id/team/:memberId",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Change what a team member, or someone invited, may do, and the pay on an open invite",
        description:
          "Replaces what you send: permissions apply on their next request. Pay changes only while they're invited; null takes it off the offer. " +
          "Ruxstar only shows the pay; the shop pays its team outside Ruxstar.",
        params: MemberParams,
        body: PermissionsBody,
        response: { 200: TeamMemberOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const business = await owned(request, request.params.id);
      if (business.suspension) throw new AppError("BUSINESS_SUSPENDED");
      const member = await memberOf(db(), business._id, request.params.memberId);
      const done = await updateMember(db(), member, request.body, { actor: actorOf(request), ip: request.ip, log: request.log });
      return ok(request, await memberView(business._id, done._id));
    },
  );

  app.delete(
    "/businesses/:id/team/:memberId",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Remove someone from the team, or cancel their invite",
        description: "Their access ends at once. Someone who was working here is told.",
        params: MemberParams,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const business = await owned(request, request.params.id);
      const member = await memberOf(db(), business._id, request.params.memberId);
      await endPlace(db(), member, { actor: actorOf(request), ip: request.ip, log: request.log, by: "owner", actorId: request.auth!.userId });
      return ok(request, { done: true as const });
    },
  );
};

export default team;
