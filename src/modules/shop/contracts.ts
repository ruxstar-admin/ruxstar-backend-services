import { Type, type Static, type TSchema } from "typebox";
import { DateTime, Envelope, ListEnvelope, ObjectIdString, PageQuery, Paise, Strict } from "../../contracts/common.js";
import { AppliedCoupon, Offer } from "../coupons/contracts.js";
import { InvoiceRefs } from "../invoices/contracts.js";
import { DeliveryStatus, OrderAddress, Vehicle } from "../pod/contracts.js";
import { Rating, ReviewEligibility } from "../reviews/contracts.js";
import { ShopRules } from "../ruxstar/contracts.js";
import { DeliveryFeeView, Point } from "../vendor/contracts.js";
import { MAX_PRICE, MAX_RADIUS_KM, MAX_STOCK } from "./rules.js";

const Nullable = <T extends TSchema>(schema: T, options?: { description: string }) => Type.Union([schema, Type.Null()], options);

export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 2000;

const Price = Type.Integer({ minimum: 100, maximum: MAX_PRICE, description: "Paise, at least ₹1" });
const Stock = Type.Integer({ minimum: 0, maximum: MAX_STOCK, description: "How many are left to sell" });
const Business = Strict({ id: ObjectIdString, name: Type.String() });
const Photo = Strict({ url: Type.String(), width: Type.Integer(), height: Type.Integer() });
const Option = Strict({ name: Type.String({ description: "Such as Size or Colour" }), values: Type.Array(Type.String(), { description: "In the shop's order" }) });
const ProductStatus = Type.Union([Type.Literal("live"), Type.Literal("hidden"), Type.Literal("removed")], {
  description: "hidden: the shop took it off sale. removed: Ruxstar took it down",
});

export const IdParams = Strict({ id: ObjectIdString });
export const ProductParams = Strict({ id: ObjectIdString, productId: ObjectIdString });

// Rules.

export const ShopRulesOne = Envelope(
  Strict({
    ...ShopRules.properties,
    commissionBps: Type.Integer(),
    platformFee: Paise,
  }),
);

// Shops and products, as customers see them.

const ShopSetupView = Strict({
  delivery: Type.Boolean({ description: "Delivers in its city" }),
  pickup: Type.Boolean({ description: "Customers can collect from the shop" }),
  radiusKm: Nullable(Type.Integer(), { description: "Road km it delivers to; null for anywhere in its city" }),
  deliveryFee: DeliveryFeeView,
  minOrder: Paise,
  returns: Type.Boolean({ description: "Takes returns within Ruxstar's return days; false is \"No returns\"" }),
  notes: Nullable(Type.String()),
});

const storeFields = {
  id: ObjectIdString,
  name: Type.String(),
  type: Type.String({ description: "clothing, electronics, grocery, gifts, bakery or general_store" }),
  photoUrl: Nullable(Type.String(), { description: "The business's first photo" }),
  city: Type.String(),
  area: Nullable(Type.String()),
  open: Type.Boolean(),
  delivery: Type.Boolean(),
  pickup: Type.Boolean(),
  returnRule: Type.String({ description: "The return rule in one sentence" }),
  rating: Rating,
};
export const StoreCard = Strict(storeFields);
export type StoreCard = Static<typeof StoreCard>;
export const StoreList = ListEnvelope(StoreCard);
export const StoresQuery = Strict({
  ...PageQuery,
  city: Type.Optional(Type.String({ minLength: 2, maxLength: 60 })),
  type: Type.Optional(Type.String({ pattern: "^[a-z_]{2,30}$", description: "A business type of local shops" })),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "Words in the shop's name" })),
});
export const StoreDetail = Strict({
  ...storeFields,
  description: Nullable(Type.String()),
  photos: Type.Array(Photo),
  phone: Nullable(Type.String()),
  address: Type.String(),
  point: Nullable(Point),
  setup: ShopSetupView,
  returnDays: Nullable(Type.Integer({ description: "Days after delivery to ask for a return; null for no returns" })),
  canOrder: Type.Boolean(),
  whyNot: Nullable(Type.String({ description: "Why nobody can order now" })),
  products: Type.Integer({ description: "Live products" }),
});
export const StoreOne = Envelope(StoreDetail);

