import { Type, type Static, type TSchema } from "typebox";
import { DateTime, Envelope, ListEnvelope, ObjectIdString, PageQuery, Strict } from "../../contracts/common.js";

const Nullable = <T extends TSchema>(schema: T, options?: { description: string }) => Type.Union([schema, Type.Null()], options);
const Count = Type.Integer({ minimum: 0 });

/** Reviews can be written and changed for this long after delivery. */
export const REVIEW_DAYS = 30;
/** A shop's average shows once it has this many reviews; before that it is new. */
export const RATING_MIN_REVIEWS = 3;
export const REVIEW_TEXT_MAX = 500;

export const Rating = Strict(
  {
    average: Nullable(Type.Number({ minimum: 1, maximum: 5 }), { description: `To one decimal; null until there are ${RATING_MIN_REVIEWS} reviews` }),
    count: Count,
  },
  { description: "Live reviews" },
);
export type Rating = Static<typeof Rating>;

const Stars = Type.Integer({ minimum: 1, maximum: 5 });
const Reply = Strict({ text: Type.String(), at: DateTime, editedAt: Nullable(DateTime) });
const Author = Strict({ id: ObjectIdString, name: Type.String(), username: Nullable(Type.String()), avatarUrl: Nullable(Type.String()) });

/** A review as anyone sees it on the shop's page. */
export const Review = Strict({
  id: ObjectIdString,
  rating: Stars,
  text: Nullable(Type.String()),
  product: Type.String({ description: "What was ordered, for example Business cards" }),
  author: Nullable(Author),
  reply: Nullable(Reply, { description: "The shop's answer" }),
  createdAt: DateTime,
  editedAt: Nullable(DateTime),
});
export type Review = Static<typeof Review>;
export const ReviewList = ListEnvelope(Review);

/** The customer's own review of their order. A removed one stays, with Ruxstar's reason, and can't be changed. */
export const MyReview = Strict({
  ...Review.properties,
  orderId: ObjectIdString,
  status: Type.Union([Type.Literal("live"), Type.Literal("removed")]),
  removedReason: Nullable(Type.String()),
});
export type MyReview = Static<typeof MyReview>;
export const MyReviewOne = Envelope(Nullable(MyReview, { description: "Null before the customer reviews the order" }));

/** A review as the shop sees it, with the order it was about. */
export const ShopReview = Strict({ ...Review.properties, orderId: ObjectIdString, orderNo: Type.Integer() });
export type ShopReview = Static<typeof ShopReview>;
export const ShopReviewOne = Envelope(ShopReview);
export const ShopReviewList = ListEnvelope(ShopReview);

export const ReviewBody = Strict({
  rating: Stars,
  text: Type.Optional(Nullable(Type.String({ maxLength: REVIEW_TEXT_MAX, description: "Optional; blank clears it" }))),
});
export const ReplyBody = Strict({ text: Type.String({ minLength: 2, maxLength: REVIEW_TEXT_MAX, description: "The customer is told the first time" }) });

export const ReviewReportReason = Type.Union([Type.Literal("spam"), Type.Literal("fake"), Type.Literal("abuse"), Type.Literal("other")]);
export const ReviewReportBody = Strict({ reason: ReviewReportReason, note: Type.Optional(Type.String({ maxLength: 300 })) });

export const Done = Envelope(Strict({ done: Type.Literal(true) }));
export const ReviewParams = Strict({ id: ObjectIdString });
export const ShopReviewsQuery = Strict({ ...PageQuery });
export const BusinessReviewParams = Strict({ id: ObjectIdString, reviewId: ObjectIdString });

// The console's reported reviews.

export const ReviewCase = Strict({
  reviewId: ObjectIdString,
  review: Nullable(
    Strict({
      ...Review.properties,
      status: Type.Union([Type.Literal("live"), Type.Literal("removed")]),
      shop: Strict({ id: ObjectIdString, name: Type.String() }),
      orderNo: Type.Integer(),
      removal: Nullable(Strict({ reason: Type.String(), at: DateTime })),
    }),
    { description: "Null once the customer deleted it" },
  ),
  status: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
  reports: Count,
  reasons: Strict({ spam: Count, fake: Count, abuse: Count, other: Count }),
  notes: Type.Array(Type.String(), { description: "What reporters wrote, newest first, up to 5" }),
  firstAt: DateTime,
  lastAt: DateTime,
  outcome: Nullable(Type.Union([Type.Literal("kept"), Type.Literal("removed")])),
  closedAt: Nullable(DateTime),
});
export type ReviewCase = Static<typeof ReviewCase>;
export const ReviewCaseList = ListEnvelope(ReviewCase);
export const ReviewCaseOne = Envelope(ReviewCase);
export const ReviewCaseParams = Strict({ reviewId: ObjectIdString });
export const RemoveReviewBody = Strict({
  reason: Type.String({ minLength: 5, maxLength: 300, description: "The customer is told, so be clear" }),
});
