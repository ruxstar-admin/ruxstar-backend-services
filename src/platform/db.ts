import { MongoClient, type ClientSession, type Db, type ObjectId } from "mongodb";
import type { Static } from "typebox";
import type { ModuleName } from "../contracts/common.js";
import type { BusinessType, PodProduct } from "../modules/vendor/catalog.js";

export type SwitchableModule = Static<typeof ModuleName>;

/** Every stored document carries these. Bump `schemaVersion` when a document's shape changes. */
export interface Stamped {
  createdAt: Date;
  updatedAt: Date;
  schemaVersion: number;
}

export interface UserRoles {
  vendor?: boolean;
  vendorStaff?: boolean;
  delivery?: boolean;
  ruxstarStaff?: boolean;
  admin?: boolean;
}

export type KycState = "none" | "pending" | "approved" | "rejected" | "expired";

export interface UserDoc extends Stamped {
  _id: ObjectId;
  /** E.164, for example +919876543210. */
  phone: string;
  /** Unique only once verified, so typing someone else's address blocks nobody. */
  email?: string;
  emailVerified?: boolean;
  passwordHash?: string;
  /** The two hashes before the current one, newest first. None of the three can be reused. */
  passwordHistory?: string[];
  name?: string;
  username?: string;
  dob?: string | null;
  gender?: "female" | "male" | "other" | null;
  /** Public URL of the profile photo. */
  avatar?: string | null;
  /** Bucket object behind `avatar`, kept so a replaced or removed photo can be deleted. */
  avatarKey?: string | null;
  bio?: string | null;
  status: "active" | "locked" | "deleted";
  /**
   * Set when the user deletes the account. Phone, username and email move here so others can take
   * them; `purgeAt` (a TTL index) removes the whole record.
   */
  deletion?: { at: Date; phone: string; username: string | null; email: string | null };
  purgeAt?: Date;
  roles: UserRoles;
  kyc: { base?: KycState; vendor?: KycState; delivery?: KycState };
  lock?: { failedCount: number; lockedUntil: Date | null };
  consent?: { termsVersion: string; acceptedAt: Date };
  home?: { city: string | null };
  prefs?: Record<string, unknown>;
  /** Counters kept by Social: live posts, and likes plus comments those posts have received. */
  social?: { posts?: number; engagements?: number; followers?: number; following?: number };
  /** The Ruxstar Card, issued when identity KYC is approved. `id` looks like RUX-1A2B-3C4D. */
  card?: { id: string; issuedAt: Date };
  /** Why the Ruxstar team put the account on hold (`status: "locked"`). Removed when it is unlocked. */
  suspension?: { by: ObjectId; at: Date; reason: string };
  /** When they last had the app or website open, to the minute. People they chat with see "Active 5m ago". */
  activeAt?: Date;
  /** Activity status off: `activeAt` isn't kept, and they don't see anyone else's either. */
  hideActivity?: boolean;
}

export type KycTrack = "base" | "vendor" | "delivery";

/** Bikes and scooters only (decision 57). */
export type VehicleType = "bike" | "scooter";
/** `locked` follows the third rejection; only support can reopen it. */
export type KycCaseStatus = "in_progress" | "submitted" | "approved" | "rejected" | "locked";
export type KycStepStatus = "pending" | "verified" | "failed";

export interface KycAddress {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  pincode: string;
}

/**
 * One verification track for one user. Only Cashfree's references, the last 4 Aadhaar digits and a
 * masked PAN are kept; the Aadhaar photo is held only until the face match uses it.
 */
export interface KycCaseDoc extends Stamped {
  _id: ObjectId;
  userId: ObjectId;
  track: KycTrack;
  status: KycCaseStatus;
  /** Rejections so far. The third locks the case. */
  rejections: number;
  steps: {
    aadhaar?: {
      status: KycStepStatus;
      verificationId: string;
      referenceId: string | null;
      name: string | null;
      last4: string | null;
      /** Base64 JPEG, removed once the face match passes or the case is decided. */
      photo?: string;
      reason: string | null;
      tries: number;
      at: Date;
    };
    pan?: {
      status: KycStepStatus;
      masked: string;
      /** Keyed hash of the full PAN, so one PAN cannot verify two accounts. */
      hash: string;
      registeredName: string | null;
      nameMatch: string | null;
      reason: string | null;
      tries: number;
      at: Date;
    };
    face?: { status: KycStepStatus; livenessScore: number | null; matchScore: number | null; reason: string | null; tries: number; at: Date };
    business?: {
      name: string;
      address: KycAddress;
      gstin: { number: string; legalName: string | null; status: string | null } | null;
      tries: number;
      at: Date;
    };
    /** Delivery track: the driving licence and the vehicle. Photos are JPEGs in the private print files bucket under `kyc/`. */
    licence?: { number: string | null; photo: { key: string; bytes: number } | null; at: Date };
    vehicle?: { type: VehicleType | null; number: string | null; photo: { key: string; bytes: number } | null; at: Date };
  };
  submittedAt: Date | null;
  /** The latest decision. Earlier ones are in the audit log. */
  review: { by: ObjectId; at: Date; decision: "approved" | "rejected"; reason: string | null } | null;
}

/** The modules a vendor can open a business in. Each business is in exactly one. */
export type BusinessModule = "pod" | "events" | "coaching" | "stays" | "turf" | "shop" | "gigs";

export interface BusinessPhoto extends PostPhoto {
  id: string;
}

/** Where a business is, as in the v1 picker: state and city always, the rest when the vendor gives it. */
export interface BusinessLocation {
  state: string;
  city: string;
  doorNo: string | null;
  building: string | null;
  street: string | null;
  area: string | null;
  pincode: string | null;
  /** From "Use current location". */
  point: { lat: number; lng: number } | null;
}

/** One print product's prices, in paise. `per_unit` uses `basePrice`; `per_page` (documents) uses `bw` and `color`. */
export interface PodPrice {
  product: PodProduct;
  model: "per_unit" | "per_page";
  minQuantity: number;
  /** Overrides the business's turnaround for this product. */
  turnaroundDays: number | null;
  basePrice: number | null;
  bw: number | null;
  color: number | null;
  /** Extra charge per unit (or per page) for an option value, such as size XL or spiral binding. */
  extras: { option: string; value: string; price: number }[];
  /** From this many units (or pages) the unit price becomes `unitPrice`. */
  tiers: { from: number; unitPrice: number }[];
}

/** What a shop charges to deliver, in paise: `base` covers the first `includedKm`, then `perKm` for each km after. All 0 is free. */
export interface DeliveryFee {
  base: number;
  includedKm: number;
  perKm: number;
}

/** A print on demand business's setup: what it prints, where, and for how much. */
export interface PodSetup {
  products: PodProduct[];
  serveAll: boolean;
  /** Lower case. */
  cities: string[];
  turnaroundDays: number;
  /** Paise. */
  minOrder: number;
  notes: string | null;
  prices: PodPrice[];
  /** Missing on shops from before it: free. */
  deliveryFee?: DeliveryFee;
}

/** A local shop's delivery, pickup and returns. Same-city only. */
export interface ShopSetup {
  /** Delivers in its city, by its own team or Ruxstar partners. */
  delivery: boolean;
  /** Customers can collect from the shop. */
  pickup: boolean;
  /** Road km from the shop it delivers to; null for anywhere in its city. */
  radiusKm: number | null;
  deliveryFee: DeliveryFee;
  /** Paise of items; 0 for none. */
  minOrder: number;
  /** Takes returns within Ruxstar's return days; false is "No returns". */
  returns: boolean;
  notes: string | null;
}

/** A freelancer's profile, on their `gigs` business. The business's name is their display name and its description the bio. */
export interface FreelancerProfile {
  /** One line, up to 80 characters. */
  headline: string;
  /** A key of the freelancers module's categories. */
  category: string;
  skills: string[];
  languages: string[];
  /** Lower case; null when they don't say. */
  city: string | null;
  /** Up to 12 photos and links together. */
  portfolio: { photos: BusinessPhoto[]; links: { id: string; title: string; url: string }[] };
}

export interface BusinessDoc extends Stamped {
  _id: ObjectId;
  ownerId: ObjectId;
  module: BusinessModule;
  type: BusinessType;
  name: string;
  /** Up to 500 characters. */
  description: string | null;
  /** 10 digits. */
  phone: string | null;
  location: BusinessLocation | null;
  /** Print on demand businesses only. */
  pod: PodSetup | null;
  /** Local shops only; missing until the owner sets delivery and returns. */
  shop?: ShopSetup | null;
  /** Freelancer profiles only: one per person, made with "Start freelancing". */
  freelancer?: FreelancerProfile | null;
  gstin: { number: string; legalName: string | null; status: string | null } | null;
  photos: BusinessPhoto[];
  /** `draft` until the vendor publishes it. Only drafts can be deleted. */
  status: "draft" | "live";
  /** Whether a live business is taking orders and bookings right now. */
  open: boolean;
  publishedAt: Date | null;
  /** Set while the Ruxstar team holds the business; customers can't see it. Removed on restore. */
  suspension?: { by: ObjectId; at: Date; reason: string };
  /** Live reviews, counted again on every change to one (decision 55). Missing before the first. */
  rating?: { count: number; sum: number };
}

/**
 * Where a vendor is paid, or in `rider_payout_methods` a Ruxstar delivery partner. One each, checked with Cashfree before
 * it is saved; someone who is both keeps two.
 */
export interface PayoutMethodDoc extends Stamped {
  _id: ObjectId;
  userId: ObjectId;
  kind: "bank" | "upi";
  /** The name the bank has for the account. */
  holderName: string | null;
  nameMatch: string | null;
  /** `number` is sealed with the payout key; only the last 4 digits are ever shown. */
  bank?: { number: string; last4: string; ifsc: string; bankName: string | null };
  upi?: { vpa: string };
  verifiedAt: Date;
}

/**
 * A withdrawal of everything available. `amount` leaves the vendor's balance; `fee` is Ruxstar's and `amount - fee`
 * reaches the bank. A person has at most one pending at a time, as a vendor or as a partner. A failed one puts `amount` back.
 */
export interface PayoutDoc extends Stamped {
  _id: ObjectId;
  /** Who is paid: the vendor, or the delivery partner when `payee` is "rider". */
  vendorId: ObjectId;
  /** Missing: a vendor's withdrawal. "rider": a Ruxstar delivery partner's, out of `rider:<id>` (decision 59). */
  payee?: "rider";
  /** Paise. */
  amount: number;
  /** Paise, the payout fee in force when it was asked for. */
  fee: number;
  status: "pending" | "paid" | "failed";
  /** How it was sent, for example "Bank ••1191" or "asha@upi". */
  to: string;
  /** Where it goes, copied when asked for, so a later change of account can't redirect it. */
  destination: { name: string; bank?: { number: string; ifsc: string }; upi?: { vpa: string } };
  /** Cashfree's `transfer_id`. */
  transferId: string;
  utr: string | null;
  paidAt: Date | null;
  /** Cashfree's reason code once it failed. */
  failure: string | null;
  /** Times it was sent to Cashfree; a transfer Cashfree never got is sent again, up to a limit. */
  attempts: number;
  checkedAt: Date | null;
}

export type PostKind = "personal" | "business";

export interface PostPhotoFile {
  key: string;
  url: string;
  width: number;
  height: number;
}

export interface PostPhoto extends PostPhotoFile {
  /** Narrower copies, narrowest first. Missing on photos uploaded before they were made. */
  smaller?: PostPhotoFile[];
}

/** Authors are read from `users` when posts are shown, so a new name or photo shows everywhere at once. */
export interface PostDoc extends Stamped {
  _id: ObjectId;
  authorId: ObjectId;
  kind: PostKind;
  text: string;
  media: PostPhoto[];
  counts: { likes: number; comments: number };
  /** The business a business post is for. Posts linked to a live print shop show an Order button. */
  businessId?: ObjectId | null;
  /** `removed` is a takedown by the Ruxstar team; its photos are deleted like a deleted post's. */
  status: "live" | "deleted" | "removed";
  editedAt: Date | null;
  removal?: { by: ObjectId; at: Date; reason: string };
}

