import { randomInt } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { MongoServerError, ObjectId, type ClientSession } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { writeAudit } from "../../platform/audit.js";
import { readAccessClaims, requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import { stamp, type Database, type UserDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import {
  ChangePasswordBody,
  DeviceBody,
  Done,
  LoginBody,
  LoginResult,
  MePatch,
  MeResult,
  OtpRequest,
  OtpSent,
  OtpVerify,
  RefreshBody,
  RefreshResult,
  ResetBody,
  SessionList,
  SessionParams,
  SignupBody,
  SignupResult,
  Verified,
  type User,
} from "./contracts.js";
import { checkCode, sendCode, useVerification } from "./otp.js";
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

const e164 = (phone: string) => `+91${phone}`;
const maskPhone = (phone: string) => `+91 ••••• •${phone.slice(-4)}`;
const minutes = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;
const isDuplicate = (err: unknown, field: string) =>
  err instanceof MongoServerError && err.code === 11000 && Object.hasOwn(err.keyPattern ?? {}, field);

const view = (user: UserDoc): User => ({
  id: user._id.toHexString(),
  phone: user.phone,
  name: user.name ?? "",
  username: user.username ?? "",
  dob: user.dob ?? null,
  gender: user.gender ?? null,
  city: user.home?.city ?? null,
  roles: {
    vendor: Boolean(user.roles.vendor),
    delivery: Boolean(user.roles.delivery),
    ruxstarStaff: Boolean(user.roles.ruxstarStaff),
    admin: Boolean(user.roles.admin),
  },
  kyc: { base: user.kyc.base ?? "none" },
  createdAt: user.createdAt.toISOString(),
});

/** A readable handle from the name plus four digits. People can change it later. */
async function pickUsername(db: Database, name: string, session: ClientSession): Promise<string> {
  const stem =
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 14) || "user";
  for (let i = 0; i < 6; i++) {
    const candidate = `${stem}${randomInt(1000, 10000)}`;
    if (!(await db.users.findOne({ username: candidate }, { session, projection: { _id: 1 } }))) return candidate;
  }
  return `${stem}${randomInt(100000, 1000000)}`;
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

  app.post(
    "/otp",
    {
      config: secured(10, 30),
      schema: {
        tags: ["account"],
        summary: "Text a 6-digit code to a number, to sign up or reset a password",
        body: OtpRequest,
        response: { 200: OtpSent, ...Errors },
      },
    },
    async (request) => {
      const d = deps();
      const phone = e164(request.body.phone);
      const user = await d.db.users.findOne({ phone, status: { $ne: "deleted" } }, { projection: { _id: 1 } });
      if (request.body.purpose === "signup" && user) throw new AppError("PHONE_TAKEN");
      if (request.body.purpose === "reset" && !user) {
        throw new AppError("NOT_FOUND", "No account uses this number. Create one instead.");
      }
      const sent = await sendCode(d, phone, request.body.purpose);
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
      const hash = await hashPassword(body.password);
      const result = await d.db
        .transaction(async (session) => {
          const phone = await useVerification(d, body.verificationToken, "signup", session);
          checkPasswordRules(body.password, phone);
          if (await d.db.users.findOne({ phone }, { session, projection: { _id: 1 } })) throw new AppError("PHONE_TAKEN");

          const now = new Date();
          const user: UserDoc = {
            _id: new ObjectId(),
            phone,
            passwordHash: hash,
            passwordHistory: [],
            name,
            username: await pickUsername(d.db, name, session),
            dob: null,
            gender: null,
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
          if (isDuplicate(err, "username")) throw new AppError("CONFLICT", "Something clashed. Try again.");
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
      const lockedUntil = user.lock?.lockedUntil;
      if (lockedUntil && lockedUntil > now) {
        const wait = Math.ceil((lockedUntil.getTime() - now.getTime()) / 60_000);
        throw new AppError("ACCOUNT_LOCKED", undefined, [
          { message: `Try again in ${minutes(wait)}.`, retryAfterSeconds: Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000) },
        ]);
      }

      if (!(await verifyPassword(request.body.password, user.passwordHash))) {
        const after = await d.db.users.findOneAndUpdate(
          { _id: user._id },
          { $inc: { "lock.failedCount": 1 }, $set: { updatedAt: now } },
          { returnDocument: "after", projection: { lock: 1 } },
        );
        if ((after?.lock?.failedCount ?? 0) >= LOCK_AFTER_FAILURES) {
          const until = new Date(now.getTime() + LOCK_MINUTES * 60_000);
          await d.db.users.updateOne({ _id: user._id }, { $set: { lock: { failedCount: 0, lockedUntil: until } } });
          throw new AppError("ACCOUNT_LOCKED", undefined, [
            { message: `Try again in ${minutes(LOCK_MINUTES)}.`, retryAfterSeconds: LOCK_MINUTES * 60 },
          ]);
        }
        throw new AppError("INVALID_CREDENTIALS");
      }
      if (user.status === "locked") throw new AppError("FORBIDDEN", "This account is on hold. Contact support.");

      if (user.lock?.failedCount || user.lock?.lockedUntil) {
        await d.db.users.updateOne({ _id: user._id }, { $set: { lock: { failedCount: 0, lockedUntil: null }, updatedAt: now } });
      }
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
      } else {
        const token = readRefreshToken(request, request.body?.refreshToken);
        if (token) await revokeByRefreshToken(db, token);
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
      await d.db.transaction(async (session) => {
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
      });
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
      const user = await requireDatabase(app.db).users.findOne({ _id: request.auth!.userId });
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
        summary: "Update name, username, date of birth, gender or city",
        body: MePatch,
        response: { 200: MeResult, ...Errors },
        security: [{ bearer: [] }, { cookie: [] }],
      },
    },
    async (request) => {
      const db = requireDatabase(app.db);
      const { name, username, dob, gender, city } = request.body;
      checkDob(dob);
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (name !== undefined) set.name = name.trim().replace(/\s+/g, " ");
      if (username !== undefined) set.username = username;
      if (dob !== undefined) set.dob = dob;
      if (gender !== undefined) set.gender = gender;
      if (city !== undefined) set["home.city"] = city?.trim() ?? null;
      const user = await db.users
        .findOneAndUpdate({ _id: request.auth!.userId }, { $set: set }, { returnDocument: "after" })
        .catch((err: unknown) => {
          if (isDuplicate(err, "username")) throw new AppError("USERNAME_TAKEN", undefined, [{ path: "body/username", message: "Taken" }]);
          throw err;
        });
      if (!user) throw new AppError("UNAUTHENTICATED");
      return ok(request, view(user));
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
