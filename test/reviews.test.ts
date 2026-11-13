import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { forgetModuleState } from "../src/platform/module-switch.js";
import { signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>>;
const BACK = "https://ruxstar.com/orders";
const ADDRESS = { name: "Ravi Kumar", phone: "9876501234", line: "Flat 302, Green Towers, Madhapur", city: "Hyderabad", pincode: "500081" };
const DAY = 24 * 60 * 60_000;

describe("shop reviews", () => {
  let stack: Stack;
  let photo: Buffer;
  let pdf: Buffer;
  let admin: User;

  beforeAll(async () => {
    stack = await startStack();
    photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#8a6a40" } }).jpeg().toBuffer();
    const doc = await PDFDocument.create();
    doc.addPage();
    pdf = Buffer.from(await doc.save());
    admin = await signIn(stack, { admin: true });
  });
  afterAll(() => stack?.stop());
  beforeEach(async () => {
    await Promise.all([
      stack.db.businesses.deleteMany({}),
      stack.db.podOrders.deleteMany({}),
      stack.db.podReviews.deleteMany({}),
      stack.db.reviewReports.deleteMany({}),
      stack.db.printFiles.deleteMany({}),
      stack.db.ledgerEntries.deleteMany({}),
      stack.db.employments.deleteMany({}),
      stack.db.notifications.deleteMany({}),
      stack.db.auditLogs.deleteMany({}),
    ]);
    await stack.db.moduleSettings.updateOne({ module: "pod" }, { $set: { live: true, signupsOpen: true, commissionBps: 1000, platformFee: 500 } });
    forgetModuleState();
  });

  const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, token: string, payload?: object) =>
    stack.app.inject({
      method,
      url: `/v1${url}`,
      headers: web(token, method === "GET" || method === "DELETE" ? {} : { "idempotency-key": randomUUID() }),
      ...(payload ? { payload } : {}),
    });

  let n = 0;
  async function person(opts: { vendor?: boolean; verified?: boolean; name?: string } = {}) {
    const user = await signIn(stack, opts.vendor ? { vendor: true } : {});
    const username = `rev${Date.now() % 1e6}${n++}`;
    await stack.db.users.updateOne(
      { _id: user.userId },
      { $set: { name: opts.name ?? "Asha Rao", username, ...(opts.verified ? { "kyc.base": "approved" } : {}) } },
    );
    return { ...user, username };
  }

  async function teeShop(owner: User) {
    const created = await call("POST", "/vendor/businesses", owner.token, {
      module: "pod",
      type: "print_shop",
      name: "Rao Prints",
      phone: "9876543210",
      location: { state: "Telangana", city: "Hyderabad", doorNo: "4-1", street: "Main Road", area: "Madhapur", pincode: "500081" },
    });
    const id = created.json().data.id as string;
    await stack.app.inject({ method: "POST", url: `/v1/vendor/businesses/${id}/photos`, headers: web(owner.token, { "content-type": "image/jpeg" }), payload: photo });
    await call("PATCH", `/vendor/businesses/${id}/pod`, owner.token, {
      products: ["tshirts"],
      cities: ["Hyderabad"],
      prices: [{ product: "tshirts", basePrice: 30_000, tiers: [{ from: 10, unitPrice: 25_000 }] }],
    });
    expect((await call("POST", `/vendor/businesses/${id}/publish`, owner.token)).statusCode).toBe(200);
    return id;
  }

  async function paid(customer: User, shopId: string) {
    const file = (
      await stack.app.inject({
        method: "POST",
        url: "/v1/pod/files",
        headers: web(customer.token, { "content-type": "application/pdf", "x-file-name": "design.pdf" }),
        payload: pdf,
      })
    ).json().data;
    const res = await call("POST", "/pod/orders", customer.token, {
      shopId,
      product: "tshirts",
      options: { size: "M" },
      quantity: 12,
      fileIds: [file.id],
      address: ADDRESS,
      returnTo: BACK,
    });
    expect(res.statusCode).toBe(201);
    const url = new URL(res.json().data.checkoutUrl);
    expect((await stack.app.inject({ method: "POST", url: `${url.pathname}/test${url.search}` })).json()).toEqual({ status: "placed" });
    return res.json().data.order as { id: string; orderNo: number };
  }

  async function delivered(owner: User, customer: User, shopId: string) {
    const order = await paid(customer, shopId);
    expect((await call("POST", `/vendor/orders/${order.id}/status`, owner.token, { status: "accepted" })).statusCode).toBe(200);
    expect((await call("POST", `/vendor/orders/${order.id}/status`, owner.token, { status: "delivered" })).statusCode).toBe(200);
    return order;
  }

  async function hire(owner: User, shopId: string, who: { token: string; username: string }, permissions: string[]) {
    const placeId = (await call("POST", `/vendor/businesses/${shopId}/team`, owner.token, { username: who.username, permissions })).json().data.id as string;
    expect((await call("POST", `/employment/${placeId}/accept`, who.token)).statusCode).toBe(200);
    return placeId;
  }

  const review = (u: User, orderId: string, body: object) => call("PUT", `/pod/orders/${orderId}/review`, u.token, body);
  const tells = async (u: User, type: string) =>
    (await stack.db.notifications.find({ userId: u.userId, type: type as never }).sort({ createdAt: 1 }).toArray()).map((x) => [x.title, x.body, x.link]);
  const activity = async (owner: User, shopId: string) =>
    (await call("GET", `/vendor/businesses/${shopId}/activity`, owner.token)).json().data.map((e: { line: string; who: { kind: string } }) => [e.who.kind, e.line]);

  it("takes one review per delivered order, changeable for 30 days, and tells the shop", async () => {
    const owner = await person({ vendor: true, verified: true });
    const shopId = await teeShop(owner);
    const replier = await person({ verified: true, name: "Replier" });
    const viewer = await person({ verified: true, name: "Viewer" });
    const replierPlace = await hire(owner, shopId, replier, ["reviews.reply"]);
    await hire(owner, shopId, viewer, ["orders.view"]);
    const customer = await person({ name: "Meena" });

    const early = await paid(customer, shopId);
    expect((await call("GET", `/pod/orders/${early.id}`, customer.token)).json().data.reviewUntil).toBeNull();
    expect((await review(customer, early.id, { rating: 5 })).json().error).toMatchObject({ code: "ORDER_STATE", message: "You can review an order once it's delivered." });
    expect((await call("GET", `/pod/orders/${early.id}/review`, customer.token)).json().data).toBeNull();
    expect((await call("POST", `/pod/orders/${early.id}/cancel`, customer.token)).json().data.status).toBe("cancelled");
    expect((await review(customer, early.id, { rating: 5 })).statusCode).toBe(409);

    const order = await delivered(owner, customer, shopId);
    expect((await tells(customer, "order.updated")).at(-1)?.[1]).toBe("Your order was delivered. Rate the shop, or report a problem within 48 hours if something's wrong.");
    const view = (await call("GET", `/pod/orders/${order.id}`, customer.token)).json().data;
    expect(Date.parse(view.reviewUntil) - Date.parse(view.deliveredAt)).toBe(30 * DAY);

    expect((await review(customer, order.id, { rating: 0 })).statusCode).toBe(400);
    expect((await review(customer, order.id, { rating: 4, text: "x".repeat(501) })).statusCode).toBe(400);
    expect((await review(await person(), order.id, { rating: 4 })).statusCode).toBe(404);
    const written = await review(customer, order.id, { rating: 4, text: "  Crisp print, on time.  " });
    expect(written.statusCode).toBe(200);
    expect(written.json().data).toMatchObject({
      orderId: order.id,
      rating: 4,
      text: "Crisp print, on time.",
      product: "T-Shirts",
      author: { name: "Meena", username: customer.username },
      reply: null,
      status: "live",
      removedReason: null,
      editedAt: null,
    });

    const body = `4 stars for order #${order.orderNo}: Crisp print, on time.`;
    expect(await tells(owner, "review.posted")).toEqual([["New review", body, { screen: "reviews", id: shopId }]]);
    expect(await tells(replier, "review.posted")).toEqual([["New review at Rao Prints", body, { screen: "work_reviews", id: replierPlace }]]);
    expect(await tells(viewer, "review.posted")).toEqual([]);

    expect((await review(customer, order.id, { rating: 4, text: "Crisp print, on time." })).json().data.editedAt).toBeNull();
    const changed = (await review(customer, order.id, { rating: 5 })).json().data;
    expect(changed).toMatchObject({ rating: 5, text: "Crisp print, on time." });
    expect(changed.editedAt).not.toBeNull();
    expect((await review(customer, order.id, { rating: 5, text: "  " })).json().data.text).toBeNull();
    expect(await stack.db.podReviews.countDocuments({})).toBe(1);
    expect(await tells(owner, "review.posted")).toHaveLength(1);

    await stack.db.podOrders.updateOne({ _id: new ObjectId(order.id) }, { $set: { deliveredAt: new Date(Date.now() - 31 * DAY) } });
    expect((await call("GET", `/pod/orders/${order.id}`, customer.token)).json().data.reviewUntil).toBeNull();
    expect((await review(customer, order.id, { rating: 1 })).json().error).toMatchObject({ code: "ORDER_STATE", message: "Reviews close 30 days after delivery." });
    expect((await call("GET", `/pod/orders/${order.id}/review`, customer.token)).json().data.rating).toBe(5);

    expect(await activity(owner, shopId)).toEqual(
      expect.arrayContaining([
        ["customer", `Rated order #${order.orderNo} 4 stars`],
        ["customer", `Changed the rating of order #${order.orderNo} to 5 stars`],
        ["customer", `Changed the review of order #${order.orderNo}`],
      ]),
    );
  }, 90_000);

  it("shows a shop's rating once it has three reviews, and lists them newest first", async () => {
    const owner = await person({ vendor: true, verified: true });
    const shopId = await teeShop(owner);
    const rating = async () => (await call("GET", `/pod/shops/${shopId}`, owner.token)).json().data.rating;
    expect(await rating()).toEqual({ average: null, count: 0 });

    const people = [await person({ name: "One" }), await person({ name: "Two" }), await person({ name: "Three" })];
    const orders = [];
    for (const [i, stars] of [5, 4, 4].entries()) {
      const order = await delivered(owner, people[i]!, shopId);
      orders.push(order);
      expect((await review(people[i]!, order.id, { rating: stars })).statusCode).toBe(200);
    }
    expect(await rating()).toEqual({ average: 4.3, count: 3 });
    const card = (await call("GET", "/pod/shops", owner.token)).json().data.find((s: { id: string }) => s.id === shopId);
    expect(card.rating).toEqual({ average: 4.3, count: 3 });
    expect((await call("GET", `/vendor/businesses/${shopId}`, owner.token)).json().data.rating).toEqual({ average: 4.3, count: 3 });

    const list = (await call("GET", `/pod/shops/${shopId}/reviews`, people[0]!.token)).json().data;
    expect(list.map((r: { author: { name: string } }) => r.author.name)).toEqual(["Three", "Two", "One"]);

    const deleted = await call("DELETE", `/pod/orders/${orders[1]!.id}/review`, people[1]!.token);
    expect(deleted.statusCode).toBe(200);
    expect(await rating()).toEqual({ average: null, count: 2 });
    expect((await call("DELETE", `/pod/orders/${orders[1]!.id}/review`, people[1]!.token)).statusCode).toBe(404);
    expect((await review(people[1]!, orders[1]!.id, { rating: 2 })).statusCode).toBe(200);
    expect(await rating()).toEqual({ average: 3.7, count: 3 });
    expect(await activity(owner, shopId)).toEqual(expect.arrayContaining([["customer", `Deleted the review of order #${orders[1]!.orderNo}`]]));
  }, 90_000);

  it("lets a partly refunded order be reviewed", async () => {
    const owner = await person({ vendor: true, verified: true });
    const shopId = await teeShop(owner);
    const customer = await person();
    const order = await delivered(owner, customer, shopId);
    const refund = await call("POST", `/vendor/orders/${order.id}/refund`, owner.token, { amount: 25_000, reason: "One shirt was misprinted" });
    expect(refund.statusCode).toBe(200);
    expect((await review(customer, order.id, { rating: 3 })).statusCode).toBe(200);
  }, 60_000);

  it("lets the owner and the team allowed to reply answer, telling the customer the first time", async () => {
    const owner = await person({ vendor: true, verified: true });
    const shopId = await teeShop(owner);
    const replier = await person({ verified: true, name: "Replier" });
    const viewer = await person({ verified: true, name: "Viewer" });
    const replierPlace = await hire(owner, shopId, replier, ["reviews.reply"]);
    const viewerPlace = await hire(owner, shopId, viewer, ["orders.view"]);
    const customer = await person({ name: "Meena" });
    const order = await delivered(owner, customer, shopId);
    const reviewId = (await review(customer, order.id, { rating: 2, text: "Faded colours." })).json().data.id as string;

    const shopList = (await call("GET", `/vendor/businesses/${shopId}/reviews`, owner.token)).json().data;
    expect(shopList).toEqual([expect.objectContaining({ id: reviewId, orderId: order.id, orderNo: order.orderNo, rating: 2 })]);
    expect((await call("PUT", `/vendor/businesses/${shopId}/reviews/${reviewId}/reply`, owner.token, { text: "x" })).statusCode).toBe(400);
    const replied = await call("PUT", `/vendor/businesses/${shopId}/reviews/${reviewId}/reply`, owner.token, { text: "Sorry! We'll reprint them." });
    expect(replied.statusCode).toBe(200);
    expect(replied.json().data.reply).toMatchObject({ text: "Sorry! We'll reprint them.", editedAt: null });
    expect(await tells(customer, "review.replied")).toEqual([["Rao Prints replied to your review", "Sorry! We'll reprint them.", { screen: "order", id: order.id }]]);

    expect((await call("GET", `/employment/${viewerPlace}/reviews`, viewer.token)).statusCode).toBe(403);
    expect((await call("PUT", `/employment/${viewerPlace}/reviews/${reviewId}/reply`, viewer.token, { text: "Hello there" })).statusCode).toBe(403);
    expect((await call("GET", `/employment/${replierPlace}/reviews`, replier.token)).json().data).toHaveLength(1);
    const edited = await call("PUT", `/employment/${replierPlace}/reviews/${reviewId}/reply`, replier.token, { text: "Reprint is on its way." });
    expect(edited.json().data.reply.text).toBe("Reprint is on its way.");
    expect(edited.json().data.reply.editedAt).not.toBeNull();
    expect(await tells(customer, "review.replied")).toHaveLength(1);
    expect((await call("GET", `/pod/orders/${order.id}/review`, customer.token)).json().data.reply.text).toBe("Reprint is on its way.");

    expect((await call("DELETE", `/employment/${replierPlace}/reviews/${reviewId}/reply`, replier.token)).json().data.reply).toBeNull();
    expect((await call("DELETE", `/vendor/businesses/${shopId}/reviews/${reviewId}/reply`, owner.token)).statusCode).toBe(409);

    const stranger = await person({ vendor: true, verified: true });
    expect((await call("GET", `/vendor/businesses/${shopId}/reviews`, stranger.token)).statusCode).toBe(404);

    expect(await activity(owner, shopId)).toEqual(
      expect.arrayContaining([
        ["you", `Replied to the review of order #${order.orderNo}`],
        ["team", `Changed the reply to the review of order #${order.orderNo}`],
        ["team", `Took down the reply to the review of order #${order.orderNo}`],
      ]),
    );
  }, 90_000);

  it("takes reports, and Ruxstar keeps a review or removes it with a reason", async () => {
    const owner = await person({ vendor: true, verified: true });
    const shopId = await teeShop(owner);
    const customer = await person({ name: "Meena" });
    const reporter = await person({ name: "Reporter" });
    const order = await delivered(owner, customer, shopId);
    const reviewId = (await review(customer, order.id, { rating: 1, text: "Buy followers at spam.example" })).json().data.id as string;
    const report = (u: User, body: object) => call("POST", `/pod/reviews/${reviewId}/report`, u.token, body);

    expect((await report(customer, { reason: "spam" })).statusCode).toBe(400);
    expect((await report(reporter, { reason: "spam", note: "A link" })).statusCode).toBe(200);
    expect((await report(reporter, { reason: "abuse" })).statusCode).toBe(200);
    expect((await report(owner, { reason: "fake" })).statusCode).toBe(200);
    expect(await stack.db.reviewReports.countDocuments({ status: "open" })).toBe(2);
    expect((await call("GET", "/ruxstar/overview", admin.token)).json().data.reports.reviews).toBe(1);

    const open = (await call("GET", "/ruxstar/reports/reviews", admin.token)).json().data;
    expect(open).toEqual([
      expect.objectContaining({
        reviewId,
        status: "open",
        reports: 2,
        reasons: { spam: 1, fake: 1, abuse: 0, other: 0 },
        notes: ["A link"],
        review: expect.objectContaining({ rating: 1, status: "live", shop: { id: shopId, name: "Rao Prints" }, orderNo: order.orderNo }),
      }),
    ]);

    const kept = await call("POST", `/ruxstar/reports/reviews/${reviewId}/keep`, admin.token);
    expect(kept.json().data).toMatchObject({ status: "closed", outcome: "kept" });
    expect((await call("POST", `/ruxstar/reports/reviews/${reviewId}/keep`, admin.token)).statusCode).toBe(409);
    expect((await call("GET", "/ruxstar/reports/reviews", admin.token)).json().data).toEqual([]);

    expect((await report(reporter, { reason: "spam" })).statusCode).toBe(200);
    expect((await call("POST", `/ruxstar/reports/reviews/${reviewId}/remove`, admin.token, { reason: "no" })).statusCode).toBe(400);
    const removed = await call("POST", `/ruxstar/reports/reviews/${reviewId}/remove`, admin.token, { reason: "Reviews can't advertise other services." });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data).toMatchObject({ outcome: "removed", review: { status: "removed", removal: { reason: "Reviews can't advertise other services." } } });
    expect((await call("POST", `/ruxstar/reports/reviews/${reviewId}/remove`, admin.token, { reason: "Again, again" })).statusCode).toBe(409);

    expect((await call("GET", `/pod/shops/${shopId}/reviews`, reporter.token)).json().data).toEqual([]);
    expect((await call("GET", `/pod/shops/${shopId}`, reporter.token)).json().data.rating).toEqual({ average: null, count: 0 });
    expect((await call("GET", `/pod/orders/${order.id}/review`, customer.token)).json().data).toMatchObject({
      status: "removed",
      removedReason: "Reviews can't advertise other services.",
    });
    expect((await review(customer, order.id, { rating: 5 })).statusCode).toBe(409);
    expect((await call("DELETE", `/pod/orders/${order.id}/review`, customer.token)).statusCode).toBe(409);
    expect((await call("PUT", `/vendor/businesses/${shopId}/reviews/${reviewId}/reply`, owner.token, { text: "Hello there" })).statusCode).toBe(404);
    expect((await report(reporter, { reason: "spam" })).statusCode).toBe(404);
    expect(await tells(customer, "review.removed")).toEqual([
      ["Your review was removed", `Ruxstar removed your review of order #${order.orderNo}: Reviews can't advertise other services.`, { screen: "order", id: order.id }],
    ]);
    expect(await activity(owner, shopId)).toEqual(
      expect.arrayContaining([["ruxstar", `Removed the review of order #${order.orderNo}: Reviews can't advertise other services.`]]),
    );

    const staff = await signIn(stack);
    expect((await call("GET", "/ruxstar/reports/reviews", staff.token)).statusCode).toBe(403);
  }, 90_000);

  it("lists Reply to reviews among the permissions an owner can give", async () => {
    const owner = await person({ vendor: true, verified: true });
    const shopId = await teeShop(owner);
    const team = (await call("GET", `/vendor/businesses/${shopId}/team`, owner.token)).json().data;
    expect(team.permissions).toEqual(expect.arrayContaining([expect.objectContaining({ key: "reviews.reply", label: "Reply to reviews" })]));
  }, 60_000);
});
