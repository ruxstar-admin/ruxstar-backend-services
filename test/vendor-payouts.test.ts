import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakePayouts } from "../src/adapters/payouts.js";
import { stamp } from "../src/platform/db.js";
import { seal } from "../src/platform/sealed.js";
import { JOB_TOKEN, signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>>;

describe("vendor withdrawals", () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack?.stop());
  beforeEach(async () => {
    await Promise.all([
      stack.db.payouts.deleteMany({}),
      stack.db.payoutMethods.deleteMany({}),
      stack.db.riderPayoutMethods.deleteMany({}),
      stack.db.ledgerEntries.deleteMany({}),
      stack.db.notifications.deleteMany({}),
      stack.db.idempotencyKeys.deleteMany({}),
    ]);
    await stack.db.moduleSettings.updateOne({ module: "ledger" }, { $unset: { payoutFee: "", minPayout: "" } });
    fake().transfers.clear();
    fake().next = "paid";
  });

  const fake = () => stack.app.payouts as FakePayouts;
  const call = (method: "GET" | "POST" | "PATCH", url: string, token: string, payload?: object, key: string = randomUUID()) =>
    stack.app.inject({
      method,
      url: `/v1${url}`,
      headers: web(token, method === "GET" ? {} : { "idempotency-key": key }),
      ...(payload ? { payload } : {}),
    });
  const sweep = () => stack.app.inject({ method: "POST", url: "/jobs/orders", headers: { authorization: `Bearer ${JOB_TOKEN}` } });
  const payments = async (user: User) => (await call("GET", "/vendor/payments", user.token)).json().data;
  const withdraw = (user: User, key?: string) => call("POST", "/vendor/payouts", user.token, undefined, key);

  /** A vendor with a checked bank account and `available` paise released to their balance. */
  async function vendor(available: number, method: "bank" | "upi" = "bank") {
    const user = await signIn(stack, { vendor: true });
    await stack.db.users.updateOne({ _id: user.userId }, { $set: { name: "Asha Rao" } });
    await stack.db.payoutMethods.insertOne({
      _id: new ObjectId(),
      userId: user.userId,
      kind: method,
      holderName: "ASHA RAO",
      nameMatch: "DIRECT_MATCH",
      ...(method === "bank"
        ? { bank: { number: seal("026291800001191", stack.app.config.payoutKey!), last4: "1191", ifsc: "YESB0000262", bankName: "YES BANK" } }
        : { upi: { vpa: "asha@okhdfc" } }),
      verifiedAt: new Date(),
      ...stamp(),
    });
    if (available) {
      await stack.db.ledgerEntries.insertMany([
        { txnId: `release:${randomUUID()}`, kind: "release", accountId: `vendor:${user.userId.toHexString()}`, bucket: "withdrawable", signedPaise: available, source: { type: "pod_order", id: new ObjectId() }, at: new Date() },
        { txnId: `release:${randomUUID()}`, kind: "release", accountId: "gateway", bucket: "withdrawable", signedPaise: -available, source: { type: "pod_order", id: new ObjectId() }, at: new Date() },
      ]);
    }
    return user;
  }

  it("withdraws everything available less the fee, to the account checked when it was asked for", async () => {
    const owner = await vendor(50_000);
    expect((await payments(owner)).withdrawal).toEqual({ minimum: 10_000, fee: 590 });

    const res = await withdraw(owner);
    expect(res.statusCode).toBe(200);
    const payout = res.json().data;
    expect(payout).toMatchObject({ amount: 50_000, fee: 590, status: "paid", to: "YES BANK ••1191", utr: expect.any(String), failure: null });
    const [transfer] = [...fake().transfers.values()];
    expect(transfer).toMatchObject({ amount: 49_410, name: "ASHA RAO", to: { kind: "bank", accountNumber: "026291800001191", ifsc: "YESB0000262" } });

    expect((await payments(owner)).balance).toEqual({ available: 0, pending: 0, paidOut: 50_000 });
    const lines = (await call("GET", "/vendor/payments/statement", owner.token)).json().data;
    expect(lines[0]).toMatchObject({ kind: "withdrawal", amount: -50_000, module: "ledger", order: null, payout: { id: payout.id, to: "YES BANK ••1191" } });
    const entries = await stack.db.ledgerEntries.find({}).toArray();
    expect(entries.reduce((sum, e) => sum + e.signedPaise, 0)).toBe(0);
    expect(entries.find((e) => e.accountId === "ruxstar")).toMatchObject({ kind: "payout", signedPaise: 590 });
    const inbox = await call("GET", "/notifications", owner.token);
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().data).toEqual([
      expect.objectContaining({ type: "payout.updated", title: "₹494.10 sent", link: { screen: "payments", id: payout.id } }),
    ]);
    expect(await stack.db.auditLogs.findOne({ action: "payout.request", "target.id": new ObjectId(payout.id) })).not.toBeNull();

    // Asking again with the same key answers the same payout; a new key finds nothing left.
    const key = randomUUID();
    const more = await vendor(20_000, "upi");
    const first = (await withdraw(more, key)).json().data;
    expect((await withdraw(more, key)).json().data.id).toBe(first.id);
    expect([...fake().transfers.values()].at(-1)).toMatchObject({ amount: 19_410, to: { kind: "upi", vpa: "asha@okhdfc" } });
    expect((await withdraw(more)).json().error.code).toBe("PAYOUT_TOO_SMALL");
  });

  it("needs a payout account, the minimum available, and the vendor role", async () => {
    const customer = await signIn(stack);
    expect((await withdraw(customer)).statusCode).toBe(403);

    const owner = await vendor(9_999);
    expect((await withdraw(owner)).json().error).toMatchObject({ code: "PAYOUT_TOO_SMALL", message: "You can withdraw once ₹100 is available." });
    await stack.db.payoutMethods.deleteMany({ userId: owner.userId });
    expect((await withdraw(owner)).json().error.code).toBe("PAYOUT_METHOD_REQUIRED");
    expect(fake().transfers.size).toBe(0);
  });

  it("puts a failed withdrawal back in the balance and says why", async () => {
    const owner = await vendor(50_000);
    fake().next = "failed";
    const payout = (await withdraw(owner)).json().data;
    expect(payout).toMatchObject({ status: "failed", failure: "The bank couldn't complete it. Try again in a while." });
    expect((await payments(owner)).balance).toEqual({ available: 50_000, pending: 0, paidOut: 0 });
    const lines = (await call("GET", "/vendor/payments/statement", owner.token)).json().data;
    expect(lines.map((l: { kind: string; amount: number }) => [l.kind, l.amount])).toEqual([
      ["returned", 50_000],
      ["withdrawal", -50_000],
    ]);
    expect(await stack.db.notifications.findOne({ userId: owner.userId, title: "Withdrawal didn't go through" })).not.toBeNull();
    expect((await withdraw(owner)).json().data.status).toBe("paid");
  });

  it("keeps one withdrawal on the way at a time and settles it when the bank answers", async () => {
    const owner = await vendor(50_000);
    fake().next = "pending";
    const payout = (await withdraw(owner)).json().data;
    expect(payout.status).toBe("pending");
    expect((await payments(owner)).balance).toMatchObject({ available: 0, paidOut: 0 });
    expect((await withdraw(owner)).json().error.code).toBe("PAYOUT_IN_PROGRESS");

    const doc = await stack.db.payouts.findOne({ _id: new ObjectId(payout.id) });
    fake().settle(doc!.transferId, "paid");
    expect((await sweep()).json().payouts).toMatchObject({ checked: 0 });
    await stack.db.payouts.updateOne({ _id: doc!._id }, { $set: { checkedAt: new Date(Date.now() - 61_000) } });
    expect((await sweep()).json().payouts).toEqual({ checked: 1, paid: 1, failed: 0 });
    expect((await payments(owner)).payouts[0]).toMatchObject({ id: payout.id, status: "paid", paidAt: expect.any(String) });
  });

  it("keeps one withdrawal on the way for someone paid both as a vendor and as a delivery partner", async () => {
    const owner = await vendor(50_000);
    await stack.db.users.updateOne({ _id: owner.userId }, { $set: { "roles.delivery": true, "kyc.delivery": "approved" } });
    const method = (await stack.db.payoutMethods.findOne({ userId: owner.userId }))!;
    await stack.db.riderPayoutMethods.insertOne({ ...method, _id: new ObjectId() });
    await stack.db.ledgerEntries.insertMany([
      { txnId: `rider_release:${randomUUID()}`, kind: "rider_release", accountId: `rider:${owner.userId.toHexString()}`, bucket: "withdrawable", signedPaise: 20_000, source: { type: "pod_order", id: new ObjectId() }, at: new Date() },
      { txnId: `rider_release:${randomUUID()}`, kind: "rider_release", accountId: `rider:${owner.userId.toHexString()}`, bucket: "pending", signedPaise: -20_000, source: { type: "pod_order", id: new ObjectId() }, at: new Date() },
    ]);
    fake().next = "pending";
    expect((await withdraw(owner)).json().data.status).toBe("pending");
    const partner = await call("POST", "/delivery/payouts", owner.token);
    expect(partner.json().error).toMatchObject({ code: "PAYOUT_IN_PROGRESS", message: expect.stringContaining("shop earnings") });
    expect((await payments(owner)).balance.available).toBe(0);
    expect((await call("GET", "/delivery/earnings", owner.token)).json().data.balance).toEqual({ available: 20_000, pending: 0, paidOut: 0 });
  });

  it("sends again a withdrawal Cashfree never got, and gives up after three tries", async () => {
    const owner = await vendor(50_000);
    fake().next = "down";
    const payout = (await withdraw(owner)).json().data;
    expect(payout.status).toBe("pending");
    const id = new ObjectId(payout.id);
    await stack.db.payouts.updateOne({ _id: id }, { $set: { checkedAt: new Date(Date.now() - 61_000) } });
    // Opening Payments checks on it too.
    expect((await payments(owner)).payouts[0]).toMatchObject({ status: "paid" });
    expect(await stack.db.payouts.findOne({ _id: id })).toMatchObject({ attempts: 2 });

    const other = await vendor(30_000);
    fake().next = "down";
    const stuck = new ObjectId((await withdraw(other)).json().data.id);
    await stack.db.payouts.updateOne({ _id: stuck }, { $set: { attempts: 3, checkedAt: null } });
    expect((await sweep()).json().payouts).toEqual({ checked: 1, paid: 0, failed: 1 });
    expect((await payments(other)).balance.available).toBe(30_000);
  });

  it("shows the Ruxstar team every withdrawal and lets them ask Cashfree about one on the way", async () => {
    const owner = await vendor(50_000);
    fake().next = "pending";
    const payout = (await withdraw(owner)).json().data;
    const failing = await vendor(30_000, "upi");
    fake().next = "failed";
    await withdraw(failing);

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
    expect((await call("GET", "/ruxstar/payouts", owner.token)).statusCode).toBe(403);
    const queue = (await call("GET", "/ruxstar/payouts", viewer.token)).json().data;
    expect(queue).toEqual([
      expect.objectContaining({ id: payout.id, payee: "vendor", vendor: { id: owner.userId.toHexString(), name: "Asha Rao" }, amount: 50_000, fee: 590, status: "pending", attempts: 1, failure: null }),
    ]);
    const failed = (await call("GET", "/ruxstar/payouts?status=failed", viewer.token)).json().data;
    expect(failed[0]).toMatchObject({ to: "asha@okhdfc", failure: { code: "BENE_BANK_DECLINED", text: "The bank couldn't complete it. Try again in a while." } });

    const check = (token: string) => call("POST", `/ruxstar/payouts/${payout.id}/check`, token);
    expect((await check(viewer.token)).statusCode).toBe(403);
    const admin = await signIn(stack, { admin: true });
    expect((await check(admin.token)).json().data).toMatchObject({ status: "pending" });
    fake().settle(queue[0].transferId, "paid");
    expect((await check(admin.token)).json().data).toMatchObject({ status: "paid", utr: expect.any(String), paidAt: expect.any(String) });
    expect((await check(admin.token)).json().error.code).toBe("CONFLICT");
    expect((await call("GET", "/ruxstar/payouts?status=paid", admin.token)).json().data.map((p: { id: string }) => p.id)).toEqual([payout.id]);
  });

  it("takes the fee and minimum Ruxstar sets on the ledger module", async () => {
    const admin = await signIn(stack, { admin: true });
    const patch = (module: string, body: object) => call("PATCH", `/ruxstar/modules/${module}`, admin.token, body);
    expect((await patch("pod", { payoutFee: 1_000 })).json().error.code).toBe("VALIDATION_FAILED");
    expect((await patch("ledger", { payoutFee: 1_000, minPayout: 1_050 })).json().error.details[0].path).toBe("body/minPayout");
    const res = await patch("ledger", { payoutFee: 1_000, minPayout: 20_000 });
    expect(res.json().data.payouts).toEqual({ fee: 1_000, minimum: 20_000 });
    const listed = (await call("GET", "/ruxstar/modules", admin.token)).json().data;
    expect(listed.find((m: { module: string }) => m.module === "pod").payouts).toBeNull();
    expect(listed.find((m: { module: string }) => m.module === "delivery").payouts).toEqual({ fee: 590, minimum: 10_000 });
    expect(await stack.db.auditLogs.findOne({ action: "module_settings.update", "scope.module": "ledger" })).not.toBeNull();

    const owner = await vendor(19_999);
    expect((await withdraw(owner)).json().error.message).toBe("You can withdraw once ₹200 is available.");
    await stack.db.ledgerEntries.insertOne({
      txnId: `release:${randomUUID()}`,
      kind: "release",
      accountId: `vendor:${owner.userId.toHexString()}`,
      bucket: "withdrawable",
      signedPaise: 1,
      source: { type: "pod_order", id: new ObjectId() },
      at: new Date(),
    });
    expect((await withdraw(owner)).json().data).toMatchObject({ amount: 20_000, fee: 1_000 });
  });
});
