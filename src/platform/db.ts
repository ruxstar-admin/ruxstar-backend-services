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
  email?: string;
  passwordHash?: string;
  /** The two hashes before the current one, newest first. None of the three can be reused. */
  passwordHistory?: string[];
  name?: string;
  username?: string;
  dob?: string | null;
  gender?: "female" | "male" | "other" | null;
  avatar?: string | null;
  status: "active" | "locked" | "deleted";
  roles: UserRoles;
  kyc: { base?: KycState; vendor?: KycState; delivery?: KycState };
  lock?: { failedCount: number; lockedUntil: Date | null };
  consent?: { termsVersion: string; acceptedAt: Date };
  home?: { city: string | null };
  prefs?: Record<string, unknown>;
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

export type OtpPurpose = "signup" | "reset";

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

  constructor(
    readonly client: MongoClient,
    readonly db: Db,
  ) {}

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
  const client = new MongoClient(uri, {
    appName: "ruxstar-api",
    maxPoolSize: 20,
    minPoolSize: 1,
    // The cluster's first answer after a cold start often takes over 5 s. Requests stay capped by timeoutMS.
    serverSelectionTimeoutMS: 15_000,
    timeoutMS: 10_000,
    retryWrites: true,
  });
  return new Database(client, client.db(dbName));
}

export const stamp = (now = new Date()): Stamped => ({ createdAt: now, updatedAt: now, schemaVersion: 1 });
