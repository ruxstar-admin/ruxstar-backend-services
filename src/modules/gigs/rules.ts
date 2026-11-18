import type { ClientSession } from "mongodb";
import type { Database, GigCategory, GigOrderDoc, GigRefundDoc, GigsRules, GigTier, LedgerEntryDoc } from "../../platform/db.js";

export const DEFAULT_GIG_CATEGORIES: GigCategory[] = [
  { key: "design", label: "Graphic and logo design", hidden: false },
  { key: "video_editing", label: "Video editing", hidden: false },
  { key: "photography", label: "Photography", hidden: false },
  { key: "writing", label: "Writing and translation", hidden: false },
  { key: "social_media", label: "Social media", hidden: false },
  { key: "websites", label: "Websites and apps", hidden: false },
  { key: "other", label: "Anything else", hidden: false },
];

/** What can be uploaded, by extension, and the type it is served as. Pages and scripts aren't on it; only images and PDFs open in the browser. */
export const FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  psd: "image/vnd.adobe.photoshop",
  ai: "application/postscript",
  eps: "application/postscript",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  zip: "application/zip",
  txt: "text/plain",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ttf: "font/ttf",
  otf: "font/otf",
};
export const FILE_EXTENSIONS = Object.keys(FILE_TYPES);

/** The most Ruxstar can set each limit to. Request bodies are held to these; the stored limits are checked after. */
export const LIMIT_CAPS = { maxPortfolio: 30, maxGigPhotos: 10, maxQuestions: 10, maxFiles: 20, maxLinks: 20, maxAnswer: 2000 } as const;

export const DEFAULT_GIGS_RULES: GigsRules = {
  autoCompleteDays: 3,
  acceptHours: 24,
  quoteDays: 7,
  deliveryMaxMb: 25,
  fileDays: 90,
  maxGigs: 10,
  maxPackages: 3,
  minPrice: 100_00,
  maxPrice: 2_00_000_00,
  minDays: 1,
  maxDays: 60,
  maxRevisions: 10,
  maxPortfolio: 12,
  maxGigPhotos: 5,
  maxQuestions: 5,
  maxFiles: 10,
  maxLinks: 10,
  maxAnswer: 1000,
  fileTypes: FILE_EXTENSIONS,
  categories: DEFAULT_GIG_CATEGORIES,
};

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const MB = 1024 * 1024;
/** The request body limit on uploads; the admin's `deliveryMaxMb` can only be lower. */
export const MAX_UPLOAD_MB = 25;
/** An unpaid order's checkout works this long. */
export const PAY_WINDOW_MS = 20 * MINUTE_MS;
/** Cashfree takes up to ₹5,00,000 in one payment. */
export const MAX_ORDER_TOTAL = 5_00_000_00;
/** Uploads not used on an order by then are deleted. */
export const UNUSED_FILE_MS = DAY_MS;
export const TIERS: readonly GigTier[] = ["basic", "standard", "premium"];
export const TIER_NAMES: Record<GigTier, string> = { basic: "Basic", standard: "Standard", premium: "Premium" };

/** Freelance orders are numbered from here, apart from the other modules' orders. */
const FIRST_ORDER_NO = 40_000_000;

export const nextGigOrderNo = async (db: Database, session?: ClientSession) => FIRST_ORDER_NO + (await db.nextNumber("gig-order", session));

export type GigsSettings = GigsRules & { commissionBps: number; platformFee: number; live: boolean; signupsOpen: boolean };

export const gigsRulesOf = (stored: Partial<GigsRules> | undefined): GigsRules => ({ ...DEFAULT_GIGS_RULES, ...stored });

export async function gigsSettings(db: Database): Promise<GigsSettings> {
  const doc = await db.moduleSettings.findOne({ module: "gigs" }, { projection: { gigsRules: 1, commissionBps: 1, platformFee: 1, live: 1, signupsOpen: 1 } });
  return {
    ...gigsRulesOf(doc?.gigsRules),
    commissionBps: doc?.commissionBps ?? 0,
    platformFee: doc?.platformFee ?? 0,
    live: Boolean(doc?.live),
    signupsOpen: doc?.signupsOpen ?? true,
  };
}

/** Rules that don't fit together, or categories that lose a key already in use. */
export function gigsRulesProblem(next: GigsRules, before: GigsRules): { field: string; message: string } | null {
  if (next.deliveryMaxMb > MAX_UPLOAD_MB) return { field: "deliveryMaxMb", message: `Deliveries can be at most ${MAX_UPLOAD_MB} MB.` };
  if (next.minPrice > next.maxPrice) return { field: "maxPrice", message: "The highest price must be at least the lowest." };
  if (next.maxPrice > MAX_ORDER_TOTAL) return { field: "maxPrice", message: "Prices can be at most ₹5,00,000." };
  if (next.minDays > next.maxDays) return { field: "maxDays", message: "The most delivery days must be at least the fewest." };
  const keys = next.categories.map((c) => c.key);
  if (new Set(keys).size !== keys.length) return { field: "categories", message: "Each category needs its own key." };
  const lost = before.categories.find((c) => !keys.includes(c.key));
  if (lost) return { field: "categories", message: `"${lost.label}" can be renamed or hidden, not removed.` };
  if (next.categories.every((c) => c.hidden)) return { field: "categories", message: "Keep at least one category showing." };
  return null;
}

