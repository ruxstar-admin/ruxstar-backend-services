import type { FastifyBaseLogger } from "fastify";
import { ObjectId } from "mongodb";
import type { Database, KycTrack, NotificationDoc } from "../../platform/db.js";

interface PostEvent {
  type: NotificationDoc["type"];
  to: ObjectId;
  /** Without a name, it is read here, off the request's path. */
  actor: { id: ObjectId; name?: string };
  postId: ObjectId;
  /** The comment, for comment notifications. */
  excerpt?: string;
}

const clip = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * Tells a post's author about a like or a comment. Never about their own actions, and one like
 * notification per person per post however often they unlike and like again. Failures are logged,
 * never shown: a missed notification must not undo the like.
 */
export async function notifyPostEvent(db: Database, log: FastifyBaseLogger, event: PostEvent): Promise<void> {
  if (event.to.equals(event.actor.id)) return;
  const now = new Date();
  const link = { screen: "post" as const, id: event.postId.toHexString() };
  try {
    const name =
      event.actor.name ?? (await db.users.findOne({ _id: event.actor.id }, { projection: { name: 1 } }))?.name ?? "Someone";
    if (event.type === "post.like") {
      await db.notifications.updateOne(
        { userId: event.to, type: "post.like", "link.id": link.id, actorId: event.actor.id },
        {
          $setOnInsert: {
            _id: new ObjectId(),
            title: "New like",
            body: `${name} liked your post.`,
            "link.screen": "post",
            readAt: null,
            createdAt: now,
          },
        },
        { upsert: true },
      );
      return;
    }
    await db.notifications.insertOne({
      _id: new ObjectId(),
      userId: event.to,
      type: event.type,
      actorId: event.actor.id,
      title: "New comment",
      body: `${name}: ${clip(event.excerpt ?? "")}`,
      link,
      readAt: null,
      createdAt: now,
    });
  } catch (err) {
    log.warn({ err: (err as Error).message, type: event.type }, "Notification not saved");
  }
}

/** Tells an author the Ruxstar team took their post down, and why. Logged, never thrown. */
export async function notifyPostRemoved(
  db: Database,
  log: FastifyBaseLogger,
  event: { to: ObjectId; moderator: ObjectId; postId: ObjectId; reason: string },
): Promise<void> {
  try {
    await db.notifications.insertOne({
      _id: new ObjectId(),
      userId: event.to,
      type: "post.removed",
      actorId: event.moderator,
      title: "Your post was removed",
      body: clip(event.reason, 140),
      link: { screen: "post", id: event.postId.toHexString() },
      readAt: null,
      createdAt: new Date(),
    });
  } catch (err) {
    log.warn({ err: (err as Error).message, type: "post.removed" }, "Notification not saved");
  }
}

const KYC_COPY = {
  base: { approved: ["You are verified", "Your Ruxstar Card is ready."] },
  vendor: { approved: ["You are a verified vendor", "You can post as a business and open your vendor portal."] },
} as const;

/** Tells a user their verification was decided. Logged, never thrown: the decision is already saved. */
export async function notifyKycDecision(
  db: Database,
  log: FastifyBaseLogger,
  event: { to: ObjectId; reviewer: ObjectId; track: KycTrack; decision: "approved" | "rejected" | "locked"; reason: string | null },
): Promise<void> {
  const [title, body] =
    event.decision === "approved"
      ? KYC_COPY[event.track].approved
      : event.decision === "locked"
        ? ["Verification is on hold", "Contact support to continue."]
        : ["Verification needs a change", clip(event.reason ?? "Open verification to see what to fix.", 140)];
  try {
    await db.notifications.insertOne({
      _id: new ObjectId(),
      userId: event.to,
      type: event.decision === "approved" ? "kyc.approved" : "kyc.rejected",
      actorId: event.reviewer,
      title,
      body,
      link: { screen: "verification", id: event.track },
      readAt: null,
      createdAt: new Date(),
    });
  } catch (err) {
    log.warn({ err: (err as Error).message, type: "kyc" }, "Notification not saved");
  }
}
