import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeVerifier } from "../src/adapters/verification.js";
import { stamp } from "../src/platform/db.js";
import { forgetModuleState } from "../src/platform/module-switch.js";
import { unseal } from "../src/platform/sealed.js";
import { signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>>;

describe("vendor portal", () => {
  let stack: Stack;
  let verifier: FakeVerifier;
  let admin: User;
  let photo: Buffer;

  beforeAll(async () => {
    verifier = new FakeVerifier();
    stack = await startStack(undefined, { verifier });
    admin = await signIn(stack, { admin: true });
    photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#8a6a40" } }).jpeg().toBuffer();
  });
  afterAll(() => stack?.stop());
  beforeEach(async () => {
    Object.assign(verifier, new FakeVerifier());
    await setModule("pod", { live: true, signupsOpen: true });
  });

  const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, token: string, payload?: object) =>
    stack.app.inject({
      method,
      url: `/v1${url}`,
      headers: web(token, method === "GET" ? {} : { "idempotency-key": randomUUID() }),
      ...(payload ? { payload } : {}),
    });
  const upload = (id: string, token: string, body = photo) =>
    stack.app.inject({ method: "POST", url: `/v1/vendor/businesses/${id}/photos`, headers: web(token, { "content-type": "image/jpeg" }), payload: body });
  const setModule = async (module: string, set: { live?: boolean; signupsOpen?: boolean }) => {
    await stack.db.moduleSettings.updateOne({ module: module as "pod" }, { $set: set });
    forgetModuleState();
  };

  /** A verified person: approved identity, an Aadhaar name, and the vendor role. */
  async function vendor(name = "Asha Rao") {
    const user = await signIn(stack, { vendor: true });
    await stack.db.users.updateOne({ _id: user.userId }, { $set: { name, username: `v${user.userId.toHexString().slice(-8)}`, "kyc.base": "approved" } });
    await stack.db.kycCases.insertOne({
      _id: new ObjectId(),
      userId: user.userId,
      track: "base",
      status: "approved",
      rejections: 0,
      steps: { aadhaar: { status: "verified", verificationId: "v", referenceId: null, name, last4: "1234", reason: null, tries: 1, at: new Date() } },
      submittedAt: new Date(),
      review: null,
      ...stamp(),
    });
    return user;
  }

  const profile = (name = "Rao Prints", module = "pod", type = "print_shop") => ({
    module,
    type,
    name,
    phone: "9876543210",
    location: { state: "telangana", city: " Hyderabad ", street: "12 Main Road", pincode: "500001" },
  });
  const create = (owner: User, body: object = profile()) => call("POST", "/vendor/businesses", owner.token, body);

  /** A print business with a cover photo, one priced product and an area: ready to publish. */
  async function readyBusiness(owner: User) {
    const created = await create(owner);
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id as string;
    expect((await upload(id, owner.token)).statusCode).toBe(201);
    const setup = await call("PATCH", `/vendor/businesses/${id}/pod`, owner.token, {
      products: ["tshirts"],
      serveAll: true,
      prices: [{ product: "tshirts", basePrice: 29_900 }],
    });
    expect(setup.statusCode).toBe(200);
    return id;
  }

  it("is for verified people only", async () => {
    const plain = await signIn(stack);
    const res = await call("GET", "/vendor/businesses", plain.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("KYC_REQUIRED");
  });

  it("serves the catalog: categories with their types and module state, states and cities, print products", async () => {
    await setModule("events", { live: true, signupsOpen: false });
    const plain = await signIn(stack);
    const catalog = (await call("GET", "/vendor/catalog", plain.token)).json().data;
    expect(catalog.categories.map((c: { module: string }) => c.module)).toEqual(["pod", "events", "coaching", "stays"]);
    expect(catalog.categories[0]).toMatchObject({ module: "pod", label: "Print on demand", live: true, signupsOpen: true });
    expect(catalog.categories[0].types.map((t: { id: string }) => t.id)).toEqual(["print_shop"]);
    expect(catalog.categories[1]).toMatchObject({ live: true, signupsOpen: false });
    expect(catalog.categories[1].types.map((t: { id: string }) => t.id)).toEqual(["concert", "sports_event"]);
    expect(catalog.categories[3].types.map((t: { id: string }) => t.id)).toEqual(["pg", "hostel"]);
    expect(catalog.states).toHaveLength(36);
    expect(catalog.states.find((s: { name: string }) => s.name === "Telangana").cities).toContain("Hyderabad");
    expect(catalog.podProducts).toHaveLength(10);
    expect(catalog.podProducts.find((p: { id: string }) => p.id === "documents")).toMatchObject({ pricing: "per_page" });
    expect(catalog.limits).toMatchObject({ photos: 3, description: 500 });
    await setModule("events", { live: false });
  });

  it("creates a draft from its category, type and profile, says what is missing, then publishes it", async () => {
    const owner = await vendor();
    const created = (await create(owner, { ...profile("  Rao Prints "), description: "Tees and posters" })).json().data;
    expect(created).toMatchObject({ name: "Rao Prints", module: "pod", type: "print_shop", phone: "9876543210", status: "draft", open: false });
    expect(created.location).toEqual({
      state: "Telangana",
      city: "Hyderabad",
      doorNo: null,
      building: null,
      street: "12 Main Road",
      area: null,
      pincode: "500001",
      point: null,
    });
    expect(created.pod).toMatchObject({ products: [], serveAll: false, turnaroundDays: 3, unpriced: [] });
    expect(created.missing).toEqual(["photo", "products", "area"]);

    const early = await call("POST", `/vendor/businesses/${created.id}/publish`, owner.token);
    expect(early.statusCode).toBe(422);
    expect(early.json().error.details.map((d: { path: string }) => d.path)).toEqual(["body/photo", "body/products", "body/area"]);

    const id = await readyBusiness(owner);
    const ready = (await call("GET", `/vendor/businesses/${id}`, owner.token)).json().data;
    expect(ready.missing).toEqual([]);
    expect(ready.photos).toHaveLength(1);
    expect(ready.photos[0].url).toContain(`business-media/dev/${id}/`);

    const live = (await call("POST", `/vendor/businesses/${id}/publish`, owner.token)).json().data;
    expect(live).toMatchObject({ status: "live", open: true });
    expect(live.publishedAt).not.toBeNull();
    expect(await stack.db.auditLogs.findOne({ action: "business.publish", "target.id": new ObjectId(id) })).not.toBeNull();

    const list = (await call("GET", "/vendor/businesses", owner.token)).json().data;
    expect(list.map((b: { id: string }) => b.id)).toContain(id);
    expect(list.map((b: { id: string }) => b.id)).toContain(created.id);
  });

  it("refuses a type from another category, an unknown state, and modules that are off or not taking signups", async () => {
    const owner = await vendor();
    expect((await create(owner, profile("Rao Prints", "pod", "concert"))).json().error.details[0].path).toBe("body/type");
    const nowhere = await create(owner, { ...profile(), location: { state: "Atlantis", city: "Hyderabad" } });
    expect(nowhere.json().error.details[0].path).toBe("body/location/state");
    expect((await create(owner, profile("Lake House", "stays", "pg"))).json().error.code).toBe("MODULE_OFF");
    await setModule("stays", { live: true, signupsOpen: false });
    expect((await create(owner, profile("Lake House", "stays", "hostel"))).json().error.code).toBe("SIGNUPS_CLOSED");
    await setModule("stays", { live: true, signupsOpen: true });
    const stay = (await create(owner, profile("Lake House", "stays", "hostel"))).json().data;
    expect(stay).toMatchObject({ module: "stays", type: "hostel", pod: null, missing: ["photo"] });
    expect((await call("PATCH", `/vendor/businesses/${stay.id}/pod`, owner.token, { serveAll: true })).statusCode).toBe(409);
    await setModule("stays", { live: false });
  });

  it("sets up print products, area and prices, checking every option against the catalog", async () => {
    const owner = await vendor();
    const id = (await create(owner)).json().data.id;
    const pod = (body: object) => call("PATCH", `/vendor/businesses/${id}/pod`, owner.token, body);

    const unoffered = await pod({ prices: [{ product: "posters", basePrice: 10_000 }] });
    expect(unoffered.json().error.details[0].path).toBe("body/prices/0/product");

    const chosen = (await pod({ products: ["tshirts", "documents"], cities: [" Hyderabad", "hyderabad", "Warangal"], turnaroundDays: 5, minOrder: 50_000 })).json().data;
    expect(chosen.pod).toMatchObject({ products: ["tshirts", "documents"], cities: ["hyderabad", "warangal"], turnaroundDays: 5, minOrder: 50_000 });
    expect(chosen.pod.unpriced).toEqual(["tshirts", "documents"]);
    expect(chosen.missing).toEqual(["photo", "pricing"]);

    const wrongValue = await pod({ prices: [{ product: "tshirts", basePrice: 29_900, extras: [{ option: "size", value: "A4", price: 100 }] }] });
    expect(wrongValue.json().error.details[0].path).toBe("body/prices/0/extras/0/value");
    const wrongOption = await pod({ prices: [{ product: "documents", bw: 200, extras: [{ option: "sides", value: "Front", price: 100 }] }] });
    expect(wrongOption.json().error.details[0].path).toBe("body/prices/0/extras/0/option");

    const priced = (
      await pod({
        prices: [
          {
            product: "tshirts",
            basePrice: 29_900,
            bw: 100,
            extras: [{ option: "size", value: "XXL", price: 5_000 }],
            tiers: [
              { from: 50, unitPrice: 24_900 },
              { from: 10, unitPrice: 27_900 },
            ],
          },
          { product: "documents", bw: 200, color: 1_000, extras: [{ option: "binding", value: "Spiral bind", price: 4_000 }] },
        ],
      })
    ).json().data;
    const tees = priced.pod.prices.find((p: { product: string }) => p.product === "tshirts");
    expect(tees).toMatchObject({ model: "per_unit", basePrice: 29_900, bw: null, minQuantity: 1 });
    expect(tees.tiers.map((t: { from: number }) => t.from)).toEqual([10, 50]);
    expect(priced.pod.prices.find((p: { product: string }) => p.product === "documents")).toMatchObject({ model: "per_page", basePrice: null, bw: 200, color: 1_000 });
    expect(priced.pod.unpriced).toEqual([]);

    const dropped = (await pod({ products: ["documents"] })).json().data;
    expect(dropped.pod.prices.map((p: { product: string }) => p.product)).toEqual(["documents"]);
  });

  it("keeps a live print business sellable", async () => {
    const owner = await vendor();
    const id = await readyBusiness(owner);
    await call("POST", `/vendor/businesses/${id}/publish`, owner.token);
    const pod = (body: object) => call("PATCH", `/vendor/businesses/${id}/pod`, owner.token, body);
    expect((await pod({ products: [] })).json().error.details[0].path).toBe("body/products");
    expect((await pod({ serveAll: false })).json().error.details[0].path).toBe("body/area");
    expect((await pod({ products: ["tshirts", "posters"] })).json().error.details[0].path).toBe("body/pricing");
    expect((await pod({ products: ["tshirts", "posters"], prices: [{ product: "posters", basePrice: 9_900 }] })).statusCode).toBe(200);
    expect((await call("PATCH", `/vendor/businesses/${id}`, owner.token, { location: null })).json().error.details[0].path).toBe("body/location");
  });

  it("keeps a live business complete, and opens and closes it", async () => {
    const owner = await vendor();
    const id = await readyBusiness(owner);
    await call("POST", `/vendor/businesses/${id}/publish`, owner.token);

    expect((await call("PATCH", `/vendor/businesses/${id}`, owner.token, { phone: null })).json().error.code).toBe("BUSINESS_INCOMPLETE");
    const [only] = (await call("GET", `/vendor/businesses/${id}`, owner.token)).json().data.photos;
    expect((await call("DELETE", `/vendor/businesses/${id}/photos/${only.id}`, owner.token)).json().error.code).toBe("BUSINESS_INCOMPLETE");
    expect((await call("DELETE", `/vendor/businesses/${id}`, owner.token)).statusCode).toBe(409);

    expect((await call("POST", `/vendor/businesses/${id}/close`, owner.token)).json().data.open).toBe(false);
    await setModule("pod", { live: false });
    expect((await call("POST", `/vendor/businesses/${id}/open`, owner.token)).json().error.code).toBe("MODULE_OFF");
    expect((await call("GET", `/vendor/businesses/${id}`, owner.token)).json().data.moduleLive).toBe(false);
    await setModule("pod", { live: true });
    expect((await call("POST", `/vendor/businesses/${id}/open`, owner.token)).json().data.open).toBe(true);
  });

  it("caps photos at three and deletes a draft with its photos", async () => {
    const owner = await vendor();
    const id = (await create(owner, profile("Mug Corner"))).json().data.id;
    for (let i = 0; i < 3; i++) expect((await upload(id, owner.token)).statusCode).toBe(201);
    expect((await upload(id, owner.token)).statusCode).toBe(409);
    expect((await upload(id, owner.token, Buffer.from("not a photo"))).statusCode).toBe(409);

    const keys = [...stack.media.keys()].filter((key) => key.includes(id));
    expect(keys.length).toBeGreaterThanOrEqual(3);
    const [first] = (await call("GET", `/vendor/businesses/${id}`, owner.token)).json().data.photos;
    expect((await call("DELETE", `/vendor/businesses/${id}/photos/${first.id}`, owner.token)).json().data.photos).toHaveLength(2);

    expect((await call("DELETE", `/vendor/businesses/${id}`, owner.token)).json().data).toEqual({ done: true });
    expect([...stack.media.keys()].filter((key) => key.includes(id))).toEqual([]);
    expect((await call("GET", `/vendor/businesses/${id}`, owner.token)).statusCode).toBe(404);
  });

  it("checks a GSTIN when one is given", async () => {
    const owner = await vendor();
    const id = (await create(owner)).json().data.id;
    verifier.gstinValid = false;
    const bad = await call("PATCH", `/vendor/businesses/${id}`, owner.token, { gstin: "36ABCDE1234F1Z5" });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.details[0].path).toBe("body/gstin");
    verifier.gstinValid = true;
    const good = (await call("PATCH", `/vendor/businesses/${id}`, owner.token, { gstin: "36ABCDE1234F1Z5" })).json().data;
    expect(good.gstin).toMatchObject({ number: "36ABCDE1234F1Z5", status: "Active" });
  });

  it("hides other vendors' businesses", async () => {
    const owner = await vendor();
    const other = await vendor("Ravi Kumar");
    const id = (await create(owner)).json().data.id;
    expect((await call("GET", `/vendor/businesses/${id}`, other.token)).statusCode).toBe(404);
    expect((await call("PATCH", `/vendor/businesses/${id}`, other.token, { name: "Mine now" })).statusCode).toBe(404);
  });

  describe("getting paid", () => {
    it("saves a checked bank account, sealed, and shows only its last 4 digits", async () => {
      const owner = await vendor();
      expect((await call("GET", "/vendor/payout-method", owner.token)).json().data).toBeNull();
      const res = await call("PUT", "/vendor/payout-method", owner.token, { kind: "bank", accountNumber: "026291800001191", ifsc: "YESB0000262" });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ kind: "bank", label: "YES BANK ••1191", holderName: "ASHA RAO", ifsc: "YESB0000262" });
      expect(JSON.stringify(res.json())).not.toContain("026291800001191");

      const stored = await stack.db.payoutMethods.findOne({ userId: owner.userId });
      expect(JSON.stringify(stored)).not.toContain("026291800001191");
      expect(unseal(stored!.bank!.number, stack.app.config.payoutKey!)).toBe("026291800001191");
      expect(await stack.db.auditLogs.findOne({ action: "payout_method.set", "actor.id": owner.userId })).not.toBeNull();

      const payments = (await call("GET", "/vendor/payments", owner.token)).json().data;
      expect(payments).toEqual({ balance: { available: 0, pending: 0, paidOut: 0 }, payoutMethod: expect.objectContaining({ kind: "bank" }), payouts: [] });
    });

    it("switches to UPI and refuses accounts in another name or that fail", async () => {
      const owner = await vendor();
      verifier.accountMatch = "NO_MATCH";
      const other = await call("PUT", "/vendor/payout-method", owner.token, { kind: "upi", vpa: "someone@upi" });
      expect(other.statusCode).toBe(422);
      expect(other.json().error.message).toMatch(/another name/);

      verifier.accountMatch = "DIRECT_MATCH";
      verifier.accountValid = false;
      expect((await call("PUT", "/vendor/payout-method", owner.token, { kind: "upi", vpa: "invalid@upi" })).json().error.code).toBe("KYC_CHECK_FAILED");

      verifier.accountValid = true;
      await call("PUT", "/vendor/payout-method", owner.token, { kind: "bank", accountNumber: "026291800001191", ifsc: "YESB0000262" });
      const upi = (await call("PUT", "/vendor/payout-method", owner.token, { kind: "upi", vpa: "Asha@OKHDFC" })).json().data;
      expect(upi).toMatchObject({ kind: "upi", label: "asha@okhdfc", ifsc: null });
      expect((await stack.db.payoutMethods.findOne({ userId: owner.userId }))!.bank).toBeUndefined();
    });

    it("rejects malformed details before calling Cashfree", async () => {
      const owner = await vendor();
      const calls = verifier.calls;
      expect((await call("PUT", "/vendor/payout-method", owner.token, { kind: "bank", accountNumber: "12", ifsc: "YESB0000262" })).statusCode).toBe(400);
      expect((await call("PUT", "/vendor/payout-method", owner.token, { kind: "upi", vpa: "no-at-sign" })).statusCode).toBe(400);
      expect(verifier.calls).toBe(calls);
    });
  });

  describe("console", () => {
    it("lists businesses with their vendor and finds them by module, state and name", async () => {
      const owner = await vendor("Meera Shah");
      const id = await readyBusiness(owner);
      await call("POST", `/vendor/businesses/${id}/publish`, owner.token);

      const plain = await signIn(stack);
      expect((await call("GET", "/ruxstar/businesses", plain.token)).statusCode).toBe(403);

      const rows = (await call("GET", "/ruxstar/businesses?module=pod&state=live", admin.token)).json().data;
      const row = rows.find((r: { business: { id: string } }) => r.business.id === id);
      expect(row.owner).toMatchObject({ id: owner.userId.toHexString(), name: "Meera Shah" });
      expect((await call("GET", "/ruxstar/businesses?state=draft", admin.token)).json().data.some((r: { business: { id: string } }) => r.business.id === id)).toBe(false);
      expect((await call("GET", "/ruxstar/businesses?q=prints", admin.token)).json().data.some((r: { business: { id: string } }) => r.business.id === id)).toBe(true);
    });

    it("suspends and restores a business, telling the vendor and freezing their changes", async () => {
      const owner = await vendor();
      const id = await readyBusiness(owner);
      await call("POST", `/vendor/businesses/${id}/publish`, owner.token);
      await call("PUT", "/vendor/payout-method", owner.token, { kind: "bank", accountNumber: "026291800001191", ifsc: "YESB0000262" });

      const held = await call("POST", `/ruxstar/businesses/${id}/suspend`, admin.token, { reason: "Photos show someone else's shop" });
      expect(held.statusCode).toBe(200);
      expect(held.json().data).toMatchObject({
        business: { suspension: { reason: "Photos show someone else's shop" } },
        payoutMethod: { label: "YES BANK ••1191" },
        suspendedBy: { id: admin.userId.toHexString() },
      });
      expect(JSON.stringify(held.json())).not.toContain("026291800001191");
      expect((await call("POST", `/ruxstar/businesses/${id}/suspend`, admin.token, { reason: "Again and again" })).statusCode).toBe(409);

      expect((await call("PATCH", `/vendor/businesses/${id}`, owner.token, { name: "New name" })).json().error.code).toBe("BUSINESS_SUSPENDED");
      expect((await call("GET", `/vendor/businesses/${id}`, owner.token)).json().data.suspension).not.toBeNull();
      expect((await call("GET", "/ruxstar/businesses?state=suspended", admin.token)).json().data.some((r: { business: { id: string } }) => r.business.id === id)).toBe(true);

      const inbox = (await call("GET", "/notifications", owner.token)).json().data;
      expect(inbox[0]).toMatchObject({ type: "business.suspended", link: { screen: "business", id } });

      const back = (await call("POST", `/ruxstar/businesses/${id}/restore`, admin.token)).json().data;
      expect(back.business).toMatchObject({ suspension: null, status: "live", open: true });
      expect((await call("GET", "/notifications", owner.token)).json().data[0].type).toBe("business.restored");
      const audit = await stack.db.auditLogs.find({ "target.id": new ObjectId(id), action: { $in: ["business.suspend", "business.restore"] } }).toArray();
      expect(audit).toHaveLength(2);
    });

    it("needs businesses.manage to suspend", async () => {
      const owner = await vendor();
      const id = (await create(owner)).json().data.id;
      const viewer = await signIn(stack, { ruxstarStaff: true });
      await stack.db.ruxstarStaff.insertOne({
        _id: new ObjectId(),
        userId: viewer.userId,
        title: "Support",
        modules: [],
        permissions: ["businesses.view"],
        grantedBy: admin.userId,
        status: "active",
        ...stamp(),
      });
      expect((await call("GET", `/ruxstar/businesses/${id}`, viewer.token)).statusCode).toBe(200);
      expect((await call("POST", `/ruxstar/businesses/${id}/suspend`, viewer.token, { reason: "Not allowed here" })).statusCode).toBe(403);
    });
  });
});
