import { Type, type Static, type TSchema } from "typebox";
import { DateTime, Envelope, ListEnvelope, ObjectIdString, PageQuery, Paise, Strict } from "../../contracts/common.js";
import { AppliedCoupon, Offer } from "../coupons/contracts.js";
import { InvoiceRefs } from "../invoices/contracts.js";
import { Rating, ReviewEligibility } from "../reviews/contracts.js";
import { QuoteCard } from "../social/chat-contracts.js";
import { ANSWER_MAX, MAX_FILES, MAX_GIG_PHOTOS, MAX_LINKS, MAX_PORTFOLIO, MAX_QUESTIONS } from "./rules.js";

const Nullable = <T extends TSchema>(schema: T, options?: { description: string }) => Type.Union([schema, Type.Null()], options);

export const IdParams = Strict({ id: ObjectIdString });
export const FileParams = Strict({ id: ObjectIdString, fileId: ObjectIdString });
export const PhotoParams = Strict({ id: ObjectIdString, photoId: Type.String({ minLength: 1, maxLength: 40 }) });
export const ItemParams = Strict({ itemId: Type.String({ minLength: 1, maxLength: 40 }) });

const Photo = Strict({ id: Type.String(), url: Type.String(), width: Type.Integer(), height: Type.Integer() });
const Category = Type.String({ minLength: 2, maxLength: 30, description: "A key from GET /v1/gigs/rules `categories`" });
const Tier = Type.Union([Type.Literal("basic"), Type.Literal("standard"), Type.Literal("premium")], {
  description: "Basic, Standard and Premium, in that order: a gig with two packages has basic and standard",
});
const Link = Type.String({ pattern: "^https?://", maxLength: 500 });
const OrderStatus = Type.Union(
  [
    Type.Literal("awaiting_payment"),
    Type.Literal("paid"),
    Type.Literal("in_progress"),
    Type.Literal("delivered"),
    Type.Literal("disputed"),
    Type.Literal("completed"),
    Type.Literal("cancelled"),
  ],
  {
    description:
      "`paid` waits for the freelancer to accept. `in_progress` is being worked on (again, after a revision). `delivered` waits for the customer. " +
      "`disputed`: a problem was reported and Ruxstar decides. `completed`: the freelancer is paid",
  },
);
const Actor = Type.Union([Type.Literal("customer"), Type.Literal("vendor"), Type.Literal("staff"), Type.Literal("system")], { description: "`vendor` is the freelancer" });
const ReturnTo = Type.String({
  maxLength: 500,
  description: "Where the checkout page sends the customer afterwards: this site, or the app's own link. `order=<id>` is added.",
});
const Coupon = Type.Optional(Type.String({ minLength: 3, maxLength: 20 }));
const FileIds = Type.Array(ObjectIdString, { maxItems: MAX_FILES, uniqueItems: true, description: "Files you uploaded with POST /v1/gigs/files and haven't used yet" });

// Ruxstar's rules.

export const GigsRulesView = Strict({
  categories: Type.Array(Strict({ key: Type.String(), label: Type.String() }), { description: "The ones showing, in order" }),
  autoCompleteDays: Type.Integer({ description: "A delivery the customer doesn't answer completes this many days later" }),
  acceptHours: Type.Integer({ description: "A paid order the freelancer doesn't accept in this long is refunded in full" }),
  quoteDays: Type.Integer({ description: "A custom offer can be paid for this many days" }),
  deliveryMaxMb: Type.Integer({ description: "Files in one delivery, or attached to an order, add up to at most this" }),
  fileDays: Type.Integer({ description: "An order's files are deleted this many days after it ends" }),
  maxGigs: Type.Integer(),
  maxPackages: Type.Integer(),
  minPrice: Paise,
  maxPrice: Paise,
  minDays: Type.Integer(),
  maxDays: Type.Integer(),
  maxRevisions: Type.Integer(),
  commissionBps: Type.Integer(),
  platformFee: Paise,
  live: Type.Boolean(),
  signupsOpen: Type.Boolean({ description: "New freelancers can start" }),
  limits: Strict(
    {
      portfolio: Type.Integer({ description: "Photos and links on a profile, together" }),
      gigPhotos: Type.Integer(),
      questions: Type.Integer({ description: "On one gig" }),
      files: Type.Integer({ description: "On one order or one delivery" }),
      links: Type.Integer({ description: "In one delivery" }),
      answer: Type.Integer({ description: "Characters in one answer to a gig's question" }),
      extensions: Type.Array(Type.String(), { description: "The kinds of file that can be uploaded, by the name's extension" }),
    },
    { description: "Fixed by Ruxstar; not settings" },
  ),
});
export const GigsRulesOne = Envelope(GigsRulesView);