/** A photo uploaded for a post. Unused ones are deleted a day later, on the uploader's next upload. */
export interface PostMediaDoc extends PostPhoto {
  _id: ObjectId;
  userId: ObjectId;
  postId: ObjectId | null;
  createdAt: Date;
}

export interface PostReactionDoc {
  _id?: ObjectId;
  postId: ObjectId;
  userId: ObjectId;
  kind: "like" | "save";
  createdAt: Date;
}

export interface PostCommentDoc extends Stamped {
  _id: ObjectId;
  postId: ObjectId;
  authorId: ObjectId;
  text: string;
  status: "live" | "deleted";
  editedAt?: Date | null;
}

export type ReportReason = "spam" | "fake" | "abuse" | "undelivered" | "other";

export interface ReportDoc {
  _id?: ObjectId;
  target: { type: "post"; id: ObjectId };
  userId: ObjectId;
  reason: ReportReason;
  status: "open" | "closed";
  createdAt: Date;
  /** Set when the Ruxstar team decides the post: kept up, or removed. */
  outcome?: "kept" | "removed";
  closedBy?: ObjectId;
  closedAt?: Date;
}

/** One person following another. Open: no request or approval. */
export interface FollowDoc {
  _id?: ObjectId;
  followerId: ObjectId;
  followeeId: ObjectId;
  createdAt: Date;
}

/** The two people stop seeing each other, and neither can follow, comment on or message the other. */
export interface BlockDoc {
  _id?: ObjectId;
  blockerId: ObjectId;
  blockedId: ObjectId;
  createdAt: Date;
}

export type UserReportReason = "spam" | "fake" | "abuse" | "scam" | "other";

/** A report about a person, one open report per reporter and person. Closed when the Ruxstar team decides. */
export interface UserReportDoc {
  _id?: ObjectId;
  userId: ObjectId;
  reporterId: ObjectId;
  reason: UserReportReason;
  note: string | null;
  status: "open" | "closed";
  createdAt: Date;
  outcome?: "dismissed" | "held";
  closedBy?: ObjectId;
  closedAt?: Date;
}

/** A 1:1 chat or a private group. Communities come later. */
export interface ConversationDoc extends Stamped {
  _id: ObjectId;
  kind: "dm" | "group";
  /** 1:1 chats only: both user ids, smaller first, joined by ":". Unique, so two people share one chat. */
  pairKey?: string;
  /** Groups only. */
  title: string | null;
  createdBy: ObjectId;
  /** Everyone in it, including people still deciding on an invite. At most 50. */
  memberIds: ObjectId[];
  /** Groups only. Never empty while anyone is left. */
  adminIds: ObjectId[];
  last: { messageId: ObjectId; senderId: ObjectId; kind: ChatMessageKind; text: string; at: Date } | null;
  /** When the name, people or admins last changed, so an open chat knows to fetch them again. */
  changedAt: Date;
  /** When anything an open chat shows last changed: typing, a reaction, Seen, an unsend. Wakes waiting /updates calls. */
  pulseAt?: Date;
}

/**
 * One person's side of a chat. `request` is a chat or group invite from someone they don't follow; it sits in
 * Requests until accepted. `declined` is a 1:1 request they turned down: hidden from them, and the sender can't send more.
 */
export interface ChatMemberDoc {
  _id?: ObjectId;
  conversationId: ObjectId;
  userId: ObjectId;
  kind: "dm" | "group";
  /** 1:1 chats only: the other person, so chats with blocked people can be left out. */
  peerId: ObjectId | null;
  state: "active" | "request" | "declined";
  addedBy: ObjectId;
  /** Groups show messages from here on. */
  joinedAt: Date;
  /** The latest message's time, for sorting the chat list. Null until the first message. */
  lastAt: Date | null;
  unread: number;
  /** When they last read the chat. In 1:1 chats this is the other person's "Seen". */
  readAt: Date | null;
  /** Muted chats don't count toward the unread badge. */
  muted: boolean;
  /** When they last sent something. Until the other person accepts a 1:1 request, the sender gets one message. */
  sentAt: Date | null;
  /** Shown as typing… to the others until then. Refreshed every few seconds while they type. */
  typingUntil?: Date | null;
}

export type ChatMessageKind = "text" | "post" | "photo" | "voice" | "event" | "quote";

/** One per person: reacting again swaps it. */
export interface ChatReaction {
  userId: ObjectId;
  emoji: string;
  at: Date;
}

/** Kept until the sender unsends it or deletes their account. */
export interface ChatMessageDoc {
  _id: ObjectId;
  conversationId: ObjectId;
  senderId: ObjectId;
  /** `event` is a line the group shows, like "Asha added Ravi", written when it happened. */
  kind: ChatMessageKind;
  text: string;
  /** A shared post. */
  postId: ObjectId | null;
  /** In the private chat bucket; only the API reads it. */
  photo: { key: string; width: number; height: number } | null;
  /** An AAC voice message in MP4, in the private chat bucket. `levels` are 0-100 loudness bars for its waveform. */
  voice?: { key: string; durationMs: number; levels: number[] } | null;
  /** The message this one answers. */
  replyToId?: ObjectId | null;
  /** A freelancer's custom offer, in `gig_quotes`. */
  quoteId?: ObjectId | null;
  reactions?: ChatReaction[];
  /** When its reactions or its offer last changed, so open chats pick that up. */
  touchedAt?: Date;
  status: "live" | "unsent";
  createdAt: Date;
  unsentAt: Date | null;
}

export type NotificationType =
  | "user.followed"
  | "post.like"
  | "post.comment"
  | "post.removed"
  | "post.mention"
  | "report.resolved"
  | "kyc.approved"
  | "kyc.rejected"
  | "business.suspended"
  | "business.restored"
  | "order.placed"
  | "order.updated"
  | "payout.updated"
  | "team.invited"
  | "team.joined"
  | "team.ended"
  | "review.posted"
  | "review.replied"
  | "review.removed"
  | "delivery.offer"
  | "delivery.updated"
  | "support.replied"
  | "support.resolved"
  | "kyc.reopened"
  | "event.ticket"
  | "event.updated"
  | "coaching.enrolled"
  | "coaching.updated"
  | "turf.booked"
  | "turf.updated"
  | "stays.reserved"
  | "stays.updated"
  | "shop.ordered"
  | "shop.updated"
  | "gigs.ordered"
  | "gigs.updated";

export interface NotificationDoc {
  _id: ObjectId;
  userId: ObjectId;
  type: NotificationType;
  /** Who did it; for KYC decisions, the reviewer. */
  actorId: ObjectId;
  title: string;
  body: string;
  /**
   * `verification` opens the KYC screen (its id is the track); `business` opens a business in the vendor portal;
   * `order` opens a customer's print order and `shop_order` the same order in the vendor portal; `profile` opens a person (its id is theirs);
   * `payments` opens the vendor's Payments (its id is the payout); `work` opens the Work area (its id is the place on the team);
   * `team` opens a business's Team in the vendor portal (its id is the business); `reviews` a business's reviews there, and
   * `work_reviews` the same reviews in the Work area (its id is the place on the team). `delivery_job` opens a job in the
   * delivery app. `support` opens one of your help tickets. `event` opens an event's page, `event_order` a customer's tickets
   * for one (its id is the ticket order), and `vendor_event` an event in the vendor portal. `coaching_course` opens a course's
   * page, `coaching_order` a customer's enrolment or demo class, `vendor_course` a course in the vendor portal, and
   * `coaching_batch` a batch's classes for its owner or coaches. `turf_ground` opens a ground's page, `turf_order` a customer's
   * booking, and `vendor_ground` a ground's board for its owner or team. `stay_property` opens a PG or hostel's page,
   * `stay_order` a customer's reservation, and `vendor_property` a property's bed board for its owner or team. `store` opens a
   * local shop's page, `store_product` one of its products, `store_order` a customer's order, and `vendor_store_order` the same
   * order at the shop's desk. `gig` opens a gig's page, `gig_order` a customer's freelance order, `vendor_gig_order` the same
   * order for the freelancer, `freelance` the freelancer's own Freelancing home (its id is the business),
   * `freelance_payments` Payments in Freelancing for someone whose only businesses are freelancer ones (its id is the payout),
   * and `chat` a chat (a custom offer in it).
   */
  link: {
    screen:
      | "post"
      | "verification"
      | "business"
      | "order"
      | "shop_order"
      | "profile"
      | "payments"
      | "work"
      | "team"
      | "work_order"
      | "reviews"
      | "work_reviews"
      | "delivery_job"
      | "delivery_earnings"
      | "support"
      | "event"
      | "event_order"
      | "vendor_event"
      | "coaching_course"
      | "coaching_order"
      | "vendor_course"
      | "coaching_batch"
      | "turf_ground"
      | "turf_order"
      | "vendor_ground"
      | "stay_property"
      | "stay_order"
      | "vendor_property"
      | "store"
      | "store_product"
      | "store_order"
      | "vendor_store_order"
      | "gig"
      | "gig_order"
      | "vendor_gig_order"
      | "freelance"
      | "freelance_payments";
    id: string;
  };
  readAt: Date | null;
  createdAt: Date;
}

