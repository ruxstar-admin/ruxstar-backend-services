import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { compareVersions } from "../src/platform/client.js";
import { requireModuleLive } from "../src/platform/module-switch.js";
import { decodeCursor, encodeCursor } from "../src/platform/pagination.js";
import { ObjectId } from "mongodb";
import { signIn, startStack, web, type Stack } from "./helpers.js";

describe("config", () => {
  it("refuses a database URI without a database name", () => {
    expect(() => loadConfig({ MONGODB_URI: "mongodb://localhost" })).toThrow(ConfigError);
  });

  it("never puts values in the message", () => {
    try {
      loadConfig({ JWT_SECRET: "short-secret-value" });
    } catch (err) {
      expect((err as Error).message).not.toContain("short-secret-value");
    }
  });

  it("treats NODE_ENV=production as prod", () => {
    expect(loadConfig({ NODE_ENV: "production" }).env).toBe("prod");
  });
});

describe("without a database", () => {
  it("serves /health and reports /ready as 503", async () => {
    const app = await buildApp({ config: loadConfig({}), db: null, logger: false });
    const health = await app.inject({ url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().data.status).toBe("ok");
    expect(health.json().meta.requestId).toBe(health.headers["x-request-id"]);

    const ready = await app.inject({ url: "/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().error.code).toBe("NOT_READY");
    await app.close();
  });
});

describe("helpers", () => {
  it("compares versions numerically", () => {
    expect(compareVersions("2.10.0", "2.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("round-trips a date cursor", () => {
    const id = new ObjectId();
    const at = new Date("2026-11-30T00:00:00.000Z");
    const decoded = decodeCursor(encodeCursor(at, id));
    expect(decoded.value).toEqual(at);
    expect(decoded.id.equals(id)).toBe(true);
  });
});

describe("platform", () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack((app) => {
      app.get("/v1/pod/ping", { preHandler: requireModuleLive("pod") }, async () => ({ data: "pong" }));
    });
  });
  afterAll(() => stack?.stop());

  it("echoes a valid incoming request id", async () => {
    const res = await stack.app.inject({ url: "/health", headers: { "x-request-id": "req-12345678" } });
    expect(res.headers["x-request-id"]).toBe("req-12345678");
  });

  it("returns the error envelope for unknown routes", async () => {
    const res = await stack.app.inject({ url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route not found.", details: [] } });
  });

  it("requires X-Client on /v1", async () => {
    const res = await stack.app.inject({ url: "/v1/ruxstar/modules" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("CLIENT_HEADER_REQUIRED");
  });

  it("returns 426 to apps below the minimum version", async () => {
    const res = await stack.app.inject({
      url: "/v1/ruxstar/modules",
      headers: { "x-client": "app", "x-app-version": "1.9.0" },
    });
    expect(res.statusCode).toBe(426);
    expect(res.json().error.details[0].minVersion).toBe("2.0.0");
  });

  it("rejects signed-out callers", async () => {
    const res = await stack.app.inject({ url: "/v1/ruxstar/modules", headers: web() });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a revoked session", async () => {
    const admin = await signIn(stack, { admin: true });
    await stack.db.sessions.updateOne({ _id: admin.sessionId }, { $set: { revokedAt: new Date() } });
    const res = await stack.app.inject({ url: "/v1/ruxstar/modules", headers: web(admin.token) });
    expect(res.statusCode).toBe(401);
  });

  it("blocks a business route while its module is off", async () => {
    const off = await stack.app.inject({ url: "/v1/pod/ping", headers: web() });
    expect(off.statusCode).toBe(503);
    expect(off.json().error.code).toBe("MODULE_OFF");
  });
});
