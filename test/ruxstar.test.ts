import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireModuleLive } from "../src/platform/module-switch.js";
import { signIn, startStack, web, type Stack } from "./helpers.js";

describe("ruxstar module settings", () => {
  let stack: Stack;
  let adminToken: string;

  beforeAll(async () => {
    stack = await startStack((app) => {
      app.get("/v1/events/ping", { preHandler: requireModuleLive("events") }, async () => ({ data: "pong" }));
    });
    adminToken = (await signIn(stack, { admin: true })).token;
  });
  afterAll(() => stack?.stop());

  const patch = (body: unknown, key: string, token = adminToken) =>
    stack.app.inject({
      method: "PATCH",
      url: "/v1/ruxstar/modules/events",
      headers: web(token, { "idempotency-key": key }),
      payload: body as object,
    });

  it("lists every switchable module, all off by default", async () => {
    const res = await stack.app.inject({ url: "/v1/ruxstar/modules", headers: web(adminToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.map((m: { module: string }) => m.module)).toEqual([
      "pod",
      "events",
      "coaching",
      "stays",
      "delivery",
      "ledger",
    ]);
    expect(body.data.every((m: { live: boolean }) => m.live === false)).toBe(true);
    expect(body.meta.nextCursor).toBeNull();
  });

  it("refuses users who are not admin or granted staff", async () => {
    const user = await signIn(stack);
    const res = await patch({ live: true }, "key-forbidden-1", user.token);
    expect(res.statusCode).toBe(403);
  });

  it("lets staff with the grant in", async () => {
    const staff = await signIn(stack, { ruxstarStaff: true });
    const res = await stack.app.inject({ url: "/v1/ruxstar/modules", headers: web(staff.token) });
    expect(res.statusCode).toBe(403);

    await stack.db.ruxstarStaff.insertOne({
      _id: staff.userId,
      userId: staff.userId,
      title: "Operations",
      modules: ["ruxstar"],
      permissions: ["modules.view"],
      grantedBy: staff.userId,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
      schemaVersion: 1,
    });
    const granted = await stack.app.inject({ url: "/v1/ruxstar/modules", headers: web(staff.token) });
    expect(granted.statusCode).toBe(200);
  });

  it("rejects unknown fields and out-of-range values", async () => {
    const unknown = await patch({ live: true, colour: "red" }, "key-unknown-1");
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe("VALIDATION_FAILED");
    expect(unknown.json().error.details[0].message).toContain("colour");

    const range = await patch({ commissionBps: 20000 }, "key-range-01");
    expect(range.statusCode).toBe(400);

    const empty = await patch({}, "key-empty-01");
    expect(empty.statusCode).toBe(400);
  });

  it("requires an Idempotency-Key", async () => {
    const res = await stack.app.inject({
      method: "PATCH",
      url: "/v1/ruxstar/modules/events",
      headers: web(adminToken),
      payload: { live: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("switches a module on, audits it, and opens its routes", async () => {
    const before = await stack.app.inject({ url: "/v1/events/ping", headers: web() });
    expect(before.statusCode).toBe(503);

    const res = await patch({ live: true, commissionBps: 1000 }, "key-switch-on-1");
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ module: "events", live: true, commissionBps: 1000 });

    const audit = await stack.db.auditLogs.findOne({ action: "module_settings.update", "scope.module": "events" });
    expect(audit?.diff).toEqual({ live: { from: false, to: true }, commissionBps: { from: 0, to: 1000 } });
    expect(audit?.actor.kind).toBe("admin");

    const after = await stack.app.inject({ url: "/v1/events/ping", headers: web() });
    expect(after.statusCode).toBe(200);
  });

  it("replays a retry with the same key instead of applying it twice", async () => {
    const first = await patch({ signupsOpen: true }, "key-replay-01");
    const retry = await patch({ signupsOpen: true }, "key-replay-01");
    expect(retry.statusCode).toBe(200);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.body).toBe(first.body);
    expect(await stack.db.auditLogs.countDocuments({ "diff.signupsOpen": { $exists: true } })).toBe(1);
  });

  it("refuses the same key with a different body", async () => {
    const res = await patch({ signupsOpen: false }, "key-replay-01");
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("writes no audit entry when nothing changed", async () => {
    const count = await stack.db.auditLogs.countDocuments();
    const res = await patch({ live: true }, "key-no-change-1");
    expect(res.statusCode).toBe(200);
    expect(await stack.db.auditLogs.countDocuments()).toBe(count);
  });
});
