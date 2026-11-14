import { Type, type Static, type TSchema } from "typebox";
import { DateTime, Envelope, ListEnvelope, ObjectIdString, PageQuery, Paise, Strict } from "../../contracts/common.js";
import { DeliveryStatus, Vehicle } from "../pod/contracts.js";
import { Point } from "../vendor/contracts.js";

const Nullable = <T extends TSchema>(schema: T, options?: { description: string }) => Type.Union([schema, Type.Null()], options);
const Carrier = Type.Union([Type.Literal("team"), Type.Literal("partner")], {
  description: "`team` is someone on the shop's team; `partner` is a Ruxstar delivery partner, paid out of the shop's share",
});

// The shop's side: who delivers an order.

export const DeliveryOptions = Envelope(
  Strict({
    orderStatus: Type.String(),
    canAssign: Type.Boolean({ description: "The order is ready and nobody has it, so a rider can be picked now" }),
    reason: Nullable(Type.String({ description: "Why a rider can't be picked now" })),
    team: Type.Array(
      Strict({
        placeId: ObjectIdString,
        name: Type.String(),
        avatarUrl: Nullable(Type.String()),
        vehicle: Nullable(Vehicle),
        ready: Type.Boolean({ description: "Delivery verified, so they can take it in the Ruxstar Delivery app" }),
      }),
      { description: 'People on the team with "Deliver orders"' },
    ),
    partner: Strict({
      available: Type.Boolean(),
      reason: Nullable(Type.String({ description: "Why Ruxstar partners can't take this one" })),
      pay: Paise,
      distanceKm: Nullable(Type.Integer()),
      online: Type.Integer({ minimum: 0, description: "Partners online in the shop's city now" }),
    }),
  }),
);

export const AssignBody = Type.Union([
  Strict({ carrier: Type.Literal("team"), placeId: ObjectIdString }),
  Strict({ carrier: Type.Literal("partner") }),
]);

// The rider's side, in the Ruxstar Delivery app.

const Place = Strict({
  name: Type.String(),
  phone: Nullable(Type.String({ description: "Shown once the job is yours" })),
  line: Nullable(Type.String({ description: "The full address once the job is yours; before that, null" })),
  area: Type.String({ description: "City, and the pincode for drops" }),
  point: Nullable(Point),
});

export const Job = Strict({
  id: ObjectIdString,
  orderNo: Type.Integer(),
  carrier: Carrier,
  status: DeliveryStatus,
  shop: Place,
  drop: Place,
  item: Type.String({ description: "What is being carried, for example Business cards × 200" }),
  distanceKm: Nullable(Type.Integer()),
  pay: Paise,
  offerUntil: Nullable(DateTime),
  proof: Type.Boolean({ description: "A photo at the door was added" }),
  cancel: Nullable(Strict({ by: Type.String(), reason: Type.String(), at: DateTime })),
  timeline: Type.Array(Strict({ status: DeliveryStatus, at: DateTime })),
  createdAt: DateTime,
});
export type Job = Static<typeof Job>;
export const JobOne = Envelope(Job);
export const JobList = ListEnvelope(Job);
export const JobParams = Strict({ id: ObjectIdString });
export const JobsQuery = Strict({
  ...PageQuery,
  view: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("past")], { description: "`active` (the default) is under way" })),
});

export const Rider = Envelope(
  Strict({
    name: Type.String(),
    avatarUrl: Nullable(Type.String()),
    vehicle: Nullable(Vehicle),
    online: Type.Boolean(),
    city: Nullable(Type.String()),
    partnerOffers: Type.Boolean({ description: "Ruxstar partner offers are on. Offers from shops you deliver for come either way" }),
    active: Nullable(Job, { description: "The job under way; one at a time" }),
    today: Strict({ trips: Type.Integer({ minimum: 0 }), earned: Paise }),
    teams: Type.Array(Strict({ placeId: ObjectIdString, business: Type.String() }), { description: 'Shops where you have "Deliver orders"' }),
  }),
);

export const OnlineBody = Strict({
  online: Type.Boolean(),
  point: Type.Optional(Point),
  city: Type.Optional(Type.String({ minLength: 2, maxLength: 60, description: "When the phone's location isn't shared" })),
});

export const DeliverBody = Strict({ code: Type.String({ pattern: "^[0-9]{4}$", description: "The customer's 4-digit code" }) });
export const RiderCancelBody = Strict({ reason: Type.String({ minLength: 5, maxLength: 300, description: "The shop sees it" }) });

export const Earnings = Envelope(
  Strict({
    balance: Paise,
    today: Paise,
    week: Paise,
    trips: Type.Integer({ minimum: 0 }),
    recent: Type.Array(Strict({ jobId: ObjectIdString, orderNo: Type.Integer(), pay: Paise, at: DateTime }), { description: "Newest first, up to 20" }),
    withdrawals: Type.Boolean({ description: "False until withdrawals open for delivery partners" }),
  }),
);
