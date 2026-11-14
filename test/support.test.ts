import { randomInt, randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/modules/account/passwords.js";
import { stamp } from "../src/platform/db.js";
import { signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>>;
const HOUR = 60 * 60_000;

describe("support", () => {
  let stack: Stack;
  let admin: User;
  let photo: Buffer;

  beforeAll(async () => {
    stack = await startStack();
    admin = await signIn(stack, { admin: true });
    await stack.db.users.updateOne({ _id: admin.userId }, { $set: { name: "Asha Admin" } });
    photo = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#7040a0" } }).jpeg().toBuffer();
  });
  afterAll(() => stack?.stop());

  const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, token: string, payload?: object) =>
    stack.app.inject({
      method,
      url: `/v1${url}`,
      headers: web(token, method === "GET" ? {} : { "idempotency-key": randomUUID() }),
      ...(payload ? { payload } : {}),
    });

  async function person(name: string) {
    const user = await signIn(stack);
    await stack.db.users.updateOne({ _id: user.userId }, { $set: { name, username: `${name.toLowerCase().split(" ")[0]}${user.userId.toHexString().slice(-4)}` } });
    return user;
  }

  async function staffWith(...permissions: string[]) {
    const user = await person("Desk Staff");
    await stack.db.users.updateOne({ _id: user.userId }, { $set: { "roles.ruxstarStaff": true } });
    await stack.db.ruxstarStaff.insertOne({ _id: new ObjectId(), userId: user.userId, title: "Support", modules: [], permissions, grantedBy: admin.userId, status: "active", ...stamp() });
    return user;
  }

  const open = (token: string, body: object = {}) =>
    call("POST", "/support/tickets", token, { category: "orders", subject: "Print never came", text: "Ordered on Monday, nothing yet.", ...body });

  it("opens a ticket and keeps it to its owner", async () => {
    const customer = await person("Ravi Kumar");
    const res = await open(customer.token);
    expect(res.statusCode).toBe(200);
    const ticket = res.json().data;
    expect(ticket).toMatchObject({ category: "orders", subject: "Print never came", status: "open", context: null, unread: false, resolvedAt: null });
    expect(ticket.number).toMatch(/^RX-10\d\d$/);
    expect(ticket.messages).toEqual([expect.objectContaining({ from: "customer", text: "Ordered on Monday, nothing yet.", mine: true, photos: [] })]);

    const list = (await call("GET", "/support/tickets", customer.token)).json().data;
    expect(list.map((t: { id: string }) => t.id)).toEqual([ticket.id]);

    const stranger = await person("Someone Else");
    expect((await call("GET", `/support/tickets/${ticket.id}`, stranger.token)).statusCode).toBe(404);
    expect((await call("GET", "/support/tickets", stranger.token)).json().data).toEqual([]);
    expect((await call("POST", "/support/tickets", customer.token, { category: "orders", subject: "Hi", text: "x" })).statusCode).toBe(400);
  });

  it("checks what a ticket is about", async () => {
    const customer = await person("Meera Shah");
    const author = await person("Post Author");
    const postId = new ObjectId();
    await stack.db.posts.insertOne({ _id: postId, authorId: author.userId, kind: "personal", text: "Spam", media: [], counts: { likes: 0, comments: 0 }, status: "live", editedAt: null, ...stamp() });

    const about = await open(customer.token, { category: "safety", subject: "Scam post", context: { type: "post", id: postId.toHexString() } });
    expect(about.json().data.context).toEqual({ type: "post", id: postId.toHexString(), label: expect.stringMatching(/^Post by @post/) });

    expect((await open(customer.token, { context: { type: "business", id: new ObjectId().toHexString() } })).statusCode).toBe(404);
    expect((await open(customer.token, { context: { type: "order", id: "nope" } })).statusCode).toBe(400);
    expect((await open(customer.token, { context: { type: "verification", id: "base" } })).statusCode).toBe(404);
  });

  it("caps open tickets", async () => {
    const busy = await person("Busy Person");
    for (let i = 0; i < 5; i++) expect((await open(busy.token)).statusCode).toBe(200);
    const sixth = await open(busy.token);
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json().error.message).toMatch(/5 open tickets/);
  });

  it("works the queue: reply, note, assign, priority and resolve", async () => {
    const customer = await person("Kiran Rao");
    const ticket = (await open(customer.token, { category: "refunds", subject: "Refund missing", text: "Cancelled, no refund." })).json().data;

    const viewer = await staffWith("support.view");
    const agent = await staffWith("support.view", "support.manage");
    const outsider = await person("Not Staff");
    expect((await call("GET", "/ruxstar/support/tickets", outsider.token)).statusCode).toBe(403);

    const queue = (await call("GET", "/ruxstar/support/tickets", viewer.token)).json().data;
    const row = queue.find((t: { id: string }) => t.id === ticket.id);
    expect(row).toMatchObject({ priority: "high", status: "open", assignee: null, overdue: false, requester: { name: "Kiran Rao", status: "active" } });
    expect(new Date(row.slaDueAt).getTime() - new Date(row.createdAt).getTime()).toBe(8 * HOUR);
    expect((await call("GET", `/ruxstar/support/tickets?q=${ticket.number}`, viewer.token)).json().data.map((t: { id: string }) => t.id)).toEqual([ticket.id]);

    expect((await call("POST", `/ruxstar/support/tickets/${ticket.id}/messages`, viewer.token, { text: "On it" })).statusCode).toBe(403);

    const noted = await call("POST", `/ruxstar/support/tickets/${ticket.id}/messages`, agent.token, { text: "Check Cashfree first", internal: true });
    expect(noted.json().data).toMatchObject({ status: "open", assignee: null });
    expect((await call("GET", `/support/tickets/${ticket.id}`, customer.token)).json().data.messages).toHaveLength(1);

    const replied = (await call("POST", `/ruxstar/support/tickets/${ticket.id}/messages`, agent.token, { text: "Your refund is on the way." })).json().data;
    expect(replied).toMatchObject({ status: "waiting", slaDueAt: null, lastFrom: "staff", assignee: { id: agent.userId.toHexString(), name: "Desk Staff" } });
    expect(replied.messages.map((m: { internal: boolean }) => m.internal)).toEqual([false, true, false]);
    const told = await stack.db.notifications.find({ userId: customer.userId, type: "support.replied" }).toArray();
    expect(told.map((n) => [n.body, n.link])).toEqual([["Your refund is on the way.", { screen: "support", id: ticket.id }]]);

    expect((await call("GET", "/support/tickets", customer.token)).json().data[0]).toMatchObject({ id: ticket.id, unread: true, status: "waiting" });
    const seen = (await call("GET", `/support/tickets/${ticket.id}`, customer.token)).json().data;
    expect(seen).toMatchObject({ unread: false });
    expect(seen.messages.map((m: { from: string; mine: boolean }) => [m.from, m.mine])).toEqual([["customer", true], ["staff", false]]);

    const answered = (await call("POST", `/support/tickets/${ticket.id}/messages`, customer.token, { text: "Still nothing after 3 days." })).json().data;
    expect(answered.status).toBe("open");
    const urgent = (await call("PATCH", `/ruxstar/support/tickets/${ticket.id}`, agent.token, { priority: "urgent" })).json().data;
    const since = (await stack.db.supportTickets.findOne({ _id: new ObjectId(ticket.id) }))!.awaitingSince!;
    expect(new Date(urgent.slaDueAt).getTime()).toBe(since.getTime() + 2 * HOUR);

    expect((await call("PATCH", `/ruxstar/support/tickets/${ticket.id}`, agent.token, { assigneeId: outsider.userId.toHexString() })).statusCode).toBe(400);
    const handed = (await call("PATCH", `/ruxstar/support/tickets/${ticket.id}`, agent.token, { assigneeId: admin.userId.toHexString() })).json().data;
    expect(handed.assignee).toEqual({ id: admin.userId.toHexString(), name: "Asha Admin" });

    const resolved = (await call("PATCH", `/ruxstar/support/tickets/${ticket.id}`, agent.token, { status: "resolved" })).json().data;
    expect(resolved).toMatchObject({ status: "resolved", slaDueAt: null });
    expect(await stack.db.notifications.countDocuments({ userId: customer.userId, type: "support.resolved" })).toBe(1);
    expect(await stack.db.auditLogs.countDocuments({ "target.id": new ObjectId(ticket.id), action: { $in: ["support.note", "support.reply", "support.update"] } })).toBe(5);

    const reopened = (await call("POST", `/support/tickets/${ticket.id}/messages`, customer.token, { text: "It bounced back." })).json().data;
    expect(reopened).toMatchObject({ status: "open", resolvedAt: null });

    expect((await call("POST", `/support/tickets/${ticket.id}/resolve`, customer.token)).json().data.status).toBe("resolved");
    await stack.db.supportTickets.updateOne({ _id: new ObjectId(ticket.id) }, { $set: { reopenUntil: new Date(Date.now() - 1000) } });
    expect((await call("GET", `/support/tickets/${ticket.id}`, customer.token)).json().data.status).toBe("closed");
    expect((await call("POST", `/support/tickets/${ticket.id}/messages`, customer.token, { text: "Hello?" })).statusCode).toBe(409);

    const summary = (await call("GET", "/ruxstar/support/summary", viewer.token)).json().data;
    expect(summary).toMatchObject({ open: expect.any(Number), overdue: expect.any(Number), unassigned: expect.any(Number) });
    const overview = (await call("GET", "/ruxstar/overview", viewer.token)).json().data;
    expect(overview.support).toEqual({ open: summary.open, overdue: summary.overdue, unassigned: summary.unassigned });
  });

  it("takes up to 3 photos on your own fresh message, behind signed links", async () => {
    const customer = await person("Photo Person");
    const ticket = (await open(customer.token, { category: "orders", subject: "Damaged print" })).json().data;
    const messageId = ticket.messages[0].id;
    const upload = (token: string, id = messageId) =>
      stack.app.inject({
        method: "POST",
        url: `/v1/support/tickets/${ticket.id}/messages/${id}/photos`,
        headers: { ...web(token, { "idempotency-key": randomUUID() }), "content-type": "image/jpeg" },
        payload: photo,
      });

    for (let i = 0; i < 3; i++) expect((await upload(customer.token)).statusCode).toBe(200);
    expect((await upload(customer.token)).statusCode).toBe(409);
    const stranger = await person("Not Owner");
    expect((await upload(stranger.token)).statusCode).toBe(404);

    const shown = (await call("GET", `/support/tickets/${ticket.id}`, customer.token)).json().data.messages[0].photos;
    expect(shown).toHaveLength(3);
    const url = new URL(shown[0].url);
    const opened = await stack.app.inject({ method: "GET", url: `${url.pathname}${url.search}` });
    expect(opened.statusCode).toBe(200);
    expect(opened.headers["content-type"]).toBe("image/jpeg");
    expect((await stack.app.inject({ method: "GET", url: `${url.pathname}?exp=${url.searchParams.get("exp")}&t=forged` })).statusCode).toBe(401);

    await stack.db.supportMessages.updateOne({ _id: new ObjectId(messageId) }, { $set: { at: new Date(Date.now() - 31 * 60_000), photos: [] } });
    expect((await upload(customer.token)).statusCode).toBe(409);
  });

  it("lets the admin change the reply-by times", async () => {
    const viewer = await staffWith("support.view");
    expect((await call("GET", "/ruxstar/support/settings", viewer.token)).json().data).toEqual({ hours: { urgent: 2, high: 8, normal: 24, low: 72 }, updatedAt: null });
    const hours = { urgent: 1, high: 4, normal: 12, low: 48 };
    expect((await call("PUT", "/ruxstar/support/settings", viewer.token, { hours })).statusCode).toBe(403);
    expect((await call("PUT", "/ruxstar/support/settings", admin.token, { hours: { ...hours, low: 0 } })).statusCode).toBe(400);
    const saved = (await call("PUT", "/ruxstar/support/settings", admin.token, { hours })).json().data;
    expect(saved.hours).toEqual(hours);

    const customer = await person("After Change");
    const ticket = (await open(customer.token)).json().data;
    const doc = (await stack.db.supportTickets.findOne({ _id: new ObjectId(ticket.id) }))!;
    expect(doc.slaDueAt!.getTime() - doc.createdAt.getTime()).toBe(12 * HOUR);
    expect(await stack.db.auditLogs.countDocuments({ action: "support.settings" })).toBe(1);
    await call("PUT", "/ruxstar/support/settings", admin.token, { hours: { urgent: 2, high: 8, normal: 24, low: 72 } });
  });

  it("gives an account on hold a support-only pass at sign-in", async () => {
    const digits = `9${randomInt(1e8, 1e9)}`;
    const userId = new ObjectId();
    await stack.db.users.insertOne({
      _id: userId,
      phone: `+91${digits}`,
      passwordHash: await hashPassword("Secret123"),
      name: "Held Person",
      status: "locked",
      suspension: { by: admin.userId, at: new Date(), reason: "Selling fake tickets." },
      roles: {},
      kyc: {},
      ...stamp(),
    });

    const wrong = await stack.app.inject({ method: "POST", url: "/v1/account/login", headers: web(), payload: { phone: digits, password: "Wrong123" } });
    expect(wrong.json().error.code).toBe("INVALID_CREDENTIALS");
    const res = await stack.app.inject({ method: "POST", url: "/v1/account/login", headers: web(), payload: { phone: digits, password: "Secret123" } });
    expect(res.statusCode).toBe(423);
    const error = res.json().error;
    expect(error.code).toBe("ACCOUNT_ON_HOLD");
    const [hold] = error.details;
    expect(hold).toMatchObject({ message: expect.stringMatching(/on hold/), supportToken: expect.any(String), expiresAt: expect.any(String) });
    expect(JSON.stringify(error)).not.toContain("Selling fake tickets.");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(await stack.db.sessions.countDocuments({ userId })).toBe(0);

    const pass = hold.supportToken as string;
    const ticket = await open(pass, { category: "account", subject: "Why am I on hold?", text: "I only sell my own prints." });
    expect(ticket.statusCode).toBe(200);
    expect((await call("GET", "/support/tickets", pass)).json().data).toHaveLength(1);
    expect((await call("GET", "/account/me", pass)).statusCode).toBe(401);
    expect((await call("GET", "/notifications", pass)).statusCode).toBe(401);

    const desk = (await call("GET", `/ruxstar/support/tickets/${ticket.json().data.id}`, admin.token)).json().data;
    expect(desk.requester).toMatchObject({ name: "Held Person", status: "locked" });

    await stack.db.users.updateOne({ _id: userId }, { $set: { status: "active" }, $unset: { suspension: "" } });
    const lifted = await call("GET", "/support/tickets", pass);
    expect(lifted.statusCode).toBe(401);
    expect(lifted.json().error.message).toMatch(/active again/);
  });

  it("reopens a locked verification from a ticket", async () => {
    const customer = await person("Locked Out");
    const caseId = new ObjectId();
    await stack.db.kycCases.insertOne({
      _id: caseId,
      userId: customer.userId,
      track: "base",
      status: "locked",
      rejections: 3,
      steps: {},
      submittedAt: new Date(),
      review: { by: admin.userId, at: new Date(), decision: "rejected", reason: "PAN name doesn't match." },
      ...stamp(),
    });
    await stack.db.users.updateOne({ _id: customer.userId }, { $set: { "kyc.base": "rejected" } });

    const ticket = (await open(customer.token, { category: "verification", subject: "Verification locked", context: { type: "verification", id: "base" } })).json().data;
    expect(ticket.context).toEqual({ type: "verification", id: "base", label: "Identity verification" });
    const desk = (await call("GET", `/ruxstar/support/tickets/${ticket.id}`, admin.token)).json().data;
    expect(desk.context).toMatchObject({ state: "locked", kycCaseId: caseId.toHexString() });

    const deskOnly = await staffWith("support.view", "support.manage");
    expect((await call("POST", `/ruxstar/kyc/${caseId}/reopen`, deskOnly.token)).statusCode).toBe(403);
    const reviewer = await staffWith("kyc.view", "kyc.review");
    const reopened = await call("POST", `/ruxstar/kyc/${caseId}/reopen`, reviewer.token);
    expect(reopened.statusCode).toBe(200);
    expect(await stack.db.kycCases.findOne({ _id: caseId })).toMatchObject({ status: "rejected", rejections: 2 });
    expect((await call("POST", `/ruxstar/kyc/${caseId}/reopen`, reviewer.token)).statusCode).toBe(409);
    expect(await stack.db.notifications.findOne({ userId: customer.userId, type: "kyc.reopened" })).toMatchObject({ link: { screen: "verification", id: "base" } });
    expect(await stack.db.auditLogs.countDocuments({ action: "kyc.reopen", "target.id": caseId })).toBe(1);
    expect((await call("GET", `/ruxstar/support/tickets/${ticket.id}`, admin.token)).json().data.context.state).toBe("rejected");
  });
});
