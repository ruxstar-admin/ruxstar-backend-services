import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, atTime, dayOf, weekdayOf } from "../src/modules/coaching/rules.js";
import { refundPercent } from "../src/modules/turf/rules.js";
import { priceAt, slotsForDay, whenText } from "../src/modules/turf/slots.js";
import { stamp } from "../src/platform/db.js";
import { forgetModuleState } from "../src/platform/module-switch.js";
import { JOB_TOKEN, signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>> & { username: string };
const BACK = "https://ruxstar.com/turf";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TELANGANA_GSTIN = "36AABCU9603R1ZM";
const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "00:00", close: "24:00" }));

const day = (n: number) => addDays(dayOf(new Date()), n);
const at = (n: number, clock: string) => atTime(day(n), clock).toISOString();

describe("turf slots and refunds", () => {
  const court = {
    slotMinutes: 90,
    hours: [
      { day: 6, open: "06:00", close: "23:00" },
      { day: 1, open: "22:00", close: "24:00" },
    ],
    prices: { base: 100_000, weekend: 120_000, peak: [{ days: [6], start: "18:00", end: "22:00", price: 150_000 }] },
  };

  it("makes a day's slots from the hours, with peak beating weekend beating base", () => {
    const saturday = "2026-11-21";
    expect(weekdayOf(saturday)).toBe(6);
    const slots = slotsForDay(court, saturday);
    expect(slots.map((s) => s.start)).toEqual(["06:00", "07:30", "09:00", "10:30", "12:00", "13:30", "15:00", "16:30", "18:00", "19:30", "21:00"]);
    expect(slots.at(-1)!.end).toBe("22:30");
    expect(slots.find((s) => s.start === "16:30")).toMatchObject({ price: 120_000, peak: false });
    expect(slots.find((s) => s.start === "18:00")).toMatchObject({ price: 150_000, peak: true });
    expect(slots.find((s) => s.start === "21:00")).toMatchObject({ price: 150_000, peak: true });
    expect(slotsForDay(court, "2026-11-22")).toEqual([]);

    const monday = slotsForDay({ ...court, slotMinutes: 60 }, "2026-11-16");
    expect(monday.map((s) => [s.start, s.end, s.price])).toEqual([
      ["22:00", "23:00", 100_000],
      ["23:00", "24:00", 100_000],
    ]);
    expect(monday[1]!.endAt.toISOString()).toBe(atTime("2026-11-17", "00:00").toISOString());
    expect(priceAt({ base: 100_000, weekend: null, peak: [] }, 0, 600)).toEqual({ price: 100_000, peak: false });
    expect(whenText(slots[8]!.startAt, slots[8]!.endAt)).toBe("Sat, 21 Nov, 6–7:30 pm");
  });

  it("refunds in full from 6 hours before, half from 2 hours, and nothing after", () => {
    const rule = { fullHours: 6, halfHours: 2, halfPercent: 50 };
    const now = new Date("2026-11-15T10:00:00Z");
    const start = (ms: number) => new Date(now.getTime() + ms);
    expect(refundPercent(rule, start(6 * HOUR), now)).toBe(100);
    expect(refundPercent(rule, start(6 * HOUR - MINUTE), now)).toBe(50);
    expect(refundPercent(rule, start(2 * HOUR), now)).toBe(50);
    expect(refundPercent(rule, start(2 * HOUR - MINUTE), now)).toBe(0);
    expect(refundPercent(rule, start(-MINUTE), now)).toBe(0);
    expect(refundPercent({ fullHours: 6, halfHours: 6, halfPercent: 50 }, start(3 * HOUR), now)).toBe(0);
  });
});

