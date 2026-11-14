import type { FastifyBaseLogger } from "fastify";
import { ObjectId } from "mongodb";
import type { Database, NotificationDoc } from "../../platform/db.js";
import { pushTo } from "./push.js";

interface PostEvent {
  type: NotificationDoc["type"];
  to: ObjectId;
  /** Without a name, it is read here, off the request's path. */
  actor: { id: ObjectId; name?: string };
  postId: ObjectId;
  /** The comment, for comment notifications. */
  excerpt?: string;
}

export const clip = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** Saves a notification for the notifications screen and sends it to the person's phones too. */
export async function save(db: Database, doc: NotificationDoc): Promise<void> {
  await db.notifications.insertOne(doc);
  announce(doc);
}

/** The phone notification for one on the notifications screen; tapping it opens what `link` points at. */
function announce(doc: Pick<NotificationDoc, "_id" | "userId" | "title" | "body" | "link">): void {
  void pushTo([doc.userId], {
    title: doc.title,
    body: doc.body,
    data: { notificationId: doc._id.toHexString(), screen: doc.link.screen, id: doc.link.id },
  });
}

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
      const _id = new ObjectId();
      const title = "New like";
      const body = `${name} liked your post.`;
      const res = await db.notifications.updateOne(
        { userId: event.to, type: "post.like", "link.id": link.id, actorId: event.actor.id },
        { $setOnInsert: { _id, title, body, "link.screen": "post", readAt: null, createdAt: now } },
        { upsert: true },
      );
      if (res.upsertedCount) announce({ _id, userId: event.to, title, body, link });
      return;
    }
    await save(db, {
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

/** Tells someone they have a new follower. Once per follower, however often they unfollow and follow again. Logged, never thrown. */
export async function notifyFollow(db: Database, log: FastifyBaseLogger, event: { to: ObjectId; follower: ObjectId }): Promise<void> {
  try {
    const follower = await db.users.findOne({ _id: event.follower }, { projection: { name: 1 } });
    const _id = new ObjectId();
    const title = "New follower";
    const body = `${follower?.name || "Someone"} started following you.`;
    const link = { screen: "profile" as const, id: event.follower.toHexString() };
    const res = await db.notifications.updateOne(
      { userId: event.to, type: "user.followed", actorId: event.follower },
      { $setOnInsert: { _id, title, body, link, readAt: null, createdAt: new Date() } },
      { upsert: true },
    );
    if (res.upsertedCount) announce({ _id, userId: event.to, title, body, link });
  } catch (err) {
    log.warn({ err: (err as Error).message, type: "user.followed" }, "Notification not saved");
  }
}

/** Tells an author the Ruxstar team took their post down, and why. Logged, never thrown. */
export async function notifyPostRemoved(
  db: Database,
  log: FastifyBaseLogger,
  event: { to: ObjectId; moderator: ObjectId; postId: ObjectId; reason: string },
): Promise<void> {
  try {
    await save(db, {
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

/** Tells a vendor the Ruxstar team put one of their businesses on hold, or lifted it. Logged, never thrown. */
export async function notifyBusinessHold(
  db: Database,
  log: FastifyBaseLogger,
  event: { to: ObjectId; moderator: ObjectId; businessId: ObjectId; name: string; held: boolean; reason: string | null },
): Promise<void> {
  try {
    await save(db, {
      _id: new ObjectId(),
      userId: event.to,
      type: event.held ? "business.suspended" : "business.restored",
      actorId: event.moderator,
      title: event.held ? `${clip(event.name, 40)} is on hold` : `${clip(event.name, 40)} is back`,
      body: event.held ? clip(event.reason ?? "Contact support to continue.", 140) : "Customers can see it again.",
      link: { screen: "business", id: event.businessId.toHexString() },
      readAt: null,
      createdAt: new Date(),
    });
  } catch (err) {
    log.warn({ err: (err as Error).message, type: "business" }, "Notification not saved");
  }
}

/**
 * Tells a shop about a new or cancelled order (`shop_order` opens it in the vendor portal), or a customer how
 * theirs is moving (`order`). Logged, never thrown.
 */
export async function notifyOrder(
  db: Database,
  log: FastifyBaseLogger,
  event: {
    to: ObjectId;
    actor: ObjectId;
    orderId: ObjectId;
    type: "order.placed" | "order.updated";
    /** `team`: someone working at the shop, who opens it in the Work area. */
    forShop: boolean | "team";
    title: string;
    body: string;
  },
): Promise<void> {
  try {
    await save(db, {
      _id: new ObjectId(),
      userId: event.to,
      type: event.type,
      actorId: event.actor,
      title: clip(event.title, 60),
      body: clip(event.body, 140),
      link: { screen: event.forShop === "team" ? "work_order" : event.forShop ? "shop_order" : "order", id: event.orderId.toHexString() },
      readAt: null,
      createdAt: new Date(),
    });
  } catch (err) {
    log.warn({ err: (err as Error).message, type: "order" }, "Notification not saved");
  }
}

const TEAM_MOVES: Record<string, string> = {
  accepted: "accepted",
  printing: "started printing",
  ready: "marked it ready",
  out_for_delivery: "sent it out for delivery",
  delivered: "marked it delivered",
  rejected: "turned it down",
};

/** Tells a shop's owner that someone on the team moved an order, so the owner isn't surprised by it. Logged, never thrown. */
export async function notifyTeamMove(
  db: Database,
  log: FastifyBaseLogger,
  event: { owner: ObjectId; member: ObjectId; orderId: ObjectId; orderNo: number; status: string },
): Promise<void> {
  const did = TEAM_MOVES[event.status];
  if (!did || event.owner.equals(event.member)) return;
  try {
    const member = await db.users.findOne({ _id: event.member }, { projection: { name: 1 } });
    await notifyOrder(db, log, {
      to: event.owner,
      actor: event.member,
      orderId: event.orderId,
      type: "order.updated",
      forShop: true,
      title: `Order #${event.orderNo} ${event.status === "rejected" ? "turned down" : "updated"}`,
      body: `${member?.name || "Someone on your team"} ${did}.`,
    });
  } catch (err) {
    log.warn({ err: (err as Error).message, type: "order" }, "Notification not saved");
  }
}

/** Tells a vendor a withdrawal reached the bank or came back. Logged, never thrown: the payout is already settled. */
export async function notifyPayout(
  db: Database,
  log: FastifyBaseLogger,
  event: { to: ObjectId; payoutId: ObjectId; title: string; body: string },
): Promise<void> {
  try {
    await save(db, {
      _id: new ObjectId(),
      userId: event.to,
      type: "payout.updated",
      actorId: event.to,
      title: clip(event.title, 60),
      body: clip(event.body, 140),
      link: { screen: "payments", id: event.payoutId.toHexString() },
      readAt: null,
      createdAt: new Date(),
    });
  } catch (err) {
    log.warn({ err: (err as Error).message, type: "payout" }, "Notification not saved");
  }
}

/**
 * Team news: an invite to the person invited (`work`), someone joining or leaving to the owner (`team`), or a removal to the person
 * removed. Logged, never thrown: the change is already saved.
 */
export async function notifyTeam(
  db: Database,
  log: FastifyBaseLogger,
  event: { to: ObjectId; actor: ObjectId; type: "team.invited" | "team.joined" | "team.ended"; title: string; body: string; link: NotificationDoc["link"] },
): Promise<void> {
  try {
    await save(db, {
      _id: new ObjectId(),
      userId: event.to,
      type: event.type,
      actorId: event.actor,
      title: clip(event.title, 60),
      body: clip(event.body, 140),
      link: event.link,
      readAt: null,
      createdAt: new Date(),
    });
  } catch (err) {
    log.warn({ err: (err as Error).message, type: event.type }, "Notification not saved");
  }
}

/** Tells a user their verification was decided. Logged, never thrown: the decision is already saved. */
export async function notifyKycDecision(
  db: Database,
  log: FastifyBaseLogger,
  event: { to: ObjectId; reviewer: ObjectId; decision: "approved" | "rejected" | "locked"; reason: string | null },
): Promise<void> {
  const [title, body] =
    event.decision === "approved"
      ? ["You are verified", "Your Ruxstar Card is ready and your vendor portal is open."]
      : event.decision === "locked"
        ? ["Verification is on hold", "Contact support to continue."]
        : ["Verification needs a change", clip(event.reason ?? "Open verification to see what to fix.", 140)];
  try {
    await save(db, {
      _id: new ObjectId(),
      userId: event.to,
      type: event.decision === "approved" ? "kyc.approved" : "kyc.rejected",
      actorId: event.reviewer,
      title,
      body,
      link: { screen: "verification", id: "base" },
      readAt: null,
      createdAt: new Date(),
    });
  } catch (err) {
    log.warn({ err: (err as Error).message, type: "kyc" }, "Notification not saved");
  }
}
