import { Type, type Static, type TSchema } from "typebox";
import { DateTime, Envelope, ListEnvelope, ObjectIdString, PageQuery, Paise, Strict } from "../../contracts/common.js";
import { AppliedCoupon, Offer } from "../coupons/contracts.js";
import { Photo } from "../social/contracts.js";
import { BusinessTypeId, PodProductId } from "../vendor/contracts.js";

const Nullable = <T extends TSchema>(schema: T, options?: { description: string }) => Type.Union([schema, Type.Null()], options);
const PaiseNote = (description: string) => Type.Integer({ minimum: 0, description: `Amount in paise. ${description}` });
const Unit = Type.Union([Type.Literal("unit"), Type.Literal("page")]);

/** A print shop as Discover shows it. */
export const ShopCard = Strict({
  id: ObjectIdString,
  name: Type.String(),
  type: BusinessTypeId,
  typeLabel: Type.String(),
  cover: Nullable(Photo),
  area: Nullable(Type.String()),
  city: Type.String(),
  state: Type.String(),
  open: Type.Boolean({ description: "Taking orders now" }),
  deliversEverywhere: Type.Boolean(),
  fromPrice: Nullable(Paise),
  fromUnit: Nullable(Unit),
  turnaroundDays: Type.Integer({ description: "Usual days to get an order ready; 0 is the same day" }),
  products: Type.Array(PodProductId),
});
export type ShopCard = Static<typeof ShopCard>;

const ShopProduct = Strict({
  id: PodProductId,
  label: Type.String(),
  description: Type.String(),
  pricing: Type.Union([Type.Literal("per_unit"), Type.Literal("per_page")]),
  minQuantity: Type.Integer(),
  turnaroundDays: Type.Integer({ description: "This product's own time, or the shop's usual time" }),
  basePrice: Nullable(Paise),
  bw: Nullable(Paise),
  color: Nullable(Paise),
  extras: Type.Array(Strict({ option: Type.String(), value: Type.String(), price: Paise })),
  tiers: Type.Array(Strict({ from: Type.Integer(), unitPrice: Paise })),
  options: Type.Array(Strict({ option: Type.String(), values: Type.Array(Type.String()) }), {
    description: "Every value a customer can choose, extra or not",
  }),
});

/** The public page of a print shop: what customers can order and how much it costs. The street address and phone are not shown. */
export const Shop = Strict({
  ...ShopCard.properties,
  description: Nullable(Type.String()),
  photos: Type.Array(Photo, { description: "The first is the cover" }),
  pincode: Nullable(Type.String()),
  cities: Type.Array(Type.String(), { description: "Where it delivers, when not everywhere" }),
  minOrder: Paise,
  notes: Nullable(Type.String()),
  catalog: Type.Array(ShopProduct, { description: "Products with a price, in catalog order" }),
});
export type Shop = Static<typeof Shop>;

export const ShopList = ListEnvelope(ShopCard);
export const ShopOne = Envelope(Shop);
export const ShopParams = Strict({ id: ObjectIdString });
export const ShopsQuery = Strict({
  ...PageQuery,
  city: Type.Optional(Type.String({ minLength: 2, maxLength: 60, description: "Shops in or delivering to this city" })),
  product: Type.Optional(PodProductId),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "Part of the shop name" })),
});

// Ordering.

export const PRINT_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const MAX_ORDER_FILES = 10;
export const MAX_QUANTITY = 10_000;

export const PrintFile = Strict({
  id: ObjectIdString,
  name: Type.String(),
  contentType: Type.Union([Type.Literal("application/pdf"), Type.Literal("image/jpeg"), Type.Literal("image/png")]),
  bytes: Type.Integer(),
  pages: Type.Integer({ description: "PDF pages; 1 for a photo" }),
});
export const PrintFileOne = Envelope(PrintFile);
export const PrintFileHeaders = Type.Object({
  "x-file-name": Type.Optional(Type.String({ maxLength: 300, description: "The file's name, URI-encoded" })),
});

export const OrderStatus = Type.Union(
  [
    Type.Literal("awaiting_payment"),
    Type.Literal("placed"),
    Type.Literal("accepted"),
    Type.Literal("printing"),
    Type.Literal("ready"),
    Type.Literal("out_for_delivery"),
    Type.Literal("delivered"),
    Type.Literal("rejected"),
    Type.Literal("cancelled"),
    Type.Literal("refunded"),
  ],
  {
    description:
      "`placed` is paid and waiting for the shop; `rejected` and `cancelled` after payment are refunded. " +
      "`refunded` is an accepted order Ruxstar refunded in full.",
  },
);

