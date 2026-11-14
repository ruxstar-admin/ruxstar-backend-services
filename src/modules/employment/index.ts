import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import { ok } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { Done } from "../social/contracts.js";
import { WorkOne, WorkParams, WorkPlaceOne } from "../team/contracts.js";
import { answerInvite, endPlace, ownPlace, placeView, workOf } from "../team/team.js";
import orders from "./orders.js";
import reviews from "./reviews.js";
import shop from "./shop.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

/** The Work area: invites to businesses' teams, and the businesses someone works at (decision 54). */
const employment: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const ctx = (request: Parameters<typeof actorOf>[0]) => ({ actor: actorOf(request), ip: request.ip, log: request.log, userId: request.auth!.userId });
  await app.register(orders);
  await app.register(shop);
  await app.register(reviews);

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["employment"],
        summary: "Your team invites and the businesses you work at",
        description: "Invites that ran out are left out. A place's `access` says whether anything works there yet.",
        response: { 200: WorkOne, ...Errors },
        security,
      },
    },
    async (request) => ok(request, await workOf(db(), request.auth!)),
  );

  app.post(
    "/:id/accept",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["employment"],
        summary: "Join a business's team",
        description: "The owner is told. Nothing works for you there until your identity verification is approved.",
        params: WorkParams,
        response: { 200: WorkPlaceOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const invite = await ownPlace(db(), request.auth!.userId, request.params.id);
      const done = await answerInvite(db(), invite, true, ctx(request));
      const [business, owner] = await Promise.all([
        db().businesses.findOne({ _id: done.businessId }),
        db().users.findOne({ _id: done.ownerId }, { projection: { name: 1, username: 1 } }),
      ]);
      return ok(request, placeView(done, business!, owner, request.auth!.kyc.base === "approved"));
    },
  );

  app.post(
    "/:id/decline",
    {
      preHandler: requireAuth,
      schema: { tags: ["employment"], summary: "Turn down a team invite", params: WorkParams, response: { 200: Done, ...Errors }, security },
    },
    async (request) => {
      const invite = await ownPlace(db(), request.auth!.userId, request.params.id);
      await answerInvite(db(), invite, false, ctx(request));
      return ok(request, { done: true as const });
    },
  );

  app.post(
    "/:id/leave",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["employment"],
        summary: "Leave a business's team",
        description: "Your access ends at once and the owner is told.",
        params: WorkParams,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const place = await ownPlace(db(), request.auth!.userId, request.params.id);
      if (place.status !== "active" || !place.current) throw new AppError("CONFLICT", "You're not on this team.");
      await endPlace(db(), place, { ...ctx(request), by: "member", actorId: request.auth!.userId });
      return ok(request, { done: true as const });
    },
  );
};

export default employment;
