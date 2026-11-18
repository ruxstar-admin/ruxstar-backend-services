import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { Collection, Document, Filter } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { Database, LedgerEntryDoc } from "../../platform/db.js";
import { ok } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { StatsQuery, StatsResult, type StatsData, type StatsModule } from "./contracts.js";
import { accessOf, type Permission } from "./permissions.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const DAY_MS = 24 * 60 * 60_000;
const IST_MS = 5.5 * 60 * 60_000;
/** How long one server keeps a number before counting it again. */
export const STATS_TTL_MS = 60_000;

const MODULES: readonly StatsModule[] = ["pod", "events", "coaching", "turf", "stays", "shop", "gigs", "delivery"];
/** Freelance orders paid and not yet completed or cancelled. */
export const OPEN_GIG_ORDERS = ["paid", "in_progress", "delivered", "disputed"] as const;
type BusinessModule = Exclude<StatsModule, "delivery">;
type ModuleBlock = StatsData["modules"][number];
type Money = NonNullable<ModuleBlock["money"]>;
type Flows = Omit<Money, "held">;
type PayoutTotals = NonNullable<StatsData["money"]>["payouts"];

const SOURCE_MODULE: Record<LedgerEntryDoc["source"]["type"], BusinessModule | null> = {
  pod_order: "pod",
  event_order: "events",
  coaching_order: "coaching",
  turf_booking: "turf",
  stay_reservation: "stays",
  shop_order: "shop",
  gig_order: "gigs",
  payout: null,
};

export interface Periods {
  today: Date;
  week: Date;
  month: Date;
}

/** Midnight in India today, on this week's Monday and on the 1st of this month, as moments. India has no daylight saving. */
export function indiaPeriods(now = new Date()): Periods {
  const local = new Date(now.getTime() + IST_MS);
  const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - IST_MS;
  const sinceMonday = (local.getUTCDay() + 6) % 7;
  return {
    today: new Date(today),
    week: new Date(today - sinceMonday * DAY_MS),
    month: new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - IST_MS),
  };
}

/**
 * Numbers by what they count, never by who asked: each request picks the ones its permissions allow. A failed count is
 * dropped at once so the next request tries again; requests during a count share it.
 */
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

/** Forgets every kept number. */
export const forgetStats = () => cache.clear();

function cached<T>(key: string, now: number, work: () => Promise<T>): { at: number; value: Promise<T> } {
  const hit = cache.get(key);
  if (hit && now - hit.at < STATS_TTL_MS) return hit as { at: number; value: Promise<T> };
  const entry = { at: now, value: work() };
  cache.set(key, entry);
  entry.value.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return entry;
}

async function people(d: Database, p: Periods): Promise<NonNullable<StatsData["people"]>> {
  const notDeleted = { $in: ["active", "locked"] as ("active" | "locked")[] };
  const [total, joinedToday, joinedThisWeek, verified, onHold] = await Promise.all([
    d.users.countDocuments({ status: notDeleted }),
    d.users.countDocuments({ createdAt: { $gte: p.today }, status: notDeleted }),
    d.users.countDocuments({ createdAt: { $gte: p.week }, status: notDeleted }),
    d.users.countDocuments({ "kyc.base": "approved", status: notDeleted }),
    d.users.countDocuments({ status: "locked" }),
  ]);
  return { total, joinedToday, joinedThisWeek, verified, onHold };
}

async function businesses(d: Database, module: BusinessModule): Promise<NonNullable<ModuleBlock["businesses"]>> {
  const held = { $exists: true };
  const [total, live, liveHeld, drafts, takenDown] = await Promise.all([
    d.businesses.countDocuments({ module }),
    d.businesses.countDocuments({ module, status: "live" }),
    d.businesses.countDocuments({ module, status: "live", suspension: held }),
    d.businesses.countDocuments({ module, status: "draft" }),
    d.businesses.countDocuments({ module, suspension: held }),
  ]);
  return { total, live: live - liveHeld, drafts, takenDown };
}

