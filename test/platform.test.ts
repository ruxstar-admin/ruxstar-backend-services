import type { FastifyBaseLogger } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { codeEmail } from "../src/adapters/email-template.js";
import { createPushSender } from "../src/adapters/push.js";
import { compareVersions } from "../src/platform/client.js";
import { seedModuleSettings } from "../src/platform/indexes.js";
import { requireModuleLive } from "../src/platform/module-switch.js";
import { decodeCursor, encodeCursor } from "../src/platform/pagination.js";
import { ObjectId } from "mongodb";
import { signIn, startStack, web, type Stack } from "./helpers.js";

describe("code email", () => {
  it("puts the code in the subject, text and HTML, and escapes the address", () => {
    const mail = codeEmail('a"<b>@example.com', "551118", 5);
    expect(mail.subject).toBe("551118 is your Ruxstar code");
    expect(mail.text).toContain("551118");
    expect(mail.text).toContain("5 minutes");
    expect(mail.html).toContain(">551118</td>");
    expect(mail.html).not.toContain('a"<b>');
    expect(mail.html).toContain("a&quot;&lt;b&gt;@example.com");
  });
});

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

  it("needs both OneSignal settings for phone notifications", () => {
    expect(loadConfig({}).push).toBeNull();
    expect(() => loadConfig({ ONESIGNAL_APP_ID: APP_ID })).toThrow(ConfigError);
    expect(() => loadConfig({ ONESIGNAL_APP_ID: "not-an-id", ONESIGNAL_API_KEY: "key" })).toThrow(ConfigError);
    expect(loadConfig({ ONESIGNAL_APP_ID: APP_ID, ONESIGNAL_API_KEY: "key" }).push).toEqual({ appId: APP_ID, apiKey: "key" });
  });
});

const APP_ID = "00000000-0000-4000-8000-000000000000";

describe("OneSignal", () => {
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends one notification per message to all its installs, and answers with installs that are gone", async () => {
    const calls: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { include_subscription_ids: string[] };
      calls.push({ headers: init.headers as Record<string, string>, body });
      return Response.json(body.include_subscription_ids.includes("s2") ? { id: "n1", errors: { invalid_player_ids: ["s2"] } } : { id: "n2" });
    });
    const sender = createPushSender({ appId: APP_ID, apiKey: "secret" }, log);
    const like = { title: "New like", body: "Asha liked your post.", data: { notificationId: "n", screen: "post", id: "p" } };

    const gone = await sender.send([
      { to: "s1", ...like },
      { to: "s2", ...like },
      { to: "s3", title: "Ravi", body: "Hi", data: { chatId: "c" } },
    ]);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers.Authorization).toBe("Key secret");
    expect(calls[0]!.body).toMatchObject({
      app_id: APP_ID,
      target_channel: "push",
      include_subscription_ids: ["s1", "s2"],
      headings: { en: "New like" },
      contents: { en: "Asha liked your post." },
      data: like.data,
    });
    expect(calls[1]!.body).toMatchObject({ include_subscription_ids: ["s3"], data: { chatId: "c" } });
    expect(gone).toEqual(["s2"]);
  });

  it("never throws when OneSignal is down, and sends nothing without settings", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    const message = { to: "s1", title: "t", body: "b", data: {} };
    await expect(createPushSender({ appId: APP_ID, apiKey: "secret" }, log).send([message])).resolves.toEqual([]);
    await expect(createPushSender(null, log).send([message])).resolves.toEqual([]);
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

  it("seeds module settings again without failing or duplicating", async () => {
    await Promise.all([seedModuleSettings(stack.db), seedModuleSettings(stack.db)]);
    expect(await stack.db.moduleSettings.countDocuments({ module: "pod" })).toBe(1);
  });

  it("swaps in a working connection when the database is renewed", async () => {
    const stale = stack.db.client;
    stack.db.renew();
    expect(stack.db.client).not.toBe(stale);
    await expect(stack.db.users.countDocuments()).resolves.toBeTypeOf("number");
    const ready = await stack.app.inject({ url: "/ready" });
    expect(ready.statusCode).toBe(200);
  });
});

describe("session cache", () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack(undefined, { authCacheSeconds: 30 });
  }, 120_000);
  afterAll(() => stack?.stop());

  const modules = (token: string) => stack.app.inject({ url: "/v1/ruxstar/modules", headers: web(token) });

  it("reuses a checked session, and forgets it at once on logout here", async () => {
    const admin = await signIn(stack, { admin: true });
    expect((await modules(admin.token)).statusCode).toBe(200);
    // Ended elsewhere: this instance keeps trusting it until the cache runs out.
    await stack.db.sessions.updateOne({ _id: admin.sessionId }, { $set: { revokedAt: new Date() } });
    expect((await modules(admin.token)).statusCode).toBe(200);

    const other = await signIn(stack, { admin: true });
    expect((await modules(other.token)).statusCode).toBe(200);
    await stack.app.inject({ method: "POST", url: "/v1/account/logout", headers: web(other.token), payload: {} });
    expect((await modules(other.token)).statusCode).toBe(401);
  });
});
