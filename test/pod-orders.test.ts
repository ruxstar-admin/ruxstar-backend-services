import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakeGateway } from "../src/adapters/payments.js";
import { stamp } from "../src/platform/db.js";
import { forgetModuleState } from "../src/platform/module-switch.js";
import { signIn, startStack, web, type Stack } from "./helpers.js";

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

  it("takes payment, then the shop accepts, prints and delivers, and its share becomes available", async () => {
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

    let balance = (await call("GET", "/vendor/payments", owner.token)).json().data.balance;
    expect(balance).toMatchObject({ available: 0, pending: 324_000 });

    const file = listed[0].files[0];
    const link = (await call("GET", `/vendor/orders/${order.id}/files/${file.id}`, owner.token)).json().data;
    const href = new URL(link.url);
    const download = await stack.app.inject({ method: "GET", url: href.pathname + href.search });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("application/pdf");
    expect(download.rawPayload.equals(pdf3)).toBe(true);
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

    balance = (await call("GET", "/vendor/payments", owner.token)).json().data.balance;
    expect(balance).toMatchObject({ available: 324_000, pending: 0 });
    const entries = await stack.db.ledgerEntries.find({}).toArray();
    expect(entries.reduce((sum, e) => sum + e.signedPaise, 0)).toBe(0);
    const ruxstar = entries.filter((e) => e.accountId === "ruxstar" && e.bucket === "withdrawable").reduce((s, e) => s + e.signedPaise, 0);
    expect(ruxstar).toBe(36_500);
    expect(stack.printFiles.expiring.size).toBe(1);
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
    expect(res.json().data).toMatchObject({ status: "rejected", reason: "Out of XXL white shirts", refund: { amount: 360_500, status: "done" } });
    expect([...gateway().refunds.values()]).toContainEqual({ orderId: `rx_${order.id}`, amount: 360_500 });

    const balance = (await call("GET", "/vendor/payments", owner.token)).json().data.balance;
    expect(balance).toMatchObject({ available: 0, pending: 0 });
    const vendorEntries = await stack.db.ledgerEntries.find({ accountId: `vendor:${owner.userId.toHexString()}` }).toArray();
    expect(vendorEntries.reduce((s, e) => s + e.signedPaise, 0)).toBe(0);
    const told = await stack.db.notifications.findOne({ userId: customer.userId, type: "order.updated" });
    expect(told?.body).toContain("Out of XXL white shirts");
  });

  it("lets the customer cancel before the shop accepts: unpaid is closed at the gateway, paid is refunded", async () => {
    const owner = await vendor();
    const shopId = await teeShop(owner);
    const customer = await signIn(stack);

    const unpaid = await placed(customer, shopId);
    const cancelled = await call("POST", `/pod/orders/${unpaid.order.id}/cancel`, customer.token);
    expect(cancelled.json().data).toMatchObject({ status: "cancelled", refund: null });
    expect(gateway().orders.get(`rx_${unpaid.order.id}`)?.status).toBe("terminated");

    const paid = await placed(customer, shopId);
    await pay(paid.checkoutUrl);
    const refunded = await call("POST", `/pod/orders/${paid.order.id}/cancel`, customer.token);
    expect(refunded.json().data).toMatchObject({ status: "cancelled", refund: { status: "done" } });
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
    expect((await order({}, owner.token)).json().error.code).toBe("ORDER_INVALID");
    const other = await signIn(stack);
    expect((await order({}, other.token)).json().error.details[0].path).toBe("body/fileIds/0");

    await call("POST", `/vendor/businesses/${shopId}/close`, owner.token);
    expect((await order({})).json().error.code).toBe("SHOP_CLOSED");
    await call("POST", `/vendor/businesses/${shopId}/open`, owner.token);

    expect((await order({})).statusCode).toBe(201);
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

  it("lets the Ruxstar team set the platform fee", async () => {
    const admin = await signIn(stack, { admin: true });
    const res = await call("PATCH", "/ruxstar/modules/pod", admin.token, { platformFee: 1_000 });
    expect(res.json().data).toMatchObject({ module: "pod", platformFee: 1_000 });
    expect((await call("PATCH", "/ruxstar/modules/pod", admin.token, { platformFee: 60_000 })).statusCode).toBe(400);
  });
});
