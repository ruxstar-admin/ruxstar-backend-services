import type { FastifyRequest } from "fastify";
import type { ObjectId } from "mongodb";
import { requireAuth } from "../../platform/auth.js";
import type { BusinessDoc, BusinessPhoto, Database, PayoutMethodDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import type { Business, PayoutMethod } from "./contracts.js";

/** Verified people are vendors. Everything under /v1/vendor needs it. */
export async function requireVendor(request: FastifyRequest): Promise<void> {
  await requireAuth(request);
  if (!request.auth!.roles.vendor) throw new AppError("KYC_REQUIRED", "Get verified to open the vendor portal.");
}

export function missingOf(doc: BusinessDoc): Business["missing"] {
  const missing: Business["missing"] = [];
  if (!doc.description || doc.description.trim().length < 20) missing.push("description");
  if (!doc.phone) missing.push("phone");
  if (!doc.address) missing.push("address");
  if (!doc.photos.length) missing.push("photo");
  return missing;
}

export function businessView(doc: BusinessDoc, moduleLive: boolean): Business {
  return {
    id: doc._id.toHexString(),
    module: doc.module,
    name: doc.name,
    description: doc.description,
    phone: doc.phone,
    email: doc.email,
    address: doc.address ? { ...doc.address, line2: doc.address.line2 ?? null } : null,
    gstin: doc.gstin,
    photos: doc.photos.map(({ id, url, width, height }) => ({ id, url, width, height })),
    status: doc.status,
    open: doc.open,
    moduleLive,
    missing: missingOf(doc),
    suspension: doc.suspension ? { reason: doc.suspension.reason, at: doc.suspension.at.toISOString() } : null,
    publishedAt: doc.publishedAt?.toISOString() ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** Which modules are live, read once for a list of businesses. */
export async function liveModules(db: Database): Promise<Set<string>> {
  const docs = await db.moduleSettings.find({ live: true }, { projection: { module: 1 } }).toArray();
  return new Set(docs.map((d) => d.module));
}

export const photoKeys = (photo: BusinessPhoto) => [photo.key, ...(photo.smaller ?? []).map((s) => s.key)];

export function payoutMethodView(doc: PayoutMethodDoc): PayoutMethod {
  const label =
    doc.kind === "bank" ? `${doc.bank?.bankName ?? "Bank"} ••${doc.bank?.last4 ?? ""}` : (doc.upi?.vpa ?? "UPI");
  return {
    kind: doc.kind,
    label,
    holderName: doc.holderName,
    ifsc: doc.bank?.ifsc ?? null,
    verifiedAt: doc.verifiedAt.toISOString(),
  };
}

export const ownedBy = (id: ObjectId, ownerId: ObjectId) => ({ _id: id, ownerId });
