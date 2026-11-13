import type { FastifyBaseLogger } from "fastify";
import type { ObjectId } from "mongodb";
import type { PushMessage, PushSender } from "../../adapters/push.js";
import type { Database } from "../../platform/db.js";

/**
 * The notify helpers are called from many modules with just the database and a logger, so the sender is set
 * once, when the app is built.
 */
let target: { db: Database; sender: PushSender; log: FastifyBaseLogger } | null = null;

export function usePush(db: Database, sender: PushSender, log: FastifyBaseLogger): void {
  target = { db, sender, log };
}

export type Push = Omit<PushMessage, "to">;

/**
 * Sends a phone notification to every app install these people are signed in on. It runs after the request
 * has answered and never throws: a missed notification must not undo what caused it. Tokens of removed apps
 * are forgotten.
 */
export function pushTo(userIds: ObjectId[], push: Push): Promise<void> {
  if (!target || userIds.length === 0) return Promise.resolve();
  const { db, sender, log } = target;
  return (async () => {
    try {
      const now = new Date();
      const sessions = await db.sessions
        .find(
          { userId: { $in: userIds }, client: "app", revokedAt: null, expiresAt: { $gt: now }, pushToken: { $type: "string" } },
          { projection: { pushToken: 1 } },
        )
        .toArray();
      const tokens = [...new Set(sessions.map((s) => s.pushToken!))];
      if (tokens.length === 0) return;
      const gone = await sender.send(tokens.map((to) => ({ to, ...push })));
      if (gone.length) await db.sessions.updateMany({ pushToken: { $in: gone } }, { $set: { pushToken: null, updatedAt: now } });
    } catch (err) {
      log.warn({ err: (err as Error).message }, "Push notification failed");
    }
  })();
}
