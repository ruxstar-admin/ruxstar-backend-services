import type { FastifyRequest } from "fastify";
import { requireAuth } from "../../platform/auth.js";
import type { UserDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";

export type AuthorFields = Pick<UserDoc, "_id" | "name" | "username" | "avatar" | "roles" | "kyc">;
export const AUTHOR_PROJECTION = { name: 1, username: 1, avatar: 1, "roles.vendor": 1, "kyc.base": 1 } as const;

export const authorView = (user: AuthorFields) => ({
  id: user._id.toHexString(),
  name: user.name ?? "",
  username: user.username ?? "",
  avatarUrl: user.avatar ?? null,
  vendor: Boolean(user.roles?.vendor),
  verified: user.kyc?.base === "approved",
});

/** Public reads show likes, saves and follows for whoever is signed in, and work for anyone who is not. */
export async function signedInIfPossible(request: FastifyRequest): Promise<void> {
  try {
    await requireAuth(request);
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== "UNAUTHENTICATED") throw err;
    request.auth = null;
  }
}
