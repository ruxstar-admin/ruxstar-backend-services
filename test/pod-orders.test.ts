import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakeGateway } from "../src/adapters/payments.js";
import { stamp } from "../src/platform/db.js";
import { forgetModuleState } from "../src/platform/module-switch.js";
import { JOB_TOKEN, signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>>;
const BACK = "https://ruxstar.com/orders";
const ADDRESS = { name: "Ravi Kumar", phone: "9876501234", line: "Flat 302, Green Towers, Madhapur", city: "Hyderabad", pincode: "500081" };

describe("print orders", () => {
  let stack: Stack;
  let photo: Buffer;
  let pdf3: Buffer;

  beforeAll(async () => {
    stack = await startStack();
    photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#8a6a40" } }).jpeg().toBuffer();
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage();
    pdf3 = Buffer.from(await doc.save());
  });
  afterAll(() => stack?.stop());
  beforeEach(async () => {
    await Promise.all([
      stack.db.businesses.deleteMany({}),
      stack.db.podOrders.deleteMany({}),
      stack.db.printFiles.deleteMany({}),
      stack.db.ledgerEntries.deleteMany({}),
      stack.db.notifications.deleteMany({}),
    ]);
    await stack.db.moduleSettings.updateOne({ module: "pod" }, { $set: { live: true, signupsOpen: true, commissionBps: 1000, platformFee: 500 } });
    forgetModuleState();
  });

  const gateway = () => stack.app.payments as FakeGateway;
  const call = (method: "GET" | "POST" | "PATCH", url: string, token: string, payload?: object) =>
    stack.app.inject({
      method,
      url: `/v1${url}`,
      headers: web(token, method === "GET" ? {} : { "idempotency-key": randomUUID() }),
      ...(payload ? { payload } : {}),
    });

  async function vendor() {
    const user = await signIn(stack, { vendor: true });
    await stack.db.users.updateOne({ _id: user.userId }, { $set: { name: "Asha Rao", "kyc.base": "approved" } });
    await stack.db.kycCases.insertOne({
      _id: new ObjectId(),
      userId: user.userId,
      track: "base",
      status: "approved",
      rejections: 0,
      steps: { aadhaar: { status: "verified", verificationId: "v", referenceId: null, name: "Asha Rao", last4: "1234", reason: null, tries: 1, at: new Date() } },
      submittedAt: new Date(),
      review: null,
      ...stamp(),
    });
    return user;
  }

  async function shop(owner: User, setup: object) {
    const created = await call("POST", "/vendor/businesses", owner.token, {
      module: "pod",
      type: "print_shop",
      name: "Rao Prints",
      phone: "9876543210",
      location: { state: "Telangana", city: "Hyderabad", doorNo: "4-1", street: "Main Road", area: "Madhapur", pincode: "500081" },
    });
    const id = created.json().data.id as string;
    await stack.app.inject({ method: "POST", url: `/v1/vendor/businesses/${id}/photos`, headers: web(owner.token, { "content-type": "image/jpeg" }), payload: photo });
    expect((await call("PATCH", `/vendor/businesses/${id}/pod`, owner.token, setup)).statusCode).toBe(200);
    expect((await call("POST", `/vendor/businesses/${id}/publish`, owner.token)).statusCode).toBe(200);
    return id;
  }

  const teeShop = (owner: User) =>
    shop(owner, {
      products: ["tshirts", "documents"],
      cities: ["Hyderabad"],
      prices: [
        { product: "tshirts", basePrice: 30_000, extras: [{ option: "size", value: "XXL", price: 5_000 }], tiers: [{ from: 10, unitPrice: 25_000 }] },
        { product: "documents", bw: 200, color: 1_000, extras: [{ option: "binding", value: "Spiral bind", price: 100 }] },
      ],
    });

  const upload = (token: string, data: Buffer, type: string, name = "design.pdf") =>
    stack.app.inject({
      method: "POST",
      url: "/v1/pod/files",
      headers: web(token, { "content-type": type, "x-file-name": encodeURIComponent(name) }),
      payload: data,
    });

  async function placed(customer: User, shopId: string, extra: object = {}) {
    const file = (await upload(customer.token, pdf3, "application/pdf")).json().data;
    const res = await call("POST", "/pod/orders", customer.token, {
      shopId,
      product: "tshirts",
      options: { size: "XXL" },
      quantity: 12,
      fileIds: [file.id],
      address: ADDRESS,
      returnTo: BACK,
      ...extra,
    });
    expect(res.statusCode).toBe(201);
    return res.json().data as { order: { id: string; status: string; price: Record<string, number>; orderNo: number }; checkoutUrl: string };
  }

  /** Opens the checkout link the way a browser does and presses the test button. */
  async function pay(checkoutUrl: string) {
    const url = new URL(checkoutUrl);
    const page = await stack.app.inject({ method: "GET", url: url.pathname + url.search });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Pay (test");
    const test = await stack.app.inject({ method: "POST", url: `${url.pathname}/test${url.search}` });
    expect(test.json()).toEqual({ status: "placed" });
  }

  const HOUR = 60 * 60_000;
  /** Moves an order's timers into the past by the given hours, as if that time had gone by. */
  const age = (orderId: string, hoursAgo: Partial<Record<"acceptBy" | "readyBy" | "deliveredAt" | "releaseAt", number>>) =>
    stack.db.podOrders.updateOne(
      { _id: new ObjectId(orderId) },
      { $set: Object.fromEntries(Object.entries(hoursAgo).map(([field, hours]) => [field, new Date(Date.now() - hours * HOUR)])) },
    );
  const sweep = (token = JOB_TOKEN) =>
    stack.app.inject({ method: "POST", url: "/jobs/orders", headers: token ? { authorization: `Bearer ${token}` } : {} });

  /** A paid order the shop has accepted, or moved on to `to`. */
  async function inHand(to: "accepted" | "out_for_delivery" | "delivered" = "accepted") {
    const owner = await vendor();
    const shopId = await teeShop(owner);
    const customer = await signIn(stack);
    const { order, checkoutUrl } = await placed(customer, shopId);
    await pay(checkoutUrl);
    await call("POST", `/vendor/orders/${order.id}/status`, owner.token, { status: "accepted" });
    if (to !== "accepted") await call("POST", `/vendor/orders/${order.id}/status`, owner.token, { status: to });
    return { owner, customer, order };
  }

  const photoUpload = (token: string, orderId: string) =>
    stack.app.inject({
      method: "POST",
      url: `/v1/pod/orders/${orderId}/problem/photos`,
      headers: web(token, { "content-type": "image/jpeg", "idempotency-key": randomUUID() }),
      payload: photo,
    });

  it("counts PDF pages, keeps files private and refuses anything else", async () => {
    const customer = await signIn(stack);
    const res = await upload(customer.token, pdf3, "application/pdf", "C:\\Users\\me\\Report final.pdf");
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ name: "Report final.pdf", contentType: "application/pdf", pages: 3, bytes: pdf3.length });
    const saved = await stack.db.printFiles.findOne({ _id: new ObjectId(res.json().data.id) });
    expect(stack.printFiles.objects.has(saved!.key)).toBe(true);

    expect((await upload(customer.token, photo, "image/jpeg", "photo.jpg")).json().data).toMatchObject({ contentType: "image/jpeg", pages: 1 });
    expect((await upload(customer.token, Buffer.from("not a file at all"), "application/pdf")).json().error.code).toBe("FILE_INVALID");
    expect((await upload(customer.token, Buffer.from("%PDF-1.7 broken"), "application/pdf")).json().error.code).toBe("FILE_INVALID");
  });

  it("prices by the unit with bulk tiers and extras, and documents by the page, plus the platform fee", async () => {
    const owner = await vendor();
    const shopId = await teeShop(owner);
    const customer = await signIn(stack);
    const file = (await upload(customer.token, pdf3, "application/pdf")).json().data;

    const tees = await call("POST", "/pod/quote", customer.token, { shopId, product: "tshirts", options: { size: "XXL" }, quantity: 12, fileIds: [] });
    expect(tees.json().data).toMatchObject({ units: 12, unitPrice: 25_000, extrasPerUnit: 5_000, items: 360_000, platformFee: 500, total: 360_500 });

    const docs = await call("POST", "/pod/quote", customer.token, {
      shopId,
      product: "documents",
      options: { paperSize: "A4", binding: "Spiral bind" },
      colour: "color",
      quantity: 2,
      fileIds: [file.id],
    });
    expect(docs.json().data).toMatchObject({ pages: 3, units: 6, unitPrice: 1_000, extrasPerUnit: 100, items: 6_600, total: 7_100 });

    const noSize = await call("POST", "/pod/quote", customer.token, { shopId, product: "tshirts", options: {}, quantity: 1, fileIds: [] });
    expect(noSize.json().error).toMatchObject({ code: "ORDER_INVALID", details: [{ path: "body/options/size" }] });
    const badValue = await call("POST", "/pod/quote", customer.token, { shopId, product: "tshirts", options: { size: "Giant" }, quantity: 1, fileIds: [] });
    expect(badValue.json().error.code).toBe("ORDER_INVALID");
    const notSold = await call("POST", "/pod/quote", customer.token, { shopId, product: "posters", options: { size: "A4" }, quantity: 1, fileIds: [] });
    expect(notSold.json().error.details[0].path).toBe("body/product");
  });

  it("takes payment, then the shop accepts, prints and delivers, and its share becomes available 48 hours later", async () => {
    const owner = await vendor();
    const shopId = await teeShop(owner);
    const customer = await signIn(stack);
    const { order, checkoutUrl } = await placed(customer, shopId);
    expect(order.status).toBe("awaiting_payment");
    expect(order.price).toMatchObject({ items: 360_000, total: 360_500 });
    expect(checkoutUrl).toMatch(/\/pay\/[a-f0-9]{24}\?/);

    // The shop doesn't see an unpaid order.
    expect((await call("GET", "/vendor/orders", owner.token)).json().data).toEqual([]);

    await pay(checkoutUrl);
    const mine = (await call("GET", `/pod/orders/${order.id}`, customer.token)).json().data;
    expect(mine.status).toBe("placed");
    expect(mine.paidAt).not.toBeNull();
    expect(mine.price).not.toHaveProperty("commission");

    const listed = (await call("GET", "/vendor/orders?view=new", owner.token)).json().data;
    expect(listed).toHaveLength(1);
    expect(listed[0].price).toMatchObject({ commissionBps: 1000, commission: 36_000, payout: 324_000 });
    expect(listed[0].address).toMatchObject(ADDRESS);
    const bell = await stack.db.notifications.findOne({ userId: owner.userId });
    expect(bell).toMatchObject({ type: "order.placed", link: { screen: "shop_order", id: order.id } });

    const balance = (await call("GET", "/vendor/payments", owner.token)).json().data.balance;
    expect(balance).toMatchObject({ available: 0, pending: 324_000 });

    const file = listed[0].files[0];
    const link = (await call("GET", `/vendor/orders/${order.id}/files/${file.id}`, owner.token)).json().data;
    const href = new URL(link.url);
    const download = await stack.app.inject({ method: "GET", url: href.pathname + href.search });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("application/pdf");
    expect(download.rawPayload.equals(pdf3)).toBe(true);
    expect(download.headers["content-disposition"]).toMatch(/^inline; /);
    const saved = await stack.app.inject({ method: "GET", url: `${href.pathname}${href.search}&download=1` });
    expect(saved.headers["content-disposition"]).toMatch(/^attachment; filename="/);
    href.searchParams.set("exp", String(Number(href.searchParams.get("exp")) + 60));
    expect((await stack.app.inject({ method: "GET", url: href.pathname + href.search })).statusCode).toBe(401);

    const move = (status: string, reason?: string) => call("POST", `/vendor/orders/${order.id}/status`, owner.token, { status, ...(reason ? { reason } : {}) });
    expect((await move("printing")).json().error.code).toBe("ORDER_STATE");
    expect((await move("accepted")).json().data.status).toBe("accepted");
    expect((await move("printing")).json().data.status).toBe("printing");
    expect((await move("accepted")).json().error.code).toBe("ORDER_STATE");
    expect((await move("rejected", "Out of white shirts")).json().error.code).toBe("ORDER_STATE");
    expect((await move("out_for_delivery")).json().data.status).toBe("out_for_delivery");
    const delivered = (await move("delivered")).json().data;
    expect(delivered.timeline.map((t: { status: string }) => t.status)).toEqual([
      "awaiting_payment",
      "placed",
      "accepted",
      "printing",
      "out_for_delivery",
      "delivered",
    ]);

    expect(Date.parse(delivered.releaseAt) - Date.parse(delivered.deliveredAt)).toBe(48 * 60 * 60_000);
    let payments = (await call("GET", "/vendor/payments", owner.token)).json().data;
    expect(payments.balance).toMatchObject({ available: 0, pending: 324_000 });
    expect(payments.upcoming).toEqual([{ orderId: order.id, orderNo: order.orderNo, amount: 324_000, availableAt: delivered.releaseAt, held: false }]);

    await age(order.id, { releaseAt: 1 });
    payments = (await call("GET", "/vendor/payments", owner.token)).json().data;
    expect(payments.balance).toMatchObject({ available: 324_000, pending: 0 });
    expect(payments.upcoming).toEqual([]);
    expect((await call("GET", `/vendor/orders/${order.id}`, owner.token)).json().data).toMatchObject({ refundable: 0, releasedAt: expect.any(String) });
    expect(await stack.db.notifications.findOne({ userId: owner.userId, title: "₹3,240 available" })).not.toBeNull();
    const entries = await stack.db.ledgerEntries.find({}).toArray();
    expect(entries.reduce((sum, e) => sum + e.signedPaise, 0)).toBe(0);
    const ruxstar = entries.filter((e) => e.accountId === "ruxstar" && e.bucket === "withdrawable").reduce((s, e) => s + e.signedPaise, 0);
    expect(ruxstar).toBe(36_500);
    expect(stack.printFiles.expiring.size).toBe(1);
    const reprint = () => call("GET", `/vendor/orders/${order.id}/files/${file.id}`, owner.token);
    expect((await reprint()).statusCode).toBe(200);
    await stack.db.podOrders.updateOne({ _id: new ObjectId(order.id) }, { $set: { deliveredAt: new Date(Date.now() - 31 * 24 * 60 * 60_000) } });
    expect((await reprint()).json().error.message).toBe("Files are kept for 30 days after delivery, so this order's are gone.");
    const customerNews = await stack.db.notifications.find({ userId: customer.userId }).toArray();
    expect(customerNews.map((n) => n.title)).toContain(`Delivered: #${order.orderNo}`);
  });

  it("refunds in full when the shop turns an order down", async () => {
    const owner = await vendor();
    const shopId = await teeShop(owner);
    const customer = await signIn(stack);
    const { order, checkoutUrl } = await placed(customer, shopId);
    await pay(checkoutUrl);

    const noReason = await call("POST", `/vendor/orders/${order.id}/status`, owner.token, { status: "rejected" });
    expect(noReason.json().error.code).toBe("VALIDATION_FAILED");
    const res = await call("POST", `/vendor/orders/${order.id}/status`, owner.token, { status: "rejected", reason: "Out of XXL white shirts" });
    expect(res.json().data).toMatchObject({
      status: "rejected",
      reason: "Out of XXL white shirts",
      refunds: [{ amount: 360_500, kind: "full", status: "done" }],
      refunded: 360_500,
    });
    expect([...gateway().refunds.values()]).toContainEqual({ orderId: `rx_${order.id}`, amount: 360_500 });

    const balance = (await call("GET", "/vendor/payments", owner.token)).json().data.balance;
    expect(balance).toMatchObject({ available: 0, pending: 0 });
    const vendorEntries = await stack.db.ledgerEntries.find({ accountId: `vendor:${owner.userId.toHexString()}` }).toArray();
    expect(vendorEntries.reduce((s, e) => s + e.signedPaise, 0)).toBe(0);
    const told = await stack.db.notifications.findOne({ userId: customer.userId, type: "order.updated" });
    expect(told?.body).toContain("Out of XXL white shirts");
    expect((await call("GET", "/account/payments", customer.token)).json().data).toMatchObject([{ id: order.id, status: "refunded", refunded: 360_500 }]);
  });

  it("lets the customer cancel before the shop accepts: unpaid is closed at the gateway, paid is refunded", async () => {
    const owner = await vendor();
    const shopId = await teeShop(owner);
    const customer = await signIn(stack);

    const unpaid = await placed(customer, shopId);
    const cancelled = await call("POST", `/pod/orders/${unpaid.order.id}/cancel`, customer.token);
    expect(cancelled.json().data).toMatchObject({ status: "cancelled", refunds: [], refunded: 0 });
    expect(gateway().orders.get(`rx_${unpaid.order.id}`)?.status).toBe("terminated");

    const paid = await placed(customer, shopId);
    await pay(paid.checkoutUrl);
    const refunded = await call("POST", `/pod/orders/${paid.order.id}/cancel`, customer.token);
    expect(refunded.json().data).toMatchObject({ status: "cancelled", refunds: [{ kind: "full", status: "done" }] });
    expect(await stack.db.notifications.findOne({ userId: owner.userId, title: `Order #${paid.order.orderNo} cancelled` })).not.toBeNull();

    const accepted = await placed(customer, shopId);
    await pay(accepted.checkoutUrl);
    await call("POST", `/vendor/orders/${accepted.order.id}/status`, owner.token, { status: "accepted" });
    expect((await call("POST", `/pod/orders/${accepted.order.id}/cancel`, customer.token)).json().error.code).toBe("ORDER_STATE");
  });

  it("refuses orders the shop can't take", async () => {
    const owner = await vendor();
    const shopId = await teeShop(owner);
    const customer = await signIn(stack);
    const file = (await upload(customer.token, pdf3, "application/pdf")).json().data;
    const order = (extra: object, token = customer.token) =>
      call("POST", "/pod/orders", token, {
        shopId,
        product: "tshirts",
        options: { size: "M" },
        quantity: 1,
        fileIds: [file.id],
        address: ADDRESS,
        returnTo: BACK,
        ...extra,
      });

    expect((await order({ address: { ...ADDRESS, city: "Chennai" } })).json().error.code).toBe("ORDER_INVALID");
    expect((await order({ returnTo: "https://evil.example/steal" })).json().error.code).toBe("VALIDATION_FAILED");
    expect((await order({ returnTo: "javascript:alert(1)" })).json().error.code).toBe("VALIDATION_FAILED");
    expect((await order({}, owner.token)).json().error.code).toBe("ORDER_INVALID");
    const other = await signIn(stack);
    expect((await order({}, other.token)).json().error.details[0].path).toBe("body/fileIds/0");

    await call("POST", `/vendor/businesses/${shopId}/close`, owner.token);
    expect((await order({})).json().error.code).toBe("SHOP_CLOSED");
    await call("POST", `/vendor/businesses/${shopId}/open`, owner.token);

    // The installed app returns to its own scheme, not Expo Go's.
    expect((await order({ returnTo: "ruxstarapplicationservices://pod/paid" })).statusCode).toBe(201);
    // The file is now in that order, so it can't be ordered again.
    expect((await order({})).json().error.code).toBe("ORDER_INVALID");
  });

  it("keeps orders and files to the customer and the shop", async () => {
    const owner = await vendor();
    const shopId = await teeShop(owner);
    const customer = await signIn(stack);
    const { order, checkoutUrl } = await placed(customer, shopId);
    await pay(checkoutUrl);
    const fileId = (await call("GET", `/pod/orders/${order.id}`, customer.token)).json().data.files[0].id;

    const stranger = await vendor();
    expect((await call("GET", `/pod/orders/${order.id}`, stranger.token)).statusCode).toBe(404);
    expect((await call("GET", `/vendor/orders/${order.id}`, stranger.token)).statusCode).toBe(404);
    expect((await call("GET", `/vendor/orders/${order.id}/files/${fileId}`, stranger.token)).statusCode).toBe(404);
    expect((await call("GET", `/pod/orders/${order.id}/files/${fileId}`, customer.token)).statusCode).toBe(200);
    expect((await call("GET", "/pod/orders", customer.token)).json().data.map((o: { id: string }) => o.id)).toEqual([order.id]);
  });

  it("refuses a tampered or expired checkout link and an unsigned webhook", async () => {
    const owner = await vendor();
    const shopId = await teeShop(owner);
    const customer = await signIn(stack);
    const { checkoutUrl } = await placed(customer, shopId);
    const url = new URL(checkoutUrl);
    url.searchParams.set("back", "https://ruxstar.com/elsewhere");
    const tampered = await stack.app.inject({ method: "GET", url: url.pathname + url.search });
    expect(tampered.body).toContain("Can't open this payment");
    const test = await stack.app.inject({ method: "POST", url: `${url.pathname}/test${url.search}` });
    expect(test.statusCode).toBe(401);

    const hook = await stack.app.inject({
      method: "POST",
      url: "/webhooks/cashfree",
      headers: { "content-type": "application/json", "x-webhook-timestamp": "1", "x-webhook-signature": "bad" },
      payload: JSON.stringify({ data: { order: { order_id: "rx_x" } } }),
    });
    expect(hook.statusCode).toBe(401);
  });

  it("cancels and refunds a paid order the shop doesn't accept within 6 hours", async () => {
    const owner = await vendor();
    const shopId = await teeShop(owner);
    const customer = await signIn(stack);
    const { order, checkoutUrl } = await placed(customer, shopId);
    await pay(checkoutUrl);
    const mine = (await call("GET", `/pod/orders/${order.id}`, customer.token)).json().data;
    expect(Date.parse(mine.acceptBy) - Date.parse(mine.paidAt)).toBe(6 * HOUR);

    expect((await sweep("")).statusCode).toBe(401);
    expect((await sweep("forged")).statusCode).toBe(401);
    expect((await sweep()).json()).toMatchObject({ ok: true, cancelled: 0 });
    await age(order.id, { acceptBy: 0.1 });
    expect((await sweep()).json()).toMatchObject({ ok: true, checked: 1, cancelled: 1 });
    const after = (await call("GET", `/pod/orders/${order.id}`, customer.token)).json().data;
    expect(after).toMatchObject({
      status: "cancelled",
      acceptBy: null,
      reason: "The shop didn't accept it within 6 hours.",
      refunds: [{ amount: 360_500, kind: "full", status: "done" }],
    });
    expect([...gateway().refunds.values()]).toContainEqual({ orderId: `rx_${order.id}`, amount: 360_500 });
    expect(await stack.db.notifications.findOne({ userId: customer.userId, title: `Order #${order.orderNo} cancelled` })).not.toBeNull();
    expect((await call("POST", `/vendor/orders/${order.id}/status`, owner.token, { status: "accepted" })).json().error.code).toBe("ORDER_STATE");
    expect((await sweep()).json()).toMatchObject({ checked: 0 });

    // Opening the shop's orders catches up one the scheduler hasn't reached yet.
    const second = await placed(customer, shopId);
    await pay(second.checkoutUrl);
    await age(second.order.id, { acceptBy: 0.1 });
    expect((await call("GET", "/vendor/orders?view=new", owner.token)).json().data[0]).toMatchObject({ id: second.order.id, status: "cancelled" });
  });

  it("counts an order delivered a week after its ready date, and pays the shop 48 hours after that", async () => {
    const { owner, customer, order } = await inHand("out_for_delivery");
    const doc = await stack.db.podOrders.findOne({ _id: new ObjectId(order.id) });
    expect(doc!.readyBy!.getTime() - doc!.acceptedAt!.getTime()).toBe(doc!.turnaroundDays! * 24 * HOUR);
    expect((await call("GET", `/pod/orders/${order.id}`, customer.token)).json().data.readyBy).toBe(doc!.readyBy!.toISOString());

    await age(order.id, { readyBy: 7 * 24 - 1 });
    expect((await sweep()).json()).toMatchObject({ delivered: 0 });
    await age(order.id, { readyBy: 7 * 24 + 1 });
    expect((await sweep()).json()).toMatchObject({ delivered: 1 });
    const after = (await call("GET", `/vendor/orders/${order.id}`, owner.token)).json().data;
    expect(after.status).toBe("delivered");
    expect(Date.parse(after.releaseAt) - Date.parse(after.deliveredAt)).toBe(48 * HOUR);
    expect(await stack.db.notifications.findOne({ userId: customer.userId, title: `Marked delivered: #${order.orderNo}` })).not.toBeNull();

    await age(order.id, { releaseAt: 1 });
    expect((await sweep()).json()).toMatchObject({ released: 1 });
    expect((await call("GET", "/vendor/payments", owner.token)).json().data.balance).toMatchObject({ available: 324_000, pending: 0 });
  });

  it("lets the shop refund part of an order out of its share, until the share is released", async () => {
    const { owner, customer, order } = await inHand();
    const refund = (amount: number) => call("POST", `/vendor/orders/${order.id}/refund`, owner.token, { amount, reason: "Two shirts misprinted" });
    expect((await refund(324_001)).json().error).toMatchObject({ code: "ORDER_INVALID", details: [{ path: "body/amount" }] });
    expect((await refund(50)).statusCode).toBe(400);
    expect((await refund(50_000)).json().data).toMatchObject({
      status: "accepted",
      refunded: 50_000,
      refundable: 274_000,
      price: { payout: 324_000, payoutLeft: 274_000 },
      refunds: [{ amount: 50_000, kind: "partial", reason: "Two shirts misprinted", status: "done" }],
    });
    expect(gateway().refunds.get(`rf_${order.id}_1`)).toEqual({ orderId: `rx_${order.id}`, amount: 50_000 });
    expect(await stack.db.notifications.findOne({ userId: customer.userId, title: `₹500 back for order #${order.orderNo}` })).not.toBeNull();
    expect((await call("GET", "/vendor/payments", owner.token)).json().data.balance).toMatchObject({ pending: 274_000 });
    expect((await call("GET", "/account/payments", customer.token)).json().data).toEqual([
      {
        id: order.id,
        module: "pod",
        business: { id: expect.any(String), name: expect.any(String) },
        order: { id: order.id, orderNo: order.orderNo, label: "T-Shirts" },
        amount: order.price.total,
        paidAt: expect.any(String),
        paymentId: expect.any(String),
        status: "part_refunded",
        refunded: 50_000,
        refunds: [{ amount: 50_000, kind: "partial", reason: "Two shirts misprinted", status: "done", at: expect.any(String) }],
      },
    ]);
    expect((await call("GET", "/account/payments", owner.token)).json().data).toEqual([]);

    await call("POST", `/vendor/orders/${order.id}/status`, owner.token, { status: "delivered" });
    await age(order.id, { releaseAt: 1 });
    expect((await call("GET", "/vendor/payments", owner.token)).json().data.balance).toMatchObject({ available: 274_000, pending: 0 });
    expect((await refund(1_000)).json().error.code).toBe("ORDER_STATE");
    const entries = await stack.db.ledgerEntries.find({}).toArray();
    expect(entries.reduce((sum, e) => sum + e.signedPaise, 0)).toBe(0);

    const statement = (query = "") => call("GET", `/vendor/payments/statement${query}`, owner.token);
    const lines = (await statement()).json();
    const ref = { id: order.id, orderNo: order.orderNo, business: { name: expect.any(String) } };
    expect(lines.data).toMatchObject([
      { kind: "available", amount: 274_000, module: "pod", order: ref },
      { kind: "refund", amount: -50_000, order: ref },
      { kind: "paid", amount: 324_000, order: ref },
    ]);
    const first = (await statement("?limit=2")).json();
    expect(first.data.map((l: { kind: string }) => l.kind)).toEqual(["available", "refund"]);
    const rest = (await statement(`?limit=2&cursor=${first.meta.nextCursor}`)).json();
    expect(rest.data.map((l: { kind: string }) => l.kind)).toEqual(["paid"]);
    expect(rest.meta.nextCursor).toBeNull();
    expect((await call("GET", "/vendor/payments/statement", customer.token)).statusCode).toBe(403);
  });

  it("takes a problem report with photos, holds the shop's share, and Ruxstar settles it", async () => {
    const { owner, customer, order } = await inHand("delivered");
    const report = (body: object) => call("POST", `/pod/orders/${order.id}/problem`, customer.token, body);
    expect((await photoUpload(customer.token, order.id)).json().error.code).toBe("ORDER_STATE");
    const reported = (await report({ kind: "wrong_item", note: "The print is the wrong design" })).json().data;
    expect(reported).toMatchObject({ canReport: false, reportUntil: null, problem: { kind: "wrong_item", status: "open", photos: [], resolution: null } });
    expect((await report({ kind: "damaged", note: "Again" })).json().error.code).toBe("CONFLICT");
    expect(await stack.db.notifications.findOne({ userId: owner.userId, title: `Problem reported: #${order.orderNo}` })).not.toBeNull();

    for (let i = 0; i < 3; i++) expect((await photoUpload(customer.token, order.id)).statusCode).toBe(200);
    expect((await photoUpload(customer.token, order.id)).json().error.code).toBe("CONFLICT");
    const shopView = (await call("GET", `/vendor/orders/${order.id}`, owner.token)).json().data;
    expect(shopView.problem.photos).toHaveLength(3);
    const href = new URL(shopView.problem.photos[0].url);
    const image = await stack.app.inject({ method: "GET", url: href.pathname + href.search });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/jpeg");
    href.searchParams.set("t", "forged");
    expect((await stack.app.inject({ method: "GET", url: href.pathname + href.search })).statusCode).toBe(401);

    // The hold is over, but the share waits for Ruxstar.
    await age(order.id, { releaseAt: 1 });
    expect((await sweep()).json()).toMatchObject({ released: 0 });
    const payments = (await call("GET", "/vendor/payments", owner.token)).json().data;
    expect(payments.balance).toMatchObject({ available: 0, pending: 324_000 });
    expect(payments.upcoming[0]).toMatchObject({ orderId: order.id, held: true });

    expect((await call("GET", "/ruxstar/reports/orders", customer.token)).statusCode).toBe(403);
    const admin = await signIn(stack, { admin: true });
    const queue = (await call("GET", "/ruxstar/reports/orders", admin.token)).json().data;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ id: order.id, vendor: { name: "Asha Rao" }, problem: { kind: "wrong_item" } });
    expect((await call("GET", "/ruxstar/overview", admin.token)).json().data.orders).toEqual({ problems: 1 });

    const settle = (body: object) => call("POST", `/ruxstar/reports/orders/${order.id}/settle`, admin.token, body);
    expect((await settle({ outcome: "refund_partial", note: "Half the shirts were wrong" })).json().error.code).toBe("VALIDATION_FAILED");
    expect((await settle({ outcome: "refund_partial", amount: 100_000, note: "Half the shirts were wrong" })).json().data).toMatchObject({
      status: "delivered",
      refunded: 100_000,
      problem: { status: "resolved", resolution: { outcome: "partial", amount: 100_000, note: "Half the shirts were wrong" } },
      releasedAt: expect.any(String),
    });
    expect((await settle({ outcome: "dismiss", note: "Again please" })).json().error.code).toBe("CONFLICT");
    expect((await call("GET", "/vendor/payments", owner.token)).json().data.balance).toMatchObject({ available: 224_000, pending: 0 });
    expect(await stack.db.notifications.findOne({ userId: owner.userId, title: `Refund on order #${order.orderNo}` })).not.toBeNull();
    const photoKeys = (await stack.db.podOrders.findOne({ _id: new ObjectId(order.id) }))!.problem!.photos.map((p) => p.key);
    expect(photoKeys.every((k) => k.startsWith(`problems/${order.id}/`) && stack.printFiles.expiring.has(k))).toBe(true);
    expect((await call("GET", "/ruxstar/reports/orders?status=resolved", admin.token)).json().data).toHaveLength(1);
  });

  it("refunds a late order in full when Ruxstar settles a not-received report, and closes reports 48 hours after delivery", async () => {
    const { owner, customer, order } = await inHand("out_for_delivery");
    await age(order.id, { readyBy: 0.5 });
    expect((await call("GET", `/pod/orders/${order.id}`, customer.token)).json().data.canReport).toBe(true);
    expect((await call("POST", `/pod/orders/${order.id}/problem`, customer.token, { kind: "not_received", note: "Nothing arrived" })).statusCode).toBe(200);
    // Not counted as delivered while the report is open.
    await age(order.id, { readyBy: 8 * 24 });
    expect((await sweep()).json()).toMatchObject({ delivered: 0 });

    const admin = await signIn(stack, { admin: true });
    const settled = await call("POST", `/ruxstar/reports/orders/${order.id}/settle`, admin.token, {
      outcome: "refund_full",
      note: "The shop couldn't show it was delivered",
    });
    expect(settled.json().data).toMatchObject({
      status: "refunded",
      refunded: 360_500,
      refundable: 0,
      price: { payoutLeft: 0 },
      refunds: [{ kind: "full", amount: 360_500, status: "done" }],
      problem: { status: "resolved", resolution: { outcome: "refunded", amount: 360_500 } },
    });
    const vendorEntries = await stack.db.ledgerEntries.find({ accountId: `vendor:${owner.userId.toHexString()}` }).toArray();
    expect(vendorEntries.reduce((s, e) => s + e.signedPaise, 0)).toBe(0);
    expect((await call("GET", "/vendor/orders?view=past", owner.token)).json().data.map((o: { id: string }) => o.id)).toEqual([order.id]);
    expect((await sweep()).json()).toMatchObject({ checked: 0 });

    const late = await inHand("delivered");
    await age(late.order.id, { deliveredAt: 49 });
    const closed = await call("POST", `/pod/orders/${late.order.id}/problem`, late.customer.token, { kind: "damaged", note: "Torn" });
    expect(closed.json().error.code).toBe("REPORT_CLOSED");
  });

  it("lets the Ruxstar team release a delivered order's share early with a reason, once any problem is settled", async () => {
    const { owner, order } = await inHand("delivered");
    const viewer = await signIn(stack, { ruxstarStaff: true });
    await stack.db.ruxstarStaff.insertOne({
      _id: new ObjectId(),
      userId: viewer.userId,
      title: "Payments",
      modules: [],
      permissions: ["payouts.view"],
      grantedBy: viewer.userId,
      status: "active",
      ...stamp(),
    });
    const held = (await call("GET", "/ruxstar/held-orders", viewer.token)).json().data;
    expect(held).toEqual([
      expect.objectContaining({ id: order.id, orderNo: order.orderNo, amount: 324_000, vendor: { id: owner.userId.toHexString(), name: "Asha Rao" }, problemOpen: false }),
    ]);
    expect(held[0].business).toMatchObject({ name: "Rao Prints" });
    expect((await call("GET", `/ruxstar/held-orders?orderNo=${order.orderNo + 1}`, viewer.token)).json().data).toEqual([]);
    const release = (token: string, reason = "The customer confirmed they got it") =>
      call("POST", `/ruxstar/held-orders/${order.id}/release`, token, { reason });
    expect((await release(viewer.token)).statusCode).toBe(403);
    expect((await release(owner.token)).statusCode).toBe(403);

    const admin = await signIn(stack, { admin: true });
    expect((await release(admin.token, "ok")).statusCode).toBe(400);
    const done = await release(admin.token);
    expect(done.statusCode).toBe(200);
    expect(done.json().data).toMatchObject({ id: order.id, amount: 324_000, releasedAt: expect.any(String) });
    expect((await call("GET", "/vendor/payments", owner.token)).json().data.balance).toMatchObject({ available: 324_000, pending: 0 });
    expect((await release(admin.token)).json().error.code).toBe("ORDER_STATE");
    expect((await call("GET", "/ruxstar/held-orders", admin.token)).json().data).toEqual([]);
    const audit = await stack.db.auditLogs.findOne({ action: "pod_order.release", "target.id": new ObjectId(order.id) });
    expect(audit?.diff.reason).toEqual({ from: null, to: "The customer confirmed they got it" });
    expect(await stack.db.notifications.findOne({ userId: owner.userId, title: "₹3,240 available", body: { $regex: "early" } })).not.toBeNull();
    const entries = await stack.db.ledgerEntries.find({}).toArray();
    expect(entries.reduce((s, e) => s + e.signedPaise, 0)).toBe(0);

    const second = await inHand("delivered");
    await call("POST", `/pod/orders/${second.order.id}/problem`, second.customer.token, { kind: "damaged", note: "The print is torn" });
    expect((await call("GET", "/ruxstar/held-orders", admin.token)).json().data).toEqual([expect.objectContaining({ id: second.order.id, problemOpen: true })]);
    const blocked = await call("POST", `/ruxstar/held-orders/${second.order.id}/release`, admin.token, { reason: "The vendor asked for it" });
    expect(blocked.json().error).toMatchObject({ code: "ORDER_STATE", message: "Settle the problem the customer reported first." });
  });

  it("lets the Ruxstar team set the platform fee", async () => {
    const admin = await signIn(stack, { admin: true });
    const res = await call("PATCH", "/ruxstar/modules/pod", admin.token, { platformFee: 1_000 });
    expect(res.json().data).toMatchObject({ module: "pod", platformFee: 1_000 });
    expect((await call("PATCH", "/ruxstar/modules/pod", admin.token, { platformFee: 60_000 })).statusCode).toBe(400);
  });
});
