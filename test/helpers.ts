import { randomBytes, randomInt } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { EmailSender } from "../src/adapters/email.js";
import type { Geocoder } from "../src/adapters/geocoder.js";
import type { PhotoStore } from "../src/adapters/photos.js";
import type { PrintFileStore } from "../src/adapters/print-files.js";
import type { SmsSender } from "../src/adapters/sms.js";
import { FakeVerifier, type Verifier } from "../src/adapters/verification.js";
import { ObjectId } from "mongodb";
import { buildApp, type App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { signAccessToken } from "../src/platform/auth.js";
import { createDatabase, stamp, type Database, type UserRoles } from "../src/platform/db.js";
import { AppError } from "../src/platform/errors.js";
import { ensurePlatformIndexes, seedModuleSettings } from "../src/platform/indexes.js";

export interface Stack {
  app: App;
  db: Database;
  /** The last code texted to each number, keyed by E.164. */
  texts: Map<string, string>;
  /** Every text sent, and a switch that makes the next send fail like a provider outage. */
  sms: { sent: number; failNext: boolean };
  /** The last code emailed to each address. */
  emails: Map<string, string>;
  /** Saved photos by object key; deleted keys are removed. */
  photos: Map<string, Buffer>;
  /** Saved post photos by object key, in their own bucket. */
  media: Map<string, Buffer>;
  /** Customers' print files by key, and the keys whose 30-day countdown started. */
  printFiles: { objects: Map<string, Buffer>; expiring: Set<string> };
  stop: () => Promise<void>;
}

/**
 * A real replica set, because transactions need one. Sessions are checked on every request unless
 * `authCacheSeconds` is given, since most tests change the database directly between requests.
 */
export async function startStack(
  extend?: (app: App) => void,
  { rateLimit = false, authCacheSeconds = 0, verifier }: { rateLimit?: boolean; authCacheSeconds?: number; verifier?: Verifier } = {},
): Promise<Stack> {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  const config = loadConfig({
    RUXSTAR_ENV: "dev",
    JWT_SECRET: "test-secret-that-is-long-enough-123456",
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB: "ruxstar_test",
    MIN_APP_VERSION: "2.0.0",
    AUTH_CACHE_SECONDS: String(authCacheSeconds),
    PAYOUT_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  });
  const db = createDatabase(config.mongo!.uri, config.mongo!.db);
  await db.client.connect();
  await ensurePlatformIndexes(db);
  await seedModuleSettings(db);
  db.ready = true;

  const texts = new Map<string, string>();
  const smsLog = { sent: 0, failNext: false };
  const sms: SmsSender = {
    sendOtp: async (phone, code) => {
      if (smsLog.failNext) {
        smsLog.failNext = false;
        throw new AppError("SMS_UNAVAILABLE");
      }
      smsLog.sent++;
      texts.set(phone, code);
    },
  };
  const emails = new Map<string, string>();
  const email: EmailSender = { sendCode: async (to, code) => void emails.set(to, code) };
  const geocoder: Geocoder = { cityAt: async () => "Hyderabad" };
  const fakeBucket = (host: string) => {
    const objects = new Map<string, Buffer>();
    const store: PhotoStore = {
      save: async (key, data) => {
        objects.set(key, data);
        return `https://${host}/${key}`;
      },
      remove: async (key) => void objects.delete(key),
    };
    return { objects, store };
  };
  const profilePhotos = fakeBucket("photos.test");
  const postMedia = fakeBucket("media.test");
  const printFiles = { objects: new Map<string, Buffer>(), expiring: new Set<string>() };
  const printStore: PrintFileStore = {
    save: async (key, data) => void printFiles.objects.set(key, data),
    read: async (key) => {
      const data = printFiles.objects.get(key);
      if (!data) throw new AppError("FILES_UNAVAILABLE");
      return data;
    },
    expire: async (key) => void printFiles.expiring.add(key),
    remove: async (key) => void printFiles.objects.delete(key),
  };
  const app = await buildApp({
    config,
    db,
    logger: false,
    sms,
    email,
    geocoder,
    photos: profilePhotos.store,
    media: postMedia.store,
    printFiles: printStore,
    rateLimit,
    verifier: verifier ?? new FakeVerifier(),
  });
  extend?.(app);
  await app.ready();

  return {
    app,
    db,
    texts,
    sms: smsLog,
    emails,
    photos: profilePhotos.objects,
    media: postMedia.objects,
    printFiles,
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
