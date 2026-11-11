import { Type, type Static, type TSchema } from "typebox";
import { DateTime, Envelope, ListEnvelope, ObjectIdString, Paise, Strict } from "../../contracts/common.js";
import { GSTIN_PATTERN } from "../kyc/contracts.js";

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** Businesses a vendor can have at once. */
export const MAX_BUSINESSES = 10;
export const MAX_BUSINESS_PHOTOS = 3;
export const IFSC_PATTERN = "^[A-Z]{4}0[A-Z0-9]{6}$";
export const VPA_PATTERN = "^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,64}$";

export const BusinessModule = Type.Union([Type.Literal("pod"), Type.Literal("events"), Type.Literal("coaching"), Type.Literal("stays")], {
  description: "pod is print on demand",
});

export const Address = Strict({
  line1: Type.String({ minLength: 3, maxLength: 120 }),
  line2: Type.Optional(Nullable(Type.String({ maxLength: 120 }))),
  city: Type.String({ minLength: 2, maxLength: 60 }),
  state: Type.String({ minLength: 2, maxLength: 60 }),
  pincode: Type.String({ pattern: "^[1-9][0-9]{5}$" }),
});
const AddressView = Strict({ line1: Type.String(), line2: Nullable(Type.String()), city: Type.String(), state: Type.String(), pincode: Type.String() });

const Photo = Strict({ id: Type.String(), url: Type.String(), width: Type.Integer(), height: Type.Integer() });
const Missing = Type.Union([Type.Literal("description"), Type.Literal("phone"), Type.Literal("address"), Type.Literal("photo")]);

export const Business = Strict({
  id: ObjectIdString,
  module: BusinessModule,
  name: Type.String(),
  description: Nullable(Type.String()),
  phone: Nullable(Type.String()),
  email: Nullable(Type.String()),
  address: Nullable(AddressView),
  gstin: Nullable(Strict({ number: Type.String(), legalName: Nullable(Type.String()), status: Nullable(Type.String()) })),
  photos: Type.Array(Photo),
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
  name: Type.String({ minLength: 2, maxLength: 80 }),
});

export const UpdateBusinessBody = Strict(
  {
    name: Type.Optional(Type.String({ minLength: 2, maxLength: 80 })),
    description: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
    phone: Type.Optional(Nullable(Type.String({ pattern: "^[6-9][0-9]{9}$", description: "10-digit mobile number" }))),
    email: Type.Optional(Nullable(Type.String({ format: "email", maxLength: 120 }))),
    address: Type.Optional(Nullable(Address)),
    gstin: Type.Optional(Nullable(Type.String({ pattern: GSTIN_PATTERN, description: "Checked with the GST network. Null removes it." }))),
  },
  { minProperties: 1 },
);

export const ModuleChoice = Strict({
  module: BusinessModule,
  live: Type.Boolean(),
  signupsOpen: Type.Boolean({ description: "Whether new businesses can be created in it" }),
});
export const ModuleChoices = ListEnvelope(ModuleChoice);

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
  status: Type.Union([Type.Literal("pending"), Type.Literal("paid"), Type.Literal("failed")]),
  to: Type.String(),
  utr: Nullable(Type.String({ description: "The bank's reference once paid" })),
  paidAt: Nullable(DateTime),
  createdAt: DateTime,
});

export const Payments = Envelope(
  Strict({
    balance: Strict({
      available: Paise,
      pending: Paise,
      paidOut: Paise,
    }),
    payoutMethod: Nullable(PayoutMethod),
    payouts: Type.Array(Payout, { description: "The latest 20" }),
  }),
);