async function listings(d: Database, module: StatsModule): Promise<ModuleBlock["listings"]> {
  const pair = async (kind: NonNullable<ModuleBlock["listings"]>["kind"], live: Promise<number>, takenDown: Promise<number>) => ({
    kind,
    live: await live,
    takenDown: await takenDown,
  });
  switch (module) {
    case "events":
      return pair("event", d.events.countDocuments({ status: "live" }), d.events.countDocuments({ status: "cancelled", "cancellation.by": "staff" }));
    case "coaching":
      return pair("course", d.coachingCourses.countDocuments({ status: "live" }), d.coachingCourses.countDocuments({ status: "removed" }));
    case "turf":
      return pair("ground", d.turfGrounds.countDocuments({ status: "live" }), d.turfGrounds.countDocuments({ status: "removed" }));
    case "stays":
      return pair("property", d.staysProperties.countDocuments({ status: "live" }), d.staysProperties.countDocuments({ status: "removed" }));
    case "shop":
      return pair("product", d.shopProducts.countDocuments({ status: "live" }), d.shopProducts.countDocuments({ status: "removed" }));
    case "gigs":
      return pair("gig", d.gigs.countDocuments({ status: "live" }), d.gigs.countDocuments({ status: "removed" }));
    default:
      return null;
  }
}

/** Paid, or free: free tickets and classes have no payment. Unpaid checkouts never count. */
const PAID_OR_FREE = { $or: [{ "payment.paidAt": { $type: "date" } }, { payment: null }] };

/** Placed today and this week, from the `createdAt` index; at most a week of documents is read. */
async function placed<T extends Document>(collection: Collection<T>, p: Periods, filter: Document = PAID_OR_FREE) {
  const [row] = await collection
    .aggregate<{ today: number; thisWeek: number }>([
      { $match: { createdAt: { $gte: p.week }, ...filter } },
      { $group: { _id: null, thisWeek: { $sum: 1 }, today: { $sum: { $cond: [{ $gte: ["$createdAt", p.today] }, 1, 0] } } } },
    ])
    .toArray();
  return { today: row?.today ?? 0, thisWeek: row?.thisWeek ?? 0 };
}

async function openCount(d: Database, module: StatsModule, now: Date): Promise<number> {
  switch (module) {
    case "pod":
      return d.podOrders.countDocuments({ status: { $in: ["placed", "accepted", "printing", "ready", "out_for_delivery"] } });
    case "events":
      return d.eventOrders.countDocuments({ status: "confirmed", endsAt: { $gt: now } });
    case "coaching": {
      const running = await d.coachingBatches.distinct("_id", { status: "live", certificatesAt: null, lastEndsAt: { $gt: now } });
      return running.length ? d.coachingOrders.countDocuments({ batchId: { $in: running }, status: "confirmed", kind: "batch" }) : 0;
    }
    case "turf":
      return d.turfBookings.countDocuments({ status: "confirmed", lastEndsAt: { $gt: now } });
    case "stays":
      return d.staysReservations.countDocuments({ status: { $in: ["confirmed", "moved_in"] } });
    case "shop":
      return d.shopOrders.countDocuments({ status: { $in: ["paid", "accepted", "packed", "out_for_delivery", "ready_for_pickup"] } });
    case "gigs":
      return d.gigOrders.countDocuments({ status: { $in: [...OPEN_GIG_ORDERS] } });
    case "delivery":
      return d.deliveryJobs.countDocuments({ status: { $in: ["offered", "accepted", "picked_up"] } });
  }
}

async function orders(d: Database, module: StatsModule, p: Periods, now: Date): Promise<NonNullable<ModuleBlock["orders"]>> {
  const counts = () => {
    switch (module) {
      case "pod":
        return placed(d.podOrders, p);
      case "events":
        return placed(d.eventOrders, p);
      case "coaching":
        return placed(d.coachingOrders, p);
      case "turf":
        return placed(d.turfBookings, p);
      case "stays":
        return placed(d.staysReservations, p);
      case "shop":
        return placed(d.shopOrders, p);
      case "gigs":
        return placed(d.gigOrders, p, { "payment.paidAt": { $type: "date" } });
      case "delivery":
        return placed(d.deliveryJobs, p, {});
    }
  };
  const [{ today, thisWeek }, open] = await Promise.all([counts(), openCount(d, module, now)]);
  return { today, thisWeek, open };
}

