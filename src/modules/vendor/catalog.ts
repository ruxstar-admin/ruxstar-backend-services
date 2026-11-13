import type { BusinessModule } from "../../platform/db.js";

/** What a vendor picks first when adding a business: one category per module, as in v1. */
export const CATEGORIES: readonly { module: BusinessModule; label: string; description: string }[] = [
  { module: "pod", label: "Print on demand", description: "Custom printing, merchandise and branding on order" },
  { module: "events", label: "Events and tournaments", description: "Sell tickets and manage live events" },
  { module: "coaching", label: "Coaching & classes", description: "Tutoring, fitness and skill coaching" },
  { module: "stays", label: "PG & hostel stays", description: "Rooms and beds by the month" },
];

export const BUSINESS_TYPES = ["print_shop", "concert", "sports_event", "coaching", "pg", "hostel"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const TYPES: readonly {
  id: BusinessType;
  module: BusinessModule;
  label: string;
  description: string;
  examples: string;
  namePlaceholder: string;
  detailHint: string;
}[] = [
  {
    id: "print_shop",
    module: "pod",
    label: "Print on demand",
    description: "Custom printing, apparel, merchandise and branding, made to order",
    examples: "Print shop, merch, banners, corporate and event printing",
    namePlaceholder: "e.g. City Print Hub",
    detailHint: "You'll pick the print categories you serve and your area after this step.",
  },
  {
    id: "concert",
    module: "events",
    label: "Concerts & live shows",
    description: "Live events, festivals, performances",
    examples: "Concert hall, event organiser",
    namePlaceholder: "e.g. Live Arena",
    detailHint: "Describe your venue or brand. Event listings come after onboarding.",
  },
  {
    id: "sports_event",
    module: "events",
    label: "Sports events",
    description: "Matches, tournaments, ticketed sports",
    examples: "Stadium, sports club events",
    namePlaceholder: "e.g. Champions Turf Events",
    detailHint: "Your organisation name and where events are held.",
  },
  {
    id: "coaching",
    module: "coaching",
    label: "Coaching & classes",
    description: "Tutoring, fitness, skill coaching",
    examples: "Tuition, yoga, music class",
    namePlaceholder: "e.g. Ace Coaching",
    detailHint: "Your coaching brand or academy name.",
  },
  {
    id: "pg",
    module: "stays",
    label: "PG",
    description: "Paying guest rooms with meals and house rules",
    examples: "Boys PG, girls PG, co-ed PG",
    namePlaceholder: "e.g. Green Nest PG",
    detailHint: "The name residents know your PG by. Rooms and beds come after this step.",
  },
  {
    id: "hostel",
    module: "stays",
    label: "Hostel",
    description: "Shared dorms and rooms for students and working people",
    examples: "Student hostel, working professionals hostel",
    namePlaceholder: "e.g. Campus Stay Hostel",
    detailHint: "The name residents know your hostel by. Rooms and beds come after this step.",
  },
];

export const typeOf = (id: BusinessType) => TYPES.find((t) => t.id === id)!;
/** The type an older business gets when it has none. */
export const DEFAULT_TYPE: Record<BusinessModule, BusinessType> = { pod: "print_shop", events: "concert", coaching: "coaching", stays: "pg" };

const APPAREL_SIZES = ["XS", "S", "M", "L", "XL", "XXL", "3XL"];
const PAPER_SIZES = ["A6", "A5", "A4", "A3", "A2", "A1", "Custom"];
const APPAREL_PRINT = ["Screen Print", "Digital / DTG", "Sublimation", "Vinyl", "Embroidery"];
const PAPER_PRINT = ["Digital", "Offset", "UV Print"];
const COLOURS = ["Full Colour", "Black & White", "Single Colour", "Custom Palette"];
const APPAREL_SIDES = ["Front", "Back", "Both"];
const FABRICS = ["Cotton", "Polyester", "Cotton Blend", "Other"];

export const POD_PRODUCTS = [
  "tshirts",
  "hoodies",
  "jerseys",
  "business_cards",
  "posters",
  "flex_banners",
  "stickers",
  "invitations",
  "photo_prints",
  "documents",
] as const;
export type PodProduct = (typeof POD_PRODUCTS)[number];

/** Priced by the unit (base price plus extras) or, for documents, by the page. */
export type PricingModel = "per_unit" | "per_page";
export type UnitOption = "sides" | "size" | "printType" | "material" | "color";
export type PageOption = "paperSize" | "binding" | "doubleSided";

export interface PodProductInfo {
  id: PodProduct;
  label: string;
  description: string;
  pricing: PricingModel;
  /** The smallest order a customer can place, unless the vendor sets a higher one. */
  minQuantity: number;
  /** The values a vendor can charge extra for, by option. */
  options: Partial<Record<UnitOption | PageOption, readonly string[]>>;
}

const product = (
  id: PodProduct,
  label: string,
  description: string,
  o: { minQuantity?: number; sizes?: string[]; materials?: string[]; printTypes?: string[]; colors?: string[]; sides?: string[] } = {},
): PodProductInfo => ({
  id,
  label,
  description,
  pricing: "per_unit",
  minQuantity: o.minQuantity ?? 1,
  options: {
    ...(o.sides ? { sides: o.sides } : {}),
    size: o.sizes ?? APPAREL_SIZES,
    printType: o.printTypes ?? APPAREL_PRINT,
    material: o.materials ?? FABRICS,
    color: o.colors ?? COLOURS,
  },
});

/** The v1 print catalog. */
export const PRODUCTS: readonly PodProductInfo[] = [
  product("tshirts", "T-Shirts", "Custom printed tees", { sides: APPAREL_SIDES }),
  product("hoodies", "Hoodies", "Hooded sweatshirts", { sides: APPAREL_SIDES }),
  product("jerseys", "Jerseys", "Team & sports jerseys", { printTypes: ["Sublimation", "Screen Print", "Heat Transfer", "Embroidery"], sides: APPAREL_SIDES }),
  product("business_cards", "Business Cards", "Professional visiting cards", {
    minQuantity: 100,
    sizes: ["Standard (90×54 mm)", "Square", "Mini", "Custom"],
    materials: ["300 GSM Art Card", "350 GSM Premium", "Textured", "Kraft"],
    printTypes: ["Single-sided", "Double-sided", "Matte lamination", "Gloss lamination"],
    colors: ["Full Colour", "Black & White", "Single Colour"],
  }),
  product("posters", "Posters", "Posters & wall prints", { sizes: PAPER_SIZES, materials: ["Art Paper", "Matte", "Glossy", "Canvas"], printTypes: PAPER_PRINT }),
  product("flex_banners", "Flex Banners", "Outdoor & event banners", {
    sizes: ["2×3 ft", "3×5 ft", "4×6 ft", "6×8 ft", "Custom"],
    materials: ["Flex Vinyl", "Star Flex", "Backlit", "Fabric"],
    printTypes: ["Frontlit", "Backlit", "Star flex", "Mesh"],
    colors: ["Full Colour"],
  }),
  product("stickers", "Stickers", "Labels & sticker sheets", {
    minQuantity: 25,
    sizes: ["Small (5 cm)", "Medium (8 cm)", "Large (12 cm)", "Custom shape"],
    materials: ["Vinyl", "Paper", "Transparent", "Holographic"],
    printTypes: ["Die-cut", "Kiss-cut", "Sheet stickers"],
    colors: ["Full Colour", "Single Colour", "White ink"],
  }),
  product("invitations", "Invitations", "Wedding & event invites", {
    minQuantity: 25,
    sizes: PAPER_SIZES,
    materials: ["Textured", "Matte", "Glossy", "Handmade paper"],
    printTypes: ["Flat card", "Folded card", "With envelope"],
  }),
  product("photo_prints", "Photo Prints", "Photo lab prints", {
    sizes: ["4×6 in", "5×7 in", "8×10 in", "12×18 in", "Custom"],
    materials: ["Glossy", "Matte", "Lustre", "Canvas"],
    printTypes: ["Standard print", "Canvas wrap", "Framed (vendor quote)"],
    colors: ["Full Colour"],
  }),
  {
    id: "documents",
    label: "Document Printing",
    description: "Documents, reports & xerox",
    pricing: "per_page",
    minQuantity: 1,
    options: { paperSize: PAPER_SIZES, binding: ["None", "Stapled", "Spiral bind", "Soft cover"], doubleSided: ["Double-sided"] },
  },
];

export const productOf = (id: PodProduct) => PRODUCTS.find((p) => p.id === id)!;

export const MAX_POD_CITIES = 50;
export const MAX_TURNAROUND_DAYS = 30;
export const MAX_PRICE_TIERS = 10;
