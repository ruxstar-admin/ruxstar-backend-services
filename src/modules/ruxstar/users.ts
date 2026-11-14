import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type Filter, type WithId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, writeAudit } from "../../platform/audit.js";
import { requireRuxstar } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { UserDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { SuspendBody, UserList, UserOne, UserParams, UsersQuery, type UserDetail, type UserRow } from "./contracts.js";
import { assertCanManage, isPermission } from "./permissions.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Phone digits, a card number, an id, or the start of a username, a name word or an email. */
function matching(q: string | undefined): Filter<UserDoc> {
  const term = q?.trim() ?? "";
  if (!term) return {};
  if (/^[0-9a-f]{24}$/i.test(term)) return { _id: new ObjectId(term.toLowerCase()) };
  if (/^rux-/i.test(term)) return { "card.id": term.toUpperCase() };
  const digits = term.replace(/[\s()+-]/g, "");
  if (/^\d{3,}$/.test(digits)) return { phone: { $regex: escape(digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits) } };
  const text = escape(term.toLowerCase().replace(/^@/, ""));
  return {
    $or: [
      { username: { $regex: `^${text}` } },
      { name: { $regex: `(^|\\s)${text}`, $options: "i" } },
      { email: { $regex: `^${text}`, $options: "i" } },
    ],
  };
}

const rowOf = (u: WithId<UserDoc>): UserRow => ({
  id: u._id.toHexString(),
  name: u.name ?? "",
  username: u.username ?? u.deletion?.username ?? "",
  phone: u.status === "deleted" ? (u.deletion?.phone ?? u.phone) : u.phone,
  avatarUrl: u.avatar ?? null,
  status: u.status,
  roles: { vendor: !!u.roles?.vendor, delivery: !!u.roles?.delivery, ruxstarStaff: !!u.roles?.ruxstarStaff, admin: !!u.roles?.admin },
  kyc: { base: u.kyc?.base ?? "none" },
  createdAt: u.createdAt.toISOString(),
});

/** Finding people and acting on their accounts. Every action is audited and signs them out where it should. */
const users: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  async function detail(user: WithId<UserDoc>): Promise<UserDetail> {
    const d = db();
    const now = new Date();
    const [suspender, sessions, postIds, grant] = await Promise.all([
      user.suspension ? d.users.findOne({ _id: user.suspension.by }, { projection: { name: 1 } }) : Promise.resolve(null),
      d.sessions.countDocuments({ userId: user._id, revokedAt: null, expiresAt: { $gt: now } }),
      d.posts.distinct("_id", { authorId: user._id, status: "live" }),
      d.ruxstarStaff.findOne({ userId: user._id }),
    ]);
    const openReports = postIds.length ? await d.reports.countDocuments({ status: "open", "target.id": { $in: postIds } }) : 0;
    const lockedUntil = user.lock?.lockedUntil && user.lock.lockedUntil > now ? user.lock.lockedUntil : null;
    return {
      ...rowOf(user),
      email: user.email ?? null,
      emailVerified: !!user.emailVerified,
      city: user.home?.city ?? null,
      bio: user.bio ?? null,
      card: user.card?.id ?? null,
      signInLockedUntil: lockedUntil?.toISOString() ?? null,
      suspension: user.suspension
        ? {
            reason: user.suspension.reason,
            at: user.suspension.at.toISOString(),
            by: suspender ? { id: suspender._id.toHexString(), name: suspender.name ?? "" } : null,
          }
        : null,
      stats: { posts: Math.max(0, user.social?.posts ?? 0), engagements: Math.max(0, user.social?.engagements ?? 0) },
      sessions,
      openReports,
      staff: grant ? { title: grant.title, permissions: grant.permissions.filter(isPermission), status: grant.status } : null,
    };
  }

  async function target(id: string) {
    const user = await db().users.findOne({ _id: new ObjectId(id) });
    if (!user) throw new AppError("NOT_FOUND", "No account with that id.");
    return user;
  }

  async function act(
    request: FastifyRequest,
    id: string,
    action: string,
    change: (user: WithId<UserDoc>) => { update: object; diff: Record<string, { from: unknown; to: unknown }>; signOut: boolean; holdReports?: boolean },
  ) {
    const database = db();
    const actor = actorOf(request);
    const user = await target(id);
    if (user.status === "deleted") throw new AppError("CONFLICT", "This account was deleted.");
    assertCanManage(request, user);
    const { update, diff, signOut, holdReports } = change(user);
    await database.transaction(async (session) => {
      const now = new Date();
      const { matchedCount } = await database.users.updateOne({ _id: user._id, status: user.status }, { ...update, $currentDate: { updatedAt: true } }, { session });
      if (!matchedCount) throw new AppError("CONFLICT");
      if (signOut) {
        const ended = await database.sessions.updateMany(
          { userId: user._id, revokedAt: null },
          { $set: { revokedAt: now, updatedAt: now } },
          { session },
        );
        if (ended.modifiedCount) diff.sessions = { from: ended.modifiedCount, to: 0 };
      }
      if (holdReports) {
        const closed = await database.userReports.updateMany(
          { userId: user._id, status: "open" },
          { $set: { status: "closed", outcome: "held", closedBy: request.auth!.userId, closedAt: now } },
          { session },
        );
        if (closed.modifiedCount) diff.openReports = { from: closed.modifiedCount, to: 0 };
      }
      await writeAudit(database, { actor, scope: { module: "account" }, action, target: { type: "user", id: user._id }, diff, ip: request.ip }, session);
    });
    app.authCache.forget(user._id);
    return ok(request, await detail(await target(id)));
  }

  app.get(
    "/users",
    {
      preHandler: requireRuxstar("users.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "Find people",
        description: "Newest first. Without `status`, deleted accounts are left out.",
        querystring: UsersQuery,
        response: { 200: UserList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { q, status, cursor, limit } = request.query;
      const { items, nextCursor } = await findPage(db().users, {
        filter: { ...matching(q), status: status ?? { $ne: "deleted" } },
        sortField: "createdAt",
        cursor,
        limit,
      });
      return page(request, items.map(rowOf), nextCursor);
    },
  );

  app.get(
    "/users/:id",
    {
      preHandler: requireRuxstar("users.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "One person's account",
        params: UserParams,
        response: { 200: UserOne, ...Errors },
        security,
      },
    },
    async (request) => ok(request, await detail(await target(request.params.id))),
  );

  app.post(
    "/users/:id/suspend",
    {
      preHandler: [requireRuxstar("users.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Put an account on hold and sign it out everywhere",
        description: "They can't sign in until it is unlocked; sign-in tells them to contact support. Admins can't be suspended here.",
        params: UserParams,
        body: SuspendBody,
        response: { 200: UserOne, ...Errors },
        security,
      },
    },
    async (request) =>
      act(request, request.params.id, "user.suspend", (user) => {
        if (user.status === "locked") throw new AppError("CONFLICT", "This account is already on hold.");
        const reason = request.body.reason.trim();
        return {
          update: { $set: { status: "locked", suspension: { by: request.auth!.userId, at: new Date(), reason } } },
          diff: { status: { from: user.status, to: "locked" }, reason: { from: null, to: reason } },
          signOut: true,
          holdReports: true,
        };
      }),
  );

  app.post(
    "/users/:id/unlock",
    {
      preHandler: [requireRuxstar("users.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Lift a hold, or the lock after too many wrong passwords",
        params: UserParams,
        response: { 200: UserOne, ...Errors },
        security,
      },
    },
    async (request) =>
      act(request, request.params.id, "user.unlock", (user) => {
        const signInLocked = !!user.lock?.lockedUntil && user.lock.lockedUntil > new Date();
        if (user.status === "active" && !signInLocked) throw new AppError("CONFLICT", "This account isn't locked.");
        return {
          update: { $set: { status: "active", lock: { failedCount: 0, lockedUntil: null } }, $unset: { suspension: "" } },
          diff: {
            ...(user.status === "locked" ? { status: { from: "locked", to: "active" } } : {}),
            ...(signInLocked ? { signInLock: { from: user.lock!.lockedUntil, to: null } } : {}),
          },
          signOut: false,
        };
      }),
  );

  app.post(
    "/users/:id/sign-out",
    {
      preHandler: [requireRuxstar("users.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Sign an account out on every device",
        params: UserParams,
        response: { 200: UserOne, ...Errors },
        security,
      },
    },
    async (request) => act(request, request.params.id, "user.sign_out", () => ({ update: {}, diff: {}, signOut: true })),
  );
};

export default users;
