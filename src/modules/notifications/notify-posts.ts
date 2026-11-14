import type { FastifyBaseLogger } from "fastify";
import { ObjectId } from "mongodb";
import type { Database } from "../../platform/db.js";
import { USERNAME } from "../account/usernames.js";
import { blockedAround } from "../social/relations.js";
import { clip, save } from "./notify.js";
import { pushTo } from "./push.js";

/** A new post is pushed to this many of the author's newest followers. The rest see it in their feed. */
export const FOLLOWER_PUSH_LIMIT = 2000;
/** Most people one post or comment can notify by mention. */
const MENTION_LIMIT = 10;

const MENTION = /(?<![a-z0-9_.@])@([a-z0-9_.]{3,20})/gi;

/** The usernames written as `@name` in a text, lowercased, once each. */
export function mentionsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(MENTION)) {
    const name = match[1]!.toLowerCase().replace(/[._]+$/, "");
    if (USERNAME.test(name)) found.add(name);
    if (found.size === MENTION_LIMIT) break;
  }
  return [...found];
}

/**
 * Tells the people @mentioned in a post or comment. Never the author, never anyone blocked either way, and never someone in
 * `skip` (they were told another way). After an edit, `before` is the old text: only names it didn't have are told.
 * Answers who was told. Logged, never thrown: the post is already saved.
 */
export async function notifyMentions(
  db: Database,
  log: FastifyBaseLogger,
  event: { text: string; before?: string; actor: { id: ObjectId; name?: string }; postId: ObjectId; skip?: ObjectId[] },
): Promise<ObjectId[]> {
  const already = new Set(event.before === undefined ? [] : mentionsIn(event.before));
  const usernames = mentionsIn(event.text).filter((name) => !already.has(name));
  if (usernames.length === 0) return [];
  try {
    const [people, blocked, actor] = await Promise.all([
      db.users.find({ username: { $in: usernames } }, { projection: { _id: 1 } }).toArray(),
      blockedAround(db, event.actor.id),
      event.actor.name === undefined ? db.users.findOne({ _id: event.actor.id }, { projection: { name: 1 } }) : null,
    ]);
    const left = new Set([event.actor.id, ...blocked, ...(event.skip ?? [])].map((id) => id.toHexString()));
    const name = event.actor.name ?? actor?.name ?? "Someone";
    const told: ObjectId[] = [];
    for (const person of people) {
      if (left.has(person._id.toHexString())) continue;
      await save(db, {
        _id: new ObjectId(),
        userId: person._id,
        type: "post.mention",
        actorId: event.actor.id,
        title: "You were mentioned",
        body: `${name}: ${clip(event.text)}`,
        link: { screen: "post", id: event.postId.toHexString() },
        readAt: null,
        createdAt: new Date(),
      });
      told.push(person._id);
    }
    return told;
  } catch (err) {
    log.warn({ err: (err as Error).message, type: "post.mention" }, "Notification not saved");
    return [];
  }
}

/**
 * Tells the author's followers about a new post, on their phones only: it would bury the notifications screen for anyone with
 * many followers. Newest followers first, up to `FOLLOWER_PUSH_LIMIT`; never anyone blocked either way or in `skip`.
 * Logged, never thrown.
 */
export async function notifyFollowersOfPost(
  db: Database,
  log: FastifyBaseLogger,
  event: { authorId: ObjectId; businessId?: ObjectId | null; postId: ObjectId; text: string; hasPhotos: boolean; skip?: ObjectId[] },
): Promise<void> {
  try {
    const [followers, blocked, author, business] = await Promise.all([
      db.follows
        .find({ followeeId: event.authorId }, { projection: { followerId: 1 } })
        .sort({ createdAt: -1, _id: -1 })
        .limit(FOLLOWER_PUSH_LIMIT)
        .toArray(),
      blockedAround(db, event.authorId),
      db.users.findOne({ _id: event.authorId }, { projection: { name: 1 } }),
      event.businessId ? db.businesses.findOne({ _id: event.businessId }, { projection: { name: 1 } }) : null,
    ]);
    const left = new Set([...blocked, ...(event.skip ?? [])].map((id) => id.toHexString()));
    const to = followers.map((f) => f.followerId).filter((id) => !left.has(id.toHexString()));
    await pushTo(to, {
      title: `${business?.name ?? author?.name ?? "Someone you follow"} posted`,
      body: event.text ? clip(event.text, 120) : event.hasPhotos ? "Shared a photo." : "Shared a post.",
      data: { screen: "post", id: event.postId.toHexString() },
    });
  } catch (err) {
    log.warn({ err: (err as Error).message, type: "post.published" }, "Followers not told about a post");
  }
}

/**
 * Tells the people who reported a post that the Ruxstar team decided it: taken down, or kept up. One each. Logged, never
 * thrown: the decision is already saved.
 */
export async function notifyReportResolved(
  db: Database,
  log: FastifyBaseLogger,
  event: { to: ObjectId[]; moderator: ObjectId; postId: ObjectId; outcome: "kept" | "removed" },
): Promise<void> {
  const [title, body] =
    event.outcome === "removed"
      ? ["Thanks for your report", "We reviewed the post you reported and took it down."]
      : ["We reviewed your report", "We looked at the post you reported and it stays up. It doesn't break our rules."];
  for (const userId of new Map(event.to.map((id) => [id.toHexString(), id])).values()) {
    try {
      await save(db, {
        _id: new ObjectId(),
        userId,
        type: "report.resolved",
        actorId: event.moderator,
        title,
        body,
        link: { screen: "post", id: event.postId.toHexString() },
        readAt: null,
        createdAt: new Date(),
      });
    } catch (err) {
      log.warn({ err: (err as Error).message, type: "report.resolved" }, "Notification not saved");
    }
  }
}
