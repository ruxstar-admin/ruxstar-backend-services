import { Type, type Static } from "typebox";
import { DateTime, Envelope, ListEnvelope, ObjectIdString, PageQuery, Strict } from "../../contracts/common.js";

export const POST_TEXT_MAX = 500;
export const POST_PHOTOS_MAX = 4;
export const COMMENT_TEXT_MAX = 300;

export const PostKind = Type.Union([Type.Literal("personal"), Type.Literal("business")]);

export const Author = Strict({
  id: ObjectIdString,
  name: Type.String(),
  username: Type.String(),
  avatarUrl: Type.Union([Type.String(), Type.Null()]),
  vendor: Type.Boolean(),
  verified: Type.Boolean({ description: "Identity verified by Ruxstar" }),
});

const PhotoFile = Strict({
  url: Type.String(),
  width: Type.Integer(),
  height: Type.Integer(),
});

export const Photo = Strict({
  ...PhotoFile.properties,
  smaller: Type.Array(PhotoFile, {
    description: "Narrower copies of the same photo, narrowest first, for grids and small screens. Empty for photos posted before they existed.",
  }),
});

export const Post = Strict({
  id: ObjectIdString,
  author: Author,
  kind: PostKind,
  text: Type.String(),
  media: Type.Array(Photo),
  counts: Strict({ likes: Type.Integer(), comments: Type.Integer() }),
  createdAt: DateTime,
  editedAt: Type.Union([DateTime, Type.Null()]),
  likedByMe: Type.Boolean(),
  savedByMe: Type.Boolean(),
  mine: Type.Boolean(),
});
export type Post = Static<typeof Post>;
export const PostResult = Envelope(Post);
export const PostList = ListEnvelope(Post);

export const Comment = Strict({
  id: ObjectIdString,
  author: Author,
  text: Type.String(),
  createdAt: DateTime,
  mine: Type.Boolean(),
});
export type Comment = Static<typeof Comment>;
export const CommentResult = Envelope(Comment);
export const CommentList = ListEnvelope(Comment);

export const Upload = Strict({ id: ObjectIdString, ...Photo.properties });
export const UploadResult = Envelope(Upload);

export const PostCreate = Strict({
  text: Type.String({ maxLength: POST_TEXT_MAX }),
  mediaIds: Type.Optional(Type.Array(ObjectIdString, { maxItems: POST_PHOTOS_MAX, uniqueItems: true })),
  kind: Type.Optional(PostKind),
});
export const PostPatch = Strict({ text: Type.String({ maxLength: POST_TEXT_MAX }) });
export const CommentCreate = Strict({ text: Type.String({ minLength: 1, maxLength: COMMENT_TEXT_MAX }) });

export const ReportReason = Type.Union(["spam", "fake", "abuse", "undelivered", "other"].map((r) => Type.Literal(r)));
export const ReportBody = Strict({ reason: ReportReason });

export const IdParams = Strict({ id: ObjectIdString });
export const UserParams = Strict({ ref: Type.String({ minLength: 3, maxLength: 24, description: "A username, or a user id" }) });
export const Page = Strict(PageQuery);
export const UserPostsQuery = Strict({ ...PageQuery, kind: Type.Optional(PostKind) });

export const LikeState = Envelope(Strict({ likes: Type.Integer(), likedByMe: Type.Boolean() }));
export const SaveState = Envelope(Strict({ savedByMe: Type.Boolean() }));
export const Done = Envelope(Strict({ done: Type.Literal(true) }));
