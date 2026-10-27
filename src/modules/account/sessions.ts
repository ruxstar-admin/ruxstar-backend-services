import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ObjectId, type ClientSession } from "mongodb";
import { ACCESS_COOKIE, ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from "../../platform/auth.js";
import type { ClientKind } from "../../platform/context.js";
import { stamp, type Database, type SessionDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";

export const REFRESH_COOKIE = "rx_rt";
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Two browser tabs can refresh at once. The slower one gets a new access token instead of a sign-out. */
const WEB_RACE_GRACE_MS = 20_000;

export interface Tokens {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("base64url");
const newRefreshToken = () => randomBytes(32).toString("base64url");

export function deviceLabel(request: FastifyRequest, deviceName?: string): string {
  if (deviceName?.trim()) return deviceName.trim().slice(0, 60);
  const client = request.client?.kind ?? "web";
  if (client !== "web") return client === "delivery" ? "Ruxstar Delivery app" : "Ruxstar app";
  const ua = request.headers["user-agent"] ?? "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "A browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad/.test(ua)
        ? "iOS"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  return os ? `${browser} on ${os}` : browser;
}

export async function startSession(
  db: Database,
  request: FastifyRequest,
  userId: ObjectId,
  device: { deviceId?: string; deviceName?: string },
  session?: ClientSession,
): Promise<{ sessionId: ObjectId; refreshToken: string; expiresAt: Date }> {
  const now = new Date();
  const refreshToken = newRefreshToken();
  const expiresAt = new Date(now.getTime() + REFRESH_TTL_SECONDS * 1000);
  const doc: SessionDoc = {
    _id: new ObjectId(),
    userId,
    client: request.client?.kind ?? "web",
    deviceId: device.deviceId ?? null,
    label: deviceLabel(request, device.deviceName),
    refreshTokenHash: hashToken(refreshToken),
    prevRefreshTokenHash: null,
    rotatedAt: null,
    pushToken: null,
    appVersion: request.client?.version ?? null,
    lastSeenAt: now,
    expiresAt,
    revokedAt: null,
    ...stamp(now),
  };
  await db.sessions.insertOne(doc, { session });
  return { sessionId: doc._id, refreshToken, expiresAt };
}

export async function issueTokens(
  request: FastifyRequest,
  userId: ObjectId,
  started: { sessionId: ObjectId; refreshToken: string; expiresAt: Date },
): Promise<Tokens> {
  const client: ClientKind = request.client?.kind ?? "web";
  const accessToken = await signAccessToken(request.server.config.jwtSecret!, {
    userId,
    sessionId: started.sessionId,
    client,
  });
  return {
    accessToken,
    accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: started.refreshToken,
    refreshTokenExpiresAt: started.expiresAt.toISOString(),
  };
}

const cookieBase = (request: FastifyRequest) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: request.server.config.env !== "dev",
  domain: request.server.config.cookieDomain,
});

/** The website gets httpOnly cookies. Apps get the tokens in the body. */
export function deliverTokens(request: FastifyRequest, reply: FastifyReply, tokens: Tokens, { access = true, refresh = true } = {}) {
  if (request.client?.kind !== "web") return tokens;
  const base = cookieBase(request);
  if (access) reply.setCookie(ACCESS_COOKIE, tokens.accessToken, { ...base, path: "/", maxAge: tokens.accessTokenExpiresIn });
  if (refresh) reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, { ...base, path: "/v1/account", maxAge: REFRESH_TTL_SECONDS });
  return undefined;
}

export function clearTokens(request: FastifyRequest, reply: FastifyReply) {
  const base = cookieBase(request);
  reply.clearCookie(ACCESS_COOKIE, { ...base, path: "/" });
  reply.clearCookie(REFRESH_COOKIE, { ...base, path: "/v1/account" });
}

export function readRefreshToken(request: FastifyRequest, bodyToken?: string): string | null {
  if (bodyToken) return bodyToken;
  return request.client?.kind === "web" ? (request.cookies?.[REFRESH_COOKIE] ?? null) : null;
}

export async function revokeByRefreshToken(db: Database, token: string) {
  const now = new Date();
  await db.sessions.updateOne({ refreshTokenHash: hashToken(token), revokedAt: null }, { $set: { revokedAt: now, updatedAt: now } });
}

type Rotation =
  | { kind: "rotated"; userId: ObjectId; sessionId: ObjectId; refreshToken: string; expiresAt: Date }
  | { kind: "raced"; userId: ObjectId; sessionId: ObjectId };

/**
 * Swaps the refresh token for a new one. Presenting an old token again means it was copied,
 * so the session is ended for everyone holding it.
 */
export async function rotateRefreshToken(db: Database, request: FastifyRequest, token: string): Promise<Rotation> {
  const now = new Date();
  const hash = hashToken(token);
  const next = newRefreshToken();
  const session = await db.sessions.findOneAndUpdate(
    { refreshTokenHash: hash, revokedAt: null, expiresAt: { $gt: now } },
    {
      $set: {
        refreshTokenHash: hashToken(next),
        prevRefreshTokenHash: hash,
        rotatedAt: now,
        lastSeenAt: now,
        appVersion: request.client?.version ?? null,
        updatedAt: now,
      },
    },
    { returnDocument: "after" },
  );
  if (session) return { kind: "rotated", userId: session.userId, sessionId: session._id, refreshToken: next, expiresAt: session.expiresAt };

  const reused = await db.sessions.findOne({ prevRefreshTokenHash: hash, revokedAt: null });
  if (reused) {
    const raced =
      reused.client === "web" &&
      request.client?.kind === "web" &&
      reused.rotatedAt &&
      now.getTime() - reused.rotatedAt.getTime() < WEB_RACE_GRACE_MS &&
      reused.expiresAt > now;
    if (raced) return { kind: "raced", userId: reused.userId, sessionId: reused._id };
    await db.sessions.updateOne({ _id: reused._id }, { $set: { revokedAt: now, updatedAt: now } });
    request.log.warn({ sessionId: reused._id.toHexString() }, "Refresh token reused; session ended");
  }
  throw new AppError("UNAUTHENTICATED", "Your session has ended. Sign in again.");
}
