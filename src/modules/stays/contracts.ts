import { Type, type Static, type TSchema } from "typebox";
import { DateTime, Envelope, ListEnvelope, ObjectIdString, PageQuery, Paise, Strict } from "../../contracts/common.js";
import { AppliedCoupon, Offer } from "../coupons/contracts.js";
import { InvoiceRefs } from "../invoices/contracts.js";
import { Rating, ReviewEligibility } from "../reviews/contracts.js";
import { StaysRules } from "../ruxstar/contracts.js";
import { Point } from "../vendor/contracts.js";
import { MAX_DEPOSIT, MAX_NEARBY, MAX_NOTICE_DAYS, MAX_PRICE } from "./rules.js";

const Nullable = <T extends TSchema>(schema: T, options?: { description: string }) => Type.Union([schema, Type.Null()], options);

export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 2000;

const Day = Type.String({ format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD, in India" });
const Clock = Type.String({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: "HH:MM in India" });
const Price = Type.Integer({ minimum: 100, maximum: MAX_PRICE, description: "Paise, at least ₹1" });
const Reason = Type.String({ minLength: 5, maxLength: 300, description: "The tenant is told" });
const Business = Strict({ id: ObjectIdString, name: Type.String() });
const FacilityKey = Type.String({ pattern: "^[a-z][a-z0-9_]{1,29}$", description: "A key from GET /v1/stays/facilities" });
export const Facility = Strict({ key: Type.String(), name: Type.String() });
const Photo = Strict({ id: Type.String(), url: Type.String(), width: Type.Integer(), height: Type.Integer() });

export const Kind = Type.Union([Type.Literal("pg"), Type.Literal("hostel"), Type.Literal("coliving")], {
  description: "pg and coliving rooms are usually priced per month, hostel beds per night; any room can offer both",
});
export const For = Type.Union([Type.Literal("men"), Type.Literal("women"), Type.Literal("any")], { description: "Who can stay" });
const Occupant = Type.Union([Type.Literal("students"), Type.Literal("working")]);
const Meal = Type.Union([Type.Literal("breakfast"), Type.Literal("lunch"), Type.Literal("dinner")]);
const FoodType = Type.Union([Type.Literal("veg"), Type.Literal("non_veg"), Type.Literal("none")], { description: "non_veg serves veg too; none: no food" });
export const Unit = Type.Union([Type.Literal("month"), Type.Literal("night")]);
export const RoomKind = Type.Union([Type.Literal("private"), Type.Literal("shared")], {
  description: "private: reserved whole, priced per room. shared: priced per bed; beds reserved one by one, or all together when `wholeRoom`",
});
const Feature = Type.Union([Type.Literal("ac"), Type.Literal("attached_bath"), Type.Literal("balcony"), Type.Literal("furnished"), Type.Literal("window")]);
const NearbyKind = Type.Union([Type.Literal("college"), Type.Literal("office"), Type.Literal("metro"), Type.Literal("other")]);
const PropertyStatus = Type.Union([Type.Literal("draft"), Type.Literal("live"), Type.Literal("removed")]);
const RoomStatus = Type.Union([Type.Literal("live"), Type.Literal("paused")], { description: "paused: shown as full, not reservable" });

const Address = Strict({
  line: Type.String({ minLength: 5, maxLength: 300 }),
  area: Type.Optional(Nullable(Type.String({ minLength: 2, maxLength: 60, description: "Locality, for search" }))),
  city: Type.String({ minLength: 2, maxLength: 60 }),
  pincode: Type.Optional(Nullable(Type.String({ pattern: "^[1-9][0-9]{5}$" }))),
  point: Type.Optional(Nullable(Point)),
});
const AddressView = Strict({ line: Type.String(), area: Nullable(Type.String()), city: Type.String(), pincode: Nullable(Type.String()), point: Nullable(Point) });
const Food = Strict({
  type: FoodType,
  meals: Type.Array(Meal, { maxItems: 3, uniqueItems: true, description: "Meals included in the rent; empty when `type` is none" }),
});
const HouseRules = Strict({
  curfew: Nullable(Clock, { description: "Latest entry time; null for none" }),
  guests: Type.Boolean({ description: "Visitors allowed" }),
  smoking: Type.Boolean(),
  alcohol: Type.Boolean(),
  pets: Type.Boolean(),
  notes: Nullable(Type.String({ maxLength: 500 })),
});
const DepositInput = Strict(
  { amount: Type.Integer({ minimum: 0, maximum: MAX_DEPOSIT }), note: Type.Optional(Nullable(Type.String({ maxLength: 200 }))) },
  { description: "Paise, paid to the owner directly at move-in; Ruxstar only shows it" },
);
const Deposit = Strict({ amount: Paise, note: Nullable(Type.String()) });
const Nearby = Strict({
  kind: NearbyKind,
  name: Type.String({ minLength: 2, maxLength: 80 }),
  km: Type.Number({ minimum: 0, maximum: 100, description: "Distance in kilometres" }),
});
const RoomPrices = Strict(
  {
    month: Nullable(Price, { description: "Per month; null when not let by the month" }),
    night: Nullable(Price, { description: "Per night; null when not let by the night" }),
  },
  { description: "For each bed of a shared room, or the whole private room. At least one" },
);

export const IdParams = Strict({ id: ObjectIdString });
export const PhotoParams = Strict({ id: ObjectIdString, photoId: Type.String({ maxLength: 60 }) });

// Rules and facilities.

export const StaysRulesOne = Envelope(
  Strict({
    ...StaysRules.properties,
    commissionBps: Type.Integer(),
    platformFee: Paise,
  }),
);
export const FacilityList = ListEnvelope(Facility);

// Properties and rooms, as customers see them.

const Bed = Strict({ id: ObjectIdString, label: Type.String({ description: "A, B, C… in the room" }) });
export const RoomView = Strict({
  id: ObjectIdString,
  name: Type.String(),
  kind: RoomKind,
  beds: Type.Integer(),
  wholeRoom: Type.Boolean({ description: "Shared rooms: every bed can be reserved together, at the bed price times the beds" }),
  prices: RoomPrices,
  features: Type.Array(Feature),
  status: RoomStatus,
  bedList: Type.Array(Bed, { description: "Its beds, for the dots; which are free comes from the availability call" }),
});
export type RoomView = Static<typeof RoomView>;

const cardFields = {
  id: ObjectIdString,
  name: Type.String(),
  kind: Kind,
  business: Business,
  city: Type.String(),
  area: Nullable(Type.String()),
  address: Type.String(),
  photo: Nullable(Photo, { description: "The first photo" }),
  for: For,
  occupants: Type.Array(Occupant, { description: "Empty: anyone" }),
  food: Food,
  facilities: Type.Array(Facility),
  priceFrom: Strict(
    { month: Nullable(Paise), night: Nullable(Paise) },
    { description: "The lowest price per bed (or private room) of its reservable rooms, per month and per night" },
  ),
  units: Type.Array(Unit, { description: "How its rooms are let" }),
  roomKinds: Type.Array(RoomKind),
  noticeDays: Type.Integer(),
  deposit: Paise,
  nearby: Type.Array(Nearby),
};
export const PropertyCard = Strict(cardFields);
export type PropertyCard = Static<typeof PropertyCard>;
export const PropertyList = ListEnvelope(PropertyCard);

const csv = (description: string) => Type.String({ pattern: "^[a-z_]+(,[a-z_]+)*$", maxLength: 300, description });
export const PropertiesQuery = Strict({
  ...PageQuery,
  city: Type.Optional(Type.String({ minLength: 2, maxLength: 60 })),
  area: Type.Optional(Type.String({ minLength: 2, maxLength: 60 })),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "Words in the property's or business's name" })),
  kind: Type.Optional(Kind),
  for: Type.Optional(Type.Union([Type.Literal("men"), Type.Literal("women")], { description: "Also matches places open to anyone" })),
  occupant: Type.Optional(Type.Union([Type.Literal("students"), Type.Literal("working")], { description: "Also matches places open to anyone" })),
  food: Type.Optional(Type.Union([Type.Literal("veg"), Type.Literal("non_veg"), Type.Literal("none"), Type.Literal("any")], { description: "any: serves food" })),
  meals: Type.Optional(csv("Comma-separated meals that must be included, for example breakfast,dinner")),
  facilities: Type.Optional(csv("Comma-separated facility keys, all of which it must have")),
  stay: Type.Optional(Type.Union([Type.Literal("month"), Type.Literal("night")], { description: "Has rooms let this way" })),
  priceMax: Type.Optional(Type.Integer({ minimum: 100, description: "Paise: its lowest price per bed is at most this; per month, or per night with stay=night" })),
  room: Type.Optional(RoomKind),
  near: Type.Optional(Type.String({ minLength: 2, maxLength: 60, description: "Words in a nearby college, office or metro station" })),
  noticeMax: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_NOTICE_DAYS, description: "Notice period of at most this many days" })),
  allows: Type.Optional(csv("Comma-separated house rules it must allow: guests, smoking, alcohol, pets, late_entry (no curfew)")),
});

