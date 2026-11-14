import { Type, type Static, type TSchema } from "typebox";
import { DateTime, Envelope, ListEnvelope, ObjectIdString, PageQuery, Paise, Strict } from "../../contracts/common.js";
import { Point } from "../vendor/contracts.js";

const Nullable = <T extends TSchema>(schema: T, options?: { description: string }) => Type.Union([schema, Type.Null()], options);

/** Tickets in one order, people or players. */
export const MAX_PER_ORDER = 10;
/** ₹1,00,000 a ticket or team. */
export const MAX_TICKET_PRICE = 1_00_000_00;
export const MAX_CAPACITY = 100_000;
/** One event runs for up to this many days, so a ticket gets one entry on each. */
export const MAX_EVENT_DAYS = 14;
export const TITLE_MAX = 80;
export const DESCRIPTION_MAX = 2000;

export const EventKind = Type.Union([Type.Literal("show"), Type.Literal("sports"), Type.Literal("meetup")], {
  description: "show: concerts and live shows. sports: matches and tournaments. meetup: workshops, talks and meetups",
});
const Refunds = Type.Union([Type.Literal("standard"), Type.Literal("none")], {
  description: "standard: customers can cancel for a full refund until Ruxstar's refund hours before the start. none: no refunds",
});
const Phone = Type.String({ pattern: "^[6-9][0-9]{9}$", description: "10 digits" });

// The organiser's side.

const TierBody = Strict({
  id: Type.Optional(Type.String({ maxLength: 40, description: "When editing: the ticket type it changes. Leave out for a new one" })),
  name: Type.String({ minLength: 1, maxLength: 40, description: "For example General, VIP or Early bird" }),
  price: Type.Integer({ minimum: 0, maximum: MAX_TICKET_PRICE, description: "Paise per person, or per team for team entries. 0 is free" }),
  capacity: Type.Integer({ minimum: 1, maximum: MAX_CAPACITY, description: "People, or teams for team entries" }),
});
const QuestionBody = Strict({
  id: Type.Optional(Type.String({ maxLength: 40 })),
  label: Type.String({ minLength: 3, maxLength: 80, description: "Asked for each ticket holder, for example T-shirt size" }),
  required: Type.Boolean(),
});
const VenueBody = Strict({
  name: Type.String({ minLength: 2, maxLength: 80 }),
  address: Type.String({ minLength: 5, maxLength: 200 }),
  city: Type.String({ minLength: 2, maxLength: 60 }),
  point: Type.Optional(Nullable(Point)),
});
const OnlineBody = Strict({
  link: Type.String({ pattern: "^https://", maxLength: 500, description: "The meeting link. Only people with a ticket see it" }),
});
const TeamBody = Strict(
  { min: Type.Integer({ minimum: 1, maximum: 50 }), max: Type.Integer({ minimum: 1, maximum: 50 }) },
  { description: "Team entries: the captain pays one price per team and names this many players, each with a ticket" },
);

const eventFields = {
  title: Type.String({ minLength: 3, maxLength: TITLE_MAX }),
  description: Nullable(Type.String({ maxLength: DESCRIPTION_MAX })),
  kind: EventKind,
  venue: Nullable(VenueBody, { description: "Null for an online event" }),
  online: Nullable(OnlineBody, { description: "Set for an online event, which has no venue and nothing to scan" }),
  startsAt: DateTime,
  endsAt: DateTime,
  team: Nullable(TeamBody),
  tiers: Type.Array(TierBody, { minItems: 1, maxItems: 10, description: "Ruxstar sets how many; GET /v1/events/rules says" }),
  questions: Type.Array(QuestionBody, { maxItems: 10, description: "Ruxstar sets how many; GET /v1/events/rules says" }),
  refunds: Refunds,
};
export const CreateEventBody = Strict(eventFields);
export const UpdateEventBody = Strict(
  {
    title: Type.Optional(eventFields.title),
    description: Type.Optional(eventFields.description),
    kind: Type.Optional(eventFields.kind),
    venue: Type.Optional(eventFields.venue),
    online: Type.Optional(eventFields.online),
    startsAt: Type.Optional(eventFields.startsAt),
    endsAt: Type.Optional(eventFields.endsAt),
    team: Type.Optional(eventFields.team),
    tiers: Type.Optional(eventFields.tiers),
    questions: Type.Optional(eventFields.questions),
    refunds: Type.Optional(eventFields.refunds),
  },
  {
    minProperties: 1,
    description:
      "Send only what changes. `tiers` and `questions` replace the lists: keep a ticket type's id to change it. A type with sales can't be " +
      "removed or go below what's sold, and team entries can't change once anything is sold. Ticket holders are told when the time or place changes.",
  },
);
export const CancelEventBody = Strict({
  reason: Type.String({ minLength: 5, maxLength: 300, description: "Every ticket holder is told" }),
});

