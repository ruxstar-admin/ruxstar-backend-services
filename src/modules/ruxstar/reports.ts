import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId, type Document } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, writeAudit } from "../../platform/audit.js";
import { requireRuxstar } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { ReportReason } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { DEFAULT_LIMIT, MAX_LIMIT, decodeCursor, encodeCursor } from "../../platform/pagination.js";
import { notifyPostRemoved } from "../notifications/notify.js";
import { notifyReportResolved } from "../notifications/notify-posts.js";
import { clearPost } from "../social/takedown.js";
import { RemoveBody, ReportList, ReportOne, ReportParams, ReportsQuery, type ReportCase } from "./contracts.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

interface Group {
  _id: ObjectId;
  reports: number;
  reasons: ReportReason[];
  firstAt: Date;
  lastAt: Date;
  closings: { at?: Date; outcome?: "kept" | "removed" }[];
  key: Date;
}

/** Reported posts, one row per post. Open rows sort by the latest report, closed ones by when they were decided. */
const reports: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  async function groups(status: "open" | "closed", match: Document, cursor: string | undefined, limit: number) {
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await db()
      .reports.aggregate<Group>([
        { $match: { status, ...match } },
        {
          $group: {
            _id: "$target.id",
            reports: { $sum: 1 },
            reasons: { $push: "$reason" },
            firstAt: { $min: "$createdAt" },
            lastAt: { $max: "$createdAt" },
            closings: { $push: { at: "$closedAt", outcome: "$outcome" } },
          },
        },
        { $addFields: { key: status === "open" ? "$lastAt" : { $max: "$closings.at" } } },
        ...(after ? [{ $match: { $or: [{ key: { $lt: after.value } }, { key: after.value, _id: { $lt: after.id } }] } }] : []),
        { $sort: { key: -1, _id: -1 } },
        { $limit: limit + 1 },
      ])
      .toArray();
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items: await present(status, items), nextCursor: rows.length > limit && last ? encodeCursor(last.key, last._id) : null };
  }

  async function present(status: "open" | "closed", rows: Group[]): Promise<ReportCase[]> {
    const posts = await db()
      .posts.find({ _id: { $in: rows.map((r) => r._id) } })
      .toArray();
    const authors = await db()
      .users.find({ _id: { $in: posts.map((p) => p.authorId) } }, { projection: { name: 1, username: 1, avatar: 1, status: 1 } })
      .toArray();
    return rows.map((row) => {
      const post = posts.find((p) => p._id.equals(row._id));
      const author = post && authors.find((a) => a._id.equals(post.authorId));
      const reasons = { spam: 0, fake: 0, abuse: 0, undelivered: 0, other: 0 };
      for (const r of row.reasons) reasons[r] = (reasons[r] ?? 0) + 1;
      const latest = row.closings.filter((c) => c.at).sort((a, b) => b.at!.getTime() - a.at!.getTime())[0];
      return {
        postId: row._id.toHexString(),
        post: post
          ? {
              id: post._id.toHexString(),
              kind: post.kind,
              text: post.text,
              media: post.media.map((m) => ({ url: m.url, width: m.width, height: m.height })),
              status: post.status,
              createdAt: post.createdAt.toISOString(),
              author: author
                ? {
                    id: author._id.toHexString(),
                    name: author.name ?? "",
                    username: author.username ?? "",
                    avatarUrl: author.avatar ?? null,
                    status: author.status,
                  }
                : null,
              removal: post.removal ? { reason: post.removal.reason, at: post.removal.at.toISOString() } : null,
            }
          : null,
        status,
        reports: row.reports,
        reasons,
        firstAt: row.firstAt.toISOString(),
        lastAt: row.lastAt.toISOString(),
        outcome: latest?.outcome ?? null,
        closedAt: latest?.at?.toISOString() ?? null,
      };
    });
  }

  async function closedCase(postId: ObjectId): Promise<ReportCase | null> {
    const { items } = await groups("closed", { "target.id": postId }, undefined, 1);
    return items[0] ?? null;
  }

  app.get(
    "/reports",
    {
      preHandler: requireRuxstar("reports.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "Reported posts, one row per post",
        description: "`open` (the default) is waiting for a decision, newest report first. `closed` is decided, newest decision first.",
        querystring: ReportsQuery,
        response: { 200: ReportList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { status = "open", cursor, limit } = request.query;
      const { items, nextCursor } = await groups(status, {}, cursor, Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT));
      return page(request, items, nextCursor);
    },
  );

  app.post(
    "/reports/:postId/keep",
    {
      preHandler: [requireRuxstar("reports.act"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Keep a reported post up and close its reports",
        description: "Anyone who has not reported it yet can still report it later.",
        params: ReportParams,
        response: { 200: ReportOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const postId = new ObjectId(request.params.postId);
      const actor = actorOf(request);
      const reporters = await database.transaction(async (session) => {
        const now = new Date();
        const open = await database.reports.find({ "target.id": postId, status: "open" }, { session, projection: { userId: 1 } }).toArray();
        const { modifiedCount } = await database.reports.updateMany(
          { "target.id": postId, status: "open" },
          { $set: { status: "closed", outcome: "kept", closedBy: request.auth!.userId, closedAt: now } },
          { session },
        );
        if (modifiedCount === 0) throw new AppError("CONFLICT", "Nothing is waiting on this post.");
        await writeAudit(
          database,
          { actor, scope: { module: "social" }, action: "report.keep", target: { type: "post", id: postId }, diff: { openReports: { from: modifiedCount, to: 0 } }, ip: request.ip },
          session,
        );
        return open.map((r) => r.userId);
      });
      await notifyReportResolved(database, app.log, { to: reporters, moderator: request.auth!.userId, postId, outcome: "kept" });
      return ok(request, (await closedCase(postId))!);
    },
  );

  app.post(
    "/reports/:postId/remove",
    {
      preHandler: [requireRuxstar("reports.act"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Take a post down and close its reports",
        description: "The post's photos, likes, saves and comments are deleted, and the author is told why. This can't be undone.",
        params: ReportParams,
        body: RemoveBody,
        response: { 200: ReportOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const postId = new ObjectId(request.params.postId);
      const reason = request.body.reason.trim();
      const actor = actorOf(request);
      const me = request.auth!.userId;

      const removed = await database.transaction(async (session) => {
        const now = new Date();
        const before = await database.posts.findOneAndUpdate(
          { _id: postId, status: "live" },
          { $set: { status: "removed", media: [], removal: { by: me, at: now, reason }, updatedAt: now } },
          { session, returnDocument: "before" },
        );
        if (!before) {
          const exists = await database.posts.findOne({ _id: postId }, { session, projection: { _id: 1 } });
          throw exists ? new AppError("CONFLICT", "This post is no longer up.") : new AppError("NOT_FOUND", "Post not found.");
        }
        const open = await database.reports.find({ "target.id": postId, status: "open" }, { session, projection: { userId: 1 } }).toArray();
        await database.reports.updateMany(
          { "target.id": postId, status: "open" },
          { $set: { status: "closed", outcome: "removed", closedBy: me, closedAt: now } },
          { session },
        );
        await writeAudit(
          database,
          {
            actor,
            scope: { module: "social" },
            action: "post.remove",
            target: { type: "post", id: postId },
            diff: { status: { from: "live", to: "removed" }, reason: { from: null, to: reason } },
            ip: request.ip,
          },
          session,
        );
        return { before, reporters: open.map((r) => r.userId) };
      });

      const gone = removed.before;
      await clearPost(app, database, gone);
      await notifyPostRemoved(database, app.log, { to: gone.authorId, moderator: me, postId, reason });
      await notifyReportResolved(database, app.log, { to: removed.reporters, moderator: me, postId, outcome: "removed" });
      const decided = await closedCase(postId);
      if (decided) return ok(request, decided);
      // Taken down without being reported: a closed case with no reports.
      const at = gone.createdAt;
      const [view] = await present("closed", [{ _id: postId, reports: 0, reasons: [], firstAt: at, lastAt: at, closings: [{ at: new Date(), outcome: "removed" }], key: at }]);
      return ok(request, view!);
    },
  );
};

export default reports;
