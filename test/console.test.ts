import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stamp } from "../src/platform/db.js";
import { signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>>;

describe("ruxstar console", () => {
  let stack: Stack;
  let admin: User;

  beforeAll(async () => {
    stack = await startStack();
    admin = await signIn(stack, { admin: true });
  });
  afterAll(() => stack?.stop());

  const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, token: string, payload?: object) =>
    stack.app.inject({
      method,
      url: `/v1${url}`,
      headers: web(token, method === "GET" ? {} : { "idempotency-key": randomUUID() }),
      ...(payload ? { payload } : {}),
    });

  async function person(name: string, roles = {}) {
    const user = await signIn(stack, roles);
    await stack.db.users.updateOne(
      { _id: user.userId },
      { $set: { name, username: name.toLowerCase().replace(/\s+/g, ".") + user.userId.toHexString().slice(-4) } },
    );
    return user;
  }

  /** Staff with exactly these permissions. */
  async function staffWith(...permissions: string[]) {
    const user = await person("Staff Member", { ruxstarStaff: true });
    await stack.db.ruxstarStaff.insertOne({
      _id: new ObjectId(),
      userId: user.userId,
      title: "Support",
      modules: [],
      permissions,
      grantedBy: admin.userId,
      status: "active",
      ...stamp(),
    });
    return user;
  }

  async function livePost(author: User, text = "Hello Ruxstar") {
    const _id = new ObjectId();
    await stack.db.posts.insertOne({ _id, authorId: author.userId, kind: "personal", text, media: [], counts: { likes: 2, comments: 1 }, status: "live", editedAt: null, ...stamp() });
    await stack.db.users.updateOne({ _id: author.userId }, { $set: { "social.posts": 1, "social.engagements": 3 } });
    return _id.toHexString();
  }

  describe("access and overview", () => {
    it("is for admins and active staff only", async () => {
      const someone = await person("Plain Person");
      expect((await call("GET", "/ruxstar/access", someone.token)).statusCode).toBe(403);

      const all = (await call("GET", "/ruxstar/access", admin.token)).json().data;
      expect(all.admin).toBe(true);
      expect(all.permissions).toContain("users.manage");
      expect(all.catalog).toHaveLength(9);

      const support = await staffWith("kyc.view", "made.up");
      const mine = (await call("GET", "/ruxstar/access", support.token)).json().data;
      expect(mine).toMatchObject({ admin: false, title: "Support", permissions: ["kyc.view"] });
    });

    it("shows only the sections you may see", async () => {
      const full = (await call("GET", "/ruxstar/overview", admin.token)).json().data;
      expect(full.kyc).toEqual({ waiting: 0, identity: 0, vendor: 0 });
      expect(full.users.total).toBeGreaterThan(0);
      expect(full.modules).toHaveLength(6);
      expect(full.staff.active).toBeGreaterThanOrEqual(0);

      const support = await staffWith("kyc.view");
      const some = (await call("GET", "/ruxstar/overview", support.token)).json().data;
      expect(some.kyc).not.toBeNull();
      expect(some).toMatchObject({ reports: null, users: null, modules: null, staff: null });
    });
  });

  describe("reports", () => {
    it("groups reports by post and keeps a post up", async () => {
      const author = await person("Post Author");
      const postId = await livePost(author);
      for (const reason of ["spam", "abuse"]) {
        const reporter = await person("Reporter");
        expect((await call("POST", `/social/posts/${postId}/report`, reporter.token, { reason })).statusCode).toBe(200);
      }

      const open = (await call("GET", "/ruxstar/reports", admin.token)).json().data;
      const row = open.find((r: { postId: string }) => r.postId === postId);
      expect(row).toMatchObject({ status: "open", reports: 2, reasons: { spam: 1, abuse: 1, fake: 0 }, outcome: null });
      expect(row.post).toMatchObject({ text: "Hello Ruxstar", status: "live", author: { name: "Post Author" } });

      const viewer = await staffWith("reports.view");
      expect((await call("POST", `/ruxstar/reports/${postId}/keep`, viewer.token)).statusCode).toBe(403);

      const kept = await call("POST", `/ruxstar/reports/${postId}/keep`, admin.token);
      expect(kept.statusCode).toBe(200);
      expect(kept.json().data).toMatchObject({ status: "closed", outcome: "kept", reports: 2 });
      expect((await call("POST", `/ruxstar/reports/${postId}/keep`, admin.token)).statusCode).toBe(409);
      expect((await call("GET", "/ruxstar/reports", admin.token)).json().data.some((r: { postId: string }) => r.postId === postId)).toBe(false);
      expect(await stack.db.auditLogs.findOne({ action: "report.keep", "target.id": new ObjectId(postId) })).not.toBeNull();
    });

    it("removes a post, clears it and tells the author", async () => {
      const author = await person("Rule Breaker");
      const postId = await livePost(author, "Buy fake followers");
      const reporter = await person("Reporter");
      await call("POST", `/social/posts/${postId}/report`, reporter.token, { reason: "spam" });

      expect((await call("POST", `/ruxstar/reports/${postId}/remove`, admin.token, { reason: "no" })).statusCode).toBe(400);
      const res = await call("POST", `/ruxstar/reports/${postId}/remove`, admin.token, { reason: "Selling fake followers is not allowed." });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ outcome: "removed", post: { status: "removed", removal: { reason: "Selling fake followers is not allowed." } } });

      expect((await call("GET", `/social/posts/${postId}`, reporter.token)).statusCode).toBe(404);
      const user = await stack.db.users.findOne({ _id: author.userId });
      expect(user?.social).toEqual({ posts: 0, engagements: 0 });
      const note = await stack.db.notifications.findOne({ userId: author.userId, type: "post.removed" });
      expect(note?.link).toEqual({ screen: "post", id: postId });
      expect((await call("POST", `/ruxstar/reports/${postId}/remove`, admin.token, { reason: "Again, again" })).statusCode).toBe(409);

      const closed = (await call("GET", "/ruxstar/reports?status=closed", admin.token)).json().data;
      expect(closed[0]).toMatchObject({ postId, outcome: "removed" });
      expect(await stack.db.auditLogs.findOne({ action: "post.remove", "target.id": new ObjectId(postId) })).not.toBeNull();
    });
  });

  describe("users", () => {
    it("finds people by phone, username or name", async () => {
      const found = await person("Kavya Menon");
      const user = (await stack.db.users.findOne({ _id: found.userId }))!;
      const byPhone = (await call("GET", `/ruxstar/users?q=${user.phone.slice(-6)}`, admin.token)).json().data;
      expect(byPhone.map((u: { id: string }) => u.id)).toContain(found.userId.toHexString());
      const byName = (await call("GET", "/ruxstar/users?q=menon", admin.token)).json().data;
      expect(byName.map((u: { id: string }) => u.id)).toContain(found.userId.toHexString());
      const byHandle = (await call("GET", `/ruxstar/users?q=@${user.username!.slice(0, 6)}`, admin.token)).json().data;
      expect(byHandle.map((u: { id: string }) => u.id)).toContain(found.userId.toHexString());

      const detail = (await call("GET", `/ruxstar/users/${found.userId}`, admin.token)).json().data;
      expect(detail).toMatchObject({ name: "Kavya Menon", status: "active", sessions: 1, staff: null, suspension: null });

      const outsider = await person("Not Staff");
      expect((await call("GET", "/ruxstar/users", outsider.token)).statusCode).toBe(403);
    });

    it("suspends, unlocks and signs people out", async () => {
      const target = await person("Spammy Seller");
      const res = await call("POST", `/ruxstar/users/${target.userId}/suspend`, admin.token, { reason: "Repeated spam reports." });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ status: "locked", sessions: 0, suspension: { reason: "Repeated spam reports." } });
      expect((await call("GET", "/account/me", target.token)).statusCode).toBe(401);
      expect((await call("POST", `/ruxstar/users/${target.userId}/suspend`, admin.token, { reason: "Again please" })).statusCode).toBe(409);

      const unlocked = await call("POST", `/ruxstar/users/${target.userId}/unlock`, admin.token);
      expect(unlocked.json().data).toMatchObject({ status: "active", suspension: null });
      expect((await call("POST", `/ruxstar/users/${target.userId}/unlock`, admin.token)).statusCode).toBe(409);

      const again = await signIn(stack);
      const out = await call("POST", `/ruxstar/users/${again.userId}/sign-out`, admin.token);
      expect(out.json().data.sessions).toBe(0);
      expect(await stack.db.auditLogs.countDocuments({ "target.id": target.userId, action: { $in: ["user.suspend", "user.unlock"] } })).toBe(2);
    });

    it("protects admins, staff and yourself", async () => {
      const otherAdmin = await signIn(stack, { admin: true });
      expect((await call("POST", `/ruxstar/users/${otherAdmin.userId}/suspend`, admin.token, { reason: "Testing guard" })).statusCode).toBe(403);
      expect((await call("POST", `/ruxstar/users/${admin.userId}/sign-out`, admin.token)).statusCode).toBe(403);

      const moderator = await staffWith("users.view", "users.manage");
      const colleague = await staffWith("kyc.view");
      expect((await call("POST", `/ruxstar/users/${colleague.userId}/suspend`, moderator.token, { reason: "Testing guard" })).statusCode).toBe(403);
    });
  });

  describe("staff", () => {
    it("is managed by admins only", async () => {
      const support = await staffWith("users.view");
      expect((await call("GET", "/ruxstar/staff", support.token)).statusCode).toBe(403);

      const hire = await person("New Hire");
      const granted = await call("PUT", `/ruxstar/staff/${hire.userId}`, admin.token, { title: "KYC reviewer", permissions: ["kyc.view", "kyc.review"] });
      expect(granted.statusCode).toBe(200);
      expect(granted.json().data).toMatchObject({ title: "KYC reviewer", status: "active", permissions: ["kyc.view", "kyc.review"] });
      expect((await call("GET", "/ruxstar/access", hire.token)).json().data.permissions).toEqual(["kyc.view", "kyc.review"]);
      expect((await call("GET", "/ruxstar/kyc", hire.token)).statusCode).toBe(200);

      await call("PUT", `/ruxstar/staff/${hire.userId}`, admin.token, { title: "KYC lead", permissions: ["kyc.view"] });
      expect((await call("POST", "/ruxstar/kyc/000000000000000000000000/approve", hire.token)).statusCode).toBe(403);
      expect(await stack.db.auditLogs.findOne({ action: "staff.update", "target.id": hire.userId })).not.toBeNull();

      const list = (await call("GET", "/ruxstar/staff", admin.token)).json().data;
      expect(list.find((s: { user: { id: string } }) => s.user.id === hire.userId.toHexString())).toMatchObject({ title: "KYC lead" });

      expect((await call("DELETE", `/ruxstar/staff/${hire.userId}`, admin.token)).json().data.status).toBe("revoked");
      expect((await call("GET", "/ruxstar/access", hire.token)).statusCode).toBe(403);
      expect((await stack.db.users.findOne({ _id: hire.userId }))?.roles.ruxstarStaff).toBe(false);
      expect((await call("DELETE", `/ruxstar/staff/${hire.userId}`, admin.token)).statusCode).toBe(404);
    });

    it("checks who and what can be granted", async () => {
      const otherAdmin = await signIn(stack, { admin: true });
      expect((await call("PUT", `/ruxstar/staff/${otherAdmin.userId}`, admin.token, { title: "Admin too", permissions: ["kyc.view"] })).statusCode).toBe(403);
      expect((await call("PUT", `/ruxstar/staff/${admin.userId}`, admin.token, { title: "Myself", permissions: ["kyc.view"] })).statusCode).toBe(403);
      const hire = await person("Second Hire");
      expect((await call("PUT", `/ruxstar/staff/${hire.userId}`, admin.token, { title: "Bad", permissions: ["staff.manage"] })).statusCode).toBe(400);
      expect((await call("PUT", `/ruxstar/staff/${hire.userId}`, admin.token, { title: "None", permissions: [] })).statusCode).toBe(400);
    });
  });

  describe("audit log", () => {
    it("lists entries with filters", async () => {
      const target = await person("Audited Person");
      await call("POST", `/ruxstar/users/${target.userId}/suspend`, admin.token, { reason: "For the audit test" });

      const res = await call("GET", `/ruxstar/audit?target=${target.userId}`, admin.token);
      expect(res.statusCode).toBe(200);
      expect(res.json().data[0]).toMatchObject({
        action: "user.suspend",
        module: "account",
        actor: { id: admin.userId.toHexString(), kind: "admin" },
        target: { type: "user", id: target.userId.toHexString() },
        diff: { status: { from: "active", to: "locked" } },
      });
      const byAction = (await call("GET", "/ruxstar/audit?action=user.suspend", admin.token)).json().data;
      expect(byAction.every((e: { action: string }) => e.action === "user.suspend")).toBe(true);

      const support = await staffWith("users.view");
      expect((await call("GET", "/ruxstar/audit", support.token)).statusCode).toBe(403);
    });
  });
});
