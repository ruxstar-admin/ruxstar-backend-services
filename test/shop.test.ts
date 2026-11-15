import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RIDER_RATE, rateFor, roadKm } from "../src/modules/delivery/rates.js";
import { DEFAULT_SHOP_RULES, releaseAtOf, returnSplit } from "../src/modules/shop/rules.js";
import { stamp } from "../src/platform/db.js";
import { forgetModuleState } from "../src/platform/module-switch.js";
import { JOB_TOKEN, signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>> & { username: string };
const BACK = "https://ruxstar.com/shop";
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const SHOP_POINT = { lat: 17.4486, lng: 78.3908 };
const DROP_POINT = { lat: 17.48, lng: 78.42 };
const ADDRESS = { name: "Ravi Kumar", phone: "9876501234", line: "Flat 302, Green Towers, Kondapur", city: "Hyderabad", pincode: "500084", point: DROP_POINT };
const DROP = { line: ADDRESS.line, city: ADDRESS.city, pincode: ADDRESS.pincode, point: DROP_POINT };
const FEE = { base: 2000, includedKm: 2, perKm: 1000 };
const DELIVERY = rateFor(FEE, roadKm(SHOP_POINT, DROP_POINT));

describe("shop money and timing", () => {
  it("releases the shop's money at the later of the return window's end and 48 hours after delivery", () => {
    const at = new Date("2026-12-01T10:00:00Z");
    expect(releaseAtOf({ returnRule: { days: 2 } }, at, DEFAULT_SHOP_RULES).getTime() - at.getTime()).toBe(48 * HOUR);
    expect(releaseAtOf({ returnRule: { days: 3 } }, at, DEFAULT_SHOP_RULES).getTime() - at.getTime()).toBe(3 * DAY);
    expect(releaseAtOf({ returnRule: null }, at, DEFAULT_SHOP_RULES).getTime() - at.getTime()).toBe(48 * HOUR);
    expect(releaseAtOf({ returnRule: { days: 1 } }, at, { releaseHours: 72 }).getTime() - at.getTime()).toBe(72 * HOUR);
  });

  it("takes one delivery fee off a return the customer pays the trip for, and none when the shop sent the wrong item", () => {
    const line = { id: new ObjectId(), unitPrice: 50_000, quantity: 2 };
    const o = {
      method: "delivery" as const,
      lines: [line] as never,
      price: { items: 100_000, delivery: 4000, deliveryKm: 4, platformFee: 500, discount: 0, coupon: null, total: 104_500, commissionBps: 1000, commission: 10_000 },
    };
    expect(returnSplit(o, [{ lineId: line.id, quantity: 1 }], "customer")).toEqual({ value: 50_000, tripFee: 4000, amount: 46_000, vendor: 41_000, ruxstar: 5000 });
    expect(returnSplit(o, [{ lineId: line.id, quantity: 2 }], "shop")).toEqual({ value: 100_000, tripFee: 0, amount: 100_000, vendor: 90_000, ruxstar: 10_000 });
    expect(returnSplit({ ...o, method: "pickup" }, [{ lineId: line.id, quantity: 1 }], "customer").tripFee).toBe(0);
  });
});

describe("shop", () => {
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
      stack.db.shopProducts.deleteMany({}),
      stack.db.shopOrders.deleteMany({}),
      stack.db.shopBanned.deleteMany({}),
      stack.db.coupons.deleteMany({}),
      stack.db.couponRedemptions.deleteMany({}),
      stack.db.employments.deleteMany({}),
      stack.db.ledgerEntries.deleteMany({}),
      stack.db.invoices.deleteMany({}),
      stack.db.reviews.deleteMany({}),
      stack.db.notifications.deleteMany({}),
      stack.db.auditLogs.deleteMany({}),
      stack.db.deliveryJobs.deleteMany({}),
      stack.db.riderStates.deleteMany({}),
      stack.db.kycCases.deleteMany({}),
    ]);
    await stack.db.moduleSettings.updateOne(
      { module: "shop" },
      { $set: { live: true, signupsOpen: true, commissionBps: 1000, platformFee: 500, deliveryEnabled: true }, $unset: { shopRules: "", gstinRequired: "" } },
      { upsert: true },
    );
    await stack.db.moduleSettings.updateOne({ module: "delivery" }, { $set: { live: true }, $unset: { riderRate: "", shopFeeMax: "", offerMinutes: "" } }, { upsert: true });
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
  const putPhoto = (url: string, token: string) => stack.app.inject({ method: "PUT", url: `/v1${url}`, headers: web(token, { "content-type": "image/jpeg" }), payload: photo });

  let n = 0;
  async function person(opts: { vendor?: boolean; name?: string } = {}): Promise<User> {
    const user = await signIn(stack, opts.vendor ? { vendor: true } : {});
    const username = `buyer${Date.now() % 1e6}${n++}`;
    await stack.db.users.updateOne({ _id: user.userId }, { $set: { name: opts.name ?? "Kiran Das", username, "kyc.base": "approved" } });
    return { ...user, username };
  }
  const vendor = () => person({ vendor: true, name: "Asha Rao" });

  /** A live clothing shop in Hyderabad, pinned on the map, delivering for FEE and taking returns unless told otherwise. */
  async function store(owner: User, setup: object = {}, name = "Asha Fashions") {
    const created = await call("POST", "/vendor/businesses", owner.token, {
      module: "shop",
      type: "clothing",
      name,
      phone: "9876543210",
      location: { state: "Telangana", city: "Hyderabad", doorNo: "4-1", street: "Main Road", area: "Madhapur", pincode: "500081" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id as string;
    await stack.app.inject({ method: "POST", url: `/v1/vendor/businesses/${id}/photos`, headers: web(owner.token, { "content-type": "image/jpeg" }), payload: photo });
    expect((await call("POST", `/vendor/businesses/${id}/publish`, owner.token)).statusCode).toBe(200);
    await stack.db.businesses.updateOne({ _id: new ObjectId(id) }, { $set: { "location.point": SHOP_POINT } });
    const set = await call("PUT", `/vendor/businesses/${id}/shop`, owner.token, { delivery: true, pickup: true, deliveryFee: FEE, returns: true, ...setup });
    expect(set.statusCode).toBe(200);
    return id;
  }

  const teeBody = (extra: object = {}) => ({
    title: "Cotton T-shirt",
    description: "Soft combed cotton, regular fit.",
    options: [
      { name: "Size", values: ["S", "M"] },
      { name: "Colour", values: ["Red", "Blue"] },
    ],
    variants: [
      { values: ["S", "Red"], price: 49_900, mrp: 79_900, stock: 5, sku: "TEE-S-RED" },
      { values: ["S", "Blue"], price: 49_900, mrp: 79_900, stock: 5, sku: "TEE-S-BLU" },
      { values: ["M", "Red"], price: 54_900, mrp: 79_900, stock: 1, sku: "TEE-M-RED" },
    ],
    ...extra,
  });
  interface Product {
    id: string;
    variants: { id: string; values: string[]; price: number; stock: number }[];
  }
  async function tee(owner: User, bizId: string, extra: object = {}): Promise<Product> {
    const res = await call("POST", `/vendor/businesses/${bizId}/products`, owner.token, teeBody(extra));
    expect(res.statusCode).toBe(201);
    return res.json().data;
  }
  const variant = (p: Product, ...values: string[]) => p.variants.find((v) => v.values.join("/") === values.join("/"))!;
  const stockOf = async (p: Product, ...values: string[]) => {
    const doc = await stack.db.shopProducts.findOne({ _id: new ObjectId(p.id) });
    return doc!.variants.find((v) => v.id.toHexString() === variant(p, ...values).id)!.stock;
  };

  const place = (customer: User, bizId: string, body: object) => call("POST", `/shop/${bizId}/orders`, customer.token, { returnTo: BACK, method: "delivery", address: ADDRESS, ...body });
  /** Presses the checkout page's test button, as a browser would. */
  async function pay(checkoutUrl: string) {
    const url = new URL(checkoutUrl);
    return (await stack.app.inject({ method: "POST", url: `${url.pathname}/test${url.search}` })).json() as { status: string };
  }
  async function paid(customer: User, bizId: string, body: object) {
    const res = await place(customer, bizId, body);
    expect(res.statusCode).toBe(201);
    expect(await pay(res.json().data.checkoutUrl)).toEqual({ status: "paid" });
    return res.json().data.order as { id: string; orderNo: number; price: { items: number; delivery: number; total: number }; lines: { id: string }[] };
  }
  const move = (u: User, orderId: string, status: string) => call("POST", `/shop/desk/orders/${orderId}/move`, u.token, { status });
  async function moveAll(u: User, orderId: string, steps: string[]) {
    for (const s of steps) {
      const res = await move(u, orderId, s);
      expect(res.statusCode, `${s}: ${res.body}`).toBe(200);
    }
  }
  const orderDoc = async (id: string) => (await stack.db.shopOrders.findOne({ _id: new ObjectId(id) }))!;
  const invoicesOf = (id: string) => stack.db.invoices.find({ "source.id": new ObjectId(id) }).sort({ issuedAt: 1, _id: 1 }).toArray();
  const balanceOf = async (owner: User) =>
    (await stack.db.ledgerEntries.find({ accountId: `vendor:${owner.userId.toHexString()}` }).toArray()).reduce(
      (sum, e) => ({ ...sum, [e.bucket]: (sum[e.bucket] ?? 0) + e.signedPaise }),
      {} as Record<string, number>,
    );

  it("keeps a price, MRP, stock and SKU per combination, with stable variant ids across edits", async () => {
    const owner = await vendor();
    const bizId = await store(owner);
    const p = await tee(owner, bizId);
    expect(p).toMatchObject({ title: "Cotton T-shirt", priceFrom: 49_900, mrpFrom: 79_900, inStock: true, status: "live", photo: null });
    expect(p.variants.map((v) => [v.values.join("/"), v.price, v.stock])).toEqual([
      ["S/Red", 49_900, 5],
      ["S/Blue", 49_900, 5],
      ["M/Red", 54_900, 1],
    ]);

    const bad = async (body: object) => (await call("POST", `/vendor/businesses/${bizId}/products`, owner.token, teeBody(body))).json().error;
    expect((await bad({ variants: [{ values: ["L", "Red"], price: 49_900, stock: 1 }] })).message).toBe("L isn't one of the Size values.");
    expect((await bad({ variants: [{ values: ["S", "Red"], price: 49_900, stock: 1 }, { values: ["s", "red"], price: 1000, stock: 1 }] })).message).toBe("S, Red is in the table twice.");
    expect((await bad({ variants: [{ values: ["S", "Red"], price: 49_900, mrp: 40_000, stock: 1 }] })).message).toBe("The MRP can't be less than the price.");
    expect((await bad({ variants: [{ values: ["S"], price: 49_900, stock: 1 }] })).message).toBe("Give a Size and Colour for each variant.");
    expect((await bad({ options: [], variants: [{ price: 1000, stock: 1 }, { price: 2000, stock: 1 }] })).message).toBe("A product without options has one variant: its price and stock.");

    await stack.db.moduleSettings.updateOne({ module: "shop" }, { $set: { shopRules: { ...DEFAULT_SHOP_RULES, maxOptions: 1 } } });
    expect((await bad({})).message).toBe("A product can have one option, such as size.");
    await stack.db.moduleSettings.updateOne({ module: "shop" }, { $unset: { shopRules: "" } });

    const edited = await call("PATCH", `/vendor/products/${p.id}`, owner.token, {
      variants: [
        { values: ["S", "Red"], price: 44_900, mrp: 79_900, stock: 7, sku: "TEE-S-RED" },
        { values: ["M", "Blue"], price: 54_900, stock: 2 },
      ],
      options: [
        { name: "Size", values: ["S", "M"] },
        { name: "Colour", values: ["Red", "Blue"] },
      ],
    });
    expect(edited.statusCode).toBe(200);
    const after = edited.json().data as Product;
    expect(variant(after, "S", "Red").id).toBe(variant(p, "S", "Red").id);
    expect(variant(after, "M", "Blue").id).not.toBe(variant(p, "M", "Red").id);
    expect(after).toMatchObject({ priceFrom: 44_900 });

    const stock = await call("PUT", `/shop/desk/products/${p.id}/stock`, owner.token, { variants: [{ variantId: variant(after, "S", "Red").id, stock: 0 }, { variantId: variant(after, "M", "Blue").id, stock: 0 }] });
    expect(stock.json().data).toMatchObject({ inStock: false });
    expect((await anon(`/shop/products/${p.id}`)).json().data).toMatchObject({ inStock: false, canOrder: false, whyNot: "Sold out." });
    expect(await stack.db.auditLogs.countDocuments({ action: { $in: ["shop_product.create", "shop_product.update", "shop_product.stock"] } })).toBe(3);

    const pic = await putPhoto(`/vendor/products/${p.id}/photo`, owner.token);
    expect(pic.statusCode).toBe(200);
    expect(pic.json().data.photo.url).toContain("shop-media/");
  }, 60_000);

  it("refuses banned words in a product with a clear message, from a list Ruxstar keeps and audits", async () => {
    const owner = await vendor();
    const bizId = await store(owner);
    const refused = await call("POST", `/vendor/businesses/${bizId}/products`, owner.token, teeBody({ title: "Cigarette case, leather" }));
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatchObject({
      code: "VALIDATION_FAILED",
      message: 'Tobacco and vapes can\'t be sold on Ruxstar ("cigarette"). Remove it, or contact support if this is a mistake.',
      details: [{ path: "body/title" }],
    });
    expect((await call("POST", `/vendor/businesses/${bizId}/products`, owner.token, teeBody({ title: "Cigarettes-free kurta" }))).statusCode).toBe(400);
    expect((await call("POST", `/vendor/businesses/${bizId}/products`, owner.token, teeBody({ title: "Beerus cosplay hoodie" }))).statusCode).toBe(201);

    const list = (await call("GET", "/ruxstar/shop/banned", admin.token)).json().data;
    expect(list.map((b: { key: string }) => b.key)).toContain("tobacco");
    const made = await call("POST", "/ruxstar/shop/banned", admin.token, { key: "fireworks", name: "Fireworks", words: ["Firecracker", "firecrackers"] });
    expect(made.statusCode).toBe(201);
    expect(made.json().data.words).toEqual(["firecracker", "firecrackers"]);
    const diwali = teeBody({ title: "Diwali gift box", description: "Sweets and a FIRECRACKER pack." });
    const no = await call("POST", `/vendor/businesses/${bizId}/products`, owner.token, diwali);
    expect(no.json().error).toMatchObject({ message: expect.stringContaining("Fireworks can't be sold on Ruxstar"), details: [{ path: "body/description" }] });
    expect((await call("PATCH", "/ruxstar/shop/banned/fireworks", admin.token, { active: false })).json().data.active).toBe(false);
    expect((await call("POST", `/vendor/businesses/${bizId}/products`, owner.token, diwali)).statusCode).toBe(201);
    expect(await stack.db.auditLogs.countDocuments({ action: { $in: ["shop_banned.create", "shop_banned.update"] } })).toBe(2);
    const user = await person();
    expect((await call("POST", "/ruxstar/shop/banned", user.token, { key: "x_y", name: "Nope", words: ["nope"] })).statusCode).toBe(403);
  }, 60_000);

  it("prices a cart without holding stock, keeps an order to one shop, and takes stock only when paid", async () => {
    const owner = await vendor();
    const bizId = await store(owner);
    const p = await tee(owner, bizId);
    const other = await vendor();
    const otherId = await store(other, {}, "Bala Gifts");
    const mug = await tee(other, otherId, { title: "Photo mug", options: [], variants: [{ price: 29_900, stock: 10 }] });
    const customer = await person();
    const line = (v: { id: string }, product = p, quantity = 2) => ({ productId: product.id, variantId: v.id, quantity });

    const mixed = await call("POST", `/shop/${bizId}/quote`, customer.token, { method: "delivery", address: DROP, lines: [line(variant(p, "S", "Red")), line(mug.variants[0]!, mug, 1)] });
    expect(mixed.statusCode).toBe(422);
    expect(mixed.json().error.message).toBe("An order is from one shop. Photo mug is from Bala Gifts, so order it separately.");

    const quote = (await call("POST", `/shop/${bizId}/quote`, customer.token, { method: "delivery", address: DROP, lines: [line(variant(p, "S", "Red"))] })).json().data;
    expect(quote).toMatchObject({ items: 99_800, delivery: DELIVERY, platformFee: 500, discount: 0, total: 99_800 + DELIVERY + 500, lines: [{ title: "Cotton T-shirt", options: [{ name: "Size", value: "S" }, { name: "Colour", value: "Red" }], stock: 5 }] });
    expect(quote.returnRule).toContain("Return within 2 days of delivery");
    const pickup = (await call("POST", `/shop/${bizId}/quote`, customer.token, { method: "pickup", lines: [line(variant(p, "S", "Red"))] })).json().data;
    expect(pickup).toMatchObject({ delivery: 0, total: 99_800 + 500 });

    const tooMany = await place(customer, bizId, { lines: [line(variant(p, "M", "Red"))] });
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.json().error.message).toBe("Only 1 of Cotton T-shirt (M, Red) left.");
    expect((await place(customer, bizId, { lines: [line(variant(p, "S", "Red"))], address: { ...ADDRESS, city: "Pune" } })).json().error.message).toBe("Asha Fashions delivers in Hyderabad only.");

    const placed = await place(customer, bizId, { lines: [line(variant(p, "S", "Red"))], note: "Gift wrap please" });
    expect(placed.statusCode).toBe(201);
    const order = placed.json().data.order;
    expect(order).toMatchObject({ status: "awaiting_payment", method: "delivery", price: { items: 99_800, delivery: DELIVERY, total: 99_800 + DELIVERY + 500 }, canCancel: true });
    expect(await stockOf(p, "S", "Red")).toBe(5);

    expect(await pay(placed.json().data.checkoutUrl)).toEqual({ status: "paid" });
    expect(await stockOf(p, "S", "Red")).toBe(3);
    const view = (await call("GET", `/shop/orders/${order.id}`, customer.token)).json().data;
    expect(view).toMatchObject({ status: "paid", canCancel: true, canReturn: false, canReview: false, lines: [{ sku: "TEE-S-RED", quantity: 2, total: 99_800 }] });
    expect(view.acceptBy).not.toBeNull();
    const [sale, fee] = await invoicesOf(order.id);
    expect(sale).toMatchObject({ module: "ecommerce", source: { type: "shop_order" }, totals: { total: 99_800 + DELIVERY } });
    expect(fee).toMatchObject({ role: "fee", totals: { total: 500 } });
    expect(await balanceOf(owner)).toEqual({ pending: 99_800 + DELIVERY - 9_980 });

    const queue = (await call("GET", `/shop/desk/stores/${bizId}/orders`, owner.token)).json().data;
    expect(queue).toMatchObject([{ id: order.id, status: "paid", next: ["accepted"], customer: { name: "Kiran Das", phone: ADDRESS.phone }, note: "Gift wrap please", vendorShare: 99_800 + DELIVERY - 9_980, payout: "waiting" }]);
    expect((await call("GET", "/shop/desk/stores", owner.token)).json().data).toMatchObject([{ id: bizId, owner: true, open: 1, returns: 0 }]);
    expect(await stack.db.notifications.countDocuments({ userId: owner.userId, type: "shop.ordered" })).toBe(1);
  }, 60_000);

  it("never oversells: two payments for the last piece, and the later one is cancelled and refunded at once", async () => {
    const owner = await vendor();
    const bizId = await store(owner);
    const p = await tee(owner, bizId);
    const [a, b] = [await person({ name: "Ravi" }), await person({ name: "Meena" })];
    const lines = [{ productId: p.id, variantId: variant(p, "M", "Red").id, quantity: 1 }];
    const first = (await place(a, bizId, { lines })).json().data;
    const second = (await place(b, bizId, { lines })).json().data;
    expect(await stockOf(p, "M", "Red")).toBe(1);

    const results = await Promise.all([pay(first.checkoutUrl), pay(second.checkoutUrl)]);
    expect(results.map((r) => r.status).sort()).toEqual(["cancelled", "paid"]);
    expect(await stockOf(p, "M", "Red")).toBe(0);
    const lost = (await stack.db.shopOrders.find({ status: "cancelled" }).toArray())[0]!;
    expect(lost.payment.paidAt).not.toBeNull();
    expect(lost.cancellation!.reason).toMatch(/^Cotton T-shirt \(M, Red\) sold out while you were paying, so the order was cancelled\. /);
    expect(lost.refunds).toMatchObject([{ kind: "full", amount: lost.price.total, status: "done", by: "system" }]);
    expect((await stack.db.ledgerEntries.find({ "source.id": lost._id }).toArray()).reduce((s, e) => s + e.signedPaise, 0)).toBe(0);
    expect(await balanceOf(owner)).toEqual({ pending: 54_900 + DELIVERY - 5_490 });
    const loser = lost.customerId.equals(a.userId) ? a : b;
    expect((await call("GET", `/shop/orders/${lost._id.toHexString()}`, loser.token)).json().data).toMatchObject({ status: "cancelled", refunded: lost.price.total });
  }, 60_000);

  it("cancels before packing with a full refund, stock back and a credit note; not once packed", async () => {
    const owner = await vendor();
    const bizId = await store(owner);
    const p = await tee(owner, bizId);
    const customer = await person();
    const made = await call("POST", "/vendor/coupons", owner.token, { code: "TEE100", kind: "flat", value: 10_000, businessIds: [bizId] });
    expect(made.statusCode).toBe(201);
    expect((await stack.db.coupons.findOne({ code: "TEE100" }))!.modules).toEqual(["shop"]);
    const lines = [{ productId: p.id, variantId: variant(p, "S", "Blue").id, quantity: 2 }];
    const quoted = await call("POST", `/shop/${bizId}/quote`, customer.token, { method: "delivery", address: DROP, lines, code: "tee100" });
    expect(quoted.statusCode, quoted.body).toBe(200);
    const quote = quoted.json().data;
    expect(quote).toMatchObject({ discount: 10_000, checked: { code: "TEE100", discount: 10_000, problem: null } });
    expect(quote.offers.map((o: { code: string }) => o.code)).toContain("TEE100");

    const order = await paid(customer, bizId, { lines, coupon: "TEE100" });
    expect(order.price.total).toBe(99_800 - 10_000 + DELIVERY + 500);
    expect(await stack.db.couponRedemptions.countDocuments({})).toBe(1);
    expect(await stockOf(p, "S", "Blue")).toBe(3);
    const cancelled = (await call("POST", `/shop/orders/${order.id}/cancel`, customer.token, {})).json().data;
    expect(cancelled).toMatchObject({ status: "cancelled", refunded: order.price.total, refunds: [{ kind: "full", status: "done" }], cancellation: { by: "customer", reason: "You cancelled it." } });
    expect(await stockOf(p, "S", "Blue")).toBe(5);
    expect(await stack.db.couponRedemptions.countDocuments({})).toBe(0);
    expect((await invoicesOf(order.id)).filter((d) => d.kind === "credit_note").map((d) => d.totals.total)).toEqual([99_800 - 10_000 + DELIVERY, 500]);
    expect(await balanceOf(owner)).toEqual({ pending: 0 });

    const next = await paid(customer, bizId, { lines });
    await moveAll(owner, next.id, ["accepted", "packed"]);
    const late = await call("POST", `/shop/orders/${next.id}/cancel`, customer.token, {});
    expect(late.statusCode).toBe(409);
    expect(late.json().error.message).toContain("The shop has packed it");
    expect((await call("POST", `/shop/desk/orders/${next.id}/cancel`, owner.token, { reason: "The blue dye ran in the wash test." })).json().data).toMatchObject({ status: "cancelled", payout: "none" });
    expect(await stockOf(p, "S", "Blue")).toBe(5);
  }, 60_000);

  it("refunds a paid order the shop doesn't accept in time", async () => {
    const owner = await vendor();
    const bizId = await store(owner);
    const p = await tee(owner, bizId);
    const customer = await person();
    const order = await paid(customer, bizId, { lines: [{ productId: p.id, variantId: variant(p, "S", "Red").id, quantity: 1 }] });
    await stack.db.shopOrders.updateOne({ _id: new ObjectId(order.id) }, { $set: { acceptBy: new Date(Date.now() - 1000) } });
    expect((await sweep()).json()).toMatchObject({ shopUnaccepted: 1 });
    expect(await orderDoc(order.id)).toMatchObject({ status: "cancelled", cancellation: { by: "system", reason: "Asha Fashions didn't accept it in time." } });
    expect(await stockOf(p, "S", "Red")).toBe(5);
  }, 60_000);

  it("does pickup with no returns: ready for pickup, then picked up; returns refused; paid out 48 hours later", async () => {
    const owner = await vendor();
    const bizId = await store(owner, { delivery: false, returns: false });
    const p = await tee(owner, bizId);
    const customer = await person();
    const lines = [{ productId: p.id, variantId: variant(p, "S", "Red").id, quantity: 1 }];
    expect((await place(customer, bizId, { lines })).json().error.message).toBe("Asha Fashions doesn't deliver. Pick it up from the shop instead.");
    const order = await paid(customer, bizId, { lines, method: "pickup", address: undefined });
    expect((await move(owner, order.id, "out_for_delivery")).json().error.message).toContain("Orders go accepted, packed");
    await moveAll(owner, order.id, ["accepted", "packed"]);
    expect((await move(owner, order.id, "out_for_delivery")).json().error.message).toBe("This order is for pickup. Mark it ready for pickup.");
    await moveAll(owner, order.id, ["ready_for_pickup", "delivered"]);
    const view = (await call("GET", `/shop/orders/${order.id}`, customer.token)).json().data;
    expect(view).toMatchObject({ status: "delivered", returnRule: "No returns.", returnUntil: null, canReturn: false, canReview: true, pickupAt: { phone: "9876543210" } });
    const no = await call("POST", `/shop/orders/${order.id}/return`, customer.token, { reason: "changed_mind" });
    expect(no.statusCode).toBe(409);
    expect(no.json().error.message).toBe("This shop doesn't take returns.");

    const doc = await orderDoc(order.id);
    expect(doc.releaseAt!.getTime() - doc.deliveredAt!.getTime()).toBe(48 * HOUR);
    await sweep();
    expect((await orderDoc(order.id)).releasedAt).toBeNull();
    await stack.db.shopOrders.updateOne({ _id: doc._id }, { $set: { releaseAt: new Date(Date.now() - 1000) } });
    expect((await sweep()).json()).toMatchObject({ shopReleases: 1 });
    expect(await balanceOf(owner)).toEqual({ pending: 0, withdrawable: 49_900 - 4_990 });
    const statement = (await call("GET", "/vendor/payments/statement", owner.token)).json().data;
    expect(statement.map((l: { kind: string; module: string }) => [l.kind, l.module])).toEqual([
      ["available", "shop"],
      ["paid", "shop"],
    ]);
  }, 60_000);

  it("takes returns within 2 days: the customer pays the trip back unless the shop sent the wrong item, and the money waits for it", async () => {
    const owner = await vendor();
    const bizId = await store(owner);
    const p = await tee(owner, bizId);
    const customer = await person();
    const lines = [{ productId: p.id, variantId: variant(p, "S", "Red").id, quantity: 2 }];

    const order = await paid(customer, bizId, { lines });
    await moveAll(owner, order.id, ["accepted", "packed", "out_for_delivery", "delivered"]);
    const delivered = (await call("GET", `/shop/orders/${order.id}`, customer.token)).json().data;
    expect(delivered).toMatchObject({ status: "delivered", canReturn: true, canCancel: false });
    expect(new Date(delivered.returnUntil).getTime() - new Date(delivered.deliveredAt).getTime()).toBe(2 * DAY);

    const asked = await call("POST", `/shop/orders/${order.id}/return`, customer.token, { reason: "changed_mind", note: "Too tight", lines: [{ lineId: order.lines[0]!.id, quantity: 1 }] });
    expect(asked.statusCode).toBe(200);
    expect(asked.json().data.return).toMatchObject({ status: "requested", tripPaidBy: "customer", tripFee: DELIVERY, amount: 49_900 - DELIVERY });
    expect((await call("POST", `/shop/orders/${order.id}/return`, customer.token, { reason: "other" })).json().error.message).toBe("You've asked for a return already.");
    await stack.db.shopOrders.updateOne({ _id: new ObjectId(order.id) }, { $set: { releaseAt: new Date(Date.now() - 1000) } });
    expect((await sweep()).json()).toMatchObject({ shopReleases: 0 });
    expect((await call("GET", `/shop/desk/orders/${order.id}`, owner.token)).json().data).toMatchObject({ payout: "return" });

    expect((await call("POST", `/shop/desk/orders/${order.id}/return/decide`, owner.token, { decision: "reject" })).statusCode).toBe(400);
    expect((await call("POST", `/shop/desk/orders/${order.id}/return/decide`, owner.token, { decision: "approve" })).json().data.return.status).toBe("approved");
    const refunded = (await call("POST", `/shop/desk/orders/${order.id}/return/received`, owner.token, {})).json().data;
    expect(refunded).toMatchObject({ return: { status: "refunded" }, refunds: [{ kind: "return", amount: 49_900 - DELIVERY, status: "done" }], payout: "released" });
    expect((await invoicesOf(order.id)).filter((d) => d.kind === "credit_note").map((d) => d.totals.total)).toEqual([49_900 - DELIVERY]);
    const share = 99_800 + DELIVERY - 9_980 - (49_900 - 4_990 - DELIVERY);
    expect(await balanceOf(owner)).toEqual({ pending: 0, withdrawable: share });

    const wrong = await paid(customer, bizId, { lines });
    await moveAll(owner, wrong.id, ["accepted", "packed", "out_for_delivery", "delivered"]);
    const shopPays = (await call("POST", `/shop/orders/${wrong.id}/return`, customer.token, { reason: "wrong_item" })).json().data.return;
    expect(shopPays).toMatchObject({ tripPaidBy: "shop", tripFee: 0, amount: 99_800 });
    const ruled = await call("POST", `/ruxstar/shop/orders/${wrong.id}/return`, admin.token, { decision: "refund", note: "The shop sent a different print." });
    expect(ruled.json().data).toMatchObject({ return: { status: "refunded", decision: { by: "staff" } }, refunded: 99_800 });

    const late = await paid(customer, bizId, { lines: [{ ...lines[0]!, quantity: 1 }] });
    await moveAll(owner, late.id, ["accepted", "packed", "out_for_delivery", "delivered"]);
    await stack.db.shopOrders.updateOne({ _id: new ObjectId(late.id) }, { $set: { returnUntil: new Date(Date.now() - 1000) } });
    expect((await call("POST", `/shop/orders/${late.id}/return`, customer.token, { reason: "damaged" })).json().error.message).toBe("Returns close 2 days after delivery.");
    expect(await stack.db.auditLogs.countDocuments({ action: { $in: ["shop_order.return_request", "shop_order.return_decide", "shop_order.return_refund"] } })).toBe(5);
  }, 90_000);

  /** Delivery verified and online in Hyderabad. */
  async function partner(name: string) {
    const user = await person({ name });
    await stack.db.kycCases.insertOne({
      _id: new ObjectId(),
      userId: user.userId,
      track: "delivery",
      status: "approved",
      rejections: 0,
      steps: { licence: { number: `TS09${String(n++).padStart(11, "0")}`, photo: null, at: new Date() }, vehicle: { type: "bike", number: "TS09AB1234", photo: null, at: new Date() } },
      submittedAt: new Date(),
      review: null,
      ...stamp(),
    } as never);
    await stack.db.users.updateOne({ _id: user.userId }, { $set: { "roles.delivery": true, "kyc.delivery": "approved" } });
    expect((await call("POST", "/delivery/online", user.token, { online: true, city: "Hyderabad" })).json().data.online).toBe(true);
    return user;
  }

  it("hands a packed order to Ruxstar riders like print: offered in the city, picked up, delivered with the customer's code", async () => {
    const owner = await vendor();
    const bizId = await store(owner);
    const p = await tee(owner, bizId);
    const customer = await person();
    const rider = await partner("Suresh");
    const pay = rateFor(DEFAULT_RIDER_RATE, roadKm(SHOP_POINT, DROP_POINT));
    const order = await paid(customer, bizId, { lines: [{ productId: p.id, variantId: variant(p, "S", "Red").id, quantity: 2 }] });

    expect((await call("GET", `/shop/desk/orders/${order.id}/delivery`, owner.token)).json().data).toMatchObject({ canAssign: false, reason: "Pack the order first." });
    await moveAll(owner, order.id, ["accepted", "packed"]);
    await stack.db.moduleSettings.updateOne({ module: "shop" }, { $set: { deliveryEnabled: false } });
    expect((await call("GET", `/shop/desk/orders/${order.id}/delivery`, owner.token)).json().data.partner).toMatchObject({ available: false, reason: "Ruxstar delivery partners aren't available for local shops yet." });
    await stack.db.moduleSettings.updateOne({ module: "shop" }, { $set: { deliveryEnabled: true } });
    expect((await call("GET", `/shop/desk/orders/${order.id}/delivery`, owner.token)).json().data).toMatchObject({ canAssign: true, partner: { available: true, pay, online: 1 } });

    const offered = await call("POST", `/shop/desk/orders/${order.id}/delivery`, owner.token, { carrier: "partner" });
    expect(offered.statusCode).toBe(200);
    expect(offered.json().data.delivery).toMatchObject({ carrier: "partner", status: "offered", pay });
    const offers = (await call("GET", "/delivery/offers", rider.token)).json().data;
    expect(offers).toMatchObject([{ orderNo: order.orderNo, item: "Cotton T-shirt (S, Red) × 2", pay, shop: { name: "Asha Fashions" } }]);
    const jobId = offers[0].id as string;
    const step = (path: string, body?: object) => call("POST", `/delivery/jobs/${jobId}/${path}`, rider.token, body);
    expect((await move(owner, order.id, "out_for_delivery")).json().error.message).toBe("A rider has this delivery. Cancel it first to deliver the order yourself.");

    expect((await step("accept")).json().data.status).toBe("accepted");
    expect((await step("pickup")).json().data.status).toBe("picked_up");
    const tracking = (await call("GET", `/shop/orders/${order.id}`, customer.token)).json().data;
    expect(tracking).toMatchObject({ status: "out_for_delivery", delivery: { carrier: "partner", status: "picked_up", rider: { name: "Suresh" } } });
    const code = tracking.delivery.dropCode as string;
    expect(code).toMatch(/^\d{4}$/);
    expect((await call("POST", `/shop/desk/orders/${order.id}/cancel`, owner.token, { reason: "Changed our mind about it." })).json().error.message).toBe(
      "The rider has it already. Call them if it must come back.",
    );

    await putPhoto(`/delivery/jobs/${jobId}/photo`, rider.token);
    expect((await step("deliver", { code })).json().data.status).toBe("delivered");
    const done = await orderDoc(order.id);
    expect(done).toMatchObject({ status: "delivered", delivery: { status: "delivered" } });
    expect(done.releaseAt).not.toBeNull();
    const riderLedger = await stack.db.ledgerEntries.find({ txnId: `rider_pay:${order.id}` }).toArray();
    expect(riderLedger.map((e) => [e.accountId, e.signedPaise]).sort()).toEqual([[`rider:${rider.userId.toHexString()}`, pay], [`vendor:${owner.userId.toHexString()}`, -pay]].sort());
    expect((await call("GET", `/shop/desk/orders/${order.id}`, owner.token)).json().data).toMatchObject({ vendorShare: 99_800 + DELIVERY - 9_980 - pay, delivery: { status: "delivered", pay } });
    const earnings = (await call("GET", "/delivery/earnings", rider.token)).json().data;
    expect(earnings).toMatchObject({ balance: { pending: pay }, upcoming: [{ orderId: order.id, amount: pay }] });
    expect((await call("GET", "/vendor/payments/statement", owner.token)).json().data[0]).toMatchObject({ kind: "delivery", module: "shop", amount: -pay });
  }, 90_000);

  it("lets each product be reviewed after delivery, not before, and rates the product", async () => {
    const owner = await vendor();
    const bizId = await store(owner);
    const p = await tee(owner, bizId);
    const mug = await tee(owner, bizId, { title: "Photo mug", options: [], variants: [{ price: 29_900, stock: 10 }] });
    const customer = await person();
    const order = await paid(customer, bizId, {
      lines: [
        { productId: p.id, variantId: variant(p, "S", "Red").id, quantity: 1 },
        { productId: p.id, variantId: variant(p, "S", "Blue").id, quantity: 1 },
        { productId: mug.id, variantId: mug.variants[0]!.id, quantity: 1 },
      ],
    });
    const review = (productId: string, body: object) => call("PUT", `/shop/orders/${order.id}/products/${productId}/review`, customer.token, body);
    const early = await review(p.id, { rating: 5 });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.message).toBe("You can review what you bought once it's delivered.");

    await moveAll(owner, order.id, ["accepted", "packed", "out_for_delivery", "delivered"]);
    const view = (await call("GET", `/shop/orders/${order.id}`, customer.token)).json().data;
    expect(view.reviewable).toMatchObject([
      { productId: p.id, title: "Cotton T-shirt", canReview: true },
      { productId: mug.id, title: "Photo mug", canReview: true },
    ]);
    const written = await review(p.id, { rating: 4, text: "Good fit" });
    expect(written.json().data).toMatchObject({ rating: 4, orderId: order.id, module: "shop", listing: { type: "product", id: p.id } });
    expect((await review(mug.id, { rating: 2 })).statusCode).toBe(200);
    expect((await call("PUT", `/shop/orders/${order.id}/products/${new ObjectId().toHexString()}/review`, customer.token, { rating: 3 })).statusCode).toBe(404);

    expect((await anon(`/shop/products/${p.id}`)).json().data.rating).toEqual({ average: null, count: 1 });
    expect((await anon(`/shop/products/${p.id}/reviews`)).json().data).toMatchObject([{ rating: 4, text: "Good fit", product: "Cotton T-shirt" }]);
    expect((await anon(`/shop/${bizId}/reviews`)).json().data).toHaveLength(2);
    expect((await anon(`/shop/${bizId}`)).json().data.rating).toEqual({ average: null, count: 2 });
    expect((await call("DELETE", `/shop/orders/${order.id}/products/${mug.id}/review`, customer.token)).statusCode).toBe(200);
    expect((await anon(`/shop/${bizId}`)).json().data.rating.count).toBe(1);
  }, 60_000);

  it("shows shops and products signed out, by city, and hides them while the module is off", async () => {
    const owner = await vendor();
    const bizId = await store(owner);
    const p = await tee(owner, bizId);
    expect((await anon("/shop/rules")).json().data).toMatchObject({ returnDays: 2, maxOptions: 2, releaseHours: 48, holdMinutes: 15, commissionBps: 1000, platformFee: 500 });
    expect((await anon("/shop?city=hyderabad")).json().data).toMatchObject([{ id: bizId, name: "Asha Fashions", type: "clothing", delivery: true, pickup: true }]);
    expect((await anon("/shop?city=Pune")).json().data).toEqual([]);
    expect((await anon(`/shop/${bizId}`)).json().data).toMatchObject({ canOrder: true, returnDays: 2, setup: { deliveryFee: FEE, returns: true }, products: 1 });
    expect((await anon("/shop/products?city=Hyderabad")).json().data).toMatchObject([{ id: p.id, priceFrom: 49_900, business: { id: bizId } }]);
    expect((await anon(`/shop/products?shop=${bizId}&q=cotton`)).json().data).toHaveLength(1);
    const detail = (await anon(`/shop/products/${p.id}`)).json().data;
    expect(detail).toMatchObject({ canOrder: true, options: [{ name: "Size" }, { name: "Colour" }], delivery: true });
    expect(detail.variants).toHaveLength(3);

    await call("PATCH", `/vendor/products/${p.id}`, owner.token, { status: "hidden" });
    expect((await anon(`/shop/products/${p.id}`)).statusCode).toBe(404);
    await call("PATCH", `/vendor/products/${p.id}`, owner.token, { status: "live" });

    await stack.db.moduleSettings.updateOne({ module: "shop" }, { $set: { live: false } });
    forgetModuleState();
    expect((await anon("/shop")).json().data).toEqual([]);
    expect((await anon("/shop/products")).json().data).toEqual([]);
  }, 60_000);

  it("lets the console list shops and products, take a product down, set the rules and decide returns, all audited", async () => {
    const owner = await vendor();
    const bizId = await store(owner);
    const p = await tee(owner, bizId);
    expect((await call("GET", "/ruxstar/shop/stores", admin.token)).json().data).toMatchObject([{ id: bizId, products: 1, orders: 0, suspended: false }]);
    expect((await call("GET", `/ruxstar/shop/stores/${bizId}`, admin.token)).json().data).toMatchObject({ setup: { delivery: true }, openOrders: 0 });
    expect((await call("GET", `/ruxstar/shop/products?shop=${bizId}`, admin.token)).json().data).toHaveLength(1);

    const down = await call("POST", `/ruxstar/shop/products/${p.id}/take-down`, admin.token, { reason: "Counterfeit brand logo." });
    expect(down.json().data).toMatchObject({ status: "removed", removal: { reason: "Counterfeit brand logo." } });
    expect((await anon(`/shop/products/${p.id}`)).statusCode).toBe(404);
    expect((await call("PATCH", `/vendor/products/${p.id}`, owner.token, { title: "Cotton tee" })).json().error.message).toBe("Ruxstar took this product down, so it can't be changed.");
    expect((await call("POST", `/ruxstar/shop/products/${p.id}/take-down`, admin.token, { reason: "Counterfeit brand logo." })).statusCode).toBe(409);
    expect(await stack.db.notifications.countDocuments({ userId: owner.userId, title: "Ruxstar took down Cotton T-shirt" })).toBe(1);
    expect(await stack.db.auditLogs.countDocuments({ action: "shop_product.take_down" })).toBe(1);

    const rules = await stack.app.inject({ method: "PATCH", url: "/v1/ruxstar/modules/shop", headers: web(admin.token, { "idempotency-key": randomUUID() }), payload: { shopRules: { returnDays: 3, holdMinutes: 10 } } });
    expect(rules.statusCode).toBe(200);
    expect(rules.json().data.shopRules).toMatchObject({ returnDays: 3, holdMinutes: 10, maxOptions: 2, releaseHours: 48 });
    expect((await anon("/shop/rules")).json().data).toMatchObject({ returnDays: 3 });
    const wrong = await stack.app.inject({ method: "PATCH", url: "/v1/ruxstar/modules/events", headers: web(admin.token, { "idempotency-key": randomUUID() }), payload: { shopRules: { returnDays: 3 } } });
    expect(wrong.json().error.message).toBe("Shop rules are set on the shop module.");

    const fresh = await tee(owner, bizId, { title: "Linen shirt" });
    const customer = await person();
    const order = await paid(customer, bizId, { lines: [{ productId: fresh.id, variantId: variant(fresh, "S", "Red").id, quantity: 1 }] });
    await moveAll(owner, order.id, ["accepted", "packed", "out_for_delivery", "delivered"]);
    const doc = await orderDoc(order.id);
    expect(doc.returnUntil!.getTime() - doc.deliveredAt!.getTime()).toBe(3 * DAY);
    expect(doc.releaseAt!.getTime() - doc.deliveredAt!.getTime()).toBe(3 * DAY);
    await call("POST", `/shop/orders/${order.id}/return`, customer.token, { reason: "damaged" });
    await call("POST", `/shop/desk/orders/${order.id}/return/decide`, owner.token, { decision: "reject", note: "It left the shop in perfect shape." });
    expect((await call("GET", "/ruxstar/shop/orders?returns=rejected", admin.token)).json().data).toMatchObject([{ id: order.id, return: { status: "rejected" } }]);
    const approved = await call("POST", `/ruxstar/shop/orders/${order.id}/return`, admin.token, { decision: "approve", note: "The photos show a torn seam." });
    expect(approved.json().data.return).toMatchObject({ status: "approved", decision: { by: "staff" } });
    expect(await stack.db.auditLogs.countDocuments({ action: "shop_order.return_decide" })).toBe(2);
  }, 90_000);

  it("gives the team store permissions one by one", async () => {
    const owner = await vendor();
    const bizId = await store(owner);
    const p = await tee(owner, bizId);
    const staff = await person({ name: "Meena" });
    await stack.db.employments.insertOne({
      _id: new ObjectId(),
      businessId: new ObjectId(bizId),
      module: "shop",
      ownerId: owner.userId,
      userId: staff.userId,
      status: "active",
      current: true,
      permissions: ["store.orders", "store.stock"],
      invitedBy: owner.userId,
      invitedAt: new Date(),
      expiresAt: new Date(Date.now() + DAY),
      joinedAt: new Date(),
      endedAt: null,
      endedBy: null,
      ...stamp(),
    });
    const customer = await person();
    const order = await paid(customer, bizId, { lines: [{ productId: p.id, variantId: variant(p, "S", "Red").id, quantity: 1 }] });
    expect((await call("GET", "/shop/desk/stores", staff.token)).json().data).toMatchObject([{ id: bizId, owner: false, permissions: ["store.orders", "store.stock"], open: 1 }]);
    expect((await call("GET", `/shop/desk/orders/${order.id}`, staff.token)).json().data.status).toBe("paid");
    expect((await move(staff, order.id, "accepted")).statusCode).toBe(403);
    expect((await call("PUT", `/shop/desk/products/${p.id}/stock`, staff.token, { variants: [{ variantId: variant(p, "S", "Blue").id, stock: 9 }] })).statusCode).toBe(200);
    expect((await call("PATCH", `/shop/desk/products/${p.id}`, staff.token, { title: "Tee" })).statusCode).toBe(403);
    expect(await stack.db.notifications.countDocuments({ userId: staff.userId, type: "shop.ordered" })).toBe(1);
  }, 60_000);
});
