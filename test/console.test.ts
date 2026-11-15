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
      expect(all.catalog).toHaveLength(19);

      const support = await staffWith("kyc.view", "made.up");
      const mine = (await call("GET", "/ruxstar/access", support.token)).json().data;
      expect(mine).toMatchObject({ admin: false, title: "Support", permissions: ["kyc.view"] });
    });

    it("shows only the sections you may see", async () => {
      const full = (await call("GET", "/ruxstar/overview", admin.token)).json().data;
      expect(full.kyc).toEqual({ waiting: 0, delivery: 0 });
      expect(full.businesses).toEqual({ total: 0, live: 0, suspended: 0 });
      expect(full.users.total).toBeGreaterThan(0);
      expect(full.modules).toHaveLength(8);
      expect(full.staff.active).toBeGreaterThanOrEqual(0);

      const support = await staffWith("kyc.view");
      const some = (await call("GET", "/ruxstar/overview", support.token)).json().data;
      expect(some.kyc).not.toBeNull();
      expect(some).toMatchObject({ reports: null, users: null, businesses: null, modules: null, staff: null });
    });
  });

  describe("reports", () => {
    it("groups reports by post and keeps a post up", async () => {
      const author = await person("Post Author");
      const postId = await livePost(author);
      const reporters: User[] = [];
      for (const reason of ["spam", "abuse"]) {
        const reporter = await person("Reporter");
        expect((await call("POST", `/social/posts/${postId}/report`, reporter.token, { reason })).statusCode).toBe(200);
        reporters.push(reporter);
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
      for (const reporter of reporters) {
        const told = await stack.db.notifications.find({ userId: reporter.userId, type: "report.resolved" }).toArray();
        expect(told.map((n) => [n.title, n.link])).toEqual([["We reviewed your report", { screen: "post", id: postId }]]);
      }
      expect(await stack.db.notifications.countDocuments({ userId: author.userId, type: "report.resolved" })).toBe(0);
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
      const thanked = await stack.db.notifications.findOne({ userId: reporter.userId, type: "report.resolved" });
      expect(thanked).toMatchObject({ title: "Thanks for your report", body: "We reviewed the post you reported and took it down." });
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

    it("audits a save that changes nothing only once", async () => {
      const hire = await person("Same Again");
      const body = { title: "Support", permissions: ["support.view"] };
      await call("PUT", `/ruxstar/staff/${hire.userId}`, admin.token, body);
      const again = await call("PUT", `/ruxstar/staff/${hire.userId}`, admin.token, body);
      expect(again.statusCode).toBe(200);
      expect(again.json().data).toMatchObject({ title: "Support", status: "active", permissions: ["support.view"] });
      const actions = async () => (await stack.db.auditLogs.find({ "target.id": hire.userId }).sort({ _id: 1 }).toArray()).map((e) => e.action);
      expect(await actions()).toEqual(["staff.grant"]);

      await call("DELETE", `/ruxstar/staff/${hire.userId}`, admin.token);
      await call("PUT", `/ruxstar/staff/${hire.userId}`, admin.token, body);
      expect(await actions()).toEqual(["staff.grant", "staff.revoke", "staff.grant"]);
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

    it("filters by time: from is included, to is not, with the other filters and paging", async () => {
      const [a, b] = [new ObjectId(), new ObjectId()];
      const hour = (h: number) => new Date(Date.UTC(2026, 0, 1, h));
      const entry = (actor: ObjectId, h: number) => ({
        _id: new ObjectId(),
        actor: { id: actor, kind: "staff" as const },
        scope: { module: "range_test" },
        action: "range_test.touch",
        target: { type: "user", id: actor },
        diff: {},
        ip: null,
        at: hour(h),
        ...stamp(hour(h)),
      });
      await stack.db.auditLogs.insertMany([entry(a, 0), entry(a, 1), entry(a, 2), entry(b, 1)]);
      const list = async (query: string) => {
        const res = await call("GET", `/ruxstar/audit?module=range_test&${query}`, admin.token);
        expect(res.statusCode, res.body).toBe(200);
        return res.json() as { data: { at: string; actor: { id: string } }[]; meta: { nextCursor: string | null } };
      };
      const times = async (query: string) => (await list(query)).data.map((e) => e.at);
      const iso = (h: number) => hour(h).toISOString();

      expect(await times(`actor=${a}&from=${iso(1)}`)).toEqual([iso(2), iso(1)]);
      expect(await times(`actor=${a}&to=${iso(1)}`)).toEqual([iso(0)]);
      expect(await times(`actor=${a}&from=${iso(0)}&to=${iso(2)}`)).toEqual([iso(1), iso(0)]);
      expect(await times(`actor=${a}&from=${encodeURIComponent("2026-01-01T06:30:00+05:30")}`)).toEqual([iso(2), iso(1)]);
      const both = (await list(`from=${iso(1)}&to=${iso(2)}`)).data;
      expect(both.map((e) => e.actor.id).sort()).toEqual([a.toHexString(), b.toHexString()].sort());
      expect(await times(`actor=${b}&action=range_test.touch&from=${iso(0)}&to=${iso(3)}`)).toEqual([iso(1)]);

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const pageOf: Awaited<ReturnType<typeof list>> = await list(`actor=${a}&from=${iso(0)}&to=${iso(3)}&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
        seen.push(...pageOf.data.map((e) => e.at));
        cursor = pageOf.meta.nextCursor;
      } while (cursor);
      expect(seen).toEqual([iso(2), iso(1), iso(0)]);

      for (const query of [`from=${iso(1)}&to=${iso(1)}`, `from=${iso(2)}&to=${iso(1)}`]) {
        const bad = await call("GET", `/ruxstar/audit?${query}`, admin.token);
        expect(bad.statusCode).toBe(400);
        expect(bad.json().error).toMatchObject({ code: "VALIDATION_FAILED", details: [{ path: "querystring/to" }] });
      }
      const notTime = await call("GET", "/ruxstar/audit?from=yesterday", admin.token);
      expect(notTime.json().error).toMatchObject({ code: "VALIDATION_FAILED", details: [{ path: "querystring/from" }] });
    });
  });
});