// Freelancers and gigs, as customers see them.

const FreelancerRef = Strict({
  businessId: ObjectIdString,
  userId: ObjectIdString,
  username: Nullable(Type.String(), { description: "With `userId`, opens a 1:1 chat with them" }),
  name: Type.String(),
  headline: Type.String(),
  city: Nullable(Type.String()),
  avatarUrl: Nullable(Type.String()),
});
export const Package = Strict({
  tier: Tier,
  name: Type.String(),
  description: Type.String({ description: "What's included" }),
  price: Paise,
  deliveryDays: Type.Integer(),
  revisions: Type.Integer(),
});
const Question = Strict({ id: Type.String(), text: Type.String(), required: Type.Boolean() });

const cardFields = {
  id: ObjectIdString,
  title: Type.String(),
  category: Type.String(),
  categoryLabel: Type.String(),
  photo: Nullable(Photo),
  priceFrom: Paise,
  fastestDays: Type.Integer({ description: "The fewest delivery days of its packages" }),
  freelancer: FreelancerRef,
  rating: Type.Optional(Rating),
};
export const GigCard = Strict(cardFields);
export type GigCard = Static<typeof GigCard>;
export const GigList = ListEnvelope(GigCard);
export const GigsQuery = Strict({
  ...PageQuery,
  category: Type.Optional(Category),
  city: Type.Optional(Type.String({ minLength: 2, maxLength: 60, description: "Freelancers who said they are there" })),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "Words in the title or the freelancer's name" })),
});

export const GigDetail = Strict({
  ...cardFields,
  description: Type.String(),
  photos: Type.Array(Photo),
  packages: Type.Array(Package),
  questions: Type.Array(Question, { description: "Asked when ordering" }),
  platformFee: Paise,
  status: Type.Union([Type.Literal("draft"), Type.Literal("live"), Type.Literal("paused"), Type.Literal("removed")]),
  canOrder: Type.Boolean(),
  whyNot: Nullable(Type.String({ description: "Why it can't be ordered right now" })),
  rules: Type.String({ description: "The order rules in a sentence or two, for above the Pay button" }),
});
export type GigDetail = Static<typeof GigDetail>;
export const GigOne = Envelope(GigDetail);

const PortfolioLink = Strict({ id: Type.String(), title: Type.String(), url: Type.String() });
const profileFields = {
  businessId: ObjectIdString,
  name: Type.String(),
  headline: Type.String(),
  bio: Nullable(Type.String()),
  category: Type.String(),
  categoryLabel: Type.String(),
  skills: Type.Array(Type.String()),
  languages: Type.Array(Type.String()),
  city: Nullable(Type.String()),
  avatarUrl: Nullable(Type.String()),
  portfolio: Strict({ photos: Type.Array(Photo), links: Type.Array(PortfolioLink) }),
  rating: Type.Optional(Rating),
};
export const FreelancerPage = Strict({
  ...profileFields,
  userId: ObjectIdString,
  username: Nullable(Type.String()),
  gigs: Type.Array(GigCard, { description: "Live gigs, newest first" }),
  memberSince: DateTime,
});
export const FreelancerOne = Envelope(FreelancerPage);

// Your freelancer profile.

export const MyProfile = Strict({
  ...profileFields,
  status: Type.Union([Type.Literal("draft"), Type.Literal("live")], { description: "`live` once a gig is published" }),
  verified: Type.Boolean({ description: "Base verification is done; publishing gigs and sending offers need it" }),
  suspended: Type.Boolean({ description: "Ruxstar is holding the profile: nothing can be sold" }),
  gigs: Strict({ total: Type.Integer(), live: Type.Integer(), max: Type.Integer() }),
  createdAt: DateTime,
});
export const MyProfileOne = Envelope(MyProfile);

