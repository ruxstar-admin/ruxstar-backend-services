import { randomUUID } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyReply, FastifyRequest } from "fastify";
import { MongoServerError, ObjectId, type WithId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, writeAudit } from "../../platform/audit.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase, type AuthContext } from "../../platform/context.js";
import type { Database, PostCommentDoc, PostDoc, PostMediaDoc, PostPhoto } from "../../platform/db.js";
import { stamp } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { findPage } from "../../platform/pagination.js";
import { notifyPostEvent } from "../notifications/notify.js";
import { notifyFollowersOfPost, notifyMentions } from "../notifications/notify-posts.js";
import { teamAccess } from "../team/team.js";
import {
  CommentCreate,
  CommentList,
  CommentResult,
  Done,
  FeedQuery,
  IdParams,
  LikeState,
  Page,
  PostCreate,
  PostList,
  PostPatch,
  PostResult,
  ReportBody,
  SaveState,
  UploadResult,
  UserParams,
  UserPostsQuery,
  type Comment,
  type Post,
} from "./contracts.js";
import chats from "./chats.js";
import { forYouPage } from "./feed.js";
import people from "./people.js";
import { POST_PHOTO_MAX_BYTES, toPostPhoto } from "./photos.js";
import { assertNotBlocked, blockBetween, blockedAround } from "./relations.js";
import { AUTHOR_PROJECTION, authorView, signedInIfPossible, type AuthorFields } from "./shared.js";
import { clearPost, keysOf } from "./takedown.js";

type Security = Record<string, string[]>[];
const security: Security = [{ bearer: [] }, { cookie: [] }];
const signedInOrNot: Security = [{}, { bearer: [] }, { cookie: [] }];
const limit = (perMinutes: number, max: number) => ({ rateLimit: { max, timeWindow: perMinutes * 60_000 } });
/** Uploaded photos that never made it into a post are deleted after a day. */
const STALE_UPLOAD_MS = 24 * 60 * 60_000;

const photoView = ({ url, width, height, smaller }: PostPhoto) => ({
  url,
  width,
  height,
  smaller: (smaller ?? []).map((s) => ({ url: s.url, width: s.width, height: s.height })),
});
/** One empty line in a row at most, no spaces at line ends. */
const tidy = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

async function authorsOf(db: Database, ids: ObjectId[]) {
  const unique = [...new Map(ids.map((id) => [id.toHexString(), id])).values()];
  const users = await db.users
    .find({ _id: { $in: unique }, status: { $ne: "deleted" } }, { projection: AUTHOR_PROJECTION })
    .toArray();
  return new Map(users.map((u) => [u._id.toHexString(), authorView(u as AuthorFields)]));
}

/** The businesses business posts are for, and whether each is a print shop customers can order from now. */
async function businessesOf(db: Database, posts: WithId<PostDoc>[]) {
  const ids = posts.flatMap((p) => (p.kind === "business" && p.businessId ? [p.businessId] : []));
  if (ids.length === 0) return new Map<string, NonNullable<Post["business"]>>();
  const [businesses, pod] = await Promise.all([
    db.businesses.find({ _id: { $in: ids } }, { projection: { name: 1, module: 1, status: 1, suspension: 1 } }).toArray(),
    db.moduleSettings.findOne({ module: "pod" }, { projection: { live: 1 } }),
  ]);
  return new Map(
    businesses.map((b) => [
      b._id.toHexString(),
      { id: b._id.toHexString(), name: b.name, module: b.module, orderable: b.module === "pod" && b.status === "live" && !b.suspension && !!pod?.live },
    ]),
  );
}

/** Three reads for a whole page, whatever its size: the authors, your likes and saves, and linked businesses. Posts by deleted accounts drop out. */
async function present(db: Database, posts: WithId<PostDoc>[], me: ObjectId | null): Promise<Post[]> {
  if (posts.length === 0) return [];
  const [authors, reactions, businesses] = await Promise.all([
    authorsOf(db, posts.map((p) => p.authorId)),
    me
      ? db.postReactions.find({ userId: me, postId: { $in: posts.map((p) => p._id) } }, { projection: { postId: 1, kind: 1 } }).toArray()
      : Promise.resolve([]),
    businessesOf(db, posts),
  ]);
  const mark = new Set(reactions.map((r) => `${r.postId.toHexString()}:${r.kind}`));
  return posts.flatMap((post) => {
    const author = authors.get(post.authorId.toHexString());
    if (!author) return [];
    const id = post._id.toHexString();
    return [
      {
        id,
        author,
        kind: post.kind,
        business: post.kind === "business" && post.businessId ? (businesses.get(post.businessId.toHexString()) ?? null) : null,
        text: post.text,
        media: post.media.map(photoView),
        counts: { likes: post.counts.likes, comments: post.counts.comments },
        createdAt: post.createdAt.toISOString(),
        editedAt: post.editedAt?.toISOString() ?? null,
        likedByMe: mark.has(`${id}:like`),
        savedByMe: mark.has(`${id}:save`),
        mine: !!me && post.authorId.equals(me),
      },
    ];
  });
}

