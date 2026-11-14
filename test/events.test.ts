import { createHash, randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stamp } from "../src/platform/db.js";
import { forgetModuleState } from "../src/platform/module-switch.js";
import { JOB_TOKEN, signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>> & { username: string };
const BACK = "https://ruxstar.com/tickets";
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const VENUE = { name: "Shilpakala Vedika", address: "Madhapur, near Hitech City", city: "Hyderabad" };

describe("events and tickets", () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack?.stop());
  beforeEach(async () => {
    await Promise.all([
      stack.db.businesses.deleteMany({}),
      stack.db.events.deleteMany({}),
      stack.db.eventOrders.deleteMany({}),
      stack.db.eventTickets.deleteMany({}),
      stack.db.eventWaits.deleteMany({}),
      stack.db.employments.deleteMany({}),
      stack.db.ledgerEntries.deleteMany({}),
      stack.db.notifications.deleteMany({}),
      stack.db.auditLogs.deleteMany({}),
    ]);
    await stack.db.moduleSettings.updateOne({ module: "events" }, { $set: { live: true, signupsOpen: true, commissionBps: 1000, platformFee: 500 }, $unset: { eventRules: "" } });
    await stack.db.moduleSettings.updateOne({ module: "pod" }, { $set: { live: true, signupsOpen: true } });
    forgetModuleState();
  });

  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, token: string, payload?: object) =>
    stack.app.inject({
      method,
      url: `/v1${url}`,
      headers: web(token, method === "GET" || method === "DELETE" ? {} : { "idempotency-key": randomUUID() }),
      ...(payload ? { payload } : {}),
    });
  const sweep = () => stack.app.inject({ method: "POST", url: "/jobs/orders", headers: { authorization: `Bearer ${JOB_TOKEN}` } });

  let n = 0;
  async function person(opts: { verified?: boolean; vendor?: boolean; name?: string } = {}): Promise<User> {
    const user = await signIn(stack, opts.vendor ? { vendor: true } : {});
    const username = `guest${Date.now() % 1e6}${n++}`;
    await stack.db.users.updateOne(
      { _id: user.userId },
      { $set: { name: opts.name ?? "Kiran Das", username, ...(opts.verified ? { "kyc.base": "approved" } : {}) } },
    );
    return { ...user, username };
  }
  const organiser = () => person({ vendor: true, verified: true, name: "Asha Rao" });

  async function business(owner: User, module: "events" | "pod" = "events") {
    const _id = new ObjectId();
    await stack.db.businesses.insertOne({
      _id,
      ownerId: owner.userId,
      module,
      type: module === "events" ? "concert" : "print_shop",
      name: module === "events" ? "Live Arena" : "Rao Prints",
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

  const eventBody = (extra: object = {}) => ({
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
    ...extra,
  });

  async function event(owner: User, businessId: string, extra: object = {}) {
    const created = await call("POST", `/vendor/businesses/${businessId}/events`, owner.token, eventBody(extra));
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id as string;
    const published = await call("POST", `/vendor/events/${id}/publish`, owner.token);
    expect(published.statusCode).toBe(200);
    return published.json().data as { id: string; tiers: { id: string; name: string; price: number; left: number }[] };
  }

  let phones = 0;
  const holder = (tierId: string, name = "Ravi Kumar") => ({ tierId, name, phone: `98765${String(10_000 + phones++).slice(-5)}` });

  async function book(customer: User, eventId: string, tickets: object[], extra: object = {}) {
    const res = await call("POST", `/events/${eventId}/tickets`, customer.token, { tickets, returnTo: BACK, ...extra });
    return res;
  }

  /** Opens the checkout link the way a browser does and presses the test button. */
  async function pay(checkoutUrl: string) {
    const url = new URL(checkoutUrl);
    const page = await stack.app.inject({ method: "GET", url: url.pathname + url.search });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Pay (test");
    const test = await stack.app.inject({ method: "POST", url: `${url.pathname}/test${url.search}` });
    expect(test.json()).toEqual({ status: "confirmed" });
  }

  /** Moves the event to now, so its tickets can be checked in today. */
  const happeningNow = (eventId: string) =>
    stack.db.events.updateOne(
      { _id: new ObjectId(eventId) },
      { $set: { startsAt: new Date(Date.now() - HOUR), endsAt: new Date(Date.now() + 2 * HOUR) } },
    );

  async function staff(permissions: string[]) {
    const user = await signIn(stack, { ruxstarStaff: true });
    await stack.db.ruxstarStaff.insertOne({ _id: new ObjectId(), userId: user.userId, title: "Ops", modules: [], permissions, grantedBy: user.userId, status: "active", ...stamp() });
    return user;
  }

  async function gateKeeper(owner: User, businessId: string, permissions: string[], verified = false) {
    const who = await person({ verified, name: "Gopal Gate" });
    const invited = await call("POST", `/vendor/businesses/${businessId}/team`, owner.token, { username: who.username, permissions });
    expect(invited.statusCode).toBe(201);
    const accepted = await call("POST", `/employment/${invited.json().data.id}/accept`, who.token);
    expect(accepted.statusCode).toBe(200);
    return { who, place: accepted.json().data as { access: string; permissions: string[] } };
  }

  it("makes a draft, says what publishing needs, and lists it for customers once live", async () => {
    const owner = await organiser();
    const bizId = await business(owner);

    const tooMany = await call("POST", `/vendor/businesses/${bizId}/events`, owner.token, eventBody({
      tiers: Array.from({ length: 6 }, (_, i) => ({ name: `Type ${i}`, price: 0, capacity: 10 })),
    }));
    expect(tooMany.json().error.code).toBe("VALIDATION_FAILED");
    const both = await call("POST", `/vendor/businesses/${bizId}/events`, owner.token, eventBody({ online: { link: "https://meet.example.com/x" } }));
    expect(both.json().error.code).toBe("VALIDATION_FAILED");

    const created = await call("POST", `/vendor/businesses/${bizId}/events`, owner.token, eventBody({ startsAt: new Date(Date.now() + HOUR).toISOString(), endsAt: new Date(Date.now() + 2 * HOUR).toISOString() }));
    expect(created.json().data).toMatchObject({ status: "draft", missing: [] });
    const id = created.json().data.id;
    await stack.db.events.updateOne({ _id: new ObjectId(id) }, { $set: { startsAt: new Date(Date.now() - HOUR) } });
    const late = await call("POST", `/vendor/events/${id}/publish`, owner.token);
    expect(late.json().error).toMatchObject({ code: "BUSINESS_INCOMPLETE", message: "Set a start time in the future" });

    const customer = await person();
    expect((await call("GET", `/events/${id}`, customer.token)).statusCode).toBe(404);
    const live = await event(owner, bizId);
    const list = (await call("GET", "/events?city=hyderabad", customer.token)).json().data;
    expect(list).toMatchObject([{ id: live.id, title: "Sunburn Nights", priceFrom: 50_000, free: false, soldOut: false, online: false }]);
    const detail = (await call("GET", `/events/${live.id}`, customer.token)).json().data;
    expect(detail).toMatchObject({ status: "live", canBuy: true, platformFee: 500, refunds: { policy: "standard", hours: 24 } });
    expect((await call("GET", "/events?city=pune", customer.token)).json().data).toEqual([]);
  });

  it("books free tickets straight away, one QR per person, and stops at capacity", async () => {
    const owner = await organiser();
    const bizId = await business(owner);
    const ev = await event(owner, bizId, { tiers: [{ name: "Free entry", price: 0, capacity: 2 }] });
    const tierId = ev.tiers[0]!.id;
    const customer = await person();

    const res = await book(customer, ev.id, [holder(tierId, "Ravi Kumar"), holder(tierId, "Meena Kumar")]);
    expect(res.statusCode).toBe(201);
    const { order, checkoutUrl } = res.json().data;
    expect(checkoutUrl).toBeNull();
    expect(order).toMatchObject({ status: "confirmed", price: { items: 0, platformFee: 0, total: 0 } });
    expect(order.tickets).toHaveLength(2);
    for (const t of order.tickets) {
      expect(t.status).toBe("valid");
      expect(t.qr).toMatch(/^RX1\./);
      expect(t.code).toMatch(/^[A-HJ-NP-Z]{6}$/);
    }

    const more = await book(await person(), ev.id, [holder(tierId)]);
    expect(more.statusCode).toBe(409);
    const detail = (await call("GET", `/events/${ev.id}`, customer.token)).json().data;
    expect(detail.tiers[0]).toMatchObject({ left: 0, soldOut: true });
    expect(detail.myOrders).toMatchObject([{ id: order.id, status: "confirmed", tickets: 2 }]);
  });

  it("asks for required answers and checks team entries", async () => {
    const owner = await organiser();
    const bizId = await business(owner);
    const ev = await event(owner, bizId, {
      kind: "sports",
      team: { min: 2, max: 3 },
      tiers: [{ name: "Team entry", price: 100_000, capacity: 8 }],
      questions: [{ label: "T-shirt size", required: true }],
    });
    const detail = (await call("GET", `/events/${ev.id}`, owner.token)).json().data;
    const [tier] = detail.tiers;
    const [question] = detail.questions;
    const captain = await person();
    const one = await book(captain, ev.id, [{ ...holder(tier.id), answers: [{ id: question.id, answer: "L" }] }], { team: { tierId: tier.id, name: "Strikers" } });
    expect(one.json().error.code).toBe("ORDER_INVALID");
    const noAnswer = await book(captain, ev.id, [holder(tier.id), holder(tier.id)], { team: { tierId: tier.id, name: "Strikers" } });
    expect(noAnswer.json().error.code).toBe("ORDER_INVALID");
    const players = [1, 2, 3].map((i) => ({ ...holder(tier.id, `Player ${i}`), answers: [{ id: question.id, answer: "M" }] }));
    const ok = await book(captain, ev.id, players, { team: { tierId: tier.id, name: "Strikers" } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().data.order).toMatchObject({ team: "Strikers", price: { items: 100_000, platformFee: 500, total: 100_500 } });
    expect(ok.json().data.order.tickets).toHaveLength(3);
  });

  it("takes payment, confirms the tickets, refunds a cancellation in full and gives the seats back", async () => {
    const owner = await organiser();
    const bizId = await business(owner);
    const ev = await event(owner, bizId, { tiers: [{ name: "General", price: 50_000, capacity: 10 }] });
    const tierId = ev.tiers[0]!.id;
    const customer = await person();

    const res = await book(customer, ev.id, [holder(tierId), holder(tierId)]);
    const { order, checkoutUrl } = res.json().data;
    expect(order).toMatchObject({ status: "awaiting_payment", price: { items: 100_000, platformFee: 500, total: 100_500 } });
    expect(order.tickets[0].qr).toBeNull();
    await pay(checkoutUrl);

    const paid = (await call("GET", `/events/orders/${order.id}`, customer.token)).json().data;
    expect(paid).toMatchObject({ status: "confirmed", canCancel: true });
    expect(paid.tickets.every((t: { qr: string | null }) => t.qr)).toBe(true);
    const vendorView = (await call("GET", `/vendor/events/${ev.id}`, owner.token)).json().data;
    expect(vendorView.tiers[0]).toMatchObject({ capacity: 10, sold: 2, held: 0, left: 8 });
    expect(vendorView.money).toMatchObject({ sales: 100_000, share: 90_000 });

    const cancelled = await call("POST", `/events/orders/${order.id}/cancel`, customer.token);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().data).toMatchObject({ status: "cancelled", refund: { amount: 100_500, status: "done" } });
    expect((await call("GET", `/events/${ev.id}`, customer.token)).json().data.tiers[0].left).toBe(10);
    const ledger = await stack.db.ledgerEntries.find({ accountId: `vendor:${owner.userId.toHexString()}` }).toArray();
    expect(ledger.reduce((sum, e) => sum + e.signedPaise, 0)).toBe(0);
  });

  it("won't refund after the cutoff or when the organiser gives no refunds", async () => {
    const owner = await organiser();
    const bizId = await business(owner);
    const none = await event(owner, bizId, { refunds: "none", tiers: [{ name: "Free", price: 0, capacity: 5 }] });
    const customer = await person();
    const order = (await book(customer, none.id, [holder(none.tiers[0]!.id)])).json().data.order;
    expect((await call("POST", `/events/orders/${order.id}/cancel`, customer.token)).json().error.message).toBe(
      "The organiser doesn't give refunds for this event.",
    );

    const soon = await event(owner, bizId, { tiers: [{ name: "Free", price: 0, capacity: 5 }] });
    const late = (await book(customer, soon.id, [holder(soon.tiers[0]!.id)])).json().data.order;
    await stack.db.events.updateOne({ _id: new ObjectId(soon.id) }, { $set: { startsAt: new Date(Date.now() + 2 * HOUR), endsAt: new Date(Date.now() + 5 * HOUR) } });
    expect((await call("POST", `/events/orders/${late.id}/cancel`, customer.token)).json().error.code).toBe("ORDER_STATE");
  });

  it("gives back unpaid seats after 20 minutes", async () => {
    const owner = await organiser();
    const bizId = await business(owner);
    const ev = await event(owner, bizId, { tiers: [{ name: "General", price: 50_000, capacity: 1 }] });
    const customer = await person();
    const { order } = (await book(customer, ev.id, [holder(ev.tiers[0]!.id)])).json().data;
    expect((await call("GET", `/events/${ev.id}`, customer.token)).json().data.tiers[0].left).toBe(0);
    await stack.db.eventOrders.updateOne({ _id: new ObjectId(order.id) }, { $set: { holdUntil: new Date(Date.now() - 1000) } });
    expect((await sweep()).json()).toMatchObject({ eventHolds: 1 });
    expect((await call("GET", `/events/orders/${order.id}`, customer.token)).json().data.status).toBe("cancelled");
    expect((await call("GET", `/events/${ev.id}`, customer.token)).json().data.tiers[0].left).toBe(1);
  });

  it("offers freed seats to the waitlist in order, holds them, and moves on when the offer runs out", async () => {
    const owner = await organiser();
    const bizId = await business(owner);
    const ev = await event(owner, bizId, { tiers: [{ name: "Free", price: 0, capacity: 1 }] });
    const tierId = ev.tiers[0]!.id;
    const [first, second, third] = [await person(), await person(), await person()];
    const firstOrder = (await book(first, ev.id, [holder(tierId)])).json().data.order;

    const wait = await call("POST", `/events/${ev.id}/waitlist`, second.token, { tierId, quantity: 1 });
    expect(wait.statusCode).toBe(201);
    expect(wait.json().data).toMatchObject({ status: "waiting", position: 1 });
    expect((await call("POST", `/events/${ev.id}/waitlist`, second.token, { tierId, quantity: 1 })).statusCode).toBe(409);
    await call("POST", `/events/${ev.id}/waitlist`, third.token, { tierId, quantity: 1 });

    await call("POST", `/events/orders/${firstOrder.id}/cancel`, first.token);
    const offered = (await call("GET", `/events/${ev.id}`, second.token)).json().data;
    expect(offered.myWaits).toMatchObject([{ status: "offered", position: null }]);
    expect(offered.tiers[0].left).toBe(0);
    expect((await stack.db.notifications.findOne({ userId: second.userId }))?.title).toBe("Tickets free for you: Sunburn Nights");
    expect((await book(third, ev.id, [holder(tierId)])).statusCode).toBe(409);

    await stack.db.eventWaits.updateOne({ customerId: second.userId }, { $set: { offeredUntil: new Date(Date.now() - 1000) } });
    expect((await sweep()).json()).toMatchObject({ eventOffers: 1 });
    expect((await call("GET", `/events/${ev.id}`, second.token)).json().data.myWaits).toEqual([]);
    const next = (await call("GET", `/events/${ev.id}`, third.token)).json().data.myWaits[0];
    expect(next).toMatchObject({ status: "offered" });

    const booked = await book(third, ev.id, [holder(tierId)], { waitlistId: next.id });
    expect(booked.statusCode).toBe(201);
    expect(booked.json().data.order.status).toBe("confirmed");
    expect((await stack.db.eventWaits.findOne({ customerId: third.userId }))!.status).toBe("booked");
  });

  it("refunds everyone when the organiser cancels, platform fee included", async () => {
    const owner = await organiser();
    const bizId = await business(owner);
    const ev = await event(owner, bizId);
    const customer = await person();
    const { order, checkoutUrl } = (await book(customer, ev.id, [holder(ev.tiers[0]!.id)])).json().data;
    await pay(checkoutUrl);

    const res = await call("POST", `/vendor/events/${ev.id}/cancel`, owner.token, { reason: "The venue flooded." });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: "cancelled", cancellation: { by: "vendor", reason: "The venue flooded." } });
    const after = (await call("GET", `/events/orders/${order.id}`, customer.token)).json().data;
    expect(after).toMatchObject({ status: "cancelled", refund: { amount: 50_500, status: "done" } });
    expect(await stack.db.notifications.countDocuments({ userId: customer.userId, type: "event.updated" })).toBe(1);
  });

  it("checks people in once a day: green, then amber, and red for anything else", async () => {
    const owner = await organiser();
    const bizId = await business(owner);
    const ev = await event(owner, bizId, { tiers: [{ name: "Free", price: 0, capacity: 10 }] });
    const other = await event(owner, bizId, { title: "Another night", tiers: [{ name: "Free", price: 0, capacity: 10 }] });
    const customer = await person();
    const { order } = (await book(customer, ev.id, [holder(ev.tiers[0]!.id, "Ravi Kumar"), holder(ev.tiers[0]!.id, "Meena")])).json().data;
    const otherTicket = (await book(customer, other.id, [holder(other.tiers[0]!.id)])).json().data.order.tickets[0];
    const [ravi, meena] = order.tickets;

    const scan = (qr: string, token = owner.token) => call("POST", `/events/desk/${ev.id}/scan`, token, { qr });
    expect((await scan(ravi.qr)).json().data).toMatchObject({ result: "wrong_day" });

    await happeningNow(ev.id);
    const green = (await scan(ravi.qr)).json().data;
    expect(green).toMatchObject({ result: "ok", ticket: { name: "Ravi Kumar" }, counts: { tickets: 2, inToday: 1 } });
    const amber = (await scan(ravi.qr)).json().data;
    expect(amber.result).toBe("inside");
    expect(amber.message).toMatch(/^Already inside since/);
    expect((await scan(otherTicket.qr)).json().data).toMatchObject({ result: "wrong_event", message: "This ticket is for Another night." });
    expect((await scan("RX1.nonsense.abc")).json().data.result).toBe("unknown");
    const forged = `RX1.${meena.id}.${"A".repeat(22)}`;
    expect((await scan(forged)).json().data.result).toBe("unknown");

    await stack.db.eventTickets.updateOne({ _id: new ObjectId(meena.id) }, { $set: { status: "cancelled" } });
    expect((await scan(meena.qr)).json().data.result).toBe("cancelled");

    const stranger = await person();
    expect((await scan(ravi.qr, stranger.token)).statusCode).toBe(404);
  });

  it("finds tickets by code or phone and checks them in by hand, on the record", async () => {
    const owner = await organiser();
    const bizId = await business(owner);
    const ev = await event(owner, bizId, { tiers: [{ name: "Free", price: 0, capacity: 10 }] });
    const customer = await person();
    const h = holder(ev.tiers[0]!.id, "Ravi Kumar");
    const ticket = (await book(customer, ev.id, [h])).json().data.order.tickets[0];
    await happeningNow(ev.id);

    const byCode = (await call("GET", `/events/desk/${ev.id}/lookup?q=${ticket.code.toLowerCase()}`, owner.token)).json().data;
    expect(byCode).toMatchObject([{ id: ticket.id, phone: `••${h.phone.slice(-4)}`, status: "valid", inToday: null }]);
    const byPhone = (await call("GET", `/events/desk/${ev.id}/lookup?q=%2B91${h.phone}`, owner.token)).json().data;
    expect(byPhone).toHaveLength(1);

    const res = await call("POST", `/events/desk/${ev.id}/tickets/${ticket.id}/check-in`, owner.token);
    expect(res.json().data.result).toBe("ok");
    const saved = await stack.db.eventTickets.findOne({ _id: new ObjectId(ticket.id) });
    expect(saved!.checkIns[0]).toMatchObject({ manual: true, offline: false });
    expect(await stack.db.auditLogs.countDocuments({ action: "event_ticket.check_in" })).toBe(1);
  });

  it("lets a gate keeper scan without verification, but not see the guest list", async () => {
    const owner = await organiser();
    const bizId = await business(owner);
    const ev = await event(owner, bizId, { tiers: [{ name: "Free", price: 0, capacity: 10 }] });
    const ticket = (await book(await person(), ev.id, [holder(ev.tiers[0]!.id)])).json().data.order.tickets[0];
    await happeningNow(ev.id);

    const { who, place } = await gateKeeper(owner, bizId, ["tickets.scan"]);
    expect(place).toMatchObject({ access: "on", permissions: ["tickets.scan"] });
    const desks = (await call("GET", "/events/desk", who.token)).json().data;
    expect(desks).toMatchObject([{ id: ev.id, role: "team", canSeeGuests: false, today: true }]);
    expect((await call("POST", `/events/desk/${ev.id}/scan`, who.token, { qr: ticket.qr })).json().data.result).toBe("ok");
    expect((await call("GET", `/events/desk/${ev.id}/guests`, who.token)).statusCode).toBe(403);

    const guests = (await call("GET", `/events/desk/${ev.id}/guests?view=arrived`, owner.token)).json().data;
    expect(guests).toMatchObject([{ id: ticket.id, by: "Gopal Gate", manual: false, clash: false }]);
    expect((await call("GET", `/events/desk/${ev.id}/guests?view=not_arrived`, owner.token)).json().data).toEqual([]);

    const unverified = await gateKeeper(owner, bizId, ["tickets.guests"]);
    expect(unverified.place).toMatchObject({ access: "verify", permissions: ["tickets.scan", "tickets.guests"] });
  });

  it("only offers each kind of business its own permissions", async () => {
    const owner = await organiser();
    const eventsBiz = await business(owner);
    const printBiz = await business(owner, "pod");
    const who = await person();
    const wrong = await call("POST", `/vendor/businesses/${eventsBiz}/team`, owner.token, { username: who.username, permissions: ["orders.view"] });
    expect(wrong.json().error.code).toBe("VALIDATION_FAILED");
    const other = await call("POST", `/vendor/businesses/${printBiz}/team`, owner.token, { username: who.username, permissions: ["tickets.scan"] });
    expect(other.json().error.code).toBe("VALIDATION_FAILED");
    const team = (await call("GET", `/vendor/businesses/${eventsBiz}/team`, owner.token)).json().data;
    expect(team.permissions.map((p: { key: string; verify: boolean }) => [p.key, p.verify])).toEqual([
      ["tickets.scan", false],
      ["tickets.guests", true],
    ]);
  });

  it("checks in offline: hashes for the phone, then sync flags a ticket let in on two phones", async () => {
    const owner = await organiser();
    const bizId = await business(owner);
    const ev = await event(owner, bizId, { tiers: [{ name: "Free", price: 0, capacity: 10 }] });
    const ticket = (await book(await person(), ev.id, [holder(ev.tiers[0]!.id, "Ravi Kumar")])).json().data.order.tickets[0];
    await happeningNow(ev.id);
    const { who } = await gateKeeper(owner, bizId, ["tickets.scan"]);

    const offline = (await call("GET", `/events/desk/${ev.id}/offline`, who.token)).json().data;
    expect(offline.tickets).toHaveLength(1);
    expect(offline.tickets[0]).toMatchObject({ id: ticket.id, h: createHash("sha256").update(ticket.qr).digest("hex"), s: "v", i: null });
    expect(JSON.stringify(offline)).not.toContain(ticket.qr);

    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    const first = (await call("POST", `/events/desk/${ev.id}/sync`, who.token, { scans: [{ ticketId: ticket.id, at, manual: false, fresh: true }] })).json().data;
    expect(first).toMatchObject({ saved: 1, clashes: [], counts: { inToday: 1 } });
    const again = (await call("POST", `/events/desk/${ev.id}/sync`, who.token, { scans: [{ ticketId: ticket.id, at, manual: false, fresh: true }] })).json().data;
    expect(again).toMatchObject({ saved: 0, clashes: [] });

    const later = new Date(Date.now() - 5 * 60_000).toISOString();
    const clash = (await call("POST", `/events/desk/${ev.id}/sync`, owner.token, { scans: [{ ticketId: ticket.id, at: later, manual: false, fresh: true }] })).json().data;
    expect(clash).toMatchObject({ saved: 0, clashes: [{ ticketId: ticket.id, name: "Ravi Kumar", firstAt: at }] });
    expect((await call("GET", `/events/desk/${ev.id}/guests`, owner.token)).json().data[0]).toMatchObject({ clash: true });
  });

  it("releases the organiser's share once the event is over", async () => {
    const owner = await organiser();
    const bizId = await business(owner);
    const ev = await event(owner, bizId, { tiers: [{ name: "General", price: 50_000, capacity: 10 }] });
    const customer = await person();
    const { order, checkoutUrl } = (await book(customer, ev.id, [holder(ev.tiers[0]!.id), holder(ev.tiers[0]!.id)])).json().data;
    await pay(checkoutUrl);

    const before = (await call("GET", "/vendor/payments", owner.token)).json().data;
    expect(before.balance).toMatchObject({ pending: 90_000, available: 0 });
    expect(before.upcoming).toMatchObject([{ orderId: order.id, amount: 90_000 }]);

    await stack.db.eventOrders.updateOne({ _id: new ObjectId(order.id) }, { $set: { releaseAt: new Date(Date.now() - 1000) } });
    expect((await sweep()).json()).toMatchObject({ eventReleases: 1 });
    const after = (await call("GET", "/vendor/payments", owner.token)).json().data;
    expect(after.balance).toMatchObject({ pending: 0, available: 90_000 });
    const statement = (await call("GET", "/vendor/payments/statement", owner.token)).json().data;
    expect(statement.map((l: { kind: string }) => l.kind)).toEqual(["available", "paid"]);
    expect(statement[1]).toMatchObject({ module: "events", order: { label: "Sunburn Nights, 2 tickets", total: 100_500 } });
  });

  it("lets Ruxstar take an event down, refunding everyone and telling the organiser", async () => {
    const owner = await organiser();
    const bizId = await business(owner);
    const ev = await event(owner, bizId);
    const customer = await person();
    const { order, checkoutUrl } = (await book(customer, ev.id, [holder(ev.tiers[0]!.id)])).json().data;
    await pay(checkoutUrl);

    const viewer = await staff(["businesses.view"]);
    expect((await call("GET", "/ruxstar/events?status=live", viewer.token)).json().data).toMatchObject([{ id: ev.id }]);
    expect((await call("POST", `/ruxstar/events/${ev.id}/take-down`, viewer.token, { reason: "Fake listing." })).statusCode).toBe(403);

    const manager = await staff(["businesses.view", "businesses.manage"]);
    const res = await call("POST", `/ruxstar/events/${ev.id}/take-down`, manager.token, { reason: "Fake listing reported by buyers." });
    expect(res.json().data).toMatchObject({ status: "cancelled", cancellation: { by: "staff" } });
    expect((await call("GET", `/events/orders/${order.id}`, customer.token)).json().data).toMatchObject({ status: "cancelled", refund: { status: "done" } });
    const told = await stack.db.notifications.find({ userId: owner.userId }).toArray();
    expect(told.map((t) => t.title)).toContain("Ruxstar took down Sunburn Nights");
    expect(await stack.db.auditLogs.countDocuments({ action: "event.take_down" })).toBe(1);
  });

  it("lets Ruxstar change the events rules, on the events module only", async () => {
    const admin = await staff(["modules.view", "modules.manage"]);
    const res = await call("PATCH", "/ruxstar/modules/events", admin.token, { eventRules: { refundHours: 48 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.eventRules).toEqual({ refundHours: 48, waitlistHours: 2, maxTicketTypes: 5, maxQuestions: 3 });
    forgetModuleState();
    const customer = await person();
    expect((await call("GET", "/events/rules", customer.token)).json().data).toMatchObject({ refundHours: 48, maxTicketTypes: 5 });
    expect((await call("PATCH", "/ruxstar/modules/pod", admin.token, { eventRules: { refundHours: 1 } })).json().error.code).toBe("VALIDATION_FAILED");
  });
});
