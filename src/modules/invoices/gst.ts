import type { ClientSession } from "mongodb";
import type { Database, GstModule, GstRate, GstRules, GstSeller } from "../../platform/db.js";
import { INDIA } from "../vendor/india.js";

export const GST_MODULES: readonly GstModule[] = ["pod", "events", "coaching", "stays", "turf", "ecommerce", "gigs"];

const rate = (code: string, codeKind: GstRate["codeKind"], rateBps: number, lowRate: GstRate["lowRate"] = null): GstRate => ({ code, codeKind, rateBps, lowRate });
const item = (key: string, label: string, r: GstRate) => ({ key, label, ...r });

/** Apparel at ₹2,500 or less a piece is 5%, above it 18% (GST rates from 22 Sep 2025). */
const APPAREL = (code: string) => rate(code, "hsn", 1800, { upTo: 2_500_00, rateBps: 500 });
/** Admission to shows and sports at ₹500 or less a person is exempt. */
const ADMISSION = rate("9996", "sac", 1800, { upTo: 500_00, rateBps: 0 });

/** What every module starts with: on, the vendor sells, prices include GST, and 0.5% TCS on registered vendors' sales. */
const BASE: Omit<GstRules, keyof GstRate> = { enabled: true, seller: "vendor", withoutGstin: "bill_of_supply", pricesIncludeTax: true, tcsBps: 50, items: [] };

/** The defaults until a Ruxstar admin changes them. A new module only needs a row here. */
export const DEFAULT_GST_RULES: Record<GstModule, GstRules> = {
  pod: {
    ...BASE,
    ...rate("4911", "hsn", 1800),
    items: [
      item("tshirts", "T-Shirts", APPAREL("6109")),
      item("hoodies", "Hoodies", APPAREL("6110")),
      item("jerseys", "Jerseys", APPAREL("6110")),
      item("business_cards", "Business Cards", rate("4911", "hsn", 1800)),
      item("posters", "Posters", rate("4911", "hsn", 1800)),
      item("flex_banners", "Flex Banners", rate("4911", "hsn", 1800)),
      item("stickers", "Stickers", rate("4821", "hsn", 1800)),
      item("invitations", "Invitations", rate("4909", "hsn", 1800)),
      item("photo_prints", "Photo Prints", rate("4911", "hsn", 1800)),
      item("documents", "Document Printing", rate("998912", "sac", 1800)),
    ],
  },
  events: {
    ...BASE,
    ...rate("9996", "sac", 1800),
    items: [item("show", "Concerts & shows", ADMISSION), item("sports", "Sports", ADMISSION), item("meetup", "Workshops & meetups", rate("9996", "sac", 1800))],
  },
  coaching: { ...BASE, ...rate("999293", "sac", 1800) },
  stays: {
    ...BASE,
    ...rate("996322", "sac", 500),
    withoutGstin: "ruxstar",
    items: [
      // Stays of 90 days or more at ₹20,000 a month or less are exempt.
      item("pg", "PG", rate("996322", "sac", 500, { upTo: 20_000_00, rateBps: 0 })),
      item("hostel", "Hostel", rate("996322", "sac", 1800, { upTo: 7_500_00, rateBps: 500 })),
    ],
  },
  turf: { ...BASE, ...rate("999652", "sac", 1800) },
  ecommerce: { ...BASE, ...rate("", "hsn", 1800) },
  // Freelance work is a service at 18%; each item is keyed by a freelancers category.
  gigs: {
    ...BASE,
    ...rate("998399", "sac", 1800),
    items: [
      item("design", "Graphic and logo design", rate("998391", "sac", 1800)),
      item("video_editing", "Video editing", rate("999612", "sac", 1800)),
      item("photography", "Photography", rate("998381", "sac", 1800)),
      item("writing", "Writing and translation", rate("998395", "sac", 1800)),
      item("social_media", "Social media", rate("998361", "sac", 1800)),
      item("websites", "Websites and apps", rate("998314", "sac", 1800)),
    ],
  },
};

export const DEFAULT_GST_SELLER: GstSeller = { legalName: "Ruxstar", tradeName: "Ruxstar", gstin: null, address: null, feeCode: "998599", feeRateBps: 1800 };

export const moduleKey = (module: GstModule) => `gst.module.${module}`;
export const SELLER_KEY = "gst.seller";

/** One module's rules: the defaults with whatever the admin changed on top. */
export async function gstRules(db: Database, module: GstModule, session?: ClientSession): Promise<GstRules & { updatedAt: Date | null }> {
  const doc = await db.platformSettings.findOne({ key: moduleKey(module) }, { session });
  return { ...DEFAULT_GST_RULES[module], ...(doc?.value as Partial<GstRules> | undefined), updatedAt: doc?.updatedAt ?? null };
}

export async function gstSeller(db: Database, session?: ClientSession): Promise<GstSeller & { updatedAt: Date | null }> {
  const doc = await db.platformSettings.findOne({ key: SELLER_KEY }, { session });
  return { ...DEFAULT_GST_SELLER, ...(doc?.value as Partial<GstSeller> | undefined), updatedAt: doc?.updatedAt ?? null };
}

/** The rate for one product or kind of business, or the module's own. */
export function rateFor(rules: GstRules, key: string | null): GstRate {
  const found = key ? rules.items.find((i) => i.key === key) : undefined;
  const { code, codeKind, rateBps, lowRate } = found ?? rules;
  return { code, codeKind, rateBps, lowRate };
}

/** The rate a unit at this price pays. */
export const bpsAt = (r: GstRate, unitPrice: number) => (r.lowRate && unitPrice <= r.lowRate.upTo ? r.lowRate.rateBps : r.rateBps);

// States.

