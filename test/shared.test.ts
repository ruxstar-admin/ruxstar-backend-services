import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, dayOf } from "../src/modules/coaching/rules.js";
import { stamp } from "../src/platform/db.js";
import { forgetModuleState } from "../src/platform/module-switch.js";
import { signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>> & { username: string };
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const EVENT_BACK = "https://ruxstar.com/tickets";
const CLASS_BACK = "https://ruxstar.com/classes";
const VENUE = { name: "Shilpakala Vedika", address: "Madhapur, near Hitech City", city: "Hyderabad" };
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: "10:00", minutes: 60 }));
const indiaDay = (at: number) => new Date(at + 5.5 * HOUR).toISOString().slice(0, 10);

describe("shared: public pages, invoice filters, reviews and coupons for every business", () => {
  let stack: Stack;
  let admin: User;

  beforeAll(async () => {
    stack = await startStack();
    admin = { ...(await signIn(stack, { admin: true })), username: "admin" };
  });
  afterAll(() => stack?.stop());
  beforeEach(async () => {
    await Promise.all([
      stack.db.businesses.deleteMany({}),
      stack.db.events.deleteMany({}),
      stack.db.eventOrders.deleteMany({}),
      stack.db.eventTickets.deleteMany({}),
      stack.db.eventWaits.deleteMany({}),
      stack.db.coachingCourses.deleteMany({}),
      stack.db.coachingBatches.deleteMany({}),
      stack.db.coachingSessions.deleteMany({}),
      stack.db.coachingOrders.deleteMany({}),
      stack.db.coachingAttendance.deleteMany({}),
      stack.db.reviews.deleteMany({}),
      stack.db.reviewReports.deleteMany({}),
      stack.db.coupons.deleteMany({}),
      stack.db.couponRedemptions.deleteMany({}),
      stack.db.invoices.deleteMany({}),
      stack.db.employments.deleteMany({}),
      stack.db.ledgerEntries.deleteMany({}),
      stack.db.notifications.deleteMany({}),
      stack.db.auditLogs.deleteMany({}),
    ]);
    const fees = { live: true, signupsOpen: true, commissionBps: 1000, platformFee: 500 };
    await stack.db.moduleSettings.updateOne({ module: "events" }, { $set: fees, $unset: { eventRules: "" } });
    await stack.db.moduleSettings.updateOne({ module: "coaching" }, { $set: fees, $unset: { coachingRules: "" } });
    forgetModuleState();
  });

  const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, token: string, payload?: object) =>
    stack.app.inject({
      method,
      url: `/v1${url}`,
      headers: web(token, method === "GET" || method === "DELETE" ? {} : { "idempotency-key": randomUUID() }),
      ...(payload ? { payload } : {}),
    });
  const signedOut = (url: string) => stack.app.inject({ method: "GET", url: `/v1${url}`, headers: web() });

  let n = 0;
  async function person(opts: { vendor?: boolean; name?: string } = {}): Promise<User> {
    const user = await signIn(stack, opts.vendor ? { vendor: true } : {});
    const username = `shared${Date.now() % 1e6}${n++}`;
    await stack.db.users.updateOne(
      { _id: user.userId },
      { $set: { name: opts.name ?? "Kiran Das", username, ...(opts.vendor ? { "kyc.base": "approved" } : {}) } },
    );
    return { ...user, username };
  }
  const owner = () => person({ vendor: true, name: "Asha Rao" });

  async function business(who: User, module: "events" | "coaching") {
    const _id = new ObjectId();
    await stack.db.businesses.insertOne({
      _id,
      ownerId: who.userId,
      module,
      type: module === "events" ? "concert" : "coaching",
      name: module === "events" ? "Live Arena" : "Ace Coaching",
      description: null,
      phone: "9876543210",
      location: { state: "Telangana", city: "Hyderabad", doorNo: "4-1", street: "Main Road", area: "Madhapur", pincode: "500081" },
      pod: null,
      gstin: null,
      photos: [],
      status: "live",
      open: true,
      publishedAt: new Date(),
      ...stamp(),
    } as never);
    return _id.toHexString();
  }

  async function event(who: User, businessId: string, opts: { draft?: boolean } = {}) {
    const created = await call("POST", `/vendor/businesses/${businessId}/events`, who.token, {
      title: "Sunburn Nights",
      description: "An evening of live music.",
      kind: "show",
      venue: VENUE,
      online: null,
      startsAt: new Date(Date.now() + 3 * DAY).toISOString(),
      endsAt: new Date(Date.now() + 3 * DAY + 4 * HOUR).toISOString(),
      team: null,
      tiers: [{ name: "General", price: 50_000, capacity: 100 }],
      questions: [],
      refunds: "standard",
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id as string;
    if (opts.draft) return { id, tierId: created.json().data.tiers[0].id as string };
    const published = await call("POST", `/vendor/events/${id}/publish`, who.token);
    expect(published.statusCode).toBe(200);
    return { id, tierId: published.json().data.tiers[0].id as string };
  }

  let phones = 0;
  const holder = (tierId: string, name = "Ravi Kumar") => ({ tierId, name, phone: `98765${String(10_000 + phones++).slice(-5)}` });

  async function pay(checkoutUrl: string) {
    const url = new URL(checkoutUrl);
    expect((await stack.app.inject({ method: "GET", url: url.pathname + url.search })).statusCode).toBe(200);
    const test = await stack.app.inject({ method: "POST", url: `${url.pathname}/test${url.search}` });
    expect(test.json()).toEqual({ status: "confirmed" });
  }

  async function bookPaid(customer: User, ev: { id: string; tierId: string }, extra: object = {}) {
    const res = await call("POST", `/events/${ev.id}/tickets`, customer.token, { tickets: [holder(ev.tierId)], returnTo: EVENT_BACK, ...extra });
    expect(res.statusCode).toBe(201);
    await pay(res.json().data.checkoutUrl);
    return res.json().data.order as { id: string; orderNo: number; price: Record<string, number> };
  }

  async function course(who: User, businessId: string, opts: { draft?: boolean } = {}) {
    const created = await call("POST", `/vendor/businesses/${businessId}/courses`, who.token, {
      title: "Class 10 Maths",
      description: "Board exam preparation.",
      category: "tuition",
      mode: "offline",
      venue: { name: "Ace Academy", address: "Road 12, Banjara Hills", city: "Hyderabad" },
      demo: null,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id as string;
    const batched = await call("POST", `/vendor/courses/${id}/batches`, who.token, {
      name: "Morning batch",
      fee: 300_000,
      capacity: 10,
      minStudents: null,
      slots: EVERY_DAY,
      startDate: addDays(dayOf(new Date()), 2),
      classes: 4,
      endDate: null,
      onlineLink: null,
      coachIds: [],
    });
    expect(batched.statusCode).toBe(201);
    const batchId = batched.json().data.batches[0].id as string;
    if (!opts.draft) expect((await call("POST", `/vendor/courses/${id}/publish`, who.token)).statusCode).toBe(200);
    return { id, batchId };
  }

  async function enrolPaid(customer: User, batchId: string) {
    const res = await call("POST", `/coaching/batches/${batchId}/enrol`, customer.token, { student: { childId: null }, returnTo: CLASS_BACK });
    expect(res.statusCode).toBe(201);
    await pay(res.json().data.checkoutUrl);
    return res.json().data.order as { id: string; orderNo: number };
  }

  /** Moves a batch, and everything dated by it, so its first class ended a minute ago. */
  async function pastFirstClass(batchId: string) {
    const _id = new ObjectId(batchId);
    const batch = (await stack.db.coachingBatches.findOne({ _id }))!;
    const ms = batch.firstEndsAt.getTime() + 60_000 - Date.now();
    const back = (field: string) => ({ $cond: [{ $eq: [{ $type: `$${field}` }, "date"] }, { $subtract: [`$${field}`, ms] }, `$${field}`] });
    await stack.db.coachingSessions.updateMany({ batchId: _id }, [{ $set: { startsAt: back("startsAt"), endsAt: back("endsAt") } }]);
    await stack.db.coachingBatches.updateOne({ _id }, [{ $set: { firstAt: back("firstAt"), firstEndsAt: back("firstEndsAt"), lastEndsAt: back("lastEndsAt") } }]);
    await stack.db.coachingOrders.updateMany({ batchId: _id }, [{ $set: { firstAt: back("firstAt"), firstEndsAt: back("firstEndsAt"), releaseAt: back("releaseAt") } }]);
  }

  describe("public event and course pages", () => {
    it("shows events without signing in, with nothing personal, and hides drafts and Ruxstar's take-downs", async () => {
      const organiser = await owner();
      const bizId = await business(organiser, "events");
      const ev = await event(organiser, bizId);
      const draft = await event(organiser, bizId, { draft: true });
      const taken = await event(organiser, bizId);
      await stack.db.events.updateOne(
        { _id: new ObjectId(taken.id) },
        { $set: { status: "cancelled", cancellation: { by: "staff", actorId: admin.userId, reason: "Against the rules.", at: new Date() } } },
      );
      const customer = await person();
      await bookPaid(customer, ev);

      const rules = await signedOut("/events/rules");
      expect(rules.statusCode).toBe(200);
      expect(rules.headers["cache-control"]).toBe("public, max-age=60");

      const list = await signedOut("/events?city=hyderabad");
      expect(list.statusCode).toBe(200);
      expect(list.headers["cache-control"]).toBe("public, max-age=60");
      expect(String(list.headers.vary)).toContain("Authorization");
      expect(list.json().data.map((e: { id: string }) => e.id)).toEqual([ev.id]);

      const detail = await signedOut(`/events/${ev.id}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.headers["cache-control"]).toBe("public, max-age=60");
      expect(detail.json().data).toMatchObject({ id: ev.id, status: "live", canBuy: true, myOrders: [], myWaits: [], onlineLink: null, rating: { count: 0 } });
      expect(detail.body).not.toContain("Ravi Kumar");
      expect(detail.body).not.toContain(customer.userId.toHexString());

      expect((await signedOut(`/events/${draft.id}`)).statusCode).toBe(404);
      expect((await signedOut(`/events/${taken.id}`)).statusCode).toBe(404);
      expect((await signedOut(`/events/${draft.id}/reviews`)).statusCode).toBe(404);
      expect((await signedOut(`/events/${taken.id}/reviews`)).statusCode).toBe(404);

      const mine = await call("GET", `/events/${ev.id}`, customer.token);
      expect(mine.headers["cache-control"]).toBe("private, no-store");
      expect(mine.json().data.myOrders).toMatchObject([{ status: "confirmed", tickets: 1 }]);
      expect((await call("GET", `/events/${draft.id}`, organiser.token)).statusCode).toBe(200);

      expect((await signedOut("/events/orders")).statusCode).toBe(401);
      expect((await signedOut(`/events/${ev.id}/offers`)).statusCode).toBe(401);
    });

    it("shows courses without signing in, with nothing personal, and hides drafts and removed courses", async () => {
      const coach = await owner();
      const bizId = await business(coach, "coaching");
      const live = await course(coach, bizId);
      const draft = await course(coach, bizId, { draft: true });
      const removed = await course(coach, bizId);
      await stack.db.coachingCourses.updateOne({ _id: new ObjectId(removed.id) }, { $set: { status: "removed" } });
      const customer = await person();
      await enrolPaid(customer, live.batchId);

      const rules = await signedOut("/coaching/rules");
      expect(rules.statusCode).toBe(200);
      expect(rules.headers["cache-control"]).toBe("public, max-age=60");

      const list = await signedOut("/coaching?city=hyderabad");
      expect(list.statusCode).toBe(200);
      expect(list.headers["cache-control"]).toBe("public, max-age=60");
      expect(list.json().data.map((c: { id: string }) => c.id)).toEqual([live.id]);

      const detail = await signedOut(`/coaching/${live.id}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.headers["cache-control"]).toBe("public, max-age=60");
      expect(detail.json().data).toMatchObject({ id: live.id, status: "live", myOrders: [], demoTaken: [], rating: { count: 0 } });
      expect(detail.json().data.batches).toMatchObject([{ id: live.batchId, enrolled: 1 }]);
      expect(detail.body).not.toContain("Kiran Das");
      expect(detail.body).not.toContain(customer.userId.toHexString());

      expect((await signedOut(`/coaching/${draft.id}`)).statusCode).toBe(404);
      expect((await signedOut(`/coaching/${removed.id}`)).statusCode).toBe(404);
      expect((await signedOut(`/coaching/${removed.id}/reviews`)).statusCode).toBe(404);

      const mine = await call("GET", `/coaching/${live.id}`, customer.token);
      expect(mine.headers["cache-control"]).toBe("private, no-store");
      expect(mine.json().data.myOrders).toMatchObject([{ status: "confirmed", kind: "batch" }]);
      expect((await call("GET", `/coaching/${removed.id}`, customer.token)).json().data.whyNot).toBe("Ruxstar took this course down.");

      expect((await signedOut("/coaching/orders")).statusCode).toBe(401);
      expect((await signedOut(`/coaching/batches/${live.batchId}/offers`)).statusCode).toBe(401);
    });
  });

  describe("invoice list filters", () => {
    it("filters customers', vendors' and Ruxstar's lists by dates, order and module, page by page", async () => {
      const seller = await owner();
      const eventsBiz = await business(seller, "events");
      const coachingBiz = await business(seller, "coaching");
      const ev = await event(seller, eventsBiz);
      const { batchId } = await course(seller, coachingBiz);
      const customer = await person();
      const booking = await bookPaid(customer, ev);
      const enrolment = await enrolPaid(customer, batchId);
      await stack.db.invoices.updateMany({ "source.id": new ObjectId(booking.id) }, { $set: { issuedAt: new Date(Date.now() - 10 * DAY) } });

      const eventDocs = await stack.db.invoices.countDocuments({ module: "events", customerId: customer.userId });
      const classDocs = await stack.db.invoices.countDocuments({ module: "coaching", customerId: customer.userId });
      expect(eventDocs).toBeGreaterThan(0);
      expect(classDocs).toBeGreaterThan(0);

      type Row = { module: string; order: { id: string } };
      const list = async (url: string, token = customer.token) => {
        const res = await call("GET", url, token);
        expect(res.statusCode).toBe(200);
        return res.json().data as Row[];
      };
      const orders = (rows: Row[]) => [...new Set(rows.map((r) => r.order.id))];

      expect(await list("/account/invoices")).toHaveLength(eventDocs + classDocs);
      const events = await list("/account/invoices?module=events");
      expect(events).toHaveLength(eventDocs);
      expect(events.every((r) => r.module === "events")).toBe(true);
      expect(orders(await list("/account/invoices?module=coaching"))).toEqual([enrolment.id]);
      expect(await list("/account/invoices?module=turf")).toEqual([]);

      expect(orders(await list(`/account/invoices?to=${indiaDay(Date.now() - 5 * DAY)}`))).toEqual([booking.id]);
      expect(orders(await list(`/account/invoices?from=${indiaDay(Date.now())}`))).toEqual([enrolment.id]);
      expect(orders(await list(`/account/invoices?from=${new Date(Date.now() - HOUR).toISOString()}`))).toEqual([enrolment.id]);
      expect(orders(await list(`/account/invoices?from=${indiaDay(Date.now() - 10 * DAY)}&to=${indiaDay(Date.now() - 10 * DAY)}`))).toEqual([booking.id]);
      expect(await list(`/account/invoices?module=coaching&to=${indiaDay(Date.now() - 5 * DAY)}`)).toEqual([]);

      const backwards = await call("GET", "/account/invoices?from=2026-05-02&to=2026-05-01", customer.token);
      expect(backwards.statusCode).toBe(400);
      expect(backwards.json().error.details[0].path).toBe("querystring/to");
      expect((await call("GET", "/account/invoices?from=yesterday", customer.token)).statusCode).toBe(400);
      expect((await call("GET", "/account/invoices?module=rockets", customer.token)).statusCode).toBe(400);

      const vendorEvent = await list(`/vendor/invoices?orderId=${booking.id}`, seller.token);
      expect(vendorEvent.length).toBeGreaterThan(0);
      expect(orders(vendorEvent)).toEqual([booking.id]);
      expect(orders(await list("/vendor/invoices?module=coaching", seller.token))).toEqual([enrolment.id]);
      expect(orders(await list(`/vendor/invoices?from=${indiaDay(Date.now())}`, seller.token))).toEqual([enrolment.id]);
      expect(await list(`/vendor/invoices?orderId=${booking.id}`, (await owner()).token)).toEqual([]);

      expect(orders(await list(`/ruxstar/invoices?orderId=${enrolment.id}`, admin.token))).toEqual([enrolment.id]);
      expect(orders(await list(`/ruxstar/invoices?module=events&to=${indiaDay(Date.now() - DAY)}`, admin.token))).toEqual([booking.id]);

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await call("GET", `/ruxstar/invoices?module=events&limit=1${cursor ? `&cursor=${cursor}` : ""}`, admin.token);
        expect(res.statusCode).toBe(200);
        for (const row of res.json().data) seen.push(row.id);
        cursor = res.json().meta.nextCursor;
      } while (cursor);
      expect(new Set(seen).size).toBe(eventDocs);
    });
  });

  describe("reviews for every business", () => {
    it("reviews an event booking once a ticket is checked in, one review per booking, with replies and Ruxstar's removal", async () => {
      const organiser = await owner();
      const bizId = await business(organiser, "events");
      const ev = await event(organiser, bizId);
      const customer = await person({ name: "Meena" });
      const booking = await bookPaid(customer, ev);

      const before = (await call("GET", `/events/orders/${booking.id}`, customer.token)).json().data;
      expect(before).toMatchObject({ canReview: false, reviewUntil: null });
      const early = await call("PUT", `/events/orders/${booking.id}/review`, customer.token, { rating: 5 });
      expect(early.json().error).toMatchObject({ code: "ORDER_STATE", message: "You can review the event once you're checked in or it has ended." });

      await stack.db.events.updateOne({ _id: new ObjectId(ev.id) }, { $set: { startsAt: new Date(Date.now() - HOUR), endsAt: new Date(Date.now() + 2 * HOUR) } });
      const scan = await call("POST", `/events/desk/${ev.id}/scan`, organiser.token, { qr: before.tickets[0].qr });
      expect(scan.json().data.result).toBe("ok");
      const open = (await call("GET", `/events/orders/${booking.id}`, customer.token)).json().data;
      expect(open.canReview).toBe(true);
      expect(new Date(open.reviewUntil).getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
      expect((await call("GET", "/events/orders?view=upcoming", customer.token)).json().data).toMatchObject([{ id: booking.id, canReview: true }]);

      expect((await call("GET", `/events/orders/${booking.id}/review`, customer.token)).json().data).toBeNull();
      const written = await call("PUT", `/events/orders/${booking.id}/review`, customer.token, { rating: 4, text: "Great sound." });
      expect(written.statusCode).toBe(200);
      expect(written.json().data).toMatchObject({ rating: 4, text: "Great sound.", product: "Sunburn Nights", module: "events", listing: { type: "event", id: ev.id }, status: "live" });
      const reviewId = written.json().data.id as string;
      const changed = await call("PUT", `/events/orders/${booking.id}/review`, customer.token, { rating: 5 });
      expect(changed.json().data).toMatchObject({ id: reviewId, rating: 5, text: "Great sound." });
      expect(await stack.db.reviews.countDocuments({ orderId: new ObjectId(booking.id) })).toBe(1);
      expect(await stack.db.reviews.findOne({ _id: new ObjectId(reviewId) })).toMatchObject({ module: "events", orderType: "event_order", shopId: new ObjectId(bizId) });
      expect((await call("PUT", `/events/orders/${booking.id}/review`, (await person()).token, { rating: 1 })).statusCode).toBe(404);

      const posted = await stack.db.notifications.findOne({ userId: organiser.userId, type: "review.posted" });
      expect(posted?.body).toBe(`4 stars for booking #${booking.orderNo}: Great sound.`);

      const listed = await signedOut(`/events/${ev.id}/reviews`);
      expect(listed.statusCode).toBe(200);
      expect(listed.headers["cache-control"]).toBe("public, max-age=60");
      expect(listed.json().data).toMatchObject([{ id: reviewId, rating: 5, author: { name: "Meena" }, listing: { type: "event", id: ev.id } }]);
      expect(listed.json().data[0].orderId).toBeUndefined();
      expect((await signedOut(`/events/${ev.id}`)).json().data.rating).toEqual({ average: null, count: 1 });

      expect((await call("GET", `/vendor/businesses/${bizId}/reviews`, organiser.token)).json().data).toMatchObject([{ id: reviewId, orderNo: booking.orderNo }]);
      const replied = await call("PUT", `/vendor/businesses/${bizId}/reviews/${reviewId}/reply`, organiser.token, { text: "Thanks for coming!" });
      expect(replied.statusCode).toBe(200);
      const told = await stack.db.notifications.findOne({ userId: customer.userId, type: "review.replied" });
      expect(told?.link).toEqual({ screen: "event_order", id: booking.id });

      const reporter = await person({ name: "Reporter" });
      expect((await call("POST", `/events/reviews/${reviewId}/report`, reporter.token, { reason: "spam" })).statusCode).toBe(200);
      const queue = (await call("GET", "/ruxstar/reports/reviews", admin.token)).json().data;
      expect(queue).toMatchObject([{ reviewId, reports: 1, review: { shop: { id: bizId, name: "Live Arena" }, orderNo: booking.orderNo } }]);
      const removed = await call("POST", `/ruxstar/reports/reviews/${reviewId}/remove`, admin.token, { reason: "Reviews can't advertise other services." });
      expect(removed.statusCode).toBe(200);
      expect((await call("GET", `/events/orders/${booking.id}/review`, customer.token)).json().data).toMatchObject({ status: "removed" });
      expect((await call("GET", `/events/orders/${booking.id}`, customer.token)).json().data.canReview).toBe(false);
      expect((await call("PUT", `/events/orders/${booking.id}/review`, customer.token, { rating: 5 })).statusCode).toBe(409);
      expect((await signedOut(`/events/${ev.id}/reviews`)).json().data).toEqual([]);
      const gone = await stack.db.notifications.findOne({ userId: customer.userId, type: "review.removed" });
      expect(gone?.link).toEqual({ screen: "event_order", id: booking.id });
      const audit = await stack.db.auditLogs.findOne({ action: { $regex: "remove" }, "target.id": new ObjectId(booking.id) });
      expect(audit).toMatchObject({ scope: { module: "events" }, target: { type: "event_order" } });
    }, 90_000);

    it("opens an unscanned booking once the event has ended, and never a cancelled one", async () => {
      const organiser = await owner();
      const bizId = await business(organiser, "events");
      const ev = await event(organiser, bizId);
      const keeper = await person();
      const kept = await bookPaid(keeper, ev);
      const leaver = await person();
      const left = await bookPaid(leaver, ev);
      expect((await call("POST", `/events/orders/${left.id}/cancel`, leaver.token)).statusCode).toBe(200);

      await stack.db.events.updateOne({ _id: new ObjectId(ev.id) }, { $set: { startsAt: new Date(Date.now() - 5 * HOUR), endsAt: new Date(Date.now() - HOUR) } });
      const cancelled = await call("PUT", `/events/orders/${left.id}/review`, leaver.token, { rating: 2 });
      expect(cancelled.json().error).toMatchObject({ code: "ORDER_STATE", message: "Only confirmed bookings can be reviewed." });
      expect((await call("GET", `/events/orders/${left.id}`, leaver.token)).json().data.canReview).toBe(false);
      expect((await call("GET", `/events/orders/${kept.id}`, keeper.token)).json().data.canReview).toBe(true);
      expect((await call("PUT", `/events/orders/${kept.id}/review`, keeper.token, { rating: 4 })).statusCode).toBe(200);

      await stack.db.events.updateOne({ _id: new ObjectId(ev.id) }, { $set: { startsAt: new Date(Date.now() - 32 * DAY), endsAt: new Date(Date.now() - 31 * DAY) } });
      const late = await call("PUT", `/events/orders/${kept.id}/review`, keeper.token, { rating: 2 });
      expect(late.json().error).toMatchObject({ code: "ORDER_STATE", message: "Reviews close 30 days after the event." });
      expect((await call("GET", `/events/orders/${kept.id}`, keeper.token)).json().data).toMatchObject({ canReview: false, reviewUntil: null });
    });

    it("reviews a coaching enrolment once its first class has been held, one review per enrolment", async () => {
      const coach = await owner();
      const bizId = await business(coach, "coaching");
      const { id: courseId, batchId } = await course(coach, bizId);
      const customer = await person({ name: "Meena" });
      const enrolment = await enrolPaid(customer, batchId);

      expect((await call("GET", `/coaching/orders/${enrolment.id}`, customer.token)).json().data).toMatchObject({ canReview: false, reviewUntil: null });
      const early = await call("PUT", `/coaching/orders/${enrolment.id}/review`, customer.token, { rating: 5 });
      expect(early.json().error).toMatchObject({ code: "ORDER_STATE", message: "You can review the course once your first class has been held." });

      await pastFirstClass(batchId);
      const open = (await call("GET", `/coaching/orders/${enrolment.id}`, customer.token)).json().data;
      expect(open.canReview).toBe(true);
      const lastEndsAt = (await stack.db.coachingBatches.findOne({ _id: new ObjectId(batchId) }))!.lastEndsAt;
      expect(open.reviewUntil).toBe(new Date(lastEndsAt.getTime() + 30 * DAY).toISOString());

      const written = await call("PUT", `/coaching/orders/${enrolment.id}/review`, customer.token, { rating: 3, text: "Good teacher." });
      expect(written.statusCode).toBe(200);
      expect(written.json().data).toMatchObject({ rating: 3, product: "Class 10 Maths", module: "coaching", listing: { type: "course", id: courseId } });
      const reviewId = written.json().data.id as string;
      expect((await call("PUT", `/coaching/orders/${enrolment.id}/review`, customer.token, { rating: 4 })).json().data.id).toBe(reviewId);
      expect(await stack.db.reviews.countDocuments({ orderId: new ObjectId(enrolment.id) })).toBe(1);

      const listed = await signedOut(`/coaching/${courseId}/reviews`);
      expect(listed.statusCode).toBe(200);
      expect(listed.json().data).toMatchObject([{ id: reviewId, rating: 4, module: "coaching" }]);
      expect((await signedOut(`/coaching/${courseId}`)).json().data.rating).toEqual({ average: null, count: 1 });

      const replied = await call("PUT", `/vendor/businesses/${bizId}/reviews/${reviewId}/reply`, coach.token, { text: "Thank you, Meena!" });
      expect(replied.statusCode).toBe(200);
      expect((await stack.db.notifications.findOne({ userId: customer.userId, type: "review.replied" }))?.link).toEqual({ screen: "coaching_order", id: enrolment.id });

      expect((await call("DELETE", `/coaching/orders/${enrolment.id}/review`, customer.token)).statusCode).toBe(200);
      expect(await stack.db.reviews.countDocuments({ orderId: new ObjectId(enrolment.id) })).toBe(0);
      expect((await signedOut(`/coaching/${courseId}`)).json().data.rating).toEqual({ average: null, count: 0 });
    }, 90_000);
  });

  describe("coupons on event tickets", () => {
    it("takes an organiser's coupon, redeems it on payment and gives it back on a refund", async () => {
      const organiser = await owner();
      const bizId = await business(organiser, "events");
      const ev = await event(organiser, bizId);
      const made = await call("POST", "/vendor/coupons", organiser.token, { code: "LIVE100", kind: "flat", value: 10_000, businessIds: [bizId] });
      expect(made.statusCode).toBe(201);
      expect((await stack.db.coupons.findOne({ code: "LIVE100" }))!.modules).toEqual(["events"]);

      const customer = await person();
      const offers = (await call("GET", `/events/${ev.id}/offers?code=live100`, customer.token)).json().data;
      expect(offers).toMatchObject({ offers: [{ code: "LIVE100", discount: 10_000 }], checked: { code: "LIVE100", discount: 10_000, problem: null } });
      const wrong = await call("POST", `/events/${ev.id}/tickets`, customer.token, { tickets: [holder(ev.tierId)], returnTo: EVENT_BACK, coupon: "NOPE99" });
      expect(wrong.json().error).toMatchObject({ code: "COUPON_INVALID" });

      const booking = await bookPaid(customer, ev, { coupon: "LIVE100" });
      expect(booking).toMatchObject({ price: { items: 50_000, discount: 10_000, platformFee: 500, total: 40_500 } });
      const view = (await call("GET", `/events/orders/${booking.id}`, customer.token)).json().data;
      expect(view).toMatchObject({ coupon: { code: "LIVE100", fundedBy: "vendor" }, price: { discount: 10_000, total: 40_500 } });
      expect(await stack.db.couponRedemptions.countDocuments({})).toBe(1);
      expect((await stack.db.coupons.findOne({ code: "LIVE100" }))!.used).toBe(1);
      expect((await stack.db.eventOrders.findOne({ _id: new ObjectId(booking.id) }))!.price.commission).toBe(4_000);
      const ledger = await stack.db.ledgerEntries.find({ accountId: `vendor:${organiser.userId.toHexString()}` }).toArray();
      expect(ledger.reduce((s, e) => s + e.signedPaise, 0)).toBe(36_000);
      const sale = await stack.db.invoices.findOne({ "source.id": new ObjectId(booking.id), role: "supply" });
      expect(sale).toMatchObject({ module: "events", lines: [{ unitPrice: 50_000, discount: 10_000 }] });
      expect(sale!.totals.total).toBe(40_000);

      const cancelled = await call("POST", `/events/orders/${booking.id}/cancel`, customer.token);
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json().data).toMatchObject({ status: "cancelled" });
      expect(await stack.db.couponRedemptions.countDocuments({})).toBe(0);
      expect((await stack.db.coupons.findOne({ code: "LIVE100" }))!.used).toBe(0);
      const after = await stack.db.ledgerEntries.find({ accountId: `vendor:${organiser.userId.toHexString()}` }).toArray();
      expect(after.reduce((s, e) => s + e.signedPaise, 0)).toBe(0);
    }, 90_000);
  });
});
