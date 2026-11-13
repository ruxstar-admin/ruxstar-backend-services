import { randomUUID } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { MongoServerError, ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { writeAudit } from "../../platform/audit.js";
import { readAccessClaims, requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import { stamp, type Database, type UserDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import {
  ChangePasswordBody,
  DeleteBody,
  DeviceBody,
  Done,
  EmailCodeSent,
  EmailVerifyBody,
  LoginBody,
  LoginCodeBody,
  LoginResult,
  CityQuery,
  CityResult,
  MePatch,
  MeResult,
  UsernameQuery,
  UsernameResult,
  OtpRequest,
  OtpSent,
  OtpVerify,
  ProfileList,
  ProfileParams,
  ProfileResult,
  ProfileSearchQuery,
  RefreshBody,
  RefreshResult,
  ResetBody,
  SessionList,
  SessionParams,
  SignupBody,
  SignupResult,
  Verified,
  type PublicProfile,
  type User,
} from "./contracts.js";
import { blockBetween, blockedAround } from "../social/relations.js";
import { eraseChats } from "../social/chats.js";
import { signedInIfPossible } from "../social/shared.js";
import { checkCode, countText, sendCode, useVerification } from "./otp.js";
import { PHOTO_MAX_BYTES, toAvatar } from "./photos.js";
import { firstFreeUsername, isAvailable, isReserved, suggestUsernames } from "./usernames.js";
import { checkPasswordRules, hashPassword, verifyAgainstNothing, verifyPassword, wasUsedRecently } from "./passwords.js";
import {
  clearTokens,
  deliverTokens,
  issueTokens,
  readRefreshToken,
  revokeByRefreshToken,
  rotateRefreshToken,
  startSession,
} from "./sessions.js";

export const TERMS_VERSION = "2026-11-30";
const LOCK_AFTER_FAILURES = 5;
const LOCK_MINUTES = 15;
const MIN_AGE_YEARS = 13;
const PURGE_AFTER_DAYS = 30;
/** For reads that never check a password. */
const WITHOUT_PASSWORDS = { passwordHash: 0, passwordHistory: 0 } as const;

const e164 = (phone: string) => `+91${phone}`;
const maskPhone = (phone: string) => `+91 ••••• •${phone.slice(-4)}`;
const maskEmail = (email: string) => {
  const [user = "", domain = ""] = email.split("@");
  return `${user.slice(0, 2)}***@${domain}`;
};
/** Bound to the user and the address, so a code for an old address stops working when it changes. */
const emailTarget = (user: UserDoc) => `${user._id.toHexString()}:${user.email}`;
const noEmail = () =>
  new AppError("VALIDATION_FAILED", "Add an email to your profile first.", [{ path: "body/email", message: "No email on this account" }]);
const minutes = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;
const isDuplicate = (err: unknown, field: string) =>
  err instanceof MongoServerError && err.code === 11000 && Object.hasOwn(err.keyPattern ?? {}, field);

const BIO_LINES = 4;

/**
 * At most 4 lines, one empty line in a row, no spaces at line ends; lines past the 4th join the 4th.
 * Also applied on read, for bios saved before the rule.
 */
const tidyBio = (bio: string | null | undefined) => {
  const lines = (bio ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .split("\n");
  const kept = lines.slice(0, BIO_LINES - 1);
  const rest = lines.slice(BIO_LINES - 1).filter(Boolean).join(" ");
  return [...kept, ...(rest ? [rest] : [])].join("\n").trim() || null;
};

const statsOf = (user: UserDoc) => ({
  posts: Math.max(0, user.social?.posts ?? 0),
  engagements: Math.max(0, user.social?.engagements ?? 0),
  followers: Math.max(0, user.social?.followers ?? 0),
  following: Math.max(0, user.social?.following ?? 0),
});

const view = (user: UserDoc): User => ({
  id: user._id.toHexString(),
  phone: user.phone,
  name: user.name ?? "",
  username: user.username ?? "",
  email: user.email ?? null,
  emailVerified: Boolean(user.email && user.emailVerified),
  avatarUrl: user.avatar ?? null,
  bio: tidyBio(user.bio),
  dob: user.dob ?? null,
  gender: user.gender ?? null,
  city: user.home?.city ?? null,
  roles: {
    vendor: Boolean(user.roles.vendor),
    delivery: Boolean(user.roles.delivery),
    ruxstarStaff: Boolean(user.roles.ruxstarStaff),
    admin: Boolean(user.roles.admin),
  },
  kyc: { base: user.kyc.base ?? "none", vendor: user.kyc.vendor ?? "none" },
  card: user.card ? { id: user.card.id } : null,
  stats: statsOf(user),
  createdAt: user.createdAt.toISOString(),
});

const publicView = (user: UserDoc): PublicProfile => ({
  id: user._id.toHexString(),
  name: user.name ?? "",
  username: user.username ?? "",
  avatarUrl: user.avatar ?? null,
  bio: tidyBio(user.bio),
  city: user.home?.city ?? null,
  badges: { verified: user.kyc.base === "approved", vendor: Boolean(user.roles.vendor), delivery: Boolean(user.roles.delivery) },
  stats: statsOf(user),
  memberSince: user.createdAt.toISOString(),
});

/** Password managers fill the saved phone number into the first text box; a name needs letters. */
function checkName(name: string | undefined) {
  if (name === undefined) return;
  if (!/\p{L}/u.test(name) || /\d{6,}/.test(name)) {
    throw new AppError("VALIDATION_FAILED", undefined, [{ path: "body/name", message: "Enter your name, not a number." }]);
  }
}

function checkDob(dob: string | null | undefined) {
  if (!dob) return;
  const born = new Date(`${dob}T00:00:00Z`);
  const latest = new Date();
  latest.setUTCFullYear(latest.getUTCFullYear() - MIN_AGE_YEARS);
  if (Number.isNaN(born.getTime()) || born > latest || born.getUTCFullYear() < 1900) {
    throw new AppError("VALIDATION_FAILED", undefined, [
      { path: "body/dob", message: `You need to be at least ${MIN_AGE_YEARS} years old.` },
    ]);
  }
}

/**
 * Per IP. Indian carriers put many phones behind one address, so these are loose; the per-number
 * limits on codes and passwords do the real work.
 */
const secured = (perMinutes: number, max: number) => ({ rateLimit: { max, timeWindow: perMinutes * 60_000 } });

const account: FastifyPluginAsyncTypebox = async (app) => {
  const deps = () => ({ db: requireDatabase(app.db), sms: app.sms, secret: requireSecret() });
  const requireSecret = () => {
    if (!app.config.jwtSecret) throw new AppError("NOT_READY", "Sign-in is not configured.");
    return app.config.jwtSecret;
  };

  app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: PHOTO_MAX_BYTES }, (_request, body, done) => done(null, body));

  app.post(
    "/otp",
    {
      config: secured(10, 30),
      schema: {
        tags: ["account"],
        summary: "Text a 6-digit code to a number, to sign up, sign in or reset a password",
        body: OtpRequest,
        response: { 200: OtpSent, ...Errors },
      },
    },
    async (request) => {
      const d = deps();
      const phone = e164(request.body.phone);
      const user = await d.db.users.findOne({ phone, status: { $ne: "deleted" } }, { projection: { _id: 1 } });
      if (request.body.purpose === "signup" && user) throw new AppError("PHONE_TAKEN");
      if (request.body.purpose !== "signup" && !user) {
        throw new AppError("NOT_FOUND", "No account uses this number. Create one instead.");
      }
      const sent = await sendCode(d, phone, request.body.purpose, async (code) => {
        await d.sms.sendOtp(phone, code);
        await countText(d.db, app.config.smsDailyLimit, request.log);
      });
      return ok(request, { sentTo: maskPhone(phone), ...sent });
    },
  );

  app.post(
    "/otp/verify",
    {
      config: secured(10, 60),
      schema: {
        tags: ["account"],
        summary: "Check the code and get a verification token for signup or reset",
        body: OtpVerify,
        response: { 200: Verified, ...Errors },
      },
    },
    async (request) => {
      const { phone, purpose, code } = request.body;
      return ok(request, await checkCode(deps(), e164(phone), purpose, code));
    },
  );

  app.post(
    "/signup",
    {
      config: secured(10, 30),
      schema: {
        tags: ["account"],
        summary: "Create an account with a verified number, then sign in",
        description: "Not idempotent by key: the verification token works once and the number is unique.",
        body: SignupBody,
        response: { 201: SignupResult, ...Errors },
      },
    },
    async (request, reply) => {
      const d = deps();
      const body = request.body;
      const name = body.name.trim().replace(/\s+/g, " ");
      checkName(name);
      checkDob(body.dob);
      const email = body.email?.trim().toLowerCase();
      if (body.username && isReserved(body.username)) {
        throw new AppError("USERNAME_TAKEN", "That username is reserved. Try another.", [{ path: "body/username", message: "Reserved" }]);
      }
      const hash = await hashPassword(body.password);
      const result = await d.db
        .transaction(async (session) => {
          const phone = await useVerification(d, body.verificationToken, "signup", session);
          checkPasswordRules(body.password, phone);
          if (await d.db.users.findOne({ phone }, { session, projection: { _id: 1 } })) throw new AppError("PHONE_TAKEN");
          if (body.username && !(await isAvailable(d.db, body.username))) {
            throw new AppError("USERNAME_TAKEN", undefined, [{ path: "body/username", message: "Taken" }]);
          }

          const now = new Date();
          const user: UserDoc = {
            _id: new ObjectId(),
            phone,
            ...(email ? { email, emailVerified: false } : {}),
            passwordHash: hash,
            passwordHistory: [],
            name,
            username: body.username ?? (await firstFreeUsername(d.db, name, session)),
            dob: body.dob ?? null,
            gender: body.gender ?? null,
            avatar: null,
            status: "active",
            roles: {},
            kyc: { base: "none" },
            lock: { failedCount: 0, lockedUntil: null },
            consent: { termsVersion: TERMS_VERSION, acceptedAt: now },
            home: { city: null },
            prefs: {},
            ...stamp(now),
          };
          await d.db.users.insertOne(user, { session });
          const started = await startSession(d.db, request, user._id, body, session);
          return { user, started };
        })
        .catch((err: unknown) => {
          if (isDuplicate(err, "phone")) throw new AppError("PHONE_TAKEN");
          if (isDuplicate(err, "username")) {
            if (body.username) throw new AppError("USERNAME_TAKEN", undefined, [{ path: "body/username", message: "Taken" }]);
            throw new AppError("CONFLICT", "Something clashed. Try again.");
          }
          throw err;
        });

      const tokens = await issueTokens(request, result.user._id, result.started);
      reply.status(201);
      return ok(request, { user: view(result.user), tokens: deliverTokens(request, reply, tokens) });
    },
  );

  app.post(
    "/login",
    {
      config: secured(10, 60),
      schema: {
        tags: ["account"],
        summary: "Sign in with number and password",
        description: `${LOCK_AFTER_FAILURES} wrong passwords lock the account for ${minutes(LOCK_MINUTES)}.`,
        body: LoginBody,
        response: { 200: LoginResult, ...Errors },
      },
    },
    async (request, reply) => {
      const d = deps();
      const phone = e164(request.body.phone);
      const user = await d.db.users.findOne({ phone });
      if (!user || !user.passwordHash || user.status === "deleted") {
        await verifyAgainstNothing(request.body.password);
        throw new AppError("INVALID_CREDENTIALS");
      }

      const now = new Date();
      const lockedFor = (until: Date) => {
        const secs = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));
        return new AppError("ACCOUNT_LOCKED", undefined, [
          { message: `Try again in ${minutes(Math.ceil(secs / 60))}.`, retryAfterSeconds: secs },
        ]);
      };
      // Reserve the attempt before the slow hash check, so a burst of parallel guesses cannot exceed the limit.
      const reserved = await d.db.users.findOneAndUpdate(
        {
          _id: user._id,
          $and: [
            { $or: [{ "lock.lockedUntil": null }, { "lock.lockedUntil": { $lte: now } }] },
            { $or: [{ "lock.failedCount": { $exists: false } }, { "lock.failedCount": { $lt: LOCK_AFTER_FAILURES } }] },
          ],
        },
        { $inc: { "lock.failedCount": 1 }, $set: { "lock.lockedUntil": null } },
        { returnDocument: "after", projection: { lock: 1 } },
      );
      if (!reserved) {
        const current = await d.db.users.findOne({ _id: user._id }, { projection: { lock: 1 } });
        const until = current?.lock?.lockedUntil;
        throw lockedFor(until && until > now ? until : new Date(now.getTime() + LOCK_MINUTES * 60_000));
      }

      if (!(await verifyPassword(request.body.password, user.passwordHash))) {
        if ((reserved.lock?.failedCount ?? 0) >= LOCK_AFTER_FAILURES) {
          const until = new Date(now.getTime() + LOCK_MINUTES * 60_000);
          await d.db.users.updateOne({ _id: user._id }, { $set: { lock: { failedCount: 0, lockedUntil: until } } });
          throw new AppError("ACCOUNT_LOCKED", undefined, [
            { message: `Try again in ${minutes(LOCK_MINUTES)}.`, retryAfterSeconds: LOCK_MINUTES * 60 },
          ]);
        }
        throw new AppError("INVALID_CREDENTIALS");
      }
      await d.db.users.updateOne({ _id: user._id }, { $set: { lock: { failedCount: 0, lockedUntil: null } } });
      if (user.status === "locked") throw new AppError("FORBIDDEN", "This account is on hold. Contact support.");
      const started = await startSession(d.db, request, user._id, request.body);
      const tokens = await issueTokens(request, user._id, started);
      return ok(request, { user: view(user), tokens: deliverTokens(request, reply, tokens) });
    },
  );

  app.post(
    "/login/code",
    {
      config: secured(10, 60),
      schema: {
        tags: ["account"],
        summary: "Sign in with the code texted by POST /otp (purpose login)",
        description: "The code's own limits apply: five wrong codes lock that number's codes for 5 minutes.",
        body: LoginCodeBody,
        response: { 200: LoginResult, ...Errors },
      },
    },
    async (request, reply) => {
      const d = deps();
      const phone = e164(request.body.phone);
      const { verificationToken } = await checkCode(d, phone, "login", request.body.code);
      await useVerification(d, verificationToken, "login");
      const user = await d.db.users.findOne({ phone, status: { $ne: "deleted" } });
      if (!user) throw new AppError("NOT_FOUND", "No account uses this number. Create one instead.");
      if (user.status === "locked") throw new AppError("FORBIDDEN", "This account is on hold. Contact support.");
      const started = await startSession(d.db, request, user._id, request.body);
      const tokens = await issueTokens(request, user._id, started);
      return ok(request, { user: view(user), tokens: deliverTokens(request, reply, tokens) });
    },
  );

  app.post(
    "/refresh",
    {
      config: secured(1, 60),
      schema: {
        tags: ["account"],
        summary: "Swap the refresh token for a new access and refresh token",
        description: "Each refresh token works once. Reusing one ends the session.",
        body: RefreshBody,
        response: { 200: RefreshResult, ...Errors },
      },
    },
    async (request, reply) => {
      const d = deps();
      const token = readRefreshToken(request, request.body?.refreshToken);
      if (!token) throw new AppError("UNAUTHENTICATED");
      let rotation;
      try {
        rotation = await rotateRefreshToken(d.db, request, token);
      } catch (err) {
        clearTokens(request, reply);
        throw err;
      }
      const user = await d.db.users.findOne({ _id: rotation.userId }, { projection: { status: 1 } });
      if (!user || user.status !== "active") {
        await d.db.sessions.updateOne({ _id: rotation.sessionId }, { $set: { revokedAt: new Date() } });
        app.authCache.forget(rotation.userId);
        clearTokens(request, reply);
        throw new AppError("UNAUTHENTICATED");
      }

      if (rotation.kind === "raced") {
        const tokens = await issueTokens(request, rotation.userId, { sessionId: rotation.sessionId, refreshToken: "", expiresAt: new Date() });
        deliverTokens(request, reply, tokens, { refresh: false });
        return ok(request, {});
      }
      const tokens = await issueTokens(request, rotation.userId, rotation);
      return ok(request, { tokens: deliverTokens(request, reply, tokens) });
    },
  );

  app.post(
    "/logout",
    {
      schema: {
        tags: ["account"],
        summary: "End this session",
        body: RefreshBody,
        response: { 200: Done, ...Errors },
      },
    },
    async (request, reply) => {
      const db = requireDatabase(app.db);
      const now = new Date();
      const claims = await readAccessClaims(request);
      if (claims) {
        await db.sessions.updateOne({ _id: claims.sessionId, userId: claims.userId }, { $set: { revokedAt: now, updatedAt: now } });
        app.authCache.forget(claims.userId);
      } else {
        const token = readRefreshToken(request, request.body?.refreshToken);
        const userId = token ? await revokeByRefreshToken(db, token) : null;
        if (userId) app.authCache.forget(userId);
      }
      clearTokens(request, reply);
      return ok(request, { done: true as const });
    },
  );

  app.post(
    "/password/reset",
    {
      config: secured(10, 30),
      schema: {
        tags: ["account"],
        summary: "Set a new password with a verified number. Signs out every device.",
        body: ResetBody,
        response: { 200: Done, ...Errors },
      },
    },
    async (request) => {
      const d = deps();
      const now = new Date();
      const hash = await hashPassword(request.body.password);
      const userId = await d.db.transaction(async (session) => {
        const phone = await useVerification(d, request.body.verificationToken, "reset", session);
        const user = await d.db.users.findOne({ phone, status: { $ne: "deleted" } }, { session });
        if (!user) throw new AppError("VERIFICATION_INVALID");
        checkPasswordRules(request.body.password, phone);
        if (await wasUsedRecently(request.body.password, user.passwordHash, user.passwordHistory)) {
          throw new AppError("PASSWORD_REUSED");
        }
        await d.db.users.updateOne(
          { _id: user._id },
          {
            $set: {
              passwordHash: hash,
              passwordHistory: [user.passwordHash, ...(user.passwordHistory ?? [])].filter((h): h is string => Boolean(h)).slice(0, 2),
              lock: { failedCount: 0, lockedUntil: null },
              updatedAt: now,
            },
          },
          { session },
        );
        await d.db.sessions.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: now, updatedAt: now } }, { session });
        await writeAudit(
          d.db,
          { actor: { id: user._id, kind: "user" }, scope: { module: "account" }, action: "user.password_reset", target: { type: "user", id: user._id }, diff: {}, ip: request.ip },
          session,
        );
        return user._id;
      });
      app.authCache.forget(userId);
      return ok(request, { done: true as const });
    },
  );

  app.post(
    "/password",
    {
      preHandler: requireAuth,
      config: secured(10, 10),
      schema: {
        tags: ["account"],
        summary: "Change the password. Signs out every other device.",
        body: ChangePasswordBody,
        response: { 200: Done, ...Errors },
        security: [{ bearer: [] }, { cookie: [] }],
      },
    },
    async (request) => {
      const db = requireDatabase(app.db);
      const auth = request.auth!;
      const user = await db.users.findOne({ _id: auth.userId });
      if (!user?.passwordHash || !(await verifyPassword(request.body.currentPassword, user.passwordHash))) {
        throw new AppError("INVALID_CREDENTIALS", "Your current password is not right.", [{ path: "body/currentPassword", message: "Not right" }]);
      }
      checkPasswordRules(request.body.newPassword, user.phone);
      if (await wasUsedRecently(request.body.newPassword, user.passwordHash, user.passwordHistory)) {
        throw new AppError("PASSWORD_REUSED");
      }
      const now = new Date();
      const hash = await hashPassword(request.body.newPassword);
      await db.transaction(async (session) => {
        await db.users.updateOne(
          { _id: user._id },
          { $set: { passwordHash: hash, passwordHistory: [user.passwordHash!, ...(user.passwordHistory ?? [])].slice(0, 2), updatedAt: now } },
          { session },
        );
        await db.sessions.updateMany(
          { userId: user._id, revokedAt: null, _id: { $ne: auth.sessionId } },
          { $set: { revokedAt: now, updatedAt: now } },
          { session },
        );
        await writeAudit(
          db,
          { actor: { id: user._id, kind: "user" }, scope: { module: "account" }, action: "user.password_change", target: { type: "user", id: user._id }, diff: {}, ip: request.ip },
          session,
        );
      });
      app.authCache.forget(user._id);
      return ok(request, { done: true as const });
    },
  );

  app.get(
    "/me",
    {
      preHandler: requireAuth,
      schema: { tags: ["account"], summary: "The signed-in user", response: { 200: MeResult, ...Errors }, security: [{ bearer: [] }, { cookie: [] }] },
    },
    async (request) => {
      const user = await requireDatabase(app.db).users.findOne({ _id: request.auth!.userId }, { projection: WITHOUT_PASSWORDS });
      if (!user) throw new AppError("UNAUTHENTICATED");
      return ok(request, view(user));
    },
  );

  app.patch(
    "/me",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["account"],
        summary: "Update name, username, email, bio, date of birth, gender or city",
        body: MePatch,
        response: { 200: MeResult, ...Errors },
        security: [{ bearer: [] }, { cookie: [] }],
      },
    },
    async (request) => {
      const db = requireDatabase(app.db);
      const { name, username, email, bio, dob, gender, city } = request.body;
      checkName(name);
      checkDob(dob);
      if (username && isReserved(username)) {
        throw new AppError("USERNAME_TAKEN", "That username is reserved. Try another.", [{ path: "body/username", message: "Reserved" }]);
      }
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (name !== undefined) set.name = name.trim().replace(/\s+/g, " ");
      if (username !== undefined) set.username = username;
      const unset: Record<string, ""> = {};
      if (email) {
        const address = email.trim().toLowerCase();
        const current = await db.users.findOne({ _id: request.auth!.userId }, { projection: { email: 1 } });
        if (current?.email !== address) {
          set.email = address;
          set.emailVerified = false;
        }
      } else if (email === null) {
        unset.email = "";
        unset.emailVerified = "";
      }
      if (bio !== undefined) set.bio = tidyBio(bio);
      if (dob !== undefined) set.dob = dob;
      if (gender !== undefined) set.gender = gender;
      if (city !== undefined) set["home.city"] = city?.trim() ?? null;
      const user = await db.users
        .findOneAndUpdate(
          { _id: request.auth!.userId },
          { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
          { returnDocument: "after" },
        )
        .catch((err: unknown) => {
          if (isDuplicate(err, "username")) throw new AppError("USERNAME_TAKEN", undefined, [{ path: "body/username", message: "Taken" }]);
          throw err;
        });
      if (!user) throw new AppError("UNAUTHENTICATED");
      return ok(request, view(user));
    },
  );

  app.put(
    "/me/photo",
    {
      preHandler: requireAuth,
      config: secured(60, 10),
      schema: {
        tags: ["account"],
        summary: "Add or replace the profile photo",
        description:
          "Send the image itself as the body with Content-Type image/jpeg, image/png or image/webp, up to 5 MB. " +
          "It is cropped to a 512 x 512 square and saved as WebP without its metadata. The old photo is deleted.",
        response: { 200: MeResult, ...Errors },
        security: [{ bearer: [] }, { cookie: [] }],
      },
    },
    async (request) => {
      const db = requireDatabase(app.db);
      const userId = request.auth!.userId;
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw new AppError("PHOTO_INVALID");
      const photo = await toAvatar(request.body);
      const key = `profile-pictures/${app.config.env}/${userId.toHexString()}/${randomUUID()}.webp`;
      const url = await app.photos.save(key, photo);
      const now = new Date();
      const before = await db.users.findOneAndUpdate(
        { _id: userId, status: { $ne: "deleted" } },
        { $set: { avatar: url, avatarKey: key, updatedAt: now } },
        { returnDocument: "before" },
      );
      if (!before) {
        await app.photos.remove(key);
        throw new AppError("UNAUTHENTICATED");
      }
      if (before.avatarKey) await app.photos.remove(before.avatarKey);
      return ok(request, view({ ...before, avatar: url, avatarKey: key, updatedAt: now }));
    },
  );

  app.delete(
    "/me/photo",
    {
      preHandler: requireAuth,
      config: secured(60, 10),
      schema: {
        tags: ["account"],
        summary: "Remove the profile photo",
        response: { 200: MeResult, ...Errors },
        security: [{ bearer: [] }, { cookie: [] }],
      },
    },
    async (request) => {
      const db = requireDatabase(app.db);
      const now = new Date();
      const before = await db.users.findOneAndUpdate(
        { _id: request.auth!.userId, status: { $ne: "deleted" } },
        { $set: { avatar: null, avatarKey: null, updatedAt: now } },
        { returnDocument: "before" },
      );
      if (!before) throw new AppError("UNAUTHENTICATED");
      if (before.avatarKey) await app.photos.remove(before.avatarKey);
      return ok(request, view({ ...before, avatar: null, avatarKey: null, updatedAt: now }));
    },
  );

  app.get(
    "/profiles",
    {
      preHandler: requireAuth,
      config: secured(1, 60),
      schema: {
        tags: ["account"],
        summary: "Find people by username or name, or list the newest members",
        description:
          "Signed-in only. Matches usernames that start with `q` and names with a word that starts with `q`, ignoring case; an exact username comes first. " +
          "Without `q`, the newest members. Leaves out you and deleted accounts.",
        querystring: ProfileSearchQuery,
        response: { 200: ProfileList, ...Errors },
        security: [{ bearer: [] }, { cookie: [] }],
      },
    },
    async (request) => {
      const { q, limit = 20 } = request.query;
      const db = requireDatabase(app.db);
      const hidden = await blockedAround(db, request.auth!.userId);
      const notMe = { $nin: [request.auth!.userId, ...hidden] };
      const listed = { _id: notMe, status: { $ne: "deleted" as const }, username: { $type: "string" as const } };
      if (q === undefined) {
        const newest = await db.users.find(listed).sort({ createdAt: -1, _id: -1 }).limit(limit).toArray();
        return page(request, newest.map(publicView), null);
      }
      const term = q.trim().toLowerCase().replace(/^@/, "");
      if (term.length < 2) return page(request, [], null);
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const docs = await db
        .users.find({
          _id: notMe,
          status: { $ne: "deleted" },
          username: { $type: "string" },
          $or: [{ username: { $regex: `^${escaped}` } }, { name: { $regex: `(^|\\s)${escaped}`, $options: "i" } }],
        })
        .sort({ username: 1 })
        .limit(limit)
        .toArray();
      const exactFirst = [...docs].sort((a, b) => Number(b.username === term) - Number(a.username === term));
      return page(request, exactFirst.map(publicView), null);
    },
  );

  app.get(
    "/profiles/:ref",
    {
      // The website renders profiles on its server, so many visitors share its address.
      config: secured(1, 300),
      preHandler: signedInIfPossible,
      schema: {
        tags: ["account"],
        summary: "Anyone's public profile, by username or id",
        description: "No sign-in needed. Deleted accounts, and people who blocked you, answer NOT_FOUND.",
        params: ProfileParams,
        response: { 200: ProfileResult, ...Errors },
        security: [{}, { bearer: [] }, { cookie: [] }],
      },
    },
    async (request, reply) => {
      const db = requireDatabase(app.db);
      const ref = request.params.ref.toLowerCase();
      const byId = /^[0-9a-f]{24}$/.test(ref);
      const user = await db.users.findOne({
        ...(byId ? { _id: new ObjectId(ref) } : { username: ref }),
        status: { $ne: "deleted" },
      });
      if (!user?.username) throw new AppError("NOT_FOUND", "No one has that username.");
      if ((await blockBetween(db, request.auth?.userId ?? null, user._id)) === "theirs") throw new AppError("NOT_FOUND", "No one has that username.");
      reply.header("vary", "Cookie, Authorization");
      reply.header("cache-control", request.auth ? "private, no-store" : "public, max-age=60");
      return ok(request, publicView(user));
    },
  );

  app.post(
    "/email/code",
    {
      preHandler: requireAuth,
      config: secured(10, 10),
      schema: {
        tags: ["account"],
        summary: "Email a 6-digit code to the address on the profile",
        description: "The same limits as texted codes: 30 seconds between sends, three resends, five tries.",
        response: { 200: EmailCodeSent, ...Errors },
        security: [{ bearer: [] }, { cookie: [] }],
      },
    },
    async (request) => {
      const d = deps();
      const user = await d.db.users.findOne({ _id: request.auth!.userId }, { projection: WITHOUT_PASSWORDS });
      if (!user) throw new AppError("UNAUTHENTICATED");
      if (!user.email) throw noEmail();
      if (user.emailVerified) throw new AppError("CONFLICT", "Your email is already verified.");
      const address = user.email;
      const sent = await sendCode(d, emailTarget(user), "email", (code) => app.email.sendCode(address, code));
      return ok(request, { sentTo: maskEmail(address), ...sent });
    },
  );

  app.post(
    "/email/verify",
    {
      preHandler: requireAuth,
      config: secured(10, 30),
      schema: {
        tags: ["account"],
        summary: "Verify the email with the code from POST /email/code",
        description: "A verified email belongs to one account. If another account verified it first, this answers EMAIL_TAKEN.",
        body: EmailVerifyBody,
        response: { 200: MeResult, ...Errors },
        security: [{ bearer: [] }, { cookie: [] }],
      },
    },
    async (request) => {
      const d = deps();
      const user = await d.db.users.findOne({ _id: request.auth!.userId }, { projection: WITHOUT_PASSWORDS });
      if (!user) throw new AppError("UNAUTHENTICATED");
      if (!user.email) throw noEmail();
      if (user.emailVerified) return ok(request, view(user));
      const { verificationToken } = await checkCode(d, emailTarget(user), "email", request.body.code).catch((err: unknown) => {
        if (err instanceof AppError && err.code === "OTP_INVALID") {
          throw new AppError("OTP_INVALID", "That code is not right. Check the email and try again.", err.details);
        }
        throw err;
      });
      await useVerification(d, verificationToken, "email");
      const verified = await d.db.users
        .findOneAndUpdate(
          { _id: user._id, email: user.email },
          { $set: { emailVerified: true, updatedAt: new Date() } },
          { returnDocument: "after" },
        )
        .catch((err: unknown) => {
          if (isDuplicate(err, "email")) {
            throw new AppError("EMAIL_TAKEN", "Another account has already verified this email.", [{ path: "body/email", message: "Taken" }]);
          }
          throw err;
        });
      if (!verified) throw new AppError("CONFLICT", "Your email changed. Ask for a new code.");
      return ok(request, view(verified));
    },
  );

  app.delete(
    "/me",
    {
      preHandler: requireAuth,
      config: secured(10, 5),
      schema: {
        tags: ["account"],
        summary: "Delete the account after checking the password. Signs out every device.",
        description: `Sign-in stops at once and the number, username and email are freed. The record is erased after ${PURGE_AFTER_DAYS} days.`,
        body: DeleteBody,
        response: { 200: Done, ...Errors },
        security: [{ bearer: [] }, { cookie: [] }],
      },
    },
    async (request, reply) => {
      const db = requireDatabase(app.db);
      const userId = request.auth!.userId;
      const current = await db.users.findOne({ _id: userId }, { projection: { passwordHash: 1 } });
      if (!current?.passwordHash || !(await verifyPassword(request.body.password, current.passwordHash))) {
        throw new AppError("INVALID_CREDENTIALS", "That password is not right.", [{ path: "body/password", message: "Not right" }]);
      }
      const now = new Date();
      const photoKey = await db.transaction(async (session) => {
        const user = await db.users.findOne({ _id: userId, status: { $ne: "deleted" } }, { session });
        if (!user) throw new AppError("UNAUTHENTICATED");
        await db.users.updateOne(
          { _id: userId },
          {
            $set: {
              status: "deleted",
              phone: `deleted:${userId.toHexString()}`,
              deletion: { at: now, phone: user.phone, username: user.username ?? null, email: user.email ?? null },
              purgeAt: new Date(now.getTime() + PURGE_AFTER_DAYS * 24 * 60 * 60_000),
              updatedAt: now,
            },
            $unset: { username: "", email: "", emailVerified: "", avatar: "", avatarKey: "" },
          },
          { session },
        );
        await db.sessions.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: now, updatedAt: now } }, { session });
        await db.posts.updateMany({ authorId: userId, status: "live" }, { $set: { status: "deleted", updatedAt: now } }, { session });
        await writeAudit(
          db,
          { actor: { id: userId, kind: "user" }, scope: { module: "account" }, action: "user.delete", target: { type: "user", id: userId }, diff: {}, ip: request.ip },
          session,
        );
        return user.avatarKey ?? null;
      });
      app.authCache.forget(userId);
      if (photoKey) await app.photos.remove(photoKey);
      await eraseChats(app, db, userId).catch((err: unknown) => request.log.error({ err: (err as Error).message }, "Chats not erased"));
      clearTokens(request, reply);
      return ok(request, { done: true as const });
    },
  );

  app.get(
    "/usernames",
    {
      config: secured(1, 60),
      schema: {
        tags: ["account"],
        summary: "Check a username and suggest free ones",
        description: "Works before signup, with `name`. Signed in, your own name is used and your own username counts as free.",
        querystring: UsernameQuery,
        response: { 200: UsernameResult, ...Errors },
        security: [{}, { bearer: [] }, { cookie: [] }],
      },
    },
    async (request) => {
      const db = requireDatabase(app.db);
      const claims = await readAccessClaims(request);
      const user = claims ? await db.users.findOne({ _id: claims.userId }, { projection: { name: 1 } }) : null;
      const name = user?.name ?? request.query.name ?? "";
      const typed = request.query.check?.trim().toLowerCase();
      const [available, suggestions] = await Promise.all([
        typed ? isAvailable(db, typed, user?._id) : null,
        suggestUsernames(db, name, { typed }),
      ]);
      return ok(request, { available, suggestions });
    },
  );

  app.get(
    "/city",
    {
      preHandler: requireAuth,
      config: secured(1, 10),
      schema: {
        tags: ["account"],
        summary: "The city at a point, for the 'use my location' button",
        description: "The point is rounded to about 1 km and not stored.",
        querystring: CityQuery,
        response: { 200: CityResult, ...Errors },
        security: [{ bearer: [] }, { cookie: [] }],
      },
    },
    async (request) => {
      const city = await app.geocoder.cityAt(request.query.lat, request.query.lng);
      return ok(request, { city, attribution: "© OpenStreetMap contributors" });
    },
  );

  app.get(
    "/sessions",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["account"],
        summary: "Devices signed in to this account",
        response: { 200: SessionList, ...Errors },
        security: [{ bearer: [] }, { cookie: [] }],
      },
    },
    async (request) => {
      const auth = request.auth!;
      const docs = await requireDatabase(app.db)
        .sessions.find({ userId: auth.userId, revokedAt: null, expiresAt: { $gt: new Date() } })
        .sort({ lastSeenAt: -1 })
        .limit(50)
        .toArray();
      return page(
        request,
        docs.map((s) => ({
          id: s._id.toHexString(),
          client: s.client,
          label: s.label ?? "Unknown device",
          current: s._id.equals(auth.sessionId),
          lastSeenAt: (s.lastSeenAt ?? s.createdAt).toISOString(),
          createdAt: s.createdAt.toISOString(),
        })),
        null,
      );
    },
  );

  app.delete(
    "/sessions/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["account"],
        summary: "Sign out one device",
        params: SessionParams,
        response: { 200: Done, ...Errors },
        security: [{ bearer: [] }, { cookie: [] }],
      },
    },
    async (request, reply) => {
      const auth = request.auth!;
      const id = new ObjectId(request.params.id);
      const now = new Date();
      const res = await requireDatabase(app.db).sessions.updateOne(
        { _id: id, userId: auth.userId, revokedAt: null },
        { $set: { revokedAt: now, updatedAt: now } },
      );
      if (!res.matchedCount) throw new AppError("NOT_FOUND", "That device is already signed out.");
      app.authCache.forget(auth.userId);
      if (id.equals(auth.sessionId)) clearTokens(request, reply);
      return ok(request, { done: true as const });
    },
  );

  app.post(
    "/devices",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["account"],
        summary: "Register this app install for push notifications",
        body: DeviceBody,
        response: { 200: Done, ...Errors },
        security: [{ bearer: [] }],
      },
    },
    async (request) => {
      const db = requireDatabase(app.db);
      const auth = request.auth!;
      const now = new Date();
      const { pushToken } = request.body;
      await db.sessions.updateMany(
        { pushToken, _id: { $ne: auth.sessionId } },
        { $set: { pushToken: null, updatedAt: now } },
      );
      await db.sessions.updateOne({ _id: auth.sessionId }, { $set: { pushToken, updatedAt: now } });
      return ok(request, { done: true as const });
    },
  );
};

export default account;
