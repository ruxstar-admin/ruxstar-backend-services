import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Errors } from "../../contracts/common.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import { ok } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { SWITCHABLE_MODULES } from "../../platform/indexes.js";
import { AccessResult, OverviewResult } from "./contracts.js";
import { accessOf, PERMISSIONS, type Permission } from "./permissions.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const WEEK_MS = 7 * 24 * 60 * 60_000;

/** The console's front door: what you may see, and the counts on its home page. */
const consoleHome: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  app.get(
    "/access",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["ruxstar"],
        summary: "What you may do in the Ruxstar console",
        description: "FORBIDDEN for anyone who is not an admin or active Ruxstar staff.",
        response: { 200: AccessResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const access = await accessOf(request);
      if (!access) throw new AppError("FORBIDDEN");
      return ok(request, { ...access, catalog: PERMISSIONS.map((p) => ({ key: p.key, label: p.label })) });
    },
  );

  app.get(
    "/overview",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["ruxstar"],
        summary: "Counts for the console home page",
        description: "Each section needs its view permission; staff numbers are for admins.",
        response: { 200: OverviewResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const access = await accessOf(request);
      if (!access) throw new AppError("FORBIDDEN");
      const can = (p: Permission) => access.permissions.includes(p);
      const d = db();
      const when = <T>(allowed: boolean, work: () => Promise<T>) => (allowed ? work() : Promise.resolve(null));

      const [kyc, reports, users, businesses, modules, orders, staff] = await Promise.all([
        when(can("kyc.view"), async () => {
          const [identity, delivery] = await Promise.all([
            d.kycCases.countDocuments({ status: "submitted", track: "base" }),
            d.kycCases.countDocuments({ status: "submitted", track: "delivery" }),
          ]);
          return { waiting: identity + delivery, delivery };
        }),
        when(can("reports.view"), async () => {
          const [[row], people, reviews] = await Promise.all([
            d.reports
              .aggregate<{ posts: number; reports: number }>([
                { $match: { status: "open" } },
                { $group: { _id: "$target.id", n: { $sum: 1 } } },
                { $group: { _id: null, posts: { $sum: 1 }, reports: { $sum: "$n" } } },
              ])
              .toArray(),
            d.userReports.distinct("userId", { status: "open" }),
            d.reviewReports.distinct("reviewId", { status: "open" }),
          ]);
          return { posts: row?.posts ?? 0, reports: row?.reports ?? 0, people: people.length, reviews: reviews.length };
        }),
        when(can("users.view"), async () => {
          const [total, newThisWeek, suspended] = await Promise.all([
            d.users.countDocuments({ status: { $ne: "deleted" } }),
            d.users.countDocuments({ status: { $ne: "deleted" }, createdAt: { $gte: new Date(Date.now() - WEEK_MS) } }),
            d.users.countDocuments({ status: "locked" }),
          ]);
          return { total, newThisWeek, suspended };
        }),
        when(can("businesses.view"), async () => {
          const [total, live, suspended] = await Promise.all([
            d.businesses.estimatedDocumentCount(),
            d.businesses.countDocuments({ status: "live", suspension: { $exists: false } }),
            d.businesses.countDocuments({ suspension: { $exists: true } }),
          ]);
          return { total, live, suspended };
        }),
        when(can("modules.view"), async () => {
          const docs = await d.moduleSettings.find({}, { projection: { module: 1, live: 1 } }).toArray();
          return SWITCHABLE_MODULES.map((module) => ({ module, live: docs.find((m) => m.module === module)?.live ?? false }));
        }),
        when(can("orders.view"), async () => ({ problems: await d.podOrders.countDocuments({ "problem.status": "open" }) })),
        when(access.admin, async () => ({ active: await d.ruxstarStaff.countDocuments({ status: "active" }) })),
      ]);
      return ok(request, { kyc, reports, users, businesses, modules, orders, staff });
    },
  );
};

export default consoleHome;