const OrderChoice = {
  shopId: ObjectIdString,
  product: PodProductId,
  options: Type.Record(Type.String({ maxLength: 40 }), Type.String({ maxLength: 60 }), {
    description: "Option to value, from the shop's catalog. `size` (or `paperSize` for documents) is required.",
  }),
  colour: Type.Optional(Type.Union([Type.Literal("bw"), Type.Literal("color")], { description: "Documents only, and required for them" })),
  quantity: Type.Integer({ minimum: 1, maximum: MAX_QUANTITY, description: "Pieces, or copies of the files for documents" }),
  couponCode: Type.Optional(Type.String({ minLength: 1, maxLength: 20, description: "A coupon to take off the items; any case" })),
};

export const QuoteBody = Strict({
  ...OrderChoice,
  fileIds: Type.Array(ObjectIdString, { maxItems: MAX_ORDER_FILES, uniqueItems: true, description: "Documents are priced by their pages; none counts as 1 page" }),
});

const Pincode = Type.String({ pattern: "^[1-9][0-9]{5}$" });
export const OrderAddress = Strict({
  name: Type.String({ minLength: 2, maxLength: 80 }),
  phone: Type.String({ pattern: "^[6-9][0-9]{9}$", description: "10 digits" }),
  line: Type.String({ minLength: 5, maxLength: 300, description: "House, street and area" }),
  city: Type.String({ minLength: 2, maxLength: 60 }),
  pincode: Pincode,
});

const ReturnTo = Type.String({
  maxLength: 500,
  description: "Where the checkout page sends the customer afterwards: this site, or the app's own link. `order=<id>` is added.",
});

export const CreateOrderBody = Strict({
  ...OrderChoice,
  fileIds: Type.Array(ObjectIdString, { minItems: 1, maxItems: MAX_ORDER_FILES, uniqueItems: true }),
  address: OrderAddress,
  note: Type.Optional(Type.String({ maxLength: 500, description: "For the shop" })),
  returnTo: ReturnTo,
});
export const PayBody = Strict({ returnTo: ReturnTo });

const Price = Strict({
  units: Type.Integer({ description: "Pieces, or pages times copies for documents" }),
  unitPrice: Paise,
  extrasPerUnit: Paise,
  items: Paise,
  discount: PaiseNote("Taken off the items by the coupon."),
  coupon: Nullable(AppliedCoupon),
  platformFee: Paise,
  total: PaiseNote("The items less the discount, plus the platform fee."),
});

const Refund = Strict({
  amount: Paise,
  kind: Type.Union([Type.Literal("full"), Type.Literal("partial")], { description: "Partial refunds come out of the shop's share" }),
  reason: Nullable(Type.String()),
  status: Type.Union([Type.Literal("pending"), Type.Literal("done")]),
  at: DateTime,
});

export const PROBLEM_PHOTOS_MAX = 3;
export const PROBLEM_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const ProblemKind = Type.Union([
  Type.Literal("not_received"),
  Type.Literal("wrong_item"),
  Type.Literal("poor_quality"),
  Type.Literal("damaged"),
  Type.Literal("other"),
]);
const Problem = Strict({
  kind: ProblemKind,
  note: Type.String(),
  photos: Type.Array(Strict({ id: ObjectIdString, url: Type.String({ description: "Opens the photo without signing in; works for 10 minutes" }) })),
  status: Type.Union([Type.Literal("open"), Type.Literal("resolved")]),
  reportedAt: DateTime,
  resolution: Nullable(
    Strict({
      outcome: Type.Union([Type.Literal("refunded"), Type.Literal("partial"), Type.Literal("dismissed")]),
      amount: Paise,
      note: Type.String({ description: "Ruxstar's answer, shown to the customer and the shop" }),
      at: DateTime,
    }),
  ),
});
export const ProblemBody = Strict({
  kind: ProblemKind,
  note: Type.String({ minLength: 3, maxLength: 1000, description: "What went wrong" }),
});

export const Quote = Strict({
  ...Price.properties,
  pages: Type.Integer({ description: "Pages in the files, for documents" }),
  minOrder: Paise,
  turnaroundDays: Type.Integer(),
  couponProblem: Nullable(Type.String({ description: "Why `couponCode` can't be used; the price is then without it" })),
  offers: Type.Array(Offer, { description: "Coupons the customer can pick, best first" }),
});
export const QuoteOne = Envelope(Quote);

const OrderCore = {
  id: ObjectIdString,
  orderNo: Type.Integer(),
  shop: Strict({ id: ObjectIdString, name: Type.String() }),
  product: PodProductId,
  productLabel: Type.String(),
  pricing: Type.Union([Type.Literal("per_unit"), Type.Literal("per_page")]),
  options: Type.Record(Type.String(), Type.String()),
  colour: Nullable(Type.Union([Type.Literal("bw"), Type.Literal("color")])),
  quantity: Type.Integer(),
  files: Type.Array(PrintFile),
  address: OrderAddress,
  note: Nullable(Type.String()),
  status: OrderStatus,
  timeline: Type.Array(Strict({ status: OrderStatus, at: DateTime })),
  paidAt: Nullable(DateTime),
  refunds: Type.Array(Refund, { description: "Oldest first" }),
  refunded: Paise,
  reason: Nullable(Type.String({ description: "Why the shop turned it down, or why it was cancelled" })),
  acceptBy: Nullable(DateTime, { description: "While placed: cancelled and refunded if the shop hasn't accepted by then" }),
  readyBy: Nullable(DateTime, { description: "When the shop promised it ready: accepted plus the ready-in days" }),
  deliveredAt: Nullable(DateTime),
  canReport: Type.Boolean({ description: "The customer can report a problem now" }),
  reportUntil: Nullable(DateTime, { description: "The last moment to report a problem after delivery" }),
  problem: Nullable(Problem),
  createdAt: DateTime,
  updatedAt: DateTime,
};