export const PropertyDetail = Strict({
  ...cardFields,
  description: Nullable(Type.String()),
  addressDetail: AddressView,
  photos: Type.Array(Photo),
  rules: HouseRules,
  depositDetail: Deposit,
  rooms: Type.Array(RoomView, { description: "Reservable and full rooms, in the property's order" }),
  refundDays: Type.Integer({ description: "Full refund until this many days before move-in" }),
  refundRule: Type.String({ description: "The refund rule in one sentence, for above the Pay button" }),
  platformFee: Paise,
  status: PropertyStatus,
  canReserve: Type.Boolean(),
  whyNot: Nullable(Type.String({ description: "Why nobody can reserve right now" })),
  kycRequired: Type.Literal(true, { description: "Tenants need base KYC before reserving" }),
  rating: Type.Optional(Rating),
});
export type PropertyDetail = Static<typeof PropertyDetail>;
export const PropertyOne = Envelope(PropertyDetail);

export const AvailabilityQuery = Strict({
  moveIn: Day,
  stay: Type.Optional(Type.Union([Type.Literal("month"), Type.Literal("night")], { default: "month" })),
  months: Type.Optional(Type.Integer({ minimum: 1, maximum: 12, default: 1, description: "stay=month: months paid now. The bed stays yours after them until you give notice" })),
  nights: Type.Optional(Type.Integer({ minimum: 1, maximum: 90, default: 1, description: "stay=night" })),
});
const BedState = Type.Union([Type.Literal("free"), Type.Literal("taken"), Type.Literal("closed")], {
  description: "taken: reserved or held for someone's checkout at some point of the stay. closed: the owner marked it full",
});
export const Availability = Envelope(
  Strict({
    property: Strict({ id: ObjectIdString, name: Type.String() }),
    moveIn: Day,
    stay: Unit,
    until: Nullable(Day, { description: "stay=night: the checkout day. stay=month: null, as the bed stays yours until notice" }),
    reservable: Type.Boolean({ description: "Within how far ahead move-in can be, and the property is taking reservations" }),
    rooms: Type.Array(
      Strict({
        id: ObjectIdString,
        name: Type.String(),
        kind: RoomKind,
        status: RoomStatus,
        beds: Type.Array(Strict({ id: ObjectIdString, label: Type.String(), state: BedState })),
        bedTotal: Nullable(Paise, { description: "Shared rooms: one free bed for this stay, before coupons and the platform fee; null when no bed is free or not let this way" }),
        roomTotal: Nullable(Paise, { description: "The whole room for this stay; null when it can't be reserved whole for these dates" }),
      }),
    ),
  }),
);

