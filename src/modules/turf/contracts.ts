import { Type, type Static, type TSchema } from "typebox";
import { DateTime, Envelope, ListEnvelope, ObjectIdString, PageQuery, Paise, Strict } from "../../contracts/common.js";
import { AppliedCoupon, Offer } from "../coupons/contracts.js";
import { InvoiceRefs } from "../invoices/contracts.js";
import { Rating, ReviewEligibility } from "../reviews/contracts.js";
import { TurfRules } from "../ruxstar/contracts.js";
import { Point } from "../vendor/contracts.js";
import { MAX_PEAKS, MAX_PRICE } from "./rules.js";

const Nullable = <T extends TSchema>(schema: T, options?: { description: string }) => Type.Union([schema, Type.Null()], options);

export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 2000;

const Day = Type.String({ format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD, in India" });
const Clock = Type.String({ pattern: "^(([01]\\d|2[0-3]):(00|30)|24:00)$", description: "HH:MM in India, on the hour or half hour. 24:00 is midnight at the end of the day" });
const Weekday = Type.Integer({ minimum: 0, maximum: 6, description: "0 Sunday, 1 Monday … 6 Saturday" });
const Price = Type.Integer({ minimum: 100, maximum: MAX_PRICE, description: "Paise per slot, at least ₹1" });
const Reason = Type.String({ minLength: 5, maxLength: 300, description: "The customer is told" });
const Business = Strict({ id: ObjectIdString, name: Type.String() });
const SportKey = Type.String({ pattern: "^[a-z][a-z0-9_]{1,29}$", description: "A key from GET /v1/turf/sports" });
export const Sport = Strict({ key: Type.String(), name: Type.String() });
const Photo = Strict({ id: Type.String(), url: Type.String(), width: Type.Integer(), height: Type.Integer() });

export const Amenity = Type.Union(
  [
    Type.Literal("parking"),
    Type.Literal("washrooms"),
    Type.Literal("changing_rooms"),
    Type.Literal("showers"),
    Type.Literal("drinking_water"),
    Type.Literal("floodlights"),
    Type.Literal("seating"),
    Type.Literal("cafe"),
    Type.Literal("first_aid"),
    Type.Literal("equipment"),
    Type.Literal("lockers"),
    Type.Literal("wifi"),
  ],
  { description: "equipment: bats, balls or rackets to use or rent" },
);
const Venue = Strict({
  address: Type.String({ minLength: 5, maxLength: 300 }),
  city: Type.String({ minLength: 2, maxLength: 60 }),
  pincode: Type.Optional(Nullable(Type.String({ pattern: "^[1-9][0-9]{5}$" }))),
  point: Type.Optional(Nullable(Point)),
});
const VenueView = Strict({ address: Type.String(), city: Type.String(), pincode: Nullable(Type.String()), point: Nullable(Point) });
const Refunds = Strict(
  {
    fullHours: Type.Integer({ minimum: 0, maximum: 168, description: "Full refund this many hours or more before the slot. Within GET /v1/turf/rules' limits" }),
    halfHours: Type.Integer({ minimum: 0, maximum: 168, description: "The partial refund (the rules' `halfPercent`) from this many hours until `fullHours`. At most `fullHours`; equal means none" }),
  },
  { description: "When customers get money back for cancelling" },
);

export const Hours = Strict({ day: Weekday, open: Clock, close: Clock });
export const Peak = Strict({
  days: Type.Array(Weekday, { minItems: 1, maxItems: 7, uniqueItems: true }),
  start: Clock,
  end: Clock,
  price: Price,
});
export const Prices = Strict({
  base: Price,
  weekend: Nullable(Price, { description: "Saturday and Sunday; null for the base price" }),
  peak: Type.Array(Peak, { maxItems: MAX_PEAKS, description: "A slot starting in a window costs its price, before the weekend price" }),
});
const Per = Type.Union([Type.Literal("booking"), Type.Literal("slot")], { description: "booking: once per booking (per date of a repeat). slot: for each slot" });
const AddOnInput = Strict({
  id: Type.Optional(Type.String({ maxLength: 40, description: "Keep an add-on's id when changing it; leave out for a new one" })),
  name: Type.String({ minLength: 2, maxLength: 40 }),
  price: Type.Integer({ minimum: 0, maximum: MAX_PRICE }),
  per: Per,
});
export const AddOn = Strict({ id: Type.String(), name: Type.String(), price: Paise, per: Per });
const SlotLength = Type.Union([Type.Literal(30), Type.Literal(60), Type.Literal(90)], { description: "Minutes. One of the rules' `slotLengths`" });
const CourtStatus = Type.Union([Type.Literal("live"), Type.Literal("paused")], { description: "paused: shown but not bookable" });

export const IdParams = Strict({ id: ObjectIdString });
export const PhotoParams = Strict({ id: ObjectIdString, photoId: Type.String({ maxLength: 60 }) });

// Rules and sports.

export const TurfRulesOne = Envelope(
  Strict({
    ...TurfRules.properties,
    commissionBps: Type.Integer(),
    platformFee: Paise,
  }),
);
export const SportList = ListEnvelope(Sport);

// Grounds and courts, as customers see them.

export const CourtView = Strict({
  id: ObjectIdString,
  name: Type.String(),
  sports: Type.Array(Sport),
  slotMinutes: Type.Integer(),
  hours: Type.Array(Hours),
  prices: Prices,
  addOns: Type.Array(AddOn),
  status: CourtStatus,
});
export type CourtView = Static<typeof CourtView>;

const cardFields = {
  id: ObjectIdString,
  name: Type.String(),
  business: Business,
  city: Type.String(),
  address: Type.String(),
  photo: Nullable(Photo, { description: "The first photo" }),
  sports: Type.Array(Sport),
  amenities: Type.Array(Amenity),
  priceFrom: Nullable(Paise, { description: "The lowest base price of a bookable court" }),
  courts: Type.Integer({ description: "Bookable courts" }),
};
export const GroundCard = Strict(cardFields);
export type GroundCard = Static<typeof GroundCard>;
export const GroundList = ListEnvelope(GroundCard);
export const GroundsQuery = Strict({
  ...PageQuery,
  city: Type.Optional(Type.String({ minLength: 2, maxLength: 60 })),
  sport: Type.Optional(SportKey),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "Words in the ground's or business's name" })),
});

