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
    // The admin audit log: everything newest first, or one action.
    db.auditLogs.createIndex({ at: -1, _id: -1 }),
    db.auditLogs.createIndex({ action: 1, at: -1, _id: -1 }),
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
    db.reports.createIndex({ "target.id": 1, status: 1 }),
    // Follower and following lists, newest first, and the Following feed's author list.
    db.follows.createIndex({ followerId: 1, followeeId: 1 }, { unique: true }),
    db.follows.createIndex({ followeeId: 1, createdAt: -1, _id: -1 }),
    db.follows.createIndex({ followerId: 1, createdAt: -1, _id: -1 }),
    db.blocks.createIndex({ blockerId: 1, blockedId: 1 }, { unique: true }),
    db.blocks.createIndex({ blockerId: 1, createdAt: -1, _id: -1 }),
    db.blocks.createIndex({ blockedId: 1 }),
    db.userReports.createIndex({ userId: 1, reporterId: 1, status: 1 }),
    db.userReports.createIndex({ status: 1, createdAt: -1 }),
    db.posts.createIndex({ authorId: 1, status: 1, createdAt: -1, _id: -1 }),
    // Chats: one 1:1 chat per pair, each person's chat list newest first (chats and requests), and a chat's
    // messages newest first, plus what was unsent since a poll.
    db.conversations.createIndex({ pairKey: 1 }, { unique: true, partialFilterExpression: { pairKey: { $type: "string" } } }),
    db.chatMembers.createIndex({ conversationId: 1, userId: 1 }, { unique: true }),
    db.chatMembers.createIndex({ userId: 1, state: 1, lastAt: -1, _id: -1 }),
    db.chatMessages.createIndex({ conversationId: 1, createdAt: -1, _id: -1 }),
    db.chatMessages.createIndex({ conversationId: 1, unsentAt: 1 }, { partialFilterExpression: { status: "unsent" } }),
    db.chatMessages.createIndex({ conversationId: 1, touchedAt: 1 }, { partialFilterExpression: { touchedAt: { $type: "date" } } }),
    db.chatMessages.createIndex({ senderId: 1 }),
    db.notifications.createIndex({ userId: 1, createdAt: -1, _id: -1 }),
    db.notifications.createIndex({ userId: 1, readAt: 1 }),
    db.notifications.createIndex({ userId: 1, type: 1, "link.id": 1, actorId: 1 }),
    db.notifications.createIndex({ createdAt: 1 }, { expireAfterSeconds: NOTIFICATION_DAYS * 24 * 60 * 60 }),
    db.kycCases.createIndex({ userId: 1, track: 1 }, { unique: true }),
    // The review queue, by status, newest activity first.
    db.kycCases.createIndex({ status: 1, updatedAt: -1, _id: -1 }),
    db.kycCases.createIndex({ status: 1, track: 1, updatedAt: -1, _id: -1 }),
    db.kycCases.createIndex({ "steps.pan.hash": 1 }, { partialFilterExpression: { "steps.pan.hash": { $type: "string" } } }),
    db.users.createIndex({ "card.id": 1 }, { unique: true, partialFilterExpression: { "card.id": { $type: "string" } } }),
    // A vendor's own businesses, and the console's list: everything, or one module or status.
    db.businesses.createIndex({ ownerId: 1, createdAt: -1 }),
    db.businesses.createIndex({ updatedAt: -1, _id: -1 }),
    db.businesses.createIndex({ module: 1, status: 1, updatedAt: -1, _id: -1 }),
    db.businesses.createIndex({ module: 1, status: 1, publishedAt: -1, _id: -1 }),
    db.businesses.createIndex({ status: 1, updatedAt: -1, _id: -1 }),
    db.payoutMethods.createIndex({ userId: 1 }, { unique: true }),
    db.payouts.createIndex({ vendorId: 1, createdAt: -1, _id: -1 }),
    // One withdrawal on the way per vendor, so two taps at once can't both take the balance.
    db.payouts.createIndex({ vendorId: 1 }, { name: "one_pending_payout", unique: true, partialFilterExpression: { status: "pending" } }),
    db.payouts.createIndex({ status: 1, checkedAt: 1 }),
    db.payouts.createIndex({ status: 1, createdAt: -1, _id: -1 }),
    db.printFiles.createIndex({ userId: 1, orderId: 1, createdAt: 1 }),
    // A customer's orders, a shop's orders (all, or one status), and finding an order from Cashfree's id.
    db.podOrders.createIndex({ orderNo: 1 }, { unique: true }),
    db.podOrders.createIndex({ customerId: 1, createdAt: -1, _id: -1 }),
    db.podOrders.createIndex({ vendorId: 1, status: 1, createdAt: -1, _id: -1 }),
    db.podOrders.createIndex({ shopId: 1, status: 1, createdAt: -1, _id: -1 }),
    db.podOrders.createIndex({ "payment.gatewayOrderId": 1 }, { unique: true }),
    // The order timers: not accepted in time, long past the ready date, the shop's share due, refunds to retry.
    db.podOrders.createIndex({ status: 1, acceptBy: 1 }),
    db.podOrders.createIndex({ status: 1, readyBy: 1 }),
    db.podOrders.createIndex({ status: 1, releaseAt: 1 }),
    db.podOrders.createIndex({ status: 1, releasedAt: 1, releaseAt: -1, _id: -1 }),
    db.podOrders.createIndex({ "refunds.status": 1 }, { partialFilterExpression: { "refunds.status": "pending" } }),
    // The console's order problems, open or settled, newest first.
    db.podOrders.createIndex({ "problem.status": 1, problemAt: -1, _id: -1 }),
    // One entry per account and bucket in a transaction, so a money move can't be written twice.
    db.ledgerEntries.createIndex({ txnId: 1, accountId: 1, bucket: 1 }, { unique: true }),
    db.ledgerEntries.createIndex({ accountId: 1, bucket: 1 }),
    db.ledgerEntries.createIndex({ accountId: 1, at: -1, _id: -1 }),
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
        platformFee: 0,
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