// Reserving.

const ReturnTo = Type.String({
  maxLength: 500,
  description: "Where the checkout page sends the customer afterwards: this site, or the app's own link. `order=<id>` is added.",
});
const stayFields = {
  bedId: Type.Optional(ObjectIdString),
  whole: Type.Optional(Type.Boolean({ description: "Shared rooms: every bed of the room. Private rooms are always whole" })),
  moveIn: Day,
  stay: Type.Optional(Type.Union([Type.Literal("month"), Type.Literal("night")], { default: "month" })),
  months: Type.Optional(Type.Integer({ minimum: 1, maximum: 12, description: "stay=month: months paid now, the first included; up to the rules' `maxMonths`. Default 1" })),
  nights: Type.Optional(Type.Integer({ minimum: 1, maximum: 90, description: "stay=night: up to the rules' `maxNights`. Default 1" })),
};
export const ReserveBody = Strict(
  { ...stayFields, coupon: Type.Optional(Type.String({ minLength: 3, maxLength: 20 })), returnTo: ReturnTo },
  { description: "A shared room needs `bedId` or `whole: true`" },
);
export const OffersBody = Strict({ ...stayFields, code: Type.Optional(Type.String({ minLength: 3, maxLength: 20, description: "Check this code too" })) });
export const OffersOne = Envelope(
  Strict({
    offers: Type.Array(Offer),
    checked: Nullable(Strict({ code: Type.String(), discount: Paise, problem: Nullable(Type.String()) }), { description: "With `code`" }),
  }),
);
export const PayBody = Strict({ returnTo: ReturnTo });
export const CancelBody = Strict({ reason: Type.Optional(Type.String({ minLength: 2, maxLength: 300 })) });
export const OwnerCancelBody = Strict({ reason: Reason });
export const ObjectionBody = Strict({ reason: Type.String({ minLength: 5, maxLength: 500, description: "What's wrong; Ruxstar support reads it" }) });
export const NoticeBody = Strict({
  on: Type.Optional(Day),
});