export const GroundDetail = Strict({
  ...cardFields,
  description: Nullable(Type.String()),
  venue: VenueView,
  photos: Type.Array(Photo),
  courtList: Type.Array(CourtView, { description: "Bookable and paused courts, in the ground's order" }),
  refunds: Strict({ fullHours: Type.Integer(), halfHours: Type.Integer(), halfPercent: Type.Integer() }),
  refundRule: Type.String({ description: "The refund rule in one sentence, for above the Pay button" }),
  platformFee: Paise,
  status: Type.Union([Type.Literal("draft"), Type.Literal("live"), Type.Literal("removed")]),
  canBook: Type.Boolean(),
  whyNot: Nullable(Type.String({ description: "Why nobody can book right now" })),
  rating: Type.Optional(Rating),
});
export type GroundDetail = Static<typeof GroundDetail>;
export const GroundOne = Envelope(GroundDetail);

const PublicState = Type.Union([Type.Literal("free"), Type.Literal("booked"), Type.Literal("blocked")], {
  description: "booked includes slots held for someone's checkout",
});
export const SlotsQuery = Strict({ date: Type.Optional(Day) });
export const DaySlots = Envelope(
  Strict({
    court: Strict({ id: ObjectIdString, name: Type.String(), slotMinutes: Type.Integer(), status: CourtStatus }),
    date: Day,
    open: Type.Boolean({ description: "False when the court is closed that day" }),
    bookable: Type.Boolean({ description: "Within how far ahead bookings go, and the court and ground are taking bookings" }),
    slots: Type.Array(
      Strict({
        startAt: DateTime,
        endAt: DateTime,
        start: Type.String({ description: "HH:MM in India" }),
        end: Type.String(),
        price: Paise,
        peak: Type.Boolean(),
        state: PublicState,
      }),
      { description: "Slots that haven't started, in order" },
    ),
  }),
);

// Booking.