const profileBody = {
  name: Type.String({ minLength: 2, maxLength: 60, description: "Your display name as a freelancer" }),
  headline: Type.String({ minLength: 5, maxLength: 80, description: "One line, for example Logo designer for small brands" }),
  bio: Nullable(Type.String({ maxLength: 500 })),
  category: Category,
  skills: Type.Array(Type.String({ minLength: 2, maxLength: 30 }), { maxItems: 15, uniqueItems: true }),
  languages: Type.Array(Type.String({ minLength: 2, maxLength: 30 }), { minItems: 1, maxItems: 8, uniqueItems: true }),
  city: Nullable(Type.String({ minLength: 2, maxLength: 60, description: "Optional; customers can look for freelancers in their city" })),
};
export const StartBody = Strict(profileBody);
export const UpdateProfileBody = Strict(
  {
    name: Type.Optional(profileBody.name),
    headline: Type.Optional(profileBody.headline),
    bio: Type.Optional(profileBody.bio),
    category: Type.Optional(profileBody.category),
    skills: Type.Optional(profileBody.skills),
    languages: Type.Optional(profileBody.languages),
    city: Type.Optional(profileBody.city),
  },
  { minProperties: 1, description: "Send only what changes. The name and city show on your gigs too." },
);
export const PortfolioLinkBody = Strict({ title: Type.String({ minLength: 2, maxLength: 80 }), url: Link });

// Your gigs.

const PackageBody = Strict({
  tier: Tier,
  name: Type.Optional(Type.String({ minLength: 2, maxLength: 40, description: "Leave out for Basic, Standard or Premium" })),
  description: Type.String({ minLength: 10, maxLength: 600, description: "What's included" }),
  price: Type.Integer({ minimum: 1, description: "Paise, within Ruxstar's price range" }),
  deliveryDays: Type.Integer({ minimum: 1, maximum: 365, description: "Within Ruxstar's delivery days, counted from acceptance" }),
  revisions: Type.Integer({ minimum: 0, maximum: 50, description: "Up to Ruxstar's most" }),
});
const QuestionBody = Strict({ text: Type.String({ minLength: 3, maxLength: 200 }), required: Type.Boolean() });
const gigBody = {
  title: Type.String({ minLength: 10, maxLength: 80, description: "For example I will design a logo for your brand" }),
  category: Category,
  description: Type.String({ minLength: 30, maxLength: 3000 }),
  packages: Type.Array(PackageBody, { minItems: 1, maxItems: 3, description: "One to Ruxstar's most, Basic first" }),
  questions: Type.Array(QuestionBody, { maxItems: MAX_QUESTIONS, description: "What to ask the customer when they order" }),
};
export const CreateGigBody = Strict(gigBody);
export const UpdateGigBody = Strict(
  {
    title: Type.Optional(gigBody.title),
    category: Type.Optional(gigBody.category),
    description: Type.Optional(gigBody.description),
    packages: Type.Optional(gigBody.packages),
    questions: Type.Optional(gigBody.questions),
  },
  { minProperties: 1, description: "Send only what changes; packages and questions are replaced whole. Orders made keep what they bought." },
);

export const MyGig = Strict({
  ...GigDetail.properties,
  publishedAt: Nullable(DateTime),
  removal: Nullable(Strict({ reason: Type.String(), at: DateTime })),
  missing: Type.Array(Type.String(), { description: "What publishing still needs, in words" }),
  orders: Type.Integer({ description: "Paid orders" }),
  createdAt: DateTime,
  updatedAt: DateTime,
});
export type MyGig = Static<typeof MyGig>;
export const MyGigOne = Envelope(MyGig);
export const MyGigList = ListEnvelope(MyGig);
export const MyGigsQuery = Strict({
  ...PageQuery,
  status: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("live"), Type.Literal("paused"), Type.Literal("removed")])),
});

// Files.

export const UploadQuery = Strict({
  name: Type.String({ minLength: 1, maxLength: 120, description: "The file's name, with its extension" }),
  use: Type.Union([Type.Literal("brief"), Type.Literal("delivery")], { description: "`brief`: to attach to an order you place. `delivery`: to deliver an order" }),
});
export const UploadedFile = Strict({
  id: ObjectIdString,
  name: Type.String(),
  contentType: Type.String(),
  bytes: Type.Integer(),
  use: UploadQuery.properties.use,
  createdAt: DateTime,
});
export const UploadedOne = Envelope(UploadedFile);
const FileView = Strict({
  id: ObjectIdString,
  name: Type.String(),
  contentType: Type.String(),
  bytes: Type.Integer(),
  url: Nullable(Type.String({ description: "Downloads it; works for 10 minutes. Null once the order's files were deleted" })),
});

// Orders.

const Delivery = Strict({
  id: ObjectIdString,
  message: Type.String(),
  links: Type.Array(Type.String()),
  files: Type.Array(FileView),
  at: DateTime,
  answer: Nullable(
    Strict({
      kind: Type.Union([Type.Literal("approved"), Type.Literal("revision"), Type.Literal("problem")]),
      note: Nullable(Type.String()),
      at: DateTime,
    }),
  ),
});
const Refund = Strict({
  kind: Type.Union([Type.Literal("full"), Type.Literal("part")]),
  amount: Paise,
  status: Type.Union([Type.Literal("pending"), Type.Literal("done")]),
  reason: Nullable(Type.String()),
  at: DateTime,
});