export const Variant = Strict({
  id: ObjectIdString,
  values: Type.Array(Type.String(), { description: "One per option, in the options' order; empty without options" }),
  price: Paise,
  mrp: Nullable(Paise, { description: "The printed MRP, when given; at least the price" }),
  stock: Type.Integer({ description: "Left to sell; stock only goes down when an order is paid" }),
  sku: Nullable(Type.String()),
});
const productFields = {
  id: ObjectIdString,
  title: Type.String(),
  photo: Nullable(Photo),
  business: Business,
  city: Type.String(),
  priceFrom: Paise,
  mrpFrom: Nullable(Paise, { description: "The MRP of the cheapest variant" }),
  inStock: Type.Boolean({ description: "Some variant has stock" }),
  rating: Rating,
};
export const ProductCard = Strict(productFields);
export type ProductCard = Static<typeof ProductCard>;
export const ProductList = ListEnvelope(ProductCard);
export const ProductsQuery = Strict({
  ...PageQuery,
  city: Type.Optional(Type.String({ minLength: 2, maxLength: 60 })),
  shop: Type.Optional(ObjectIdString),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "Words in the product's title" })),
  inStock: Type.Optional(Type.Boolean()),
});
export const ProductDetail = Strict({
  ...productFields,
  description: Nullable(Type.String()),
  options: Type.Array(Option, { description: "Up to the rules' `maxOptions`" }),
  variants: Type.Array(Variant, { description: "One per combination sold; a combination missing here isn't sold" }),
  status: ProductStatus,
  canOrder: Type.Boolean(),
  whyNot: Nullable(Type.String()),
  returnRule: Type.String(),
  delivery: Type.Boolean(),
  pickup: Type.Boolean(),
});
export type ProductDetail = Static<typeof ProductDetail>;
export const ProductOne = Envelope(ProductDetail);

// The cart and checkout. The cart is kept on the device; these price it as it is now.

const CartLine = Strict({
  productId: ObjectIdString,
  variantId: ObjectIdString,
  quantity: Type.Integer({ minimum: 1, maximum: 100, description: "Up to the rules' `maxQuantity`" }),
});
const Lines = Type.Array(CartLine, { minItems: 1, maxItems: 50, description: "From one shop; up to the rules' `maxLines`" });
const Method = Type.Union([Type.Literal("delivery"), Type.Literal("pickup")]);
const ReturnTo = Type.String({
  maxLength: 500,
  description: "Where the checkout page sends the customer afterwards: this site, or the app's own link. `order=<id>` is added.",
});
export const QuoteBody = Strict({
  lines: Lines,
  method: Method,
  address: Type.Optional(
    Strict(
      {
        line: Type.Optional(Type.String({ maxLength: 300 })),
        city: Type.Optional(Type.String({ maxLength: 60 })),
        pincode: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{5}$" })),
        point: Type.Optional(Nullable(Point)),
      },
      { description: "Where it goes, as far as filled in, to price delivery by distance" },
    ),
  ),
  code: Type.Optional(Type.String({ minLength: 3, maxLength: 20, description: "Check this coupon too" })),
});
const QuoteLine = Strict({
  productId: ObjectIdString,
  variantId: ObjectIdString,
  title: Type.String(),
  options: Type.Array(Strict({ name: Type.String(), value: Type.String() })),
  unitPrice: Paise,
  mrp: Nullable(Paise),
  quantity: Type.Integer(),
  total: Paise,
  stock: Type.Integer(),
});
export const QuoteOne = Envelope(
  Strict({
    lines: Type.Array(QuoteLine),
    items: Paise,
    delivery: Paise,
    deliveryKm: Nullable(Type.Integer()),
    platformFee: Paise,
    discount: Paise,
    total: Paise,
    returnRule: Type.String(),
    offers: Type.Array(Offer),
    checked: Nullable(Strict({ code: Type.String(), discount: Paise, problem: Nullable(Type.String()) }), { description: "With `code`" }),
  }),
);
export const PlaceOrderBody = Strict(
  {
    lines: Lines,
    method: Method,
    address: Type.Optional(OrderAddress),
    coupon: Type.Optional(Type.String({ minLength: 3, maxLength: 20 })),
    note: Type.Optional(Type.String({ maxLength: 500, description: "For the shop" })),
    returnTo: ReturnTo,
  },
  { description: "Delivery needs `address`, in the shop's city" },
);
export const PayBody = Strict({ returnTo: ReturnTo });
export const CancelBody = Strict({ reason: Type.Optional(Type.String({ minLength: 2, maxLength: 300 })) });
const ReturnReason = Type.Union(
  [Type.Literal("wrong_item"), Type.Literal("damaged"), Type.Literal("not_as_described"), Type.Literal("changed_mind"), Type.Literal("other")],
  { description: "wrong_item and damaged: the shop pays the trip back. Otherwise one delivery fee comes off the refund" },
);
export const ReturnBody = Strict({
  reason: ReturnReason,
  note: Type.Optional(Type.String({ maxLength: 500 })),
  lines: Type.Optional(
    Type.Array(Strict({ lineId: ObjectIdString, quantity: Type.Integer({ minimum: 1, maximum: 100 }) }), {
      minItems: 1,
      maxItems: 50,
      description: "What goes back; left out, everything",
    }),
  ),
});

