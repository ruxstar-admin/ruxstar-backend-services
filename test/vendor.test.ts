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

  async function readyBusiness(owner: User, module = "pod") {
    const created = await call("POST", "/vendor/businesses", owner.token, { module, name: "Rao Prints" });
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id as string;
    const patched = await call("PATCH", `/vendor/businesses/${id}`, owner.token, {
      description: "T-shirts, mugs and posters printed to order in Hyderabad.",
      phone: "9876543210",
      address: { line1: "12 Main Road", city: "Hyderabad", state: "Telangana", pincode: "500001" },
    });
    expect(patched.statusCode).toBe(200);
    expect((await upload(id, owner.token)).statusCode).toBe(201);
    return id;
  }

  it("is for verified people only", async () => {
    const plain = await signIn(stack);
    const res = await call("GET", "/vendor/businesses", plain.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("KYC_REQUIRED");
  });

  it("lists the modules and which take new businesses", async () => {
    await setModule("events", { live: true, signupsOpen: false });
    const owner = await vendor();
    const modules = (await call("GET", "/vendor/modules", owner.token)).json().data;
    expect(modules.map((m: { module: string }) => m.module)).toEqual(["pod", "events", "coaching", "stays"]);
    expect(modules[0]).toEqual({ module: "pod", live: true, signupsOpen: true });
    expect(modules[1]).toEqual({ module: "events", live: true, signupsOpen: false });
    expect(modules[2]).toEqual({ module: "coaching", live: false, signupsOpen: false });
  });

  it("creates a draft, says what is missing, then publishes it", async () => {
    const owner = await vendor();
    const created = (await call("POST", "/vendor/businesses", owner.token, { module: "pod", name: "  Rao Prints " })).json().data;
    expect(created).toMatchObject({ name: "Rao Prints", module: "pod", status: "draft", open: false, moduleLive: true });
    expect(created.missing).toEqual(["description", "phone", "address", "photo"]);

    const early = await call("POST", `/vendor/businesses/${created.id}/publish`, owner.token);
    expect(early.statusCode).toBe(422);
    expect(early.json().error.code).toBe("BUSINESS_INCOMPLETE");

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

  it("refuses new businesses while a module is off or not taking signups", async () => {
    const owner = await vendor();
    expect((await call("POST", "/vendor/businesses", owner.token, { module: "stays", name: "Lake House" })).json().error.code).toBe("MODULE_OFF");
    await setModule("stays", { live: true, signupsOpen: false });
    expect((await call("POST", "/vendor/businesses", owner.token, { module: "stays", name: "Lake House" })).json().error.code).toBe("SIGNUPS_CLOSED");
    await setModule("stays", { live: false });
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
    const id = (await call("POST", "/vendor/businesses", owner.token, { module: "pod", name: "Mug Corner" })).json().data.id;
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
    const id = (await call("POST", "/vendor/businesses", owner.token, { module: "pod", name: "Rao Prints" })).json().data.id;
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
    const id = (await call("POST", "/vendor/businesses", owner.token, { module: "pod", name: "Rao Prints" })).json().data.id;
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
      const id = (await call("POST", "/vendor/businesses", owner.token, { module: "pod", name: "Rao Prints" })).json().data.id;
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
