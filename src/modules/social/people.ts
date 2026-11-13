import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { MongoServerError, ObjectId, type ClientSession, type WithId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { Database, FollowDoc, UserDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { findPage } from "../../platform/pagination.js";
import { notifyFollow } from "../notifications/notify.js";
import { Done, Page, PersonList, PersonParams, RelationResult, UserParams, UserReportBody, type Person } from "./contracts.js";
import { blockBetween, blockedAround, blockedError } from "./relations.js";
import { AUTHOR_PROJECTION, authorView, signedInIfPossible, type AuthorFields } from "./shared.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const signedInOrNot: Record<string, string[]>[] = [{}, { bearer: [] }, { cookie: [] }];
const limit = (perMinutes: number, max: number) => ({ rateLimit: { max, timeWindow: perMinutes * 60_000 } });
const isDuplicate = (err: unknown) => err instanceof MongoServerError && err.code === 11000;
const count = (n: number | undefined) => Math.max(0, n ?? 0);
const noOne = () => new AppError("NOT_FOUND", "No one has that username.");

/** True when `write` happened, false when its unique index says it already had. */
async function firstTime(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (err) {
    if (isDuplicate(err)) return false;
    throw err;
  }
}

/** Follows, blocks and reports about people. Mounted inside the social module. */
const people: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const me = (request: FastifyRequest) => request.auth?.userId ?? null;

  async function person(ref: string): Promise<WithId<UserDoc>> {
    const key = ref.toLowerCase();
    const user = await db().users.findOne({
      ...(/^[0-9a-f]{24}$/.test(key) ? { _id: new ObjectId(key) } : { username: key }),
      status: { $ne: "deleted" },
    });
    if (!user?.username) throw noOne();
    return user;
  }

  async function relation(viewer: ObjectId, them: ObjectId) {
    const d = db();
    const [user, following, followsMe, blocked] = await Promise.all([
      d.users.findOne({ _id: them }, { projection: { social: 1 } }),
      d.follows.countDocuments({ followerId: viewer, followeeId: them }, { limit: 1 }),
      d.follows.countDocuments({ followerId: them, followeeId: viewer }, { limit: 1 }),
      d.blocks.countDocuments({ blockerId: viewer, blockedId: them }, { limit: 1 }),
    ]);
    return {
      following: following > 0,
      followsMe: followsMe > 0,
      blockedByMe: blocked > 0,
      counts: { followers: count(user?.social?.followers), following: count(user?.social?.following) },
    };
  }

  /** Ends a follow and moves both counts. False when there was none. */
  async function unfollow(d: Database, followerId: ObjectId, followeeId: ObjectId, session: ClientSession): Promise<boolean> {
    const { deletedCount } = await d.follows.deleteOne({ followerId, followeeId }, { session });
    if (!deletedCount) return false;
    await d.users.updateOne({ _id: followerId }, { $inc: { "social.following": -1 } }, { session });
    await d.users.updateOne({ _id: followeeId }, { $inc: { "social.followers": -1 } }, { session });
    return true;
  }

  async function listed(request: FastifyRequest, rows: WithId<FollowDoc>[], pick: (row: FollowDoc) => ObjectId): Promise<Person[]> {
    const d = db();
    const viewer = me(request);
    const ids = rows.map(pick);
    const [users, mine] = await Promise.all([
      d.users.find({ _id: { $in: ids }, status: { $ne: "deleted" } }, { projection: AUTHOR_PROJECTION }).toArray(),
      viewer ? d.follows.find({ followerId: viewer, followeeId: { $in: ids } }, { projection: { followeeId: 1 } }).toArray() : Promise.resolve([]),
    ]);
    const byId = new Map(users.map((u) => [u._id.toHexString(), u]));
    const followed = new Set(mine.map((f) => f.followeeId.toHexString()));
    return ids.flatMap((id) => {
      const user = byId.get(id.toHexString());
      if (!user?.username) return [];
      return [{ ...authorView(user as AuthorFields), followedByMe: followed.has(id.toHexString()), me: !!viewer && viewer.equals(id) }];
    });
  }

  app.get(
    "/users/:ref/relation",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["social"],
        summary: "You and someone else: following, follows you, blocked, and their counts",
        params: UserParams,
        response: { 200: RelationResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const them = await person(request.params.ref);
      if ((await blockBetween(db(), me(request), them._id)) === "theirs") throw noOne();
      return ok(request, await relation(request.auth!.userId, them._id));
    },
  );

  for (const side of ["followers", "following"] as const) {
    app.get(
      `/users/:ref/${side}`,
      {
        preHandler: signedInIfPossible,
        schema: {
          tags: ["social"],
          summary: side === "followers" ? "Who follows someone, newest first" : "Who someone follows, newest first",
          description: "No sign-in needed. Signed in, `followedByMe` says whether you follow each of them, and people you blocked or who blocked you are left out.",
          params: UserParams,
          querystring: Page,
          response: { 200: PersonList, ...Errors },
          security: signedInOrNot,
        },
      },
      async (request) => {
        const d = db();
        const them = await person(request.params.ref);
        if ((await blockBetween(d, me(request), them._id)) === "theirs") throw noOne();
        const hidden = await blockedAround(d, me(request));
        const mineField = side === "followers" ? "followeeId" : "followerId";
        const otherField = side === "followers" ? "followerId" : "followeeId";
        const { items, nextCursor } = await findPage(d.follows, {
          filter: { [mineField]: them._id, ...(hidden.length ? { [otherField]: { $nin: hidden } } : {}) },
          sortField: "createdAt",
          cursor: request.query.cursor,
          limit: request.query.limit,
        });
        return page(request, await listed(request, items, (row) => row[otherField]), nextCursor);
      },
    );
  }

  app.put(
    "/users/:id/follow",
    {
      preHandler: requireAuth,
      config: limit(1, 60),
      schema: {
        tags: ["social"],
        summary: "Follow someone",
        description: "Open follows: no request. Following again changes nothing. They are told once.",
        params: PersonParams,
        response: { 200: RelationResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const d = db();
      const userId = request.auth!.userId;
      const them = await person(request.params.id);
      if (them._id.equals(userId)) throw new AppError("VALIDATION_FAILED", "You can't follow yourself.", [{ path: "params/id", message: "That is you" }]);
      if (await blockBetween(d, userId, them._id)) throw blockedError();
      // A duplicate aborts the transaction, so it is caught outside it: already following.
      const added = await firstTime(() =>
        d.transaction(async (session) => {
          await d.follows.insertOne({ followerId: userId, followeeId: them._id, createdAt: new Date() }, { session });
          await d.users.updateOne({ _id: userId }, { $inc: { "social.following": 1 } }, { session });
          await d.users.updateOne({ _id: them._id }, { $inc: { "social.followers": 1 } }, { session });
        }),
      );
      if (added) void notifyFollow(d, app.log, { to: them._id, follower: userId });
      return ok(request, await relation(userId, them._id));
    },
  );

  app.delete(
    "/users/:id/follow",
    {
      preHandler: requireAuth,
      config: limit(1, 60),
      schema: { tags: ["social"], summary: "Stop following someone", params: PersonParams, response: { 200: RelationResult, ...Errors }, security },
    },
    async (request) => {
      const d = db();
      const userId = request.auth!.userId;
      const them = await person(request.params.id);
      await d.transaction((session) => unfollow(d, userId, them._id, session));
      return ok(request, await relation(userId, them._id));
    },
  );

  app.put(
    "/users/:id/block",
    {
      preHandler: requireAuth,
      config: limit(1, 30),
      schema: {
        tags: ["social"],
        summary: "Block someone",
        description:
          "You stop seeing each other's posts, comments and profile, follows both ways end, and neither of you can follow, comment on or message the other. " +
          "They aren't told. Blocking again changes nothing.",
        params: PersonParams,
        response: { 200: RelationResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const d = db();
      const userId = request.auth!.userId;
      const them = await person(request.params.id);
      if (them._id.equals(userId)) throw new AppError("VALIDATION_FAILED", "You can't block yourself.", [{ path: "params/id", message: "That is you" }]);
      await firstTime(() =>
        d.transaction(async (session) => {
          await d.blocks.insertOne({ blockerId: userId, blockedId: them._id, createdAt: new Date() }, { session });
          await unfollow(d, userId, them._id, session);
          await unfollow(d, them._id, userId, session);
        }),
      );
      return ok(request, await relation(userId, them._id));
    },
  );

  app.delete(
    "/users/:id/block",
    {
      preHandler: requireAuth,
      config: limit(1, 30),
      schema: {
        tags: ["social"],
        summary: "Unblock someone",
        description: "Follows that ended when you blocked them don't come back.",
        params: PersonParams,
        response: { 200: RelationResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const them = await person(request.params.id);
      await db().blocks.deleteOne({ blockerId: userId, blockedId: them._id });
      return ok(request, await relation(userId, them._id));
    },
  );

  app.get(
    "/blocks",
    {
      preHandler: requireAuth,
      schema: { tags: ["social"], summary: "People you blocked, most recent first", querystring: Page, response: { 200: PersonList, ...Errors }, security },
    },
    async (request) => {
      const d = db();
      const { items, nextCursor } = await findPage(d.blocks, {
        filter: { blockerId: request.auth!.userId },
        sortField: "createdAt",
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      const ids = items.map((b) => b.blockedId);
      const users = await d.users.find({ _id: { $in: ids }, status: { $ne: "deleted" } }, { projection: AUTHOR_PROJECTION }).toArray();
      const byId = new Map(users.map((u) => [u._id.toHexString(), u]));
      const list = ids.flatMap((id) => {
        const user = byId.get(id.toHexString());
        return user?.username ? [{ ...authorView(user as AuthorFields), followedByMe: false, me: false }] : [];
      });
      return page(request, list, nextCursor);
    },
  );

  app.post(
    "/users/:id/report",
    {
      preHandler: requireAuth,
      config: limit(60, 20),
      schema: {
        tags: ["social"],
        summary: "Report someone to Ruxstar",
        description: "One open report per person you report; reporting them again while it is open changes nothing. They aren't told.",
        params: PersonParams,
        body: UserReportBody,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const them = await person(request.params.id);
      if (them._id.equals(userId)) throw new AppError("VALIDATION_FAILED", "You can't report yourself.", [{ path: "params/id", message: "That is you" }]);
      const note = request.body.note?.trim() || null;
      await db().userReports.updateOne(
        { userId: them._id, reporterId: userId, status: "open" },
        { $setOnInsert: { reason: request.body.reason as never, note, createdAt: new Date() } },
        { upsert: true },
      );
      return ok(request, { done: true as const });
    },
  );
};

export default people;