const Status = Type.Union(
  [
    Type.Literal("awaiting_payment"),
    Type.Literal("paid"),
    Type.Literal("accepted"),
    Type.Literal("packed"),
    Type.Literal("out_for_delivery"),
    Type.Literal("ready_for_pickup"),
    Type.Literal("delivered"),
    Type.Literal("cancelled"),
  ],
  { description: "paid: waiting for the shop to accept. delivered also covers picked up from the shop" },
);
const Actor = Type.Union([Type.Literal("customer"), Type.Literal("vendor"), Type.Literal("staff"), Type.Literal("system"), Type.Literal("rider")]);
const OrderLine = Strict({
  id: ObjectIdString,
  productId: ObjectIdString,
  variantId: ObjectIdString,
  title: Type.String(),
  options: Type.Array(Strict({ name: Type.String(), value: Type.String() }), { description: "As it was when ordered" }),
  photoUrl: Nullable(Type.String()),
  sku: Nullable(Type.String()),
  unitPrice: Paise,
  mrp: Nullable(Paise),
  quantity: Type.Integer(),
  total: Paise,
});
const Refund = Strict({
  kind: Type.Union([Type.Literal("full"), Type.Literal("return")]),
  amount: Paise,
  reason: Nullable(Type.String()),
  status: Type.Union([Type.Literal("pending"), Type.Literal("done")]),
  at: DateTime,
});
const Return = Strict({
  reason: ReturnReason,
  note: Nullable(Type.String()),
  lines: Type.Array(Strict({ lineId: ObjectIdString, quantity: Type.Integer() })),
  status: Type.Union([Type.Literal("requested"), Type.Literal("approved"), Type.Literal("rejected"), Type.Literal("refunded")], {
    description: "requested and approved hold the shop's money until refunded or rejected",
  }),
  tripPaidBy: Type.Union([Type.Literal("shop"), Type.Literal("customer")]),
  tripFee: PaiseOf("Taken off the refund when the customer pays the trip back"),
  amount: PaiseOf("What the customer gets back"),
  requestedAt: DateTime,
  decision: Nullable(Strict({ by: Actor, note: Nullable(Type.String()), at: DateTime })),
  receivedAt: Nullable(DateTime),
});
function PaiseOf(description: string) {
  return Type.Integer({ minimum: 0, description: `Paise. ${description}` });
}
const Rider = Strict({ name: Type.String(), avatarUrl: Nullable(Type.String()), phone: Type.String(), vehicle: Vehicle });
const deliveryCore = {
  carrier: Type.Union([Type.Literal("team"), Type.Literal("partner")], { description: "Someone on the shop's team, or a Ruxstar delivery partner" }),
  status: DeliveryStatus,
  rider: Nullable(Rider, { description: "Once someone accepted it" }),
};