const ReturnTo = Type.String({
  maxLength: 500,
  description: "Where the checkout page sends the customer afterwards: this site, or the app's own link. `order=<id>` is added.",
});
export const BookBody = Strict({
  startAts: Type.Array(DateTime, { minItems: 1, maxItems: 48, description: "Back-to-back slots of the court on one day, by their start" }),
  sport: Type.Optional(SportKey),
  addOns: Type.Optional(
    Type.Array(Strict({ id: Type.String({ maxLength: 40 }), quantity: Type.Integer({ minimum: 1, maximum: 20 }) }), { maxItems: 30 }),
  ),
  weeks: Type.Optional(Type.Integer({ minimum: 1, maximum: 52, default: 1, description: "Book the same slots this many weeks running, the first included; all paid now" })),
  coupon: Type.Optional(Type.String({ minLength: 3, maxLength: 20 })),
  returnTo: ReturnTo,
});
export const OffersOne = Envelope(
  Strict({
    offers: Type.Array(Offer),
    checked: Nullable(Strict({ code: Type.String(), discount: Paise, problem: Nullable(Type.String()) }), { description: "With `code`" }),
  }),
);
export const OffersBody = Strict({
  startAts: BookBody.properties.startAts,
  addOns: BookBody.properties.addOns,
  weeks: BookBody.properties.weeks,
  code: Type.Optional(Type.String({ minLength: 3, maxLength: 20, description: "Check this code too" })),
});
export const PayBody = Strict({ returnTo: ReturnTo });
export const CancelBody = Strict({
  occurrences: Type.Optional(
    Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: 52, uniqueItems: true, description: "Dates to cancel by their `n`; leave out for every one still to come" }),
  ),
  reason: Type.Optional(Type.String({ minLength: 2, maxLength: 300 })),
});
export const OwnerCancelBody = Strict({ occurrences: CancelBody.properties.occurrences, reason: Reason });

const Status = Type.Union([Type.Literal("awaiting_payment"), Type.Literal("confirmed"), Type.Literal("cancelled")]);
const Arrival = Nullable(Type.Union([Type.Literal("arrived"), Type.Literal("no_show")]));
const Money = Strict({ percent: Type.Integer(), amount: Paise });

export const Occurrence = Strict({
  n: Type.Integer({ description: "1 for the first date, 2 the week after, …" }),
  startAt: DateTime,
  endAt: DateTime,
  slots: Type.Array(Strict({ startAt: DateTime, endAt: DateTime, price: Paise, peak: Type.Boolean() })),
  items: Paise,
  paid: Paise,
  status: Type.Union([Type.Literal("booked"), Type.Literal("cancelled")]),
  refund: Nullable(Money, { description: "Cancelled: what came back" }),
  cancelledBy: Nullable(Type.Union([Type.Literal("customer"), Type.Literal("ground"), Type.Literal("ruxstar")])),
  cancelReason: Nullable(Type.String()),
  arrival: Arrival,
  canCancel: Type.Boolean(),
  refundIfCancelled: Nullable(Money, { description: "What cancelling it now gives back" }),
});

const bookingFields = {
  id: ObjectIdString,
  orderNo: Type.Integer(),
  status: Status,
  ground: Strict({
    id: ObjectIdString,
    name: Type.String(),
    address: Type.String(),
    city: Type.String(),
    point: Nullable(Point),
    photo: Nullable(Photo),
    removed: Type.Boolean({ description: "Taken down by Ruxstar" }),
  }),
  court: Strict({ id: ObjectIdString, name: Type.String() }),
  business: Business,
  sport: Nullable(Sport),
  slotMinutes: Type.Integer(),
  addOns: Type.Array(Strict({ id: Type.String(), name: Type.String(), price: Paise, per: Per, quantity: Type.Integer() })),
  weeks: Type.Integer(),
  occurrences: Type.Array(Occurrence),
  firstAt: DateTime,
  lastEndsAt: DateTime,
  price: Strict({ items: Paise, discount: Paise, platformFee: Paise, total: Paise }),
  coupon: Nullable(AppliedCoupon),
  refundRule: Type.String(),
  refunds: Type.Array(Strict({ amount: Paise, status: Type.Union([Type.Literal("pending"), Type.Literal("done")]), reason: Type.String(), at: DateTime })),
  reason: Nullable(Type.String()),
  payBy: Nullable(DateTime, { description: "Unpaid, the slots go back after this" }),
  createdAt: DateTime,
};
export const TurfBooking = Strict({
  ...bookingFields,
  canCancel: Type.Boolean({ description: "Some date can be cancelled now, or it is unpaid" }),
  invoices: InvoiceRefs,
  ...ReviewEligibility,
});
export type TurfBooking = Static<typeof TurfBooking>;
export const TurfBookingOne = Envelope(TurfBooking);
export const TurfBookingList = ListEnvelope(TurfBooking);
export const PlacedBooking = Envelope(Strict({ booking: TurfBooking, checkoutUrl: Type.String() }));
export const CheckoutLinkOne = Envelope(Strict({ checkoutUrl: Type.String() }));
export const MyBookingsQuery = Strict({
  ...PageQuery,
  view: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("past")], { default: "current", description: "current: a date still to come, or unpaid" })),
});

