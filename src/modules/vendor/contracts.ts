import { Type, type Static, type TSchema } from "typebox";
import { DateTime, Envelope, ListEnvelope, ModuleName, ObjectIdString, PageQuery, Paise, Strict } from "../../contracts/common.js";
import { GSTIN_PATTERN } from "../kyc/contracts.js";
import { BUSINESS_TYPES, MAX_POD_CITIES, MAX_PRICE_TIERS, MAX_TURNAROUND_DAYS, POD_PRODUCTS } from "./catalog.js";

const Nullable = <T extends TSchema>(schema: T, options: { description?: string } = {}) => Type.Union([schema, Type.Null()], options);

/** Businesses a vendor can have at once. */
export const MAX_BUSINESSES = 10;
export const MAX_BUSINESS_PHOTOS = 3;
export const DESCRIPTION_MAX = 500;
/** ₹1,00,000 in paise: no single price is higher. */
const MAX_PRICE = 10_000_000;
export const IFSC_PATTERN = "^[A-Z]{4}0[A-Z0-9]{6}$";
export const VPA_PATTERN = "^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,64}$";

export const BusinessModule = Type.Union([Type.Literal("pod"), Type.Literal("events"), Type.Literal("coaching"), Type.Literal("stays")], {
  description: "pod is print on demand",
});
export const BusinessTypeId = Type.Enum(BUSINESS_TYPES, { description: "Belongs to one module; GET /v1/vendor/catalog lists them" });
export const PodProductId = Type.Enum(POD_PRODUCTS);

const Phone = Type.String({ pattern: "^[6-9][0-9]{9}$", description: "10-digit mobile number" });
const Part = (max: number) => Type.Optional(Nullable(Type.String({ maxLength: max })));
const Point = Strict({ lat: Type.Number({ minimum: -90, maximum: 90 }), lng: Type.Number({ minimum: -180, maximum: 180 }) });

export const Location = Strict({
  state: Type.String({ minLength: 2, maxLength: 60, description: "One of the catalog's states" }),
  city: Type.String({ minLength: 2, maxLength: 60, description: "One of the state's cities, or any other the vendor types" }),
  doorNo: Part(60),
  building: Part(120),
  street: Part(120),
  area: Part(120),
  pincode: Type.Optional(Nullable(Type.String({ pattern: "^[1-9][0-9]{5}$" }))),
  point: Type.Optional(Nullable(Point)),
});
const LocationView = Strict({
  state: Type.String(),
  city: Type.String(),
  doorNo: Nullable(Type.String()),
  building: Nullable(Type.String()),
  street: Nullable(Type.String()),
  area: Nullable(Type.String()),
  pincode: Nullable(Type.String()),
  point: Nullable(Point),
});

const Extra = Strict({
  option: Type.String({ maxLength: 20, description: "size, material, printType, color or sides; for documents paperSize, binding or doubleSided" }),
  value: Type.String({ maxLength: 60, description: "One of the product's values for that option" }),
  price: Type.Integer({ minimum: 1, maximum: MAX_PRICE, description: "Extra paise per unit, or per page for documents" }),
});
const Tier = Strict({
  from: Type.Integer({ minimum: 2, maximum: 1_000_000, description: "Units, or pages for documents" }),
  unitPrice: Type.Integer({ minimum: 1, maximum: MAX_PRICE, description: "Paise per unit (or page) from this many" }),
});
const Price = Type.Integer({ minimum: 0, maximum: MAX_PRICE, description: "Paise" });

export const PodPriceBody = Strict({
  product: PodProductId,
  minQuantity: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  turnaroundDays: Type.Optional(Nullable(Type.Integer({ minimum: 0, maximum: MAX_TURNAROUND_DAYS }))),
  basePrice: Type.Optional(Nullable(Price)),
  bw: Type.Optional(Nullable(Price)),
  color: Type.Optional(Nullable(Price)),
  extras: Type.Optional(Type.Array(Extra, { maxItems: 60 })),
  tiers: Type.Optional(Type.Array(Tier, { maxItems: MAX_PRICE_TIERS })),
});
const PodPriceView = Strict({
  product: PodProductId,
  model: Type.Union([Type.Literal("per_unit"), Type.Literal("per_page")]),
  minQuantity: Type.Integer(),
  turnaroundDays: Nullable(Type.Integer()),
  basePrice: Nullable(Paise),
  bw: Nullable(Paise),
  color: Nullable(Paise),
  extras: Type.Array(Extra),
  tiers: Type.Array(Tier),
});
const PodSetupView = Strict({
  products: Type.Array(PodProductId),
  serveAll: Type.Boolean({ description: "Takes orders from every city" }),
  cities: Type.Array(Type.String(), { description: "Lower case" }),
  turnaroundDays: Type.Integer(),
  minOrder: Paise,
  notes: Nullable(Type.String()),
  prices: Type.Array(PodPriceView),
  unpriced: Type.Array(PodProductId, { description: "Chosen products still without a price" }),
});