const NO_FLOWS: Flows = { collectedToday: 0, collectedThisWeek: 0, collectedThisMonth: 0, refundsToday: 0, refundsThisMonth: 0 };

/**
 * Money in and back out through the gateway, per module, from the ledger: a payment's gateway entry is minus what the
 * customer paid, a refund's is plus what went back. Reads only the gateway's entries since the week or month began.
 */
async function flows(d: Database, p: Periods): Promise<Partial<Record<BusinessModule, Flows>>> {
  const since = (kind: "payment" | "refund", from: Date) => ({
    $sum: {
      $cond: [{ $and: [{ $eq: ["$kind", kind] }, { $gte: ["$at", from] }] }, kind === "payment" ? { $subtract: [0, "$signedPaise"] } : "$signedPaise", 0],
    },
  });
  const rows = await d.ledgerEntries
    .aggregate<Flows & { _id: LedgerEntryDoc["source"]["type"] }>([
      { $match: { accountId: "gateway", kind: { $in: ["payment", "refund"] }, at: { $gte: p.week < p.month ? p.week : p.month } } },
      {
        $group: {
          _id: "$source.type",
          collectedToday: since("payment", p.today),
          collectedThisWeek: since("payment", p.week),
          collectedThisMonth: since("payment", p.month),
          refundsToday: since("refund", p.today),
          refundsThisMonth: since("refund", p.month),
        },
      },
    ])
    .toArray();
  const out: Partial<Record<BusinessModule, Flows>> = {};
  for (const { _id, ...row } of rows) {
    const module = SOURCE_MODULE[_id];
    if (module) out[module] = row;
  }
  return out;
}

/** Vendors' and partners' pending balances by module. Released and refunded orders net to zero, so this is what's still held. */
async function held(d: Database): Promise<Partial<Record<BusinessModule, number>>> {
  const rows = await d.ledgerEntries
    .aggregate<{ _id: LedgerEntryDoc["source"]["type"]; held: number }>(
      [{ $match: { bucket: "pending", accountId: { $ne: "ruxstar" } } }, { $group: { _id: "$source.type", held: { $sum: "$signedPaise" } } }],
      { hint: "pending_by_source" },
    )
    .toArray();
  const out: Partial<Record<BusinessModule, number>> = {};
  for (const row of rows) {
    const module = SOURCE_MODULE[row._id];
    if (module) out[module] = Math.max(0, row.held);
  }
  return out;
}