const orderFields = {
  id: ObjectIdString,
  orderNo: Type.Integer(),
  status: Status,
  business: Business,
  lines: Type.Array(OrderLine),
  method: Method,
  address: Nullable(Strict({ ...OrderAddress.properties, point: Nullable(Point) }), { description: "Null for pickup" }),
  pickupAt: Nullable(Strict({ address: Type.String(), point: Nullable(Point), phone: Nullable(Type.String()) }), { description: "Pickup: where to collect it" }),
  price: Strict({ items: Paise, delivery: Paise, deliveryKm: Nullable(Type.Integer()), platformFee: Paise, discount: Paise, total: Paise }),
  coupon: Nullable(AppliedCoupon),
  note: Nullable(Type.String()),
  timeline: Type.Array(Strict({ status: Status, at: DateTime, by: Actor })),
  payBy: Nullable(DateTime, { description: "Unpaid: the checkout closes then" }),
  paidAt: Nullable(DateTime),
  acceptBy: Nullable(DateTime, { description: "Paid: refunded if the shop hasn't accepted by then" }),
  deliveredAt: Nullable(DateTime),
  returnRule: Type.String(),
  returnUntil: Nullable(DateTime, { description: "The last moment to ask for a return" }),
  return: Nullable(Return),
  refunds: Type.Array(Refund),
  refunded: Paise,
  cancellation: Nullable(Strict({ by: Actor, reason: Type.String(), at: DateTime })),
  invoices: InvoiceRefs,
  createdAt: DateTime,
};
export const ShopOrder = Strict({
  ...orderFields,
  delivery: Nullable(
    Strict({ ...deliveryCore, dropCode: Nullable(Type.String({ description: "Give it to the rider at the door; null once delivered or cancelled" })) }),
    { description: "Null while the shop delivers it itself" },
  ),
  canCancel: Type.Boolean({ description: "Unpaid, or paid and not packed yet: a full refund" }),
  canReturn: Type.Boolean({ description: "Delivered, the shop takes returns and the window is open" }),
  reviewable: Type.Array(
    Strict({ productId: ObjectIdString, title: Type.String(), canReview: Type.Boolean(), reviewUntil: Nullable(DateTime) }),
    { description: "Each product in the order, reviewed on its own once delivered" },
  ),
  ...ReviewEligibility,
});
export type ShopOrder = Static<typeof ShopOrder>;
export const ShopOrderOne = Envelope(ShopOrder);
export const ShopOrderList = ListEnvelope(ShopOrder);
export const PlacedShopOrder = Envelope(Strict({ order: ShopOrder, checkoutUrl: Type.String({ description: "Open it to pay" }) }));
export const CheckoutLinkOne = Envelope(Strict({ checkoutUrl: Type.String() }));
export const MyOrdersQuery = Strict({
  ...PageQuery,
  view: Type.Optional(
    Type.Union([Type.Literal("current"), Type.Literal("past"), Type.Literal("all")], { default: "all", description: "current: not delivered or cancelled yet" }),
  ),
});

// The desk: the owner and their team.

const Payout = Type.Union([Type.Literal("none"), Type.Literal("waiting"), Type.Literal("return"), Type.Literal("released")], {
  description: "Your share. waiting: until the return window and the hold are over. return: a return is open",
});
export const DeskOrder = Strict({
  ...orderFields,
  customer: Strict({ name: Type.String(), phone: Nullable(Type.String({ description: "Paid orders" })) }),
  delivery: Nullable(
    Strict({
      ...deliveryCore,
      jobId: ObjectIdString,
      pay: PaiseOf("To the Ruxstar partner, out of your share at delivery; 0 for your team"),
      offerUntil: Nullable(DateTime, { description: "A partner offer nobody accepts is cancelled then" }),
    }),
    { description: "Null while you deliver it yourself" },
  ),
  commission: Paise,
  vendorShare: PaiseOf("Items and delivery, less your coupon, Ruxstar's commission, a partner's pay and returns"),
  payout: Payout,
  releaseAt: Nullable(DateTime),
  next: Type.Array(Status, { description: "The steps you can move it to now" }),
  canCancel: Type.Boolean({ description: "Paid and not delivered; always a full refund" }),
});
export type DeskOrder = Static<typeof DeskOrder>;
export const DeskOrderOne = Envelope(DeskOrder);
export const DeskOrderList = ListEnvelope(DeskOrder);
export const DeskOrdersQuery = Strict({
  ...PageQuery,
  view: Type.Optional(
    Type.Union([Type.Literal("open"), Type.Literal("returns"), Type.Literal("done"), Type.Literal("all")], {
      default: "open",
      description: "open: paid and not delivered. returns: a return is open. done: delivered or cancelled",
    }),
  ),
});
export const MoveBody = Strict({
  status: Type.Union([Type.Literal("accepted"), Type.Literal("packed"), Type.Literal("out_for_delivery"), Type.Literal("ready_for_pickup"), Type.Literal("delivered")], {
    description: "One step at a time. out_for_delivery and delivered are for your own delivery; a rider's trip moves it by itself",
  }),
});
export const OwnerCancelBody = Strict({ reason: Type.String({ minLength: 5, maxLength: 300, description: "The customer is told" }) });
export const DecideReturnBody = Strict({
  decision: Type.Union([Type.Literal("approve"), Type.Literal("reject")]),
  note: Type.Optional(Type.String({ maxLength: 500, description: "The customer is told; needed to reject" })),
});
export const ReceivedBody = Strict({ note: Type.Optional(Type.String({ maxLength: 500 })) });

