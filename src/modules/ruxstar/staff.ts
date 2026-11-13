import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId, type WithId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, diffOf, writeAudit } from "../../platform/audit.js";
import { requireAdmin } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import { stamp, type RuxstarStaffDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { StaffBody, StaffList, StaffOne, StaffParams, type StaffMember } from "./contracts.js";
import { assertCanManage, isPermission } from "./permissions.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const USER_PROJECTION = { name: 1, username: 1, phone: 1, avatar: 1 } as const;

/** Ruxstar staff and what each may do. Admins only. */
const staff: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  async function present(grants: WithId<RuxstarStaffDoc>[]): Promise<StaffMember[]> {
    const people = await db()
      .users.find({ _id: { $in: grants.map((g) => g.userId) } }, { projection: USER_PROJECTION })
      .toArray();
    return grants.map((g) => {
      const u = people.find((p) => p._id.equals(g.userId));
      return {
        user: { id: g.userId.toHexString(), name: u?.name ?? "", username: u?.username ?? "", phone: u?.phone ?? "", avatarUrl: u?.avatar ?? null },
        title: g.title,
        permissions: g.permissions.filter(isPermission),
        status: g.status,
        grantedAt: g.createdAt.toISOString(),
        updatedAt: g.updatedAt.toISOString(),
      };
    });
  }

  app.get(
    "/staff",
    {
      preHandler: requireAdmin,
      schema: {
        tags: ["ruxstar"],
        summary: "Ruxstar staff, active first",
        response: { 200: StaffList, ...Errors },
        security,
      },
    },
    async (request) => {
      const grants = await db().ruxstarStaff.find({}).sort({ status: 1, updatedAt: -1 }).limit(200).toArray();
      return page(request, await present(grants), null);
    },
  );

  app.put(
    "/staff/:userId",
    {
      preHandler: [requireAdmin, idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Make someone Ruxstar staff, or change their title and permissions",
        description: "Also brings back staff who were removed.",
        params: StaffParams,
        body: StaffBody,
        response: { 200: StaffOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const userId = new ObjectId(request.params.userId);
      const user = await database.users.findOne({ _id: userId }, { projection: { roles: 1, status: 1 } });
      if (!user || user.status === "deleted") throw new AppError("NOT_FOUND", "No account with that id.");
      assertCanManage(request, user);
      const title = request.body.title.trim();
      const permissions = [...request.body.permissions];
      const modules = [...new Set(permissions.map((p) => p.split(".")[0]!))];
      const actor = actorOf(request);

      const saved = await database.transaction(async (session) => {
        const now = new Date();
        const before = await database.ruxstarStaff.findOne({ userId }, { session });
        const change = { title, permissions, modules, status: "active" as const };
        let after: WithId<RuxstarStaffDoc>;
        if (before) {
          after = (await database.ruxstarStaff.findOneAndUpdate(
            { _id: before._id },
            { $set: { ...change, grantedBy: request.auth!.userId, updatedAt: now } },
            { session, returnDocument: "after" },
          ))!;
        } else {
          after = { _id: new ObjectId(), userId, ...change, grantedBy: request.auth!.userId, ...stamp(now) };
          await database.ruxstarStaff.insertOne(after, { session });
        }
        await database.users.updateOne({ _id: userId }, { $set: { "roles.ruxstarStaff": true, updatedAt: now } }, { session });
        const diff = before ? diffOf(before, change) : { title: { from: null, to: title }, permissions: { from: null, to: permissions } };
        await writeAudit(
          database,
          {
            actor,
            scope: { module: "ruxstar" },
            action: before?.status === "active" ? "staff.update" : "staff.grant",
            target: { type: "user", id: userId },
            diff,
            ip: request.ip,
          },
          session,
        );
        return after;
      });

      app.authCache.forget(userId);
      return ok(request, (await present([saved]))[0]!);
    },
  );

  app.delete(
    "/staff/:userId",
    {
      preHandler: [requireAdmin, idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Remove someone from Ruxstar staff",
        description: "They lose console access at once. Their account stays as it is.",
        params: StaffParams,
        response: { 200: StaffOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const userId = new ObjectId(request.params.userId);
      const actor = actorOf(request);
      const saved = await database.transaction(async (session) => {
        const now = new Date();
        const after = await database.ruxstarStaff.findOneAndUpdate(
          { userId, status: "active" },
          { $set: { status: "revoked", updatedAt: now } },
          { session, returnDocument: "after" },
        );
        if (!after) throw new AppError("NOT_FOUND", "They are not on the Ruxstar staff.");
        await database.users.updateOne({ _id: userId }, { $set: { "roles.ruxstarStaff": false, updatedAt: now } }, { session });
        await writeAudit(
          database,
          {
            actor,
            scope: { module: "ruxstar" },
            action: "staff.revoke",
            target: { type: "user", id: userId },
            diff: { status: { from: "active", to: "revoked" } },
            ip: request.ip,
          },
          session,
        );
        return after;
      });
      app.authCache.forget(userId);
      return ok(request, (await present([saved]))[0]!);
    },
  );
};

export default staff;
