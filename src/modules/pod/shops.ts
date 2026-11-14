import type { Filter } from "mongodb";
import type { BusinessDoc, PodPrice, PostPhoto } from "../../platform/db.js";
import { shopFeeOf } from "../delivery/rates.js";
import { ratingOf } from "../reviews/reviews.js";
import { unpricedOf } from "../vendor/businesses.js";
import { PRODUCTS, typeOf, type PodProduct } from "../vendor/catalog.js";
import type { Shop, ShopCard } from "./contracts.js";

/** Customers see a print shop only while it is live and not on hold; the module being off hides them all. */
export const visibleShops: Filter<BusinessDoc> = { module: "pod", status: "live", suspension: { $exists: false } };

const photoView = ({ url, width, height, smaller }: PostPhoto) => ({
  url,
  width,
  height,
  smaller: (smaller ?? []).map((s) => ({ url: s.url, width: s.width, height: s.height })),
});

/** The lowest price a customer can pay per unit or page, from bulk tiers too. */
function lowest(price: PodPrice): number | null {
  const base = price.model === "per_page" ? [price.bw, price.color] : [price.basePrice];
  const all = [...base, ...price.tiers.map((t) => t.unitPrice)].filter((p): p is number => typeof p === "number" && p > 0);
  return all.length ? Math.min(...all) : null;
}

const pricedOf = (doc: BusinessDoc) => {
  const pod = doc.pod!;
  const unpriced = new Set(unpricedOf(pod));
  return pod.prices.filter((p) => pod.products.includes(p.product) && !unpriced.has(p.product));
};

export function shopCard(doc: BusinessDoc): ShopCard {
  const pod = doc.pod!;
  const priced = pricedOf(doc);
  let from: { price: number; unit: "unit" | "page" } | null = null;
  for (const price of priced) {
    const value = lowest(price);
    if (value !== null && (!from || value < from.price)) from = { price: value, unit: price.model === "per_page" ? "page" : "unit" };
  }
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    type: doc.type,
    typeLabel: typeOf(doc.type).label,
    cover: doc.photos[0] ? photoView(doc.photos[0]) : null,
    area: doc.location?.area ?? null,
    city: doc.location?.city ?? "",
    state: doc.location?.state ?? "",
    open: doc.open,
    deliversEverywhere: pod.serveAll,
    fromPrice: from?.price ?? null,
    fromUnit: from?.unit ?? null,
    turnaroundDays: pod.turnaroundDays,
    products: PRODUCTS.map((p) => p.id).filter((id) => priced.some((p) => p.product === id)),
    rating: ratingOf(doc),
  };
}

export function shopView(doc: BusinessDoc): Shop {
  const pod = doc.pod!;
  const priced = new Map(pricedOf(doc).map((p) => [p.product, p]));
  return {
    ...shopCard(doc),
    description: doc.description,
    photos: doc.photos.map(photoView),
    pincode: doc.location?.pincode ?? null,
    cities: pod.serveAll ? [] : pod.cities,
    minOrder: pod.minOrder,
    notes: pod.notes,
    deliveryFee: shopFeeOf(doc),
    catalog: PRODUCTS.flatMap((info) => {
      const price = priced.get(info.id);
      if (!price) return [];
      return [
        {
          id: info.id,
          label: info.label,
          description: info.description,
          pricing: info.pricing,
          minQuantity: price.minQuantity,
          turnaroundDays: price.turnaroundDays ?? pod.turnaroundDays,
          basePrice: price.basePrice,
          bw: price.bw,
          color: price.color,
          extras: price.extras,
          tiers: price.tiers,
          options: Object.entries(info.options).map(([option, values]) => ({ option, values: [...values] })),
        },
      ];
    }),
  };
}

/** Open shops first within a page, so a customer sees who can take the order now. */
export const openFirst = (a: ShopCard, b: ShopCard) => Number(b.open) - Number(a.open);

/** Within a page: shops in the customer's own city, then open ones. */
export const nearFirst = (city: string | null | undefined) => {
  const home = city?.trim().toLowerCase();
  const near = (s: ShopCard) => Number(!!home && s.city.toLowerCase() === home);
  return (a: ShopCard, b: ShopCard) => near(b) - near(a) || openFirst(a, b);
};

export const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What people type for a product besides its name. */
const PRODUCT_WORDS: Partial<Record<PodProduct, string[]>> = {
  tshirts: ["t shirt", "tshirt", "tee"],
  business_cards: ["visiting card", "visiting cards"],
  flex_banners: ["flex", "banner", "hoarding"],
  invitations: ["invite", "wedding card"],
  photo_prints: ["photo"],
  documents: ["xerox", "photocopy", "printout", "print out", "document"],
  stickers: ["label"],
};

const fold = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Products a search means: its words are in a product's name or description, or it names one of the product's words. */
export function productsFor(q: string): PodProduct[] {
  const term = fold(q);
  if (term.length < 3) return [];
  return PRODUCTS.filter((p) => {
    const words = [p.label, p.description, ...(PRODUCT_WORDS[p.id] ?? [])].map(fold);
    return words.some((w) => w.includes(term) || ` ${term} `.includes(` ${w} `));
  }).map((p) => p.id);
}

/** A search matches part of the shop's name, what it prints, or its city or area. */
export function shopSearch(q: string): Filter<BusinessDoc> {
  const pattern = { $regex: escapeRegex(q.trim()), $options: "i" };
  const products = productsFor(q);
  return {
    $or: [
      { name: pattern },
      { "location.city": pattern },
      { "location.area": pattern },
      ...(products.length ? [{ "pod.products": { $in: products } }] : []),
    ],
  };
}
