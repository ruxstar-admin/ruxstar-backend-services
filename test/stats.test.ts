import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forgetStats, indiaPeriods } from "../src/modules/ruxstar/stats.js";
import { stamp } from "../src/platform/db.js";
import { signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>>;
const DAY_MS = 24 * 60 * 60_000;

describe("india periods", () => {
  const at = (iso: string) => {
    const p = indiaPeriods(new Date(iso));
    return { today: p.today.toISOString(), week: p.week.toISOString(), month: p.month.toISOString() };
  };

  it("starts days at midnight India time, weeks on Monday and months on the 1st", () => {
    // Sunday 15 Nov 2026, 23:50 in India.
    expect(at("2026-11-15T18:20:00.000Z")).toEqual({
      today: "2026-11-14T18:30:00.000Z",
      week: "2026-11-08T18:30:00.000Z",
      month: "2026-10-31T18:30:00.000Z",
    });
    // Monday 16 Nov 2026, midnight in India: a new day and a new week.
    expect(at("2026-11-15T18:30:00.000Z")).toEqual({
      today: "2026-11-15T18:30:00.000Z",
      week: "2026-11-15T18:30:00.000Z",
      month: "2026-10-31T18:30:00.000Z",
    });
    // Tuesday 1 Dec 2026, midnight in India: the month starts after the week.
    expect(at("2026-11-30T18:30:00.000Z")).toEqual({
      today: "2026-11-30T18:30:00.000Z",
      week: "2026-11-29T18:30:00.000Z",
      month: "2026-11-30T18:30:00.000Z",
    });
    // A millisecond earlier is still Monday 30 Nov.
    expect(at("2026-11-30T18:29:59.999Z").today).toBe("2026-11-29T18:30:00.000Z");
    // Friday 1 Jan 2027 in India, still 31 Dec in UTC.
    expect(at("2026-12-31T19:00:00.000Z")).toEqual({
      today: "2026-12-31T18:30:00.000Z",
      week: "2026-12-27T18:30:00.000Z",
      month: "2026-12-31T18:30:00.000Z",
    });
  });
});

describe("console stats", () => {
  let stack: Stack;
  let admin: User;

  beforeAll(async () => {
    stack = await startStack();
    admin = await signIn(stack, { admin: true });
  });
  afterAll(() => stack?.stop());

  const stats = (token?: string, query = "") => stack.app.inject({ method: "GET", url: `/v1/ruxstar/stats${query}`, headers: web(token) });
  const fresh = async (token: string, query = "") => {
    forgetStats();
    const res = await stats(token, query);
    expect(res.statusCode).toBe(200);
    return res.json().data;
  };
  const block = (data: { modules: { module: string }[] }, module: string) => data.modules.find((m) => m.module === module) as Record<string, unknown>;

  async function staffWith(...permissions: string[]) {
    const user = await signIn(stack, { ruxstarStaff: true });
    await stack.db.ruxstarStaff.insertOne({
      _id: new ObjectId(),
      userId: user.userId,
      title: "Staff",
      modules: [],
      permissions,
      grantedBy: admin.userId,
      status: "active",
      ...stamp(),
    });
    return user;
  }

  let orderNo = 1000;
  const no = () => ++orderNo;
  const ago = (date: Date, ms: number) => new Date(date.getTime() - ms);

  it("needs console access", async () => {
    expect((await stats()).statusCode).toBe(401);
    const someone = await signIn(stack);
    expect((await stats(someone.token)).statusCode).toBe(403);

    const auditor = await staffWith("audit.view");
    const data = await fresh(auditor.token);
    expect(data).toMatchObject({ module: null, people: null, money: null });
    expect(data.modules.map((m: { module: string }) => m.module)).toEqual(["pod", "events", "coaching", "turf", "stays", "shop", "delivery"]);
    for (const m of data.modules) expect(m).toMatchObject({ businesses: null, listings: null, orders: null, money: null });
    expect(Object.values(data.queues).every((v) => v === null)).toBe(true);
  });

  it("counts match the seeded data, on India-time day, week and month boundaries", async () => {
    const before = (await fresh(admin.token)).people;
    const p = indiaPeriods();
    const times = [p.today, ago(p.today, 1), p.week, ago(p.week, 1), p.month, ago(p.month, 1)];
    const since = (from: Date) => times.filter((t) => t >= from).length;
    const old = ago(p.week, 8 * DAY_MS);
    const later = new Date(Date.now() + 30 * DAY_MS);
    const d = stack.db;
    const user = (createdAt: Date, extra: object = {}) => ({ _id: new ObjectId(), phone: `+91${no()}${no()}`, status: "active", roles: {}, kyc: {}, ...stamp(createdAt), ...extra });

    await d.users.insertMany([
      ...times.map((t) => user(t)),
      user(p.today, { status: "deleted" }),
      user(old, { status: "locked" }),
      user(old, { kyc: { base: "approved" } }),
    ] as never);

    const business = (module: string, status: string, extra: object = {}) => ({ _id: new ObjectId(), ownerId: new ObjectId(), module, status, ...stamp(), ...extra });
    const suspension = { by: admin.userId, at: new Date(), reason: "Test" };
    await d.businesses.insertMany([business("pod", "live"), business("pod", "draft"), business("pod", "live", { suspension }), business("events", "live")] as never);
    await d.events.insertMany([
      { _id: new ObjectId(), status: "live", startsAt: later, endsAt: later, ...stamp() },
      { _id: new ObjectId(), status: "cancelled", cancellation: { by: "staff" }, startsAt: later, endsAt: later, ...stamp() },
      { _id: new ObjectId(), status: "cancelled", cancellation: { by: "vendor" }, startsAt: later, endsAt: later, ...stamp() },
    ] as never);
    await d.coachingCourses.insertMany([
      { _id: new ObjectId(), status: "live", ...stamp() },
      { _id: new ObjectId(), status: "live", ...stamp() },
      { _id: new ObjectId(), status: "removed", ...stamp() },
    ] as never);

    const pay = (paidAt: Date | null) => ({ gatewayOrderId: `cf_${no()}`, sessionId: "s", paymentId: paidAt ? "p" : null, paidAt });
    await d.podOrders.insertMany([
      ...times.map((t) => ({ _id: new ObjectId(), orderNo: no(), status: "delivered", payment: pay(t), ...stamp(t) })),
      { _id: new ObjectId(), orderNo: no(), status: "cancelled", payment: pay(null), ...stamp(p.today) },
      { _id: new ObjectId(), orderNo: no(), status: "printing", payment: pay(old), ...stamp(old) },
      { _id: new ObjectId(), orderNo: no(), status: "delivered", payment: pay(old), problem: { status: "open" }, ...stamp(old) },
    ] as never);
    await d.eventOrders.insertMany([
      { _id: new ObjectId(), orderNo: no(), status: "confirmed", payment: null, endsAt: later, ...stamp(p.today) },
      { _id: new ObjectId(), orderNo: no(), status: "awaiting_payment", payment: pay(null), endsAt: later, ...stamp(p.today) },
      { _id: new ObjectId(), orderNo: no(), status: "confirmed", payment: pay(old), endsAt: old, ...stamp(old) },
    ] as never);
    const running = new ObjectId();
    const finished = new ObjectId();
    await d.coachingBatches.insertMany([
      { _id: running, status: "live", certificatesAt: null, lastEndsAt: later, ...stamp() },
      { _id: finished, status: "live", certificatesAt: null, lastEndsAt: old, ...stamp() },
    ] as never);
    await d.coachingOrders.insertMany([
      { _id: new ObjectId(), orderNo: no(), kind: "batch", batchId: running, status: "confirmed", payment: pay(old), ...stamp(old) },
      { _id: new ObjectId(), orderNo: no(), kind: "demo", batchId: running, status: "confirmed", payment: pay(old), ...stamp(old) },
      { _id: new ObjectId(), orderNo: no(), kind: "batch", batchId: finished, status: "confirmed", payment: pay(old), ...stamp(old) },
    ] as never);
    await d.turfBookings.insertMany([
      { _id: new ObjectId(), orderNo: no(), status: "confirmed", lastEndsAt: later, payment: pay(p.today), ...stamp(p.today) },
      { _id: new ObjectId(), orderNo: no(), status: "confirmed", lastEndsAt: old, payment: pay(old), ...stamp(old) },
    ] as never);
    await d.staysReservations.insertMany([
      { _id: new ObjectId(), orderNo: no(), status: "moved_in", objection: { status: "open", at: new Date() }, payment: pay(old), ...stamp(old) },
      { _id: new ObjectId(), orderNo: no(), status: "confirmed", objection: null, payment: pay(old), ...stamp(old) },
      { _id: new ObjectId(), orderNo: no(), status: "cancelled", objection: null, payment: pay(old), ...stamp(old) },
    ] as never);
    await d.shopOrders.insertMany([
      { _id: new ObjectId(), orderNo: no(), status: "packed", payment: pay(p.today), return: null, ...stamp(p.today) },
      { _id: new ObjectId(), orderNo: no(), status: "delivered", payment: pay(old), return: { status: "requested" }, ...stamp(old) },
      { _id: new ObjectId(), orderNo: no(), status: "delivered", payment: pay(old), return: { status: "rejected" }, ...stamp(old) },
    ] as never);
    await d.deliveryJobs.insertMany([
      { _id: new ObjectId(), status: "offered", ...stamp(p.today) },
      { _id: new ObjectId(), status: "delivered", ...stamp(old) },
    ] as never);

    const entry = (kind: string, accountId: string, bucket: string, signedPaise: number, type: string, at = p.today) => ({
      txnId: `${kind}:${no()}`,
      kind,
      accountId,
      bucket,
      signedPaise,
      source: { type, id: new ObjectId() },
      at,
    });
    const vendor = `vendor:${new ObjectId().toHexString()}`;
    await d.ledgerEntries.insertMany([
      ...times.map((t) => entry("payment", "gateway", "withdrawable", -1000, "pod_order", t)),
      entry("payment", "gateway", "withdrawable", -500, "event_order"),
      entry("refund", "gateway", "withdrawable", 300, "pod_order"),
      entry("refund", "gateway", "withdrawable", 700, "pod_order", ago(p.month, 1)),
      entry("payout", "gateway", "withdrawable", 5000, "payout"),
      entry("payment", vendor, "pending", 900, "pod_order"),
      entry("payment", vendor, "pending", 900, "pod_order"),
      entry("release", vendor, "pending", -900, "pod_order"),
      entry("rider_pay", `rider:${new ObjectId().toHexString()}`, "pending", 100, "pod_order"),
      entry("payment", "ruxstar", "pending", 100, "pod_order"),
      entry("payment", vendor, "pending", 400, "shop_order"),
    ] as never);

    const payout = (status: string, amount: number, paidAt: Date | null = null) => ({ _id: new ObjectId(), vendorId: new ObjectId(), status, amount, fee: 0, paidAt, ...stamp() });
    await d.payouts.insertMany([
      payout("pending", 5000),
      payout("pending", 3000),
      payout("failed", 2000),
      payout("failed", 1000),
      payout("paid", 10000, p.month),
      payout("paid", 7000, ago(p.month, 1)),
    ] as never);

    await d.kycCases.insertMany([
      { _id: new ObjectId(), userId: new ObjectId(), track: "base", status: "submitted", ...stamp() },
      { _id: new ObjectId(), userId: new ObjectId(), track: "delivery", status: "submitted", ...stamp() },
      { _id: new ObjectId(), userId: new ObjectId(), track: "base", status: "approved", ...stamp() },
    ] as never);
    await d.supportTickets.insertMany([
      { _id: new ObjectId(), ticketNo: no(), status: "open", ...stamp() },
      { _id: new ObjectId(), ticketNo: no(), status: "waiting", ...stamp() },
    ] as never);
    await d.reports.insertMany([
      { target: { type: "post", id: new ObjectId() }, userId: new ObjectId(), reason: "spam", status: "open", createdAt: new Date() },
      { target: { type: "post", id: new ObjectId() }, userId: new ObjectId(), reason: "spam", status: "closed", createdAt: new Date() },
    ] as never);
    await d.userReports.insertOne({ userId: new ObjectId(), reporterId: new ObjectId(), reason: "spam", note: null, status: "open", createdAt: new Date() });
    await d.reviewReports.insertOne({ reviewId: new ObjectId(), reporterId: new ObjectId(), reason: "spam", note: null, status: "open", createdAt: new Date() });

    const data = await fresh(admin.token);

    expect(data.people).toEqual({
      total: before.total + times.length + 2,
      joinedToday: before.joinedToday + since(p.today),
      joinedThisWeek: before.joinedThisWeek + since(p.week),
      verified: before.verified + 1,
      onHold: before.onHold + 1,
    });

    expect(block(data, "pod")).toEqual({
      module: "pod",
      businesses: { total: 3, live: 1, drafts: 1, takenDown: 1 },
      listings: null,
      orders: { today: since(p.today), thisWeek: since(p.week), open: 1 },
      money: {
        collectedToday: 1000 * since(p.today),
        collectedThisWeek: 1000 * since(p.week),
        collectedThisMonth: 1000 * since(p.month),
        refundsToday: 300,
        refundsThisMonth: 300,
        held: 1000,
      },
    });
    expect(block(data, "events")).toEqual({
      module: "events",
      businesses: { total: 1, live: 1, drafts: 0, takenDown: 0 },
      listings: { kind: "event", live: 1, takenDown: 1 },
      orders: { today: 1, thisWeek: 1, open: 1 },
      money: { collectedToday: 500, collectedThisWeek: 500, collectedThisMonth: 500, refundsToday: 0, refundsThisMonth: 0, held: 0 },
    });
    expect(block(data, "coaching")).toMatchObject({ listings: { kind: "course", live: 2, takenDown: 1 }, orders: { today: 0, thisWeek: 0, open: 1 } });
    expect(block(data, "turf")).toMatchObject({ listings: { kind: "ground", live: 0, takenDown: 0 }, orders: { today: 1, thisWeek: 1, open: 1 } });
    expect(block(data, "stays")).toMatchObject({ listings: { kind: "property" }, orders: { today: 0, thisWeek: 0, open: 2 } });
    expect(block(data, "shop")).toMatchObject({ listings: { kind: "product" }, orders: { today: 1, thisWeek: 1, open: 1 }, money: { held: 400 } });
    expect(block(data, "delivery")).toEqual({ module: "delivery", businesses: null, listings: null, orders: { today: 1, thisWeek: 1, open: 1 }, money: null });

    expect(data.money).toEqual({
      collectedToday: 1000 * since(p.today) + 500,
      collectedThisWeek: 1000 * since(p.week) + 500,
      collectedThisMonth: 1000 * since(p.month) + 500,
      refundsToday: 300,
      refundsThisMonth: 300,
      held: 1400,
      payouts: { pending: { count: 2, amount: 8000 }, failed: { count: 2, amount: 3000 }, paidThisMonth: { count: 1, amount: 10000 } },
    });
    expect(data.queues).toEqual({ kyc: 2, helpTickets: 1, reports: 3, orderProblems: 1, staysObjections: 1, shopReturns: 1 });
    expect(Date.parse(data.asOf)).toBeLessThanOrEqual(Date.now());
  });

  it("keeps numbers for a minute", async () => {
    const first = await fresh(admin.token);
    await stack.db.businesses.insertOne({ _id: new ObjectId(), ownerId: new ObjectId(), module: "pod", status: "draft", ...stamp() } as never);
    const again = (await stats(admin.token)).json().data;
    expect(block(again, "pod").businesses).toEqual(block(first, "pod").businesses);
    expect(again.asOf).toBe(first.asOf);

    const recounted = await fresh(admin.token);
    expect((block(recounted, "pod").businesses as { total: number }).total).toBe((block(first, "pod").businesses as { total: number }).total + 1);
  });

  it("shows each person only what they may see, even from numbers another person filled", async () => {
    forgetStats();
    const people = await staffWith("users.view");
    const money = await staffWith("payouts.view", "kyc.view");

    const first = (await stats(people.token)).json().data;
    expect(first.people).not.toBeNull();
    expect(first.money).toBeNull();
    for (const m of first.modules) expect(m).toMatchObject({ businesses: null, listings: null, orders: null, money: null });
    expect(Object.values(first.queues).every((v) => v === null)).toBe(true);

    const everything = (await stats(admin.token)).json().data;
    expect(everything.people).toEqual(first.people);
    expect(everything.money).not.toBeNull();
    expect(Object.values(everything.queues).every((v) => typeof v === "number")).toBe(true);

    const other = (await stats(money.token)).json().data;
    expect(other.people).toBeNull();
    expect(other.money).toEqual(everything.money);
    expect(block(other, "pod")).toMatchObject({ businesses: null, listings: null, orders: null, money: block(everything, "pod").money });
    expect(other.queues).toEqual({ kyc: everything.queues.kyc, helpTickets: null, reports: null, orderProblems: null, staysObjections: null, shopReturns: null });

    const again = (await stats(people.token)).json().data;
    expect(again).toEqual({ ...first, asOf: again.asOf });
  });

  it("returns one module's block", async () => {
    const stays = await fresh(admin.token, "?module=stays");
    expect(stays).toMatchObject({ module: "stays", people: null, money: null, queues: null });
    expect(stays.modules).toHaveLength(1);
    expect(stays.modules[0]).toMatchObject({ module: "stays", businesses: { total: 0 }, orders: { open: 2 }, money: { held: 0 } });

    const delivery = await fresh(admin.token, "?module=delivery");
    expect(delivery.modules).toEqual([{ module: "delivery", businesses: null, listings: null, orders: { today: 1, thisWeek: 1, open: 1 }, money: null }]);

    expect((await stats(admin.token, "?module=ledger")).statusCode).toBe(400);
  });
});
