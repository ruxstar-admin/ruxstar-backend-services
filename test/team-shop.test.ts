import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { forgetModuleState } from "../src/platform/module-switch.js";
import { signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>>;

describe("team shop actions", () => {
  let stack: Stack;
  let photo: Buffer;

  beforeAll(async () => {
    stack = await startStack();
    photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#8a6a40" } }).jpeg().toBuffer();
  });
  afterAll(() => stack?.stop());
  beforeEach(async () => {
    await Promise.all([
      stack.db.businesses.deleteMany({}),
      stack.db.employments.deleteMany({}),
      stack.db.coupons.deleteMany({}),
      stack.db.posts.deleteMany({}),
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
  const upload = (url: string, token: string) =>
    stack.app.inject({ method: "POST", url: `/v1${url}`, headers: web(token, { "content-type": "image/jpeg" }), payload: photo });

  let n = 0;
  async function person(opts: { vendor?: boolean; verified?: boolean } = {}) {
    const user = await signIn(stack, opts.vendor ? { vendor: true } : {});
    const username = `crew${Date.now() % 1e6}${n++}`;
    await stack.db.users.updateOne({ _id: user.userId }, { $set: { name: "Kiran Das", username, ...(opts.verified ? { "kyc.base": "approved" } : {}) } });
    return { ...user, username };
  }

  async function teeShop(owner: User, name = "Rao Prints") {
    const created = await call("POST", "/vendor/businesses", owner.token, {
      module: "pod",
      type: "print_shop",
      name,
      phone: "9876543210",
      location: { state: "Telangana", city: "Hyderabad", doorNo: "4-1", street: "Main Road", area: "Madhapur", pincode: "500081" },
    });
    const id = created.json().data.id as string;
    await upload(`/vendor/businesses/${id}/photos`, owner.token);
    await call("PATCH", `/vendor/businesses/${id}/pod`, owner.token, {
      products: ["tshirts"],
      cities: ["Hyderabad"],
      prices: [{ product: "tshirts", basePrice: 30_000, tiers: [{ from: 10, unitPrice: 25_000 }] }],
    });
    expect((await call("POST", `/vendor/businesses/${id}/publish`, owner.token)).statusCode).toBe(200);
    return id;
  }

  async function hire(owner: User, shopId: string, who: { token: string; username: string }, permissions: string[]) {
    const placeId = (await call("POST", `/vendor/businesses/${shopId}/team`, owner.token, { username: who.username, permissions })).json().data.id as string;
    expect((await call("POST", `/employment/${placeId}/accept`, who.token)).statusCode).toBe(200);
    return placeId;
  }

  const actions = async (shopId: string) =>
    (await stack.db.auditLogs.find({ "scope.businessId": { $exists: true } }).sort({ createdAt: 1 }).toArray())
      .filter((l) => l.scope.businessId!.toHexString() === shopId)
      .map((l) => [l.action, l.actor.id?.toHexString()]);

  it("opens, closes and edits the shop only with each permission, logged as whoever did it", async () => {
    const owner = await person({ vendor: true, verified: true });
    const shopId = await teeShop(owner);
    const opener = await person({ verified: true });
    const editor = await person({ verified: true });
    const pricer = await person({ verified: true });
    const poster = await person({ verified: true });
    const openerAt = await hire(owner, shopId, opener, ["shop.open"]);
    const editorAt = await hire(owner, shopId, editor, ["shop.details"]);
    const pricerAt = await hire(owner, shopId, pricer, ["shop.catalog"]);
    const posterAt = await hire(owner, shopId, poster, ["posts.create"]);
    await stack.db.auditLogs.deleteMany({});

    expect((await call("GET", `/employment/${openerAt}/shop`, opener.token)).json().data).toMatchObject({ id: shopId, open: true });
    expect((await call("GET", `/employment/${posterAt}/shop`, poster.token)).statusCode).toBe(403);
    expect((await call("POST", `/employment/${editorAt}/shop/close`, editor.token)).statusCode).toBe(403);
    expect((await call("POST", `/employment/${openerAt}/shop/close`, opener.token)).json().data.open).toBe(false);
    expect((await call("POST", `/employment/${openerAt}/shop/open`, opener.token)).json().data.open).toBe(true);

    expect((await call("PATCH", `/employment/${pricerAt}/shop`, pricer.token, { name: "Rao Print House" })).statusCode).toBe(403);
    const renamed = await call("PATCH", `/employment/${editorAt}/shop`, editor.token, { name: "Rao Print House", description: "Shirts and mugs" });
    expect(renamed.json().data).toMatchObject({ name: "Rao Print House", description: "Shirts and mugs" });
    expect((await call("PATCH", `/employment/${editorAt}/shop`, editor.token, { gstin: "36AABCU9603R1ZM" })).statusCode).toBe(400);
    const added = await upload(`/employment/${editorAt}/shop/photos`, editor.token);
    expect(added.statusCode).toBe(201);
    const photos = added.json().data.photos as { id: string }[];
    expect(photos).toHaveLength(2);
    expect((await call("DELETE", `/employment/${editorAt}/shop/photos/${photos[1]!.id}`, editor.token)).json().data.photos).toHaveLength(1);
    expect((await call("DELETE", `/employment/${editorAt}/shop/photos/${photos[0]!.id}`, editor.token)).json().error.code).toBe("BUSINESS_INCOMPLETE");

    expect((await call("PATCH", `/employment/${editorAt}/shop/pod`, editor.token, { turnaroundDays: 5 })).statusCode).toBe(403);
    expect((await call("PATCH", `/employment/${pricerAt}/shop/pod`, pricer.token, { turnaroundDays: 5 })).json().data.pod.turnaroundDays).toBe(5);
    expect((await call("PATCH", `/employment/${pricerAt}/shop/pod`, pricer.token, { products: [] })).json().error.code).toBe("BUSINESS_INCOMPLETE");

    await call("PATCH", `/vendor/businesses/${shopId}`, owner.token, { phone: "9876500000" });
    const [o, e, p, me] = [opener, editor, pricer, owner].map((u) => u.userId.toHexString());
    expect(await actions(shopId)).toEqual([
      ["business.close", o],
      ["business.open", o],
      ["business.update", e],
      ["business.photo_add", e],
      ["business.photo_remove", e],
      ["business.catalog", p],
      ["business.update", me],
    ]);

    await stack.db.users.updateOne({ _id: opener.userId }, { $set: { "kyc.base": "pending" } });
    expect((await call("POST", `/employment/${openerAt}/shop/close`, opener.token)).json().error.code).toBe("KYC_REQUIRED");
    await call("DELETE", `/vendor/businesses/${shopId}/team/${editorAt}`, owner.token);
    expect((await call("PATCH", `/employment/${editorAt}/shop`, editor.token, { name: "Gone" })).statusCode).toBe(404);
  }, 60_000);

  it("makes and changes coupons for this shop alone, and leaves the owner's other coupons to the owner", async () => {
    const owner = await person({ vendor: true, verified: true });
    const shopId = await teeShop(owner);
    const otherShop = await teeShop(owner, "Rao Mugs");
    const crew = await person({ verified: true });
    const viewer = await person({ verified: true });
    const at = await hire(owner, shopId, crew, ["coupons.manage"]);
    const viewerAt = await hire(owner, shopId, viewer, ["orders.view"]);
    const both = (await call("POST", "/vendor/coupons", owner.token, { code: "BOTHSHOPS", kind: "flat", value: 5_000, businessIds: [shopId, otherShop] })).json().data;
    await call("POST", "/vendor/coupons", owner.token, { code: "MUGSONLY", kind: "flat", value: 5_000, businessIds: [otherShop] });
    await stack.db.auditLogs.deleteMany({});

    expect((await call("POST", `/employment/${viewerAt}/coupons`, viewer.token, { code: "NOPE", kind: "flat", value: 5_000 })).statusCode).toBe(403);
    const made = await call("POST", `/employment/${at}/coupons`, crew.token, { code: "RAO50", kind: "percent", value: 10, cap: 5_000 });
    expect(made.statusCode).toBe(201);
    expect(made.json().data).toMatchObject({ fundedBy: "vendor", vendor: { id: owner.userId.toHexString() }, businesses: [{ id: shopId }], label: "10% off up to ₹50" });
    expect((await call("POST", `/employment/${at}/coupons`, crew.token, { code: "RAO50", kind: "flat", value: 100, businessIds: [otherShop] })).statusCode).toBe(400);

    const listed = (await call("GET", `/employment/${at}/coupons`, crew.token)).json().data.map((c: { code: string }) => c.code);
    expect(listed).toEqual(["RAO50", "BOTHSHOPS"]);
    const id = made.json().data.id as string;
    expect((await call("PATCH", `/employment/${at}/coupons/${id}`, crew.token, { active: false })).json().data.state).toBe("off");
    expect((await call("PATCH", `/employment/${at}/coupons/${both.id}`, crew.token, { active: false })).statusCode).toBe(403);
    const mugs = (await stack.db.coupons.findOne({ code: "MUGSONLY" }))!._id.toHexString();
    expect((await call("PATCH", `/employment/${at}/coupons/${mugs}`, crew.token, { active: false })).statusCode).toBe(404);
    expect((await call("GET", "/vendor/coupons", owner.token)).json().data.map((c: { code: string }) => c.code)).toContain("RAO50");

    const c = crew.userId.toHexString();
    expect(await actions(shopId)).toEqual([
      ["coupon.create", c],
      ["coupon.update", c],
    ]);
  }, 60_000);

  it("posts as the business for people allowed to, under the owner's name", async () => {
    const owner = await person({ vendor: true, verified: true });
    const shopId = await teeShop(owner);
    const poster = await person({ verified: true });
    const viewer = await person({ verified: true });
    const stranger = await person({ verified: true });
    await hire(owner, shopId, poster, ["posts.create"]);
    await hire(owner, shopId, viewer, ["orders.view"]);
    await stack.db.auditLogs.deleteMany({});
    const post = (u: User, body: object) => call("POST", "/social/posts", u.token, { text: "New colours this week", kind: "business", ...body });

    const made = await post(poster, { businessId: shopId });
    expect(made.statusCode).toBe(201);
    expect(made.json().data).toMatchObject({ kind: "business", author: { id: owner.userId.toHexString() }, business: { id: shopId } });
    expect((await stack.db.users.findOne({ _id: owner.userId }))?.social?.posts).toBe(1);
    expect(await actions(shopId)).toEqual([["post.create", poster.userId.toHexString()]]);

    expect((await post(viewer, { businessId: shopId })).statusCode).toBe(403);
    expect((await post(stranger, { businessId: shopId })).json().error.code).toBe("VALIDATION_FAILED");
    expect((await post(poster, {})).statusCode).toBe(403);
    const mine = await post(owner, {});
    expect(mine.json().data).toMatchObject({ author: { id: owner.userId.toHexString() }, business: { id: shopId } });
  }, 60_000);
});
