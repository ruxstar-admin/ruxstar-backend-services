import { MongoClient, type ClientSession, type Db, type ObjectId } from "mongodb";
import type { Static } from "typebox";
import type { ModuleName } from "../contracts/common.js";

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
}

export type PostKind = "personal" | "business";

export interface PostPhoto {
  key: string;
  url: string;
  width: number;
  height: number;
}

/** Authors are read from `users` when posts are shown, so a new name or photo shows everywhere at once. */
export interface PostDoc extends Stamped {
  _id: ObjectId;
  authorId: ObjectId;
  kind: PostKind;
  text: string;
  media: PostPhoto[];
  counts: { likes: number; comments: number };
  status: "live" | "deleted";
  editedAt: Date | null;
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
}

export interface NotificationDoc {
  _id: ObjectId;
  userId: ObjectId;
  type: "post.like" | "post.comment";
  actorId: ObjectId;
  title: string;
  body: string;
  link: { screen: "post"; id: string };
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