// The owner's setup.

export const CreateGroundBody = Strict({
  name: Type.String({ minLength: 2, maxLength: NAME_MAX }),
  description: Type.Optional(Nullable(Type.String({ maxLength: DESCRIPTION_MAX }))),
  venue: Venue,
  amenities: Type.Optional(Type.Array(Amenity, { maxItems: 12, uniqueItems: true })),
  refunds: Type.Optional(Refunds),
});
export const UpdateGroundBody = Type.Partial(CreateGroundBody, { additionalProperties: false, minProperties: 1 });

export const CourtBody = Strict({
  name: Type.String({ minLength: 1, maxLength: 40 }),
  sports: Type.Array(SportKey, { minItems: 1, maxItems: 5, uniqueItems: true }),
  slotMinutes: SlotLength,
  hours: Type.Array(Hours, { maxItems: 7, description: "One entry per open weekday; leave a day out to close it" }),
  prices: Prices,
  addOns: Type.Optional(Type.Array(AddOnInput, { maxItems: 30 })),
  status: Type.Optional(CourtStatus),
});
export const UpdateCourtBody = Type.Partial(CourtBody, { additionalProperties: false, minProperties: 1 });
export const PricesBody = Strict(
  { prices: Type.Optional(Prices), addOns: Type.Optional(Type.Array(AddOnInput, { maxItems: 30 })) },
  { minProperties: 1 },
);

export const VendorGround = Strict({
  ...GroundDetail.properties,
  courtList: Type.Array(CourtView),
  publishedAt: Nullable(DateTime),
  removal: Nullable(Strict({ reason: Type.String(), at: DateTime })),
  missing: Type.Array(Type.String(), { description: "What it needs before it can be published" }),
  upcoming: Type.Integer({ description: "Paid bookings with a date still to come" }),
});
export type VendorGround = Static<typeof VendorGround>;
export const VendorGroundOne = Envelope(VendorGround);
export const VendorGroundList = ListEnvelope(VendorGround);

// The desk: the owner and their team.

export const DeskGround = Strict({
  id: ObjectIdString,
  name: Type.String(),
  business: Business,
  status: Type.Union([Type.Literal("draft"), Type.Literal("live"), Type.Literal("removed")]),
  courts: Type.Integer(),
  owner: Type.Boolean(),
  permissions: Type.Array(Type.String(), { description: "The owner has every one" }),
});
export const DeskGroundList = ListEnvelope(DeskGround);