export interface SessionDoc extends Stamped {
  _id: ObjectId;
  userId: ObjectId;
  client: "web" | "app" | "delivery";
  deviceId?: string | null;
  /** A readable device name, for example "Chrome on Windows". */
  label?: string;
  refreshTokenHash?: string;
  /** The hash before the last rotation. Seeing it again means the token was stolen. */
  prevRefreshTokenHash?: string | null;
  rotatedAt?: Date | null;
  pushToken?: string | null;
  appVersion?: string | null;
  lastSeenAt?: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** `email` codes go to the user's email; their target is `<userId>:<email>`. */
export type OtpPurpose = "signup" | "reset" | "login" | "email";

export interface OtpDoc {
  _id: ObjectId;
  target: string;
  purpose: OtpPurpose;
  codeHash: string;
  attempts: number;
  resends: number;
  lastSentAt: Date;
  lockedUntil: Date | null;
  /** Set once the code is right; the matching verification token can be used once. */
  verifiedJti: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface ModuleSettingsDoc extends Stamped {
  _id: ObjectId;
  module: SwitchableModule;
  live: boolean;
  signupsOpen: boolean;
  commissionBps: number;
  /** Paise the customer pays Ruxstar on each order, on top of the vendor's prices. Missing on older documents: 0. */
  platformFee?: number;
  /**
   * In paise: taken from each withdrawal, and the least that can be withdrawn. On the ledger module for vendors, on the
   * delivery module for Ruxstar partners. Missing: the defaults.
   */
  payoutFee?: number;
  minPayout?: number;
  /** Business modules: publishing needs a verified GSTIN. Missing: not needed. */
  gstinRequired?: boolean;
  /** The delivery module only. Missing: the defaults in the delivery module. */
  riderRate?: DeliveryFee;
  shopFeeMax?: { base: number; perKm: number };
  offerMinutes?: number;
  /** The events module only. Missing: the defaults in the events module. */
  eventRules?: EventRules;
  /** The coaching module only. Missing: the defaults in the coaching module. */
  coachingRules?: CoachingRules;
  /** The turf module only. Missing: the defaults in the turf module. */
  turfRules?: TurfRules;
  /** The stays module only. Missing: the defaults in the stays module. */
  staysRules?: StaysRules;
  /** The shop module only. Missing: the defaults in the shop module. */
  shopRules?: ShopRules;
  /** The freelancers module only. Missing: the defaults in the gigs module. */
  gigsRules?: GigsRules;
  deliveryEnabled: boolean;
  permissionCatalog: string[];
  updatedBy: ObjectId | null;
}

/** What Ruxstar sets for every event. */
export interface EventRules {
  /** Customers can cancel for a full refund until this many hours before the start, unless the organiser chose no refunds. */
  refundHours: number;
  /** Seats offered to the next person on a waitlist are held for them this long. */
  waitlistHours: number;
  /** Ticket types per event. */
  maxTicketTypes: number;
  /** Questions an organiser can ask each ticket holder. */
  maxQuestions: number;
}

/** What Ruxstar sets for coaching. */
export interface CoachingRules {
  /** The share of classes a student must attend for a certificate, until a course sets its own. */
  certificatePercent: number;
  /** A batch short of its minimum this many hours before its first class is cancelled and refunded. */
  minimumHours: number;
  maxBatchSize: number;
  /** Classes in one batch, extra ones included. */
  maxClasses: number;
  /** Batches running or to come in one course. */
  maxBatches: number;
  /** Paise, the most a demo class can cost. */
  maxDemoFee: number;
  /** Demo students in one class. */
  maxDemoSeats: number;
  /** An online class's link shows this many minutes before it starts. */
  joinMinutes: number;
}

/** What Ruxstar sets for sports grounds. Owners pick each ground's refund hours within the limits. */
export interface TurfRules {
  /** New grounds start with these: a full refund this many hours or more before the slot, `halfPercent` from `refundHalfHours`. */
  refundFullHours: number;
  refundHalfHours: number;
  /** The share refunded in the middle tier. */
  halfPercent: number;
  /** An owner's full-refund hours stay between these. */
  minFullHours: number;
  maxFullHours: number;
  /** A weekly repeat books this many weeks at most, the first included. */
  maxRepeatWeeks: number;
  /** Unpaid slots are held this long for the checkout. */
  holdMinutes: number;
  /** Slot lengths a court can use, in minutes. */
  slotLengths: number[];
  /** Back-to-back slots in one booking. */
  maxSlots: number;
  /** How far ahead the first slot can be, in days. */
  bookAheadDays: number;
  maxGrounds: number;
  maxCourts: number;
  maxAddOns: number;
}

/** What Ruxstar sets for PG and hostel stays. Owners can only make the refund rule stricter. */
export interface StaysRules {
  /** A customer cancelling at least this many days before move-in gets everything back, unless the property is stricter. */
  refundDays: number;
  /** The most days a property's stricter rule can ask for. */
  maxRefundDays: number;
  /** After the owner marks "Moved in", the tenant can object for this long; the owner's money waits until then. */
  objectionHours: number;
  /** PG: months paid up front with a reservation, the first included. */
  maxMonths: number;
  /** Hostel: nights in one reservation. */
  maxNights: number;
  /** Unpaid reservations hold their beds this long for the checkout. */
  holdMinutes: number;
  /** How far ahead move-in can be, in days. */
  bookAheadDays: number;
  maxProperties: number;
  maxRooms: number;
  /** Beds in one room. */
  maxBeds: number;
}

/** What Ruxstar sets for local shops. */
export interface ShopRules {
  /** Shops that take returns take them for this many days after delivery. */
  returnDays: number;
  /** Option dimensions on one product, such as size and colour. */
  maxOptions: number;
  /** The shop's money is released this long after delivery, or when the return window ends if that is later. */
  releaseHours: number;
  /** An unpaid order's checkout link works this long. Stock is only taken when it's paid. */
  holdMinutes: number;
  /** A paid order the shop hasn't accepted in this long is cancelled and refunded. */
  acceptHours: number;
  maxProducts: number;
  /** Variants (option combinations) on one product. */
  maxVariants: number;
  /** Values of one option. */
  maxValues: number;
  /** Lines in one order. */
  maxLines: number;
  /** Of one variant in one order. */
  maxQuantity: number;
}

/** One kind of freelance work. Keys never change once made; hidden ones take no new gigs. */
export interface GigCategory {
  key: string;
  label: string;
  hidden: boolean;
}

/** What Ruxstar sets for freelancers. Prices are paise. */
export interface GigsRules {
  /** A delivered order the customer doesn't answer is completed this many days later. */
  autoCompleteDays: number;
  /** A paid order the freelancer hasn't accepted in this long is cancelled and fully refunded. */
  acceptHours: number;
  /** A custom offer in a chat can be paid for this many days. */
  quoteDays: number;
  /** The most one delivery, or a customer's files with an order, can add up to. Never above 25. */
  deliveryMaxMb: number;
  /** Delivered files are deleted this many days after the order ends; the order and messages stay. */
  fileDays: number;
  maxGigs: number;
  maxPackages: number;
  minPrice: number;
  maxPrice: number;
  minDays: number;
  maxDays: number;
  maxRevisions: number;
  /** Photos and links on a profile's portfolio, together. */
  maxPortfolio: number;
  maxGigPhotos: number;
  /** Questions on one gig. */
  maxQuestions: number;
  /** Files on one order's brief or one delivery. */
  maxFiles: number;
  /** Links in one delivery. */
  maxLinks: number;
  /** Characters in one answer to a gig's question. */
  maxAnswer: number;
  /** Extensions that can be uploaded, each one the gigs module knows how to serve. */
  fileTypes: string[];
  categories: GigCategory[];
}

/** A file a customer uploaded to print. Unused ones are deleted a day later, on the uploader's next upload. */
export interface PrintFileDoc {
  _id: ObjectId;
  userId: ObjectId;
  key: string;
  /** As the customer named it, for the shop. */
  name: string;
  contentType: "application/pdf" | "image/jpeg" | "image/png";
  bytes: number;
  /** PDF pages; 1 for a photo. */
  pages: number;
  orderId: ObjectId | null;
  createdAt: Date;
}

export type PodOrderStatus =
  | "awaiting_payment"
  | "placed"
  | "accepted"
  | "printing"
  | "ready"
  | "out_for_delivery"
  | "delivered"
  | "rejected"
  | "cancelled"
  | "refunded";

/** Money sent back to the customer. Partial ones come out of the shop's share; a full one undoes the whole order. */
export interface PodRefundDoc {
  refundId: string;
  amount: number;
  kind: "full" | "partial";
  reason: string | null;
  by: "customer" | "vendor" | "staff" | "system";
  status: "pending" | "done";
  at: Date;
}

export type PodProblemKind = "not_received" | "wrong_item" | "poor_quality" | "damaged" | "other";

export interface PodProblemDoc {
  kind: PodProblemKind;
  note: string;
  /** Re-encoded JPEGs in the print files bucket, under `problems/<orderId>/`. */
  photos: { id: ObjectId; key: string; bytes: number }[];
  status: "open" | "resolved";
  reportedAt: Date;
  resolution: { outcome: "refunded" | "partial" | "dismissed"; amount: number; note: string; by: ObjectId; at: Date } | null;
}

export interface PodOrderDoc extends Stamped {
  _id: ObjectId;
  /** Readable, for example 1042. */
  orderNo: number;
  customerId: ObjectId;
  shopId: ObjectId;
  vendorId: ObjectId;
  shopName: string;
  product: PodProduct;
  productLabel: string;
  pricing: "per_unit" | "per_page";
  /** Option name to the value picked, for example size: "XL". */
  options: Record<string, string>;
  /** Documents only. */
  colour: "bw" | "color" | null;
  /** Units, or copies of the files for documents. */
  quantity: number;
  files: { id: ObjectId; key: string; name: string; contentType: PrintFileDoc["contentType"]; bytes: number; pages: number }[];
  /** Paise. `units` is pieces, or pages times copies for documents. */
  price: {
    units: number;
    unitPrice: number;
    extrasPerUnit: number;
    items: number;
    platformFee: number;
    /** Taken off `items` by the coupon. Missing on older orders: 0. */
    discount?: number;
    coupon?: { id: ObjectId; code: string; fundedBy: CouponDoc["fundedBy"] } | null;
    /** The shop's delivery fee; part of its share, with no commission on it. Missing on older orders: 0. */
    delivery?: number;
    /** From the shop to the customer, rounded up, when both are on the map. */
    deliveryKm?: number | null;
    /** `items` less the discount, plus delivery and the platform fee. */
    total: number;
    commissionBps: number;
    /** On `items`, or on `items` less the discount when the vendor pays for the coupon. */
    commission: number;
  };
  /** `point` from "Use my location", or found from the typed address; null when neither worked. */
  address: { name: string; phone: string; line: string; city: string; pincode: string; point?: { lat: number; lng: number } | null };
  /** Who is taking it to the customer, when not the shop itself (decision 57). Kept after a job is cancelled, until the next one. */
  delivery?: OrderDelivery | null;
  note: string | null;
  status: PodOrderStatus;
  timeline: { status: PodOrderStatus; at: Date; by: "customer" | "vendor" | "system" | "staff" }[];
  payment: { gatewayOrderId: string; sessionId: string; paymentId: string | null; paidAt: Date | null };
  /** Before 13 Nov 2026 an order held at most one full refund here; `refunds` replaced it. Read through `refundsOf`. */
  refund?: { refundId: string; amount: number; status: "pending" | "done"; at: Date } | null;
  refunds?: PodRefundDoc[];
  /** Why the shop turned it down, or why Ruxstar cancelled it. */
  reason: string | null;
  /** The product's "ready in" days when it was ordered. Missing on older orders. */
  turnaroundDays?: number;
  /** Cancelled with a full refund if the shop hasn't accepted by then. */
  acceptBy?: Date | null;
  acceptedAt?: Date | null;
  /** Accepted plus the ready-in days. Seven days after it, an order not marked delivered counts as delivered. */
  readyBy?: Date | null;
  deliveredAt?: Date | null;
  /** The shop's share becomes available then, unless a problem is open. */
  releaseAt?: Date | null;
  releasedAt?: Date | null;
  /** Ruxstar released the share before its hold was over. */
  earlyRelease?: { by: ObjectId; reason: string; at: Date } | null;
  problem?: PodProblemDoc | null;
  /** When the problem was reported; top level so the console can page by it. */
  problemAt?: Date | null;
  /** The GST documents issued for it, oldest first. Missing before 15 Nov 2026. */
  invoices?: InvoiceRefDoc[];
}

export type DeliveryJobStatus = "offered" | "accepted" | "picked_up" | "delivered" | "cancelled";

export interface OrderDelivery {
  jobId: ObjectId;
  carrier: "team" | "partner";
  status: DeliveryJobStatus;
  rider: { id: ObjectId; name: string; phone: string; avatar: string | null; vehicle: { type: VehicleType; number: string } } | null;
  /** Paise to a Ruxstar partner, out of the shop's share; 0 for the shop's own team. */
  pay: number;
  /** Set once the partner's pay moved to them, at delivery: pending until `releaseAt`. */
  paidAt: Date | null;
  /**
   * 48 hours after delivery the pay becomes withdrawable, unless a "not received" problem is open. Missing on deliveries
   * before 14 Nov 2026, whose pay was withdrawable at once.
   */
  releaseAt?: Date | null;
  releasedAt?: Date | null;
  /** Shown to the customer only, who gives it to the rider at the door. */
  dropCode: string;
  offerUntil: Date | null;
}

/**
 * One trip from a shop to a customer (decision 57). A team job is offered to one member with "Deliver orders"; a partner job to every
 * online Ruxstar partner in the shop's city, and the first to accept gets it. Cancelled ones stay for the history.
 */
export interface DeliveryJobDoc extends Stamped {
  _id: ObjectId;
  /** A local shop's order in `shop_orders`; missing for print orders. */
  orderType?: "shop_order";
  orderId: ObjectId;
  orderNo: number;
  shopId: ObjectId;
  vendorId: ObjectId;
  carrier: "team" | "partner";
  /** Lower case, for partner offers. */
  city: string;
  /** The team member it was offered to, or the partner who accepted it. */
  riderId: ObjectId | null;
  /** The team place, for team jobs. */
  placeId: ObjectId | null;
  status: DeliveryJobStatus;
  /** A partner offer nobody accepts by then is cancelled and the shop told. */
  offerUntil: Date | null;
  pickup: { name: string; phone: string; line: string; city: string; point: { lat: number; lng: number } | null };
  drop: { name: string; phone: string; line: string; city: string; pincode: string; point: { lat: number; lng: number } | null };
  item: string;
  /** Pieces to carry: a print order's quantity, or every unit across a shop order's lines. Missing on jobs from before 15 Nov 2026. */
  itemCount?: number;
  distanceKm: number | null;
  pay: number;
  /** The customer reads it out at the door. */
  dropCode: string;
  proof: { key: string; bytes: number; at: Date } | null;
  /** Partners who passed on the offer, so it stops showing to them. */
  passedBy: ObjectId[];
  /** Set while accepted or picked up, so a rider has one trip at a time. */
  busy?: true;
  /** Wrong drop codes tried; after five the rider calls the customer or hands it back. */
  codeTries: number;
  cancel: { by: "rider" | "shop" | "system" | "staff"; reason: string; at: Date } | null;
  timeline: { status: DeliveryJobStatus; at: Date }[];
}

/** The road between two stops of a delivery, for the rider's map, kept so the router isn't asked on every location update. */
export interface DeliveryRouteDoc {
  /** `<jobId>:shop-drop`, or `<jobId>:here-<shop|drop>:<cell>` for the way from the rider's ~150 m grid cell. */
  _id: string;
  jobId: ObjectId;
  /** [lat, lng] pairs. */
  polyline: [number, number][];
  distanceM: number;
  durationS: number;
  provider: "google" | "osrm" | "straight";
  createdAt: Date;
  /** Deleted by a TTL index: road routes after a day, straight-line stand-ins sooner so the router is tried again. */
  expiresAt: Date;
}

/** A delivery partner's working state; one per partner, made the first time they go online. */
export interface RiderStateDoc {
  _id: ObjectId;
  online: boolean;
  /** Lower case. */
  city: string | null;
  point: { lat: number; lng: number } | null;
  updatedAt: Date;
}

/**
 * One side of a money movement. Every `txnId`'s entries sum to zero. Accounts are `gateway` (money held at
 * Cashfree), `ruxstar` (commission and fees), `vendor:<userId>` and `rider:<userId>`. `pending` becomes `withdrawable` 48 hours after delivery.
 */
export interface LedgerEntryDoc {
  _id?: ObjectId;
  txnId: string;
  /**
   * `payout` takes a withdrawal out of the vendor's available balance; `payout_return` puts a failed one back. `rider_pay` moves a
   * Ruxstar partner's pay out of the shop's pending share at delivery.
   */
  kind: "payment" | "refund" | "release" | "payout" | "payout_return" | "rider_pay" | "rider_release";
  accountId: string;
  bucket: "pending" | "withdrawable";
  signedPaise: number;
  source: { type: "pod_order" | "event_order" | "coaching_order" | "turf_booking" | "stay_reservation" | "shop_order" | "gig_order" | "payout"; id: ObjectId };
  at: Date;
}

/** `show`: concerts and live shows; `sports`: matches and tournaments; `meetup`: workshops, talks and meetups. */
export type EventKind = "show" | "sports" | "meetup";

export interface EventTierDoc {
  id: string;
  name: string;
  /** Paise, per person; per team for team entries. 0 is free. */
  price: number;
  /** People, or teams for team entries. */
  capacity: number;
  /** Not sold, not waiting for payment and not held for someone on the waitlist. */
  left: number;
}

/**
 * One event from an events business. Customers buy tickets once it is live; each person gets their own ticket with a QR code,
 * and a team entry gives every player one. Online events have a link instead of a venue and nothing to scan.
 */
export interface EventDoc extends Stamped {
  _id: ObjectId;
  businessId: ObjectId;
  vendorId: ObjectId;
  businessName: string;
  title: string;
  description: string | null;
  kind: EventKind;
  venue: { name: string; address: string; city: string; point: { lat: number; lng: number } | null } | null;
  /** Shown only to people with a ticket. */
  online: { link: string } | null;
  /** Lower case, for the city filter; null for online events. */
  city: string | null;
  startsAt: Date;
  endsAt: Date;
  /** Team entries: the captain pays once and names between `min` and `max` players. */
  team: { min: number; max: number } | null;
  tiers: EventTierDoc[];
  questions: { id: string; label: string; required: boolean }[];
  /** `standard`: full refund until Ruxstar's refund hours before the start. */
  refunds: "standard" | "none";
  photo: BusinessPhoto | null;
  status: "draft" | "live" | "cancelled";
  publishedAt: Date | null;
  cancellation: { by: "vendor" | "staff"; actorId: ObjectId; reason: string; at: Date } | null;
}

export type EventOrderStatus = "awaiting_payment" | "confirmed" | "cancelled";

/** One checkout: tickets of one or more types for one event. Free orders are confirmed at once. */
export interface EventOrderDoc extends Stamped {
  _id: ObjectId;
  orderNo: number;
  eventId: ObjectId;
  businessId: ObjectId;
  vendorId: ObjectId;
  customerId: ObjectId;
  eventTitle: string;
  businessName: string;
  startsAt: Date;
  endsAt: Date;
  lines: { tierId: string; name: string; quantity: number; unitPrice: number }[];
  team: { name: string } | null;
  price: {
    items: number;
    platformFee: number;
    total: number;
    commissionBps: number;
    commission: number;
    /** Missing before event coupons (15 Nov 2026). */
    discount?: number;
    coupon?: { id: ObjectId; code: string; fundedBy: "ruxstar" | "vendor" } | null;
  };
  status: EventOrderStatus;
  timeline: { status: EventOrderStatus; at: Date; by: "customer" | "vendor" | "staff" | "system" }[];
  /** Null on free orders. */
  payment: { gatewayOrderId: string; sessionId: string; paymentId: string | null; paidAt: Date | null } | null;
  /** Unpaid orders give their seats back after this. */
  holdUntil: Date | null;
  /** The waitlist offer it was bought from. */
  waitlistId: ObjectId | null;
  refund: { refundId: string; amount: number; reason: string | null; by: "customer" | "vendor" | "staff" | "system"; status: "pending" | "done"; at: Date } | null;
  reason: string | null;
  /** The organiser's share becomes available when the event ends. */
  releaseAt: Date | null;
  releasedAt: Date | null;
  /** The GST documents issued for it, oldest first. Missing before 15 Nov 2026. */
  invoices?: InvoiceRefDoc[];
}

export type InvoiceKind = "tax_invoice" | "bill_of_supply" | "credit_note";
/** Modules with GST rules. `turf` and `ecommerce` have defaults ready for when they are built. */
export type GstModule = "pod" | "events" | "coaching" | "stays" | "turf" | "ecommerce" | "gigs";

/** A rate for one module, or for one product or kind of business in it. Units priced at or below `lowRate.upTo` use its rate. */
export interface GstRate {
  code: string;
  codeKind: "hsn" | "sac";
  rateBps: number;
  lowRate: { upTo: number; rateBps: number } | null;
}

/** What Ruxstar sets for GST in one module (decision A8). Missing fields use the defaults in the invoices module. */
export interface GstRules extends GstRate {
  enabled: boolean;
  /** `vendor`: the vendor sells and Ruxstar is the e-commerce operator. `ruxstar`: Ruxstar invoices the sale itself. */
  seller: "vendor" | "ruxstar";
  /** A vendor without a GSTIN: they issue a bill of supply, or Ruxstar issues the invoice and pays the tax (section 9(5)). */
  withoutGstin: "bill_of_supply" | "ruxstar";
  pricesIncludeTax: boolean;
  /** Tax the operator collects at source on a registered vendor's sales. */
  tcsBps: number;
  items: (GstRate & { key: string; label: string })[];
}

/** Ruxstar's own details, printed on its invoices and as the operator on vendors'. */
export interface GstSeller {
  legalName: string;
  tradeName: string;
  gstin: string | null;
  address: { line: string; city: string; state: string; pincode: string } | null;
  /** The platform fee's SAC and rate. */
  feeCode: string;
  feeRateBps: number;
}

export interface InvoiceParty {
  name: string;
  legalName: string | null;
  gstin: string | null;
  address: string | null;
  state: string | null;
  /** The two-digit GST state code. */
  stateCode: string | null;
}

export interface InvoiceLineDoc {
  description: string;
  code: string;
  codeKind: "hsn" | "sac";
  quantity: number;
  /** Paise per unit, as charged. */
  unitPrice: number;
  /** Paise off the line by the seller, such as their coupon. */
  discount: number;
  rateBps: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  /** Taxable value plus tax. */
  total: number;
}

/**
 * A GST document, numbered once and never changed afterwards except `credited`. Everything printed on it is copied in when it
 * is issued, so later changes to settings, businesses or names never alter it.
 */
export interface InvoiceDoc extends Stamped {
  _id: ObjectId;
  /** One document per order part, or per refund and invoice: `pod_order:<id>:supply`, `credit:<invoice>:<refund>`. */
  key: string;
  kind: InvoiceKind;
  /** Up to 16 characters, consecutive within `series`. */
  number: string;
  /** The counter it was numbered from: one per seller, document type and Indian financial year. */
  series: string;
  /** For example 2026-27. */
  fy: string;
  issuer: "vendor" | "ruxstar";
  /** `supply`: what was bought; `fee`: Ruxstar's platform fee. */
  role: "supply" | "fee";
  module: GstModule;
  source: { type: "pod_order" | "event_order" | "coaching_order" | "turf_booking" | "stay_reservation" | "shop_order" | "gig_order"; id: ObjectId; orderNo: number };
  businessId: ObjectId;
  businessName: string;
  vendorId: ObjectId;
  customerId: ObjectId;
  seller: InvoiceParty;
  buyer: InvoiceParty;
  /** Ruxstar as the e-commerce operator, on documents a vendor issues. */
  operator: { name: string; gstin: string | null } | null;
  placeOfSupply: { state: string; code: string } | null;
  supply: "intra" | "inter";
  /** Ruxstar pays the tax as the operator on a vendor's sale (section 9(5)). */
  operatorPays: boolean;
  lines: InvoiceLineDoc[];
  totals: { taxable: number; cgst: number; sgst: number; igst: number; tax: number; total: number; ruxstarDiscount: number; payable: number };
  tcs: { rateBps: number; amount: number } | null;
  /** Credit notes: the invoice they reduce, and the refund behind them. */
  against: { id: ObjectId; number: string; issuedAt: Date } | null;
  refund: { id: string; reason: string | null } | null;
  /** Invoices: paise credited back so far. */
  credited: number;
  notes: string[];
  issuedAt: Date;
}

/** What an order keeps about each of its GST documents. */
export interface InvoiceRefDoc {
  id: ObjectId;
  kind: InvoiceKind;
  number: string;
  issuer: "vendor" | "ruxstar";
  role: "supply" | "fee";
  total: number;
  refundId: string | null;
  issuedAt: Date;
}

/** One person's entry. The QR code holds a signed token; only its SHA-256 is stored, and is what scanners check offline. */
export interface EventTicketDoc {
  _id: ObjectId;
  orderId: ObjectId;
  eventId: ObjectId;
  businessId: ObjectId;
  customerId: ObjectId;
  tierId: string;
  tierName: string;
  holder: { name: string; phone: string | null };
  answers: { id: string; label: string; answer: string }[];
  team: string | null;
  /** Six letters, unique in the event, for looking a ticket up by hand. */
  code: string;
  hash: string;
  status: "awaiting_payment" | "valid" | "cancelled";
  /** One a day; `day` is the date in India. */
  checkIns: { day: string; at: Date; by: ObjectId; manual: boolean; offline: boolean }[];
  /** Scanned in on two phones while they were offline; the later one is kept here for the organiser. */
  clashes: { day: string; at: Date; by: ObjectId }[];
  createdAt: Date;
  updatedAt: Date;
}

/** First come, first served for one ticket type. An offer holds the seats until `offeredUntil`. */
export interface EventWaitDoc {
  _id: ObjectId;
  eventId: ObjectId;
  tierId: string;
  customerId: ObjectId;
  quantity: number;
  status: "waiting" | "offered" | "booked" | "expired" | "left" | "closed";
  /** Set while waiting or offered, so a person has one place per ticket type. */
  open?: true;
  offeredUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CourseCategory = "tuition" | "exam_prep" | "music" | "dance" | "sports" | "fitness" | "art" | "languages" | "tech" | "other";

/** A course from a coaching business: taught at its venue or online live, in one or more batches. */
export interface CoachingCourseDoc extends Stamped {
  _id: ObjectId;
  businessId: ObjectId;
  vendorId: ObjectId;
  businessName: string;
  title: string;
  description: string | null;
  category: CourseCategory;
  mode: "offline" | "online";
  /** Offline courses only. */
  venue: { name: string; address: string; city: string; point: { lat: number; lng: number } | null } | null;
  /** Lower case, for the city filter; null for online courses. */
  city: string | null;
  /** One demo class per student per course, in any upcoming class with a demo place. A fee of 0 is free. */
  demo: { fee: number; seats: number } | null;
  /** The share of held classes a student must attend for the certificate. */
  certificatePercent: number;
  photo: BusinessPhoto | null;
  /** `removed`: taken down by the Ruxstar team. */
  status: "draft" | "live" | "removed";
  publishedAt: Date | null;
  removal: { actorId: ObjectId; reason: string; at: Date } | null;
}

/** A weekly class time. `day` is 0 for Sunday to 6 for Saturday; `start` is HH:MM in India. */
export interface CoachingSlot {
  day: number;
  start: string;
  minutes: number;
}

/** One group of students on a weekly schedule. The full fee is paid up front. */
export interface CoachingBatchDoc extends Stamped {
  _id: ObjectId;
  courseId: ObjectId;
  businessId: ObjectId;
  vendorId: ObjectId;
  name: string;
  /** Paise for the whole batch. */
  fee: number;
  capacity: number;
  /** Not taken by a paid enrolment or one waiting for payment. */
  seatsLeft: number;
  /** Cancelled with full refunds when fewer have enrolled `minimumHours` before the first class. */
  minStudents: number | null;
  /** Set once the minimum was checked, whatever the answer. */
  minimumCheckedAt: Date | null;
  slots: CoachingSlot[];
  /** YYYY-MM-DD in India. Classes run from here for `classes` classes, or until `endDate`. */
  startDate: string;
  classes: number | null;
  endDate: string | null;
  /** Online courses: the meeting link, shown to enrolled students shortly before each class. */
  onlineLink: string | null;
  /** Team members who teach it. */
  coachIds: ObjectId[];
  /** The first and last classes not cancelled, kept up to date as classes move. */
  firstAt: Date;
  firstEndsAt: Date;
  lastEndsAt: Date;
  status: "live" | "cancelled";
  cancellation: { by: "vendor" | "staff" | "system"; actorId: ObjectId | null; reason: string; at: Date } | null;
  /** When certificates were issued, after the last class. */
  certificatesAt: Date | null;
}

/** One class of a batch. Cancelled classes stay, so students see what happened. */
export interface CoachingSessionDoc extends Stamped {
  _id: ObjectId;
  batchId: ObjectId;
  courseId: ObjectId;
  businessId: ObjectId;
  startsAt: Date;
  endsAt: Date;
  status: "scheduled" | "cancelled";
  /** Added by hand, beyond the weekly schedule. */
  extra: boolean;
  /** Where it was before it was first moved. */
  movedFrom: { startsAt: Date; endsAt: Date } | null;
  cancellation: { by: ObjectId; reason: string; at: Date } | null;
  /** Demo students booked into it, paid or waiting for payment. */
  demos: number;
  markedAt: Date | null;
}

export type CoachingOrderStatus = "awaiting_payment" | "confirmed" | "cancelled";

/**
 * One student's place: a batch enrolment, or a demo class. The first class it covers sets both rules: a full refund until it
 * starts, and the institute's share released once it ends.
 */
export interface CoachingOrderDoc extends Stamped {
  _id: ObjectId;
  orderNo: number;
  kind: "batch" | "demo";
  courseId: ObjectId;
  batchId: ObjectId;
  /** Demo classes only. */
  sessionId: ObjectId | null;
  businessId: ObjectId;
  vendorId: ObjectId;
  /** Who pays and sees it: the student, or their parent. */
  customerId: ObjectId;
  student: { childId: ObjectId | null; name: string };
  /** `self:<user>` or `child:<child>`. */
  studentKey: string;
  /** One open place per student: `batch:<batch>:<student>` or `demo:<course>:<student>`. Removed when cancelled. */
  seat?: string;
  courseTitle: string;
  batchName: string;
  businessName: string;
  firstAt: Date;
  firstEndsAt: Date;
  price: {
    items: number;
    platformFee: number;
    total: number;
    commissionBps: number;
    commission: number;
    discount?: number;
    coupon?: { id: ObjectId; code: string; fundedBy: "ruxstar" | "vendor" } | null;
  };
  status: CoachingOrderStatus;
  timeline: { status: CoachingOrderStatus; at: Date; by: "customer" | "vendor" | "staff" | "system" }[];
  payment: { gatewayOrderId: string; sessionId: string; paymentId: string | null; paidAt: Date | null } | null;
  holdUntil: Date | null;
  refund: { refundId: string; amount: number; reason: string | null; by: "customer" | "vendor" | "staff" | "system"; status: "pending" | "done"; at: Date } | null;
  reason: string | null;
  releaseAt: Date | null;
  releasedAt: Date | null;
  invoices?: InvoiceRefDoc[];
}

/** A parent's child, who can be enrolled as a student. */
export interface CoachingChildDoc extends Stamped {
  _id: ObjectId;
  parentId: ObjectId;
  name: string;
  birthYear: number | null;
}

/** Whether a student came to a class. One per class and enrolment or demo. */
export interface CoachingAttendanceDoc {
  _id: ObjectId;
  sessionId: ObjectId;
  batchId: ObjectId;
  orderId: ObjectId;
  present: boolean;
  by: ObjectId;
  at: Date;
}

/** A file or link for a batch's students, or every batch of the course. Files are in the private files bucket. */
export interface CoachingMaterialDoc {
  _id: ObjectId;
  courseId: ObjectId;
  /** Null: every batch of the course. */
  batchId: ObjectId | null;
  businessId: ObjectId;
  title: string;
  kind: "file" | "link";
  file: { key: string; name: string; contentType: "application/pdf" | "image/jpeg" | "image/png"; bytes: number } | null;
  url: string | null;
  addedBy: ObjectId;
  createdAt: Date;
}

/** A message from the institute to everyone in a batch. */
export interface CoachingMessageDoc {
  _id: ObjectId;
  batchId: ObjectId;
  courseId: ObjectId;
  authorId: ObjectId;
  authorName: string;
  text: string;
  at: Date;
}

/** Issued once a batch ends, to each student who attended enough of its classes. */
export interface CoachingCertificateDoc {
  _id: ObjectId;
  orderId: ObjectId;
  courseId: ObjectId;
  batchId: ObjectId;
  businessId: ObjectId;
  customerId: ObjectId;
  /** Eight letters printed on it, to check it with the institute. */
  code: string;
  studentName: string;
  courseTitle: string;
  batchName: string;
  businessName: string;
  attended: number;
  classes: number;
  issuedAt: Date;
}

/** A sport grounds can offer. Ruxstar keeps the list; inactive ones stay on courts that have them but can't be picked. */
export interface TurfSportDoc extends Stamped {
  /** Lower case letters and underscores, for example `box_cricket`. Never changes. */
  _id: string;
  name: string;
  active: boolean;
  order: number;
}

export type TurfAmenity =
  | "parking"
  | "washrooms"
  | "changing_rooms"
  | "showers"
  | "drinking_water"
  | "floodlights"
  | "seating"
  | "cafe"
  | "first_aid"
  | "equipment"
  | "lockers"
  | "wifi";

/** A venue of a turf business: one or more courts at one address. Customers book its courts' slots. */
export interface TurfGroundDoc extends Stamped {
  _id: ObjectId;
  businessId: ObjectId;
  vendorId: ObjectId;
  businessName: string;
  name: string;
  description: string | null;
  venue: { address: string; city: string; pincode: string | null; point: { lat: number; lng: number } | null };
  /** The venue's city in lower case, for the listing. */
  city: string;
  amenities: TurfAmenity[];
  photos: BusinessPhoto[];
  /** This ground's refund tiers, within Ruxstar's limits. Each booking keeps the ones it was made under. */
  refunds: { fullHours: number; halfHours: number };
  /** The sports of its live courts, and the lowest base price among them, kept for the listing. */
  sports: string[];
  priceFrom: number | null;
  status: "draft" | "live" | "removed";
  publishedAt: Date | null;
  removal: { actorId: ObjectId; reason: string; at: Date } | null;
}

/** A peak window: these days, these hours, this price per slot. Peak beats the weekend price, which beats the base price. */
export interface TurfPeak {
  days: number[];
  start: string;
  end: string;
  price: number;
}

export interface TurfAddOn {
  id: string;
  name: string;
  price: number;
  /** `booking`: once per booking. `slot`: for each slot booked. */
  per: "booking" | "slot";
}

/** One playing area of a ground: a pitch, a court, a net. Its slots are made from its hours, every `slotMinutes` from opening. */
export interface TurfCourtDoc extends Stamped {
  _id: ObjectId;
  groundId: ObjectId;
  businessId: ObjectId;
  vendorId: ObjectId;
  name: string;
  /** Keys of `turf_sports`. */
  sports: string[];
  slotMinutes: number;
  /** Opening hours per weekday, 0 Sunday … 6 Saturday; a missing day is closed. `close` may be "24:00". */
  hours: { day: number; open: string; close: string }[];
  /** Paise per slot. A null weekend price means the base price on Saturday and Sunday too. */
  prices: { base: number; weekend: number | null; peak: TurfPeak[] };
  addOns: TurfAddOn[];
  /** `paused`: shown on the ground but not bookable. `removed`: deleted by the owner, kept for old bookings. */
  status: "live" | "paused" | "removed";
  order: number;
}

/**
 * One slot of one court that isn't free: held for a checkout, booked, or blocked by the ground. The unique court and start
 * is what stops two people booking the same slot. Free slots have no document.
 */
export interface TurfSlotDoc {
  _id: ObjectId;
  courtId: ObjectId;
  groundId: ObjectId;
  businessId: ObjectId;
  startAt: Date;
  endAt: Date;
  status: "held" | "booked" | "blocked";
  bookingId: ObjectId | null;
  /** Held slots: when the checkout gives them back. */
  holdUntil: Date | null;
  /** Blocks: why, and who. */
  note: string | null;
  by: ObjectId | null;
  createdAt: Date;
}

export type TurfBookingStatus = "awaiting_payment" | "confirmed" | "cancelled";
export type TurfActor = "customer" | "vendor" | "staff" | "system";

/** One date of a booking: its back-to-back slots on the court, and its share of the money. */
export interface TurfOccurrenceDoc {
  n: number;
  startAt: Date;
  endAt: Date;
  slots: { startAt: Date; endAt: Date; price: number; peak: boolean }[];
  /** Paise: slots and add-ons, this date's share of the discount and platform fee, what was paid for it, and the split. */
  items: number;
  discount: number;
  platformFee: number;
  paid: number;
  vendorShare: number;
  ruxstarShare: number;
  status: "booked" | "cancelled";
  cancellation: { by: TurfActor; actorId: ObjectId | null; reason: string; percent: number; refund: number; vendorBack: number; at: Date } | null;
  arrival: { status: "arrived" | "no_show"; by: ObjectId; at: Date } | null;
  /** The ground's share of it moved to withdrawable, once it ended. */
  releasedAt: Date | null;
}

/**
 * A booking of back-to-back slots on one court, with add-ons; a weekly repeat books the same slots for more weeks, all paid
 * together. Each date can be cancelled on its own, refunded by the ground's tiers when the customer cancels and in full when
 * the ground or Ruxstar does.
 */
export interface TurfBookingDoc extends Stamped {
  _id: ObjectId;
  orderNo: number;
  groundId: ObjectId;
  courtId: ObjectId;
  businessId: ObjectId;
  vendorId: ObjectId;
  customerId: ObjectId;
  customerName: string;
  groundName: string;
  courtName: string;
  businessName: string;
  sport: string | null;
  slotMinutes: number;
  addOns: (TurfAddOn & { quantity: number })[];
  weeks: number;
  occurrences: TurfOccurrenceDoc[];
  firstAt: Date;
  lastEndsAt: Date;
  price: {
    items: number;
    platformFee: number;
    total: number;
    commissionBps: number;
    commission: number;
    discount?: number;
    coupon?: { id: ObjectId; code: string; fundedBy: "ruxstar" | "vendor" } | null;
  };
  /** The refund tiers when it was booked. */
  refundRule: { fullHours: number; halfHours: number; halfPercent: number };
  status: TurfBookingStatus;
  timeline: { status: TurfBookingStatus; at: Date; by: TurfActor }[];
  payment: { gatewayOrderId: string; sessionId: string; paymentId: string | null; paidAt: Date | null } | null;
  holdUntil: Date | null;
  refunds: { refundId: string; occurrences: number[]; amount: number; reason: string; by: TurfActor; status: "pending" | "done"; at: Date }[];
  reason: string | null;
  /** The end of the next date whose share is still pending; null when none is. */
  releaseAt: Date | null;
  invoices?: InvoiceRefDoc[];
}

/** A facility a PG or hostel can list. Ruxstar keeps the list; inactive ones stay on properties that have them but can't be picked. */
export interface StayFacilityDoc extends Stamped {
  /** Lower case letters and underscores, for example `power_backup`. Never changes. */
  _id: string;
  name: string;
  active: boolean;
  order: number;
}

export type StayKind = "pg" | "hostel" | "coliving";
export type StayFor = "men" | "women" | "any";
export type StayOccupant = "students" | "working";
export type StayMeal = "breakfast" | "lunch" | "dinner";
/** PG and co-living rooms are priced per month, hostel beds per night; a room can offer both. */
export type StayUnit = "month" | "night";
export type StayRoomKind = "private" | "shared";
export type StayRoomFeature = "ac" | "attached_bath" | "balcony" | "furnished" | "window";
export type StayNearbyKind = "college" | "office" | "metro" | "other";

/** A PG, hostel or co-living house of a stays business: rooms with beds at one address. */
export interface StayPropertyDoc extends Stamped {
  _id: ObjectId;
  businessId: ObjectId;
  vendorId: ObjectId;
  businessName: string;
  kind: StayKind;
  name: string;
  description: string | null;
  address: { line: string; area: string | null; city: string; pincode: string | null; point: { lat: number; lng: number } | null };
  /** The city and area in lower case, for search. */
  city: string;
  area: string | null;
  for: StayFor;
  /** Empty: anyone. */
  occupants: StayOccupant[];
  food: { type: "veg" | "non_veg" | "none"; meals: StayMeal[] };
  /** Keys of `stays_facilities`. */
  facilities: string[];
  /** House rules. `curfew` is the latest entry time, "HH:MM", or null for none. */
  rules: { curfew: string | null; guests: boolean; smoking: boolean; alcohol: boolean; pets: boolean; notes: string | null };
  noticeDays: number;
  /** Paid to the owner directly; only shown on the listing. */
  deposit: { amount: number; note: string | null };
  nearby: { kind: StayNearbyKind; name: string; km: number }[];
  photos: BusinessPhoto[];
  /** Full refund until this many days before move-in, within Ruxstar's limits. */
  refundDays: number;
  /** Kept from the live rooms for search: how they're priced, their kinds, and the lowest price per bed of each unit. */
  units: StayUnit[];
  roomKinds: StayRoomKind[];
  priceFrom: { month: number | null; night: number | null };
  status: "draft" | "live" | "removed";
  publishedAt: Date | null;
  removal: { actorId: ObjectId; reason: string; at: Date } | null;
}

/** A room of a property. A shared room's beds are reserved one by one, or all together; a private room is reserved whole. */
export interface StayRoomDoc extends Stamped {
  _id: ObjectId;
  propertyId: ObjectId;
  businessId: ObjectId;
  vendorId: ObjectId;
  name: string;
  kind: StayRoomKind;
  beds: number;
  /** Shared rooms: whether all its beds can be reserved together, at the bed price times the beds. */
  wholeRoom: boolean;
  /** Paise: for each bed in a shared room, for the room when private. Null when the room isn't offered that way. */
  prices: { month: number | null; night: number | null };
  features: StayRoomFeature[];
  /** `paused`: shown but not reservable, the owner marked it full. `removed`: deleted by the owner, kept for old reservations. */
  status: "live" | "paused" | "removed";
  order: number;
}

/** One bed of a room. Every reservation of a bed writes its `seq`, so two at once can't both pass the overlap check. */
export interface StayBedDoc {
  _id: ObjectId;
  roomId: ObjectId;
  propertyId: ObjectId;
  businessId: ObjectId;
  /** A, B, C… in the room. */
  label: string;
  /** `closed`: the owner marked it full or unavailable. `removed`: the room has fewer beds now. */
  status: "open" | "closed" | "removed";
  seq: number;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

export type StayStatus = "awaiting_payment" | "confirmed" | "moved_in" | "moved_out" | "cancelled";
export type StayActor = "customer" | "vendor" | "staff" | "system";

/**
 * A reservation of beds in one room: one bed, or every bed of the room. It pays the first months (PG) or the nights
 * (hostel), and occupies its beds from move-in until `until`; a PG reservation has no end until a notice or move-out sets
 * one. The owner's money waits until they mark "Moved in" and the tenant's objection window passes.
 */
export interface StayReservationDoc extends Stamped {
  _id: ObjectId;
  orderNo: number;
  propertyId: ObjectId;
  roomId: ObjectId;
  bedIds: ObjectId[];
  bedLabels: string[];
  /** Every bed of the room. */
  whole: boolean;
  businessId: ObjectId;
  vendorId: ObjectId;
  customerId: ObjectId;
  customerName: string;
  propertyName: string;
  roomName: string;
  businessName: string;
  kind: StayKind;
  roomKind: StayRoomKind;
  unit: StayUnit;
  /** Months or nights paid for. */
  units: number;
  /** "YYYY-MM-DD". */
  moveIn: string;
  from: Date;
  /** When the beds are free again; null while a PG stay has no end. */
  until: Date | null;
  price: {
    /** Per month or night: for one bed of a shared room, or a private room. */
    unitPrice: number;
    /** Beds charged: every bed of a shared room reserved whole, else 1. `items` is `unitPrice` × `quantity` × `units`. */
    quantity: number;
    items: number;
    platformFee: number;
    total: number;
    commissionBps: number;
    commission: number;
    discount?: number;
    coupon?: { id: ObjectId; code: string; fundedBy: "ruxstar" | "vendor" } | null;
  };
  deposit: { amount: number; note: string | null };
  noticeDays: number;
  /** The refund rule when it was made: full refund until this many days before move-in. */
  refundRule: { days: number };
  /** The tenant's base KYC when they reserved. */
  tenantVerified: boolean;
  status: StayStatus;
  timeline: { status: StayStatus; at: Date; by: StayActor }[];
  payment: { gatewayOrderId: string; sessionId: string; paymentId: string | null; paidAt: Date | null } | null;
  holdUntil: Date | null;
  refund: { refundId: string; amount: number; reason: string | null; by: StayActor; status: "pending" | "done"; at: Date } | null;
  reason: string | null;
  cancellation: { by: StayActor; actorId: ObjectId | null; reason: string; refund: number; at: Date } | null;
  movedIn: { at: Date; by: ObjectId } | null;
  /** The end of the tenant's window to object after "Moved in". */
  objectionUntil: Date | null;
  objection: {
    reason: string;
    at: Date;
    status: "open" | "withdrawn" | "released" | "refunded";
    note: string | null;
    resolvedAt: Date | null;
    resolvedBy: ObjectId | null;
  } | null;
  /** A notice or move-out that set `until`. */
  moveOut: { on: string; kind: "notice" | "move_out"; by: StayActor; actorId: ObjectId | null; at: Date } | null;
  /** When the owner's share moves to withdrawable; null while it waits for "Moved in" or an objection. */
  releaseAt: Date | null;
  releasedAt: Date | null;
  invoices?: InvoiceRefDoc[];
}

/** One combination of a product's option values, such as M and Red, with its own price and stock. */
export interface ShopVariantDoc {
  id: ObjectId;
  /** One value per option, in the options' order; empty for a product without options. */
  values: string[];
  /** Paise, the sale price. */
  price: number;
  /** Paise, the printed MRP; null when not given. At least `price`. */
  mrp: number | null;
  stock: number;
  sku: string | null;
}

/** A product at a local shop. One photo, up to two options and a variant for each combination. Live as soon as it's saved. */
export interface ShopProductDoc extends Stamped {
  _id: ObjectId;
  businessId: ObjectId;
  vendorId: ObjectId;
  businessName: string;
  /** The shop's city, lower case. */
  city: string;
  title: string;
  description: string | null;
  photo: BusinessPhoto | null;
  options: { name: string; values: string[] }[];
  variants: ShopVariantDoc[];
  /** The cheapest variant's price, and its MRP, for lists. */
  priceFrom: number;
  mrpFrom: number | null;
  inStock: boolean;
  /** Overrides the shop module's GST defaults for this product. */
  tax: { hsn: string | null; rateBps: number | null };
  /** `hidden`: the shop took it off sale. `removed`: Ruxstar took it down. */
  status: "live" | "hidden" | "removed";
  removal: { actorId: ObjectId; reason: string; at: Date } | null;
  /** Live reviews of it. Missing before the first. */
  rating?: { count: number; sum: number };
  /** Raised by every change, so an edit made from an old copy can't undo a sale's stock. */
  seq: number;
}

/** A word or phrase products can't use, kept by Ruxstar, with the category it stands for. */
export interface ShopBannedDoc extends Stamped {
  /** Lower case key, such as `tobacco`. */
  _id: string;
  name: string;
  /** Lower case. A product whose title, description or option values contain one is refused. */
  words: string[];
  active: boolean;
}

export type ShopOrderStatus =
  | "awaiting_payment"
  | "paid"
  | "accepted"
  | "packed"
  | "out_for_delivery"
  | "ready_for_pickup"
  | "delivered"
  | "cancelled";
export type ShopActor = "customer" | "vendor" | "staff" | "system" | "rider";

export interface ShopOrderLineDoc {
  id: ObjectId;
  productId: ObjectId;
  variantId: ObjectId;
  title: string;
  options: { name: string; value: string }[];
  photo: string | null;
  sku: string | null;
  unitPrice: number;
  mrp: number | null;
  quantity: number;
  tax: { hsn: string | null; rateBps: number | null };
}

/** Money sent back: everything when the order is cancelled, or the returned items. */
export interface ShopRefundDoc {
  refundId: string;
  kind: "full" | "return";
  amount: number;
  /** What came out of the shop's pending share and Ruxstar's. */
  vendor: number;
  ruxstar: number;
  reason: string | null;
  by: ShopActor;
  status: "pending" | "done";
  at: Date;
}

export type ShopReturnReason = "wrong_item" | "damaged" | "not_as_described" | "changed_mind" | "other";

export interface ShopReturnDoc {
  reason: ShopReturnReason;
  note: string | null;
  lines: { lineId: ObjectId; quantity: number }[];
  /** `requested` and `approved` hold the shop's money until it's received and refunded, or rejected. */
  status: "requested" | "approved" | "rejected" | "refunded";
  /** The shop pays the trip back when it sent the wrong or a damaged item; otherwise the customer, out of the refund. */
  tripPaidBy: "shop" | "customer";
  tripFee: number;
  /** What the customer gets back. */
  amount: number;
  requestedAt: Date;
  decision: { by: ShopActor; actorId: ObjectId | null; note: string | null; at: Date } | null;
  receivedAt: Date | null;
}

/**
 * An order at one local shop: lines of variants, delivered in the shop's city or picked up. Stock is taken when it's paid;
 * if something sold out meanwhile, it's cancelled and refunded at once. The shop's money waits until the later of the return
 * window's end and `releaseHours` after delivery.
 */
export interface ShopOrderDoc extends Stamped {
  _id: ObjectId;
  orderNo: number;
  customerId: ObjectId;
  customerName: string;
  businessId: ObjectId;
  vendorId: ObjectId;
  businessName: string;
  lines: ShopOrderLineDoc[];
  method: "delivery" | "pickup";
  /** Where it goes; null for pickup. */
  address: { name: string; phone: string; line: string; city: string; pincode: string; point: { lat: number; lng: number } | null } | null;
  price: {
    items: number;
    delivery: number;
    deliveryKm: number | null;
    platformFee: number;
    discount: number;
    coupon: { id: ObjectId; code: string; fundedBy: "ruxstar" | "vendor" } | null;
    total: number;
    commissionBps: number;
    commission: number;
  };
  /** Days to return after delivery, as the shop and Ruxstar had them when it was ordered; null for "No returns". */
  returnRule: { days: number } | null;
  note: string | null;
  status: ShopOrderStatus;
  timeline: { status: ShopOrderStatus; at: Date; by: ShopActor }[];
  payment: { gatewayOrderId: string; sessionId: string; paymentId: string | null; paidAt: Date | null };
  /** The checkout link works until then. */
  holdUntil: Date | null;
  /** Taken from the variants when it was paid, and put back if it's cancelled. */
  stockTaken: boolean;
  /** Cancelled and refunded if the shop hasn't accepted by then. */
  acceptBy: Date | null;
  /** A Ruxstar partner's or team member's trip, when the shop doesn't deliver it itself. */
  delivery?: OrderDelivery | null;
  deliveredAt: Date | null;
  returnUntil: Date | null;
  return: ShopReturnDoc | null;
  refunds: ShopRefundDoc[];
  cancellation: { by: ShopActor; actorId: ObjectId | null; reason: string; at: Date } | null;
  releaseAt: Date | null;
  releasedAt: Date | null;
  invoices?: InvoiceRefDoc[];
}

export type GigTier = "basic" | "standard" | "premium";

/** One fixed package of a gig: what's included, for how much, in how many days, with how many revisions. */
export interface GigPackageDoc {
  tier: GigTier;
  name: string;
  /** What's included. */
  description: string;
  price: number;
  deliveryDays: number;
  revisions: number;
}

/** A question the customer answers when ordering. Files can go with any order. */
export interface GigQuestionDoc {
  id: string;
  text: string;
  required: boolean;
}

/**
 * One service a freelancer sells, with one to three packages. `draft` until published (base KYC needed), `paused` while the
 * freelancer takes no new orders for it, `removed` when Ruxstar took it down.
 */
export interface GigDoc extends Stamped {
  _id: ObjectId;
  businessId: ObjectId;
  vendorId: ObjectId;
  businessName: string;
  title: string;
  category: string;
  description: string;
  photos: BusinessPhoto[];
  packages: GigPackageDoc[];
  questions: GigQuestionDoc[];
  /** The cheapest package, for lists. */
  priceFrom: number;
  /** The freelancer's city, lower case, for the city filter; null when they don't say. */
  city: string | null;
  status: "draft" | "live" | "paused" | "removed";
  publishedAt: Date | null;
  removal: { actorId: ObjectId; reason: string; at: Date } | null;
  rating?: { count: number; sum: number };
}

/**
 * A file uploaded for a freelance order, kept privately in the print files bucket under `gigs/`: the customer's files for the
 * brief, or the freelancer's for a delivery. Unused ones are deleted a day later; used ones `fileDays` after the order ends.
 */
export interface GigFileDoc {
  _id: ObjectId;
  userId: ObjectId;
  key: string;
  /** As the uploader named it. */
  name: string;
  contentType: string;
  bytes: number;
  use: "brief" | "delivery";
  orderId: ObjectId | null;
  createdAt: Date;
}

export interface GigFileRef {
  id: ObjectId;
  name: string;
  contentType: string;
  bytes: number;
}

/** One delivery: a message, links and files. The customer approves it, asks for a revision or reports a problem. */
export interface GigDeliveryDoc {
  id: ObjectId;
  message: string;
  links: string[];
  files: GigFileRef[];
  at: Date;
  answer: { kind: "approved" | "revision" | "problem"; note: string | null; at: Date } | null;
}

export type GigOrderStatus = "awaiting_payment" | "paid" | "in_progress" | "delivered" | "disputed" | "completed" | "cancelled";
export type GigActor = "customer" | "vendor" | "staff" | "system";

/** Money sent back: everything, or part of it when Ruxstar decides a reported problem. `vendor` and `ruxstar` are where it came from. */
export interface GigRefundDoc {
  refundId: string;
  kind: "full" | "part";
  amount: number;
  vendor: number;
  ruxstar: number;
  reason: string | null;
  by: GigActor;
  status: "pending" | "done";
  at: Date;
}

/**
 * A freelance order: one package of a gig, or a custom offer from a chat. Paid up front; the freelancer accepts within
 * `acceptHours` (offers are accepted already), delivers by `dueAt`, and the money waits in pending until the customer
 * approves, it completes by itself, or Ruxstar decides a reported problem.
 */
export interface GigOrderDoc extends Stamped {
  _id: ObjectId;
  orderNo: number;
  customerId: ObjectId;
  customerName: string;
  businessId: ObjectId;
  vendorId: ObjectId;
  businessName: string;
  /** The gig ordered from; null for a custom offer. */
  gigId: ObjectId | null;
  /** The custom offer paid for; null for a gig's package. */
  quoteId: ObjectId | null;
  title: string;
  category: string;
  package: { tier: GigTier | null; name: string; description: string; deliveryDays: number; revisions: number };
  answers: { questionId: string; question: string; answer: string }[];
  /** The customer's files for the brief. */
  files: GigFileRef[];
  note: string | null;
  price: {
    items: number;
    platformFee: number;
    discount: number;
    coupon: { id: ObjectId; code: string; fundedBy: "ruxstar" | "vendor" } | null;
    total: number;
    commissionBps: number;
    commission: number;
  };
  status: GigOrderStatus;
  timeline: { status: GigOrderStatus; at: Date; by: GigActor }[];
  payment: { gatewayOrderId: string; sessionId: string; paymentId: string | null; paidAt: Date | null };
  /** The checkout link works until then. */
  holdUntil: Date | null;
  /** Cancelled and refunded if the freelancer hasn't accepted by then. */
  acceptBy: Date | null;
  acceptedAt: Date | null;
  /** Acceptance plus the package's delivery days. */
  dueAt: Date | null;
  revisionsUsed: number;
  deliveries: GigDeliveryDoc[];
  deliveredAt: Date | null;
  /** Completed by itself then, unless the customer answers the delivery first. */
  autoCompleteAt: Date | null;
  completedAt: Date | null;
  /** A problem the customer reported: the money is held until Ruxstar decides a full, part or no refund. */
  dispute: {
    ticketId: ObjectId;
    reason: string;
    openedAt: Date;
    decision: { outcome: "full" | "part" | "none"; amount: number; note: string; by: ObjectId; at: Date } | null;
  } | null;
  refunds: GigRefundDoc[];
  cancellation: { by: GigActor; actorId: ObjectId | null; reason: string; at: Date } | null;
  releasedAt: Date | null;
  /** When its files are deleted: `fileDays` after it completed or was cancelled. */
  filesUntil: Date | null;
  filesDeletedAt: Date | null;
  invoices?: InvoiceRefDoc[];
}

/**
 * A custom offer a freelancer sends in a 1:1 chat. The customer's "Accept and pay" makes an order that is accepted already.
 * It can be paid until `expiresAt`; the freelancer can withdraw it until it is paid.
 */
export interface GigQuoteDoc extends Stamped {
  _id: ObjectId;
  conversationId: ObjectId;
  messageId: ObjectId;
  businessId: ObjectId;
  vendorId: ObjectId;
  businessName: string;
  customerId: ObjectId;
  title: string;
  /** What's included. */
  description: string;
  category: string;
  price: number;
  deliveryDays: number;
  revisions: number;
  status: "open" | "withdrawn" | "expired" | "paid";
  expiresAt: Date;
  orderId: ObjectId | null;
  withdrawnAt: Date | null;
}

/**
 * A discount code. Ruxstar's work at every shop and Ruxstar pays for them; a vendor's work at the shops
 * they pick and come out of their share. The code and the discount never change once made.
 */
export interface CouponDoc extends Stamped {
  _id: ObjectId;
  /** Upper case letters and digits, unique across Ruxstar. */
  code: string;
  fundedBy: "ruxstar" | "vendor";
  vendorId: ObjectId | null;
  /** The vendor's shops it works at; empty for Ruxstar's, which work everywhere. */
  businessIds: ObjectId[];
  modules: SwitchableModule[];
  /** `percent`: `value` is 1 to 100, up to `cap` paise when set. `flat`: `value` is paise off. */
  kind: "percent" | "flat";
  value: number;
  cap: number | null;
  /** Paise of items before the discount; 0 for none. */
  minOrder: number;
  startsAt: Date | null;
  endsAt: Date | null;
  /** Uses across everyone, and per customer; null for no limit. */
  limit: number | null;
  perCustomer: number | null;
  firstOrderOnly: boolean;
  /** Shown in the offers at checkout; otherwise only someone who knows the code can use it. */
  listed: boolean;
  active: boolean;
  /** Ruxstar switched a vendor's coupon off; only Ruxstar can switch it back on. */
  stoppedByRuxstar?: boolean;
  /** Paid orders that used it and weren't refunded in full. */
  used: number;
  createdBy: ObjectId;
}

/** One paid order's use of a coupon. Removed when the order is refunded in full, which gives the use back. */
export interface CouponRedemptionDoc {
  _id?: ObjectId;
  couponId: ObjectId;
  customerId: ObjectId;
  orderId: ObjectId;
  discount: number;
  at: Date;
}

/** What an owner can let a team member do at one business. Withdrawals, payment details, publishing, deleting and the team stay with the owner. */
export type TeamPermission =
  | "orders.view"
  | "orders.move"
  | "orders.reject"
  | "orders.refund"
  | "earnings.view"
  | "shop.open"
  | "shop.catalog"
  | "shop.details"
  | "coupons.manage"
  | "posts.create"
  | "reviews.reply"
  | "orders.deliver"
  | "tickets.scan"
  | "tickets.guests"
  | "classes.view"
  | "classes.attendance"
  | "classes.message"
  | "classes.materials"
  | "classes.reschedule"
  | "turf.bookings"
  | "turf.block"
  | "turf.cancel"
  | "turf.prices"
  | "turf.arrivals"
  | "stays.reservations"
  | "stays.movein"
  | "stays.beds"
  | "stays.cancel"
  | "stays.listing"
  | "store.orders"
  | "store.move"
  | "store.cancel"
  | "store.returns"
  | "store.products"
  | "store.stock";

/** Modules whose orders can be reviewed. */
export type ReviewModule = "pod" | "events" | "coaching" | "turf" | "stays" | "shop" | "gigs";
export type ReviewOrderType = "pod_order" | "event_order" | "coaching_order" | "turf_booking" | "stay_reservation" | "shop_order" | "gig_order";

/**
 * A customer's review of one finished order at any business (decisions 55 and A6): 1 to 5 stars and an optional note, written
 * or changed while the module's window is open. The business replies once and can change or remove the reply. `removed` when
 * the Ruxstar team took it down. Print reviews written before 15 Nov 2026 have no `module`, `orderType` or `listing`.
 */
export interface ReviewDoc extends Stamped {
  _id: ObjectId;
  orderId: ObjectId;
  orderNo: number;
  /** The business reviewed, of any module. */
  shopId: ObjectId;
  vendorId: ObjectId;
  customerId: ObjectId;
  /** What was bought: a print product, an event's title or a course's. */
  productLabel: string;
  /** Missing means `pod`. */
  module?: ReviewModule;
  /** Missing means `pod_order`. */
  orderType?: ReviewOrderType;
  /** The event, course or ground reviewed; null or missing for print. */
  listing?: { type: "event" | "course" | "ground" | "property" | "product" | "gig"; id: ObjectId } | null;
  /** The whole order when `orderId` is one line of it: a local shop's products are reviewed one by one. */
  parentId?: ObjectId;
  rating: number;
  text: string | null;
  status: "live" | "removed";
  editedAt: Date | null;
  reply: { text: string; by: ObjectId; at: Date; editedAt: Date | null } | null;
  removal?: { by: ObjectId; reason: string; at: Date };
}
export type PodReviewDoc = ReviewDoc;

export type ReviewReportReason = "spam" | "fake" | "abuse" | "other";

/** One open report per person and review. Closed when the Ruxstar team keeps or removes the review. */
export interface ReviewReportDoc {
  _id?: ObjectId;
  reviewId: ObjectId;
  reporterId: ObjectId;
  reason: ReviewReportReason;
  note: string | null;
  status: "open" | "closed";
  createdAt: Date;
  outcome?: "kept" | "removed";
  closedBy?: ObjectId;
  closedAt?: Date;
}

/**
 * Someone on a business's team (decision 54). `invited` until they accept or the invite expires; `active` after, though nothing
 * works for them until their identity verification is approved. `current` is set while invited or active, so one person has at
 * most one open place per business.
 */
export interface EmploymentDoc extends Stamped {
  _id: ObjectId;
  businessId: ObjectId;
  module: BusinessDoc["module"];
  ownerId: ObjectId;
  userId: ObjectId;
  status: "invited" | "active" | "declined" | "expired" | "removed" | "left";
  current?: true;
  permissions: TeamPermission[];
  /** Pay offered with the invite, in paise. Shown only: the shop pays its team outside Ruxstar. Missing on invites from before it. */
  pay?: { amount: number; per: "month" | "week" | "day" | "hour" | "order"; note: string | null } | null;
  invitedBy: ObjectId;
  invitedAt: Date;
  expiresAt: Date;
  joinedAt: Date | null;
  endedAt: Date | null;
  /** Who ended it: the owner, the member leaving, or the Ruxstar team. */
  endedBy: "owner" | "member" | "ruxstar" | null;
}

export interface RuxstarStaffDoc extends Stamped {
  _id: ObjectId;
  userId: ObjectId;
  title: string;
  modules: string[];
  permissions: string[];
  grantedBy: ObjectId;
  status: "active" | "revoked";
}

export interface AuditLogDoc extends Stamped {
  _id?: ObjectId;
  actor: { id: ObjectId | null; kind: "user" | "staff" | "admin" | "system" };
  scope: { module: string; businessId?: ObjectId };
  action: string;
  target: { type: string; id: ObjectId | string };
  diff: Record<string, { from: unknown; to: unknown }>;
  ip: string | null;
  at: Date;
}

export interface IdempotencyDoc {
  _id: string;
  state: "running" | "done";
  requestHash: string;
  status?: number;
  body?: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface CounterDoc {
  _id: string;
  seq: number;
}

export interface PlatformSettingDoc extends Stamped {
  _id: ObjectId;
  key: string;
  value: unknown;
  updatedBy: ObjectId | null;
}

export type SupportCategory = "orders" | "refunds" | "verification" | "business" | "delivery" | "account" | "safety" | "app" | "other";
export type SupportPriority = "urgent" | "high" | "normal" | "low";
/** `waiting` is waiting on the customer. A resolved ticket reads as closed once `reopenUntil` has passed. */
export type SupportStatus = "open" | "waiting" | "resolved";
export type SupportContextType = "order" | "business" | "verification" | "post" | "coupon" | "delivery" | "gig_order";

export interface SupportTicketDoc extends Stamped {
  _id: ObjectId;
  /** Shown as RX-1042. */
  ticketNo: number;
  requesterId: ObjectId;
  category: SupportCategory;
  subject: string;
  /** What it is about, checked when the ticket is opened. `label` is how staff and the customer see it, for example "Order #1042". */
  context: { type: SupportContextType; id: string; label: string } | null;
  status: SupportStatus;
  priority: SupportPriority;
  assigneeId: ObjectId | null;
  /** When the customer's oldest unanswered message arrived; null once staff reply. */
  awaitingSince: Date | null;
  /** The reply-by deadline: `awaitingSince` plus the priority's hours. Null while nothing waits for staff. */
  slaDueAt: Date | null;
  /** The latest message the customer can see, for sorting. */
  lastAt: Date;
  lastFrom: "customer" | "staff";
  /** When the customer last opened it, so staff replies after that show as unread. */
  seenAt: Date | null;
  resolvedAt: Date | null;
  reopenUntil: Date | null;
}

export interface SupportPhotoDoc {
  id: ObjectId;
  key: string;
  bytes: number;
}

export interface SupportMessageDoc {
  _id: ObjectId;
  ticketId: ObjectId;
  authorId: ObjectId;
  from: "customer" | "staff";
  text: string;
  /** JPEGs in the private print files bucket under `support/`. */
  photos: SupportPhotoDoc[];
  /** A staff note the customer never sees. */
  internal: boolean;
  at: Date;
}

export class Database {
  /** False until the first connect and the index build succeed; requests get 503 until then. */
  ready = false;
  client: MongoClient;
  db: Db;