const Status = Type.Union([
  Type.Literal("awaiting_payment"),
  Type.Literal("confirmed"),
  Type.Literal("moved_in"),
  Type.Literal("moved_out"),
  Type.Literal("cancelled"),
], { description: "confirmed: paid, waiting for move-in. moved_in: the owner marked it; the stay may have an end date (`until`)" });
const Objection = Strict({
  reason: Type.String(),
  at: DateTime,
  status: Type.Union([Type.Literal("open"), Type.Literal("withdrawn"), Type.Literal("released"), Type.Literal("refunded")], {
    description: "released: Ruxstar paid the owner. refunded: Ruxstar refunded the tenant",
  }),
  note: Nullable(Type.String({ description: "Ruxstar's note when it decided" })),
  resolvedAt: Nullable(DateTime),
});

const reservationFields = {
  id: ObjectIdString,
  orderNo: Type.Integer(),
  status: Status,
  property: Strict({
    id: ObjectIdString,
    name: Type.String(),
    kind: Kind,
    address: Type.String(),
    city: Type.String(),
    point: Nullable(Point),
    photo: Nullable(Photo),
    removed: Type.Boolean({ description: "Taken down by Ruxstar" }),
  }),
  room: Strict({ id: ObjectIdString, name: Type.String(), kind: RoomKind }),
  beds: Type.Array(Bed),
  whole: Type.Boolean(),
  business: Business,
  stay: Unit,
  units: Type.Integer({ description: "Months or nights paid" }),
  moveIn: Day,
  from: DateTime,
  until: Nullable(DateTime, { description: "When the beds are free again; null while a monthly stay has no end date" }),
  price: Strict({ unitPrice: Paise, quantity: Type.Integer({ description: "Beds charged" }), items: Paise, discount: Paise, platformFee: Paise, total: Paise }),
  coupon: Nullable(AppliedCoupon),
  deposit: Deposit,
  noticeDays: Type.Integer(),
  refundRule: Type.String(),
  refundUntil: DateTime,
  refund: Nullable(Strict({ amount: Paise, status: Type.Union([Type.Literal("pending"), Type.Literal("done")]), reason: Nullable(Type.String()), at: DateTime })),
  cancellation: Nullable(
    Strict({ by: Type.Union([Type.Literal("customer"), Type.Literal("property"), Type.Literal("ruxstar"), Type.Literal("system")]), reason: Type.String(), at: DateTime }),
  ),
  movedInAt: Nullable(DateTime),
  objectionUntil: Nullable(DateTime, { description: "After \"Moved in\": the tenant can object until then" }),
  objection: Nullable(Objection),
  moveOut: Nullable(Strict({ on: Day, kind: Type.Union([Type.Literal("notice"), Type.Literal("move_out")]), by: Type.Union([Type.Literal("tenant"), Type.Literal("property"), Type.Literal("ruxstar")]) })),
  staying: Type.Boolean({ description: "Moved in and not moved out yet" }),
  reason: Nullable(Type.String()),
  payBy: Nullable(DateTime, { description: "Unpaid, the beds go back after this" }),
  createdAt: DateTime,
};
export const StayReservation = Strict({
  ...reservationFields,
  canCancel: Type.Boolean({ description: "Unpaid, or paid and not moved in" }),
  refundIfCancelled: Nullable(Paise, { description: "What cancelling now gives back" }),
  canObject: Type.Boolean({ description: "Within the window after \"Moved in\", with no objection yet" }),
  canGiveNotice: Type.Boolean({ description: "A monthly stay with no end date yet" }),
  noticeFrom: Nullable(Day, { description: "The earliest move-out day a notice now can ask for" }),
  invoices: InvoiceRefs,
  ...ReviewEligibility,
});
export type StayReservation = Static<typeof StayReservation>;
export const StayReservationOne = Envelope(StayReservation);
export const StayReservationList = ListEnvelope(StayReservation);
export const PlacedReservation = Envelope(Strict({ reservation: StayReservation, checkoutUrl: Type.String() }));
export const CheckoutLinkOne = Envelope(Strict({ checkoutUrl: Type.String() }));
export const MyStaysQuery = Strict({
  ...PageQuery,
  view: Type.Optional(
    Type.Union([Type.Literal("current"), Type.Literal("past")], { default: "current", description: "current: unpaid, waiting for move-in, or staying" }),
  ),
});