async function presentComments(db: Database, comments: WithId<PostCommentDoc>[], me: ObjectId | null): Promise<Comment[]> {
  const authors = await authorsOf(db, comments.map((c) => c.authorId));
  return comments.flatMap((comment) => {
    const author = authors.get(comment.authorId.toHexString());
    if (!author) return [];
    return [{ id: comment._id.toHexString(), author, text: comment.text, createdAt: comment.createdAt.toISOString(), mine: !!me && comment.authorId.equals(me) }];
  });
}

const removed = () => new AppError("NOT_FOUND", "This post was removed.");

async function livePost(db: Database, id: string) {
  const post = await db.posts.findOne({ _id: new ObjectId(id), status: "live" });
  if (!post) throw removed();
  return post;
}

const isDuplicate = (err: unknown) => err instanceof MongoServerError && err.code === 11000;

/**
 * The business a business post is for, and who it's posted as: the vendor's pick or their only business, or a business whose
 * team the person posts for (with "Post as the business"), posted as its owner so it sits with the owner's other business posts.
 */
async function businessFor(db: Database, auth: AuthContext, picked: string | null | undefined): Promise<{ businessId: ObjectId; authorId: ObjectId } | null> {
  const notYours = () => new AppError("VALIDATION_FAILED", "Pick one of your businesses.", [{ path: "body/businessId", message: "Not your business" }]);
  if (picked) {
    const business = await db.businesses.findOne({ _id: new ObjectId(picked) }, { projection: { _id: 1, ownerId: 1 } });
    if (!business) throw notYours();
    if (business.ownerId.equals(auth.userId)) {
      if (!auth.roles.vendor) throw new AppError("FORBIDDEN", "Only vendors can post as a business.");
      return { businessId: business._id, authorId: auth.userId };
    }
    await teamAccess(db, auth, { businessId: business._id }, "posts.create").catch((err: unknown) => {
      throw err instanceof AppError && err.code === "NOT_FOUND" ? notYours() : err;
    });
    return { businessId: business._id, authorId: business.ownerId };
  }
  if (!auth.roles.vendor) throw new AppError("FORBIDDEN", "Only vendors can post as a business.");
  const mine = await db.businesses.find({ ownerId: auth.userId }, { projection: { _id: 1 } }).limit(2).toArray();
  if (mine.length > 1) throw new AppError("VALIDATION_FAILED", "Pick which business this post is for.", [{ path: "body/businessId", message: "Required" }]);
  return mine[0] ? { businessId: mine[0]._id, authorId: auth.userId } : null;
}

