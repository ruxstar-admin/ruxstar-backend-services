import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { WithId } from "mongodb";
import type { Static } from "typebox";
import { diffOf, writeAudit, type Diff } from "../../platform/audit.js";
import type { AuditLogDoc, BusinessDoc, BusinessPhoto, Database } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { deliveryRules } from "../delivery/rates.js";
import { rupees } from "../pod/orders.js";
import { toPostPhoto } from "../social/photos.js";
import { emptyPod, missingOf, nextPod, photoKeys, toLocation, unpricedOf } from "./businesses.js";
import { MAX_BUSINESS_PHOTOS, type Business, type PodSetupBody, type UpdateBusinessBody } from "./contracts.js";

/** Who made the change: the owner from the vendor portal, or someone on the team from Work. */
export interface By {
  actor: AuditLogDoc["actor"];
  ip: string | null;
}

const failed = (path: string, message: string) => new AppError("KYC_CHECK_FAILED", message, [{ path, message }]);
const NEEDS: Record<Business["missing"][number], string> = {
  photo: "Add a cover photo",
  phone: "Add a phone number",
  location: "Add the state and city",
  products: "Select at least one print category you offer",
  area: 'Add at least one service city or turn on "Serve everywhere"',
  pricing: "Set a price for every product you offer",
  gstin: "Add your GSTIN. Ruxstar needs one for this category",
};
export const incomplete = (missing: Business["missing"]) =>
  new AppError(
    "BUSINESS_INCOMPLETE",
    undefined,
    missing.map((field) => ({ path: `body/${field}`, message: NEEDS[field] })),
  );

const audit = (db: Database, doc: WithId<BusinessDoc>, action: string, by: By, diff: Diff) =>
  writeAudit(db, { actor: by.actor, scope: { module: doc.module, businessId: doc._id }, action, target: { type: "business", id: doc._id }, diff, ip: by.ip });

export async function editDetails(app: FastifyInstance, db: Database, doc: WithId<BusinessDoc>, body: Static<typeof UpdateBusinessBody>, by: By) {
  const set: Partial<BusinessDoc> = {};
  if (body.name !== undefined) set.name = body.name.trim();
  if (body.description !== undefined) set.description = body.description?.trim() || null;
  if (body.phone !== undefined) set.phone = body.phone;
  if (body.location !== undefined) set.location = body.location ? toLocation(body.location) : null;
  if (body.gstin !== undefined && body.gstin !== doc.gstin?.number) {
    if (body.gstin === null) set.gstin = null;
    else {
      const result = await app.verifier.gstin(body.gstin, set.name ?? doc.name);
      if (!result.valid) throw failed("body/gstin", "We could not find this GSTIN. Check it, or leave it empty.");
      if (result.status && result.status.toLowerCase() !== "active") throw failed("body/gstin", "This GSTIN is not active.");
      set.gstin = { number: body.gstin, legalName: result.legalName, status: result.status };
    }
  }
  if (doc.status === "live") {
    const missing = missingOf({ ...doc, ...set });
    if (missing.length) throw incomplete(missing);
  }
  const diff = diffOf(doc, set);
  if (!Object.keys(diff).length) return;
  await db.businesses.updateOne({ _id: doc._id }, { $set: { ...set, updatedAt: new Date() } });
  await audit(db, doc, "business.update", by, diff);
}