// The owner's setup.

export const CreatePropertyBody = Strict({
  name: Type.String({ minLength: 2, maxLength: NAME_MAX }),
  kind: Type.Optional(Kind),
  description: Type.Optional(Nullable(Type.String({ maxLength: DESCRIPTION_MAX }))),
  address: Address,
  for: For,
  occupants: Type.Optional(Type.Array(Occupant, { maxItems: 2, uniqueItems: true, description: "Empty or left out: anyone" })),
  food: Type.Optional(Food),
  facilities: Type.Optional(Type.Array(FacilityKey, { maxItems: 40, uniqueItems: true })),
  rules: Type.Optional(HouseRules),
  noticeDays: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_NOTICE_DAYS, description: "Days of notice before moving out. Default 30" })),
  deposit: Type.Optional(DepositInput),
  nearby: Type.Optional(Type.Array(Nearby, { maxItems: MAX_NEARBY })),
  refundDays: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 60,
      description: "Full refund until this many days before move-in: at least the rules' `refundDays` (stricter means more days), at most `maxRefundDays`. Default: Ruxstar's",
    }),
  ),
});
export const UpdatePropertyBody = Type.Partial(CreatePropertyBody, { additionalProperties: false, minProperties: 1 });

export const RoomBody = Strict({
  name: Type.String({ minLength: 1, maxLength: 40 }),
  kind: RoomKind,
  beds: Type.Integer({ minimum: 1, maximum: 24, description: "Up to the rules' `maxBeds`. A private room is one unit however many beds" }),
  wholeRoom: Type.Optional(Type.Boolean({ description: "Shared rooms: let customers reserve every bed together. Default true" })),
  prices: RoomPrices,
  features: Type.Optional(Type.Array(Feature, { maxItems: 5, uniqueItems: true })),
  status: Type.Optional(RoomStatus),
});
export const UpdateRoomBody = Type.Partial(RoomBody, { additionalProperties: false, minProperties: 1 });
export const RoomPricesBody = Strict({ prices: RoomPrices });

