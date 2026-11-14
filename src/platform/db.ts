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
export type BusinessModule = "pod" | "events" | "coaching" | "stays";

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

export type ChatMessageKind = "text" | "post" | "photo" | "voice" | "event";

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
  reactions?: ChatReaction[];
  /** When its reactions last changed, so open chats pick that up. */
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
  | "kyc.reopened";

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
   * delivery app. `support` opens one of your help tickets.
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
      | "support";
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
  deliveryEnabled: boolean;
  permissionCatalog: string[];
  updatedBy: ObjectId | null;
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
  source: { type: "pod_order" | "payout"; id: ObjectId };
  at: Date;
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
  | "orders.deliver";

/**
 * A customer's review of one delivered print order (decision 55): 1 to 5 stars and an optional note, written or changed within
 * 30 days of delivery. The shop replies once and can change or remove the reply. `removed` when the Ruxstar team took it down.
 */
export interface PodReviewDoc extends Stamped {
  _id: ObjectId;
  orderId: ObjectId;
  orderNo: number;
  shopId: ObjectId;
  vendorId: ObjectId;
  customerId: ObjectId;
  productLabel: string;
  rating: number;
  text: string | null;
  status: "live" | "removed";
  editedAt: Date | null;
  reply: { text: string; by: ObjectId; at: Date; editedAt: Date | null } | null;
  removal?: { by: ObjectId; reason: string; at: Date };
}

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
export type SupportContextType = "order" | "business" | "verification" | "post" | "coupon";

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
  get podReviews() {
    return this.db.collection<PodReviewDoc>("pod_reviews");
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
  get supportTickets() {
    return this.db.collection<SupportTicketDoc>("support_tickets");
  }
  get supportMessages() {
    return this.db.collection<SupportMessageDoc>("support_messages");
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