export const DeskStore = Strict({
  id: ObjectIdString,
  name: Type.String(),
  owner: Type.Boolean(),
  permissions: Type.Array(Type.String(), { description: "The owner has every one" }),
  open: Type.Integer({ description: "Orders paid and not delivered" }),
  returns: Type.Integer({ description: "Returns open" }),
});
export const DeskStoreList = ListEnvelope(DeskStore);

// The owner's setup: shop settings and products.

export const ShopSetupBody = Strict(
  {
    delivery: Type.Optional(Type.Boolean()),
    pickup: Type.Optional(Type.Boolean()),
    radiusKm: Type.Optional(Nullable(Type.Integer({ minimum: 1, maximum: MAX_RADIUS_KM }))),
    deliveryFee: Type.Optional(
      Strict(
        { base: Type.Integer({ minimum: 0, maximum: MAX_PRICE }), includedKm: Type.Integer({ minimum: 0, maximum: 50 }), perKm: Type.Integer({ minimum: 0, maximum: MAX_PRICE }) },
        { description: "Up to the most Ruxstar allows" },
      ),
    ),
    minOrder: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_PRICE })),
    returns: Type.Optional(Type.Boolean({ description: "true: returns within Ruxstar's return days. false: \"No returns\"" })),
    notes: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
  },
  { minProperties: 1, description: "At least one of delivery and pickup stays on" },
);
export const ShopSetupOne = Envelope(Strict({ ...ShopSetupView.properties, returnDays: Type.Integer({ description: "Ruxstar's return days, when returns are on" }) }));

const OptionInput = Strict({
  name: Type.String({ minLength: 1, maxLength: 30 }),
  values: Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { minItems: 1, maxItems: 30, description: "Up to the rules' `maxValues`" }),
});
const VariantInput = Strict({
  values: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 2, description: "One per option, in order; left out without options" })),
  price: Price,
  mrp: Type.Optional(Nullable(Price)),
  stock: Stock,
  sku: Type.Optional(Nullable(Type.String({ maxLength: 40 }))),
});
const productInputFields = {
  title: Type.String({ minLength: 2, maxLength: TITLE_MAX }),
  description: Type.Optional(Nullable(Type.String({ maxLength: DESCRIPTION_MAX }))),
  options: Type.Optional(Type.Array(OptionInput, { maxItems: 2, description: "Up to the rules' `maxOptions`, such as Size and Colour" })),
  variants: Type.Array(VariantInput, {
    minItems: 1,
    maxItems: 100,
    description: "The variant table: one row per combination sold, each with its price, MRP, stock and SKU. Without options, one row",
  }),
  hsn: Type.Optional(Nullable(Type.String({ pattern: "^[0-9]{4,8}$", description: "For invoices" }))),
  gstRateBps: Type.Optional(Nullable(Type.Integer({ minimum: 0, maximum: 2800, description: "Overrides the module's GST rate, in basis points" }))),
  status: Type.Optional(Type.Union([Type.Literal("live"), Type.Literal("hidden")], { description: "Default live" })),
};
export const ProductBody = Strict(productInputFields);
export const UpdateProductBody = Type.Partial(ProductBody, {
  additionalProperties: false,
  minProperties: 1,
  description: "Sending `variants` replaces the table, stock included; with `options`, send `variants` too",
});
export const StockBody = Strict({
  variants: Type.Array(Strict({ variantId: ObjectIdString, stock: Stock }), { minItems: 1, maxItems: 100, description: "Each set to the number given" }),
});
export const VendorProduct = Strict({
  ...ProductDetail.properties,
  hsn: Nullable(Type.String()),
  gstRateBps: Nullable(Type.Integer()),
  removal: Nullable(Strict({ reason: Type.String(), at: DateTime })),
  createdAt: DateTime,
  updatedAt: DateTime,
});
export type VendorProduct = Static<typeof VendorProduct>;
export const VendorProductOne = Envelope(VendorProduct);
export const VendorProductList = ListEnvelope(VendorProduct);
export const VendorProductsQuery = Strict({
  ...PageQuery,
  status: Type.Optional(ProductStatus),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
  lowStock: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_STOCK, description: "Only products with a variant at or under this stock" })),
});

