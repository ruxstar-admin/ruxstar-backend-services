import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { ClientSession } from "mongodb";
import { SignJWT, jwtVerify } from "jose";
import type { SmsSender } from "../../adapters/sms.js";
import type { Database, OtpPurpose } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";

export const OTP_TTL_SECONDS = 5 * 60;
export const RESEND_COOLDOWN_SECONDS = 30;
export const VERIFICATION_TTL_SECONDS = 10 * 60;
const MAX_ATTEMPTS = 5;
const MAX_RESENDS = 3;
const LOCK_SECONDS = 30 * 60;
const VERIFY_AUDIENCE = "ruxstar-verify";

const seconds = (from: Date, to: Date) => Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 1000));
const later = (from: Date, s: number) => new Date(from.getTime() + s * 1000);

const limited = (now: Date, until: Date) => {
  const wait = seconds(now, until);
  return new AppError("OTP_LIMIT", undefined, [{ message: `Try again in ${wait} seconds.`, retryAfterSeconds: wait }]);
};

/** Keyed by the JWT secret and bound to the number and purpose, so a stolen row cannot be replayed elsewhere. */
function hashCode(secret: Uint8Array, target: string, purpose: OtpPurpose, code: string) {
  return createHmac("sha256", secret).update(`otp:${target}:${purpose}:${code}`).digest("base64url");
}

export async function sendCode(
  deps: { db: Database; sms: SmsSender; secret: Uint8Array },
  target: string,
  purpose: OtpPurpose,
  now = new Date(),
) {
  const existing = await deps.db.otps.findOne({ target, purpose });
  if (existing?.lockedUntil && existing.lockedUntil > now) throw limited(now, existing.lockedUntil);

  const live = existing && existing.expiresAt > now && !existing.verifiedJti;
  if (live) {
    const nextAllowed = later(existing.lastSentAt, RESEND_COOLDOWN_SECONDS);
    if (nextAllowed > now) throw limited(now, nextAllowed);
    if (existing.resends >= MAX_RESENDS) {
      const until = later(now, LOCK_SECONDS);
      await deps.db.otps.updateOne({ _id: existing._id }, { $set: { lockedUntil: until, expiresAt: until } });
      throw limited(now, until);
    }
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const codeHash = hashCode(deps.secret, target, purpose, code);
  const expiresAt = later(now, OTP_TTL_SECONDS);
  if (live) {
    await deps.db.otps.updateOne(
      { _id: existing._id },
      { $set: { codeHash, lastSentAt: now, expiresAt }, $inc: { resends: 1 } },
    );
  } else {
    await deps.db.otps.findOneAndReplace(
      { target, purpose },
      { target, purpose, codeHash, attempts: 0, resends: 0, lastSentAt: now, lockedUntil: null, verifiedJti: null, createdAt: now, expiresAt },
      { upsert: true },
    );
  }

  await deps.sms.sendOtp(target, code);
  return { expiresInSeconds: OTP_TTL_SECONDS, resendInSeconds: RESEND_COOLDOWN_SECONDS };
}

/** Counts the attempt before comparing, so parallel guesses cannot get past the limit. */
export async function checkCode(
  deps: { db: Database; secret: Uint8Array },
  target: string,
  purpose: OtpPurpose,
  code: string,
  now = new Date(),
): Promise<{ verificationToken: string; expiresInSeconds: number }> {
  const doc = await deps.db.otps.findOneAndUpdate(
    { target, purpose, verifiedJti: null, expiresAt: { $gt: now }, attempts: { $lt: MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { returnDocument: "after" },
  );
  if (!doc) {
    const current = await deps.db.otps.findOne({ target, purpose });
    if (current?.lockedUntil && current.lockedUntil > now) throw limited(now, current.lockedUntil);
    if (current && current.expiresAt > now && !current.verifiedJti) throw limited(now, current.expiresAt);
    throw new AppError("OTP_EXPIRED");
  }
  if (doc.lockedUntil && doc.lockedUntil > now) throw limited(now, doc.lockedUntil);

  const expected = Buffer.from(doc.codeHash);
  const given = Buffer.from(hashCode(deps.secret, target, purpose, code));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    const left = MAX_ATTEMPTS - doc.attempts;
    if (left <= 0) {
      const until = later(now, LOCK_SECONDS);
      await deps.db.otps.updateOne({ _id: doc._id }, { $set: { lockedUntil: until, expiresAt: until } });
      throw limited(now, until);
    }
    throw new AppError("OTP_INVALID", undefined, [
      { path: "body/code", message: `${left} ${left === 1 ? "try" : "tries"} left.`, attemptsLeft: left },
    ]);
  }

  const jti = randomUUID();
  await deps.db.otps.updateOne(
    { _id: doc._id },
    { $set: { verifiedJti: jti, expiresAt: later(now, VERIFICATION_TTL_SECONDS) } },
  );
  const verificationToken = await new SignJWT({ pur: purpose })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(target)
    .setJti(jti)
    .setAudience(VERIFY_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${VERIFICATION_TTL_SECONDS}s`)
    .sign(deps.secret);
  return { verificationToken, expiresInSeconds: VERIFICATION_TTL_SECONDS };
}

/** Returns the verified number. The token works once; call inside the transaction that uses it. */
export async function useVerification(
  deps: { db: Database; secret: Uint8Array },
  token: string,
  purpose: OtpPurpose,
  session?: ClientSession,
): Promise<string> {
  let target: string;
  let jti: string;
  try {
    const { payload } = await jwtVerify(token, deps.secret, { audience: VERIFY_AUDIENCE, algorithms: ["HS256"] });
    if (payload.pur !== purpose || typeof payload.sub !== "string" || typeof payload.jti !== "string") throw new Error("claims");
    target = payload.sub;
    jti = payload.jti;
  } catch {
    throw new AppError("VERIFICATION_INVALID");
  }
  const used = await deps.db.otps.findOneAndDelete({ target, purpose, verifiedJti: jti }, { session });
  if (!used) throw new AppError("VERIFICATION_INVALID");
  return target;
}
