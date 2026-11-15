import type { UserDoc } from "../../platform/db.js";

export { signedInIfPossible } from "../../platform/auth.js";

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