// Reviews of products.

export const OrderReviewParams = Strict({ id: ObjectIdString, productId: ObjectIdString });

// The console.

export const ConsoleStore = Strict({
  ...storeFields,
  ownerId: ObjectIdString,
  status: Type.String({ description: "The business's status" }),
  suspended: Type.Boolean(),
  products: Type.Integer({ description: "Not removed" }),
  orders: Type.Integer({ description: "Paid, all time" }),
  createdAt: DateTime,
});
export const ConsoleStoreList = ListEnvelope(ConsoleStore);
export const ConsoleStoreOne = Envelope(Strict({ store: ConsoleStore, setup: Nullable(ShopSetupView), openOrders: Type.Integer(), openReturns: Type.Integer() }));
export const ConsoleStoresQuery = Strict({
  ...PageQuery,
  city: Type.Optional(Type.String({ minLength: 2, maxLength: 60 })),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
});
export const ConsoleProduct = Strict({ ...VendorProduct.properties, vendorId: ObjectIdString });
export const ConsoleProductOne = Envelope(ConsoleProduct);
export const ConsoleProductList = ListEnvelope(ConsoleProduct);
export const ConsoleProductsQuery = Strict({
  ...PageQuery,
  status: Type.Optional(ProductStatus),
  shop: Type.Optional(ObjectIdString),
  city: Type.Optional(Type.String({ minLength: 2, maxLength: 60 })),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
});
export const TakeDownBody = Strict({ reason: Type.String({ minLength: 5, maxLength: 300, description: "The shop is told" }) });

const BannedKey = Type.String({ pattern: "^[a-z][a-z0-9_]{1,29}$" });
const BannedWords = Type.Array(Type.String({ minLength: 2, maxLength: 40 }), {
  minItems: 1,
  maxItems: 100,
  description: "Words or phrases; a product whose title, description or options use one as a whole word, in any case, is refused",
});
export const BannedCategory = Strict({ key: Type.String(), name: Type.String(), words: Type.Array(Type.String()), active: Type.Boolean(), updatedAt: DateTime });
export const BannedList = ListEnvelope(BannedCategory);
export const BannedOne = Envelope(BannedCategory);
export const BannedParams = Strict({ key: BannedKey });
export const CreateBannedBody = Strict({ key: BannedKey, name: Type.String({ minLength: 2, maxLength: 60 }), words: BannedWords });
export const UpdateBannedBody = Strict(
  {
    name: Type.Optional(Type.String({ minLength: 2, maxLength: 60 })),
    words: Type.Optional(BannedWords),
    active: Type.Optional(Type.Boolean({ description: "Inactive: not checked. Products saved meanwhile stay" })),
  },
  { minProperties: 1 },
);

export const ConsoleOrder = Strict({ ...DeskOrder.properties, customerId: ObjectIdString, vendorId: ObjectIdString, releasedAt: Nullable(DateTime) });
export type ConsoleOrder = Static<typeof ConsoleOrder>;
export const ConsoleOrderOne = Envelope(ConsoleOrder);
export const ConsoleOrderList = ListEnvelope(ConsoleOrder);
export const ConsoleOrdersQuery = Strict({
  ...PageQuery,
  shop: Type.Optional(ObjectIdString),
  status: Type.Optional(Status),
  returns: Type.Optional(
    Type.Union([Type.Literal("open"), Type.Literal("rejected")], { description: "open: requested or approved. rejected: the shop turned it down; Ruxstar can still approve" }),
  ),
});
export const ConsoleCancelBody = Strict({ reason: Type.String({ minLength: 5, maxLength: 300, description: "The customer and the shop are told" }) });
export const ConsoleReturnBody = Strict({
  decision: Type.Union([Type.Literal("approve"), Type.Literal("reject"), Type.Literal("refund")], {
    description: "refund: the items are back (or needn't be), refund now",
  }),
  note: Type.String({ minLength: 5, maxLength: 500, description: "Both sides are told" }),
});
