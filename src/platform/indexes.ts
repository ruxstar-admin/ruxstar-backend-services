import type { Database, ModuleSettingsDoc, SwitchableModule } from "./db.js";
import { stamp } from "./db.js";

export const SWITCHABLE_MODULES: readonly SwitchableModule[] = ["pod", "events", "coaching", "stays", "delivery", "ledger"];

export async function ensurePlatformIndexes(db: Database): Promise<void> {
  await Promise.all([
    db.moduleSettings.createIndex({ module: 1 }, { unique: true }),
    db.ruxstarStaff.createIndex({ userId: 1 }, { unique: true }),
    db.platformSettings.createIndex({ key: 1 }, { unique: true }),
    db.users.createIndex({ phone: 1 }, { unique: true }),
    db.users.createIndex({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: "string" } } }),
    db.users.createIndex({ username: 1 }, { unique: true, partialFilterExpression: { username: { $type: "string" } } }),
    db.users.createIndex({ status: 1 }),
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
  ]);
}

/** New modules start switched off. Existing settings are never overwritten. */
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
  );
}