export const EventParams = Strict({ id: ObjectIdString });
export const BusinessEventsParams = Strict({ id: ObjectIdString });

const Photo = Nullable(Strict({ url: Type.String(), width: Type.Integer(), height: Type.Integer() }));
const Venue = Strict({ name: Type.String(), address: Type.String(), city: Type.String(), point: Nullable(Point) });

const cardFields = {
  id: ObjectIdString,
  title: Type.String(),
  kind: EventKind,
  business: Strict({ id: ObjectIdString, name: Type.String() }),
  photo: Photo,
  startsAt: DateTime,
  endsAt: DateTime,
  city: Nullable(Type.String()),
  venueName: Nullable(Type.String()),
  online: Type.Boolean(),
  team: Type.Boolean({ description: "Team entries: the price is per team" }),
  priceFrom: Paise,
  free: Type.Boolean({ description: "Every ticket type is free" }),
  soldOut: Type.Boolean(),
};
export const EventCard = Strict(cardFields);
export type EventCard = Static<typeof EventCard>;
export const EventList = ListEnvelope(EventCard);
export const EventsQuery = Strict({
  ...PageQuery,
  city: Type.Optional(Type.String({ minLength: 2, maxLength: 60 })),
  kind: Type.Optional(EventKind),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "Words in the title or the organiser's name" })),
});

const TierView = Strict({
  id: Type.String(),
  name: Type.String(),
  price: Paise,
  left: Type.Integer({ minimum: 0, description: "Tickets (or teams) that can be bought now" }),
  soldOut: Type.Boolean(),
});
const Question = Strict({ id: Type.String(), label: Type.String(), required: Type.Boolean() });
const RefundRule = Strict({
  policy: Refunds,
  until: Nullable(DateTime, { description: "Cancel before this for a full refund; null with no refunds" }),
  hours: Type.Integer({ description: "Hours before the start that refunds stop" }),
});

const MyWait = Strict({
  id: ObjectIdString,
  tierId: Type.String(),
  quantity: Type.Integer(),
  status: Type.Union([Type.Literal("waiting"), Type.Literal("offered")]),
  position: Nullable(Type.Integer({ description: "1 is next; null once seats are offered" })),
  offeredUntil: Nullable(DateTime, { description: "Book before this, or the seats go to the next person" }),
});

export const EventDetail = Strict({
  ...cardFields,
  description: Nullable(Type.String()),
  venue: Nullable(Venue),
  onlineLink: Nullable(Type.String({ description: "Only for people with a confirmed ticket" })),
  teamSize: Nullable(Strict({ min: Type.Integer(), max: Type.Integer() })),
  tiers: Type.Array(TierView),
  questions: Type.Array(Question),
  refunds: RefundRule,
  platformFee: Paise,
  status: Type.Union([Type.Literal("live"), Type.Literal("cancelled"), Type.Literal("ended")]),
  cancelReason: Nullable(Type.String()),
  canBuy: Type.Boolean(),
  whyNot: Nullable(Type.String({ description: "Why tickets can't be bought now" })),
  myOrders: Type.Array(
    Strict({ id: ObjectIdString, orderNo: Type.Integer(), status: Type.String(), tickets: Type.Integer() }),
    { description: "Your orders for it, newest first" },
  ),
  myWaits: Type.Array(MyWait),
  maxPerOrder: Type.Integer(),
});
export type EventDetail = Static<typeof EventDetail>;
export const EventOne = Envelope(EventDetail);