const BoardBooking = Strict({
  id: ObjectIdString,
  orderNo: Type.Integer(),
  n: Type.Integer({ description: "Which date of the booking" }),
  weeks: Type.Integer(),
  customerName: Type.String(),
  customerPhone: Nullable(Type.String({ description: "Null for a held slot" })),
  status: Status,
  arrival: Arrival,
  startAt: DateTime,
  endAt: DateTime,
});
export const BoardQuery = Strict({ date: Type.Optional(Day) });
export const Board = Envelope(
  Strict({
    ground: Strict({ id: ObjectIdString, name: Type.String() }),
    date: Day,
    courts: Type.Array(
      Strict({
        id: ObjectIdString,
        name: Type.String(),
        slotMinutes: Type.Integer(),
        status: CourtStatus,
        open: Type.Boolean(),
        slots: Type.Array(
          Strict({
            startAt: DateTime,
            endAt: DateTime,
            start: Type.String(),
            end: Type.String(),
            price: Paise,
            peak: Type.Boolean(),
            past: Type.Boolean(),
            state: Type.Union([Type.Literal("free"), Type.Literal("held"), Type.Literal("booked"), Type.Literal("blocked")], {
              description: "held: someone is paying for it now",
            }),
            booking: Nullable(BoardBooking),
            block: Nullable(Strict({ note: Nullable(Type.String()), by: Nullable(Type.String()) })),
          }),
        ),
      }),
    ),
    totals: Strict({ booked: Type.Integer(), blocked: Type.Integer(), free: Type.Integer(), arrived: Type.Integer(), noShow: Type.Integer() }),
  }),
);
export const BlockBody = Strict({
  courtId: ObjectIdString,
  startAts: Type.Array(DateTime, { minItems: 1, maxItems: 96, uniqueItems: true, description: "Slots of the court, by their start" }),
  note: Type.Optional(Type.String({ maxLength: 200, description: "For example \"Maintenance\" or \"Booked by phone\"" })),
});
export const UnblockBody = Strict({ courtId: ObjectIdString, startAts: BlockBody.properties.startAts });
export const BlockResult = Envelope(Strict({ done: Type.Integer({ description: "Slots changed" }) }));

export const DeskBooking = Strict({
  ...bookingFields,
  customer: Strict({ name: Type.String(), phone: Nullable(Type.String()) }),
  vendorShare: Paise,
  canCancel: Type.Boolean({ description: "Some date hasn't ended" }),
});
export type DeskBooking = Static<typeof DeskBooking>;
export const DeskBookingOne = Envelope(DeskBooking);
export const DeskBookingList = ListEnvelope(DeskBooking);
export const DeskBookingsQuery = Strict({
  ...PageQuery,
  view: Type.Optional(
    Type.Union([Type.Literal("upcoming"), Type.Literal("past"), Type.Literal("all")], { default: "upcoming", description: "upcoming: paid, with a date still to come" }),
  ),
});
export const ArrivalBody = Strict({ n: Type.Integer({ minimum: 1 }), status: Type.Union([Type.Literal("arrived"), Type.Literal("no_show")]) });

// The console.

export const ConsoleGround = Strict({
  ...cardFields,
  status: Type.Union([Type.Literal("draft"), Type.Literal("live"), Type.Literal("removed")]),
  vendorId: ObjectIdString,
  removal: Nullable(Strict({ reason: Type.String(), at: DateTime })),
  createdAt: DateTime,
});
export const ConsoleGroundList = ListEnvelope(ConsoleGround);
export const ConsoleGroundsQuery = Strict({
  ...PageQuery,
  status: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("live"), Type.Literal("removed")])),
});
export const ConsoleGroundDetail = Strict({
  ground: VendorGround,
  bookings: Strict({ upcoming: Type.Integer(), total: Type.Integer(), cancelled: Type.Integer() }),
});
export const ConsoleGroundOne = Envelope(ConsoleGroundDetail);
export const TakeDownBody = Strict({ reason: Type.String({ minLength: 5, maxLength: 300, description: "The owner and every customer refunded are told" }) });
export const TakeDownResult = Envelope(Strict({ ground: VendorGround, refunded: Type.Integer({ description: "Bookings with dates refunded" }) }));

export const ConsoleSport = Strict({ key: Type.String(), name: Type.String(), active: Type.Boolean(), order: Type.Integer() });
export const ConsoleSportList = ListEnvelope(ConsoleSport);
export const ConsoleSportOne = Envelope(ConsoleSport);
export const CreateSportBody = Strict({
  key: SportKey,
  name: Type.String({ minLength: 2, maxLength: 40 }),
  order: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
});
export const UpdateSportBody = Strict(
  {
    name: Type.Optional(Type.String({ minLength: 2, maxLength: 40 })),
    active: Type.Optional(Type.Boolean({ description: "Inactive sports stay on the courts that have them but can't be picked" })),
    order: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
  },
  { minProperties: 1 },
);
export const SportParams = Strict({ key: SportKey });
