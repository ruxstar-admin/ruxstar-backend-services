import { createHmac } from "node:crypto";
import type { ObjectId } from "mongodb";
import type { Database, KycCaseDoc, KycTrack, UserDoc } from "../../platform/db.js";
import { MAX_REJECTIONS, type BaseCase, type Card, type ReviewCase, type VendorCase } from "./contracts.js";

/** Tries per step in a day. Production checks cost money, so this caps both abuse and the bill. */
export const MAX_TRIES_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60_000;
/** Cashfree's PAN name grades that count as the same person. */
export const NAME_MATCHES = new Set(["DIRECT_MATCH", "GOOD_PARTIAL_MATCH", "MODERATE_PARTIAL_MATCH"]);

export const triesToday = (step?: { tries: number; at: Date }) => (step && Date.now() - step.at.getTime() < DAY_MS ? step.tries : 0);

export const maskPan = (pan: string) => `${pan.slice(0, 2)}******${pan.slice(-2)}`;

/** Keyed, so the stored value cannot be reversed by hashing every possible PAN. */
export const panHash = (pan: string, key: Uint8Array) => createHmac("sha256", key).update(`pan:${pan}`).digest("hex");

export const verificationId = (userId: ObjectId, step: string) => `rux_${userId.toHexString().slice(-8)}_${step}_${Date.now()}`;

export const loadCase = (db: Database, userId: ObjectId, track: KycTrack) => db.kycCases.findOne({ userId, track });

/** Creates the case on first use. */
export async function openCase(db: Database, userId: ObjectId, track: KycTrack): Promise<KycCaseDoc> {
  const now = new Date();
  const doc = await db.kycCases.findOneAndUpdate(
    { userId, track },
    {
      $setOnInsert: { userId, track, status: "in_progress", rejections: 0, steps: {}, submittedAt: null, review: null, createdAt: now, schemaVersion: 1 },
      $set: { updatedAt: now },
    },
    { upsert: true, returnDocument: "after" },
  );
  return doc!;
}

const decision = (doc: KycCaseDoc | null) => ({
  status: doc?.status ?? ("not_started" as const),
  rejectionReason: doc && (doc.status === "rejected" || doc.status === "locked") ? (doc.review?.reason ?? null) : null,
  rejectionsLeft: Math.max(0, MAX_REJECTIONS - (doc?.rejections ?? 0)),
  submittedAt: doc?.submittedAt?.toISOString() ?? null,
  decidedAt: doc?.review?.at.toISOString() ?? null,
});

export function baseView(doc: KycCaseDoc | null): BaseCase {
  const { aadhaar, pan, face } = doc?.steps ?? {};
  return {
    ...decision(doc),
    steps: {
      aadhaar: { status: aadhaar?.status ?? "not_started", reason: aadhaar?.reason ?? null, name: aadhaar?.name ?? null, last4: aadhaar?.last4 ?? null },
      pan: { status: pan?.status ?? "not_started", reason: pan?.reason ?? null, masked: pan?.status === "verified" ? pan.masked : null },
      face: { status: face?.status ?? "not_started", reason: face?.reason ?? null },
    },
  };
}

const businessView = (business: NonNullable<KycCaseDoc["steps"]["business"]>) => ({
  name: business.name,
  address: { ...business.address, line2: business.address.line2 ?? null },
  gstin: business.gstin,
});

export function vendorView(doc: KycCaseDoc | null): VendorCase {
  const business = doc?.steps.business;
  return { ...decision(doc), business: business ? businessView(business) : null };
}

export async function overview(db: Database, userId: ObjectId) {
  const cases = await db.kycCases.find({ userId }).toArray();
  return {
    base: baseView(cases.find((c) => c.track === "base") ?? null),
    vendor: vendorView(cases.find((c) => c.track === "vendor") ?? null),
  };
}

export function cardView(user: UserDoc, base: KycCaseDoc, siteUrl: string): Card {
  return {
    id: user.card!.id,
    name: base.steps.aadhaar?.name ?? user.name ?? "",
    photoUrl: user.avatar ?? null,
    aadhaar: `XXXX XXXX ${base.steps.aadhaar?.last4 ?? "XXXX"}`,
    pan: base.steps.pan?.masked ?? null,
    vendor: Boolean(user.roles.vendor),
    memberSince: user.card!.issuedAt.toISOString(),
    profileUrl: `${siteUrl}/u/${encodeURIComponent(user.username ?? user._id.toHexString())}`,
  };
}

type ReviewUser = Pick<UserDoc, "_id" | "name" | "username" | "phone" | "avatar" | "createdAt">;

export function reviewView(doc: KycCaseDoc, user: ReviewUser | undefined): ReviewCase {
  const { aadhaar, pan, face, business } = doc.steps;
  return {
    id: doc._id.toHexString(),
    track: doc.track,
    status: doc.status,
    rejections: doc.rejections,
    user: {
      id: doc.userId.toHexString(),
      name: user?.name ?? "",
      username: user?.username ?? "",
      phone: user?.phone ?? "",
      avatarUrl: user?.avatar ?? null,
      memberSince: (user?.createdAt ?? doc.createdAt).toISOString(),
    },
    identity:
      doc.track === "base"
        ? {
            aadhaarName: aadhaar?.name ?? null,
            aadhaarLast4: aadhaar?.last4 ?? null,
            panMasked: pan?.masked ?? null,
            panName: pan?.registeredName ?? null,
            nameMatch: pan?.nameMatch ?? null,
            livenessScore: face?.livenessScore ?? null,
            faceMatchScore: face?.matchScore ?? null,
          }
        : null,
    business: business ? businessView(business) : null,
    submittedAt: doc.submittedAt?.toISOString() ?? null,
    review: doc.review ? { decision: doc.review.decision, reason: doc.review.reason, at: doc.review.at.toISOString() } : null,
  };
}

export const REVIEW_USER_PROJECTION = { name: 1, username: 1, phone: 1, avatar: 1, createdAt: 1 } as const;
