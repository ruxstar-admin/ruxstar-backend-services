import { Type, type Static, type TSchema } from "typebox";
import { DateTime, Envelope, ListEnvelope, ObjectIdString, PageQuery, Paise, Strict } from "../../contracts/common.js";
import { GSTIN_PATTERN } from "../kyc/contracts.js";

const Nullable = <T extends TSchema>(schema: T, options: { description?: string } = {}) => Type.Union([schema, Type.Null()], options);

export const InvoiceKind = Type.Union([Type.Literal("tax_invoice"), Type.Literal("bill_of_supply"), Type.Literal("credit_note")], {
  description: "tax_invoice: a sale with GST. bill_of_supply: a sale without GST, when the seller has no GSTIN. credit_note: money refunded against an invoice.",
});
export const GstModuleName = Type.Union(
  [Type.Literal("pod"), Type.Literal("events"), Type.Literal("coaching"), Type.Literal("stays"), Type.Literal("turf"), Type.Literal("ecommerce")],
  { description: "ecommerce has defaults ready for when it opens" },
);
const Issuer = Type.Union([Type.Literal("vendor"), Type.Literal("ruxstar")], { description: "Whose document it is: the business's, or Ruxstar's" });
const Role = Type.Union([Type.Literal("supply"), Type.Literal("fee")], { description: "supply: what was bought. fee: Ruxstar's platform fee." });

/** What an order shows about each of its GST documents. */
export const InvoiceRef = Strict({
  id: ObjectIdString,
  kind: InvoiceKind,
  number: Type.String({ maxLength: 16 }),
  issuer: Issuer,
  role: Role,
  total: Paise,
  refundId: Nullable(Type.String(), { description: "Credit notes: the refund behind it" }),
  issuedAt: DateTime,
});
export type InvoiceRef = Static<typeof InvoiceRef>;
export const InvoiceRefs = Type.Optional(
  Type.Array(InvoiceRef, { description: "GST invoices and credit notes for it, oldest first. Open one with its invoice routes." }),
);

const Party = Strict({
  name: Type.String(),
  legalName: Nullable(Type.String()),
  gstin: Nullable(Type.String()),
  address: Nullable(Type.String()),
  state: Nullable(Type.String()),
  stateCode: Nullable(Type.String({ description: "Two-digit GST state code" })),
});

const Line = Strict({
  description: Type.String(),
  code: Type.String({ description: "HSN for goods, SAC for services; empty when not set" }),
  codeKind: Type.Union([Type.Literal("hsn"), Type.Literal("sac")]),
  quantity: Type.Integer({ minimum: 0 }),
  unitPrice: Type.Integer({ minimum: 0, description: "Paise per unit, as charged" }),
  discount: Type.Integer({ minimum: 0, description: "Paise off the line by the seller" }),
  rateBps: Type.Integer({ minimum: 0, description: "GST rate in basis points: 1800 = 18%" }),
  taxable: Paise,
  cgst: Paise,
  sgst: Paise,
  igst: Paise,
  total: Type.Integer({ minimum: 0, description: "Paise: taxable value plus tax" }),
});

export const Invoice = Strict({
  id: ObjectIdString,
  kind: InvoiceKind,
  number: Type.String({ maxLength: 16, description: "Consecutive within the seller's series for the financial year" }),
  fy: Type.String({ description: "Indian financial year, for example 2026-27" }),
  issuer: Issuer,
  role: Role,
  module: GstModuleName,
  order: Strict({
    type: Type.Union([Type.Literal("pod_order"), Type.Literal("event_order"), Type.Literal("coaching_order"), Type.Literal("turf_booking")]),
    id: ObjectIdString,
    orderNo: Type.Integer(),
  }),
  business: Strict({ id: ObjectIdString, name: Type.String() }),
  seller: Party,
  buyer: Party,
  operator: Nullable(Strict({ name: Type.String(), gstin: Nullable(Type.String()) }), { description: "Ruxstar as the e-commerce operator, on a business's documents" }),
  placeOfSupply: Nullable(Strict({ state: Type.String(), code: Type.String() })),
  supply: Type.Union([Type.Literal("intra"), Type.Literal("inter")], { description: "intra: CGST and SGST. inter: IGST." }),
  operatorPays: Type.Boolean({ description: "Ruxstar pays the GST on the business's sale as the e-commerce operator (section 9(5))" }),
  lines: Type.Array(Line),
  totals: Strict({
    taxable: Paise,
    cgst: Paise,
    sgst: Paise,
    igst: Paise,
    tax: Paise,
    total: Paise,
    ruxstarDiscount: Type.Integer({ minimum: 0, description: "A Ruxstar coupon: paid to the seller by Ruxstar, not by the customer" }),
    payable: Type.Integer({ description: "Total less the Ruxstar discount" }),
  }),
  tcs: Nullable(Strict({ rateBps: Type.Integer({ minimum: 0 }), amount: Paise }), {
    description: "Tax Ruxstar collects at source on the business's sale. Shown to the business and the console only",
  }),
  against: Nullable(Strict({ id: ObjectIdString, number: Type.String(), issuedAt: DateTime }), { description: "Credit notes: the invoice it reduces" }),
  refund: Nullable(Strict({ id: Type.String(), reason: Nullable(Type.String()) }), { description: "Credit notes: the refund behind it" }),
  credited: Type.Integer({ minimum: 0, description: "Invoices: paise credited back so far" }),
  notes: Type.Array(Type.String()),
  issuedAt: DateTime,
  pdfUrl: Type.String({ description: "Opens the PDF without signing in; works for 10 minutes. Add `download=1` to save it instead" }),
});
export type Invoice = Static<typeof Invoice>;
export const InvoiceOne = Envelope(Invoice);
export const InvoiceList = ListEnvelope(Invoice);
export const InvoiceParams = Strict({ id: ObjectIdString });