const VendorTier = Strict({
  id: Type.String(),
  name: Type.String(),
  price: Paise,
  capacity: Type.Integer(),
  sold: Type.Integer({ description: "Paid or free tickets (or teams) confirmed" }),
  held: Type.Integer({ description: "Waiting for payment, or held for someone on the waitlist" }),
  left: Type.Integer(),
});
export const VendorEvent = Strict({
  ...cardFields,
  description: Nullable(Type.String()),
  venue: Nullable(Venue),
  onlineLink: Nullable(Type.String()),
  teamSize: Nullable(Strict({ min: Type.Integer(), max: Type.Integer() })),
  tiers: Type.Array(VendorTier),
  questions: Type.Array(Question),
  refunds: Refunds,
  status: Type.Union([Type.Literal("draft"), Type.Literal("live"), Type.Literal("cancelled"), Type.Literal("ended")]),
  publishedAt: Nullable(DateTime),
  cancellation: Nullable(Strict({ by: Type.Union([Type.Literal("vendor"), Type.Literal("staff")]), reason: Type.String(), at: DateTime })),
  counts: Strict({
    tickets: Type.Integer({ description: "Confirmed tickets, one per person" }),
    checkedIn: Type.Integer({ description: "Tickets checked in today" }),
    waiting: Type.Integer({ description: "People on the waitlist" }),
  }),
  money: Strict({
    sales: Paise,
    share: Paise,
    commissionBps: Type.Integer(),
  }),
  missing: Type.Array(Type.String(), { description: "What publishing still needs, in words" }),
  createdAt: DateTime,
  updatedAt: DateTime,
});
export type VendorEvent = Static<typeof VendorEvent>;
export const VendorEventOne = Envelope(VendorEvent);
export const VendorEventList = ListEnvelope(VendorEvent);

const BookingTicket = Strict({
  id: ObjectIdString,
  name: Type.String(),
  phone: Nullable(Type.String()),
  tier: Type.String(),
  code: Type.String(),
  answers: Type.Array(Strict({ label: Type.String(), answer: Type.String() })),
  status: Type.Union([Type.Literal("awaiting_payment"), Type.Literal("valid"), Type.Literal("cancelled")]),
  lastIn: Nullable(DateTime),
});
export const Booking = Strict({
  id: ObjectIdString,
  orderNo: Type.Integer(),
  status: Type.Union([Type.Literal("awaiting_payment"), Type.Literal("confirmed"), Type.Literal("cancelled")]),
  team: Nullable(Type.String()),
  total: Paise,
  share: Paise,
  refunded: Paise,
  tickets: Type.Array(BookingTicket),
  createdAt: DateTime,
});
export type Booking = Static<typeof Booking>;
export const BookingList = ListEnvelope(Booking);
export const BookingsQuery = Strict({
  ...PageQuery,
  status: Type.Optional(Type.Union([Type.Literal("confirmed"), Type.Literal("cancelled")])),
});

export const EventRulesView = Strict({
  refundHours: Type.Integer(),
  waitlistHours: Type.Integer(),
  maxTicketTypes: Type.Integer(),
  maxQuestions: Type.Integer(),
  maxPerOrder: Type.Integer(),
  maxDays: Type.Integer(),
  commissionBps: Type.Integer(),
  platformFee: Paise,
});
export const EventRulesOne = Envelope(EventRulesView);

// The customer's side.