export async function editPod(db: Database, doc: WithId<BusinessDoc>, body: Static<typeof PodSetupBody>, by: By) {
  if (doc.module !== "pod") throw new AppError("CONFLICT", "Only print on demand businesses have this setup.");
  const before = doc.pod ?? emptyPod();
  const pod = nextPod(doc.pod, body);
  if (body.deliveryFee) {
    const max = (await deliveryRules(db)).shopFeeMax;
    for (const part of ["base", "perKm"] as const) {
      if (body.deliveryFee[part] > max[part]) {
        const message = `Ruxstar allows up to ${rupees(max[part])}${part === "perKm" ? " a km" : ""}.`;
        throw new AppError("VALIDATION_FAILED", message, [{ path: `body/deliveryFee/${part}`, message }]);
      }
    }
  }
  if (doc.status === "live") {
    // A live shop can add a product before pricing it: customers only see priced products, so it
    // stays hidden until then. It still needs one priced product to stay sellable.
    const sellable = unpricedOf(pod).length < pod.products.length;
    const missing = missingOf({ ...doc, pod }).filter((field) => field !== "pricing" || !sellable);
    if (missing.length) throw incomplete(missing);
  }
  const diff = diffOf(before, pod);
  if (!Object.keys(diff).length) return;
  await db.businesses.updateOne({ _id: doc._id }, { $set: { pod, updatedAt: new Date() } });
  await audit(db, doc, "business.catalog", by, diff);
}

export async function addPhoto(app: FastifyInstance, db: Database, doc: WithId<BusinessDoc>, image: unknown, by: By) {
  const full = `Up to ${MAX_BUSINESS_PHOTOS} photos. Remove one first.`;
  if (doc.photos.length >= MAX_BUSINESS_PHOTOS) throw new AppError("CONFLICT", full);
  if (!Buffer.isBuffer(image) || image.length === 0) throw new AppError("PHOTO_INVALID");
  const { full: big, smaller } = await toPostPhoto(image);
  const id = randomUUID();
  const base = `business-media/${app.config.env}/${doc._id.toHexString()}/${id}`;
  const save = async (file: typeof big, suffix: string) => {
    const key = `${base}${suffix}.webp`;
    return { key, url: await app.media.save(key, file.data), width: file.width, height: file.height };
  };
  const [saved, ...copies] = await Promise.all([save(big, ""), ...smaller.map((file) => save(file, `-${file.width}w`))]);
  const photo: BusinessPhoto = { id, ...saved!, smaller: copies };
  const res = await db.businesses.updateOne(
    { _id: doc._id, suspension: { $exists: false }, [`photos.${MAX_BUSINESS_PHOTOS - 1}`]: { $exists: false } },
    { $push: { photos: photo }, $set: { updatedAt: new Date() } },
  );
  if (res.matchedCount === 0) {
    await Promise.all(photoKeys(photo).map((key) => app.media.remove(key)));
    throw new AppError("CONFLICT", full);
  }
  await audit(db, doc, "business.photo_add", by, { photo: { from: null, to: id } });
}

/** A live business keeps at least one photo. */
export async function removePhoto(app: FastifyInstance, db: Database, doc: WithId<BusinessDoc>, photoId: string, by: By) {
  const photo = doc.photos.find((p) => p.id === photoId);
  if (!photo) throw new AppError("NOT_FOUND", "Photo not found.");
  if (doc.status === "live" && doc.photos.length === 1) throw incomplete(["photo"]);
  await db.businesses.updateOne({ _id: doc._id }, { $pull: { photos: { id: photo.id } }, $set: { updatedAt: new Date() } });
  await Promise.all(photoKeys(photo).map((key) => app.media.remove(key)));
  await audit(db, doc, "business.photo_remove", by, { photo: { from: photo.id, to: null } });
}

/** Only a live business opens or closes, and it opens only while its module is live. */
export async function setOpen(db: Database, doc: WithId<BusinessDoc>, open: boolean, moduleLive: () => Promise<boolean>, by: By) {
  if (doc.status !== "live") throw new AppError("CONFLICT", "Publish this business first.");
  if (open && !(await moduleLive())) throw new AppError("MODULE_OFF");
  if (doc.open === open) return;
  await db.businesses.updateOne({ _id: doc._id }, { $set: { open, updatedAt: new Date() } });
  await audit(db, doc, open ? "business.open" : "business.close", by, { open: { from: doc.open, to: open } });
}