export const GigOrder = Strict({
  id: ObjectIdString,
  orderNo: Type.Integer(),
  status: OrderStatus,
  role: Type.Union([Type.Literal("customer"), Type.Literal("freelancer"), Type.Literal("staff")], { description: "Whose view this is" }),
  title: Type.String(),
  category: Type.String(),
  gigId: Nullable(ObjectIdString, { description: "Null for a custom offer" }),
  quoteId: Nullable(ObjectIdString),
  freelancer: Strict({
    businessId: ObjectIdString,
    userId: ObjectIdString,
    username: Nullable(Type.String(), { description: "With `userId`, opens a 1:1 chat with them" }),
    name: Type.String(),
    avatarUrl: Nullable(Type.String()),
  }),
  customer: Strict({ id: ObjectIdString, name: Type.String() }),
  package: Strict({ tier: Nullable(Tier), name: Type.String(), description: Type.String(), deliveryDays: Type.Integer(), revisions: Type.Integer() }),
  answers: Type.Array(Strict({ question: Type.String(), answer: Type.String() })),
  files: Type.Array(FileView, { description: "The customer's files for the brief" }),
  note: Nullable(Type.String()),
  price: Strict({ items: Paise, discount: Paise, platformFee: Paise, total: Paise }),
  coupon: Nullable(AppliedCoupon),
  share: Nullable(Paise, { description: "The freelancer's and the console's view: what the freelancer gets once it completes, after commission and part refunds" }),
  refunds: Type.Array(Refund),
  payBy: Nullable(DateTime, { description: "Unpaid, it is cancelled after this" }),
  paidAt: Nullable(DateTime),
  acceptBy: Nullable(DateTime, { description: "Paid, the freelancer must accept by then or it is refunded" }),
  acceptedAt: Nullable(DateTime),
  dueAt: Nullable(DateTime),
  late: Type.Boolean({ description: "Past its due date with nothing delivered" }),
  revisions: Strict({ included: Type.Integer(), used: Type.Integer(), left: Type.Integer() }),
  deliveries: Type.Array(Delivery, { description: "Oldest first" }),
  autoCompleteAt: Nullable(DateTime, { description: "Delivered: it completes by itself then unless the customer answers" }),
  completedAt: Nullable(DateTime),
  dispute: Nullable(
    Strict({
      reason: Type.String(),
      openedAt: DateTime,
      ticketId: ObjectIdString,
      decision: Nullable(Strict({ outcome: Type.Union([Type.Literal("full"), Type.Literal("part"), Type.Literal("none")]), amount: Paise, note: Type.String(), at: DateTime })),
    }),
  ),
  cancellation: Nullable(Strict({ by: Actor, reason: Type.String(), at: DateTime })),
  timeline: Type.Array(Strict({ status: OrderStatus, at: DateTime, by: Actor }), { description: "Every change of status, oldest first" }),
  filesDeleted: Type.Boolean({ description: "Files go a set number of days after it ends; the order and messages stay" }),
  can: Strict({
    pay: Type.Boolean(),
    cancel: Type.Boolean({ description: "Customer: before it's accepted, or once late. Freelancer: until it completes or a problem is reported" }),
    accept: Type.Boolean(),
    decline: Type.Boolean({ description: "Freelancer: a paid order waiting to be accepted can be turned down" }),
    deliver: Type.Boolean(),
    approve: Type.Boolean(),
    revise: Type.Boolean(),
    report: Type.Boolean(),
  }),
  invoices: InvoiceRefs,
  ...ReviewEligibility,
  createdAt: DateTime,
});
export type GigOrder = Static<typeof GigOrder>;
export const GigOrderOne = Envelope(GigOrder);
export const GigOrderList = ListEnvelope(GigOrder);
export const PlacedOrder = Envelope(Strict({ order: GigOrder, checkoutUrl: Nullable(Type.String({ description: "Null when it was free and is paid already" })) }));
export const CheckoutLinkOne = Envelope(Strict({ checkoutUrl: Type.String() }));
export const PayBody = Strict({ returnTo: ReturnTo });
export const OrderBody = Strict({
  tier: Tier,
  answers: Type.Array(Strict({ questionId: Type.String({ minLength: 1, maxLength: 40 }), answer: Type.String({ maxLength: ANSWER_MAX }) }), { maxItems: MAX_QUESTIONS }),
  fileIds: Type.Optional(FileIds),
  note: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
  coupon: Coupon,
  returnTo: ReturnTo,
});
export const QuotePayBody = Strict({
  fileIds: Type.Optional(FileIds),
  note: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
  coupon: Coupon,
  returnTo: ReturnTo,
});
export const MyOrdersQuery = Strict({
  ...PageQuery,
  view: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("past")], { default: "current", description: "current: not completed or cancelled" })),
});
export const DeskOrdersQuery = Strict({ ...PageQuery, status: Type.Optional(OrderStatus) });
export const NoteBody = Strict({ note: Type.String({ minLength: 5, maxLength: 1000, description: "What to change" }) });
export const ApproveBody = Strict({ note: Type.Optional(Nullable(Type.String({ maxLength: 500 }))) });
export const ProblemBody = Strict({ reason: Type.String({ minLength: 10, maxLength: 2000, description: "What's wrong. It opens a help ticket about the order" }) });
export const CancelBody = Strict({ reason: Type.Optional(Type.String({ minLength: 5, maxLength: 300 })) });
export const VendorCancelBody = Strict({ reason: Type.String({ minLength: 5, maxLength: 300, description: "The customer is told" }) });
export const DeliverBody = Strict({
  message: Type.String({ minLength: 1, maxLength: 2000 }),
  links: Type.Array(Link, { maxItems: MAX_LINKS, description: "For example a shared drive folder" }),
  fileIds: FileIds,
});
export const OffersQuery = Strict({
  tier: Tier,
  code: Type.Optional(Type.String({ minLength: 3, maxLength: 20, description: "Check this code too" })),
});
export const OffersOne = Envelope(
  Strict({
    offers: Type.Array(Offer),
    checked: Nullable(Strict({ code: Type.String(), discount: Paise, problem: Nullable(Type.String()) }), { description: "With `code`" }),
  }),
);
export const QuoteOne = Envelope(
  Strict(
    {
      ...QuoteCard.properties,
      chatId: ObjectIdString,
      orderId: Nullable(ObjectIdString, { description: "Once it's paid" }),
      withdrawnAt: Nullable(DateTime),
    },
    { description: "Everything the offer's card in the chat shows, and where it stands" },
  ),
);
export const QuoteOffersQuery = Strict({ code: OffersQuery.properties.code });

