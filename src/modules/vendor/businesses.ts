import type { FastifyRequest } from "fastify";
import type { ObjectId } from "mongodb";
import type { Static } from "typebox";
import { requireAuth } from "../../platform/auth.js";
import type { BusinessDoc, BusinessLocation, BusinessPhoto, Database, PayoutMethodDoc, PodPrice, PodSetup } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { ratingOf } from "../reviews/reviews.js";
import { productOf, type PodProduct } from "./catalog.js";
import type { Business, Location, PayoutMethod, PodPriceBody, PodSetupBody } from "./contracts.js";
import { INDIAN_STATES } from "./india.js";

/** Verified people are vendors. Everything under /v1/vendor needs it. */
export async function requireVendor(request: FastifyRequest): Promise<void> {
  await requireAuth(request);
  if (!request.auth!.roles.vendor) throw new AppError("KYC_REQUIRED", "Get verified to open the vendor portal.");
}

const invalid = (path: string, message: string) => new AppError("VALIDATION_FAILED", message, [{ path, message }]);

/** A product has a price once it can be charged: a base price, or a page rate for documents. */
const priced = (p: PodPrice | undefined) => !!p && (p.model === "per_page" ? (p.bw ?? 0) > 0 || (p.color ?? 0) > 0 : (p.basePrice ?? 0) > 0);

export const unpricedOf = (pod: PodSetup) => pod.products.filter((product) => !priced(pod.prices.find((p) => p.product === product)));

/** What still stops a business going live, all at once, as v1 did. */
export function missingOf(doc: BusinessDoc): Business["missing"] {
  const missing: Business["missing"] = [];
  if (!doc.photos.length) missing.push("photo");
  if (!doc.phone) missing.push("phone");
  if (!doc.location) missing.push("location");
  if (doc.module === "pod") {
    const pod = doc.pod ?? emptyPod();
    if (!pod.products.length) missing.push("products");
    if (!pod.serveAll && !pod.cities.length) missing.push("area");
    if (pod.products.length && unpricedOf(pod).length) missing.push("pricing");
  }
  return missing;
}

export const emptyPod = (): PodSetup => ({ products: [], serveAll: false, cities: [], turnaroundDays: 3, minOrder: 0, notes: null, prices: [] });

export function businessView(doc: BusinessDoc, moduleLive: boolean): Business {
  const pod = doc.module === "pod" ? (doc.pod ?? emptyPod()) : null;
  return {
    id: doc._id.toHexString(),
    module: doc.module,
    type: doc.type,
    name: doc.name,
    description: doc.description,
    phone: doc.phone,
    location: doc.location,
    gstin: doc.gstin,
    photos: doc.photos.map(({ id, url, width, height }) => ({ id, url, width, height })),
    pod: pod ? { ...pod, unpriced: unpricedOf(pod) } : null,
    status: doc.status,
    open: doc.open,
    moduleLive,
    missing: missingOf(doc),
    suspension: doc.suspension ? { reason: doc.suspension.reason, at: doc.suspension.at.toISOString() } : null,
    rating: ratingOf(doc),
    publishedAt: doc.publishedAt?.toISOString() ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

const clean = (value: string | null | undefined) => value?.trim().replace(/\s+/g, " ") || null;

/** Trims every part and matches the state to the catalog's spelling. */
export function toLocation(body: Static<typeof Location>): BusinessLocation {
  const state = INDIAN_STATES.find((s) => s.toLowerCase() === body.state.trim().toLowerCase());
  if (!state) throw invalid("body/location/state", "Pick a state from the list.");
  const city = clean(body.city);
  if (!city || city.length < 2) throw invalid("body/location/city", "Pick or type a city.");
  return {
    state,
    city,
    doorNo: clean(body.doorNo),
    building: clean(body.building),
    street: clean(body.street),
    area: clean(body.area),
    pincode: body.pincode ?? null,
    point: body.point ?? null,
  };
}

function toPrice(body: Static<typeof PodPriceBody>, index: number): PodPrice {
  const info = productOf(body.product);
  const at = `body/prices/${index}`;
  const extras = new Map<string, PodPrice["extras"][number]>();
  for (const [i, extra] of (body.extras ?? []).entries()) {
    const values = info.options[extra.option as keyof typeof info.options];
    if (!values) throw invalid(`${at}/extras/${i}/option`, `${info.label} has no ${extra.option} option.`);
    if (!values.includes(extra.value)) throw invalid(`${at}/extras/${i}/value`, `${extra.value} is not a ${extra.option} for ${info.label}.`);
    extras.set(`${extra.option}\u0000${extra.value}`, extra);
  }
  const tiers = new Map<number, PodPrice["tiers"][number]>();
  for (const tier of body.tiers ?? []) tiers.set(tier.from, tier);
  const perPage = info.pricing === "per_page";
  return {
    product: body.product,
    model: info.pricing,
    minQuantity: Math.max(body.minQuantity ?? info.minQuantity, 1),
    turnaroundDays: body.turnaroundDays ?? null,
    basePrice: perPage ? null : (body.basePrice ?? null),
    bw: perPage ? (body.bw ?? null) : null,
    color: perPage ? (body.color ?? null) : null,
    extras: [...extras.values()],
    tiers: [...tiers.values()].sort((a, b) => a.from - b.from),
  };
}

/** Applies a partial setup. Prices are kept only for products still offered. */
export function nextPod(current: PodSetup | null, body: Static<typeof PodSetupBody>): PodSetup {
  const pod = { ...(current ?? emptyPod()) };
  if (body.products !== undefined) pod.products = [...new Set(body.products)];
  if (body.serveAll !== undefined) pod.serveAll = body.serveAll;
  if (body.cities !== undefined) pod.cities = [...new Set(body.cities.map((c) => c.trim().toLowerCase()).filter(Boolean))];
  if (body.turnaroundDays !== undefined) pod.turnaroundDays = body.turnaroundDays;
  if (body.minOrder !== undefined) pod.minOrder = body.minOrder;
  if (body.notes !== undefined) pod.notes = clean(body.notes);
  if (body.prices !== undefined) {
    const sent = body.prices.map((price, i) => {
      if (!pod.products.includes(price.product)) throw invalid(`body/prices/${i}/product`, `Add ${productOf(price.product).label} to your products first.`);
      return toPrice(price, i);
    });
    const replaced = new Set<PodProduct>(sent.map((p) => p.product));
    pod.prices = [...pod.prices.filter((p) => !replaced.has(p.product)), ...sent];
  }
  pod.prices = pod.prices.filter((p) => pod.products.includes(p.product));
  return pod;
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
