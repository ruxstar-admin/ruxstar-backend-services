import { randomInt } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { SmsSender } from "../src/adapters/sms.js";
import { ObjectId } from "mongodb";
import { buildApp, type App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { signAccessToken } from "../src/platform/auth.js";
import { createDatabase, stamp, type Database, type UserRoles } from "../src/platform/db.js";
import { ensurePlatformIndexes, seedModuleSettings } from "../src/platform/indexes.js";

export interface Stack {
  app: App;
  db: Database;
  /** The last code texted to each number, keyed by E.164. */
  texts: Map<string, string>;
  stop: () => Promise<void>;
}

/** A real replica set, because transactions need one. */
export async function startStack(extend?: (app: App) => void, { rateLimit = false } = {}): Promise<Stack> {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  const config = loadConfig({
    RUXSTAR_ENV: "dev",
    JWT_SECRET: "test-secret-that-is-long-enough-123456",
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB: "ruxstar_test",
    MIN_APP_VERSION: "2.0.0",
  });
  const db = createDatabase(config.mongo!.uri, config.mongo!.db);
  await db.client.connect();
  await ensurePlatformIndexes(db);
  await seedModuleSettings(db);

  const texts = new Map<string, string>();
  const sms: SmsSender = {
    sendOtp: async (phone, code) => {
      texts.set(phone, code);
    },
  };
  const app = await buildApp({ config, db, logger: false, sms, rateLimit });
  extend?.(app);
  await app.ready();

  return {
    app,
    db,
    texts,
    stop: async () => {
      await app.close();
      await replSet.stop();
    },
  };
}

export async function signIn(stack: Stack, roles: UserRoles = {}, status: "active" | "locked" = "active") {
  const userId = new ObjectId();
  const sessionId = new ObjectId();
  await stack.db.users.insertOne({ _id: userId, phone: `+919${randomInt(1e8, 1e9)}`, status, roles, kyc: {}, ...stamp() });
  await stack.db.sessions.insertOne({
    _id: sessionId,
    userId,
    client: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: null,
    ...stamp(),
  });
  const token = await signAccessToken(stack.app.config.jwtSecret!, { userId, sessionId, client: "web" });
  return { userId, sessionId, token };
}

export const web = (token?: string, extra: Record<string, string> = {}) => ({
  "x-client": "web",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
  ...extra,
});
