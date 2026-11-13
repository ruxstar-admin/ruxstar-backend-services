import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stamp } from "../src/platform/db.js";
import { forgetModuleState } from "../src/platform/module-switch.js";
import { signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>>;
const BACK = "https://ruxstar.com/orders";
const ADDRESS = { name: "Ravi Kumar", phone: "9876501234", line: "Flat 302, Green Towers, Madhapur", city: "Hyderabad", pincode: "500081" };
const DAY = 24 * 60 * 60_000;

describe("coupons", () => {
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
      stack.db.coupons.deleteMany({}),
      stack.db.couponRedemptions.deleteMany({}),
      stack.db.auditLogs.deleteMany({}),
    ]);
    await stack.db.moduleSettings.updateOne({ module: "pod" }, { $set: { live: true, signupsOpen: true, commissionBps: 1000, platformFee: 500 } });
    forgetModuleState();
  });

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
    return user;
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

  const choice = (shopId: string, couponCode?: string) => ({
    shopId,
    product: "tshirts",
    options: { size: "M" },
    quantity: 12,
    ...(couponCode ? { couponCode } : {}),
  });
  const quote = async (customer: User, shopId: string, couponCode?: string) =>
    (await call("POST", "/pod/quote", customer.token, { ...choice(shopId, couponCode), fileIds: [] })).json().data;

  async function order(customer: User, shopId: string, couponCode?: string) {
    const file = (
      await stack.app.inject({
        method: "POST",
        url: "/v1/pod/files",
        headers: web(customer.token, { "content-type": "application/pdf", "x-file-name": "design.pdf" }),
        payload: pdf,
      })
    ).json().data;
    return call("POST", "/pod/orders", customer.token, { ...choice(shopId, couponCode), fileIds: [file.id], address: ADDRESS, returnTo: BACK });
  }

  async function pay(checkoutUrl: string) {
    const url = new URL(checkoutUrl);
    const test = await stack.app.inject({ method: "POST", url: `${url.pathname}/test${url.search}` });
    expect(test.json()).toEqual({ status: "placed" });
  }

  async function paid(customer: User, shopId: string, couponCode?: string) {
    const res = await order(customer, shopId, couponCode);
    expect(res.statusCode).toBe(201);
    const { order: placed, checkoutUrl } = res.json().data;
    await pay(checkoutUrl);
    return placed as { id: string; orderNo: number; price: Record<string, unknown> };
  }

  async function staff(permissions: string[]) {
    const user = await signIn(stack, { ruxstarStaff: true });
    await stack.db.ruxstarStaff.insertOne({ _id: new ObjectId(), userId: user.userId, title: "Offers", modules: [], permissions, grantedBy: user.userId, status: "active", ...stamp() });
    return user;
  }

  const ledgerSum = async (accountId: string) =>
    (await stack.db.ledgerEntries.find({ accountId }).toArray()).reduce((sum, e) => sum + e.signedPaise, 0);

  it("lets the Ruxstar team make coupons, change only their dates and limits, and switch a vendor's off", async () => {
    const viewer = await staff(["coupons.view"]);
    const manager = await staff(["coupons.view", "coupons.manage"]);
    const someone = await signIn(stack);
    const welcome = { code: "welcome20", kind: "percent", value: 20, cap: 50_000 };

    expect((await call("POST", "/ruxstar/coupons", someone.token, welcome)).statusCode).toBe(403);
    expect((await call("POST", "/ruxstar/coupons", viewer.token, welcome)).statusCode).toBe(403);
    const made = await call("POST", "/ruxstar/coupons", manager.token, welcome);
    expect(made.statusCode).toBe(201);
    const coupon = made.json().data;
    expect(coupon).toMatchObject({
      code: "WELCOME20",
      fundedBy: "ruxstar",
      vendor: null,
      businesses: [],
      kind: "percent",
      value: 20,
      cap: 50_000,
      label: "20% off up to ₹500",
      perCustomer: 1,
      limit: null,
      listed: true,
      active: true,
      used: 0,
      state: "active",
    });

    const taken = await call("POST", "/ruxstar/coupons", manager.token, { ...welcome, code: "Welcome20" });
    expect(taken.json().error).toMatchObject({ code: "CONFLICT", details: [{ path: "body/code" }] });
    expect((await call("POST", "/ruxstar/coupons", manager.token, { code: "HALFOFF", kind: "percent", value: 150 })).statusCode).toBe(400);
    expect((await call("POST", "/ruxstar/coupons", manager.token, { code: "FLAT50", kind: "flat", value: 5_000, cap: 1_000 })).statusCode).toBe(400);
    const past = await call("POST", "/ruxstar/coupons", manager.token, { code: "OLDONE", kind: "flat", value: 5_000, endsAt: new Date(Date.now() - DAY).toISOString() });
    expect(past.json().error.details[0].path).toBe("body/endsAt");

    const changed = await call("PATCH", `/ruxstar/coupons/${coupon.id}`, manager.token, { limit: 100, perCustomer: 2, listed: false });
    expect(changed.json().data).toMatchObject({ limit: 100, perCustomer: 2, listed: false, value: 20 });
    expect((await call("PATCH", `/ruxstar/coupons/${coupon.id}`, manager.token, { value: 90 })).statusCode).toBe(400);
    expect((await call("PATCH", `/ruxstar/coupons/${coupon.id}`, viewer.token, { active: false })).statusCode).toBe(403);
    const audit = await stack.db.auditLogs.find({ "target.id": new ObjectId(coupon.id) }).sort({ at: 1 }).toArray();
    expect(audit.map((a) => a.action)).toEqual(["coupon.create", "coupon.update"]);
    expect(audit[1]!.diff).toMatchObject({ limit: { from: null, to: 100 }, perCustomer: { from: 1, to: 2 } });

    const owner = await vendor();
    const shopId = await teeShop(owner);
    const theirs = await call("POST", "/vendor/coupons", owner.token, { code: "RAO100", kind: "flat", value: 10_000, businessIds: [shopId] });
    expect(theirs.statusCode).toBe(201);
    const vendorCoupon = theirs.json().data;
    expect(vendorCoupon).toMatchObject({ fundedBy: "vendor", vendor: { name: "Asha Rao" }, businesses: [{ id: shopId, name: "Rao Prints" }], label: "₹100 off" });

    expect((await call("GET", "/ruxstar/coupons", viewer.token)).json().data.map((c: { code: string }) => c.code)).toEqual(["WELCOME20"]);
    expect((await call("GET", "/ruxstar/coupons?funder=vendor", viewer.token)).json().data.map((c: { code: string }) => c.code)).toEqual(["RAO100"]);
    expect((await call("GET", "/ruxstar/coupons?code=rao100", viewer.token)).json().data).toHaveLength(1);

    expect((await call("PATCH", `/ruxstar/coupons/${vendorCoupon.id}`, manager.token, { minOrder: 0 })).statusCode).toBe(403);
    const stopped = await call("PATCH", `/ruxstar/coupons/${vendorCoupon.id}`, manager.token, { active: false });
    expect(stopped.json().data).toMatchObject({ active: false, stoppedByRuxstar: true, state: "off" });
    const back = await call("PATCH", `/vendor/coupons/${vendorCoupon.id}`, owner.token, { active: true });
    expect(back.json().error.code).toBe("FORBIDDEN");
    expect((await call("PATCH", `/vendor/coupons/${vendorCoupon.id}`, owner.token, { endsAt: new Date(Date.now() + DAY).toISOString() })).statusCode).toBe(200);
    expect((await call("PATCH", `/ruxstar/coupons/${vendorCoupon.id}`, manager.token, { active: true })).json().data).toMatchObject({ active: true, stoppedByRuxstar: false });
  });

  it("takes a Ruxstar coupon off the items and Ruxstar pays for it, so the shop's share doesn't change", async () => {
    const admin = await signIn(stack, { admin: true });
    await call("POST", "/ruxstar/coupons", admin.token, { code: "WELCOME20", kind: "percent", value: 20, cap: 50_000 });
    const owner = await vendor();
    const shopId = await teeShop(owner);
    const customer = await signIn(stack);

    const plain = await quote(customer, shopId);
    expect(plain).toMatchObject({ items: 300_000, discount: 0, coupon: null, total: 300_500, couponProblem: null });
    expect(plain.offers).toEqual([
      { code: "WELCOME20", fundedBy: "ruxstar", label: "20% off up to ₹500", terms: null, discount: 50_000, problem: null },
    ]);
    const priced = await quote(customer, shopId, " welcome20 ");
    expect(priced).toMatchObject({ discount: 50_000, coupon: { code: "WELCOME20", fundedBy: "ruxstar", label: "Ruxstar offer" }, total: 250_500 });
    expect((await quote(customer, shopId, "NOSUCH")).couponProblem).toBe("There's no coupon with this code.");

    const placed = await paid(customer, shopId, "welcome20");
    expect(placed.price).toMatchObject({ items: 300_000, discount: 50_000, total: 250_500 });
    const coupon = await stack.db.coupons.findOne({ code: "WELCOME20" });
    expect(coupon?.used).toBe(1);
    expect(await stack.db.couponRedemptions.countDocuments({ couponId: coupon!._id, customerId: customer.userId })).toBe(1);

    const shopView = (await call("GET", `/vendor/orders/${placed.id}`, owner.token)).json().data;
    expect(shopView.price).toMatchObject({ discount: 50_000, coupon: { label: "Ruxstar offer" }, commission: 30_000, payout: 270_000 });
    expect(await ledgerSum(`vendor:${owner.userId.toHexString()}`)).toBe(270_000);
    expect(await ledgerSum("ruxstar")).toBe(30_000 + 500 - 50_000);
    expect(await ledgerSum("gateway")).toBe(-250_500);

    const again = await quote(customer, shopId, "WELCOME20");
    expect(again).toMatchObject({ couponProblem: "You've already used this coupon.", discount: 0, total: 300_500, offers: [] });
    const refused = await order(customer, shopId, "WELCOME20");
    expect(refused.json().error).toMatchObject({ code: "COUPON_INVALID", message: "You've already used this coupon.", details: [{ path: "body/couponCode" }] });
  });

  it("takes a vendor's coupon out of the shop's share with commission on the lower price, and gives the use back on a full refund", async () => {
    const owner = await vendor();
    const shopId = await teeShop(owner);
    const other = await vendor();
    const otherShop = await teeShop(other);
    const notMine = await call("POST", "/vendor/coupons", owner.token, { code: "RAO100", kind: "flat", value: 10_000, businessIds: [otherShop] });
    expect(notMine.json().error.details[0].path).toBe("body/businessIds/0");
    const made = await call("POST", "/vendor/coupons", owner.token, { code: "RAO100", kind: "flat", value: 10_000, minOrder: 400_000, businessIds: [shopId] });
    expect(made.statusCode).toBe(201);
    const id = made.json().data.id as string;
    expect((await call("GET", "/vendor/coupons", owner.token)).json().data).toHaveLength(1);
    expect((await call("GET", "/vendor/coupons", other.token)).json().data).toEqual([]);
    expect((await call("PATCH", `/vendor/coupons/${id}`, other.token, { minOrder: 0 })).statusCode).toBe(404);

    const customer = await signIn(stack);
    const short = await quote(customer, shopId);
    expect(short.offers).toEqual([
      { code: "RAO100", fundedBy: "vendor", label: "₹100 off", terms: "On items of ₹4,000 or more", discount: 0, problem: "Add ₹1,000 more to use this." },
    ]);
    expect((await quote(customer, otherShop)).offers).toEqual([]);
    expect((await quote(customer, otherShop, "RAO100")).couponProblem).toBe("This coupon doesn't work at Rao Prints.");

    await call("PATCH", `/vendor/coupons/${id}`, owner.token, { minOrder: 0 });
    const placed = await paid(customer, shopId, "rao100");
    expect(placed.price).toMatchObject({ discount: 10_000, coupon: { label: "Shop offer" }, total: 290_500 });
    const shopView = (await call("GET", `/vendor/orders/${placed.id}`, owner.token)).json().data;
    expect(shopView.price).toMatchObject({ commission: 29_000, payout: 261_000 });
    expect(await ledgerSum(`vendor:${owner.userId.toHexString()}`)).toBe(261_000);
    expect(await ledgerSum("ruxstar")).toBe(29_500);
    expect((await stack.db.coupons.findOne({ code: "RAO100" }))?.used).toBe(1);
    expect((await quote(customer, shopId, "RAO100")).couponProblem).toBe("You've already used this coupon.");

    const cancelled = await call("POST", `/pod/orders/${placed.id}/cancel`, customer.token);
    expect(cancelled.json().data.status).toBe("cancelled");
    expect((await stack.db.coupons.findOne({ code: "RAO100" }))?.used).toBe(0);
    expect(await stack.db.couponRedemptions.countDocuments({})).toBe(0);
    expect((await quote(customer, shopId, "RAO100")).couponProblem).toBeNull();
    const entries = await stack.db.ledgerEntries.find({}).toArray();
    expect(entries.reduce((sum, e) => sum + e.signedPaise, 0)).toBe(0);
    expect(await ledgerSum(`vendor:${owner.userId.toHexString()}`)).toBe(0);
  });

  it("holds to its dates, its total uses, first orders only, and keeps unlisted coupons out of the offers", async () => {
    const admin = await signIn(stack, { admin: true });
    const owner = await vendor();
    const shopId = await teeShop(owner);
    const first = await signIn(stack);
    const second = await signIn(stack);
    const make = (body: object) => call("POST", "/ruxstar/coupons", admin.token, { kind: "flat", value: 5_000, ...body });

    await make({ code: "LATER", startsAt: new Date(Date.now() + 2 * DAY).toISOString() });
    expect((await quote(first, shopId, "LATER")).couponProblem).toMatch(/^This coupon starts on /);

    await make({ code: "ONEUSE", limit: 1 });
    await paid(first, shopId, "ONEUSE");
    const usedUp = await quote(second, shopId, "ONEUSE");
    expect(usedUp.couponProblem).toBe("This coupon has been used up.");
    expect(usedUp.offers.map((o: { code: string }) => o.code)).not.toContain("ONEUSE");

    await make({ code: "FIRSTONLY", firstOrderOnly: true });
    expect((await quote(first, shopId, "FIRSTONLY")).couponProblem).toBe("This coupon is for your first order.");
    expect((await quote(second, shopId, "FIRSTONLY")).couponProblem).toBeNull();

    await make({ code: "SECRET", listed: false });
    const offers = (await quote(second, shopId)).offers.map((o: { code: string }) => o.code);
    expect(offers).toContain("FIRSTONLY");
    expect(offers).not.toContain("SECRET");
    expect((await quote(second, shopId, "SECRET")).discount).toBe(5_000);

    const off = (await stack.db.coupons.findOne({ code: "SECRET" }))!;
    await call("PATCH", `/ruxstar/coupons/${off._id.toHexString()}`, admin.token, { active: false });
    expect((await quote(second, shopId, "SECRET")).couponProblem).toBe("This coupon is switched off.");
  });
});
