import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { gigFileLinks } from "../src/modules/gigs/checkout.js";
import { DEFAULT_GIGS_RULES, maxPartRefundOf, vendorLeftOf } from "../src/modules/gigs/rules.js";
import type { GigOrderDoc } from "../src/platform/db.js";
import { forgetModuleState } from "../src/platform/module-switch.js";
import { JOB_TOKEN, signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>> & { username: string };
const BACK = "https://ruxstar.com/gigs";
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;

describe("freelance money", () => {
  const order = (refunds: GigOrderDoc["refunds"] = []) =>
    ({
      price: { items: 50_000, platformFee: 500, discount: 10_000, coupon: { id: new ObjectId(), code: "X", fundedBy: "vendor" }, total: 40_500, commissionBps: 1000, commission: 4000 },
      refunds,
    }) as Pick<GigOrderDoc, "price" | "refunds">;

  it("takes a vendor coupon and the commission out of the freelancer's share, and part refunds out of what's left", () => {
    expect(vendorLeftOf(order())).toBe(36_000);
    expect(maxPartRefundOf(order())).toBe(36_000);
    const part = { refundId: "p", kind: "part" as const, amount: 6000, vendor: 6000, ruxstar: 0, reason: null, by: "staff" as const, status: "done" as const, at: new Date() };
    expect(vendorLeftOf(order([part]))).toBe(30_000);
  });
});

describe("gigs", () => {
  let stack: Stack;
  let admin: User;
  let photo: Buffer;

  beforeAll(async () => {
    stack = await startStack();
    admin = { ...(await signIn(stack, { admin: true })), username: "admin" };
    photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#5d8aa8" } }).jpeg().toBuffer();
  });
  afterAll(() => stack?.stop());
  beforeEach(async () => {
    await Promise.all([
      stack.db.businesses.deleteMany({}),
      stack.db.gigs.deleteMany({}),
      stack.db.gigOrders.deleteMany({}),
      stack.db.gigFiles.deleteMany({}),
      stack.db.gigQuotes.deleteMany({}),
      stack.db.coupons.deleteMany({}),
      stack.db.couponRedemptions.deleteMany({}),
      stack.db.ledgerEntries.deleteMany({}),
      stack.db.invoices.deleteMany({}),
      stack.db.reviews.deleteMany({}),
      stack.db.notifications.deleteMany({}),
      stack.db.auditLogs.deleteMany({}),
      stack.db.supportTickets.deleteMany({}),
      stack.db.supportMessages.deleteMany({}),
      stack.db.conversations.deleteMany({}),
      stack.db.chatMembers.deleteMany({}),
      stack.db.chatMessages.deleteMany({}),
    ]);
    stack.printFiles.objects.clear();
    await stack.db.moduleSettings.updateOne(
      { module: "gigs" },
      { $set: { live: true, signupsOpen: true, commissionBps: 1000, platformFee: 500 }, $unset: { gigsRules: "" } },
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
  const upload = (u: User, use: "brief" | "delivery", bytes: number, name = "brief.pdf") =>
    stack.app.inject({
      method: "POST",
      url: `/v1/gigs/files?${new URLSearchParams({ name, use }).toString()}`,
      headers: web(u.token, { "content-type": "application/octet-stream", "idempotency-key": randomUUID() }),
      payload: Buffer.alloc(bytes, 7),
    });
  const rules = (gigsRules: object) => call("PATCH", "/ruxstar/modules/gigs", admin.token, { gigsRules });

  let n = 0;
  async function person(opts: { verified?: boolean; vendor?: boolean; name?: string } = {}): Promise<User> {
    const verified = opts.verified ?? true;
    const user = await signIn(stack, (opts.vendor ?? verified) ? { vendor: true } : {});
    const username = `gig${Date.now() % 1e6}${n++}`;
    await stack.db.users.updateOne({ _id: user.userId }, { $set: { name: opts.name ?? "Kiran Das", username, ...(verified ? { "kyc.base": "approved" } : {}) } });
    return { ...user, username };
  }

  const profileBody = { name: "Asha Designs", headline: "Logo designer for small brands", bio: "Ten years of logos.", category: "design", skills: ["Logos", "Branding"], languages: ["English", "Telugu"], city: "Hyderabad" };
  async function freelancer(opts: { verified?: boolean; vendor?: boolean } = {}) {
    const u = await person({ ...opts, name: "Asha Rao" });
    const res = await call("POST", "/gigs/me", u.token, profileBody);
    expect(res.statusCode, res.body).toBe(201);
    return { u, businessId: res.json().data.businessId as string };
  }
  const pkg = (tier: string, price: number, extra: object = {}) => ({ tier, description: `The ${tier} package, with source files.`, price, deliveryDays: 3, revisions: 1, ...extra });
  const gigBody = (extra: object = {}) => ({
    title: "I will design a logo for your brand",
    category: "design",
    description: "A clean, modern logo for your business, with a few concepts to pick from.",
    packages: [pkg("basic", 50_000), pkg("standard", 1_00_000, { revisions: 3 })],
    questions: [
      { text: "What is your brand called?", required: true },
      { text: "Any colours you like?", required: false },
    ],
    ...extra,
  });
  async function draft(u: User, extra: object = {}) {
    const res = await call("POST", "/gigs/me/gigs", u.token, gigBody(extra));
    expect(res.statusCode, res.body).toBe(201);
    return res.json().data as { id: string; questions: { id: string; text: string }[]; status: string; missing: string[] };
  }
  const addPhoto = (u: User, gigId: string) =>
    stack.app.inject({ method: "POST", url: `/v1/gigs/me/gigs/${gigId}/photos`, headers: web(u.token, { "content-type": "image/jpeg" }), payload: photo });
  async function liveGig(u: User, extra: object = {}) {
    const g = await draft(u, extra);
    expect((await addPhoto(u, g.id)).statusCode).toBe(200);
    const res = await call("POST", `/gigs/me/gigs/${g.id}/publish`, u.token);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as { id: string; questions: { id: string }[]; status: string };
  }

  /** Presses the checkout page's test button, as a browser would. */
  async function pay(checkoutUrl: string) {
    const url = new URL(checkoutUrl);
    return (await stack.app.inject({ method: "POST", url: `${url.pathname}/test${url.search}` })).json() as { status: string };
  }
  type Order = {
    id: string;
    orderNo: number;
    status: string;
    price: { items: number; total: number };
    files: { url: string | null }[];
    paidAt: string | null;
    timeline: { status: string; at: string }[];
  };
  async function place(customer: User, gig: { id: string; questions: { id: string }[] }, body: object = {}) {
    return call("POST", `/gigs/${gig.id}/order`, customer.token, { tier: "basic", answers: [{ questionId: gig.questions[0]!.id, answer: "Chai Point" }], returnTo: BACK, ...body });
  }
  async function paid(customer: User, gig: { id: string; questions: { id: string }[] }, body: object = {}): Promise<Order> {
    const res = await place(customer, gig, body);
    expect(res.statusCode, res.body).toBe(201);
    expect(await pay(res.json().data.checkoutUrl)).toEqual({ status: "paid" });
    return (await call("GET", `/gigs/orders/${res.json().data.order.id}`, customer.token)).json().data;
  }
  const desk = (u: User, orderId: string, action: string, body?: object) => call("POST", `/gigs/desk/orders/${orderId}/${action}`, u.token, body);
  const mine = (u: User, orderId: string, action: string, body: object = {}) => call("POST", `/gigs/orders/${orderId}/${action}`, u.token, body);
  async function delivered(f: User, orderId: string, fileIds: string[] = []) {
    const res = await desk(f, orderId, "deliver", { message: "Here are your logo files.", links: ["https://drive.example.com/logo"], fileIds });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data;
  }
  async function underway(customer: User, f: User, gig: { id: string; questions: { id: string }[] }) {
    const o = await paid(customer, gig);
    expect((await desk(f, o.id, "accept")).statusCode).toBe(200);
    return o;
  }
  const orderDoc = async (id: string) => (await stack.db.gigOrders.findOne({ _id: new ObjectId(id) }))!;
  const balanceOf = async (u: User) =>
    (await stack.db.ledgerEntries.find({ accountId: `vendor:${u.userId.toHexString()}` }).toArray()).reduce(
      (sum, e) => ({ ...sum, [e.bucket]: (sum[e.bucket] ?? 0) + e.signedPaise }),
      {} as Record<string, number>,
    );

  it("lets anyone start freelancing once, and needs base verification to publish a gig", async () => {
    await stack.db.moduleSettings.updateOne({ module: "gigs" }, { $set: { live: false } });
    forgetModuleState();
    const early = await person({ verified: false });
    expect((await call("POST", "/gigs/me", early.token, profileBody)).statusCode).toBe(503);
    await stack.db.moduleSettings.updateOne({ module: "gigs" }, { $set: { live: true, signupsOpen: false } });
    forgetModuleState();
    expect((await call("POST", "/gigs/me", early.token, profileBody)).json().error.code).toBe("SIGNUPS_CLOSED");
    const catalog = (await anon("/vendor/catalog")).json().data;
    expect(catalog.categories.find((c: { module: string }) => c.module === "gigs")).toMatchObject({ label: "Freelancers", live: true, signupsOpen: false });
    await stack.db.moduleSettings.updateOne({ module: "gigs" }, { $set: { signupsOpen: true } });
    forgetModuleState();

    const { u, businessId } = await freelancer({ verified: false });
    expect((await call("POST", "/gigs/me", u.token, profileBody)).statusCode).toBe(409);
    const me = (await call("GET", "/gigs/me", u.token)).json().data;
    expect(me).toMatchObject({ businessId, name: "Asha Designs", status: "draft", verified: false, city: "hyderabad", categoryLabel: "Graphic and logo design", gigs: { total: 0, max: 10 } });
    expect((await call("POST", "/vendor/businesses", u.token, { module: "gigs", type: "freelancer", name: "Another" })).statusCode).not.toBe(201);

    const g = await draft(u);
    expect(g).toMatchObject({ status: "draft", missing: ["Get verified", "Add a photo"], packages: [{ name: "Basic" }, { name: "Standard" }] });
    expect((await call("POST", `/gigs/me/gigs/${g.id}/publish`, u.token)).json().error.code).toBe("KYC_REQUIRED");
    await stack.db.users.updateOne({ _id: u.userId }, { $set: { "kyc.base": "approved" } });
    const noPhoto = await call("POST", `/gigs/me/gigs/${g.id}/publish`, u.token);
    expect(noPhoto.statusCode).toBe(409);
    expect(noPhoto.json().error.message).toBe("Add a photo first.");
    expect((await addPhoto(u, g.id)).statusCode).toBe(200);
    const live = await call("POST", `/gigs/me/gigs/${g.id}/publish`, u.token);
    expect(live.json().data).toMatchObject({ status: "live", missing: [] });
    expect((await call("GET", "/gigs/me", u.token)).json().data).toMatchObject({ status: "live", verified: true, gigs: { total: 1, live: 1 } });

    const list = (await anon("/gigs?category=design&city=Hyderabad")).json().data;
    expect(list.map((c: { id: string }) => c.id)).toEqual([g.id]);
    expect(list[0]).toMatchObject({ priceFrom: 50_000, fastestDays: 3, freelancer: { businessId, name: "Asha Designs", city: "hyderabad" } });
    expect((await anon("/gigs?category=photography")).json().data).toEqual([]);
    const page = (await anon(`/gigs/freelancers/${businessId}`)).json().data;
    expect(page).toMatchObject({ headline: profileBody.headline, gigs: [{ id: g.id }] });
    expect((await anon(`/gigs/${g.id}`)).json().data).toMatchObject({
      canOrder: true,
      questions: [{ required: true }, { required: false }],
      freelancer: { businessId, userId: u.userId.toHexString(), username: u.username },
    });
    const { limits } = (await anon("/gigs/rules")).json().data;
    expect(limits).toMatchObject({ portfolio: 12, gigPhotos: 5, questions: 5, files: 10, links: 10, answer: 1000 });
    expect(limits.extensions).toContain("pdf");
    expect(limits.extensions).not.toContain("html");
    expect(limits.extensions).not.toContain("svg");

    await call("POST", `/gigs/me/gigs/${g.id}/pause`, u.token);
    expect((await anon("/gigs")).json().data).toEqual([]);
    expect((await anon(`/gigs/${g.id}`)).json().data).toMatchObject({ canOrder: false, whyNot: "The freelancer isn't taking orders for this gig right now." });
  });

  it("keeps gigs within Ruxstar's packages, prices, days, revisions and gig count", async () => {
    const { u } = await freelancer();
    const bad = async (extra: object) => (await call("POST", "/gigs/me/gigs", u.token, gigBody(extra))).json().error;
    expect((await bad({ packages: [pkg("standard", 50_000)] })).message).toBe("Packages go Basic, then Standard, then Premium.");
    expect((await bad({ packages: [pkg("basic", 5000)] })).message).toBe("The price must be from ₹100 to ₹2,00,000.");
    expect((await bad({ packages: [pkg("basic", 50_000, { deliveryDays: 90 })] })).message).toBe("Delivery must be in 1 to 60 days.");
    expect((await bad({ packages: [pkg("basic", 50_000, { revisions: 11 })] })).message).toBe("Up to 10 revisions.");
    expect((await bad({ category: "gardening" })).message).toBe("Pick one of the categories.");

    expect((await rules({ maxGigs: 1, maxPackages: 2, categories: DEFAULT_GIGS_RULES.categories.map((c) => (c.key === "photography" ? { ...c, hidden: true } : c)) })).statusCode).toBe(200);
    expect((await bad({ packages: [pkg("basic", 50_000), pkg("standard", 60_000), pkg("premium", 70_000)] })).message).toBe("Up to 2 packages.");
    expect((await bad({ category: "photography" })).message).toBe("Pick one of the categories.");
    expect((await anon("/gigs/rules")).json().data.categories.map((c: { key: string }) => c.key)).not.toContain("photography");
    await draft(u);
    const over = await call("POST", "/gigs/me/gigs", u.token, gigBody());
    expect(over.statusCode).toBe(409);
    expect(over.json().error.message).toBe("You can have up to 1 gigs.");
  });

  it("takes a coupon at checkout, and pays the freelancer when the customer approves the delivery", async () => {
    const { u: f, businessId } = await freelancer();
    const gig = await liveGig(f);
    const customer = await person();
    const made = await call("POST", "/vendor/coupons", f.token, { code: "LOGO100", kind: "flat", value: 10_000, businessIds: [businessId] });
    expect(made.statusCode, made.body).toBe(201);
    const offers = (await call("GET", `/gigs/${gig.id}/offers?tier=basic&code=logo100`, customer.token)).json().data;
    expect(offers.checked).toEqual({ code: "LOGO100", discount: 10_000, problem: null });

    expect((await place(customer, gig, { answers: [] })).json().error.message).toBe('Answer "What is your brand called?".');
    expect((await place(f, gig)).json().error.message).toBe("You can't order from yourself.");
    const brief = await upload(customer, "brief", 2000);
    expect(brief.statusCode, brief.body).toBe(201);
    const o = await paid(customer, gig, { coupon: "LOGO100", fileIds: [brief.json().data.id], note: "Something warm" });
    expect(o).toMatchObject({
      status: "paid",
      price: { items: 50_000, discount: 10_000, platformFee: 500, total: 40_500 },
      coupon: { code: "LOGO100" },
      can: { cancel: true, approve: false, decline: false },
      freelancer: { businessId, userId: f.userId.toHexString(), username: f.username, name: "Asha Designs" },
      timeline: [
        { status: "awaiting_payment", by: "customer" },
        { status: "paid", by: "system" },
      ],
    });
    expect(o.paidAt).toBe(o.timeline[1]!.at);
    expect(o.files).toHaveLength(1);
    expect(await stack.db.couponRedemptions.countDocuments({})).toBe(1);
    expect(await balanceOf(f)).toEqual({ pending: 36_000 });
    expect(await stack.db.notifications.countDocuments({ userId: f.userId, type: "gigs.ordered" })).toBe(1);
    expect((await stack.db.invoices.find({ "source.id": new ObjectId(o.id) }).toArray()).length).toBeGreaterThan(0);

    const desked = (await call("GET", `/gigs/desk/orders/${o.id}`, f.token)).json().data;
    expect(desked).toMatchObject({ role: "freelancer", share: 36_000, can: { accept: true, decline: true, deliver: false } });
    expect((await desk(f, o.id, "deliver", { message: "Early", links: [], fileIds: [] })).json().error.message).toBe("Accept the order first.");
    const accepted = (await desk(f, o.id, "accept")).json().data;
    expect(accepted).toMatchObject({ status: "in_progress", can: { decline: false, deliver: true } });
    expect(accepted.timeline.map((t: { status: string; by: string }) => [t.status, t.by])).toEqual([
      ["awaiting_payment", "customer"],
      ["paid", "system"],
      ["in_progress", "vendor"],
    ]);
    expect(new Date(accepted.dueAt).getTime() - new Date(accepted.acceptedAt).getTime()).toBe(3 * DAY);

    const file = (await upload(f, "delivery", 3000, "logo.zip")).json().data;
    const d = await delivered(f, o.id, [file.id]);
    expect(d).toMatchObject({ status: "delivered", deliveries: [{ links: ["https://drive.example.com/logo"], files: [{ name: "logo.zip" }] }] });
    expect(new Date(d.autoCompleteAt).getTime() - new Date(d.deliveries[0].at).getTime()).toBe(3 * DAY);

    const approved = await mine(customer, o.id, "approve", { note: "Love it" });
    expect(approved.json().data).toMatchObject({ status: "completed", canReview: true, deliveries: [{ answer: { kind: "approved", note: "Love it" } }] });
    expect(await balanceOf(f)).toEqual({ pending: 0, withdrawable: 36_000 });
    expect((await call("PUT", `/gigs/orders/${o.id}/review`, customer.token, { rating: 5, text: "Great work" })).statusCode).toBe(200);
    expect((await stack.db.gigs.findOne({ _id: new ObjectId(gig.id) }))!.rating).toEqual({ count: 1, sum: 5 });
    expect((await anon(`/gigs/${gig.id}/reviews`)).json().data).toHaveLength(1);
    const statement = (await call("GET", "/vendor/payments/statement", f.token)).json().data;
    expect(statement.map((l: { kind: string; module: string }) => [l.kind, l.module])).toEqual([
      ["available", "gigs"],
      ["paid", "gigs"],
    ]);
  });

  it("refunds in full when the freelancer turns an order down or doesn't accept in time", async () => {
    const { u: f } = await freelancer();
    const gig = await liveGig(f);
    const customer = await person();

    const declined = await paid(customer, gig);
    const res = await desk(f, declined.id, "decline", { reason: "Fully booked this week" });
    expect(res.json().data).toMatchObject({ status: "cancelled", refunds: [{ kind: "full", amount: 50_500, status: "done" }], cancellation: { by: "vendor" } });
    expect(await balanceOf(f)).toEqual({ pending: 0 });

    const late = await paid(customer, gig);
    await stack.db.gigOrders.updateOne({ _id: new ObjectId(late.id) }, { $set: { acceptBy: new Date(Date.now() - 1000) } });
    expect((await desk(f, late.id, "accept")).json().error.message).toBe("The time to accept ran out, so the customer was refunded.");
    expect(await orderDoc(late.id)).toMatchObject({ status: "cancelled", cancellation: { by: "system" } });

    const swept = await paid(customer, gig);
    await stack.db.gigOrders.updateOne({ _id: new ObjectId(swept.id) }, { $set: { acceptBy: new Date(Date.now() - 1000) } });
    const job = (await sweep()).json();
    expect(job.gigAcceptTimeouts).toBe(1);
    expect(await orderDoc(swept.id)).toMatchObject({ status: "cancelled", refunds: [{ amount: 50_500, status: "done" }], cancellation: { reason: "Asha Designs didn't accept in time." } });
    expect(await balanceOf(f)).toEqual({ pending: 0 });
  });

  it("holds deliveries to the size limit, counts revisions, and completes by itself", async () => {
    const { u: f } = await freelancer();
    const gig = await liveGig(f);
    const customer = await person();
    expect((await rules({ deliveryMaxMb: 26 })).statusCode).toBe(400);
    expect((await rules({ deliveryMaxMb: 1 })).statusCode).toBe(200);
    const big = await upload(f, "delivery", 1.5 * MB, "video.mp4");
    expect(big.statusCode).toBe(422);
    expect(big.json().error.message).toBe("Files can be up to 1 MB.");
    expect((await upload(f, "delivery", 10, "page.html")).statusCode).toBe(422);
    expect((await upload(customer, "delivery", 10, "logo.png")).statusCode).toBe(403);

    const o = await underway(customer, f, gig);
    const a = (await upload(f, "delivery", 0.6 * MB, "a.png")).json().data;
    const b = (await upload(f, "delivery", 0.6 * MB, "b.png")).json().data;
    const tooMuch = await desk(f, o.id, "deliver", { message: "Two files", links: [], fileIds: [a.id, b.id] });
    expect(tooMuch.statusCode).toBe(422);
    expect(tooMuch.json().error.message).toBe("Files can add up to 1 MB.");

    await delivered(f, o.id, [a.id]);
    const revised = await mine(customer, o.id, "revision", { note: "Make it bluer please" });
    expect(revised.json().data).toMatchObject({ status: "in_progress", revisions: { included: 1, used: 1, left: 0 }, autoCompleteAt: null });
    await delivered(f, o.id);
    expect((await mine(customer, o.id, "revision", { note: "One more change" })).json().error.message).toBe(
      "All the revisions in this package are used. Approve it or report a problem.",
    );

    await stack.db.gigOrders.updateOne({ _id: new ObjectId(o.id) }, { $set: { autoCompleteAt: new Date(Date.now() - 1000) } });
    expect((await sweep()).json().gigAutoCompleted).toBe(1);
    expect(await orderDoc(o.id)).toMatchObject({ status: "completed" });
    expect(await balanceOf(f)).toEqual({ pending: 0, withdrawable: 45_000 });
  });

  it("lets the customer cancel before acceptance or once late, and the freelancer any time before it completes", async () => {
    const { u: f } = await freelancer();
    const gig = await liveGig(f);
    const customer = await person();

    const early = await paid(customer, gig);
    expect((await mine(customer, early.id, "cancel")).json().data).toMatchObject({ status: "cancelled", refunds: [{ amount: 50_500 }], cancellation: { by: "customer" } });

    const started = await underway(customer, f, gig);
    const refused = await mine(customer, started.id, "cancel");
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toBe("The freelancer has started. You can cancel once it's past its due date, or contact support.");
    await stack.db.gigOrders.updateOne({ _id: new ObjectId(started.id) }, { $set: { dueAt: new Date(Date.now() - 1000) } });
    expect((await call("GET", `/gigs/orders/${started.id}`, customer.token)).json().data).toMatchObject({ late: true, can: { cancel: true } });
    expect((await mine(customer, started.id, "cancel")).json().data).toMatchObject({ status: "cancelled", cancellation: { reason: "You cancelled it because it was late." } });

    const done = await underway(customer, f, gig);
    await delivered(f, done.id);
    expect((await mine(customer, done.id, "cancel")).json().error.message).toBe("It's delivered: approve it, ask for a revision or report a problem.");
    const dropped = await desk(f, done.id, "cancel", { reason: "Can't finish the revisions" });
    expect(dropped.json().data).toMatchObject({ status: "cancelled", refunds: [{ amount: 50_500, status: "done" }], cancellation: { by: "vendor" } });
    expect(await balanceOf(f)).toEqual({ pending: 0 });
    expect(await stack.db.notifications.countDocuments({ userId: customer.userId, type: "gigs.updated", title: { $regex: "order cancelled" } })).toBe(1);
  });

  it("holds the money on a reported problem until Ruxstar decides a full, part or no refund", async () => {
    const { u: f } = await freelancer();
    const gig = await liveGig(f);
    const customer = await person();
    const reported = async () => {
      const o = await underway(customer, f, gig);
      await delivered(f, o.id);
      const res = await mine(customer, o.id, "problem", { reason: "The files don't open at all." });
      expect(res.json().data).toMatchObject({ status: "disputed", autoCompleteAt: null, dispute: { reason: "The files don't open at all.", decision: null } });
      return o;
    };
    const decide = (id: string, body: object) => call("POST", `/ruxstar/gigs/orders/${id}/decide`, admin.token, body);

    const full = await reported();
    const ticket = await stack.db.supportTickets.findOne({ "context.type": "gig_order" });
    expect(ticket).toMatchObject({ priority: "high", category: "orders", context: { label: `Freelance order #${full.orderNo}` } });
    expect((await mine(customer, full.id, "approve")).statusCode).toBe(409);
    expect((await desk(f, full.id, "cancel", { reason: "I want to stop now" })).statusCode).toBe(409);
    expect((await stack.app.inject({ method: "GET", url: "/v1/ruxstar/stats", headers: web(admin.token) })).json().data.queues.gigDisputes).toBe(1);
    expect((await decide(full.id, { outcome: "full", note: "The files were broken." })).json().data).toMatchObject({
      status: "cancelled",
      refunds: [{ kind: "full", amount: 50_500 }],
      dispute: { decision: { outcome: "full", amount: 50_500 } },
    });
    expect(await stack.db.supportMessages.countDocuments({ ticketId: ticket!._id, internal: true })).toBe(1);
    expect(await balanceOf(f)).toEqual({ pending: 0 });

    const part = await reported();
    expect((await decide(part.id, { outcome: "part", amount: 46_000, note: "Too much." })).statusCode).toBe(400);
    expect((await decide(part.id, { outcome: "part", amount: 15_000, note: "One concept was missing." })).json().data).toMatchObject({
      status: "completed",
      share: 30_000,
      refunds: [{ kind: "part", amount: 15_000, status: "done" }],
    });
    expect(await balanceOf(f)).toEqual({ pending: 0, withdrawable: 30_000 });
    expect((await decide(part.id, { outcome: "none", note: "Again" })).statusCode).toBe(409);

    const none = await reported();
    expect((await decide(none.id, { outcome: "none", note: "The files open fine." })).json().data).toMatchObject({ status: "completed", refunds: [] });
    expect(await balanceOf(f)).toEqual({ pending: 0, withdrawable: 75_000 });
    expect(await stack.db.auditLogs.countDocuments({ action: "gig_order.decide" })).toBe(3);
  });

  it("sends custom offers in a 1:1 chat that expire, can be withdrawn, and pay as accepted orders", async () => {
    const { u: f, businessId } = await freelancer();
    const customer = await person();
    const opened = await call("POST", "/social/chats/dm", customer.token, { userId: f.userId.toHexString() });
    expect(opened.statusCode, opened.body).toBe(201);
    const chat = opened.json().data.id as string;
    expect((await call("POST", `/social/chats/${chat}/messages`, customer.token, { text: "Can you do a menu card?" })).statusCode).toBe(201);
    await call("POST", `/social/chats/${chat}/accept`, f.token);
    const offer = (extra: object = {}) =>
      call("POST", `/social/chats/${chat}/quotes`, f.token, { title: "Menu card design", description: "A two-sided menu card, print ready.", category: "design", price: 80_000, deliveryDays: 5, revisions: 2, ...extra });

    expect((await call("POST", `/social/chats/${chat}/quotes`, customer.token, { title: "Menu", description: "Not a freelancer here.", category: "design", price: 80_000, deliveryDays: 5, revisions: 2 })).statusCode).toBe(403);
    expect((await offer({ price: 50 })).statusCode).toBe(400);
    const sent = await offer();
    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json().data).toMatchObject({ kind: "quote", quote: { status: "open", price: 80_000, freelancer: { businessId }, canWithdraw: true, canPay: false } });
    const quoteId = sent.json().data.quote.id as string;
    const seen = (await call("GET", `/social/chats/${chat}/messages`, customer.token)).json().data;
    expect(seen.find((m: { kind: string }) => m.kind === "quote").quote).toMatchObject({ canPay: true, canWithdraw: false });

    const stranger = await person();
    expect((await call("POST", `/gigs/quotes/${quoteId}/pay`, stranger.token, { returnTo: BACK })).statusCode).toBe(404);
    expect((await call("GET", `/gigs/quotes/${quoteId}`, customer.token)).json().data).toMatchObject({
      id: quoteId,
      status: "open",
      chatId: chat,
      title: "Menu card design",
      description: "A two-sided menu card, print ready.",
      category: "design",
      price: 80_000,
      deliveryDays: 5,
      revisions: 2,
      freelancer: { businessId },
      canPay: true,
      canWithdraw: false,
    });

    expect((await call("POST", "/vendor/coupons", f.token, { code: "MENU50", kind: "flat", value: 5000, businessIds: [businessId] })).statusCode).toBe(201);
    const offers = (await call("GET", `/gigs/quotes/${quoteId}/offers?code=menu50`, customer.token)).json().data;
    expect(offers.offers.map((c: { code: string }) => c.code)).toContain("MENU50");
    expect(offers.checked).toEqual({ code: "MENU50", discount: 5000, problem: null });
    expect((await call("GET", `/gigs/quotes/${quoteId}/offers?code=NOPE99`, customer.token)).json().data.checked).toMatchObject({ code: "NOPE99", discount: 0 });
    expect((await call("GET", `/gigs/quotes/${quoteId}/offers`, f.token)).statusCode).toBe(403);
    expect((await call("GET", `/gigs/quotes/${quoteId}/offers`, stranger.token)).statusCode).toBe(404);

    const placed = await call("POST", `/gigs/quotes/${quoteId}/pay`, customer.token, { returnTo: BACK });
    expect(placed.statusCode, placed.body).toBe(201);
    const again = await call("POST", `/gigs/quotes/${quoteId}/pay`, customer.token, { returnTo: BACK });
    expect(again.json().data.order.id).toBe(placed.json().data.order.id);
    expect(await pay(placed.json().data.checkoutUrl)).toEqual({ status: "in_progress" });
    const o = (await call("GET", `/gigs/orders/${placed.json().data.order.id}`, customer.token)).json().data;
    expect(o).toMatchObject({ status: "in_progress", gigId: null, quoteId, package: { name: "Custom offer", deliveryDays: 5, revisions: 2 }, price: { total: 80_500 } });
    expect(new Date(o.dueAt).getTime() - new Date(o.acceptedAt).getTime()).toBe(5 * DAY);
    expect((await call("GET", `/gigs/quotes/${quoteId}`, customer.token)).json().data).toMatchObject({ status: "paid", orderId: o.id, canPay: false });
    expect((await call("GET", `/gigs/quotes/${quoteId}/offers`, customer.token)).json().error.message).toBe("This offer is paid for already.");
    expect((await call("POST", `/gigs/desk/quotes/${quoteId}/withdraw`, f.token)).statusCode).toBe(409);

    const pulled = (await offer({ title: "Logo refresh" })).json().data.quote.id as string;
    expect((await call("POST", `/gigs/desk/quotes/${pulled}/withdraw`, f.token)).json().data).toMatchObject({ status: "withdrawn", title: "Logo refresh", price: 80_000, canWithdraw: false });
    expect((await call("POST", `/gigs/quotes/${pulled}/pay`, customer.token, { returnTo: BACK })).json().error.message).toBe("The freelancer withdrew this offer.");

    const stale = (await offer({ title: "Poster design" })).json().data.quote.id as string;
    await stack.db.gigQuotes.updateOne({ _id: new ObjectId(stale) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call("POST", `/gigs/quotes/${stale}/pay`, customer.token, { returnTo: BACK })).json().error.message).toBe("This offer has expired.");
    expect((await sweep()).json().gigQuotesExpired).toBe(1);
    expect((await stack.db.gigQuotes.findOne({ _id: new ObjectId(stale) }))!.status).toBe("expired");
    const unsend = await call("DELETE", `/social/chats/${chat}/messages/${sent.json().data.id}`, f.token);
    expect(unsend.json().error.message).toBe("A custom offer can't be unsent. Withdraw the offer instead.");
  });

  it("serves files only through short signed links, and deletes them after the order ends", async () => {
    const { u: f } = await freelancer();
    const gig = await liveGig(f);
    const customer = await person();
    const unused = (await upload(customer, "brief", 100)).json().data;
    await stack.db.gigFiles.updateOne({ _id: new ObjectId(unused.id) }, { $set: { createdAt: new Date(Date.now() - 2 * DAY) } });

    const o = await underway(customer, f, gig);
    const file = (await upload(f, "delivery", 500, "logo.pdf")).json().data;
    await delivered(f, o.id, [file.id]);
    const view = (await call("GET", `/gigs/orders/${o.id}`, customer.token)).json().data;
    const url = new URL(view.deliveries[0].files[0].url);
    const got = await stack.app.inject({ method: "GET", url: `${url.pathname}${url.search}` });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-disposition"]).toBe('inline; filename="logo.pdf"');
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(got.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(got.rawPayload.length).toBe(500);
    const saved = await stack.app.inject({ method: "GET", url: `${url.pathname}${url.search}&download=1` });
    expect(saved.statusCode).toBe(200);
    expect(saved.headers["content-disposition"]).toBe('attachment; filename="logo.pdf"');
    expect(saved.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect((await stack.app.inject({ method: "GET", url: `${url.pathname}${url.search}&download=yes` })).statusCode).toBe(400);
    const zip = (await upload(customer, "brief", 300, "refs.zip")).json().data;
    const zipLink = new URL(gigFileLinks(stack.app, { protocol: "http", host: "localhost" })(new ObjectId(zip.id)));
    expect((await stack.app.inject({ method: "GET", url: `${zipLink.pathname}${zipLink.search}` })).headers["content-disposition"]).toBe('attachment; filename="refs.zip"');
    expect((await stack.app.inject({ method: "GET", url: `${url.pathname}?exp=${url.searchParams.get("exp")}&t=forged` })).statusCode).toBe(401);
    const stranger = await person();
    expect((await call("GET", `/gigs/orders/${o.id}`, stranger.token)).statusCode).toBe(404);

    await mine(customer, o.id, "approve");
    const before = stack.printFiles.objects.size;
    await stack.db.gigOrders.updateOne({ _id: new ObjectId(o.id) }, { $set: { filesUntil: new Date(Date.now() - 1000) } });
    const job = (await sweep()).json();
    expect(job).toMatchObject({ gigFilesUnused: 1, gigFilesCleaned: 1 });
    expect(stack.printFiles.objects.size).toBe(before - 2);
    const after = (await call("GET", `/gigs/orders/${o.id}`, customer.token)).json().data;
    expect(after).toMatchObject({ filesDeleted: true, status: "completed", deliveries: [{ message: "Here are your logo files.", files: [{ name: "logo.pdf", url: null }] }] });
  });

  it("opens a freelancer's own earnings, withdrawals and invoices without the vendor role, and nothing else under /vendor", async () => {
    const { u: f, businessId } = await freelancer({ vendor: false });
    const { u: other } = await freelancer({ vendor: false });
    const customer = await person();
    const o = await underway(customer, f, await liveGig(f));
    await delivered(f, o.id);
    expect((await mine(customer, o.id, "approve")).statusCode).toBe(200);
    const theirs = await paid(customer, await liveGig(other));

    const payments = await call("GET", "/vendor/payments", f.token);
    expect(payments.statusCode, payments.body).toBe(200);
    expect(payments.json().data).toMatchObject({ balance: { available: 45_000, pending: 0 }, payoutMethod: null });
    const statement = (await call("GET", "/vendor/payments/statement", f.token)).json().data;
    expect(statement.map((l: { kind: string; order: { id: string } }) => [l.kind, l.order.id])).toEqual([
      ["available", o.id],
      ["paid", o.id],
    ]);
    expect((await call("GET", "/vendor/payout-method", f.token)).statusCode).toBe(200);
    expect((await call("POST", "/vendor/payouts", f.token)).json().error.code).toBe("PAYOUT_METHOD_REQUIRED");

    const invoices = (await call("GET", "/vendor/invoices", f.token)).json().data as { id: string }[];
    expect(invoices.length).toBeGreaterThan(0);
    expect((await call("GET", `/vendor/invoices/${invoices[0]!.id}`, f.token)).statusCode).toBe(200);
    expect((await call("GET", `/vendor/invoices/${invoices[0]!.id}/pdf`, f.token)).statusCode).toBe(200);
    expect((await call("GET", `/vendor/invoices?business=${businessId}`, f.token)).json().data).toHaveLength(invoices.length);
    const otherInvoice = await stack.db.invoices.findOne({ "source.id": new ObjectId(theirs.id), role: "supply" });
    expect(otherInvoice).not.toBeNull();
    expect(invoices.map((i) => i.id)).not.toContain(otherInvoice!._id.toHexString());
    expect((await call("GET", `/vendor/invoices/${otherInvoice!._id.toHexString()}`, f.token)).statusCode).toBe(404);
    expect((await call("GET", `/vendor/invoices/${otherInvoice!._id.toHexString()}/pdf`, f.token)).statusCode).toBe(404);
    expect((await call("GET", "/vendor/payments", other.token)).json().data.balance).toMatchObject({ available: 0, pending: 45_000 });

    for (const [method, url, body] of [
      ["GET", "/vendor/businesses", undefined],
      ["GET", `/vendor/businesses/${businessId}`, undefined],
      ["POST", "/vendor/businesses", { module: "pod", type: "print_shop", name: "Asha Prints", phone: "9876543210", location: { state: "Telangana", city: "Hyderabad" } }],
      ["PATCH", `/vendor/businesses/${businessId}`, { name: "Renamed" }],
      ["GET", "/vendor/orders", undefined],
      ["GET", "/vendor/coupons", undefined],
      ["POST", "/vendor/coupons", { code: "ASHA10", kind: "flat", value: 1000, businessIds: [businessId] }],
      ["GET", `/vendor/businesses/${businessId}/activity`, undefined],
    ] as const) {
      const res = await call(method, url, f.token, body);
      expect(res.json().error?.code, `${method} ${url}`).toBe("KYC_REQUIRED");
    }
    const nobody = await person({ vendor: false });
    expect((await call("GET", "/vendor/payments", nobody.token)).json().error.code).toBe("KYC_REQUIRED");
    expect((await call("GET", "/vendor/invoices", nobody.token)).json().error.code).toBe("KYC_REQUIRED");
  });

  it("shows freelancers, gigs and orders in the console, with settings and take-downs", async () => {
    const { u: f, businessId } = await freelancer();
    const gig = await liveGig(f);
    const customer = await person();
    const o = await paid(customer, gig);

    const modules = (await call("GET", "/ruxstar/modules", admin.token)).json().data;
    expect(modules.find((m: { module: string }) => m.module === "gigs").gigsRules).toMatchObject({ autoCompleteDays: 3, acceptHours: 24, quoteDays: 7, deliveryMaxMb: 25, fileDays: 90 });
    expect((await rules({ minPrice: 3_00_000_00 })).statusCode).toBe(400);
    expect((await rules({ categories: DEFAULT_GIGS_RULES.categories.filter((c) => c.key !== "design") })).statusCode).toBe(400);
    expect((await rules({ acceptHours: 12 })).statusCode).toBe(200);
    expect((await anon("/gigs/rules")).json().data.acceptHours).toBe(12);

    const freelancers = (await call("GET", "/ruxstar/gigs/freelancers?q=asha", admin.token)).json().data;
    expect(freelancers).toMatchObject([{ businessId, verified: true, gigs: 1, orders: 1 }]);
    expect((await call("GET", `/ruxstar/gigs/orders?q=${o.orderNo}`, admin.token)).json().data.map((x: { id: string }) => x.id)).toEqual([o.id]);
    expect((await call("GET", "/ruxstar/gigs/orders?q=logo", admin.token)).json().data).toHaveLength(1);
    expect((await call("GET", "/ruxstar/gigs/orders", customer.token)).statusCode).toBe(403);

    expect((await call("POST", `/ruxstar/gigs/freelancers/${businessId}/suspend`, customer.token, { reason: "Not staff" })).statusCode).toBe(403);
    const held = await call("POST", `/ruxstar/gigs/freelancers/${businessId}/suspend`, admin.token, { reason: "Reports of copied work" });
    expect(held.json().data).toMatchObject({ businessId, suspended: true });
    expect((await call("POST", `/ruxstar/gigs/freelancers/${businessId}/suspend`, admin.token, { reason: "Again please" })).statusCode).toBe(409);
    expect((await anon(`/gigs/freelancers/${businessId}`)).statusCode).toBe(404);
    expect((await anon("/gigs")).json().data).toEqual([]);
    expect((await desk(f, o.id, "accept")).json().error.code).toBe("BUSINESS_SUSPENDED");
    expect((await call("GET", `/ruxstar/businesses/${businessId}`, admin.token)).json().data.business.suspension).toMatchObject({ reason: "Reports of copied work" });
    expect((await call("POST", `/ruxstar/gigs/freelancers/${businessId}/restore`, admin.token)).json().data).toMatchObject({ suspended: false });
    expect((await anon(`/gigs/freelancers/${businessId}`)).statusCode).toBe(200);
    expect(await stack.db.auditLogs.countDocuments({ action: { $in: ["business.suspend", "business.restore"] }, "target.id": new ObjectId(businessId) })).toBe(2);
    expect(await stack.db.notifications.countDocuments({ userId: f.userId, type: { $in: ["business.suspended", "business.restored"] } })).toBe(2);

    const down = await call("POST", `/ruxstar/gigs/listings/${gig.id}/take-down`, admin.token, { reason: "Copies another designer's work" });
    expect(down.json().data).toMatchObject({ status: "removed", removal: { reason: "Copies another designer's work" } });
    expect((await anon("/gigs")).json().data).toEqual([]);
    expect((await anon(`/gigs/${gig.id}`)).statusCode).toBe(404);
    expect((await call("PATCH", `/gigs/me/gigs/${gig.id}`, f.token, { title: "I will design a better logo" })).statusCode).toBe(409);
    expect(await stack.db.auditLogs.countDocuments({ action: "gig.take_down" })).toBe(1);
    expect(await stack.db.notifications.countDocuments({ userId: f.userId, title: { $regex: "took down" } })).toBe(1);
    expect((await desk(f, o.id, "accept")).json().data.status).toBe("in_progress");
  });
});