export const VendorProperty = Strict({
  ...PropertyDetail.properties,
  refundLimits: Strict({ min: Type.Integer(), max: Type.Integer() }, { description: "The refund days it can pick" }),
  publishedAt: Nullable(DateTime),
  removal: Nullable(Strict({ reason: Type.String(), at: DateTime })),
  missing: Type.Array(Type.String(), { description: "What it needs before it can be published" }),
  upcoming: Type.Integer({ description: "Paid reservations waiting for move-in" }),
  staying: Type.Integer({ description: "Tenants moved in and not moved out" }),
});
export type VendorProperty = Static<typeof VendorProperty>;
export const VendorPropertyOne = Envelope(VendorProperty);
export const VendorPropertyList = ListEnvelope(VendorProperty);

// The desk: the owner and their team.

export const DeskProperty = Strict({
  id: ObjectIdString,
  name: Type.String(),
  kind: Kind,
  business: Business,
  status: PropertyStatus,
  rooms: Type.Integer(),
  beds: Type.Integer(),
  owner: Type.Boolean(),
  permissions: Type.Array(Type.String(), { description: "The owner has every one" }),
});
export const DeskPropertyList = ListEnvelope(DeskProperty);

const BoardReservation = Strict({
  id: ObjectIdString,
  orderNo: Type.Integer(),
  tenantName: Type.String(),
  status: Status,
  moveIn: Day,
  until: Nullable(DateTime),
});
export const BoardQuery = Strict({ date: Type.Optional(Day) });
export const Board = Envelope(
  Strict({
    property: Strict({ id: ObjectIdString, name: Type.String() }),
    date: Day,
    rooms: Type.Array(
      Strict({
        id: ObjectIdString,
        name: Type.String(),
        kind: RoomKind,
        status: RoomStatus,
        prices: RoomPrices,
        beds: Type.Array(
          Strict({
            id: ObjectIdString,
            label: Type.String(),
            status: Type.Union([Type.Literal("open"), Type.Literal("closed")], { description: "closed: you marked it full" }),
            state: Type.Union([Type.Literal("free"), Type.Literal("held"), Type.Literal("reserved"), Type.Literal("occupied"), Type.Literal("closed")], {
              description: "That day. held: someone is paying now. reserved: paid, not moved in. occupied: moved in",
            }),
            reservation: Nullable(BoardReservation),
            next: Nullable(BoardReservation, { description: "Free that day: the next reservation of the bed, if any" }),
          }),
        ),
      }),
    ),
    totals: Strict({ beds: Type.Integer(), free: Type.Integer(), held: Type.Integer(), reserved: Type.Integer(), occupied: Type.Integer(), closed: Type.Integer() }),
  }),
);
export const BedStatusBody = Strict({ status: Type.Union([Type.Literal("open"), Type.Literal("closed")], { description: "closed: full or unavailable; reservations made stand" }) });
export const RoomStatusBody = Strict({ status: RoomStatus });
export const BedOne = Envelope(Strict({ id: ObjectIdString, label: Type.String(), status: Type.Union([Type.Literal("open"), Type.Literal("closed")]) }));