const ReturnTo = Type.String({
  maxLength: 500,
  description: "Where the checkout page sends the customer afterwards: this site, or the app's own link. `order=<id>` is added.",
});
const HolderBody = Strict({
  tierId: Type.String({ maxLength: 40, description: "Ignored for team entries: the team's ticket type is used" }),
  name: Type.String({ minLength: 2, maxLength: 60 }),
  phone: Phone,
  answers: Type.Optional(Type.Array(Strict({ id: Type.String({ maxLength: 40 }), answer: Type.String({ minLength: 1, maxLength: 200 }) }), { maxItems: 10 })),
});
export const CreateTicketsBody = Strict({
  tickets: Type.Array(HolderBody, { minItems: 1, maxItems: 50, description: "One per person, or per player for a team entry" }),
  team: Type.Optional(Strict({ tierId: Type.String({ maxLength: 40 }), name: Type.String({ minLength: 2, maxLength: 60 }) })),
  waitlistId: Type.Optional(ObjectIdString),
  returnTo: ReturnTo,
});
export const PayTicketsBody = Strict({ returnTo: ReturnTo });
export const JoinWaitlistBody = Strict({
  tierId: Type.String({ maxLength: 40 }),
  quantity: Type.Integer({ minimum: 1, maximum: MAX_PER_ORDER }),
});
export const WaitParams = Strict({ id: ObjectIdString });

const TicketView = Strict({
  id: ObjectIdString,
  name: Type.String(),
  phone: Nullable(Type.String()),
  tier: Type.String(),
  team: Nullable(Type.String()),
  code: Type.String({ description: "Six letters the gate can type in instead of scanning" }),
  qr: Nullable(Type.String({ description: "What the QR code holds; only on valid tickets" })),
  status: Type.Union([Type.Literal("awaiting_payment"), Type.Literal("valid"), Type.Literal("cancelled")]),
  checkedInAt: Nullable(DateTime, { description: "The latest entry" }),
});
export const TicketOrder = Strict({
  id: ObjectIdString,
  orderNo: Type.Integer(),
  status: Type.Union([Type.Literal("awaiting_payment"), Type.Literal("confirmed"), Type.Literal("cancelled")]),
  event: Strict({
    id: ObjectIdString,
    title: Type.String(),
    startsAt: DateTime,
    endsAt: DateTime,
    venueName: Nullable(Type.String()),
    address: Nullable(Type.String()),
    city: Nullable(Type.String()),
    online: Type.Boolean(),
    onlineLink: Nullable(Type.String()),
    photo: Photo,
    cancelled: Type.Boolean(),
  }),
  business: Strict({ id: ObjectIdString, name: Type.String() }),
  lines: Type.Array(Strict({ tierId: Type.String(), name: Type.String(), quantity: Type.Integer(), unitPrice: Paise })),
  team: Nullable(Type.String()),
  price: Strict({ items: Paise, platformFee: Paise, total: Paise }),
  refund: Nullable(Strict({ amount: Paise, status: Type.Union([Type.Literal("pending"), Type.Literal("done")]), reason: Nullable(Type.String()) })),
  reason: Nullable(Type.String()),
  canCancel: Type.Boolean(),
  cancelUntil: Nullable(DateTime, { description: "Cancel before this for a full refund" }),
  payBy: Nullable(DateTime, { description: "Unpaid orders give their seats back after this" }),
  tickets: Type.Array(TicketView),
  createdAt: DateTime,
});
export type TicketOrder = Static<typeof TicketOrder>;
export const TicketOrderOne = Envelope(TicketOrder);
export const TicketOrderList = ListEnvelope(TicketOrder);
export const PlacedTickets = Envelope(
  Strict({ order: TicketOrder, checkoutUrl: Nullable(Type.String({ description: "Null when it was free and is confirmed already" })) }),
);
export const CheckoutLinkOne = Envelope(Strict({ checkoutUrl: Type.String() }));
export const MyTicketsQuery = Strict({
  ...PageQuery,
  view: Type.Optional(Type.Union([Type.Literal("upcoming"), Type.Literal("past")], { default: "upcoming" })),
});
export const WaitOne = Envelope(MyWait);

// The gate.

export const DeskEvent = Strict({
  id: ObjectIdString,
  title: Type.String(),
  business: Strict({ id: ObjectIdString, name: Type.String() }),
  startsAt: DateTime,
  endsAt: DateTime,
  venueName: Nullable(Type.String()),
  photo: Photo,
  today: Type.Boolean({ description: "Tickets can be checked in today" }),
  days: Type.Array(Type.String({ description: "YYYY-MM-DD, in India" })),
  counts: Strict({ tickets: Type.Integer(), inToday: Type.Integer() }),
  canSeeGuests: Type.Boolean(),
  role: Type.Union([Type.Literal("owner"), Type.Literal("team")]),
});
export const DeskEventList = ListEnvelope(DeskEvent);
export const DeskEventOne = Envelope(DeskEvent);