export const PodSetupBody = Strict(
  {
    products: Type.Optional(Type.Array(PodProductId, { maxItems: POD_PRODUCTS.length, uniqueItems: true })),
    serveAll: Type.Optional(Type.Boolean()),
    cities: Type.Optional(Type.Array(Type.String({ minLength: 2, maxLength: 60 }), { maxItems: MAX_POD_CITIES })),
    turnaroundDays: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_TURNAROUND_DAYS })),
    minOrder: Type.Optional(Price),
    notes: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
    prices: Type.Optional(Type.Array(PodPriceBody, { maxItems: POD_PRODUCTS.length, description: "Replaces the prices of the products sent" })),
  },
  { minProperties: 1 },
);

const Photo = Strict({ id: Type.String(), url: Type.String(), width: Type.Integer(), height: Type.Integer() });
const Missing = Type.Union(
  [Type.Literal("photo"), Type.Literal("phone"), Type.Literal("location"), Type.Literal("products"), Type.Literal("area"), Type.Literal("pricing")],
  { description: "products, area and pricing are for print on demand" },
);

export const Business = Strict({
  id: ObjectIdString,
  module: BusinessModule,
  type: BusinessTypeId,
  name: Type.String(),
  description: Nullable(Type.String()),
  phone: Nullable(Type.String()),
  location: Nullable(LocationView),
  gstin: Nullable(Strict({ number: Type.String(), legalName: Nullable(Type.String()), status: Nullable(Type.String()) })),
  photos: Type.Array(Photo, { description: "The first is the cover" }),
  pod: Nullable(PodSetupView),
  status: Type.Union([Type.Literal("draft"), Type.Literal("live")]),
  open: Type.Boolean({ description: "A live business takes orders and bookings only while open" }),
  moduleLive: Type.Boolean({ description: "False while the Ruxstar team has paused this module" }),
  missing: Type.Array(Missing, { description: "What is still needed before it can be published" }),
  suspension: Nullable(Strict({ reason: Type.String(), at: DateTime })),
  publishedAt: Nullable(DateTime),
  createdAt: DateTime,
  updatedAt: DateTime,
});
export type Business = Static<typeof Business>;
export const BusinessList = ListEnvelope(Business);
export const BusinessOne = Envelope(Business);
export const BusinessParams = Strict({ id: ObjectIdString });
export const PhotoParams = Strict({ id: ObjectIdString, photoId: Type.String({ pattern: "^[a-f0-9-]{36}$" }) });

export const CreateBusinessBody = Strict({
  module: BusinessModule,
  type: BusinessTypeId,
  name: Type.String({ minLength: 2, maxLength: 80 }),
  phone: Phone,
  location: Location,
  description: Type.Optional(Nullable(Type.String({ maxLength: DESCRIPTION_MAX }))),
});

export const UpdateBusinessBody = Strict(
  {
    name: Type.Optional(Type.String({ minLength: 2, maxLength: 80 })),
    description: Type.Optional(Nullable(Type.String({ maxLength: DESCRIPTION_MAX }))),
    phone: Type.Optional(Nullable(Phone)),
    location: Type.Optional(Nullable(Location)),
    gstin: Type.Optional(Nullable(Type.String({ pattern: GSTIN_PATTERN, description: "Checked with the GST network. Null removes it." }))),
  },
  { minProperties: 1 },
);

