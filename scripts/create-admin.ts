/**
 * Makes a phone number an admin, creating the account if it does not exist, and sets its password.
 *
 *   ADMIN_PHONE=+91XXXXXXXXXX ADMIN_PASSWORD=... npm run create-admin
 *
 * Runs only against ruxstar_dev. Existing sessions for the account are signed out.
 */
import { ObjectId } from "mongodb";
import { loadConfig } from "../src/config.js";
import { TERMS_VERSION } from "../src/modules/account/index.js";
import { checkPasswordRules, hashPassword } from "../src/modules/account/passwords.js";
import { firstFreeUsername } from "../src/modules/account/usernames.js";
import { createDatabase, stamp, type UserDoc } from "../src/platform/db.js";

const phone = process.env.ADMIN_PHONE?.trim() ?? "";
const password = process.env.ADMIN_PASSWORD ?? "";
const name = process.env.ADMIN_NAME?.trim() || "Ruxstar Admin";
if (!/^\+91[6-9]\d{9}$/.test(phone)) throw new Error("Set ADMIN_PHONE to an Indian mobile in +91 format.");
if (password.length < 8) throw new Error("Set ADMIN_PASSWORD (at least 8 characters).");
checkPasswordRules(password, phone);

const config = loadConfig(process.env);
if (config.mongo?.db !== "ruxstar_dev") throw new Error(`Refusing to write to "${config.mongo?.db}". This script is for ruxstar_dev only.`);

const db = createDatabase(config.mongo.uri, config.mongo.db);
await db.client.connect();
try {
  const now = new Date();
  const hash = await hashPassword(password);
  const existing = await db.users.findOne({ phone }, { projection: { _id: 1, status: 1 } });
  let userId: ObjectId;
  if (existing) {
    userId = existing._id;
    if (existing.status === "deleted") throw new Error("That number belongs to a deleted account.");
    await db.users.updateOne(
      { _id: existing._id },
      { $set: { "roles.admin": true, passwordHash: hash, "lock.failedCount": 0, "lock.lockedUntil": null, updatedAt: now } },
    );
    await db.sessions.updateMany({ userId: existing._id, revokedAt: null }, { $set: { revokedAt: now, updatedAt: now } });
    console.log(`Existing account ${existing._id.toHexString()} is now admin.`);
  } else {
    const user: UserDoc = {
      _id: new ObjectId(),
      phone,
      passwordHash: hash,
      passwordHistory: [],
      name,
      username: await firstFreeUsername(db, name),
      dob: null,
      gender: null,
      avatar: null,
      status: "active",
      roles: { admin: true },
      kyc: { base: "none" },
      lock: { failedCount: 0, lockedUntil: null },
      consent: { termsVersion: TERMS_VERSION, acceptedAt: now },
      home: { city: null },
      prefs: {},
      ...stamp(now),
    };
    await db.users.insertOne(user);
    userId = user._id;
    console.log(`Created admin ${user._id.toHexString()} (@${user.username}).`);
  }
  await db.auditLogs.insertOne({
    actor: { id: null, kind: "system" },
    scope: { module: "account" },
    action: "admin.grant",
    target: { type: "user", id: userId },
    diff: { "roles.admin": { from: null, to: true } },
    ip: null,
    at: now,
    ...stamp(now),
  });
} finally {
  await db.client.close();
}
