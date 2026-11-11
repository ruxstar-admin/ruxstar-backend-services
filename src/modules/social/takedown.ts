import type { FastifyInstance } from "fastify";
import type { WithId } from "mongodb";
import type { Database, PostDoc, PostPhoto } from "../../platform/db.js";

export const keysOf = (photo: Pick<PostPhoto, "key" | "smaller">) => [photo.key, ...(photo.smaller ?? []).map((s) => s.key)];

/**
 * After a post stops being live, deleted by its author or removed by the Ruxstar team: its counts
 * come off the author, and its likes, saves, comments and photos go. `gone` is the post as it was.
 */
export async function clearPost(app: FastifyInstance, db: Database, gone: WithId<PostDoc>): Promise<void> {
  await Promise.all([
    db.users.updateOne(
      { _id: gone.authorId },
      { $inc: { "social.posts": -1, "social.engagements": -(gone.counts.likes + gone.counts.comments) } },
    ),
    db.postReactions.deleteMany({ postId: gone._id }),
    db.postComments.updateMany({ postId: gone._id }, { $set: { status: "deleted" } }),
    db.postMedia.deleteMany({ postId: gone._id }),
    ...gone.media.flatMap(keysOf).map((key) => app.media.remove(key)),
  ]);
}
