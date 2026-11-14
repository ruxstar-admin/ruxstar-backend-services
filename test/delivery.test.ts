import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakePayouts } from "../src/adapters/payouts.js";
import { DEFAULT_RIDER_RATE, rateFor, roadKm } from "../src/modules/delivery/rates.js";
import { stamp } from "../src/platform/db.js";
import { forgetModuleState } from "../src/platform/module-switch.js";
import { JOB_TOKEN, signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>>;
const BACK = "https://ruxstar.com/orders";
const SHOP_POINT = { lat: 17.4486, lng: 78.3908 };
const DROP_POINT = { lat: 17.48, lng: 78.42 };
const ADDRESS = { name: "Ravi Kumar", phone: "9876501234", line: "Flat 302, Green Towers, Kondapur", city: "Hyderabad", pincode: "500084" };
const FEE = { base: 2000, includedKm: 2, perKm: 1000 };

describe("delivery", () => {
  let stack: Stack;
  let admin: User;
  let photo: Buffer;
  let pdf: Buffer;

  beforeAll(async () => {
    stack = await startStack();
    admin = await signIn(stack, { admin: true });
    photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#406080" } }).jpeg().toBuffer();
    const doc = await PDFDocument.create();
    doc.addPage();
    pdf = Buffer.from(await doc.save());
  });
  afterAll(() => stack?.stop());
  beforeEach(async () => {
    await Promise.all([
      stack.db.businesses.deleteMany({}),
      stack.db.podOrders.deleteMany({}),
      stack.db.ledgerEntries.deleteMany({}),
      stack.db.employments.deleteMany({}),
      stack.db.notifications.deleteMany({}),
      stack.db.deliveryJobs.deleteMany({}),
      stack.db.riderStates.deleteMany({}),
      stack.db.kycCases.deleteMany({}),
      stack.db.payouts.deleteMany({}),
      stack.db.riderPayoutMethods.deleteMany({}),
    ]);
    await stack.db.moduleSettings.updateOne(
      { module: "pod" },
      { $set: { live: true, signupsOpen: true, commissionBps: 1000, platformFee: 500, deliveryEnabled: true }, $unset: { gstinRequired: "" } },
    );
    await stack.db.moduleSettings.updateOne(
      { module: "delivery" },
      { $set: { live: true }, $unset: { riderRate: "", shopFeeMax: "", offerMinutes: "", payoutFee: "", minPayout: "" } },
    );
    forgetModuleState();
  });

  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, token: string, payload?: object) =>
    stack.app.inject({
      method,
      url: `/v1${url}`,
      headers: web(token, method === "GET" || method === "DELETE" ? {} : { "idempotency-key": randomUUID() }),
      ...(payload ? { payload } : {}),
    });
  const putPhoto = (url: string, token: string) =>
    stack.app.inject({ method: "PUT", url: `/v1${url}`, headers: web(token, { "content-type": "image/jpeg" }), payload: photo });

  let n = 0;
  async function person(opts: { vendor?: boolean; verified?: boolean; name?: string } = {}) {
    const user = await signIn(stack, opts.vendor ? { vendor: true } : {});
    const username = `rider${Date.now() % 1e6}${n++}`;
    await stack.db.users.updateOne({ _id: user.userId }, { $set: { name: opts.name ?? "Kiran Das", username } });
    if (opts.verified) await verifyIdentity(user);
    return { ...user, username };
  }

  async function verifyIdentity(user: User) {
    await stack.db.kycCases.insertOne({
      _id: new ObjectId(),
      userId: user.userId,
      track: "base",
      status: "approved",
      rejections: 0,
      steps: {},
      submittedAt: new Date(),
      review: null,
      ...stamp(),
    });
    await stack.db.users.updateOne({ _id: user.userId }, { $set: { "kyc.base": "approved" } });
  }

  /** Delivery verification approved, as the Ruxstar team leaves it. */
  async function makeRider(user: User, plate = "TS09AB1234") {
    await stack.db.kycCases.insertOne({
      _id: new ObjectId(),
      userId: user.userId,
      track: "delivery",
      status: "approved",
      rejections: 0,
      steps: {
        licence: { number: `TS09${String(n++).padStart(11, "0")}`, photo: null, at: new Date() },
        vehicle: { type: "bike", number: plate, photo: null, at: new Date() },
      },
      submittedAt: new Date(),
      review: null,
      ...stamp(),
    });
    await stack.db.users.updateOne({ _id: user.userId }, { $set: { "roles.delivery": true, "kyc.delivery": "approved" } });
  }

  async function partner(name: string) {
    const user = await person({ verified: true, name });
    await makeRider(user);
    expect((await call("POST", "/delivery/online", user.token, { online: true, city: "Hyderabad" })).json().data.online).toBe(true);
    return user;
  }

  /** A live tee shop pinned on the map: twelve shirts are ₹3,000 of items, plus the ₹5 platform fee. */
  async function teeShop(owner: User, deliveryFee?: typeof FEE) {
    const created = await call("POST", "/vendor/businesses", owner.token, {
      module: "pod",
      type: "print_shop",
      name: "Rao Prints",
      phone: "9876543210",
      location: { state: "Telangana", city: "Hyderabad", doorNo: "4-1", street: "Main Road", area: "Madhapur", pincode: "500081" },
    });
    const id = created.json().data.id as string;
    await stack.app.inject({ method: "POST", url: `/v1/vendor/businesses/${id}/photos`, headers: web(owner.token, { "content-type": "image/jpeg" }), payload: photo });
    const setup = await call("PATCH", `/vendor/businesses/${id}/pod`, owner.token, {
      products: ["tshirts"],
      cities: ["Hyderabad"],
      prices: [{ product: "tshirts", basePrice: 30_000, tiers: [{ from: 10, unitPrice: 25_000 }] }],
      ...(deliveryFee ? { deliveryFee } : {}),
    });
    expect(setup.statusCode).toBe(200);
    expect((await call("POST", `/vendor/businesses/${id}/publish`, owner.token)).statusCode).toBe(200);
    await stack.db.businesses.updateOne({ _id: new ObjectId(id) }, { $set: { "location.point": SHOP_POINT } });
    return id;
  }

  async function paid(customer: User, shopId: string, address: object = { ...ADDRESS, point: DROP_POINT }) {
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
      address,
      returnTo: BACK,
    });
    expect(res.statusCode).toBe(201);
    const url = new URL(res.json().data.checkoutUrl);
    expect((await stack.app.inject({ method: "POST", url: `${url.pathname}/test${url.search}` })).json()).toEqual({ status: "placed" });
    return res.json().data.order as { id: string; orderNo: number; price: { delivery: number; deliveryKm: number | null; total: number } };
  }

  async function ready(owner: User, orderId: string) {
    expect((await call("POST", `/vendor/orders/${orderId}/status`, owner.token, { status: "accepted" })).statusCode).toBe(200);
    expect((await call("POST", `/vendor/orders/${orderId}/status`, owner.token, { status: "ready" })).statusCode).toBe(200);
  }

  const codeOf = async (orderId: string) => (await stack.db.podOrders.findOne({ _id: new ObjectId(orderId) }))!.delivery!.dropCode;
  const sent = async (u: User, type: string) => (await stack.db.notifications.find({ userId: u.userId, type: type as never }).toArray()).map((x) => x.title);
  const step = (u: User, jobId: string, path: string, body?: object) => call("POST", `/delivery/jobs/${jobId}/${path}`, u.token, body);

  it("verifies a delivery partner: licence and vehicle on top of identity, checked with photos by the Ruxstar team", async () => {
    const user = await person({ name: "Suresh Rao" });
    const patch = (body: object, token = user.token) => call("PATCH", "/kyc/delivery", token, body);
    expect((await patch({ vehicleType: "bike" })).json().error.code).toBe("KYC_STEP_ORDER");

    await verifyIdentity(user);
    expect((await call("GET", "/kyc", user.token)).json().data.delivery).toMatchObject({ status: "not_started", identityVerified: true });
    expect((await patch({ licenceNumber: "12345" })).json().error.code).toBe("VALIDATION_FAILED");
    const filled = await patch({ licenceNumber: "ts09 2019-0001234", vehicleType: "bike", vehicleNumber: "ts 09 ab 1234" });
    expect(filled.statusCode).toBe(200);
    expect(filled.json().data.delivery).toMatchObject({
      status: "in_progress",
      licence: { number: "TS0920190001234", photo: false },
      vehicle: { type: "bike", number: "TS09AB1234", photo: false },
    });
    expect((await call("POST", "/kyc/delivery/submit", user.token)).json().error.code).toBe("KYC_STEP_ORDER");
    expect((await putPhoto("/kyc/delivery/photos/licence", user.token)).statusCode).toBe(200);
    const both = await putPhoto("/kyc/delivery/photos/vehicle", user.token);
    expect(both.json().data.delivery).toMatchObject({ licence: { photo: true }, vehicle: { photo: true } });
    expect([...stack.printFiles.objects.keys()].filter((k) => k.startsWith(`kyc/${user.userId.toHexString()}/`))).toHaveLength(2);

    const submitted = await call("POST", "/kyc/delivery/submit", user.token);
    expect(submitted.json().data.delivery.status).toBe("submitted");
    expect((await call("GET", "/account/me", user.token)).json().data.kyc.delivery).toBe("pending");
    expect((await call("GET", "/delivery/me", user.token)).json().error.code).toBe("KYC_REQUIRED");

    const copycat = await person({ verified: true });
    expect((await patch({ licenceNumber: "TS0920190001234" }, copycat.token)).json().error.message).toContain("another Ruxstar account");

    const list = (await call("GET", "/ruxstar/kyc?track=delivery", admin.token)).json().data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ track: "delivery", user: { name: "Suresh Rao" }, delivery: { licenceNumber: "TS0920190001234", vehicleNumber: "TS09AB1234" } });
    const link = new URL(list[0].delivery.licencePhotoUrl);
    const opened = await stack.app.inject({ url: `${link.pathname}${link.search}` });
    expect(opened.statusCode).toBe(200);
    expect(opened.headers["content-type"]).toBe("image/jpeg");
    expect((await stack.app.inject({ url: `${link.pathname}${link.search.replace(/t=[^&]+/, "t=forged")}` })).statusCode).toBe(401);
    expect((await call("GET", "/ruxstar/kyc", admin.token)).json().data.some((c: { id: string }) => c.id === list[0].id)).toBe(false);

    const approved = await call("POST", `/ruxstar/kyc/${list[0].id}/approve`, admin.token);
    expect(approved.statusCode).toBe(200);
    const me = (await call("GET", "/account/me", user.token)).json().data;
    expect(me.roles.delivery).toBe(true);
    expect(me.kyc.delivery).toBe("approved");
    expect(await sent(user, "kyc.approved")).toEqual(["You can deliver with Ruxstar"]);
    const rider = (await call("GET", "/delivery/me", user.token)).json().data;
    expect(rider).toMatchObject({ name: "Suresh Rao", vehicle: { type: "bike", number: "TS09AB1234" }, online: false, partnerOffers: true, active: null });
  }, 60_000);

  it("lets Ruxstar ask for a GSTIN per category and cap what shops charge for delivery", async () => {
    const patch = (module: string, body: object) => call("PATCH", `/ruxstar/modules/${module}`, admin.token, body);
    expect((await patch("pod", { gstinRequired: true })).json().data.gstinRequired).toBe(true);
    expect((await patch("delivery", { gstinRequired: true })).statusCode).toBe(400);
    expect((await patch("pod", { offerMinutes: 10 })).statusCode).toBe(400);

    const owner = await person({ vendor: true, verified: true });
    const draft = await call("POST", "/vendor/businesses", owner.token, {
      module: "pod",
      type: "print_shop",
      name: "GST Prints",
      phone: "9876543210",
      location: { state: "Telangana", city: "Hyderabad", doorNo: "4-1", street: "Main Road", area: "Madhapur", pincode: "500081" },
    });
    expect(draft.json().data.missing).toContain("gstin");
    await patch("pod", { gstinRequired: false });
    const shopId = await teeShop(owner);

    const delivery = (await patch("delivery", { shopFeeMax: { base: 10_000, perKm: 2000 }, riderRate: { base: 4000, includedKm: 2, perKm: 1000 } })).json().data;
    expect(delivery.delivery).toMatchObject({ shopFeeMax: { base: 10_000, perKm: 2000 }, riderRate: { base: 4000 }, offerMinutes: 15 });
    const tooMuch = await call("PATCH", `/vendor/businesses/${shopId}/pod`, owner.token, { deliveryFee: { base: 15_000, includedKm: 2, perKm: 1000 } });
    expect(tooMuch.json().error.message).toBe("Ruxstar allows up to ₹100.");
    const fine = await call("PATCH", `/vendor/businesses/${shopId}/pod`, owner.token, { deliveryFee: FEE });
    expect(fine.json().data.pod.deliveryFee).toEqual(FEE);
  }, 60_000);

  it("prices delivery by distance at the quote and the order, and pays it to the shop", async () => {
    const owner = await person({ vendor: true, verified: true });
    const shopId = await teeShop(owner, FEE);
    const customer = await signIn(stack);
    const km = roadKm(SHOP_POINT, DROP_POINT)!;
    const fee = rateFor(FEE, km);
    stack.places.set(`${ADDRESS.line}, ${ADDRESS.city}, ${ADDRESS.pincode}`, DROP_POINT);

    const choice = { shopId, product: "tshirts", options: { size: "M" }, quantity: 12, fileIds: [] };
    const bare = (await call("POST", "/pod/quote", customer.token, choice)).json().data;
    expect(bare).toMatchObject({ delivery: FEE.base, deliveryKm: null, total: 300_000 + 500 + FEE.base });
    const quote = (await call("POST", "/pod/quote", customer.token, { ...choice, address: { line: ADDRESS.line, city: ADDRESS.city, pincode: ADDRESS.pincode } })).json().data;
    expect(quote).toMatchObject({ delivery: fee, deliveryKm: km, total: 300_000 + 500 + fee });

    const typed = await paid(customer, shopId, ADDRESS);
    expect(typed.price).toMatchObject({ delivery: fee, deliveryKm: km, total: 300_000 + 500 + fee });
    const located = await paid(customer, shopId, { ...ADDRESS, line: "Somewhere new", point: DROP_POINT });
    expect(located.price.deliveryKm).toBe(km);
    const shopView = (await call("GET", `/vendor/orders/${typed.id}`, owner.token)).json().data;
    expect(shopView.price).toMatchObject({ delivery: fee, commission: 30_000, payout: 270_000 + fee });
  }, 60_000);

  it("sends a ready order with someone on the team, who picks it up and hands it over with the code and a photo", async () => {
    const owner = await person({ vendor: true, verified: true });
    const shopId = await teeShop(owner);
    const kiran = await person({ verified: true, name: "Kiran Das" });
    const placeId = (await call("POST", `/vendor/businesses/${shopId}/team`, owner.token, { username: kiran.username, permissions: ["orders.deliver"] })).json().data
      .id as string;
    expect((await call("POST", `/employment/${placeId}/accept`, kiran.token)).json().data.permissions).toEqual(["orders.view", "orders.deliver"]);
    const customer = await signIn(stack);
    const order = await paid(customer, shopId);

    const early = (await call("GET", `/vendor/orders/${order.id}/delivery`, owner.token)).json().data;
    expect(early).toMatchObject({ canAssign: false, reason: "Mark the order ready first.", team: [{ placeId, name: "Kiran Das", ready: false }] });
    await ready(owner, order.id);
    const assign = () => call("POST", `/vendor/orders/${order.id}/delivery`, owner.token, { carrier: "team", placeId });
    expect((await assign()).json().error.message).toContain("delivery verification");

    await makeRider(kiran);
    const assigned = await assign();
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().data.delivery).toMatchObject({ carrier: "team", status: "offered", rider: null, pay: 0 });
    expect((await assign()).json().error.code).toBe("ORDER_STATE");
    expect(await sent(kiran, "delivery.offer")).toEqual(["Deliver for Rao Prints"]);
    expect((await call("POST", `/vendor/orders/${order.id}/status`, owner.token, { status: "out_for_delivery" })).json().error.message).toContain("A rider has");

    const offers = (await call("GET", "/delivery/offers", kiran.token)).json().data;
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ carrier: "team", status: "offered", drop: { name: "Customer", phone: null, line: null } });
    const jobId = offers[0].id as string;

    const accepted = await step(kiran, jobId, "accept");
    expect(accepted.json().data).toMatchObject({ status: "accepted", drop: { name: "Ravi Kumar", phone: "9876501234" } });
    expect(await sent(owner, "order.updated")).toContain(`Rider for order #${order.orderNo}`);
    const seen = (await call("GET", `/pod/orders/${order.id}`, customer.token)).json().data.delivery;
    expect(seen).toMatchObject({ carrier: "team", status: "accepted", rider: { name: "Kiran Das", vehicle: { type: "bike", number: "TS09AB1234" } } });
    expect(seen.dropCode).toMatch(/^\d{4}$/);

    expect((await step(kiran, jobId, "pickup")).json().data.status).toBe("picked_up");
    expect((await call("GET", `/pod/orders/${order.id}`, customer.token)).json().data.status).toBe("out_for_delivery");
    expect((await step(kiran, jobId, "deliver", { code: seen.dropCode })).json().error.code).toBe("CONFLICT");
    expect((await putPhoto(`/delivery/jobs/${jobId}/photo`, kiran.token)).json().data.proof).toBe(true);
    const wrong = seen.dropCode === "0000" ? "1111" : "0000";
    expect((await step(kiran, jobId, "deliver", { code: wrong })).json().error.code).toBe("DROP_CODE_INVALID");
    const done = await step(kiran, jobId, "deliver", { code: seen.dropCode });
    expect(done.json().data.status).toBe("delivered");

    const after = (await call("GET", `/pod/orders/${order.id}`, customer.token)).json().data;
    expect(after).toMatchObject({ status: "delivered", delivery: { status: "delivered", dropCode: null } });
    expect(await stack.db.ledgerEntries.countDocuments({ kind: "rider_pay" })).toBe(0);
    expect((await call("GET", "/delivery/jobs?view=past", kiran.token)).json().data.map((j: { id: string }) => j.id)).toEqual([jobId]);
    expect((await call("GET", "/delivery/me", kiran.token)).json().data).toMatchObject({ active: null, today: { trips: 1, earned: 0 }, teams: [{ placeId }] });
    expect((await call("GET", "/delivery/earnings", kiran.token)).json().data).toMatchObject({
      today: 0,
      trips: 0,
      teamTrips: 1,
      recent: [{ jobId, orderNo: order.orderNo, carrier: "team", pay: 0 }],
    });
  }, 90_000);

  it("offers a ready order to Ruxstar partners in the city; the first to accept gets it and is paid out of the shop's share", async () => {
    const owner = await person({ vendor: true, verified: true });
    const shopId = await teeShop(owner);
    const customer = await signIn(stack);
    const order = await paid(customer, shopId);
    await ready(owner, order.id);
    const asha = await partner("Asha");
    const bala = await partner("Bala");
    const pay = rateFor(DEFAULT_RIDER_RATE, roadKm(SHOP_POINT, DROP_POINT));

    await stack.db.moduleSettings.updateOne({ module: "pod" }, { $set: { deliveryEnabled: false } });
    const off = (await call("GET", `/vendor/orders/${order.id}/delivery`, owner.token)).json().data.partner;
    expect(off).toMatchObject({ available: false, reason: "Ruxstar delivery partners aren't available yet." });
    await stack.db.moduleSettings.updateOne({ module: "pod" }, { $set: { deliveryEnabled: true } });
    const options = (await call("GET", `/vendor/orders/${order.id}/delivery`, owner.token)).json().data;
    expect(options).toMatchObject({ canAssign: true, partner: { available: true, pay, online: 2 } });

    const offered = await call("POST", `/vendor/orders/${order.id}/delivery`, owner.token, { carrier: "partner" });
    expect(offered.json().data.delivery).toMatchObject({ carrier: "partner", status: "offered", pay });
    expect(offered.json().data.delivery.offerUntil).not.toBeNull();
    expect(offered.json().data.refundable).toBe(270_000 - pay);
    for (const u of [asha, bala]) expect((await sent(u, "delivery.offer")).length).toBe(1);
    const offer = (await call("GET", "/delivery/offers", bala.token)).json().data[0];
    const jobId = offer.id as string;
    expect(offer.drop.point).toBeNull();
    expect(offer.dropNear).toEqual({ lat: Math.round(DROP_POINT.lat * 100) / 100, lng: Math.round(DROP_POINT.lng * 100) / 100 });

    expect((await step(asha, jobId, "accept")).json().data.status).toBe("accepted");
    expect((await step(bala, jobId, "accept")).json().error.code).toBe("JOB_TAKEN");
    expect((await call("GET", "/delivery/offers", bala.token)).json().data).toEqual([]);
    expect((await call("GET", `/delivery/jobs/${jobId}`, bala.token)).json().error.code).toBe("JOB_TAKEN");

    await step(asha, jobId, "pickup");
    await putPhoto(`/delivery/jobs/${jobId}/photo`, asha.token);
    expect((await step(asha, jobId, "deliver", { code: await codeOf(order.id) })).json().data.status).toBe("delivered");

    const ledger = await stack.db.ledgerEntries.find({ txnId: `rider_pay:${order.id}` }).toArray();
    expect(ledger.map((e) => [e.accountId, e.bucket, e.signedPaise]).sort()).toEqual(
      [
        [`rider:${asha.userId.toHexString()}`, "pending", pay],
        [`vendor:${owner.userId.toHexString()}`, "pending", -pay],
      ].sort(),
    );
    const statement = (await call("GET", "/vendor/payments/statement", owner.token)).json().data;
    expect(statement[0]).toMatchObject({ kind: "delivery", amount: -pay, order: { id: order.id }, refund: null });
    const shopSide = (await call("GET", `/vendor/orders/${order.id}`, owner.token)).json().data;
    expect(shopSide.price.payoutLeft).toBe(270_000 - pay);
    expect(shopSide.delivery).toMatchObject({ status: "delivered", rider: { name: "Asha" } });
    expect(await sent(owner, "order.updated")).toContain(`Order #${order.orderNo} delivered`);
    const earnings = (await call("GET", "/delivery/earnings", asha.token)).json().data;
    expect(earnings).toMatchObject({
      balance: { available: 0, pending: pay, paidOut: 0 },
      today: pay,
      week: pay,
      trips: 1,
      teamTrips: 0,
      recent: [{ jobId, orderNo: order.orderNo, carrier: "partner", pay }],
      upcoming: [{ orderId: order.id, orderNo: order.orderNo, amount: pay, held: false }],
      withdrawal: { minimum: 10_000, fee: 590 },
      payoutMethod: null,
      payouts: [],
    });
  }, 90_000);

  /** A ready order offered to Ruxstar partners, taken by `rider` and delivered. */
  async function partnerDelivers(owner: User, shopId: string, customer: User, rider: User) {
    const order = await paid(customer, shopId);
    await ready(owner, order.id);
    expect((await call("POST", `/vendor/orders/${order.id}/delivery`, owner.token, { carrier: "partner" })).statusCode).toBe(200);
    const jobId = (await stack.db.podOrders.findOne({ _id: new ObjectId(order.id) }))!.delivery!.jobId.toHexString();
    await step(rider, jobId, "accept");
    await step(rider, jobId, "pickup");
    await putPhoto(`/delivery/jobs/${jobId}/photo`, rider.token);
    expect((await step(rider, jobId, "deliver", { code: await codeOf(order.id) })).json().data.status).toBe("delivered");
    return order;
  }

  it("holds a partner's pay for 48 hours, longer only while a 'not received' report is open, then lets them withdraw it", async () => {
    const owner = await person({ vendor: true, verified: true });
    const shopId = await teeShop(owner);
    const customer = await signIn(stack);
    const asha = await partner("Asha");
    const pay = rateFor(DEFAULT_RIDER_RATE, roadKm(SHOP_POINT, DROP_POINT));
    const first = await partnerDelivers(owner, shopId, customer, asha);
    const second = await partnerDelivers(owner, shopId, customer, asha);
    const fake = stack.app.payouts as FakePayouts;
    fake.next = "paid";
    const earnings = async () => (await call("GET", "/delivery/earnings", asha.token)).json().data;
    const sweep = () => stack.app.inject({ method: "POST", url: "/jobs/orders", headers: { authorization: `Bearer ${JOB_TOKEN}` } });
    const holdOver = (id: string) =>
      stack.db.podOrders.updateOne({ _id: new ObjectId(id) }, { $set: { "delivery.releaseAt": new Date(Date.now() - 60_000) } });

    expect((await call("POST", `/pod/orders/${second.id}/problem`, customer.token, { kind: "not_received", note: "Nothing arrived" })).statusCode).toBe(200);
    await holdOver(first.id);
    await holdOver(second.id);
    expect((await sweep()).json().riderPay).toBe(1);
    const now = await earnings();
    expect(now.balance).toEqual({ available: pay, pending: pay, paidOut: 0 });
    expect(now.upcoming).toEqual([expect.objectContaining({ orderId: second.id, held: true })]);

    const staff = (await call("GET", "/ruxstar/held-orders", admin.token)).json().data;
    expect(staff.find((o: { id: string }) => o.id === second.id).partner).toMatchObject({ rider: { name: "Asha" }, amount: pay, held: true });
    expect(staff.find((o: { id: string }) => o.id === first.id).partner).toBeNull();

    // Ruxstar settles it without a refund: the partner keeps their pay and it is released on the next look.
    await stack.db.podOrders.updateOne({ _id: new ObjectId(second.id) }, { $set: { "problem.status": "resolved" } });
    expect((await earnings()).balance).toEqual({ available: 2 * pay, pending: 0, paidOut: 0 });

    expect((await call("POST", "/delivery/payouts", asha.token)).json().error.code).toBe("PAYOUT_METHOD_REQUIRED");
    const method = await stack.app.inject({
      method: "PUT",
      url: "/v1/delivery/payout-method",
      headers: web(asha.token),
      payload: { kind: "upi", vpa: "Asha@OKHDFC" },
    });
    expect(method.json().data).toMatchObject({ kind: "upi", label: "asha@okhdfc" });
    expect(await stack.db.payoutMethods.countDocuments({ userId: asha.userId })).toBe(0);
    expect((await call("GET", "/delivery/payout-method", asha.token)).json().data).toMatchObject({ label: "asha@okhdfc" });

    await call("PATCH", "/ruxstar/modules/delivery", admin.token, { payoutFee: 500, minPayout: 2 * pay + 1 });
    expect((await call("POST", "/delivery/payouts", asha.token)).json().error.code).toBe("PAYOUT_TOO_SMALL");
    const rules = await call("PATCH", "/ruxstar/modules/delivery", admin.token, { minPayout: 1_000 });
    expect(rules.json().data.payouts).toEqual({ fee: 500, minimum: 1_000 });
    const payout = (await call("POST", "/delivery/payouts", asha.token)).json().data;
    expect(payout).toMatchObject({ amount: 2 * pay, fee: 500, status: "paid", to: "asha@okhdfc" });
    expect([...fake.transfers.values()].at(-1)).toMatchObject({ amount: 2 * pay - 500, to: { kind: "upi", vpa: "asha@okhdfc" } });

    const after = await earnings();
    expect(after.balance).toEqual({ available: 0, pending: 0, paidOut: 2 * pay });
    expect(after.payouts).toEqual([expect.objectContaining({ id: payout.id, status: "paid" })]);
    const lines = (await call("GET", "/delivery/earnings/statement", asha.token)).json().data;
    expect(lines.map((l: { kind: string; amount: number }) => [l.kind, l.amount])).toEqual([
      ["withdrawal", -2 * pay],
      ["available", pay],
      ["available", pay],
      ["earned", pay],
      ["earned", pay],
    ]);
    expect(await stack.db.notifications.findOne({ userId: asha.userId, type: "payout.updated", "link.screen": "delivery_earnings" })).not.toBeNull();

    // The console lists it with vendors' withdrawals, marked as a partner's; the shop's own Payments doesn't show it.
    const listed = (await call("GET", "/ruxstar/payouts?status=paid", admin.token)).json().data;
    expect(listed.find((p: { id: string }) => p.id === payout.id)).toMatchObject({ payee: "partner", vendor: { name: "Asha" } });
    expect((await call("GET", "/vendor/payments", owner.token)).json().data.payouts).toEqual([]);
  }, 120_000);

  it("sends the order back to the shop when an offer runs out, the shop cancels, or the rider gives it up", async () => {
    const owner = await person({ vendor: true, verified: true });
    const shopId = await teeShop(owner);
    const customer = await signIn(stack);
    const order = await paid(customer, shopId);
    const other = await paid(customer, shopId);
    await ready(owner, order.id);
    await ready(owner, other.id);
    const asha = await partner("Asha");
    const offer = async (id = order.id) => {
      expect((await call("POST", `/vendor/orders/${id}/delivery`, owner.token, { carrier: "partner" })).statusCode).toBe(200);
      return (await stack.db.podOrders.findOne({ _id: new ObjectId(id) }))!.delivery!.jobId.toHexString();
    };
    const deliveryOf = async (id = order.id) => (await call("GET", `/vendor/orders/${id}`, owner.token)).json().data;

    let jobId = await offer();
    const past = new Date(Date.now() - 60_000);
    await stack.db.podOrders.updateOne({ _id: new ObjectId(order.id) }, { $set: { "delivery.offerUntil": past } });
    await stack.db.deliveryJobs.updateOne({ _id: new ObjectId(jobId) }, { $set: { offerUntil: past } });
    expect((await stack.app.inject({ method: "POST", url: "/jobs/orders", headers: { authorization: `Bearer ${JOB_TOKEN}` } })).statusCode).toBe(200);
    expect((await deliveryOf()).delivery.status).toBe("cancelled");
    expect(await sent(owner, "order.updated")).toContain(`Nobody took order #${order.orderNo}`);

    jobId = await offer();
    await step(asha, jobId, "accept");
    const otherJob = await offer(other.id);
    expect((await step(asha, otherJob, "accept")).json().error.message).toBe("Finish the delivery you have first.");
    const cancelled = await call("DELETE", `/vendor/orders/${order.id}/delivery`, owner.token);
    expect(cancelled.json().data.delivery.status).toBe("cancelled");
    expect(await sent(asha, "delivery.updated")).toEqual(["Delivery cancelled"]);

    jobId = await offer();
    await step(asha, jobId, "accept");
    expect((await step(asha, jobId, "cancel", { reason: "Tyre puncture" })).json().data.status).toBe("cancelled");
    expect((await deliveryOf()).delivery.status).toBe("cancelled");

    jobId = await offer();
    await step(asha, jobId, "accept");
    await step(asha, jobId, "pickup");
    expect((await call("DELETE", `/vendor/orders/${order.id}/delivery`, owner.token)).json().error.code).toBe("ORDER_STATE");
    await step(asha, jobId, "cancel", { reason: "The customer's lane is closed" });
    const back = await deliveryOf();
    expect(back).toMatchObject({ status: "ready", delivery: { status: "cancelled" } });
    expect(await sent(owner, "order.updated")).toContain(`Delivery of #${order.orderNo} stopped`);
    expect((await call("GET", "/delivery/me", asha.token)).json().data.active).toBeNull();
  }, 90_000);
});
