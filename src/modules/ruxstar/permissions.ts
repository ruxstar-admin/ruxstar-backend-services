import type { FastifyRequest } from "fastify";
import { requireDatabase } from "../../platform/context.js";
import type { UserDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";

/**
 * Everything a Ruxstar staff member can be granted. Admins have all of them; managing staff is
 * for admins only and is not on this list.
 */
export const PERMISSIONS = [
  { key: "kyc.view", label: "See verification cases" },
  { key: "kyc.review", label: "Approve and reject verification" },
  { key: "reports.view", label: "See reported posts" },
  { key: "reports.act", label: "Keep or remove reported posts" },
  { key: "users.view", label: "Find people and see their accounts" },
  { key: "users.manage", label: "Suspend, unlock and sign people out" },
  { key: "modules.view", label: "See module settings" },
  { key: "modules.manage", label: "Change module settings" },
  { key: "businesses.view", label: "See vendors' businesses" },
  { key: "businesses.manage", label: "Suspend and restore businesses" },
  { key: "audit.view", label: "Read the audit log" },
] as const;

export type Permission = (typeof PERMISSIONS)[number]["key"];
const KNOWN = new Set<string>(PERMISSIONS.map((p) => p.key));
export const isPermission = (key: string): key is Permission => KNOWN.has(key);

export interface Access {
  admin: boolean;
  title: string | null;
  permissions: Permission[];
}

/** What the signed-in person may do in the console, or null when they are not on the Ruxstar team. */
export async function accessOf(request: FastifyRequest): Promise<Access | null> {
  const auth = request.auth!;
  if (auth.roles.admin) return { admin: true, title: "Admin", permissions: PERMISSIONS.map((p) => p.key) };
  if (!auth.roles.ruxstarStaff) return null;
  const grant = await requireDatabase(request.server.db).ruxstarStaff.findOne(
    { userId: auth.userId, status: "active" },
    { projection: { title: 1, permissions: 1 } },
  );
  if (!grant) return null;
  return { admin: false, title: grant.title, permissions: grant.permissions.filter(isPermission) };
}

/**
 * Staff act on ordinary accounts only. Nobody acts on themselves, and admins are changed only by
 * the create-admin script.
 */
export function assertCanManage(request: FastifyRequest, target: Pick<UserDoc, "_id" | "roles">): void {
  const auth = request.auth!;
  if (target._id.equals(auth.userId)) throw new AppError("FORBIDDEN", "You can't do this to your own account.");
  if (target.roles?.admin) throw new AppError("FORBIDDEN", "Admins can't be changed here.");
  if (target.roles?.ruxstarStaff && !auth.roles.admin) throw new AppError("FORBIDDEN", "Only an admin can change a Ruxstar staff account.");
}