export const STATE_CODES: Readonly<Record<string, string>> = {
  "Jammu and Kashmir": "01",
  "Himachal Pradesh": "02",
  Punjab: "03",
  Chandigarh: "04",
  Uttarakhand: "05",
  Haryana: "06",
  Delhi: "07",
  Rajasthan: "08",
  "Uttar Pradesh": "09",
  Bihar: "10",
  Sikkim: "11",
  "Arunachal Pradesh": "12",
  Nagaland: "13",
  Manipur: "14",
  Mizoram: "15",
  Tripura: "16",
  Meghalaya: "17",
  Assam: "18",
  "West Bengal": "19",
  Jharkhand: "20",
  Odisha: "21",
  Chhattisgarh: "22",
  "Madhya Pradesh": "23",
  Gujarat: "24",
  "Dadra and Nagar Haveli and Daman and Diu": "26",
  Maharashtra: "27",
  Karnataka: "29",
  Goa: "30",
  Lakshadweep: "31",
  Kerala: "32",
  "Tamil Nadu": "33",
  Puducherry: "34",
  "Andaman and Nicobar Islands": "35",
  Telangana: "36",
  "Andhra Pradesh": "37",
  Ladakh: "38",
};

export const stateOfCode = (code: string) => Object.keys(STATE_CODES).find((s) => STATE_CODES[s] === code) ?? null;
/** A GSTIN starts with its state's code. */
export const stateOfGstin = (gstin: string | null | undefined) => (gstin ? stateOfCode(gstin.slice(0, 2)) : null);

/** Cities listed under exactly one state. */
const CITY_STATE = (() => {
  const seen = new Map<string, string | null>();
  for (const [state, cities] of INDIA) {
    for (const city of [state, ...cities]) {
      const key = city.toLowerCase();
      seen.set(key, seen.has(key) && seen.get(key) !== state ? null : state);
    }
  }
  return seen;
})();

/** By the first three digits of a PIN code; earlier rows win. */
const PIN_STATES: readonly [from: number, to: number, state: string][] = [
  [110, 110, "Delhi"],
  [160, 160, "Chandigarh"],
  [194, 194, "Ladakh"],
  [246, 246, "Uttarakhand"],
  [248, 249, "Uttarakhand"],
  [262, 263, "Uttarakhand"],
  [403, 403, "Goa"],
  [737, 737, "Sikkim"],
  [744, 744, "Andaman and Nicobar Islands"],
  [790, 792, "Arunachal Pradesh"],
  [793, 794, "Meghalaya"],
  [795, 795, "Manipur"],
  [796, 796, "Mizoram"],
  [797, 798, "Nagaland"],
  [799, 799, "Tripura"],
  [814, 816, "Jharkhand"],
  [822, 822, "Jharkhand"],
  [825, 829, "Jharkhand"],
  [831, 835, "Jharkhand"],
  [120, 136, "Haryana"],
  [140, 159, "Punjab"],
  [170, 177, "Himachal Pradesh"],
  [180, 193, "Jammu and Kashmir"],
  [200, 285, "Uttar Pradesh"],
  [300, 345, "Rajasthan"],
  [360, 396, "Gujarat"],
  [400, 445, "Maharashtra"],
  [450, 489, "Madhya Pradesh"],
  [490, 497, "Chhattisgarh"],
  [500, 509, "Telangana"],
  [510, 539, "Andhra Pradesh"],
  [560, 591, "Karnataka"],
  [600, 643, "Tamil Nadu"],
  [670, 695, "Kerala"],
  [700, 743, "West Bengal"],
  [750, 770, "Odisha"],
  [780, 788, "Assam"],
  [800, 855, "Bihar"],
];

/** The state of an Indian address: its city when that names one state, else its PIN code. Null when neither tells. */
export function stateOfPlace(city: string | null | undefined, pincode?: string | null): string | null {
  const byCity = city ? CITY_STATE.get(city.trim().toLowerCase()) : null;
  if (byCity) return byCity;
  const prefix = pincode && /^[1-9][0-9]{5}$/.test(pincode) ? Number(pincode.slice(0, 3)) : null;
  if (prefix === null) return null;
  return PIN_STATES.find(([from, to]) => prefix >= from && prefix <= to)?.[2] ?? null;
}

// Numbering.

const MONTH_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" });

/** The Indian financial year, April to March, for example 2026-27. */
export function financialYear(at: Date): string {
  const [year, month] = MONTH_FORMAT.format(at).split("-").map(Number) as [number, number];
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** At most 16 characters: INV/26-27/00001, with more digits once the year passes 99,999 documents. */
export function formatNumber(prefix: string, fy: string, seq: number): string {
  const short = fy.slice(2);
  const digits = String(seq).padStart(5, "0");
  return digits.length <= 6 ? `${prefix}/${short}/${digits}` : `${prefix}${short.replace("-", "")}${digits}`;
}

/** The next number in one seller's series for one kind of document and year. Inside a transaction, so an abandoned one leaves no gap. */
export async function nextInvoiceNumber(db: Database, series: string, prefix: string, fy: string, session: ClientSession): Promise<string> {
  return formatNumber(prefix, fy, await db.nextNumber(series, session));
}

// Tax.

/**
 * Splits a tax-inclusive amount into its taxable value and tax at `rateBps`, as CGST and SGST in the seller's own state
 * or IGST across states.
 */
export function taxOf(value: number, rateBps: number, supply: "intra" | "inter") {
  const taxable = Math.round((value * 10_000) / (10_000 + rateBps));
  const tax = value - taxable;
  const cgst = supply === "intra" ? Math.floor(tax / 2) : 0;
  const sgst = supply === "intra" ? tax - cgst : 0;
  return { taxable, cgst, sgst, igst: supply === "inter" ? tax : 0, total: value };
}
