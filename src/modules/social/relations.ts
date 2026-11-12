import type { ObjectId } from "mongodb";
import type { Database } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";

/** Everyone `me` blocked or is blocked by. Both sides stop seeing each other. */
export async function blockedAround(db: Database, me: ObjectId | null): Promise<ObjectId[]> {
  if (!me) return [];
  const rows = await db.blocks
    .find({ $or: [{ blockerId: me }, { blockedId: me }] }, { projection: { blockerId: 1, blockedId: 1 } })
    .toArray();
  return rows.map((r) => (r.blockerId.equals(me) ? r.blockedId : r.blockerId));
}

/** `mine` when `me` blocked them, `theirs` when they blocked `me`. */
export async function blockBetween(db: Database, me: ObjectId | null, them: ObjectId): Promise<"mine" | "theirs" | null> {
  if (!me || me.equals(them)) return null;
  const row = await db.blocks.findOne(
    { $or: [{ blockerId: me, blockedId: them }, { blockerId: them, blockedId: me }] },
    { projection: { blockerId: 1 } },
  );
  if (!row) return null;
  return row.blockerId.equals(me) ? "mine" : "theirs";
}

export const blockedError = () => new AppError("FORBIDDEN", "You can't do that with this account.");

/** Liking, commenting and following are refused either way round. */
export async function assertNotBlocked(db: Database, me: ObjectId, them: ObjectId): Promise<void> {
  if (await blockBetween(db, me, them)) throw blockedError();
}
