import type { FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { ObjectId } from "mongodb";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { UserDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { HOLD_MESSAGE } from "./contracts.js";

const ISSUER = "ruxstar-api";
/** Not the sessions' audience, so a pass never works anywhere a session does. */
const AUDIENCE = "ruxstar-support";
export const PASS_SECONDS = 2 * 60 * 60;
/** A pass has no session behind it. */
const NO_SESSION = new ObjectId("000000000000000000000000");

/**
 * Sign-in for an account Ruxstar put on hold. The password or code was right, so instead of a session the person gets a
 * short-lived pass that only opens their own help tickets. The hold's reason stays with the team.
 */
export async function onHold(secret: Uint8Array, user: Pick<UserDoc, "_id">): Promise<AppError> {
  const exp = Math.floor(Date.now() / 1000) + PASS_SECONDS;
  const supportToken = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user._id.toHexString())
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(secret);
  return new AppError("ACCOUNT_ON_HOLD", undefined, [{ message: HOLD_MESSAGE, supportToken, expiresAt: new Date(exp * 1000).toISOString() }]);
}

async function readPass(request: FastifyRequest): Promise<ObjectId | null> {
  const header = request.headers.authorization;
  const secret = request.server.config.jwtSecret;
  if (!header?.startsWith("Bearer ") || !secret) return null;
  try {
    const { payload } = await jwtVerify(header.slice(7).trim(), secret, { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
    return typeof payload.sub === "string" && ObjectId.isValid(payload.sub) ? new ObjectId(payload.sub) : null;
  } catch {
    return null;
  }
}

/** A signed-in person, or someone on hold with a support pass. Only the customer's own ticket routes take a pass. */
export async function requireRequester(request: FastifyRequest): Promise<void> {
  const userId = await readPass(request);
  if (!userId) return requireAuth(request);
  const user = await requireDatabase(request.server.db).users.findOne({ _id: userId }, { projection: { status: 1 } });
  if (user?.status === "active") throw new AppError("UNAUTHENTICATED", "Your account is active again. Sign in to continue.");
  if (user?.status !== "locked") throw new AppError("UNAUTHENTICATED");
  request.auth = { userId, sessionId: NO_SESSION, roles: {}, kyc: {} };
}
