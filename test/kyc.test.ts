import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeVerifier } from "../src/adapters/verification.js";
import { signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>>;

describe("kyc", () => {
  let stack: Stack;
  let verifier: FakeVerifier;
  let admin: User;
  let selfie: Buffer;

  beforeAll(async () => {
    verifier = new FakeVerifier();
    stack = await startStack(undefined, { verifier });
    admin = await signIn(stack, { admin: true });
    selfie = await sharp({ create: { width: 480, height: 640, channels: 3, background: "#c08060" } }).jpeg().toBuffer();
  });
  afterAll(() => stack?.stop());
  beforeEach(() => Object.assign(verifier, new FakeVerifier()));

  const get = (url: string, token: string) => stack.app.inject({ url, headers: web(token) });
  const post = (url: string, token: string, payload?: object) =>
    stack.app.inject({ method: "POST", url, headers: web(token), ...(payload ? { payload } : {}) });
  const sendSelfie = (token: string, body = selfie) =>
    stack.app.inject({ method: "POST", url: "/v1/kyc/base/face", headers: web(token, { "content-type": "image/jpeg" }), payload: body });
  const review = (id: string, action: "approve" | "reject", payload?: object, token = admin.token) =>
    stack.app.inject({
      method: "POST",
      url: `/v1/ruxstar/kyc/${id}/${action}`,
      headers: web(token, { "idempotency-key": randomUUID() }),
      ...(payload ? { payload } : {}),
    });

  /** A fresh user with a named profile. */
  async function person(name = "Asha Rao") {
    const user = await signIn(stack);
    await stack.db.users.updateOne({ _id: user.userId }, { $set: { name, username: `u${user.userId.toHexString().slice(-8)}` } });
    return user;
  }

  /** Runs the three identity steps and submits, returning the case id. */
  async function submitIdentity(user: User, pan = `ABCDE${String(Math.floor(Math.random() * 9000) + 1000)}F`) {
    expect((await post("/v1/kyc/base/aadhaar", user.token)).statusCode).toBe(200);
    expect((await post("/v1/kyc/base/aadhaar/check", user.token)).statusCode).toBe(200);
    expect((await post("/v1/kyc/base/pan", user.token, { pan })).statusCode).toBe(200);
    expect((await sendSelfie(user.token)).statusCode).toBe(200);
    const res = await post("/v1/kyc/base/submit", user.token);
    expect(res.statusCode).toBe(200);
    const doc = await stack.db.kycCases.findOne({ userId: user.userId, track: "base" });
    return doc!._id.toHexString();
  }

  it("starts with nothing to show", async () => {
    const user = await person();
    const res = await get("/v1/kyc", user.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.base.status).toBe("not_started");
    expect(res.json().data.vendor.status).toBe("not_started");
    expect((await get("/v1/kyc/card", user.token)).statusCode).toBe(403);
  });

  it("walks identity through DigiLocker, PAN and selfie to review", async () => {
    const user = await person();
    const start = await post("/v1/kyc/base/aadhaar", user.token);
    expect(start.json().data.url).toContain("verification_id=");

    const checked = (await post("/v1/kyc/base/aadhaar/check", user.token)).json().data.base;
    expect(checked.steps.aadhaar).toMatchObject({ status: "verified", name: "Asha Rao", last4: "1234" });

    const panned = (await post("/v1/kyc/base/pan", user.token, { pan: "ABCDE1234F" })).json().data.base;
    expect(panned.steps.pan).toMatchObject({ status: "verified", masked: "AB******4F" });

    const faced = (await sendSelfie(user.token)).json().data.base;
    expect(faced.steps.face.status).toBe("verified");
    const stored = await stack.db.kycCases.findOne({ userId: user.userId, track: "base" });
    expect(stored!.steps.aadhaar!.photo).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain("ABCDE1234F");

    const submitted = (await post("/v1/kyc/base/submit", user.token)).json().data.base;
    expect(submitted.status).toBe("submitted");
    expect((await stack.db.users.findOne({ _id: user.userId }))!.kyc.base).toBe("pending");

    const again = await post("/v1/kyc/base/pan", user.token, { pan: "ABCDE1234F" });
    expect(again.statusCode).toBe(409);
  });

  it("keeps the steps in order", async () => {
    const user = await person();
    expect((await post("/v1/kyc/base/pan", user.token, { pan: "ABCDE1234F" })).json().error.code).toBe("KYC_STEP_ORDER");
    expect((await sendSelfie(user.token)).json().error.code).toBe("KYC_STEP_ORDER");
    expect((await post("/v1/kyc/base/submit", user.token)).json().error.code).toBe("KYC_STEP_ORDER");
    expect((await stack.app.inject({ method: "PUT", url: "/v1/kyc/vendor", headers: web(user.token), payload: business() })).json().error.code).toBe(
      "KYC_REQUIRED",
    );
  });

  it("waits while DigiLocker is pending and fails when it expires", async () => {
    const user = await person();
    verifier.digilocker = "pending";
    await post("/v1/kyc/base/aadhaar", user.token);
    expect((await post("/v1/kyc/base/aadhaar/check", user.token)).json().data.base.steps.aadhaar.status).toBe("pending");
    verifier.digilocker = "expired";
    const expired = (await post("/v1/kyc/base/aadhaar/check", user.token)).json().data.base.steps.aadhaar;
    expect(expired.status).toBe("failed");
    expect(expired.reason).toMatch(/expired/);
  });

  it("refuses a PAN whose name does not match, or that another account verified", async () => {
    const first = await person();
    await post("/v1/kyc/base/aadhaar", first.token);
    await post("/v1/kyc/base/aadhaar/check", first.token);
    verifier.nameMatch = "NO_MATCH";
    const mismatch = await post("/v1/kyc/base/pan", first.token, { pan: "PQRST1234Z" });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json().error.code).toBe("KYC_CHECK_FAILED");
    verifier.nameMatch = "DIRECT_MATCH";
    expect((await post("/v1/kyc/base/pan", first.token, { pan: "PQRST1234Z" })).statusCode).toBe(200);

    const second = await person();
    await post("/v1/kyc/base/aadhaar", second.token);
    await post("/v1/kyc/base/aadhaar/check", second.token);
    const calls = verifier.calls;
    const taken = await post("/v1/kyc/base/pan", second.token, { pan: "PQRST1234Z" });
    expect(taken.statusCode).toBe(422);
    expect(taken.json().error.message).toMatch(/another Ruxstar account/);
    expect(verifier.calls).toBe(calls);
  });

  it("rejects badly formed PANs before calling Cashfree", async () => {
    const user = await person();
    const calls = verifier.calls;
    expect((await post("/v1/kyc/base/pan", user.token, { pan: "abc" })).statusCode).toBe(400);
    expect(verifier.calls).toBe(calls);
  });

  it("explains a failed selfie and drops the Aadhaar photo after the fifth", async () => {
    const user = await person();
    await post("/v1/kyc/base/aadhaar", user.token);
    await post("/v1/kyc/base/aadhaar/check", user.token);
    await post("/v1/kyc/base/pan", user.token, { pan: "LMNOP1234Q" });

    verifier.live = false;
    const notLive = await sendSelfie(user.token);
    expect(notLive.statusCode).toBe(422);
    expect(notLive.json().error.message).toMatch(/live photo/);

    verifier.live = true;
    verifier.match = false;
    for (let i = 0; i < 3; i++) expect((await sendSelfie(user.token)).statusCode).toBe(422);
    const fifth = await sendSelfie(user.token);
    expect(fifth.json().error.message).toMatch(/does not match/);
    expect((await stack.db.kycCases.findOne({ userId: user.userId, track: "base" }))!.steps.aadhaar!.photo).toBeUndefined();
    const sixth = await sendSelfie(user.token);
    expect(sixth.json().error).toMatchObject({ code: "KYC_STEP_ORDER", message: expect.stringMatching(/Aadhaar again/) });
  });

  it("limits each step to five tries a day", async () => {
    const user = await person();
    verifier.digilocker = "pending";
    for (let i = 0; i < 5; i++) expect((await post("/v1/kyc/base/aadhaar", user.token)).statusCode).toBe(200);
    expect((await post("/v1/kyc/base/aadhaar", user.token)).statusCode).toBe(429);
  });

  it("refuses files that are not photos", async () => {
    const user = await person();
    await post("/v1/kyc/base/aadhaar", user.token);
    await post("/v1/kyc/base/aadhaar/check", user.token);
    await post("/v1/kyc/base/pan", user.token, { pan: "FGHIJ1234K" });
    const res = await sendSelfie(user.token, Buffer.from("not an image"));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("PHOTO_INVALID");
  });

  it("says so when Cashfree is down", async () => {
    const user = await person();
    verifier.down = true;
    const res = await post("/v1/kyc/base/aadhaar", user.token);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("KYC_UNAVAILABLE");
  });

  describe("review", () => {
    it("is for admins and granted staff only", async () => {
      const user = await person();
      expect((await get("/v1/ruxstar/kyc", user.token)).statusCode).toBe(403);
      const id = await submitIdentity(user);
      expect((await review(id, "approve", undefined, user.token)).statusCode).toBe(403);
    });

    it("lists submitted cases without the Aadhaar photo or full PAN", async () => {
      const user = await person("Ravi Kumar");
      verifier.aadhaarName = "Ravi Kumar";
      const id = await submitIdentity(user);
      const res = await get("/v1/ruxstar/kyc", admin.token);
      expect(res.statusCode).toBe(200);
      const item = res.json().data.find((c: { id: string }) => c.id === id);
      expect(item).toMatchObject({ track: "base", status: "submitted", user: { name: "Ravi Kumar" } });
      expect(item.identity).toMatchObject({ aadhaarName: "Ravi Kumar", aadhaarLast4: "1234", nameMatch: "DIRECT_MATCH" });
      expect(item.identity.panMasked).toMatch(/^AB\*{6}\dF$/);
      expect(JSON.stringify(item)).not.toContain("photo");
      expect((await get(`/v1/ruxstar/kyc/${id}`, admin.token)).json().data.id).toBe(id);
    });

    it("approves identity: card, Verified tick, notification and audit", async () => {
      const user = await person();
      const id = await submitIdentity(user);
      const res = await review(id, "approve");
      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe("approved");

      const card = (await get("/v1/kyc/card", user.token)).json().data;
      expect(card.id).toMatch(/^RUX-[0-9A-F]{4}-[0-9A-F]{4}$/);
      expect(card).toMatchObject({ name: "Asha Rao", aadhaar: "XXXX XXXX 1234", vendor: false });
      expect(card.profileUrl).toContain("ruxstar.com");

      const me = (await get("/v1/account/me", user.token)).json().data;
      expect(me.kyc.base).toBe("approved");
      expect(me.card.id).toBe(card.id);

      const inbox = (await get("/v1/notifications", user.token)).json().data;
      expect(inbox[0]).toMatchObject({ kind: "account", type: "kyc.approved", link: { screen: "verification", id: "base" } });

      const audit = await stack.db.auditLogs.findOne({ action: "kyc.approve", "actor.id": admin.userId, "target.id": new ObjectId(id) });
      expect(audit).not.toBeNull();
      expect((await review(id, "approve")).statusCode).toBe(409);
    });

    it("rejects with a reason the user sees, and locks after the third", async () => {
      const user = await person();
      let id = await submitIdentity(user);
      for (let round = 1; round <= 3; round++) {
        const res = await review(id, "reject", { reason: `Selfie is blurry, round ${round}` });
        expect(res.statusCode).toBe(200);
        const base = (await get("/v1/kyc", user.token)).json().data.base;
        if (round < 3) {
          expect(base).toMatchObject({ status: "rejected", rejectionReason: `Selfie is blurry, round ${round}`, rejectionsLeft: 3 - round });
          expect((await post("/v1/kyc/base/submit", user.token)).statusCode).toBe(200);
          id = (await stack.db.kycCases.findOne({ userId: user.userId, track: "base" }))!._id.toHexString();
        } else {
          expect(base.status).toBe("locked");
          expect((await post("/v1/kyc/base/aadhaar", user.token)).json().error.code).toBe("KYC_LOCKED");
        }
      }
      expect((await stack.db.users.findOne({ _id: user.userId }))!.kyc.base).toBe("rejected");
    });
  });

  describe("vendor", () => {
    it("needs approved identity, takes business details and makes the user a vendor", async () => {
      const user = await person();
      await review(await submitIdentity(user), "approve");

      const saved = await stack.app.inject({ method: "PUT", url: "/v1/kyc/vendor", headers: web(user.token), payload: business() });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().data.vendor.business).toMatchObject({ name: "Rao Stores", gstin: null });
      expect((await post("/v1/kyc/vendor/submit", user.token)).statusCode).toBe(200);

      const vendorCase = await stack.db.kycCases.findOne({ userId: user.userId, track: "vendor" });
      expect((await review(vendorCase!._id.toHexString(), "approve")).statusCode).toBe(200);
      const after = await stack.db.users.findOne({ _id: user.userId });
      expect(after!.roles.vendor).toBe(true);
      expect(after!.kyc.vendor).toBe("approved");
      expect((await get("/v1/kyc/card", user.token)).json().data.vendor).toBe(true);
    });

    it("checks a GSTIN when one is given", async () => {
      const user = await person();
      await review(await submitIdentity(user), "approve");
      verifier.gstinValid = false;
      const bad = await stack.app.inject({
        method: "PUT",
        url: "/v1/kyc/vendor",
        headers: web(user.token),
        payload: business({ gstin: "36ABCDE1234F1Z5" }),
      });
      expect(bad.statusCode).toBe(422);
      expect(bad.json().error.details[0].path).toBe("body/gstin");

      verifier.gstinValid = true;
      const good = await stack.app.inject({
        method: "PUT",
        url: "/v1/kyc/vendor",
        headers: web(user.token),
        payload: business({ gstin: "36ABCDE1234F1Z5" }),
      });
      expect(good.json().data.vendor.business.gstin).toMatchObject({ number: "36ABCDE1234F1Z5", status: "Active" });
    });
  });
});

function business(extra: Record<string, unknown> = {}) {
  return {
    businessName: "Rao Stores",
    address: { line1: "12 Main Road", city: "Hyderabad", state: "Telangana", pincode: "500001" },
    ...extra,
  };
}