export const DeskReservation = Strict({
  ...reservationFields,
  tenant: Strict({ name: Type.String(), phone: Nullable(Type.String()), verified: Type.Boolean({ description: "Base KYC approved" }) }),
  vendorShare: Paise,
  payout: Type.Union([Type.Literal("none"), Type.Literal("waiting"), Type.Literal("objection"), Type.Literal("released"), Type.Literal("refunded")], {
    description: "Your share. waiting: until \"Moved in\" and the objection window. objection: the tenant objected; Ruxstar decides",
  }),
  releaseAt: Nullable(DateTime),
  canMoveIn: Type.Boolean(),
  canMoveOut: Type.Boolean(),
  canCancel: Type.Boolean({ description: "Paid and the money not released yet; always a full refund" }),
});
export type DeskReservation = Static<typeof DeskReservation>;
export const DeskReservationOne = Envelope(DeskReservation);
export const DeskReservationList = ListEnvelope(DeskReservation);
export const DeskReservationsQuery = Strict({
  ...PageQuery,
  view: Type.Optional(
    Type.Union([Type.Literal("upcoming"), Type.Literal("staying"), Type.Literal("past"), Type.Literal("all")], {
      default: "upcoming",
      description: "upcoming: paid, waiting for move-in. staying: moved in, not moved out. past: moved out or cancelled",
    }),
  ),
});
export const MoveOutBody = Strict({
  on: Type.Optional(Day),
  reason: Type.Optional(Type.String({ maxLength: 300 })),
});

// The console.

export const ConsoleProperty = Strict({
  ...cardFields,
  status: PropertyStatus,
  vendorId: ObjectIdString,
  removal: Nullable(Strict({ reason: Type.String(), at: DateTime })),
  createdAt: DateTime,
});
export const ConsolePropertyList = ListEnvelope(ConsoleProperty);
export const ConsolePropertiesQuery = Strict({
  ...PageQuery,
  status: Type.Optional(PropertyStatus),
  city: Type.Optional(Type.String({ minLength: 2, maxLength: 60 })),
});
export const ConsolePropertyDetail = Strict({
  property: VendorProperty,
  reservations: Strict({ upcoming: Type.Integer(), staying: Type.Integer(), total: Type.Integer(), cancelled: Type.Integer(), objections: Type.Integer() }),
});
export const ConsolePropertyOne = Envelope(ConsolePropertyDetail);
export const TakeDownBody = Strict({ reason: Type.String({ minLength: 5, maxLength: 300, description: "The owner and every tenant refunded are told" }) });
export const TakeDownResult = Envelope(Strict({ property: VendorProperty, refunded: Type.Integer({ description: "Reservations not moved in yet, refunded in full" }) }));

export const ConsoleFacility = Strict({ key: Type.String(), name: Type.String(), active: Type.Boolean(), order: Type.Integer() });
export const ConsoleFacilityList = ListEnvelope(ConsoleFacility);
export const ConsoleFacilityOne = Envelope(ConsoleFacility);
export const CreateFacilityBody = Strict({
  key: FacilityKey,
  name: Type.String({ minLength: 2, maxLength: 40 }),
  order: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
});
export const UpdateFacilityBody = Strict(
  {
    name: Type.Optional(Type.String({ minLength: 2, maxLength: 40 })),
    active: Type.Optional(Type.Boolean({ description: "Inactive facilities stay on the properties that have them but can't be picked" })),
    order: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
  },
  { minProperties: 1 },
);
export const FacilityParams = Strict({ key: FacilityKey });

export const ConsoleReservation = Strict({
  ...reservationFields,
  tenant: Strict({ id: ObjectIdString, name: Type.String() }),
  vendorId: ObjectIdString,
  releaseAt: Nullable(DateTime),
  releasedAt: Nullable(DateTime),
});
export type ConsoleReservation = Static<typeof ConsoleReservation>;
export const ConsoleReservationList = ListEnvelope(ConsoleReservation);
export const ConsoleReservationOne = Envelope(ConsoleReservation);
export const ObjectionsQuery = Strict({
  ...PageQuery,
  status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("withdrawn"), Type.Literal("released"), Type.Literal("refunded")], { default: "open" })),
});
export const DecideObjectionBody = Strict({
  decision: Type.Union([Type.Literal("release"), Type.Literal("refund")], { description: "release: pay the owner. refund: everything back to the tenant and the stay ends" }),
  note: Type.String({ minLength: 5, maxLength: 500, description: "Both sides are told" }),
});