describe("turf", () => {
  let stack: Stack;
  let photo: Buffer;

  beforeAll(async () => {
    stack = await startStack();
    photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#2f7d32" } }).jpeg().toBuffer();
  });
  afterAll(() => stack?.stop());
  beforeEach(async () => {
    await Promise.all([
      stack.db.businesses.deleteMany({}),
      stack.db.turfGrounds.deleteMany({}),
      stack.db.turfCourts.deleteMany({}),
      stack.db.turfSlots.deleteMany({}),
      stack.db.turfBookings.deleteMany({}),
      stack.db.turfSports.deleteMany({}),
      stack.db.coupons.deleteMany({}),
      stack.db.couponRedemptions.deleteMany({}),
      stack.db.employments.deleteMany({}),
      stack.db.ledgerEntries.deleteMany({}),
      stack.db.invoices.deleteMany({}),
      stack.db.reviews.deleteMany({}),
      stack.db.notifications.deleteMany({}),
      stack.db.auditLogs.deleteMany({}),
    ]);
    await stack.db.moduleSettings.updateOne(
      { module: "turf" },
      { $set: { live: true, signupsOpen: true, commissionBps: 1000, platformFee: 500 }, $unset: { turfRules: "" } },
      { upsert: true },
    );
    forgetModuleState();
  });

  const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, token: string, payload?: object) =>
    stack.app.inject({
      method,
      url: `/v1${url}`,
      headers: web(token, method === "GET" || method === "DELETE" ? {} : { "idempotency-key": randomUUID() }),
      ...(payload ? { payload } : {}),
    });
  const anon = (url: string) => stack.app.inject({ method: "GET", url: `/v1${url}`, headers: web() });
  const sweep = () => stack.app.inject({ method: "POST", url: "/jobs/orders", headers: { authorization: `Bearer ${JOB_TOKEN}` } });

  let n = 0;
  async function person(opts: { verified?: boolean; vendor?: boolean; name?: string } = {}): Promise<User> {
    const user = await signIn(stack, opts.vendor ? { vendor: true } : {});
    const username = `player${Date.now() % 1e6}${n++}`;
    await stack.db.users.updateOne(
      { _id: user.userId },
      { $set: { name: opts.name ?? "Kiran Das", username, ...(opts.verified ? { "kyc.base": "approved" } : {}) } },
    );
    return { ...user, username };
  }
  const vendor = () => person({ vendor: true, verified: true, name: "Asha Rao" });

  async function business(owner: User, gstin = false) {
    const _id = new ObjectId();
    await stack.db.businesses.insertOne({
      _id,
      ownerId: owner.userId,
      module: "turf",
      type: "turf",
      name: "Kick Off Sports",
      description: null,
      phone: "9876543210",
      location: { state: "Telangana", city: "Hyderabad", doorNo: "2-9", street: "Road 2", area: "Madhapur", pincode: "500081" },
      pod: null,
      gstin: gstin ? { number: TELANGANA_GSTIN, legalName: "Kick Off Sports LLP", status: "Active" } : null,
      photos: [],
      status: "live",
      open: true,
      publishedAt: new Date(),
      ...stamp(),
    } as never);
    return _id.toHexString();
  }

  const groundBody = (extra: object = {}) => ({
    name: "Kick Off Arena",
    description: "Floodlit five-a-side turf.",
    venue: { address: "Road 2, Madhapur", city: "Hyderabad", pincode: "500081" },
    amenities: ["parking", "floodlights"],
    ...extra,
  });
  const courtBody = (extra: object = {}) => ({
    name: "Pitch 1",
    sports: ["football"],
    slotMinutes: 60,
    hours: ALL_DAY,
    prices: { base: 100_000, weekend: null, peak: [] },
    addOns: [
      { name: "Bibs", price: 5_000, per: "booking" },
      { name: "Ball", price: 2_000, per: "slot" },
    ],
    ...extra,
  });

  interface Setup {
    bizId: string;
    groundId: string;
    courtId: string;
    addOns: { id: string; name: string }[];
  }
  async function setup(owner: User, { gstin = false }: { gstin?: boolean } = {}): Promise<Setup> {
    const bizId = await business(owner, gstin);
    const created = await call("POST", `/vendor/businesses/${bizId}/grounds`, owner.token, groundBody());
    expect(created.statusCode).toBe(201);
    const groundId = created.json().data.id as string;
    const uploaded = await stack.app.inject({
      method: "POST",
      url: `/v1/vendor/grounds/${groundId}/photos`,
      headers: web(owner.token, { "content-type": "image/jpeg" }),
      payload: photo,
    });
    expect(uploaded.statusCode).toBe(200);
    const court = await call("POST", `/vendor/grounds/${groundId}/courts`, owner.token, courtBody());
    expect(court.statusCode).toBe(201);
    const published = await call("POST", `/vendor/grounds/${groundId}/publish`, owner.token);
    expect(published.statusCode).toBe(200);
    const view = published.json().data;
    return { bizId, groundId, courtId: view.courtList[0].id, addOns: view.courtList[0].addOns };
  }

  const book = (customer: User, courtId: string, body: object) => call("POST", `/turf/courts/${courtId}/book`, customer.token, { returnTo: BACK, ...body });

  /** Opens the checkout link the way a browser does and presses the test button. */
  async function pay(checkoutUrl: string) {
    const url = new URL(checkoutUrl);
    const page = await stack.app.inject({ method: "GET", url: url.pathname + url.search });
    expect(page.statusCode).toBe(200);
    const test = await stack.app.inject({ method: "POST", url: `${url.pathname}/test${url.search}` });
    expect(test.json()).toEqual({ status: "confirmed" });
  }
  async function bookPaid(customer: User, courtId: string, body: object) {
    const res = await book(customer, courtId, body);
    expect(res.statusCode).toBe(201);
    await pay(res.json().data.checkoutUrl);
    return res.json().data.booking as { id: string; orderNo: number };
  }

  /** Moves a booking's dates, and its slots, `ms` earlier. */
  async function shift(bookingId: string, ms: number) {
    const _id = new ObjectId(bookingId);
    const b = (await stack.db.turfBookings.findOne({ _id }))!;
    const back = (d: Date) => new Date(d.getTime() - ms);
    await stack.db.turfBookings.updateOne(
      { _id },
      {
        $set: {
          occurrences: b.occurrences.map((o) => ({
            ...o,
            startAt: back(o.startAt),
            endAt: back(o.endAt),
            slots: o.slots.map((s) => ({ ...s, startAt: back(s.startAt), endAt: back(s.endAt) })),
          })),
          firstAt: back(b.firstAt),
          lastEndsAt: back(b.lastEndsAt),
          releaseAt: b.releaseAt ? back(b.releaseAt) : null,
        },
      },
    );
    for (const s of await stack.db.turfSlots.find({ bookingId: _id }).toArray()) {
      await stack.db.turfSlots.updateOne({ _id: s._id }, { $set: { startAt: back(s.startAt), endAt: back(s.endAt) } });
    }
  }
  /** Moves a booking so its first date starts `ms` from now (negative: that long ago). */
  async function startsIn(bookingId: string, ms: number) {
    const b = (await stack.db.turfBookings.findOne({ _id: new ObjectId(bookingId) }))!;
    await shift(bookingId, b.firstAt.getTime() - (Date.now() + ms));
  }

  async function staff(permissions: string[]) {
    const user = await signIn(stack, { ruxstarStaff: true });
    await stack.db.ruxstarStaff.insertOne({ _id: new ObjectId(), userId: user.userId, title: "Ops", modules: [], permissions, grantedBy: user.userId, status: "active", ...stamp() });
    return user;
  }
  async function teamMember(owner: User, businessId: string, permissions: string[], verified = true) {
    const who = await person({ verified, name: "Gopal Desk" });
    const invited = await call("POST", `/vendor/businesses/${businessId}/team`, owner.token, { username: who.username, permissions });
    expect(invited.statusCode).toBe(201);
    const accepted = await call("POST", `/employment/${invited.json().data.id}/accept`, who.token);
    expect(accepted.statusCode).toBe(200);
    return who;
  }

  const notesFor = (userId: ObjectId) => stack.db.notifications.find({ userId }).sort({ createdAt: 1, _id: 1 }).toArray();
  const invoicesOf = (id: string) => stack.db.invoices.find({ "source.id": new ObjectId(id) }).sort({ issuedAt: 1, _id: 1 }).toArray();
  const slotState = async (courtId: string, date: string, start: string) =>
    (await anon(`/turf/courts/${courtId}/slots?date=${date}`)).json().data.slots.find((s: { start: string }) => s.start === start)?.state;

  it("sets up a ground with courts, says what publishing needs, and shows it signed out with a 60-second cache", async () => {
    const owner = await vendor();
    const bizId = await business(owner);
    const created = await call("POST", `/vendor/businesses/${bizId}/grounds`, owner.token, groundBody());
    expect(created.json().data).toMatchObject({
      status: "draft",
      refunds: { fullHours: 6, halfHours: 2, halfPercent: 50 },
      missing: ["Add at least one photo", "Add a court that's open for bookings"],
    });
    const groundId = created.json().data.id as string;
    expect((await call("POST", `/vendor/grounds/${groundId}/publish`, owner.token)).json().error.code).toBe("BUSINESS_INCOMPLETE");
    expect((await call("PATCH", `/vendor/grounds/${groundId}`, owner.token, { refunds: { fullHours: 100, halfHours: 2 } })).json().error.details[0].path).toBe("body/refunds/fullHours");
    expect((await call("POST", `/vendor/grounds/${groundId}/courts`, owner.token, courtBody({ slotMinutes: 45 }))).statusCode).toBe(400);
    expect((await call("POST", `/vendor/grounds/${groundId}/courts`, owner.token, courtBody({ sports: ["curling"] }))).json().error.details[0].path).toBe("body/sports/0");
    const overlap = courtBody({ prices: { base: 100_000, weekend: null, peak: [{ days: [1], start: "18:00", end: "21:00", price: 1 }] } });
    expect((await call("POST", `/vendor/grounds/${groundId}/courts`, owner.token, overlap)).statusCode).toBe(400);
    const clash = courtBody({
      prices: {
        base: 100_000,
        weekend: null,
        peak: [
          { days: [1, 2], start: "18:00", end: "21:00", price: 150_000 },
          { days: [2], start: "20:00", end: "22:00", price: 160_000 },
        ],
      },
    });
    expect((await call("POST", `/vendor/grounds/${groundId}/courts`, owner.token, clash)).json().error.details[0].path).toBe("body/prices/peak/1");
    expect((await anon(`/turf/${groundId}`)).statusCode).toBe(404);
    expect((await call("DELETE", `/vendor/grounds/${groundId}`, owner.token)).json().data).toEqual({ done: true });

    const { courtId, groundId: liveId } = await setup(owner);
    const peakCourt = await call(
      "POST",
      `/vendor/grounds/${liveId}/courts`,
      owner.token,
      courtBody({
        name: "Box cricket",
        sports: ["box_cricket"],
        slotMinutes: 90,
        prices: { base: 100_000, weekend: 120_000, peak: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "18:00", end: "22:00", price: 150_000 }] },
      }),
    );
    expect(peakCourt.statusCode).toBe(201);
    const ground = peakCourt.json().data;
    expect(ground).toMatchObject({ status: "live", priceFrom: 100_000, sports: [{ key: "football" }, { key: "box_cricket" }], courts: 2 });

    const list = await anon("/turf?city=hyderabad&sport=box_cricket");
    expect(list.headers["cache-control"]).toBe("public, max-age=60");
    expect(list.json().data).toMatchObject([{ id: ground.id, name: "Kick Off Arena", priceFrom: 100_000, courts: 2, photo: { url: expect.any(String) } }]);
    expect((await anon("/turf?city=pune")).json().data).toEqual([]);
    expect((await anon("/turf?q=kick")).json().data).toHaveLength(1);
    const detail = await anon(`/turf/${ground.id}`);
    expect(detail.headers["cache-control"]).toBe("public, max-age=60");
    expect(detail.json().data).toMatchObject({ canBook: true, whyNot: null, platformFee: 500, amenities: ["parking", "floodlights"], courtList: [{ name: "Pitch 1" }, { name: "Box cricket" }] });
    expect(detail.json().data.refundRule).toContain("6 hours");
    expect((await anon("/turf/sports")).json().data).toContainEqual({ key: "badminton", name: "Badminton" });
    expect((await anon("/turf/rules")).json().data).toMatchObject({ refundFullHours: 6, refundHalfHours: 2, halfPercent: 50, holdMinutes: 15, platformFee: 500 });

    const saturday = [1, 2, 3, 4, 5, 6, 7].map(day).find((d) => weekdayOf(d) === 6)!;
    const slots = (await anon(`/turf/courts/${ground.courtList[1].id}/slots?date=${saturday}`)).json().data;
    expect(slots).toMatchObject({ open: true, bookable: true, court: { slotMinutes: 90 } });
    expect(slots.slots.find((s: { start: string }) => s.start === "10:30")).toMatchObject({ price: 120_000, peak: false, state: "free" });
    expect(slots.slots.find((s: { start: string }) => s.start === "18:00")).toMatchObject({ price: 150_000, peak: true, state: "free" });
    expect((await anon(`/turf/courts/${courtId}/slots?date=${day(40)}`)).json().data.bookable).toBe(false);

    await stack.db.moduleSettings.updateOne({ module: "turf" }, { $set: { live: false } });
    forgetModuleState();
    expect((await anon("/turf")).json().data).toEqual([]);
  });

  it("books back-to-back slots with add-ons, holds them for checkout, issues GST documents and shows them on the board", async () => {
    const owner = await vendor();
    const { courtId, groundId, addOns } = await setup(owner, { gstin: true });
    const customer = await person();
    const bibs = addOns.find((a) => a.name === "Bibs")!;
    const ball = addOns.find((a) => a.name === "Ball")!;

    const gap = await book(customer, courtId, { startAts: [at(2, "10:00"), at(2, "12:00")] });
    expect(gap.json().error).toMatchObject({ code: "ORDER_INVALID", details: [{ path: "body/startAts" }] });
    const odd = await book(customer, courtId, { startAts: [at(2, "10:30")] });
    expect(odd.json().error.details[0].path).toBe("body/startAts/0");
    expect((await book(owner, courtId, { startAts: [at(2, "10:00")] })).json().error.message).toContain("own ground");

    const placed = await book(customer, courtId, {
      startAts: [at(2, "11:00"), at(2, "10:00")],
      addOns: [
        { id: bibs.id, quantity: 1 },
        { id: ball.id, quantity: 2 },
      ],
    });
    expect(placed.statusCode).toBe(201);
    const { booking, checkoutUrl } = placed.json().data;
    expect(booking).toMatchObject({
      status: "awaiting_payment",
      sport: { key: "football" },
      weeks: 1,
      price: { items: 200_000 + 5_000 + 2 * 2_000 * 2, platformFee: 500, total: 213_500 },
      occurrences: [{ n: 1, startAt: at(2, "10:00"), endAt: at(2, "12:00"), slots: [{ price: 100_000 }, { price: 100_000 }] }],
      payBy: expect.any(String),
    });
    expect(await slotState(courtId, day(2), "10:00")).toBe("booked");
    const other = await person({ name: "Ravi Kumar" });
    const taken = await book(other, courtId, { startAts: [at(2, "11:00")] });
    expect(taken.json().error).toMatchObject({ code: "CONFLICT" });
    expect(taken.json().error.message).toContain("is booked. Pick another time.");

    await pay(checkoutUrl);
    const view = (await call("GET", `/turf/orders/${booking.id}`, customer.token)).json().data;
    expect(view).toMatchObject({ status: "confirmed", canCancel: true, canReview: false, occurrences: [{ refundIfCancelled: { percent: 100, amount: 213_500 } }] });
    expect(view.invoices).toHaveLength(2);
    const [sale, fee] = await invoicesOf(booking.id);
    expect(sale).toMatchObject({ kind: "tax_invoice", module: "turf", totals: { total: 213_000 } });
    expect(fee).toMatchObject({ role: "fee", totals: { total: 500 } });
    const ledger = await stack.db.ledgerEntries.find({ accountId: `vendor:${owner.userId.toHexString()}` }).toArray();
    expect(ledger).toMatchObject([{ kind: "payment", bucket: "pending", signedPaise: 213_000 - 21_300 }]);
    expect((await notesFor(owner.userId)).some((x) => x.title === `New booking #${booking.orderNo}` && x.type === "turf.booked")).toBe(true);
    expect((await notesFor(customer.userId)).at(-1)!.title).toBe("Booked: Kick Off Arena");

    const board = (await call("GET", `/turf/desk/grounds/${groundId}/board?date=${day(2)}`, owner.token)).json().data;
    const ten = board.courts[0].slots.find((s: { start: string }) => s.start === "10:00");
    expect(ten).toMatchObject({ state: "booked", booking: { orderNo: booking.orderNo, customerName: "Kiran Das", customerPhone: expect.any(String), n: 1 } });
    expect(board.totals).toMatchObject({ booked: 2, blocked: 0 });
    expect((await call("GET", "/turf/orders", customer.token)).json().data).toHaveLength(1);
    expect((await call("GET", `/turf/desk/grounds/${groundId}/bookings`, owner.token)).json().data).toMatchObject([{ id: booking.id, customer: { name: "Kiran Das" }, vendorShare: 191_700 }]);
  });

  it("never gives one slot to two people at once", async () => {
    const owner = await vendor();
    const { courtId } = await setup(owner);
    const customers = await Promise.all([1, 2, 3, 4, 5, 6].map(() => person()));
    const results = await Promise.all(customers.map((c) => book(c, courtId, { startAts: [at(3, "19:00"), at(3, "20:00")] })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    expect(await stack.db.turfSlots.countDocuments({})).toBe(2);
    expect(await stack.db.turfBookings.countDocuments({})).toBe(1);
  });

  it("gives held slots back once the hold runs out, on the next booking or the sweep", async () => {
    const owner = await vendor();
    const { courtId } = await setup(owner);
    const first = await person();
    const held = (await book(first, courtId, { startAts: [at(2, "09:00")] })).json().data.booking;
    const expire = async (id: string) => {
      const past = new Date(Date.now() - MINUTE);
      await stack.db.turfBookings.updateOne({ _id: new ObjectId(id) }, { $set: { holdUntil: past } });
      await stack.db.turfSlots.updateMany({ bookingId: new ObjectId(id) }, { $set: { holdUntil: past } });
    };
    await expire(held.id);
    expect(await slotState(courtId, day(2), "09:00")).toBe("free");
    const second = await person();
    expect((await book(second, courtId, { startAts: [at(2, "09:00")] })).statusCode).toBe(201);
    expect((await stack.db.turfBookings.findOne({ _id: new ObjectId(held.id) }))!.status).toBe("cancelled");

    const third = await person();
    const another = (await book(third, courtId, { startAts: [at(2, "15:00")] })).json().data.booking;
    await expire(another.id);
    expect((await sweep()).json().turfHolds).toBe(1);
    expect(await stack.db.turfSlots.countDocuments({ bookingId: new ObjectId(another.id) })).toBe(0);
  });

  it("books the same slots every week, paid up front, only when every week is free", async () => {
    const owner = await vendor();
    const { courtId } = await setup(owner);
    const customer = await person();
    expect((await call("POST", "/turf/desk/slots/block", owner.token, { courtId, startAts: [at(16, "07:00")], note: "Resurfacing" })).json().data).toEqual({ done: 1 });
    const blocked = await book(customer, courtId, { startAts: [at(2, "07:00")], weeks: 3 });
    expect(blocked.json().error.code).toBe("CONFLICT");
    expect(blocked.json().error.message).toContain("is not available");
    expect(await stack.db.turfSlots.countDocuments({ status: "held" })).toBe(0);
    expect((await book(customer, courtId, { startAts: [at(2, "07:00")], weeks: 13 })).json().error.details[0].path).toBe("body/weeks");
    await call("POST", "/turf/desk/slots/unblock", owner.token, { courtId, startAts: [at(16, "07:00")] });

    const booking = await bookPaid(customer, courtId, { startAts: [at(2, "07:00")], weeks: 3 });
    const view = (await call("GET", `/turf/orders/${booking.id}`, customer.token)).json().data;
    expect(view).toMatchObject({ weeks: 3, price: { items: 300_000, total: 300_500 } });
    expect(view.occurrences.map((o: { startAt: string }) => o.startAt)).toEqual([at(2, "07:00"), at(9, "07:00"), at(16, "07:00")]);
    expect(view.occurrences.reduce((s: number, o: { paid: number }) => s + o.paid, 0)).toBe(300_500);
    expect(await slotState(courtId, day(9), "07:00")).toBe("booked");

    const second = view.occurrences[1];
    const cancelled = (await call("POST", `/turf/orders/${booking.id}/cancel`, customer.token, { occurrences: [2] })).json().data;
    expect(cancelled.status).toBe("confirmed");
    expect(cancelled.occurrences.map((o: { status: string }) => o.status)).toEqual(["booked", "cancelled", "booked"]);
    expect(cancelled.occurrences[1]).toMatchObject({ refund: { percent: 100, amount: second.paid }, cancelledBy: "customer" });
    expect(cancelled.refunds).toMatchObject([{ amount: second.paid, status: "done" }]);
    expect(await slotState(courtId, day(9), "07:00")).toBe("free");
    expect(await slotState(courtId, day(16), "07:00")).toBe("booked");
  });

  it("refunds a customer by the tiers: in full from 6 hours, half from 2 hours, nothing after", async () => {
    const owner = await vendor();
    const { courtId } = await setup(owner);
    const customer = await person();
    const early = await bookPaid(customer, courtId, { startAts: [at(2, "10:00")] });
    const middle = await bookPaid(customer, courtId, { startAts: [at(2, "11:00")] });
    const late = await bookPaid(customer, courtId, { startAts: [at(2, "12:00")] });
    await startsIn(early.id, 7 * HOUR);
    await startsIn(middle.id, 3 * HOUR);
    await startsIn(late.id, HOUR);

    const preview = (await call("GET", `/turf/orders/${middle.id}`, customer.token)).json().data;
    expect(preview.occurrences[0].refundIfCancelled).toEqual({ percent: 50, amount: 50_250 });

    const full = (await call("POST", `/turf/orders/${early.id}/cancel`, customer.token, {})).json().data;
    expect(full).toMatchObject({ status: "cancelled", occurrences: [{ refund: { percent: 100, amount: 100_500 } }], refunds: [{ amount: 100_500 }] });
    const half = (await call("POST", `/turf/orders/${middle.id}/cancel`, customer.token, {})).json().data;
    expect(half).toMatchObject({ status: "cancelled", occurrences: [{ refund: { percent: 50, amount: 50_250 } }], refunds: [{ amount: 50_250 }] });
    const none = (await call("POST", `/turf/orders/${late.id}/cancel`, customer.token, {})).json().data;
    expect(none).toMatchObject({ status: "cancelled", occurrences: [{ refund: { percent: 0, amount: 0 } }], refunds: [] });

    const vendorBalance = (await stack.db.ledgerEntries.find({ accountId: `vendor:${owner.userId.toHexString()}` }).toArray()).reduce((s, e) => s + e.signedPaise, 0);
    expect(vendorBalance).toBe(90_000 / 2 + 90_000);
    const started = await bookPaid(customer, courtId, { startAts: [at(2, "13:00")] });
    await startsIn(started.id, -MINUTE);
    expect((await call("GET", `/turf/orders/${started.id}`, customer.token)).json().data).toMatchObject({ canCancel: false, occurrences: [{ refundIfCancelled: null }] });
    expect((await call("POST", `/turf/orders/${started.id}/cancel`, customer.token, {})).json().error.code).toBe("ORDER_STATE");
  });

  it("lets the ground cancel with a full refund, fee included, issuing credit notes", async () => {
    const owner = await vendor();
    const { courtId } = await setup(owner, { gstin: true });
    const customer = await person();
    const booking = await bookPaid(customer, courtId, { startAts: [at(2, "18:00")] });
    await startsIn(booking.id, 30 * MINUTE);
    expect((await call("POST", `/turf/desk/orders/${booking.id}/cancel`, owner.token, { reason: "x" })).statusCode).toBe(400);
    const done = await call("POST", `/turf/desk/orders/${booking.id}/cancel`, owner.token, { reason: "Floodlights are broken tonight." });
    expect(done.json().data).toMatchObject({ status: "cancelled", occurrences: [{ refund: { percent: 100, amount: 100_500 }, cancelledBy: "ground" }] });
    const notes = (await invoicesOf(booking.id)).filter((d) => d.kind === "credit_note");
    expect(notes.map((x) => x.totals.total)).toEqual([100_000, 500]);
    expect((await notesFor(customer.userId)).at(-1)).toMatchObject({ type: "turf.updated" });
    expect((await notesFor(customer.userId)).at(-1)!.body).toContain("Floodlights are broken tonight.");
    const ledger = await stack.db.ledgerEntries.find({ accountId: `vendor:${owner.userId.toHexString()}` }).toArray();
    expect(ledger.reduce((s, e) => s + e.signedPaise, 0)).toBe(0);
    expect(await stack.db.turfSlots.countDocuments({ bookingId: new ObjectId(booking.id) })).toBe(0);
    expect(await stack.db.auditLogs.countDocuments({ action: "turf_booking.cancel" })).toBe(1);
  });

  it("blocks and unblocks slots with a note, all or none", async () => {
    const owner = await vendor();
    const { courtId, groundId } = await setup(owner);
    const customer = await person();
    await bookPaid(customer, courtId, { startAts: [at(2, "20:00")] });
    const clash = await call("POST", "/turf/desk/slots/block", owner.token, { courtId, startAts: [at(2, "19:00"), at(2, "20:00")], note: "Tournament" });
    expect(clash.json().error).toMatchObject({ code: "CONFLICT" });
    expect(clash.json().error.message).toContain("is booked");
    expect(await stack.db.turfSlots.countDocuments({ status: "blocked" })).toBe(0);

    expect((await call("POST", "/turf/desk/slots/block", owner.token, { courtId, startAts: [at(2, "19:00"), at(2, "21:00")], note: "Tournament" })).json().data.done).toBe(2);
    expect(await slotState(courtId, day(2), "19:00")).toBe("blocked");
    expect((await book(customer, courtId, { startAts: [at(2, "21:00")] })).json().error.code).toBe("CONFLICT");
    const board = (await call("GET", `/turf/desk/grounds/${groundId}/board?date=${day(2)}`, owner.token)).json().data;
    expect(board.courts[0].slots.find((s: { start: string }) => s.start === "19:00")).toMatchObject({ state: "blocked", block: { note: "Tournament", by: "Asha Rao" } });
    expect(board.totals).toMatchObject({ booked: 1, blocked: 2 });

    expect((await call("POST", "/turf/desk/slots/unblock", owner.token, { courtId, startAts: [at(2, "21:00"), at(2, "20:00")] })).json().data.done).toBe(1);
    expect(await slotState(courtId, day(2), "21:00")).toBe("free");
    expect(await slotState(courtId, day(2), "20:00")).toBe("booked");
    expect(await stack.db.auditLogs.countDocuments({ action: { $in: ["turf_slot.block", "turf_slot.unblock"] } })).toBe(2);
  });

  it("marks arrivals and no-shows only around the slot", async () => {
    const owner = await vendor();
    const { courtId } = await setup(owner);
    const customer = await person();
    const booking = await bookPaid(customer, courtId, { startAts: [at(2, "06:00")] });
    const early = await call("POST", `/turf/desk/orders/${booking.id}/arrival`, owner.token, { n: 1, status: "arrived" });
    expect(early.json().error.message).toBe("Mark arrivals from 30 minutes before the slot.");
    await startsIn(booking.id, 20 * MINUTE);
    expect((await call("POST", `/turf/desk/orders/${booking.id}/arrival`, owner.token, { n: 1, status: "no_show" })).json().error.message).toBe(
      "Mark a no-show once the slot has started.",
    );
    expect((await call("POST", `/turf/desk/orders/${booking.id}/arrival`, owner.token, { n: 1, status: "arrived" })).json().data.occurrences[0].arrival).toBe("arrived");
    await startsIn(booking.id, -10 * MINUTE);
    expect((await call("POST", `/turf/desk/orders/${booking.id}/arrival`, owner.token, { n: 1, status: "no_show" })).json().data.occurrences[0].arrival).toBe("no_show");
    expect((await call("POST", `/turf/desk/orders/${booking.id}/arrival`, owner.token, { n: 2, status: "arrived" })).json().error.details[0].path).toBe("body/n");
    expect((await call("GET", `/turf/orders/${booking.id}`, customer.token)).json().data.occurrences[0].arrival).toBe("no_show");
    await startsIn(booking.id, -26 * HOUR);
    expect((await call("POST", `/turf/desk/orders/${booking.id}/arrival`, owner.token, { n: 1, status: "arrived" })).json().error.message).toBe(
      "Arrivals can be marked until a day after the slot.",
    );
  });

  it("releases the ground's share once each date has been played", async () => {
    const owner = await vendor();
    const { courtId } = await setup(owner);
    const customer = await person();
    const booking = await bookPaid(customer, courtId, { startAts: [at(2, "08:00")], weeks: 2 });
    const before = (await call("GET", "/vendor/payments", owner.token)).json().data;
    expect(before.balance).toMatchObject({ available: 0, pending: 180_000 });
    await startsIn(booking.id, -2 * HOUR);
    const after = (await call("GET", "/vendor/payments", owner.token)).json().data;
    expect(after.balance).toMatchObject({ available: 90_000, pending: 90_000 });
    expect((await call("POST", `/turf/desk/orders/${booking.id}/cancel`, owner.token, { reason: "Changing the turf." })).json().data.occurrences[0].status).toBe("booked");
    const statement = (await call("GET", "/vendor/payments/statement", owner.token)).json().data;
    expect(statement.every((l: { module: string }) => l.module === "turf")).toBe(true);
    expect((await sweep()).json().turfReleases).toBe(0);
  });

  it("checks team permissions and verification at the desk", async () => {
    const owner = await vendor();
    const { bizId, courtId, groundId } = await setup(owner);
    const viewer = await teamMember(owner, bizId, ["turf.bookings"]);
    const blocker = await teamMember(owner, bizId, ["turf.block"]);
    const unverified = await teamMember(owner, bizId, ["turf.bookings"], false);
    const outsider = await person({ verified: true });
    const customer = await person();
    const booking = await bookPaid(customer, courtId, { startAts: [at(2, "17:00")] });

    expect((await call("GET", "/turf/desk/grounds", viewer.token)).json().data).toMatchObject([{ id: groundId, owner: false, permissions: ["turf.bookings"] }]);
    expect((await call("GET", "/turf/desk/grounds", owner.token)).json().data).toMatchObject([{ id: groundId, owner: true }]);
    expect((await call("GET", `/turf/desk/grounds/${groundId}/board`, viewer.token)).statusCode).toBe(200);
    expect((await call("GET", `/turf/desk/orders/${booking.id}`, viewer.token)).json().data.customer.phone).toEqual(expect.any(String));
    expect((await call("POST", "/turf/desk/slots/block", viewer.token, { courtId, startAts: [at(2, "16:00")] })).statusCode).toBe(403);
    expect((await call("POST", `/turf/desk/orders/${booking.id}/cancel`, viewer.token, { reason: "Not allowed here." })).statusCode).toBe(403);
    expect((await call("PUT", `/turf/desk/courts/${courtId}/prices`, viewer.token, { prices: { base: 90_000, weekend: null, peak: [] } })).statusCode).toBe(403);
    expect((await call("GET", `/turf/desk/grounds/${groundId}/board`, unverified.token)).json().error.code).toBe("KYC_REQUIRED");
    expect((await call("GET", "/turf/desk/grounds", unverified.token)).json().data).toEqual([]);
    expect((await call("GET", `/turf/desk/grounds/${groundId}/board`, outsider.token)).statusCode).toBe(404);
    expect((await call("PATCH", `/vendor/courts/${courtId}`, viewer.token, { name: "Mine" })).statusCode).toBe(403);

    expect((await call("POST", "/turf/desk/slots/block", blocker.token, { courtId, startAts: [at(2, "16:00")] })).json().data.done).toBe(1);
    const prices = await call("PUT", `/turf/desk/courts/${courtId}/prices`, owner.token, { prices: { base: 80_000, weekend: 90_000, peak: [] } });
    expect(prices.json().data).toMatchObject({ priceFrom: 80_000, courtList: [{ prices: { base: 80_000, weekend: 90_000 } }] });
    expect((await stack.db.turfBookings.findOne({ _id: new ObjectId(booking.id) }))!.occurrences[0]!.slots[0]!.price).toBe(100_000);
  });

  it("keeps booked slots when the court's hours change, and won't remove a court with bookings to come", async () => {
    const owner = await vendor();
    const { courtId } = await setup(owner);
    const customer = await person();
    await bookPaid(customer, courtId, { startAts: [at(2, "05:00")] });
    const narrower = ALL_DAY.map((h) => ({ ...h, open: "06:00" }));
    const refused = await call("PATCH", `/vendor/courts/${courtId}`, owner.token, { hours: narrower });
    expect(refused.json().error).toMatchObject({ code: "CONFLICT" });
    expect(refused.json().error.message).toContain("wouldn't fit the new hours");
    expect((await call("PATCH", `/vendor/courts/${courtId}`, owner.token, { name: "Main pitch", status: "paused" })).json().data.courtList[0]).toMatchObject({ name: "Main pitch", status: "paused" });
    expect((await book(await person(), courtId, { startAts: [at(2, "09:00")] })).statusCode).toBe(404);
    expect((await call("DELETE", `/vendor/courts/${courtId}`, owner.token)).json().error.message).toBe("This court has a booking still to come. Cancel it first.");
  });

  it("opens reviews once a date is played, and shows them on the ground signed out", async () => {
    const owner = await vendor();
    const { courtId, groundId } = await setup(owner);
    const customer = await person();
    const booking = await bookPaid(customer, courtId, { startAts: [at(2, "07:00")] });
    expect((await call("PUT", `/turf/orders/${booking.id}/review`, customer.token, { rating: 5 })).statusCode).toBe(409);
    await startsIn(booking.id, -2 * HOUR);
    const view = (await call("GET", `/turf/orders/${booking.id}`, customer.token)).json().data;
    expect(view).toMatchObject({ canReview: true, reviewUntil: expect.any(String) });
    const review = await call("PUT", `/turf/orders/${booking.id}/review`, customer.token, { rating: 5, text: "Great turf, good lights." });
    expect(review.statusCode).toBe(200);
    const reviews = await anon(`/turf/${groundId}/reviews`);
    expect(reviews.statusCode).toBe(200);
    expect(reviews.json().data).toMatchObject([{ rating: 5, text: "Great turf, good lights." }]);
    const stranger = await person();
    expect((await call("PUT", `/turf/orders/${booking.id}/review`, stranger.token, { rating: 1 })).statusCode).toBe(404);
  });

  it("takes a vendor's coupon on a turf business", async () => {
    const owner = await vendor();
    const { bizId, courtId } = await setup(owner);
    const made = await call("POST", "/vendor/coupons", owner.token, { code: "TURF200", kind: "flat", value: 20_000, businessIds: [bizId] });
    expect(made.statusCode).toBe(201);
    expect((await stack.db.coupons.findOne({ code: "TURF200" }))!.modules).toEqual(["turf"]);
    const customer = await person();
    const offers = (await call("POST", `/turf/courts/${courtId}/offers`, customer.token, { startAts: [at(2, "10:00")], code: "turf200" })).json().data;
    expect(offers).toMatchObject({ offers: [{ code: "TURF200", discount: 20_000 }], checked: { code: "TURF200", discount: 20_000, problem: null } });
    const res = await book(customer, courtId, { startAts: [at(2, "10:00")], coupon: "TURF200" });
    expect(res.json().data.booking).toMatchObject({ price: { items: 100_000, discount: 20_000, total: 80_500 }, coupon: { code: "TURF200", fundedBy: "vendor" } });
    await pay(res.json().data.checkoutUrl);
    expect(await stack.db.couponRedemptions.countDocuments({})).toBe(1);
    expect((await stack.db.turfBookings.findOne({}))!.price.commission).toBe(8_000);
  });

  it("lets the console list grounds, take one down refunding bookings to come, keep the sports list and set turf rules, audited", async () => {
    const owner = await vendor();
    const { groundId, courtId } = await setup(owner);
    const customer = await person();
    const booking = await bookPaid(customer, courtId, { startAts: [at(2, "10:00")] });
    const viewer = await staff(["businesses.view"]);
    const manager = await staff(["businesses.view", "businesses.manage", "modules.view", "modules.manage"]);

    expect((await call("GET", "/ruxstar/turf/grounds?status=live", viewer.token)).json().data).toMatchObject([{ id: groundId, status: "live", vendorId: owner.userId.toHexString() }]);
    expect((await call("GET", `/ruxstar/turf/grounds/${groundId}`, viewer.token)).json().data.bookings).toEqual({ upcoming: 1, total: 1, cancelled: 0 });
    expect((await call("POST", `/ruxstar/turf/grounds/${groundId}/take-down`, viewer.token, { reason: "Unsafe surface." })).statusCode).toBe(403);
    const down = await call("POST", `/ruxstar/turf/grounds/${groundId}/take-down`, manager.token, { reason: "Unsafe surface reported." });
    expect(down.json().data).toMatchObject({ refunded: 1, ground: { status: "removed", removal: { reason: "Unsafe surface reported." } } });
    expect((await stack.db.turfBookings.findOne({ _id: new ObjectId(booking.id) }))!).toMatchObject({
      status: "cancelled",
      occurrences: [{ cancellation: { by: "staff", refund: 100_500 } }],
    });
    expect((await call("GET", `/turf/orders/${booking.id}`, customer.token)).json().data.occurrences[0].cancelledBy).toBe("ruxstar");
    expect((await notesFor(owner.userId)).at(-1)!.title).toBe("Ruxstar took down Kick Off Arena");
    expect((await anon("/turf")).json().data).toEqual([]);
    expect((await anon(`/turf/${groundId}`)).statusCode).toBe(404);
    expect(await stack.db.auditLogs.countDocuments({ action: "turf_ground.take_down" })).toBe(1);

    expect((await call("POST", "/ruxstar/turf/sports", viewer.token, { key: "kabaddi", name: "Kabaddi" })).statusCode).toBe(403);
    expect((await call("POST", "/ruxstar/turf/sports", manager.token, { key: "kabaddi", name: "Kabaddi" })).statusCode).toBe(201);
    expect((await call("POST", "/ruxstar/turf/sports", manager.token, { key: "kabaddi", name: "Kabaddi" })).statusCode).toBe(409);
    expect((await call("PATCH", "/ruxstar/turf/sports/swimming", manager.token, { active: false })).json().data).toMatchObject({ key: "swimming", active: false });
    const sports = (await anon("/turf/sports")).json().data.map((s: { key: string }) => s.key);
    expect(sports).toContain("kabaddi");
    expect(sports).not.toContain("swimming");
    expect(await stack.db.auditLogs.countDocuments({ action: { $in: ["turf_sport.create", "turf_sport.update"] } })).toBe(2);

    const settings = await call("PATCH", "/ruxstar/modules/turf", manager.token, { turfRules: { refundFullHours: 12, maxRepeatWeeks: 8 } });
    expect(settings.json().data.turfRules).toMatchObject({ refundFullHours: 12, refundHalfHours: 2, maxRepeatWeeks: 8 });
    const bad = await call("PATCH", "/ruxstar/modules/turf", manager.token, { turfRules: { refundHalfHours: 20 } });
    expect(bad.json().error.details[0].path).toBe("body/turfRules/refundHalfHours");
    expect((await call("PATCH", "/ruxstar/modules/events", manager.token, { turfRules: { holdMinutes: 10 } })).statusCode).toBe(400);
    expect(await stack.db.auditLogs.countDocuments({ action: "module_settings.update" })).toBe(1);
    expect((await anon("/turf/rules")).json().data).toMatchObject({ refundFullHours: 12, maxRepeatWeeks: 8, commissionBps: 1000 });
  });
});
