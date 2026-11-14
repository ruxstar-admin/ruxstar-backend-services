import type { Filter } from "mongodb";
import type { BusinessDoc, PodPrice, PostPhoto } from "../../platform/db.js";
import { ratingOf } from "../reviews/reviews.js";
import { unpricedOf } from "../vendor/businesses.js";
import { PRODUCTS, typeOf } from "../vendor/catalog.js";
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

export const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
