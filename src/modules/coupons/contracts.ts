import { Type, type Static, type TSchema } from "typebox";
import { DateTime, Envelope, ListEnvelope, ModuleName, ObjectIdString, PageQuery, Paise, Strict } from "../../contracts/common.js";

const Nullable = <T extends TSchema>(schema: T, options?: { description: string }) => Type.Union([schema, Type.Null()], options);

/** A flat coupon takes at most ₹10,000 off. */
export const MAX_FLAT = 10_000_00;
export const MAX_USES = 1_000_000;
export const MAX_PER_CUSTOMER = 100;

export const Funder = Type.Union([Type.Literal("ruxstar"), Type.Literal("vendor")], {
  description: "Who pays for the discount: Ruxstar, or the vendor out of their share",
});
const Kind = Type.Union([Type.Literal("percent"), Type.Literal("flat")], {
  description: "`percent` takes `value` percent off the items, up to `cap`; `flat` takes `value` paise off",
});
const State = Type.Union(
  [Type.Literal("active"), Type.Literal("scheduled"), Type.Literal("ended"), Type.Literal("used_up"), Type.Literal("off")],
  { description: "`scheduled` hasn't started, `ended` is past its end date, `used_up` reached its limit, `off` is switched off" },
);

export const Coupon = Strict({
  id: ObjectIdString,
  code: Type.String(),
  fundedBy: Funder,
  vendor: Nullable(Strict({ id: ObjectIdString, name: Type.String() })),
  businesses: Type.Array(Strict({ id: ObjectIdString, name: Type.String() }), { description: "The vendor's shops it works at; empty for Ruxstar's" }),
  modules: Type.Array(ModuleName),
  kind: Kind,
  value: Type.Integer(),
  cap: Nullable(Paise),
  label: Type.String({ description: 'For example "20% off up to ₹100" or "₹50 off"' }),
  minOrder: Paise,
  startsAt: Nullable(DateTime),
  endsAt: Nullable(DateTime),
  limit: Nullable(Type.Integer()),
  perCustomer: Nullable(Type.Integer()),
  firstOrderOnly: Type.Boolean(),
  listed: Type.Boolean({ description: "Shown in the offers at checkout" }),
  active: Type.Boolean(),
  stoppedByRuxstar: Type.Boolean({ description: "Ruxstar switched this vendor coupon off; only Ruxstar can switch it back on" }),
  used: Type.Integer({ description: "Paid orders that used it, less ones refunded in full" }),
  state: State,
  createdAt: DateTime,
  updatedAt: DateTime,
});
export type Coupon = Static<typeof Coupon>;
export const CouponOne = Envelope(Coupon);
export const CouponList = ListEnvelope(Coupon);
export const CouponParams = Strict({ id: ObjectIdString });

const Terms = {
  minOrder: Type.Optional(Type.Integer({ minimum: 0, maximum: 5_00_000_00, description: "Paise of items before the discount; 0 for none" })),
  startsAt: Type.Optional(Nullable(DateTime)),
  endsAt: Type.Optional(Nullable(DateTime)),
  limit: Type.Optional(Nullable(Type.Integer({ minimum: 1, maximum: MAX_USES, description: "Uses across everyone; null for no limit" }))),
  perCustomer: Type.Optional(Nullable(Type.Integer({ minimum: 1, maximum: MAX_PER_CUSTOMER, description: "Uses per customer; null for no limit" }))),
  firstOrderOnly: Type.Optional(Type.Boolean({ description: "Only a customer's first paid order: on Ruxstar for Ruxstar's, with this vendor for a vendor's" })),
  listed: Type.Optional(Type.Boolean({ description: "Show it in the offers at checkout (the default)" })),
};

const Discount = {
  code: Type.String({ pattern: "^[A-Za-z0-9]{4,16}$", description: "4 to 16 letters and digits; stored in capitals" }),
  kind: Kind,
  value: Type.Integer({ minimum: 1, maximum: MAX_FLAT, description: "Percent (1 to 100), or paise off (at least ₹1)" }),
  cap: Type.Optional(Nullable(Type.Integer({ minimum: 100, maximum: MAX_FLAT, description: "Percent only: the most it takes off, in paise" }))),
};

export const StaffCreateCouponBody = Strict({ ...Discount, ...Terms });
export const VendorCreateCouponBody = Strict({
  ...Discount,
  ...Terms,
  businessIds: Type.Array(ObjectIdString, { minItems: 1, maxItems: 20, uniqueItems: true, description: "Your print shops it works at" }),
});
export type CreateCouponBody = Static<typeof StaffCreateCouponBody> & { businessIds?: string[] };

export const StaffUpdateCouponBody = Strict({ ...Terms, active: Type.Optional(Type.Boolean()) });
export const VendorUpdateCouponBody = Strict({
  ...Terms,
  active: Type.Optional(Type.Boolean()),
  businessIds: Type.Optional(VendorCreateCouponBody.properties.businessIds),
});
export type UpdateCouponBody = Static<typeof StaffUpdateCouponBody> & { businessIds?: string[] };

export const StaffCouponsQuery = Strict({
  ...PageQuery,
  funder: Type.Optional(Type.Union([Type.Literal("ruxstar"), Type.Literal("vendor")], { description: "Ruxstar's coupons (the default) or vendors'" })),
  code: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9]{1,16}$", description: "Find one code" })),
});
export const VendorCouponsQuery = Strict({ ...PageQuery });

/** A coupon a customer can pick at checkout. */
export const Offer = Strict({
  code: Type.String(),
  fundedBy: Funder,
  label: Type.String(),
  terms: Nullable(Type.String({ description: 'For example "On items over ₹200 · First order only · Ends 30 Nov"' })),
  discount: Type.Integer({ minimum: 0, description: "Paise it takes off this order; 0 when it doesn't apply yet" }),
  problem: Nullable(Type.String({ description: 'Why it doesn\'t apply yet, for example "Add ₹50 more to use this"' })),
});
export type Offer = Static<typeof Offer>;

export const AppliedCoupon = Strict({ code: Type.String(), fundedBy: Funder, label: Type.String({ description: '"Ruxstar offer" or "Shop offer"' }) });