  constructor(
    private readonly open: () => MongoClient,
    private readonly dbName: string,
  ) {
    this.client = open();
    this.db = this.client.db(dbName);
  }

  /**
   * Swaps in a new client. One that failed to set up can keep a round-trip estimate above
   * `timeoutMS`, and then refuses every operation, so a retry on it never succeeds.
   */
  renew(): void {
    const stale = this.client;
    this.client = this.open();
    this.db = this.client.db(this.dbName);
    stale.close().catch(() => undefined);
  }

  /**
   * The same client with a longer limit per operation. Startup queues hundreds of index builds on a pool of 20, and the
   * wait for a connection counts against `timeoutMS`, so under the request limit the last ones in the queue always fail.
   */
  withTimeout(timeoutMS: number): Database {
    return Object.create(this, { db: { value: this.client.db(this.dbName, { timeoutMS }) } }) as Database;
  }

  get users() {
    return this.db.collection<UserDoc>("users");
  }
  get sessions() {
    return this.db.collection<SessionDoc>("sessions");
  }
  get otps() {
    return this.db.collection<OtpDoc>("otps");
  }
  get moduleSettings() {
    return this.db.collection<ModuleSettingsDoc>("module_settings");
  }
  get ruxstarStaff() {
    return this.db.collection<RuxstarStaffDoc>("ruxstar_staff");
  }
  get auditLogs() {
    return this.db.collection<AuditLogDoc>("audit_logs");
  }
  get idempotencyKeys() {
    return this.db.collection<IdempotencyDoc>("idempotency_keys");
  }
  get counters() {
    return this.db.collection<CounterDoc>("counters");
  }
  get platformSettings() {
    return this.db.collection<PlatformSettingDoc>("platform_settings");
  }
  get posts() {
    return this.db.collection<PostDoc>("posts");
  }
  get postMedia() {
    return this.db.collection<PostMediaDoc>("post_media");
  }
  get postReactions() {
    return this.db.collection<PostReactionDoc>("post_reactions");
  }
  get postComments() {
    return this.db.collection<PostCommentDoc>("post_comments");
  }
  get reports() {
    return this.db.collection<ReportDoc>("reports");
  }
  get notifications() {
    return this.db.collection<NotificationDoc>("notifications");
  }
  get follows() {
    return this.db.collection<FollowDoc>("follows");
  }
  get blocks() {
    return this.db.collection<BlockDoc>("blocks");
  }
  get userReports() {
    return this.db.collection<UserReportDoc>("user_reports");
  }
  get conversations() {
    return this.db.collection<ConversationDoc>("conversations");
  }
  get chatMembers() {
    return this.db.collection<ChatMemberDoc>("chat_members");
  }
  get chatMessages() {
    return this.db.collection<ChatMessageDoc>("chat_messages");
  }
  get kycCases() {
    return this.db.collection<KycCaseDoc>("kyc_cases");
  }
  get businesses() {
    return this.db.collection<BusinessDoc>("businesses");
  }
  get payoutMethods() {
    return this.db.collection<PayoutMethodDoc>("payout_methods");
  }
  get payouts() {
    return this.db.collection<PayoutDoc>("payouts");
  }
  get riderPayoutMethods() {
    return this.db.collection<PayoutMethodDoc>("rider_payout_methods");
  }
  get printFiles() {
    return this.db.collection<PrintFileDoc>("print_files");
  }
  get podOrders() {
    return this.db.collection<PodOrderDoc>("pod_orders");
  }
  get coupons() {
    return this.db.collection<CouponDoc>("coupons");
  }
  get couponRedemptions() {
    return this.db.collection<CouponRedemptionDoc>("coupon_redemptions");
  }
  get employments() {
    return this.db.collection<EmploymentDoc>("employments");
  }
  /** Reviews of every module. The collection kept the name it had when only print orders were reviewed. */
  get reviews() {
    return this.db.collection<ReviewDoc>("pod_reviews");
  }
  get podReviews() {
    return this.reviews;
  }
  get reviewReports() {
    return this.db.collection<ReviewReportDoc>("review_reports");
  }
  get ledgerEntries() {
    return this.db.collection<LedgerEntryDoc>("ledger_entries");
  }
  get deliveryJobs() {
    return this.db.collection<DeliveryJobDoc>("delivery_jobs");
  }
  get riderStates() {
    return this.db.collection<RiderStateDoc>("rider_states");
  }
  get deliveryRoutes() {
    return this.db.collection<DeliveryRouteDoc>("delivery_routes");
  }
  get supportTickets() {
    return this.db.collection<SupportTicketDoc>("support_tickets");
  }
  get supportMessages() {
    return this.db.collection<SupportMessageDoc>("support_messages");
  }
  get events() {
    return this.db.collection<EventDoc>("events");
  }
  get eventOrders() {
    return this.db.collection<EventOrderDoc>("event_orders");
  }
  get eventTickets() {
    return this.db.collection<EventTicketDoc>("event_tickets");
  }
  get eventWaits() {
    return this.db.collection<EventWaitDoc>("event_waitlist");
  }
  get invoices() {
    return this.db.collection<InvoiceDoc>("invoices");
  }
  get coachingCourses() {
    return this.db.collection<CoachingCourseDoc>("coaching_courses");
  }
  get coachingBatches() {
    return this.db.collection<CoachingBatchDoc>("coaching_batches");
  }
  get coachingSessions() {
    return this.db.collection<CoachingSessionDoc>("coaching_sessions");
  }
  get coachingOrders() {
    return this.db.collection<CoachingOrderDoc>("coaching_orders");
  }
  get coachingChildren() {
    return this.db.collection<CoachingChildDoc>("coaching_children");
  }
  get coachingAttendance() {
    return this.db.collection<CoachingAttendanceDoc>("coaching_attendance");
  }
  get coachingMaterials() {
    return this.db.collection<CoachingMaterialDoc>("coaching_materials");
  }
  get coachingMessages() {
    return this.db.collection<CoachingMessageDoc>("coaching_messages");
  }
  get coachingCertificates() {
    return this.db.collection<CoachingCertificateDoc>("coaching_certificates");
  }
  get turfSports() {
    return this.db.collection<TurfSportDoc>("turf_sports");
  }
  get turfGrounds() {
    return this.db.collection<TurfGroundDoc>("turf_grounds");
  }
  get turfCourts() {
    return this.db.collection<TurfCourtDoc>("turf_courts");
  }
  get turfSlots() {
    return this.db.collection<TurfSlotDoc>("turf_slots");
  }
  get turfBookings() {
    return this.db.collection<TurfBookingDoc>("turf_bookings");
  }
  get staysFacilities() {
    return this.db.collection<StayFacilityDoc>("stays_facilities");
  }
  get staysProperties() {
    return this.db.collection<StayPropertyDoc>("stays_properties");
  }
  get staysRooms() {
    return this.db.collection<StayRoomDoc>("stays_rooms");
  }
  get staysBeds() {
    return this.db.collection<StayBedDoc>("stays_beds");
  }
  get staysReservations() {
    return this.db.collection<StayReservationDoc>("stays_reservations");
  }
  get shopProducts() {
    return this.db.collection<ShopProductDoc>("shop_products");
  }
  get shopBanned() {
    return this.db.collection<ShopBannedDoc>("shop_banned");
  }
  get shopOrders() {
    return this.db.collection<ShopOrderDoc>("shop_orders");
  }
  get gigs() {
    return this.db.collection<GigDoc>("gigs");
  }
  get gigOrders() {
    return this.db.collection<GigOrderDoc>("gig_orders");
  }
  get gigFiles() {
    return this.db.collection<GigFileDoc>("gig_files");
  }
  get gigQuotes() {
    return this.db.collection<GigQuoteDoc>("gig_quotes");
  }

  /** Runs `work` in a majority-committed transaction, retrying transient errors. */
  async transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try {
      return await session.withTransaction(work, {
        readConcern: { level: "majority" },
        writeConcern: { w: "majority" },
      });
    } finally {
      await session.endSession();
    }
  }

  /** Next number in a human-readable series such as `pod-order`. */
  async nextNumber(series: string, session?: ClientSession): Promise<number> {
    const doc = await this.counters.findOneAndUpdate(
      { _id: series },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after", session },
    );
    return doc!.seq;
  }

  async ping(): Promise<void> {
    await this.db.command({ ping: 1 });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export function createDatabase(uri: string, dbName: string): Database {
  const open = () =>
    new MongoClient(uri, {
      appName: "ruxstar-api",
      maxPoolSize: 20,
      minPoolSize: 1,
      // The cluster's first answer after a cold start often takes over 5 s. Requests stay capped by timeoutMS.
      serverSelectionTimeoutMS: 15_000,
      timeoutMS: 10_000,
      retryWrites: true,
    });
  return new Database(open, dbName);
}

export const stamp = (now = new Date()): Stamped => ({ createdAt: now, updatedAt: now, schemaVersion: 1 });