export const categoryLabel = (rules: Pick<GigsRules, "categories">, key: string) => rules.categories.find((c) => c.key === key)?.label ?? "Anything else";

// Days.

export const daysText = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
export const revisionsText = (n: number) => (n === 0 ? "No revisions" : n === 1 ? "1 revision" : `${n} revisions`);

// Money.

const discountFrom = (o: Pick<GigOrderDoc, "price">, fundedBy: "ruxstar" | "vendor") => (o.price.coupon?.fundedBy === fundedBy ? o.price.discount : 0);
/** The freelancer's share: the price less their own coupon and Ruxstar's commission. */
export const vendorShareOf = (o: Pick<GigOrderDoc, "price">) => o.price.items - discountFrom(o, "vendor") - o.price.commission;
/** Ruxstar's commission and platform fee, less a Ruxstar coupon it pays for. */
export const ruxstarShareOf = (o: Pick<GigOrderDoc, "price">) => o.price.commission + o.price.platformFee - discountFrom(o, "ruxstar");
const parts = (o: Pick<GigOrderDoc, "refunds">, side: "vendor" | "ruxstar") => o.refunds.filter((r) => r.kind === "part").reduce((s, r) => s + r[side], 0);
/** What's still waiting for the freelancer, after any part refund. */
export const vendorLeftOf = (o: Pick<GigOrderDoc, "price" | "refunds">) => vendorShareOf(o) - parts(o, "vendor");
const ruxstarLeftOf = (o: Pick<GigOrderDoc, "price" | "refunds">) => ruxstarShareOf(o) - parts(o, "ruxstar");
export const refundedOf = (o: Pick<GigOrderDoc, "refunds">) => o.refunds.reduce((s, r) => s + r.amount, 0);
/** A part refund comes out of the freelancer's share only, and is less than what was paid. */
export const maxPartRefundOf = (o: Pick<GigOrderDoc, "price" | "refunds">) => Math.max(0, Math.min(vendorLeftOf(o), o.price.total - refundedOf(o) - 1));

const vendorAccount = (o: Pick<GigOrderDoc, "vendorId">) => `vendor:${o.vendorId.toHexString()}`;
type Row = [string, LedgerEntryDoc["bucket"], number];
const entries = (txnId: string, kind: LedgerEntryDoc["kind"], o: Pick<GigOrderDoc, "_id">, rows: Row[], at: Date): LedgerEntryDoc[] =>
  rows
    .filter(([, , paise]) => paise !== 0)
    .map(([accountId, bucket, signedPaise]) => ({ txnId, kind, accountId, bucket, signedPaise, source: { type: "gig_order" as const, id: o._id }, at }));

/**
 * A paid order: the freelancer's share and Ruxstar's wait in pending until the order completes. A full refund before then
 * takes what's left of both back out; a release moves what's left to the available balances.
 */
export function gigLedger(kind: "payment" | "release" | "refund", o: GigOrderDoc, at: Date): LedgerEntryDoc[] {
  const vendor = vendorLeftOf(o);
  const ruxstar = ruxstarLeftOf(o);
  const rows: Row[] =
    kind === "payment"
      ? [
          [vendorAccount(o), "pending", vendorShareOf(o)],
          ["ruxstar", "pending", ruxstarShareOf(o)],
          ["gateway", "withdrawable", -o.price.total],
        ]
      : kind === "release"
        ? [
            [vendorAccount(o), "pending", -vendor],
            [vendorAccount(o), "withdrawable", vendor],
            ["ruxstar", "pending", -ruxstar],
            ["ruxstar", "withdrawable", ruxstar],
          ]
        : [
            [vendorAccount(o), "pending", -vendor],
            ["ruxstar", "pending", -ruxstar],
            ["gateway", "withdrawable", vendor + ruxstar],
          ];
  return entries(`${kind}:${o._id.toHexString()}`, kind, o, rows, at);
}

/** A part refund Ruxstar decided comes out of the freelancer's pending share. */
export const partRefundLedger = (o: Pick<GigOrderDoc, "_id" | "vendorId">, refund: GigRefundDoc): LedgerEntryDoc[] =>
  entries(
    `refund:${o._id.toHexString()}:${refund.refundId}`,
    "refund",
    o,
    [
      [vendorAccount(o), "pending", -refund.vendor],
      ["ruxstar", "pending", -refund.ruxstar],
      ["gateway", "withdrawable", refund.amount],
    ],
    refund.at,
  );