const social: FastifyPluginAsyncTypebox = async (app) => {
  app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: POST_PHOTO_MAX_BYTES }, (_request, body, done) => done(null, body));
  await app.register(people);
  await app.register(chats);

  const me = (request: FastifyRequest) => request.auth?.userId ?? null;
  // A cached anonymous answer must not be reused once someone signs in: it would show "not liked".
  const publicCache = (request: FastifyRequest, reply: FastifyReply) => {
    const vary = reply.getHeader("vary");
    reply.header("vary", [vary, "Cookie, Authorization"].filter(Boolean).join(", "));
    reply.header("cache-control", request.auth ? "private, no-store" : "public, max-age=30");
  };

  app.get(
    "/feed",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["social"],
        summary: "The feed: For you, or Following",
        description:
          "`for_you` (the default) is the last week's posts ranked by likes and comments, newer first, with people you follow boosted; older posts follow, newest first. " +
          "`following` is posts by people you follow, and yours, newest first. Both leave out anyone you blocked or who blocked you.",
        querystring: FeedQuery,
        response: { 200: PostList, ...Errors },
        security,
      },
    },
    async (request) => {
      const db = requireDatabase(app.db);
      const userId = request.auth!.userId;
      const { tab = "for_you", cursor, limit } = request.query;
      const [hidden, follows] = await Promise.all([
        blockedAround(db, userId),
        db.follows.find({ followerId: userId }, { projection: { followeeId: 1 } }).toArray(),
      ]);
      const followed = follows.map((f) => f.followeeId);
      const { items, nextCursor } =
        tab === "following"
          ? await findPage(db.posts, { filter: { status: "live", authorId: { $in: [userId, ...followed] } }, sortField: "createdAt", cursor, limit })
          : await forYouPage(db, { hidden, followed: new Set(followed.map((id) => id.toHexString())), cursor, limit });
      return page(request, await present(db, items, userId), nextCursor);
    },
  );

  app.get(
    "/users/:ref/posts",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["social"],
        summary: "Someone's posts on one profile tab, newest first",
        description: "No sign-in needed. `kind` is personal (the default) or business; only vendors have business posts.",
        params: UserParams,
        querystring: UserPostsQuery,
        response: { 200: PostList, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      const db = requireDatabase(app.db);
      const ref = request.params.ref.toLowerCase();
      const byId = /^[0-9a-f]{24}$/.test(ref) ? new ObjectId(ref) : null;
      const postsOf = (authorId: ObjectId) =>
        findPage(db.posts, {
          filter: { authorId, kind: request.query.kind ?? "personal", status: "live" },
          sortField: "createdAt",
          cursor: request.query.cursor,
          limit: request.query.limit,
        });
      const findUser = db.users.findOne(
        { ...(byId ? { _id: byId } : { username: ref }), status: { $ne: "deleted" } },
        { projection: { _id: 1, username: 1 } },
      );
      // By id, the posts are read alongside the profile; by username, they need its id first.
      const [user, early] = await Promise.all([findUser, byId ? postsOf(byId) : null]);
      if (!user?.username) throw new AppError("NOT_FOUND", "No one has that username.");
      const block = await blockBetween(db, me(request), user._id);
      if (block === "theirs") throw new AppError("NOT_FOUND", "No one has that username.");
      publicCache(request, reply);
      if (block === "mine") return page(request, [], null);
      const { items, nextCursor } = early ?? (await postsOf(user._id));
      return page(request, await present(db, items, me(request)), nextCursor);
    },
  );

  app.get(
    "/saved",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["social"],
        summary: "Posts you saved, most recently saved first",
        querystring: Page,
        response: { 200: PostList, ...Errors },
        security,
      },
    },
    async (request) => {
      const db = requireDatabase(app.db);
      const { items, nextCursor } = await findPage(db.postReactions, {
        filter: { userId: request.auth!.userId, kind: "save" },
        sortField: "createdAt",
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      const hidden = await blockedAround(db, request.auth!.userId);
      const posts = await db.posts
        .find({ _id: { $in: items.map((r) => r.postId) }, status: "live", ...(hidden.length ? { authorId: { $nin: hidden } } : {}) })
        .toArray();
      const byId = new Map(posts.map((p) => [p._id.toHexString(), p]));
      const ordered = items.flatMap((r) => byId.get(r.postId.toHexString()) ?? []);
      return page(request, await present(db, ordered, me(request)), nextCursor);
    },
  );

  app.get(
    "/posts/:id",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["social"],
        summary: "One post",
        description: "No sign-in needed. Removed posts, and posts by deleted accounts, answer NOT_FOUND.",
        params: IdParams,
        response: { 200: PostResult, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      const db = requireDatabase(app.db);
      const found = await livePost(db, request.params.id);
      if (await blockBetween(db, me(request), found.authorId)) throw new AppError("NOT_FOUND", "This post isn't available.");
      const [post] = await present(db, [found], me(request));
      if (!post) throw removed();
      publicCache(request, reply);
      return ok(request, post);
    },
  );

  app.post(
    "/media",
    {
      preHandler: requireAuth,
      config: limit(60, 60),
      schema: {
        tags: ["social"],
        summary: "Upload one photo for a post you are about to make",
        description:
          "Send the image itself with Content-Type image/jpeg, image/png or image/webp, up to 8 MB. It is saved as WebP, at most " +
          "1440 pixels on its long side, without its metadata, with copies 320 and 640 pixels wide in `smaller`. " +
          "Pass the returned id in `mediaIds` when creating the post. " +
          "Photos not used in a post within a day are deleted.",
        response: { 201: UploadResult, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const db = requireDatabase(app.db);
      const userId = request.auth!.userId;
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw new AppError("PHOTO_INVALID");
      const { full, smaller } = await toPostPhoto(request.body);
      const base = `post-media/${app.config.env}/${userId.toHexString()}/${randomUUID()}`;
      const save = async (file: typeof full, suffix: string) => {
        const key = `${base}${suffix}.webp`;
        return { key, url: await app.media.save(key, file.data), width: file.width, height: file.height };
      };
      const [saved, ...copies] = await Promise.all([save(full, ""), ...smaller.map((file) => save(file, `-${file.width}w`))]);
      const photo: PostPhoto = { ...saved!, smaller: copies };
      const _id = new ObjectId();
      await db.postMedia.insertOne({ _id, userId, postId: null, ...photo, createdAt: new Date() });
      void sweepStaleUploads(db, userId);
      return reply.status(201).send(ok(request, { id: _id.toHexString(), ...photoView(photo) }));
    },
  );

  async function sweepStaleUploads(db: Database, userId: ObjectId) {
    try {
      const stale = await db.postMedia
        .find({ userId, postId: null, createdAt: { $lt: new Date(Date.now() - STALE_UPLOAD_MS) } }, { projection: { key: 1, smaller: 1 } })
        .limit(20)
        .toArray();
      await Promise.all(stale.flatMap(keysOf).map((key) => app.media.remove(key)));
      if (stale.length) await db.postMedia.deleteMany({ _id: { $in: stale.map((m) => m._id) }, postId: null });
    } catch (err) {
      app.log.warn({ err: (err as Error).message }, "Unused post photos not swept");
    }
  }

  app.post(
    "/posts",
    {
      preHandler: requireAuth,
      config: limit(60, 30),
      schema: {
        tags: ["social"],
        summary: "Make a post: text, up to 4 photos, or both",
        description:
          "Upload photos first with POST /media. `kind: business` is for vendors from the vendor portal, and for people on a business's " +
          'team with "Post as the business", from Work; theirs is posted as the owner.',
        body: PostCreate,
        response: { 201: PostResult, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const db = requireDatabase(app.db);
      const auth = request.auth!;
      const text = tidy(request.body.text);
      const mediaIds = (request.body.mediaIds ?? []).map((id) => new ObjectId(id));
      const kind = request.body.kind ?? "personal";
      if (!text && mediaIds.length === 0) {
        throw new AppError("VALIDATION_FAILED", "Write something or add a photo.", [{ path: "body/text", message: "Empty post" }]);
      }
      const as = kind === "business" ? await businessFor(db, auth, request.body.businessId) : null;
      const businessId = as?.businessId ?? null;
      const authorId = as?.authorId ?? auth.userId;

      const postId = new ObjectId();
      let media: WithId<PostMediaDoc>[] = [];
      if (mediaIds.length) {
        // A photo's files never change once uploaded, so they are read while the claim decides who gets it.
        const [claimed, found] = await Promise.all([
          db.postMedia.updateMany({ _id: { $in: mediaIds }, userId: auth.userId, postId: null }, { $set: { postId } }),
          db.postMedia.find({ _id: { $in: mediaIds }, userId: auth.userId }).toArray(),
        ]);
        if (claimed.modifiedCount !== mediaIds.length) {
          await db.postMedia.updateMany({ postId }, { $set: { postId: null } });
          throw new AppError("VALIDATION_FAILED", "Some photos are no longer available. Add them again.", [
            { path: "body/mediaIds", message: "Unknown or used photo" },
          ]);
        }
        media = found;
      }
      const byId = new Map(media.map((m) => [m._id.toHexString(), m]));
      const now = new Date();
      const doc: PostDoc = {
        _id: postId,
        authorId,
        kind,
        ...(businessId ? { businessId } : {}),
        text,
        media: mediaIds.map((id) => {
          const { key, url, width, height, smaller } = byId.get(id.toHexString())!;
          return { key, url, width, height, ...(smaller ? { smaller } : {}) };
        }),
        counts: { likes: 0, comments: 0 },
        status: "live",
        editedAt: null,
        ...stamp(now),
      };
      // The author's details are read while the post is saved; the count only moves once it is.
      const [, [post]] = await Promise.all([
        db.posts.insertOne(doc).then(() => db.users.updateOne({ _id: authorId }, { $inc: { "social.posts": 1 } })),
        present(db, [doc], auth.userId),
      ]);
      if (businessId && !authorId.equals(auth.userId)) {
        await writeAudit(db, {
          actor: actorOf(request),
          scope: { module: "social", businessId },
          action: "post.create",
          target: { type: "post", id: postId },
          ip: request.ip,
        });
      }
      // After the answer: people mentioned hear about it on their notifications screen, and then the followers who were not already told.
      void notifyMentions(db, app.log, { text, actor: { id: authorId }, postId })
        .then((told) => notifyFollowersOfPost(db, app.log, { authorId, businessId, postId, text, hasPhotos: media.length > 0, skip: told }));
      return reply.status(201).send(ok(request, post!));
    },
  );

  app.patch(
    "/posts/:id",
    {
      preHandler: requireAuth,
      config: limit(10, 30),
      schema: {
        tags: ["social"],
        summary: "Change the text of your post",
        params: IdParams,
        body: PostPatch,
        response: { 200: PostResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const db = requireDatabase(app.db);
      const userId = request.auth!.userId;
      const post = await livePost(db, request.params.id);
      if (!post.authorId.equals(userId)) throw new AppError("FORBIDDEN", "You can only edit your own posts.");
      const text = tidy(request.body.text);
      if (!text && post.media.length === 0) {
        throw new AppError("VALIDATION_FAILED", "Write something, or delete the post.", [{ path: "body/text", message: "Empty post" }]);
      }
      const now = new Date();
      const updated = await db.posts.findOneAndUpdate(
        { _id: post._id, status: "live" },
        { $set: { text, editedAt: now, updatedAt: now } },
        { returnDocument: "after" },
      );
      if (!updated) throw removed();
      const [view] = await present(db, [updated], userId);
      return ok(request, view!);
    },
  );

  app.delete(
    "/posts/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["social"],
        summary: "Delete your post, its photos, likes, saves and comments",
        params: IdParams,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const db = requireDatabase(app.db);
      const userId = request.auth!.userId;
      const post = await livePost(db, request.params.id);
      if (!post.authorId.equals(userId)) throw new AppError("FORBIDDEN", "You can only delete your own posts.");
      const gone = await db.posts.findOneAndUpdate(
        { _id: post._id, status: "live" },
        { $set: { status: "deleted", media: [], updatedAt: new Date() } },
        { returnDocument: "before" },
      );
      if (!gone) throw removed();
      await clearPost(app, db, gone);
      return ok(request, { done: true as const });
    },
  );

  // `params` is checked by IdParams in the route schema.
  const react = (kind: "like" | "save", on: boolean) => async (request: FastifyRequest) => {
    const db = requireDatabase(app.db);
    const userId = request.auth!.userId;
    const post = await livePost(db, (request.params as { id: string }).id);
    if (on) await assertNotBlocked(db, userId, post.authorId);
    let changed = false;
    if (on) {
      try {
        await db.postReactions.insertOne({ postId: post._id, userId, kind, createdAt: new Date() });
        changed = true;
      } catch (err) {
        if (!isDuplicate(err)) throw err;
      }
    } else {
      changed = (await db.postReactions.deleteOne({ postId: post._id, userId, kind })).deletedCount === 1;
    }
    if (kind === "save") return ok(request, { savedByMe: on });

    let likes = post.counts.likes;
    if (changed) {
      const step = on ? 1 : -1;
      const [after] = await Promise.all([
        db.posts.findOneAndUpdate({ _id: post._id }, { $inc: { "counts.likes": step } }, { returnDocument: "after", projection: { counts: 1 } }),
        db.users.updateOne({ _id: post.authorId }, { $inc: { "social.engagements": step } }),
      ]);
      likes = after?.counts.likes ?? likes + step;
      if (on) void notifyPostEvent(db, app.log, { type: "post.like", to: post.authorId, actor: { id: userId }, postId: post._id });
    }
    return ok(request, { likes, likedByMe: on });
  };

  for (const [kind, Result] of [["like", LikeState], ["save", SaveState]] as const) {
    const schema = (summary: string) => ({ tags: ["social"], summary, params: IdParams, response: { 200: Result, ...Errors }, security });
    app.put(`/posts/:id/${kind}`, { preHandler: requireAuth, config: limit(1, 120), schema: schema(kind === "like" ? "Like a post" : "Save a post") }, react(kind, true));
    app.delete(`/posts/:id/${kind}`, { preHandler: requireAuth, config: limit(1, 120), schema: schema(kind === "like" ? "Take back a like" : "Remove from saved") }, react(kind, false));
  }

  app.get(
    "/posts/:id/comments",
    {
      preHandler: signedInIfPossible,
      schema: {
        tags: ["social"],
        summary: "A post's comments, newest first",
        description: "No sign-in needed.",
        params: IdParams,
        querystring: Page,
        response: { 200: CommentList, ...Errors },
        security: signedInOrNot,
      },
    },
    async (request, reply) => {
      const db = requireDatabase(app.db);
      const post = await livePost(db, request.params.id);
      if (await blockBetween(db, me(request), post.authorId)) throw new AppError("NOT_FOUND", "This post isn't available.");
      const hidden = await blockedAround(db, me(request));
      const { items, nextCursor } = await findPage(db.postComments, {
        filter: { postId: post._id, status: "live", ...(hidden.length ? { authorId: { $nin: hidden } } : {}) },
        sortField: "createdAt",
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      publicCache(request, reply);
      return page(request, await presentComments(db, items, me(request)), nextCursor);
    },
  );

  app.post(
    "/posts/:id/comments",
    {
      preHandler: requireAuth,
      config: limit(10, 40),
      schema: {
        tags: ["social"],
        summary: "Comment on a post",
        params: IdParams,
        body: CommentCreate,
        response: { 201: CommentResult, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const db = requireDatabase(app.db);
      const userId = request.auth!.userId;
      const text = tidy(request.body.text);
      if (!text) throw new AppError("VALIDATION_FAILED", "Write a comment first.", [{ path: "body/text", message: "Empty comment" }]);
      const post = await livePost(db, request.params.id);
      await assertNotBlocked(db, userId, post.authorId);
      const doc: PostCommentDoc = { _id: new ObjectId(), postId: post._id, authorId: userId, text, status: "live", ...stamp() };
      const [, [comment]] = await Promise.all([
        db.postComments.insertOne(doc).then(() =>
          Promise.all([
            db.posts.updateOne({ _id: post._id }, { $inc: { "counts.comments": 1 } }),
            db.users.updateOne({ _id: post.authorId }, { $inc: { "social.engagements": 1 } }),
          ]),
        ),
        presentComments(db, [doc], userId),
      ]);
      void notifyPostEvent(db, app.log, { type: "post.comment", to: post.authorId, actor: { id: userId, name: comment!.author.name }, postId: post._id, excerpt: text });
      void notifyMentions(db, app.log, { text, actor: { id: userId, name: comment!.author.name }, postId: post._id, skip: [post.authorId] });
      return reply.status(201).send(ok(request, comment!));
    },
  );

  app.delete(
    "/comments/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["social"],
        summary: "Delete a comment: your own, or any on your post",
        params: IdParams,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const db = requireDatabase(app.db);
      const userId = request.auth!.userId;
      const comment = await db.postComments.findOne({ _id: new ObjectId(request.params.id), status: "live" });
      if (!comment) throw new AppError("NOT_FOUND", "This comment was removed.");
      const post = await db.posts.findOne({ _id: comment.postId }, { projection: { authorId: 1, status: 1 } });
      if (!comment.authorId.equals(userId) && !post?.authorId.equals(userId)) throw new AppError("FORBIDDEN", "You can only delete your own comments.");
      const result = await db.postComments.updateOne({ _id: comment._id, status: "live" }, { $set: { status: "deleted", updatedAt: new Date() } });
      if (result.modifiedCount === 1 && post?.status === "live") {
        await Promise.all([
          db.posts.updateOne({ _id: comment.postId }, { $inc: { "counts.comments": -1 } }),
          db.users.updateOne({ _id: post.authorId }, { $inc: { "social.engagements": -1 } }),
        ]);
      }
      return ok(request, { done: true as const });
    },
  );

  app.post(
    "/posts/:id/report",
    {
      preHandler: requireAuth,
      config: limit(60, 30),
      schema: {
        tags: ["social"],
        summary: "Report a post to Ruxstar",
        description: "Reporting the same post again changes nothing.",
        params: IdParams,
        body: ReportBody,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const db = requireDatabase(app.db);
      const post = await livePost(db, request.params.id);
      await db.reports.updateOne(
        { "target.id": post._id, userId: request.auth!.userId },
        {
          $setOnInsert: {
            "target.type": "post",
            reason: request.body.reason as never,
            status: "open",
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );
      return ok(request, { done: true as const });
    },
  );
};

export default social;
