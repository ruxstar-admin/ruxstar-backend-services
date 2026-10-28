import type { FastifyRequest } from "fastify";
import type { ClientSession, ObjectId } from "mongodb";
import type { AuditLogDoc, Database } from "./db.js";
import { stamp } from "./db.js";

export type Diff = AuditLogDoc["diff"];

/** Only the keys whose values changed. */
export function diffOf<T extends object>(before: T, after: Partial<T>): Diff {
  const diff: Diff = {};
  for (const key of Object.keys(after) as (keyof T & string)[]) {
    const from = before[key];
    const to = after[key];
    if (to !== undefined && JSON.stringify(from) !== JSON.stringify(to)) diff[key] = { from, to };
  }
  return diff;
}

export function actorOf(request: FastifyRequest): AuditLogDoc["actor"] {
  const auth = request.auth;
  if (!auth) return { id: null, kind: "system" };
  return { id: auth.userId, kind: auth.roles.admin ? "admin" : auth.roles.ruxstarStaff ? "staff" : "user" };
}

/**
 * Every money, permission, KYC and admin action calls this, inside the same transaction as the
 * change when there is one, so the change and its record commit together.
 */
export async function writeAudit(
  db: Database,
  entry: {
    actor: AuditLogDoc["actor"];
    scope: { module: string; businessId?: ObjectId };
    action: string;
    target: { type: string; id: ObjectId | string };
    diff?: Diff;
    ip?: string | null;
  },
  session?: ClientSession,
): Promise<void> {
  const now = new Date();
  await db.auditLogs.insertOne(
    { ...entry, diff: entry.diff ?? {}, ip: entry.ip ?? null, at: now, ...stamp(now) },
    { session },
  );
}