const ScanTicket = Strict({ id: ObjectIdString, name: Type.String(), tier: Type.String(), team: Nullable(Type.String()), code: Type.String() });
export const ScanResult = Strict({
  result: Type.Union(
    [
      Type.Literal("ok"),
      Type.Literal("inside"),
      Type.Literal("wrong_event"),
      Type.Literal("wrong_day"),
      Type.Literal("cancelled"),
      Type.Literal("unknown"),
    ],
    {
      description:
        "ok (green): let them in. inside (amber): already checked in today, let them back in. wrong_event, wrong_day, cancelled, unknown (red): don't",
    },
  ),
  ticket: Nullable(ScanTicket),
  firstAt: Nullable(DateTime, { description: "With inside: when they first came in today" }),
  message: Type.String(),
  counts: Strict({ tickets: Type.Integer(), inToday: Type.Integer() }),
});
export const ScanResultOne = Envelope(ScanResult);
export const ScanBody = Strict({ qr: Type.String({ minLength: 1, maxLength: 200, description: "What the camera read" }) });
export const LookupQuery = Strict({
  q: Type.String({ minLength: 4, maxLength: 20, description: "A ticket's six letters, or a phone number's 10 digits" }),
});
export const LookupList = ListEnvelope(
  Strict({
    ...ScanTicket.properties,
    phone: Type.String({ description: "The last four digits only" }),
    status: Type.Union([Type.Literal("awaiting_payment"), Type.Literal("valid"), Type.Literal("cancelled")]),
    inToday: Nullable(DateTime),
  }),
);
export const TicketParams = Strict({ id: ObjectIdString, ticketId: ObjectIdString });

export const OfflineList = Envelope(
  Strict({
    eventId: ObjectIdString,
    day: Type.String(),
    at: DateTime,
    tickets: Type.Array(
      Strict({
        h: Type.String({ description: "SHA-256 of the QR text, hex" }),
        id: ObjectIdString,
        c: Type.String({ description: "The six letters" }),
        n: Type.String({ description: "The holder's name" }),
        t: Type.String({ description: "The ticket type" }),
        p: Type.String({ description: "SHA-256 of the phone's 10 digits, hex, for looking up by phone" }),
        s: Type.Union([Type.Literal("v"), Type.Literal("x")], { description: "v: valid. x: cancelled" }),
        i: Nullable(DateTime, { description: "When they first came in today" }),
      }),
    ),
  }),
);
export const SyncBody = Strict({
  scans: Type.Array(
    Strict({
      ticketId: ObjectIdString,
      at: DateTime,
      manual: Type.Boolean(),
      fresh: Type.Boolean({ description: "This phone showed green: it thought they were coming in for the first time today" }),
    }),
    { minItems: 1, maxItems: 500 },
  ),
});
export const SyncResult = Envelope(
  Strict({
    saved: Type.Integer(),
    clashes: Type.Array(Strict({ ticketId: ObjectIdString, name: Type.String(), code: Type.String(), firstAt: DateTime }), {
      description: "Let in as new on two phones while offline",
    }),
    counts: Strict({ tickets: Type.Integer(), inToday: Type.Integer() }),
  }),
);

export const GuestsQuery = Strict({
  ...PageQuery,
  view: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("arrived"), Type.Literal("not_arrived")], { default: "all" })),
});
export const GuestList = ListEnvelope(
  Strict({
    ...ScanTicket.properties,
    phone: Nullable(Type.String()),
    inToday: Nullable(DateTime),
    by: Nullable(Type.String({ description: "Who checked them in today" })),
    manual: Type.Boolean(),
    clash: Type.Boolean({ description: "Let in as new on two phones while offline" }),
  }),
);
