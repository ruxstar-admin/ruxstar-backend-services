import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { forgetModuleState } from "../src/platform/module-switch.js";
import { signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>>;
const BACK = "https://ruxstar.com/orders";
const ADDRESS = { name: "Ravi Kumar", phone: "9876501234", line: "Flat 302, Green Towers, Madhapur", city: "Hyderabad", pincode: "500081" };

describe("team orders", () => {
  let stack: Stack;
  let photo: Buffer;
  let pdf: Buffer;

  beforeAll(async () => {
    stack = await startStack();
    photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#8a6a40" } }).jpeg().toBuffer();
    const doc = await PDFDocument.create();
    doc.addPage();
    pdf = Buffer.from(await doc.save());
  });
  afterAll(() => stack?.stop());
  beforeEach(async () => {
    await Promise.all([
      stack.db.businesses.deleteMany({}),
      stack.db.podOrders.deleteMany({}),
      stack.db.printFiles.deleteMany({}),
      stack.db.ledgerEntries.deleteMany({}),
      stack.db.employments.deleteMany({}),
      stack.db.notifications.deleteMany({}),
      stack.db.auditLogs.deleteMany({}),
    ]);
    await stack.db.moduleSettings.updateOne({ module: "pod" }, { $set: { live: true, signupsOpen: true, commissionBps: 1000, platformFee: 500 } });
    forgetModuleState();
  });

  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, token: string, payload?: object) =>
    stack.app.inject({
      method,
      url: `/v1${url}`,
      headers: web(token, method === "GET" || method === "DELETE" ? {} : { "idempotency-key": randomUUID() }),
      ...(payload ? { payload } : {}),
    });

  let n = 0;
  async function person(opts: { vendor?: boolean; verified?: boolean; name?: string } = {}) {
    const user = await signIn(stack, opts.vendor ? { vendor: true } : {});
    const username = `staff${Date.now() % 1e6}${n++}`;
    await stack.db.users.updateOne(
      { _id: user.userId },
      { $set: { name: opts.name ?? "Kiran Das", username, ...(opts.verified ? { "kyc.base": "approved" } : {}) } },
    );
    return { ...user, username };
  }

  /** A live tee shop: ₹300 a shirt, ₹250 from 10. Twelve shirts are ₹3,000 of items, plus the ₹5 platform fee. */
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
    return res.json().data.order as { id: string; orderNo: number; files: { id: string }[] };
  }

  /** Invites and accepts; returns the place id. */
  async function hire(owner: User, shopId: string, who: { token: string; username: string }, permissions: string[]) {
    const placeId = (await call("POST", `/vendor/businesses/${shopId}/team`, owner.token, { username: who.username, permissions })).json().data.id as string;
    expect((await call("POST", `/employment/${placeId}/accept`, who.token)).statusCode).toBe(200);
    return placeId;
  }

  it("shows a shop's orders to its team, with the shop's money only for those who may see earnings", async () => {
    const owner = await person({ vendor: true, verified: true });
    const shopId = await teeShop(owner);
    const viewer = await person({ verified: true, name: "Viewer" });
    const counter = await person({ verified: true, name: "Counter" });
    const unverified = await person({ name: "Pending" });
    const shopOnly = await person({ verified: true, name: "Shop only" });
    const viewerPlace = await hire(owner, shopId, viewer, ["orders.view"]);
    const counterPlace = await hire(owner, shopId, counter, ["earnings.view"]);
    const pendingPlace = await hire(owner, shopId, unverified, ["orders.view"]);
    await hire(owner, shopId, shopOnly, ["shop.open"]);

    const customer = await signIn(stack);
    const order = await paid(customer, shopId);

    const tells = async (u: User) => (await stack.db.notifications.find({ userId: u.userId, type: "order.placed" }).toArray()).map((x) => [x.title, x.body, x.link]);
    expect(await tells(viewer)).toEqual([[`New order #${order.orderNo} at Rao Prints`, "T-Shirts × 12 for Hyderabad.", { screen: "work_order", id: order.id }]]);
    expect(await tells(counter)).toEqual([
      [`New order #${order.orderNo} at Rao Prints`, "T-Shirts × 12 for Hyderabad. ₹2,700 to the shop.", { screen: "work_order", id: order.id }],
    ]);
    expect(await tells(unverified)).toEqual([]);
    expect(await tells(shopOnly)).toEqual([]);
    const placed = await stack.db.notifications.find({ userId: customer.userId, type: "order.updated" }).toArray();
    expect(placed.map((x) => [x.title, x.body, x.link])).toEqual([
      [`Order placed: #${order.orderNo}`, "Waiting for Rao Prints to accept it. If they don't within 6 hours, you're refunded.", { screen: "order", id: order.id }],
    ]);

    const list = await call("GET", `/employment/${viewerPlace}/orders?view=new`, viewer.token);
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0]).toMatchObject({
      id: order.id,
      placeId: viewerPlace,
      permissions: ["orders.view"],
      price: { items: 300_000, total: 300_500, commission: null, payout: null, payoutLeft: null, commissionBps: null },
      refundable: 0,
    });
    const counted = (await call("GET", `/employment/orders/${order.id}`, counter.token)).json().data;
    expect(counted).toMatchObject({ placeId: counterPlace, price: { commission: 30_000, payout: 270_000 } });

    expect((await call("GET", `/employment/${pendingPlace}/orders`, unverified.token)).json().error.code).toBe("KYC_REQUIRED");
    expect((await call("GET", `/employment/orders/${order.id}`, shopOnly.token)).statusCode).toBe(403);
    expect((await call("GET", `/employment/orders/${order.id}`, customer.token)).statusCode).toBe(404);
    expect((await call("GET", `/employment/${viewerPlace}/orders`, counter.token)).statusCode).toBe(404);

    const file = await call("GET", `/employment/orders/${order.id}/files/${order.files[0]!.id}`, viewer.token);
    expect(file.statusCode).toBe(200);
    expect(file.json().data.url).toContain(order.id);
  }, 60_000);

  it("lets the team move, turn down and refund orders only with each permission, logged as them", async () => {
    const owner = await person({ vendor: true, verified: true });
    const shopId = await teeShop(owner);
    const viewer = await person({ verified: true, name: "Viewer" });
    const mover = await person({ verified: true, name: "Mover" });
    const rejecter = await person({ verified: true, name: "Rejecter" });
    const refunder = await person({ verified: true, name: "Refunder" });
    await hire(owner, shopId, viewer, ["orders.view"]);
    await hire(owner, shopId, mover, ["orders.move"]);
    await hire(owner, shopId, rejecter, ["orders.reject"]);
    await hire(owner, shopId, refunder, ["orders.refund"]);
    const customer = await signIn(stack);
    const first = await paid(customer, shopId);
    const second = await paid(customer, shopId);

    const move = (u: User, id: string, body: object) => call("POST", `/employment/orders/${id}/status`, u.token, body);
    expect((await move(viewer, first.id, { status: "accepted" })).statusCode).toBe(403);
    expect((await move(mover, first.id, { status: "rejected", reason: "Out of stock" })).statusCode).toBe(403);
    const accepted = await move(mover, first.id, { status: "accepted" });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data.status).toBe("accepted");
    expect((await move(mover, first.id, { status: "printing" })).json().data.status).toBe("printing");
    expect((await move(rejecter, first.id, { status: "rejected", reason: "Out of stock" })).json().error.code).toBe("ORDER_STATE");

    const rejected = await move(rejecter, second.id, { status: "rejected", reason: "We're out of medium shirts." });
    expect(rejected.json().data).toMatchObject({ status: "rejected", reason: "We're out of medium shirts." });
    const ownerHears = await stack.db.notifications.find({ userId: owner.userId, type: "order.updated" }).sort({ createdAt: 1, _id: 1 }).toArray();
    expect(ownerHears.map((x) => [x.title, x.body, x.link])).toEqual([
      [`Order #${first.orderNo} updated`, "Mover accepted.", { screen: "shop_order", id: first.id }],
      [`Order #${first.orderNo} updated`, "Mover started printing.", { screen: "shop_order", id: first.id }],
      [`Order #${second.orderNo} turned down`, "Rejecter turned it down.", { screen: "shop_order", id: second.id }],
    ]);

    const refund = (u: User) => call("POST", `/employment/orders/${first.id}/refund`, u.token, { amount: 25_000, reason: "One shirt was misprinted" });
    expect((await refund(mover)).statusCode).toBe(403);
    const refunded = await refund(refunder);
    expect(refunded.statusCode).toBe(200);
    expect(refunded.json().data).toMatchObject({ refunded: 25_000, refundable: 245_000, price: { payout: null } });

    const logs = await stack.db.auditLogs.find({ action: { $in: ["pod_order.status", "pod_order.refund"] } }).sort({ createdAt: 1 }).toArray();
    expect(logs.map((l) => [l.action, l.actor.id?.toHexString()])).toEqual([
      ["pod_order.status", mover.userId.toHexString()],
      ["pod_order.status", mover.userId.toHexString()],
      ["pod_order.status", rejecter.userId.toHexString()],
      ["pod_order.refund", refunder.userId.toHexString()],
    ]);

    const placeId = (await stack.db.employments.findOne({ userId: mover.userId }))!._id.toHexString();
    await call("DELETE", `/vendor/businesses/${shopId}/team/${placeId}`, owner.token);
    expect((await move(mover, first.id, { status: "ready" })).statusCode).toBe(404);
  }, 60_000);
});
