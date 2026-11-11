import type { FastifyInstance, FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { ObjectId } from "mongodb";
import type { AuthContext, ClientKind } from "./context.js";
import { requireDatabase } from "./context.js";
import { AppError } from "./errors.js";

export const ACCESS_COOKIE = "rx_at";
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

const ISSUER = "ruxstar-api";
const AUDIENCE = "ruxstar";

export async function signAccessToken(
  secret: Uint8Array,
  claims: { userId: ObjectId; sessionId: ObjectId; client: ClientKind },
): Promise<string> {
  return new SignJWT({ sid: claims.sessionId.toHexString(), cli: claims.client })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId.toHexString())
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secret);
}

function readToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim() || null;
  return request.cookies?.[ACCESS_COOKIE] ?? null;
}

/** Checks the signature and expiry only. `requireAuth` also checks the user and session. */
export async function readAccessClaims(request: FastifyRequest): Promise<{ userId: ObjectId; sessionId: ObjectId } | null> {
  const secret = request.server.config.jwtSecret;
  const token = readToken(request);
  if (!secret || !token) return null;
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
    const { sub, sid } = payload;
    if (typeof sub !== "string" || typeof sid !== "string" || !ObjectId.isValid(sub) || !ObjectId.isValid(sid)) return null;
    return { userId: new ObjectId(sub), sessionId: new ObjectId(sid) };
  } catch {
    return null;
  }
}

/** Sessions checked recently on this instance, so most signed-in requests skip a database trip. */
export class SessionCache {
  private static readonly MAX = 10_000;
  private readonly entries = new Map<string, { auth: AuthContext; until: number }>();

  constructor(private readonly ttlMs: number) {}

  get(sessionId: ObjectId, userId: ObjectId): AuthContext | null {
    const key = sessionId.toHexString();
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (hit.until <= Date.now() || !hit.auth.userId.equals(userId)) {
      this.entries.delete(key);
      return null;
    }
    return { ...hit.auth };
  }

  set(auth: AuthContext, sessionExpiresAt: Date) {
    if (this.ttlMs === 0) return;
    if (this.entries.size >= SessionCache.MAX) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(auth.sessionId.toHexString(), { auth, until: Math.min(Date.now() + this.ttlMs, sessionExpiresAt.getTime()) });
  }

  /** Call after ending sessions or changing someone's status or roles, so this instance stops trusting them at once. */
  forget(userId: ObjectId) {
    for (const [key, { auth }] of this.entries) if (auth.userId.equals(userId)) this.entries.delete(key);
  }
}

export function registerAuth(app: FastifyInstance) {
  app.decorateRequest("auth", null);
  app.decorate("authCache", new SessionCache(app.config.authCacheSeconds * 1000));
}

/**
 * Verifies the access token, then reads roles from the user and checks the session is live.
 * The answer is reused for `authCacheSeconds`, so a logout or role change on another instance
 * applies within that time; on this instance it applies at once through `authCache.forget`.
 */
export async function requireAuth(request: FastifyRequest): Promise<void> {
  if (!readToken(request)) throw new AppError("UNAUTHENTICATED");
  const claims = await readAccessClaims(request);
  if (!claims) throw new AppError("UNAUTHENTICATED", "Your session has ended. Sign in again.");

  const { userId, sessionId } = claims;
  const cache = request.server.authCache;
  const cached = cache.get(sessionId, userId);
  if (cached) {
    request.auth = cached;
    return;
  }

  const db = requireDatabase(request.server.db);
  const [user, session] = await Promise.all([
    db.users.findOne({ _id: userId }, { projection: { status: 1, roles: 1, kyc: 1 } }),
    db.sessions.findOne(
      { _id: sessionId, userId, revokedAt: null, expiresAt: { $gt: new Date() } },
      { projection: { expiresAt: 1 } },
    ),
  ]);
  if (!user || !session || user.status !== "active") throw new AppError("UNAUTHENTICATED");

  request.auth = { userId, sessionId, roles: user.roles ?? {}, kyc: user.kyc ?? {} };
  cache.set({ ...request.auth }, session.expiresAt);
}

export async function requireAdmin(request: FastifyRequest): Promise<void> {
  await requireAuth(request);
  if (!request.auth!.roles.admin) throw new AppError("FORBIDDEN");
}

/** Admins pass. Ruxstar staff pass when their active grant includes `permission`. */
export function requireRuxstar(permission: string) {
  return async function ruxstarGuard(request: FastifyRequest): Promise<void> {
    await requireAuth(request);
    const auth = request.auth!;
    if (auth.roles.admin) return;
    if (auth.roles.ruxstarStaff) {
      const grant = await requireDatabase(request.server.db).ruxstarStaff.findOne(
        { userId: auth.userId, status: "active", permissions: permission },
        { projection: { _id: 1 } },
      );
      if (grant) return;
    }
    throw new AppError("FORBIDDEN");
  };
}

export async function requireDeliveryKyc(request: FastifyRequest): Promise<void> {
  await requireAuth(request);
  const auth = request.auth!;
  if (!auth.roles.delivery || auth.kyc.delivery !== "approved") throw new AppError("KYC_REQUIRED");
}