// The console.

export const ConsoleFreelancer = Strict({
  ...profileFields,
  ownerId: ObjectIdString,
  status: Type.Union([Type.Literal("draft"), Type.Literal("live")]),
  verified: Type.Boolean(),
  suspended: Type.Boolean({ description: "On hold: POST /v1/ruxstar/gigs/freelancers/{id}/suspend and /restore, the same as the business hold" }),
  gigs: Type.Integer(),
  orders: Type.Integer({ description: "Paid orders" }),
  createdAt: DateTime,
});
export const ConsoleFreelancerList = ListEnvelope(ConsoleFreelancer);
export const ConsoleFreelancerOne = Envelope(ConsoleFreelancer);
export const ConsoleFreelancersQuery = Strict({ ...PageQuery, q: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "Words in the name" })) });
export const ConsoleGigsQuery = Strict({
  ...PageQuery,
  status: MyGigsQuery.properties.status,
  freelancer: Type.Optional(ObjectIdString),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "Words in the title" })),
});
export const ConsoleGig = Strict({ ...MyGig.properties, vendorId: ObjectIdString });
export const ConsoleGigList = ListEnvelope(ConsoleGig);
export const ConsoleGigOne = Envelope(ConsoleGig);
export const TakeDownBody = Strict({ reason: Type.String({ minLength: 5, maxLength: 300, description: "The freelancer is told" }) });
export const ConsoleOrdersQuery = Strict({
  ...PageQuery,
  status: Type.Optional(OrderStatus),
  freelancer: Type.Optional(ObjectIdString),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "An order number, or words in the title" })),
});
export const DecideBody = Strict({
  outcome: Type.Union([Type.Literal("full"), Type.Literal("part"), Type.Literal("none")], {
    description: "full: everything back to the customer. part: `amount` back, out of the freelancer's share, and the rest to them. none: all of it to the freelancer",
  }),
  amount: Type.Optional(Type.Integer({ minimum: 1, description: "Paise; part refunds only, less than what was paid and up to the freelancer's share" })),
  note: Type.String({ minLength: 5, maxLength: 1000, description: "Both sides are told; it goes on the help ticket too" }),
});
