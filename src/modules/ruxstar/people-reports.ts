import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId, type Document } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, writeAudit } from "../../platform/audit.js";
import { requireRuxstar } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { UserReportReason } from "../../platform/db.js";
import { page, ok } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { DEFAULT_LIMIT, MAX_LIMIT, decodeCursor, encodeCursor } from "../../platform/pagination.js";
import { PersonCaseList, PersonCaseOne, PersonCaseParams, ReportsQuery, type PersonCase } from "./contracts.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

interface Group {
  _id: ObjectId;
  reports: number;
  reasons: UserReportReason[];
  notes: { at: Date; note: string }[];
  firstAt: Date;
  lastAt: Date;
  closings: { at?: Date; outcome?: "dismissed" | "held" }[];
  key: Date;
}

/** Reported people, one row per person. Putting their account on hold closes these as `held`. */
const peopleReports: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  async function groups(status: "open" | "closed", match: Document, cursor: string | undefined, limit: number) {
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await db()
      .userReports.aggregate<Group>([
        { $match: { status, ...match } },
        {
          $group: {
            _id: "$userId",
            reports: { $sum: 1 },
            reasons: { $push: "$reason" },
            notes: { $push: { at: "$createdAt", note: "$note" } },
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

  async function present(status: "open" | "closed", rows: Group[]): Promise<PersonCase[]> {
    const people = await db()
      .users.find({ _id: { $in: rows.map((r) => r._id) } }, { projection: { name: 1, username: 1, avatar: 1, status: 1, deletion: 1 } })
      .toArray();
    return rows.map((row) => {
      const user = people.find((u) => u._id.equals(row._id));
      const reasons = { spam: 0, fake: 0, abuse: 0, scam: 0, other: 0 };
      for (const r of row.reasons) reasons[r] = (reasons[r] ?? 0) + 1;
      const latest = row.closings.filter((c) => c.at).sort((a, b) => b.at!.getTime() - a.at!.getTime())[0];
      return {
        userId: row._id.toHexString(),
        user: user
          ? {
              id: user._id.toHexString(),
              name: user.name ?? "",
              username: user.username ?? user.deletion?.username ?? "",
              avatarUrl: user.avatar ?? null,
              status: user.status,
            }
          : null,
        status,
        reports: row.reports,
        reasons,
        notes: row.notes
          .filter((n) => n.note)
          .sort((a, b) => b.at.getTime() - a.at.getTime())
          .slice(0, 5)
          .map((n) => n.note),
        firstAt: row.firstAt.toISOString(),
        lastAt: row.lastAt.toISOString(),
        outcome: latest?.outcome ?? null,
        closedAt: latest?.at?.toISOString() ?? null,
      };
    });
  }

  app.get(
    "/reports/people",
    {
      preHandler: requireRuxstar("reports.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "Reported people, one row per person",
        description: "`open` (the default) is waiting for a decision, newest report first. `closed` is decided, newest decision first.",
        querystring: ReportsQuery,
        response: { 200: PersonCaseList, ...Errors },
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
    "/reports/people/:userId/dismiss",
    {
      preHandler: [requireRuxstar("reports.act"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Close the reports about someone without acting on their account",
        description: "To act on the account, put it on hold from People; that closes these reports too.",
        params: PersonCaseParams,
        response: { 200: PersonCaseOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const userId = new ObjectId(request.params.userId);
      const actor = actorOf(request);
      await database.transaction(async (session) => {
        const { modifiedCount } = await database.userReports.updateMany(
          { userId, status: "open" },
          { $set: { status: "closed", outcome: "dismissed", closedBy: request.auth!.userId, closedAt: new Date() } },
          { session },
        );
        if (modifiedCount === 0) throw new AppError("CONFLICT", "Nothing is waiting on this person.");
        await writeAudit(
          database,
          { actor, scope: { module: "social" }, action: "user_report.dismiss", target: { type: "user", id: userId }, diff: { openReports: { from: modifiedCount, to: 0 } }, ip: request.ip },
          session,
        );
      });
      const { items } = await groups("closed", { userId }, undefined, 1);
      return ok(request, items[0]!);
    },
  );
};

export default peopleReports;