const dayOrTime = (description: string) =>
  Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2}))?$", maxLength: 40, description });
const listFilters = {
  from: Type.Optional(dayOrTime("Issued on or after: a day (YYYY-MM-DD, India time) or an exact ISO 8601 time")),
  to: Type.Optional(dayOrTime("Issued on or before: a day (YYYY-MM-DD, India time, the whole day) or an exact ISO 8601 time")),
  orderId: Type.Optional(ObjectIdString),
  module: Type.Optional(GstModuleName),
};
export const MyInvoicesQuery = Strict({ ...PageQuery, ...listFilters });
export const VendorInvoicesQuery = Strict({ ...PageQuery, business: Type.Optional(ObjectIdString), kind: Type.Optional(InvoiceKind), ...listFilters });
const Day = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", description: "YYYY-MM-DD, India time" });
export const InvoiceExportQuery = Strict({ from: Day, to: Day, business: Type.Optional(ObjectIdString) });
export const StaffInvoicesQuery = Strict({
  ...PageQuery,
  kind: Type.Optional(InvoiceKind),
  number: Type.Optional(Type.String({ minLength: 1, maxLength: 16, description: "Exact document number" })),
  orderNo: Type.Optional(Type.Integer({ minimum: 1 })),
  business: Type.Optional(ObjectIdString),
  ...listFilters,
});

// GST settings in the console.

const Bps = Type.Integer({ minimum: 0, maximum: 4000, description: "Basis points: 1800 = 18%" });
const Code = Type.String({ pattern: "^([0-9]{4,8})?$", description: "HSN or SAC, 4 to 8 digits" });
const CodeKind = Type.Union([Type.Literal("hsn"), Type.Literal("sac")], { description: "hsn for goods, sac for services" });
const LowRate = Nullable(Strict({ upTo: Type.Integer({ minimum: 1, maximum: 1_000_000_000, description: "Paise per unit" }), rateBps: Bps }), {
  description: "Units priced at or below `upTo` (tax included) use this rate instead",
});
const rateFields = { code: Code, codeKind: CodeKind, rateBps: Bps, lowRate: LowRate };
const GstItem = Strict({
  key: Type.String({ pattern: "^[a-z_]{2,40}$", description: "A print product, an event kind (show, sports, meetup) or a business type (pg, hostel)" }),
  label: Type.String({ minLength: 2, maxLength: 60 }),
  ...rateFields,
});
const moduleFields = {
  enabled: Type.Boolean({ description: "Issue GST documents for this module's orders" }),
  seller: Type.Union([Type.Literal("vendor"), Type.Literal("ruxstar")], {
    description: "vendor: the business sells and Ruxstar is the e-commerce operator. ruxstar: Ruxstar invoices the sale itself.",
  }),
  withoutGstin: Type.Union([Type.Literal("bill_of_supply"), Type.Literal("ruxstar")], {
    description: "A business without a GSTIN: it issues a bill of supply, or Ruxstar invoices the sale and pays the GST (section 9(5))",
  }),
  ...rateFields,
  items: Type.Array(GstItem, { maxItems: 30, description: "Rates for one product or kind of business; the rest use the module's" }),
  pricesIncludeTax: Type.Boolean({ description: "Prices customers see include GST" }),
  tcsBps: Type.Integer({ minimum: 0, maximum: 200, description: "Tax collected at source on registered businesses' sales, in basis points" }),
};
export const GstModuleSettings = Strict({ module: GstModuleName, ...moduleFields, updatedAt: Nullable(DateTime, { description: "Null while on the defaults" }) });
export type GstModuleSettings = Static<typeof GstModuleSettings>;
export const GstModuleParams = Strict({ module: GstModuleName });
export const GstModulePatch = Type.Partial(Strict(moduleFields), { additionalProperties: false, minProperties: 1 });
export const GstModuleOne = Envelope(GstModuleSettings);

const Address = Strict({
  line: Type.String({ minLength: 3, maxLength: 200 }),
  city: Type.String({ minLength: 2, maxLength: 60 }),
  state: Type.String({ minLength: 2, maxLength: 60, description: "One of the states in the vendor catalog" }),
  pincode: Type.String({ pattern: "^[1-9][0-9]{5}$" }),
});
const sellerFields = {
  legalName: Type.String({ minLength: 2, maxLength: 120 }),
  tradeName: Type.String({ minLength: 2, maxLength: 120 }),
  gstin: Nullable(Type.String({ pattern: GSTIN_PATTERN })),
  address: Nullable(Address),
  feeCode: Code,
  feeRateBps: Bps,
};
export const GstSellerSettings = Strict(
  { ...sellerFields, updatedAt: Nullable(DateTime) },
  { description: "Ruxstar's own details for its invoices (platform fee, and sales it invoices itself) and as the operator on businesses' invoices" },
);
export type GstSellerSettings = Static<typeof GstSellerSettings>;
export const GstSellerPatch = Type.Partial(Strict(sellerFields), { additionalProperties: false, minProperties: 1 });
export const GstSellerOne = Envelope(GstSellerSettings);
export const GstSettingsOne = Envelope(Strict({ seller: GstSellerSettings, modules: Type.Array(GstModuleSettings) }));
