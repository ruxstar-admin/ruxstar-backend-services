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
  social?: { posts?: number; engagements?: number };
  /** The Ruxstar Card, issued when identity KYC is approved. `id` looks like RUX-1A2B-3C4D. */
  card?: { id: string; issuedAt: Date };
  /** Why the Ruxstar team put the account on hold (`status: "locked"`). Removed when it is unlocked. */
  suspension?: { by: ObjectId; at: Date; reason: string };
}

export type KycTrack = "base" | "vendor";
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
}

/** Where a vendor is paid. One per vendor, checked with Cashfree before it is saved. */
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

export interface PayoutDoc extends Stamped {
  _id: ObjectId;
  vendorId: ObjectId;
  /** Paise. */
  amount: number;
  status: "pending" | "paid" | "failed";
  /** How it was sent, for example "Bank ••1191" or "asha@upi". */
  to: string;
  utr: string | null;
  paidAt: Date | null;
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

export type NotificationType =
  | "post.like"
  | "post.comment"
  | "post.removed"
  | "kyc.approved"
  | "kyc.rejected"
  | "business.suspended"
  | "business.restored";

export interface NotificationDoc {
  _id: ObjectId;
  userId: ObjectId;
  type: NotificationType;
  /** Who did it; for KYC decisions, the reviewer. */
  actorId: ObjectId;
  title: string;
  body: string;
  /** `verification` opens the KYC screen (its id is the track); `business` opens a business in the vendor portal. */
  link: { screen: "post" | "verification" | "business"; id: string };
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
  deliveryEnabled: boolean;
  permissionCatalog: string[];
  updatedBy: ObjectId | null;
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