/** Everything the Add a business and setup screens choose from, so the app and the website show the same lists. */
export const Catalog = Envelope(
  Strict({
    categories: Type.Array(
      Strict({
        module: BusinessModule,
        label: Type.String(),
        description: Type.String(),
        live: Type.Boolean(),
        signupsOpen: Type.Boolean({ description: "Whether new businesses can be created in it" }),
        types: Type.Array(
          Strict({
            id: BusinessTypeId,
            label: Type.String(),
            description: Type.String(),
            examples: Type.String(),
            namePlaceholder: Type.String(),
            detailHint: Type.String(),
          }),
        ),
      }),
    ),
    states: Type.Array(Strict({ name: Type.String(), cities: Type.Array(Type.String()) })),
    podProducts: Type.Array(
      Strict({
        id: PodProductId,
        label: Type.String(),
        description: Type.String(),
        pricing: Type.Union([Type.Literal("per_unit"), Type.Literal("per_page")]),
        minQuantity: Type.Integer(),
        options: Type.Array(Strict({ option: Type.String(), values: Type.Array(Type.String()) })),
      }),
    ),
    limits: Strict({
      businesses: Type.Integer(),
      photos: Type.Integer(),
      description: Type.Integer(),
      cities: Type.Integer(),
      turnaroundDays: Type.Integer(),
      tiers: Type.Integer(),
    }),
  }),
);

// Getting paid.

export const PayoutMethod = Strict({
  kind: Type.Union([Type.Literal("bank"), Type.Literal("upi")]),
  label: Type.String({ description: "For example YES BANK ••1191, or asha@upi" }),
  holderName: Nullable(Type.String({ description: "The name the bank has for the account" })),
  ifsc: Nullable(Type.String()),
  verifiedAt: DateTime,
});
export type PayoutMethod = Static<typeof PayoutMethod>;
export const PayoutMethodResult = Envelope(Nullable(PayoutMethod));

export const PayoutMethodBody = Type.Union([
  Strict({
    kind: Type.Literal("bank"),
    accountNumber: Type.String({ pattern: "^[0-9]{9,18}$" }),
    ifsc: Type.String({ pattern: IFSC_PATTERN, description: "11 characters, like YESB0000262" }),
  }),
  Strict({ kind: Type.Literal("upi"), vpa: Type.String({ pattern: VPA_PATTERN, description: "For example asha@okhdfc" }) }),
]);

const Payout = Strict({
  id: ObjectIdString,
  amount: Paise,
  fee: Type.Integer({ minimum: 0, description: "Paise taken from the amount; the bank gets amount - fee" }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("paid"), Type.Literal("failed")]),
  to: Type.String(),
  utr: Nullable(Type.String({ description: "The bank's reference once paid" })),
  paidAt: Nullable(DateTime),
  failure: Nullable(Type.String({ description: "Why it failed, for the vendor; the amount is back in their balance" })),
  createdAt: DateTime,
});
export type Payout = Static<typeof Payout>;

export const PayoutResult = Envelope(Payout);

export const Payments = Envelope(
  Strict({
    balance: Strict({
      available: Paise,
      pending: Paise,
      paidOut: Paise,
    }),
    upcoming: Type.Array(
      Strict({
        orderId: ObjectIdString,
        orderNo: Type.Integer(),
        amount: Paise,
        availableAt: DateTime,
        held: Type.Boolean({ description: "The customer reported a problem; it waits for Ruxstar" }),
      }),
      { description: "Delivered orders whose share is still on hold, soonest first, up to 20" },
    ),
    withdrawal: Strict(
      { minimum: Paise, fee: Paise },
      { description: "The least that can be withdrawn and the fee taken from each withdrawal, both set by Ruxstar" },
    ),
    payoutMethod: Nullable(PayoutMethod),
    payouts: Type.Array(Payout, { description: "The latest 20" }),
  }),
);

export const StatementQuery = Strict({ ...PageQuery });

const StatementLine = Strict({
  id: ObjectIdString,
  kind: Type.Union(
    [Type.Literal("paid"), Type.Literal("available"), Type.Literal("refund"), Type.Literal("withdrawal"), Type.Literal("returned")],
    {
      description:
        "paid: an order's share arrived, pending until its hold ends. available: the hold ended and it can be withdrawn. " +
        "refund: money went back to the customer out of your share. withdrawal: you withdrew it. returned: a withdrawal failed and came back.",
    },
  ),
  amount: Type.Integer({ description: "Paise; negative for refunds and withdrawals" }),
  at: DateTime,
  module: ModuleName,
  order: Nullable(
    Strict({
      id: ObjectIdString,
      orderNo: Type.Integer(),
      business: Nullable(Strict({ id: ObjectIdString, name: Type.String() })),
    }),
    { description: "Set on order lines" },
  ),
  payout: Nullable(Strict({ id: ObjectIdString, to: Type.String() }), { description: "Set on withdrawal lines" }),
});
export type StatementLine = Static<typeof StatementLine>;

export const Statement = ListEnvelope(StatementLine);
