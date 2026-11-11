import { MongoBulkWriteError } from "mongodb";
import type { Database, ModuleSettingsDoc, SwitchableModule } from "./db.js";
import { stamp } from "./db.js";

export const SWITCHABLE_MODULES: readonly SwitchableModule[] = ["pod", "events", "coaching", "stays", "delivery", "ledger"];
/** Notifications are deleted after this many days. */
export const NOTIFICATION_DAYS = 90;

export async function ensurePlatformIndexes(db: Database): Promise<void> {
  await Promise.all([
    db.moduleSettings.createIndex({ module: 1 }, { unique: true }),
    db.ruxstarStaff.createIndex({ userId: 1 }, { unique: true }),
    db.platformSettings.createIndex({ key: 1 }, { unique: true }),
    db.users.createIndex({ phone: 1 }, { unique: true }),
    ensureVerifiedEmailIndex(db),
    db.users.createIndex({ username: 1 }, { unique: true, partialFilterExpression: { username: { $type: "string" } } }),
    db.users.createIndex({ status: 1 }),
    db.users.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 }),
    db.sessions.createIndex({ userId: 1, revokedAt: 1 }),
    db.sessions.createIndex(
      { refreshTokenHash: 1 },
      { unique: true, partialFilterExpression: { refreshTokenHash: { $type: "string" } } },
    ),
    db.sessions.createIndex({ prevRefreshTokenHash: 1 }, { partialFilterExpression: { prevRefreshTokenHash: { $type: "string" } } }),
    db.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.sessions.createIndex({ pushToken: 1 }, { partialFilterExpression: { pushToken: { $type: "string" } } }),
    db.otps.createIndex({ target: 1, purpose: 1 }, { unique: true }),
    db.otps.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.auditLogs.createIndex({ "scope.businessId": 1, at: -1 }),
    db.auditLogs.createIndex({ "scope.module": 1, at: -1 }),
    db.auditLogs.createIndex({ "actor.id": 1, at: -1 }),
    db.auditLogs.createIndex({ "target.id": 1, at: -1 }),
    db.idempotencyKeys.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.users.createIndex({ createdAt: -1, _id: -1 }),
    // The feed, and one person's posts on one tab.
    db.posts.createIndex({ status: 1, createdAt: -1, _id: -1 }),
    db.posts.createIndex({ authorId: 1, kind: 1, status: 1, createdAt: -1, _id: -1 }),
    db.postMedia.createIndex({ userId: 1, postId: 1, createdAt: 1 }),
    // Releasing and deleting a post's photos.
    db.postMedia.createIndex({ postId: 1 }),
    db.postReactions.createIndex({ postId: 1, userId: 1, kind: 1 }, { unique: true }),
    db.postReactions.createIndex({ userId: 1, kind: 1, createdAt: -1, _id: -1 }),
    db.postComments.createIndex({ postId: 1, status: 1, createdAt: -1, _id: -1 }),
    db.reports.createIndex({ "target.id": 1, userId: 1 }, { unique: true }),
    db.reports.createIndex({ status: 1, createdAt: -1 }),
    db.notifications.createIndex({ userId: 1, createdAt: -1, _id: -1 }),
    db.notifications.createIndex({ userId: 1, readAt: 1 }),
    db.notifications.createIndex({ userId: 1, type: 1, "link.id": 1, actorId: 1 }),
    db.notifications.createIndex({ createdAt: 1 }, { expireAfterSeconds: NOTIFICATION_DAYS * 24 * 60 * 60 }),
    db.kycCases.createIndex({ userId: 1, track: 1 }, { unique: true }),
    // The review queue, by status and optionally track, newest activity first.
    db.kycCases.createIndex({ status: 1, updatedAt: -1, _id: -1 }),
    db.kycCases.createIndex({ status: 1, track: 1, updatedAt: -1, _id: -1 }),
    db.kycCases.createIndex({ "steps.pan.hash": 1 }, { partialFilterExpression: { "steps.pan.hash": { $type: "string" } } }),
    db.users.createIndex({ "card.id": 1 }, { unique: true, partialFilterExpression: { "card.id": { $type: "string" } } }),
  ]);
}

/** The first version made every email unique; it is rebuilt once to cover verified emails only. */
async function ensureVerifiedEmailIndex(db: Database): Promise<void> {
  const filter = { email: { $type: "string" }, emailVerified: true };
  const existing = (await db.users.indexes().catch(() => [])).find((index) => index.name === "email_1");
  if (existing && JSON.stringify(existing.partialFilterExpression) !== JSON.stringify(filter)) {
    // Two instances starting together may both try; the second finds it already gone.
    await db.users.dropIndex("email_1").catch(() => undefined);
  }
  await db.users.createIndex({ email: 1 }, { unique: true, partialFilterExpression: filter });
}

/**
 * New modules start switched off. Existing settings are never overwritten. When another instance
 * seeds at the same moment, its rows win and the duplicate-key errors here are expected.
 */
export async function seedModuleSettings(db: Database): Promise<void> {
  const now = new Date();
  await db.moduleSettings.bulkWrite(
    SWITCHABLE_MODULES.map((module) => {
      const defaults: Omit<ModuleSettingsDoc, "_id"> = {
        module,
        live: false,
        signupsOpen: false,
        commissionBps: 0,
        deliveryEnabled: false,
        permissionCatalog: [],
        updatedBy: null,
        ...stamp(now),
      };
      return { updateOne: { filter: { module }, update: { $setOnInsert: defaults }, upsert: true } };
    }),
    { ordered: false },
  ).catch((err: unknown) => {
    const errors = err instanceof MongoBulkWriteError ? [err.writeErrors].flat() : [];
    if (errors.length === 0 || errors.some((e) => e.code !== 11000)) throw err;
  });
}