async function payouts(d: Database, p: Periods): Promise<PayoutTotals> {
  const total = (status: "pending" | "failed" | "paid", extra: Filter<Document> = {}) =>
    d.payouts
      .aggregate<{ count: number; amount: number }>(
        [{ $match: { status, ...extra } }, { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$amount" } } }],
        { hint: "payout_totals" },
      )
      .toArray()
      .then(([row]) => ({ count: row?.count ?? 0, amount: row?.amount ?? 0 }));
  const [pending, failed, paidThisMonth] = await Promise.all([total("pending"), total("failed"), total("paid", { paidAt: { $gte: p.month } })]);
  return { pending, failed, paidThisMonth };
}

const QUEUES = {
  kyc: (d: Database) => d.kycCases.countDocuments({ status: "submitted" }),
  helpTickets: (d: Database) => d.supportTickets.countDocuments({ status: "open" }),
  reports: async (d: Database) => {
    const counts = await Promise.all([
      d.reports.countDocuments({ status: "open" }),
      d.userReports.countDocuments({ status: "open" }),
      d.reviewReports.countDocuments({ status: "open" }),
    ]);
    return counts.reduce((a, b) => a + b, 0);
  },
  orderProblems: (d: Database) => d.podOrders.countDocuments({ "problem.status": "open" }),
  staysObjections: (d: Database) => d.staysReservations.countDocuments({ "objection.status": "open" }),
  shopReturns: (d: Database) => d.shopOrders.countDocuments({ "return.status": { $type: "string", $in: ["requested", "approved"] } }),
  gigDisputes: (d: Database) => d.gigOrders.countDocuments({ status: "disputed" }),
} as const;

const QUEUE_PERMISSION: Record<keyof typeof QUEUES, Permission> = {
  kyc: "kyc.view",
  helpTickets: "support.view",
  reports: "reports.view",
  orderProblems: "orders.view",
  staysObjections: "orders.view",
  shopReturns: "orders.view",
  gigDisputes: "orders.view",
};

const sum = (rows: Flows[], key: keyof Flows) => rows.reduce((total, row) => total + row[key], 0);

/** Every number on the console dashboard, in one call. */
const consoleStats: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  app.get(
    "/stats",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["ruxstar"],
        summary: "Every console number in one place: people, businesses, orders and money per module, payouts and queues",
        description:
          "For admins and active Ruxstar staff; each section needs its view permission, as on the overview, and is null without it. " +
          "Days, weeks (from Monday) and months are India time. Numbers are counted at most once a minute on each server.",
        querystring: StatsQuery,
        response: { 200: StatsResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const access = await accessOf(request);
      if (!access) throw new AppError("FORBIDDEN");
      const can = (p: Permission) => access.permissions.includes(p);
      const only = request.query.module ?? null;
      const d = db();
      const now = Date.now();
      const counted: number[] = [];
      const get = <T>(allowed: boolean, key: string, work: (p: Periods, at: Date) => Promise<T>): Promise<T | null> => {
        if (!allowed) return Promise.resolve(null);
        const entry = cached(key, now, () => work(indiaPeriods(new Date(now)), new Date(now)));
        counted.push(entry.at);
        return entry.value;
      };

      const money = can("payouts.view") && only !== "delivery";
      const [peopleBlock, flowRows, heldRows, payoutTotals, rows, queues] = await Promise.all([
        get(!only && can("users.view"), "people", (p) => people(d, p)),
        get(money, "money:flows", (p) => flows(d, p)),
        get(money, "money:held", () => held(d)),
        get(money && !only, "money:payouts", (p) => payouts(d, p)),
        Promise.all(
          (only ? [only] : MODULES).map(async (module): Promise<ModuleBlock> => {
            const business = module !== "delivery";
            const [businessCounts, listingCounts, orderCounts] = await Promise.all([
              get(can("businesses.view") && business, `businesses:${module}`, () => businesses(d, module as BusinessModule)),
              get(can("businesses.view") && business && module !== "pod", `listings:${module}`, () => listings(d, module)),
              get(can("orders.view"), `orders:${module}`, (p, at) => orders(d, module, p, at)),
            ]);
            return { module, businesses: businessCounts, listings: listingCounts ?? null, orders: orderCounts, money: null };
          }),
        ),
        only
          ? null
          : Promise.all(
              (Object.keys(QUEUES) as (keyof typeof QUEUES)[]).map(async (key) => [key, await get(can(QUEUE_PERMISSION[key]), `queue:${key}`, () => QUEUES[key](d))] as const),
            ).then((pairs) => Object.fromEntries(pairs) as NonNullable<StatsData["queues"]>),
      ]);

      if (flowRows && heldRows) {
        for (const row of rows) {
          if (row.module === "delivery") continue;
          const module = row.module as BusinessModule;
          row.money = { ...(flowRows[module] ?? NO_FLOWS), held: heldRows[module] ?? 0 };
        }
      }
      const all = flowRows ? Object.values(flowRows) : [];
      const data: StatsData = {
        asOf: new Date(counted.length ? Math.min(...counted) : now).toISOString(),
        module: only,
        people: peopleBlock,
        modules: rows,
        money:
          !only && flowRows && heldRows && payoutTotals
            ? {
                collectedToday: sum(all, "collectedToday"),
                collectedThisWeek: sum(all, "collectedThisWeek"),
                collectedThisMonth: sum(all, "collectedThisMonth"),
                refundsToday: sum(all, "refundsToday"),
                refundsThisMonth: sum(all, "refundsThisMonth"),
                held: Object.values(heldRows).reduce((a, b) => a + b, 0),
                payouts: payoutTotals,
              }
            : null,
        queues,
      };
      return ok(request, data);
    },
  );
};

export default consoleStats;
