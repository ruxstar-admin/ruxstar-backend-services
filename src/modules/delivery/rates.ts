import type { BusinessDoc, Database, DeliveryFee, ModuleSettingsDoc } from "../../platform/db.js";

/** Defaults until a Ruxstar admin changes them on the delivery module (decision 57). Paise. */
export const DEFAULT_RIDER_RATE: DeliveryFee = { base: 3000, includedKm: 3, perKm: 800 };
export const DEFAULT_SHOP_FEE_MAX = { base: 20_000, perKm: 5000 };
export const DEFAULT_OFFER_MINUTES = 15;
export const FREE_DELIVERY: DeliveryFee = { base: 0, includedKm: 0, perKm: 0 };

/** Roads are longer than a straight line; this stands in until a routing service does it properly. */
const ROAD_FACTOR = 1.3;

export const BUSINESS_MODULES: ModuleSettingsDoc["module"][] = ["pod", "events", "coaching", "stays"];

export interface DeliveryRules {
  riderRate: DeliveryFee;
  shopFeeMax: { base: number; perKm: number };
  offerMinutes: number;
  /** Ruxstar partners can be picked: the delivery module is live and print orders have delivery switched on. */
  partners: boolean;
}

export const rulesOf = (delivery: ModuleSettingsDoc | null, pod: ModuleSettingsDoc | null): DeliveryRules => ({
  riderRate: delivery?.riderRate ?? DEFAULT_RIDER_RATE,
  shopFeeMax: delivery?.shopFeeMax ?? DEFAULT_SHOP_FEE_MAX,
  offerMinutes: delivery?.offerMinutes ?? DEFAULT_OFFER_MINUTES,
  partners: Boolean(delivery?.live && pod?.deliveryEnabled),
});

export async function deliveryRules(db: Database): Promise<DeliveryRules> {
  const docs = await db.moduleSettings.find({ module: { $in: ["delivery", "pod"] } }).toArray();
  return rulesOf(docs.find((d) => d.module === "delivery") ?? null, docs.find((d) => d.module === "pod") ?? null);
}

type Point = { lat: number; lng: number };

/** Road km between two points, rounded up to a whole km; null when either is missing. */
export function roadKm(from: Point | null | undefined, to: Point | null | undefined): number | null {
  if (!from || !to) return null;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(to.lat - from.lat);
  const dLng = rad(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLng / 2) ** 2;
  const km = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * ROAD_FACTOR;
  return Math.max(1, Math.ceil(km));
}

/** `base` for the first `includedKm`, then `perKm` for each km after. Unknown distance: the base only. */
export const rateFor = (rate: DeliveryFee, km: number | null) => rate.base + rate.perKm * Math.max(0, (km ?? 0) - rate.includedKm);

export const shopFeeOf = (shop: BusinessDoc): DeliveryFee => shop.pod?.deliveryFee ?? FREE_DELIVERY;