/** A print order as its customer sees it. */
export const Order = Strict({ ...OrderCore, price: Price });
export type Order = Static<typeof Order>;
export const OrderOne = Envelope(Order);
export const OrderList = ListEnvelope(Order);
export const PlacedOrder = Envelope(Strict({ order: Order, checkoutUrl: Type.String({ description: "Open it to pay" }) }));
export const CheckoutLink = Envelope(Strict({ checkoutUrl: Type.String() }));

/** The same order as the shop sees it, with what Ruxstar keeps and what the shop is paid. */
export const ShopOrder = Strict({
  ...OrderCore,
  price: Strict({
    ...Price.properties,
    commissionBps: Type.Integer(),
    commission: PaiseNote("On the items, or on the items less the discount when the coupon is yours."),
    payout: PaiseNote("Items less commission, and less the discount when the coupon is yours."),
    payoutLeft: PaiseNote("The payout less partial refunds; 0 once the order is refunded, turned down or cancelled."),
  }),
  releaseAt: Nullable(DateTime, { description: "When your share becomes available: 48 hours after delivery, later while a problem is open" }),
  releasedAt: Nullable(DateTime),
  refundable: PaiseNote("The most you can refund now; 0 once your share is released."),
});
export type ShopOrder = Static<typeof ShopOrder>;
export const ShopOrderOne = Envelope(ShopOrder);
export const ShopOrderList = ListEnvelope(ShopOrder);

export const FileLink = Envelope(
  Strict({ url: Type.String({ description: "Opens the file without signing in; works for 10 minutes" }), expiresAt: DateTime }),
);
export const OrderParams = Strict({ id: ObjectIdString });
export const OrderFileParams = Strict({ id: ObjectIdString, fileId: ObjectIdString });
export const OrdersQuery = Strict({ ...PageQuery });
export const ShopOrdersQuery = Strict({
  ...PageQuery,
  business: Type.Optional(ObjectIdString),
  view: Type.Optional(
    Type.Union([Type.Literal("new"), Type.Literal("active"), Type.Literal("past")], {
      description: "`new` waits for you to accept, `active` is being made or delivered, `past` is delivered, turned down or cancelled",
    }),
  ),
});

export const ShopStatus = Type.Union([
  Type.Literal("accepted"),
  Type.Literal("printing"),
  Type.Literal("ready"),
  Type.Literal("out_for_delivery"),
  Type.Literal("delivered"),
  Type.Literal("rejected"),
]);
export const ShopStatusBody = Strict({
  status: ShopStatus,
  reason: Type.Optional(Type.String({ minLength: 5, maxLength: 300, description: "Required to turn an order down; the customer sees it" })),
});

/** Cashfree's smallest refund is ₹1. */
const RefundAmount = Type.Integer({ minimum: 100, description: "Amount in paise, at least ₹1" });
export const ShopRefundBody = Strict({
  amount: RefundAmount,
  reason: Type.String({ minLength: 5, maxLength: 300, description: "The customer sees it" }),
});

// The console's order problems.

export const StaffOrder = Strict({
  ...ShopOrder.properties,
  customer: Strict({ id: ObjectIdString, name: Type.String(), username: Nullable(Type.String()) }),
  vendor: Strict({ id: ObjectIdString, name: Type.String() }),
});
export type StaffOrder = Static<typeof StaffOrder>;
export const StaffOrderOne = Envelope(StaffOrder);
export const StaffOrderList = ListEnvelope(StaffOrder);
export const ProblemsQuery = Strict({
  ...PageQuery,
  status: Type.Optional(
    Type.Union([Type.Literal("open"), Type.Literal("resolved")], { description: "`open` (the default) waits for Ruxstar, newest report first" }),
  ),
});
export const SettleBody = Strict({
  outcome: Type.Union([Type.Literal("refund_full"), Type.Literal("refund_partial"), Type.Literal("dismiss")], {
    description: "`refund_full` refunds what is left of the order and ends it; `refund_partial` takes `amount` from the shop's share",
  }),
  amount: Type.Optional(RefundAmount),
  note: Type.String({ minLength: 5, maxLength: 500, description: "Shown to the customer and the shop" }),
});
