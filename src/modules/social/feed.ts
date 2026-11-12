import type { ObjectId, WithId } from "mongodb";
import type { Database, PostDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { DEFAULT_LIMIT, MAX_LIMIT, findPage } from "../../platform/pagination.js";

/** For you ranks the last week's posts; older ones follow, newest first. */
const WINDOW_MS = 7 * 24 * 60 * 60_000;
const MAX_RANKED = 300;
const FOLLOWED_BOOST = 2;

/**
 * Likes and comments, newer posts first: (1 + likes + 2 × comments) / (hours old + 2)^1.5, doubled for
 * people you follow. The same ranking every time for the same moment, so a page never repeats or skips.
 */
export function score(post: Pick<PostDoc, "counts" | "createdAt">, at: number, followed: boolean): number {
  const hours = Math.max(0, at - post.createdAt.getTime()) / 3_600_000;
  const engagement = 1 + Math.max(0, post.counts.likes) + 2 * Math.max(0, post.counts.comments);
  return (engagement / Math.pow(hours + 2, 1.5)) * (followed ? FOLLOWED_BOOST : 1);
}

/** `a` is the moment the first page was ranked at. Ranked pages carry `o`, the offset; older pages carry `b`, where they start. */
interface ForYouCursor {
  a: number;
  o?: number;
  b?: number;
  c?: string;
}

const encode = (cursor: ForYouCursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");

function decode(cursor: string | undefined): ForYouCursor | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as ForYouCursor;
    const number = (n: unknown) => n === undefined || (typeof n === "number" && Number.isFinite(n) && n >= 0);
    if (!value.a || !number(value.a) || !number(value.o) || !number(value.b) || (value.c !== undefined && typeof value.c !== "string")) throw new Error();
    return value;
  } catch {
    throw new AppError("VALIDATION_FAILED", undefined, [{ path: "querystring/cursor", message: "Invalid cursor" }]);
  }
}

export async function forYouPage(
  db: Database,
  options: { hidden: ObjectId[]; followed: Set<string>; cursor?: string | undefined; limit?: number | undefined },
): Promise<{ items: WithId<PostDoc>[]; nextCursor: string | null }> {
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const cursor = decode(options.cursor);
  const at = cursor?.a ?? Date.now();
  const authors = options.hidden.length ? { authorId: { $nin: options.hidden } } : {};

  if (cursor?.b === undefined) {
    const ranked = await db.posts
      .find({ status: "live", createdAt: { $gt: new Date(at - WINDOW_MS), $lte: new Date(at) }, ...authors })
      .sort({ createdAt: -1, _id: -1 })
      .limit(MAX_RANKED)
      .toArray();
    const order = ranked
      .map((post) => ({ post, score: score(post, at, options.followed.has(post.authorId.toHexString())) }))
      .sort((x, y) => y.score - x.score || (y.post._id.toHexString() > x.post._id.toHexString() ? 1 : -1));
    const offset = cursor?.o ?? 0;
    const items = order.slice(offset, offset + limit).map((r) => r.post);
    if (offset + limit < order.length) return { items, nextCursor: encode({ a: at, o: offset + limit }) };
    // Older posts start where the ranked ones stop: the week's edge, or just before the oldest ranked post when there were too many.
    const edge = ranked.length === MAX_RANKED ? ranked.at(-1)!.createdAt.getTime() - 1 : at - WINDOW_MS;
    const older = await db.posts.findOne({ status: "live", createdAt: { $lte: new Date(edge) }, ...authors }, { projection: { _id: 1 } });
    return { items, nextCursor: older ? encode({ a: at, b: edge }) : null };
  }

  const page = await findPage(db.posts, {
    filter: { status: "live", createdAt: { $lte: new Date(cursor.b) }, ...authors },
    sortField: "createdAt",
    cursor: cursor.c,
    limit,
  });
  return { items: page.items, nextCursor: page.nextCursor ? encode({ a: at, b: cursor.b, c: page.nextCursor }) : null };
}
