import { Type, type Static, type TSchema } from "typebox";
import { DateTime, Envelope, ListEnvelope, ModuleName, ObjectIdString, PageQuery, Strict } from "../../contracts/common.js";
import { Business, BusinessModule, PayoutMethod } from "../vendor/contracts.js";

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Count = Type.Integer({ minimum: 0 });
const Reason = Type.String({ minLength: 5, maxLength: 300, description: "Shown to the person, so be clear" });
/** ₹500. */
export const MAX_PLATFORM_FEE = 50_000;
/** ₹100. */
export const MAX_PAYOUT_FEE = 10_000;
/** ₹1,00,000. */
export const MAX_MIN_PAYOUT = 10_000_000;
/** ₹1,000, for any one delivery rate. */
export const MAX_DELIVERY_RATE = 100_000;

const DeliveryRate = Strict(
  {
    base: Type.Integer({ minimum: 0, maximum: MAX_DELIVERY_RATE, description: "Paise for the first `includedKm`" }),
    includedKm: Type.Integer({ minimum: 0, maximum: 50 }),
    perKm: Type.Integer({ minimum: 0, maximum: MAX_DELIVERY_RATE, description: "Paise for each km after" }),
  },
  { description: "What a Ruxstar delivery partner is paid for one trip, out of the shop's share" },
);

const EventRules = Strict(
  {
    refundHours: Type.Integer({ minimum: 0, maximum: 720, description: "Customers can cancel for a full refund until this many hours before the start" }),
    waitlistHours: Type.Integer({ minimum: 1, maximum: 48, description: "How long someone offered a seat from the waitlist has to pay" }),
    maxTicketTypes: Type.Integer({ minimum: 1, maximum: 10 }),
    maxQuestions: Type.Integer({ minimum: 0, maximum: 10, description: "Questions an organiser can ask each ticket holder" }),
  },
  { description: "The events module only" },
);

const CoachingRules = Strict(
  {
    certificatePercent: Type.Integer({ minimum: 1, maximum: 100, description: "The share of classes a student must attend for a certificate, unless a course sets its own" }),
    minimumHours: Type.Integer({ minimum: 1, maximum: 168, description: "A batch short of its minimum this many hours before the first class is cancelled and refunded" }),
    maxBatchSize: Type.Integer({ minimum: 1, maximum: 1000 }),
    maxClasses: Type.Integer({ minimum: 1, maximum: 500, description: "Classes in one batch, extra ones included" }),
    maxBatches: Type.Integer({ minimum: 1, maximum: 100, description: "Batches running or to come in one course" }),
    maxDemoFee: Type.Integer({ minimum: 0, maximum: 10_000_00, description: "Paise, the most a demo class can cost" }),
    maxDemoSeats: Type.Integer({ minimum: 1, maximum: 50, description: "Demo students in one class" }),
    joinMinutes: Type.Integer({ minimum: 0, maximum: 120, description: "An online class's link shows this many minutes before it starts" }),
  },
  { description: "The coaching module only" },
);

export const TurfRules = Strict(
  {
    refundFullHours: Type.Integer({ minimum: 0, maximum: 168, description: "New grounds' default: a full refund when the customer cancels this many hours or more before the slot" }),
    refundHalfHours: Type.Integer({ minimum: 0, maximum: 168, description: "New grounds' default: `halfPercent` back from this many hours until the full-refund hours. At most `refundFullHours`" }),
    halfPercent: Type.Integer({ minimum: 0, maximum: 100, description: "The share refunded in the middle tier" }),
    minFullHours: Type.Integer({ minimum: 0, maximum: 168, description: "Owners pick their full-refund hours between this and `maxFullHours`" }),
    maxFullHours: Type.Integer({ minimum: 0, maximum: 168 }),
    maxRepeatWeeks: Type.Integer({ minimum: 1, maximum: 52, description: "A weekly repeat books this many weeks at most, the first included" }),
    holdMinutes: Type.Integer({ minimum: 5, maximum: 60, description: "Unpaid slots are held this long for the checkout" }),
    slotLengths: Type.Array(Type.Union([Type.Literal(30), Type.Literal(60), Type.Literal(90)]), {
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
      description: "Slot lengths, in minutes, a court can use",
    }),
    maxSlots: Type.Integer({ minimum: 1, maximum: 48, description: "Back-to-back slots in one booking" }),
    bookAheadDays: Type.Integer({ minimum: 1, maximum: 180, description: "How far ahead the first slot can be" }),
    maxGrounds: Type.Integer({ minimum: 1, maximum: 100, description: "Grounds per business" }),
    maxCourts: Type.Integer({ minimum: 1, maximum: 100, description: "Courts per ground" }),
    maxAddOns: Type.Integer({ minimum: 0, maximum: 30, description: "Add-ons per court" }),
  },
  { description: "The turf module only" },
);

export const StaysRules = Strict(
  {
    refundDays: Type.Integer({ minimum: 0, maximum: 60, description: "A full refund when the customer cancels at least this many days before move-in. Properties can only be stricter" }),
    maxRefundDays: Type.Integer({ minimum: 0, maximum: 60, description: "The most days a property's stricter refund rule can ask for. At least `refundDays`" }),
    objectionHours: Type.Integer({ minimum: 1, maximum: 168, description: "After the owner marks \"Moved in\", the tenant can object for this long; the owner's money waits until then" }),
    maxMonths: Type.Integer({ minimum: 1, maximum: 12, description: "PG and co-living: months paid with a reservation, the first included" }),
    maxNights: Type.Integer({ minimum: 1, maximum: 90, description: "Hostels: nights in one reservation" }),
    holdMinutes: Type.Integer({ minimum: 5, maximum: 60, description: "Unpaid reservations hold their beds this long for the checkout" }),
    bookAheadDays: Type.Integer({ minimum: 1, maximum: 180, description: "How far ahead move-in can be" }),
    maxProperties: Type.Integer({ minimum: 1, maximum: 100, description: "Properties per business" }),
    maxRooms: Type.Integer({ minimum: 1, maximum: 500, description: "Rooms per property" }),
    maxBeds: Type.Integer({ minimum: 1, maximum: 24, description: "Beds per room" }),
  },
  { description: "The stays module only" },
);

export const ShopRules = Strict(
  {
    returnDays: Type.Integer({ minimum: 1, maximum: 30, description: "Shops that take returns take them for this many days after delivery. Orders made keep their days" }),
    maxOptions: Type.Integer({ minimum: 1, maximum: 2, description: "Option dimensions on one product, such as size and colour" }),
    releaseHours: Type.Integer({ minimum: 1, maximum: 720, description: "The shop's money is released this long after delivery, or when the return window ends if that is later" }),
    holdMinutes: Type.Integer({ minimum: 5, maximum: 60, description: "An unpaid order's checkout works this long. Stock is only taken when it's paid" }),
    acceptHours: Type.Integer({ minimum: 1, maximum: 72, description: "A paid order the shop hasn't accepted in this long is cancelled and fully refunded" }),
    maxProducts: Type.Integer({ minimum: 1, maximum: 5000, description: "Products per shop" }),
    maxVariants: Type.Integer({ minimum: 1, maximum: 100, description: "Variants (option combinations) on one product" }),
    maxValues: Type.Integer({ minimum: 1, maximum: 30, description: "Values of one option" }),
    maxLines: Type.Integer({ minimum: 1, maximum: 50, description: "Lines in one order" }),
    maxQuantity: Type.Integer({ minimum: 1, maximum: 100, description: "Of one variant in one order" }),
  },
  { description: "The shop module only" },
);

export const ModuleSettings = Strict({
  module: ModuleName,
  live: Type.Boolean(),
  signupsOpen: Type.Boolean(),
  commissionBps: Type.Integer({ minimum: 0, maximum: 10000, description: "Commission in basis points. 1000 = 10%" }),
  platformFee: Type.Integer({ minimum: 0, maximum: MAX_PLATFORM_FEE, description: "Paise the customer pays Ruxstar on each order" }),
  payouts: Nullable(
    Strict(
      {
        fee: Type.Integer({ minimum: 0, description: "Paise taken from each withdrawal" }),
        minimum: Type.Integer({ minimum: 0, description: "Paise, the least that can be withdrawn" }),
      },
      { description: "The ledger module: vendors' withdrawals. The delivery module: Ruxstar partners'. Null on the others." },
    ),
  ),
  deliveryEnabled: Type.Boolean(),
  gstinRequired: Nullable(Type.Boolean({ description: "Business modules: publishing needs a verified GSTIN. Null for other modules." })),
  delivery: Nullable(
    Strict(
      {
        riderRate: DeliveryRate,
        shopFeeMax: Strict({ base: Type.Integer({ minimum: 0 }), perKm: Type.Integer({ minimum: 0 }) }, { description: "The most a shop can charge, in paise" }),
        offerMinutes: Type.Integer({ minimum: 1, description: "A Ruxstar partner offer nobody accepts is cancelled after this" }),
      },
      { description: "The delivery module only" },
    ),
  ),
  eventRules: Nullable(EventRules),
  coachingRules: Nullable(CoachingRules),
  turfRules: Nullable(TurfRules),
  staysRules: Nullable(StaysRules),
  shopRules: Nullable(ShopRules),
  permissionCatalog: Type.Array(Type.String()),
  updatedAt: DateTime,
});
export type ModuleSettings = Static<typeof ModuleSettings>;

export const ModuleParams = Strict({ module: ModuleName });

export const ModuleSettingsPatch = Strict(
  {
    live: Type.Optional(Type.Boolean()),
    signupsOpen: Type.Optional(Type.Boolean()),
    commissionBps: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
    platformFee: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_PLATFORM_FEE, description: "Paise, up to ₹500" })),
    payoutFee: Type.Optional(
      Type.Integer({ minimum: 0, maximum: MAX_PAYOUT_FEE, description: "Ledger (vendors) or delivery (partners) only. Paise taken from each withdrawal, up to ₹100" }),
    ),
    minPayout: Type.Optional(
      Type.Integer({ minimum: 100, maximum: MAX_MIN_PAYOUT, description: "Ledger (vendors) or delivery (partners) only. Paise, at least ₹1 more than the payout fee" }),
    ),
    deliveryEnabled: Type.Optional(Type.Boolean()),
    gstinRequired: Type.Optional(Type.Boolean({ description: "Business modules only. Live businesses without a GSTIN stay live." })),
    riderRate: Type.Optional(DeliveryRate),
    shopFeeMax: Type.Optional(
      Strict({
        base: Type.Integer({ minimum: 0, maximum: MAX_DELIVERY_RATE }),
        perKm: Type.Integer({ minimum: 0, maximum: MAX_DELIVERY_RATE }),
      }),
    ),
    offerMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
    eventRules: Type.Optional(Type.Partial(EventRules, { additionalProperties: false, minProperties: 1, description: "Events only. Send only what changes." })),
    coachingRules: Type.Optional(
      Type.Partial(CoachingRules, { additionalProperties: false, minProperties: 1, description: "Coaching only. Send only what changes." }),
    ),
    turfRules: Type.Optional(
      Type.Partial(TurfRules, {
        additionalProperties: false,
        minProperties: 1,
        description: "Turf only. Send only what changes. A ground outside new refund limits is held to them from its next booking; bookings made keep their rule.",
      }),
    ),
    staysRules: Type.Optional(
      Type.Partial(StaysRules, {
        additionalProperties: false,
        minProperties: 1,
        description: "Stays only. Send only what changes. A property outside new refund limits is held to them from its next reservation; reservations made keep their rule.",
      }),
    ),
    shopRules: Type.Optional(
      Type.Partial(ShopRules, {
        additionalProperties: false,
        minProperties: 1,
        description: "Local shops only. Send only what changes. Orders made keep their return days.",
      }),
    ),
  },
  { minProperties: 1 },
);

export const ModuleSettingsList = ListEnvelope(ModuleSettings);
export const ModuleSettingsOne = Envelope(ModuleSettings);

// The console: who may do what.

export const PermissionKey = Type.Union([
  Type.Literal("kyc.view"),
  Type.Literal("kyc.review"),
  Type.Literal("reports.view"),
  Type.Literal("reports.act"),
  Type.Literal("users.view"),
  Type.Literal("users.manage"),
  Type.Literal("modules.view"),
  Type.Literal("modules.manage"),
  Type.Literal("businesses.view"),
  Type.Literal("businesses.manage"),
  Type.Literal("orders.view"),
  Type.Literal("orders.manage"),
  Type.Literal("payouts.view"),
  Type.Literal("payouts.manage"),
  Type.Literal("coupons.view"),
  Type.Literal("coupons.manage"),
  Type.Literal("support.view"),
  Type.Literal("support.manage"),
  Type.Literal("audit.view"),
]);

export const AccessResult = Envelope(
  Strict({
    admin: Type.Boolean({ description: "Admins have every permission and manage staff" }),
    title: Nullable(Type.String()),
    permissions: Type.Array(PermissionKey),
    catalog: Type.Array(Strict({ key: PermissionKey, label: Type.String() }), { description: "Every permission staff can be given" }),
  }),
);

export const OverviewResult = Envelope(
  Strict(
    {
      kyc: Nullable(Strict({ waiting: Count, delivery: Type.Integer({ minimum: 0, description: "Of those waiting, delivery partner cases" }) })),
      reports: Nullable(
        Strict({
          posts: Count,
          reports: Count,
          people: Type.Integer({ minimum: 0, description: "People with open reports" }),
          reviews: Type.Integer({ minimum: 0, description: "Shop reviews with open reports" }),
        }),
      ),
      users: Nullable(Strict({ total: Count, newThisWeek: Count, suspended: Count })),
      businesses: Nullable(Strict({ total: Count, live: Count, suspended: Count })),
      modules: Nullable(Type.Array(Strict({ module: ModuleName, live: Type.Boolean() }))),
      orders: Nullable(Strict({ problems: Type.Integer({ minimum: 0, description: "Order problems waiting for a decision" }) })),
      support: Nullable(
        Strict({
          open: Type.Integer({ minimum: 0, description: "Tickets waiting for a reply from Ruxstar" }),
          overdue: Type.Integer({ minimum: 0, description: "Of those, past their reply-by time" }),
          unassigned: Count,
        }),
      ),
      staff: Nullable(Strict({ active: Count })),
    },
    { description: "A section is null when you lack the permission to see it" },
  ),
);

// Console stats: every dashboard number in one response.

const statsModule = (description: string) =>
  Type.Union(
    [
      Type.Literal("pod"),
      Type.Literal("events"),
      Type.Literal("coaching"),
      Type.Literal("turf"),
      Type.Literal("stays"),
      Type.Literal("shop"),
      Type.Literal("delivery"),
    ],
    { description },
  );
export const StatsModule = statsModule("A business module, or `delivery` for Ruxstar partners' trips");
export type StatsModule = Static<typeof StatsModule>;

export const StatsQuery = Strict({
  module: Type.Optional(statsModule("Only this module's block. `people`, `money` and `queues` are then null.")),
});

const counted = (description: string) => Type.Integer({ minimum: 0, description });
const paise = (description: string) => Type.Integer({ minimum: 0, description: `Paise ${description}` });
const queue = (description: string) => Nullable(Type.Integer({ minimum: 0, description }));

const moneyFields = {
  collectedToday: paise("customers paid today (India time): the gateway side of each payment, so coupons Ruxstar pays for are not in it"),
  collectedThisWeek: paise("customers paid since Monday 00:00 India time"),
  collectedThisMonth: paise("customers paid since the 1st 00:00 India time"),
  refundsToday: paise("refunded to customers today (India time), counted when the refund was started"),
  refundsThisMonth: paise("refunded to customers since the 1st 00:00 India time"),
  held: paise("vendors' and delivery partners' shares not yet released: everything in their pending balances"),
};

const payoutTotal = (description: string) =>
  Strict({ count: counted("Withdrawals"), amount: paise("taken from payees' balances; the payout fee is included") }, { description });

const StatsModuleBlock = Strict({
  module: StatsModule,
  businesses: Nullable(
    Strict(
      {
        total: counted("Businesses in the module, drafts and taken down included"),
        live: counted("Published and not taken down"),
        drafts: counted("Not published yet"),
        takenDown: counted("Held by the Ruxstar team (suspended), published or not"),
      },
      { description: "Needs businesses.view. Null for delivery." },
    ),
  ),
  listings: Nullable(
    Strict(
      {
        kind: Type.Union([Type.Literal("event"), Type.Literal("course"), Type.Literal("ground"), Type.Literal("property"), Type.Literal("product")], {
          description: "What the module lists: events, courses, grounds, PG / hostel properties or shop products",
        }),
        live: counted("Published listings, past events included"),
        takenDown: counted("Taken down by the Ruxstar team (events: cancelled by staff)"),
      },
      { description: "Needs businesses.view. Null for print and delivery, which have no listings." },
    ),
  ),
  orders: Nullable(
    Strict(
      {
        today: counted("Placed today (India time) and paid, or free; delivery: trips created today"),
        thisWeek: counted("Placed since Monday 00:00 India time and paid, or free; delivery: trips created"),
        open: counted(
          "Still under way. Print and shop: paid and not yet delivered or cancelled. Events: confirmed ticket orders for events that " +
            "haven't ended. Coaching: confirmed batch enrolments in batches still running. Turf: confirmed bookings with a slot still to " +
            "come. Stays: reservations confirmed or moved in. Delivery: trips offered, accepted or picked up.",
        ),
      },
      { description: "Orders and bookings. Needs orders.view." },
    ),
  ),
  money: Nullable(Strict(moneyFields, { description: "This module's money. Needs payouts.view. Null for delivery." })),
});

export const StatsResult = Envelope(
  Strict(
    {
      asOf: Type.String({ format: "date-time", description: "When the oldest number here was counted. Numbers are kept for up to 60 seconds on each server." }),
      module: Nullable(statsModule("The `module` asked for; null for everything")),
      people: Nullable(
        Strict(
          {
            total: counted("Accounts not deleted"),
            joinedToday: counted("Accounts made today (India time) and not deleted"),
            joinedThisWeek: counted("Accounts made since Monday 00:00 India time and not deleted"),
            verified: counted("Accounts not deleted whose identity verification (KYC) is approved"),
            onHold: counted("Accounts on hold"),
          },
          { description: "Needs users.view" },
        ),
      ),
      modules: Type.Array(StatsModuleBlock, { description: "Print, events, coaching, turf, stays, shop and delivery, in that order; just one with `module`" }),
      money: Nullable(
        Strict(
          {
            ...moneyFields,
            payouts: Strict(
              {
                pending: payoutTotal("Vendors' and partners' withdrawals on the way"),
                failed: payoutTotal("Withdrawals that failed and went back to the payee's balance, ever"),
                paidThisMonth: payoutTotal("Withdrawals that reached the bank since the 1st 00:00 India time"),
              },
              { description: "Withdrawals by vendors and delivery partners" },
            ),
          },
          { description: "Every module together. Needs payouts.view." },
        ),
      ),
      queues: Nullable(
        Strict(
          {
            kyc: queue("Verification cases waiting for a decision, every track. Needs kyc.view."),
            helpTickets: queue("Help tickets waiting for a reply from Ruxstar. Needs support.view."),
            reports: queue("Open reports on posts, people and reviews, each report counted. Needs reports.view."),
            orderProblems: queue("Print order problems waiting for a decision. Needs orders.view."),
            staysObjections: queue("Tenants' objections after \"Moved in\" waiting for a decision. Needs orders.view."),
            shopReturns: queue("Shop returns requested or approved and not yet refunded or rejected. Needs orders.view."),
          },
          { description: "Work waiting for the Ruxstar team. Each count is null without its permission." },
        ),
      ),
    },
    { description: "A section or count is null when you lack the permission to see it" },
  ),
);
export type StatsData = Static<typeof StatsResult>["data"];

// Reported posts.

const ReportStatus = Type.Union([Type.Literal("open"), Type.Literal("closed")]);
export const ReportsQuery = Strict({ ...PageQuery, status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed")], { default: "open" })) });

const UserStatus = Type.Union([Type.Literal("active"), Type.Literal("locked"), Type.Literal("deleted")]);

const ModeratedPost = Strict({
  id: ObjectIdString,
  kind: Type.Union([Type.Literal("personal"), Type.Literal("business")]),
  text: Type.String(),
  media: Type.Array(Strict({ url: Type.String(), width: Type.Integer(), height: Type.Integer() })),
  status: Type.Union([Type.Literal("live"), Type.Literal("deleted"), Type.Literal("removed")]),
  createdAt: DateTime,
  author: Nullable(
    Strict({ id: ObjectIdString, name: Type.String(), username: Type.String(), avatarUrl: Nullable(Type.String()), status: UserStatus }),
  ),
  removal: Nullable(Strict({ reason: Type.String(), at: DateTime })),
});

export const ReportCase = Strict({
  postId: ObjectIdString,
  post: Nullable(ModeratedPost),
  status: ReportStatus,
  reports: Count,
  reasons: Strict({ spam: Count, fake: Count, abuse: Count, undelivered: Count, other: Count }),
  firstAt: DateTime,
  lastAt: DateTime,
  outcome: Nullable(Type.Union([Type.Literal("kept"), Type.Literal("removed")])),
  closedAt: Nullable(DateTime),
});
export type ReportCase = Static<typeof ReportCase>;
export const ReportList = ListEnvelope(ReportCase);
export const ReportOne = Envelope(ReportCase);
export const ReportParams = Strict({ postId: ObjectIdString });
export const RemoveBody = Strict({ reason: Reason });

// Reported people.

export const PersonCase = Strict({
  userId: ObjectIdString,
  user: Nullable(Strict({ id: ObjectIdString, name: Type.String(), username: Type.String(), avatarUrl: Nullable(Type.String()), status: UserStatus })),
  status: ReportStatus,
  reports: Count,
  reasons: Strict({ spam: Count, fake: Count, abuse: Count, scam: Count, other: Count }),
  notes: Type.Array(Type.String(), { description: "What reporters wrote, newest first, up to 5" }),
  firstAt: DateTime,
  lastAt: DateTime,
  outcome: Nullable(Type.Union([Type.Literal("dismissed"), Type.Literal("held")], { description: "`held` when their account was put on hold" })),
  closedAt: Nullable(DateTime),
});
export type PersonCase = Static<typeof PersonCase>;
export const PersonCaseList = ListEnvelope(PersonCase);
export const PersonCaseOne = Envelope(PersonCase);
export const PersonCaseParams = Strict({ userId: ObjectIdString });

// People.

export const UsersQuery = Strict({
  ...PageQuery,
  q: Type.Optional(Type.String({ maxLength: 80, description: "Phone digits, @username, a name, a card number like RUX-1A2B-3C4D, or an id" })),
  status: Type.Optional(UserStatus),
});

const Roles = Strict({ vendor: Type.Boolean(), delivery: Type.Boolean(), ruxstarStaff: Type.Boolean(), admin: Type.Boolean() });

const userRow = {
  id: ObjectIdString,
  name: Type.String(),
  username: Type.String(),
  phone: Type.String(),
  avatarUrl: Nullable(Type.String()),
  status: UserStatus,
  roles: Roles,
  kyc: Strict({ base: Type.String() }),
  createdAt: DateTime,
};
export const UserRow = Strict(userRow);
export type UserRow = Static<typeof UserRow>;

export const UserDetail = Strict({
  ...userRow,
  email: Nullable(Type.String()),
  emailVerified: Type.Boolean(),
  city: Nullable(Type.String()),
  bio: Nullable(Type.String()),
  card: Nullable(Type.String({ description: "Ruxstar Card number" })),
  signInLockedUntil: Nullable(DateTime),
  suspension: Nullable(Strict({ reason: Type.String(), at: DateTime, by: Nullable(Strict({ id: ObjectIdString, name: Type.String() })) })),
  stats: Strict({ posts: Count, engagements: Count }),
  sessions: Type.Integer({ minimum: 0, description: "Devices signed in now" }),
  openReports: Type.Integer({ minimum: 0, description: "Open reports on their posts" }),
  staff: Nullable(Strict({ title: Type.String(), permissions: Type.Array(PermissionKey), status: Type.Union([Type.Literal("active"), Type.Literal("revoked")]) })),
});
export type UserDetail = Static<typeof UserDetail>;
export const UserList = ListEnvelope(UserRow);
export const UserOne = Envelope(UserDetail);
export const UserParams = Strict({ id: ObjectIdString });
export const SuspendBody = Strict({ reason: Reason });

// Ruxstar staff.

export const StaffMember = Strict({
  user: Strict({ id: ObjectIdString, name: Type.String(), username: Type.String(), phone: Type.String(), avatarUrl: Nullable(Type.String()) }),
  title: Type.String(),
  permissions: Type.Array(PermissionKey),
  status: Type.Union([Type.Literal("active"), Type.Literal("revoked")]),
  grantedAt: DateTime,
  updatedAt: DateTime,
});
export type StaffMember = Static<typeof StaffMember>;
export const StaffList = ListEnvelope(StaffMember);
export const StaffOne = Envelope(StaffMember);
export const StaffParams = Strict({ userId: ObjectIdString });
export const StaffBody = Strict({
  title: Type.String({ minLength: 2, maxLength: 60, description: "For example Support lead" }),
  permissions: Type.Array(PermissionKey, { minItems: 1, uniqueItems: true }),
});

// Vendors' businesses.

export const BusinessesQuery = Strict({
  ...PageQuery,
  q: Type.Optional(Type.String({ maxLength: 80, description: "The start of a business name word, or an id" })),
  module: Type.Optional(BusinessModule),
  state: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("live"), Type.Literal("suspended")])),
});

const BusinessOwner = Strict({
  id: ObjectIdString,
  name: Type.String(),
  username: Type.String(),
  phone: Type.String(),
  avatarUrl: Nullable(Type.String()),
  status: UserStatus,
});

export const BusinessRow = Strict({ business: Business, owner: Nullable(BusinessOwner) });
export type BusinessRow = Static<typeof BusinessRow>;
export const BusinessCase = Strict({
  business: Business,
  owner: Nullable(BusinessOwner),
  payoutMethod: Nullable(PayoutMethod),
  suspendedBy: Nullable(Strict({ id: ObjectIdString, name: Type.String() })),
});
export type BusinessCase = Static<typeof BusinessCase>;
export const BusinessRows = ListEnvelope(BusinessRow);
export const BusinessCaseOne = Envelope(BusinessCase);

// Payouts and held money.

const Paise = Type.Integer({ minimum: 0 });
const Party = Strict({ id: ObjectIdString, name: Type.String() });

export const PayoutsQuery = Strict({
  ...PageQuery,
  status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("failed"), Type.Literal("paid")], { default: "pending" })),
});
export const PayoutParams = Strict({ id: ObjectIdString });

export const StaffPayout = Strict({
  id: ObjectIdString,
  payee: Type.Union([Type.Literal("vendor"), Type.Literal("partner")], { description: "`partner` is a Ruxstar delivery partner's withdrawal" }),
  vendor: Party,
  amount: Type.Integer({ minimum: 0, description: "Paise taken from the payee's balance" }),
  fee: Type.Integer({ minimum: 0, description: "Paise kept by Ruxstar; the bank gets amount - fee" }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("paid"), Type.Literal("failed")]),
  to: Type.String(),
  transferId: Type.String({ description: "Cashfree's transfer_id" }),
  utr: Nullable(Type.String()),
  failure: Nullable(Strict({ code: Type.String(), text: Type.String({ description: "What the payee was told" }) })),
  attempts: Type.Integer({ minimum: 0, description: "Times it was sent to Cashfree" }),
  checkedAt: Nullable(DateTime),
  paidAt: Nullable(DateTime),
  createdAt: DateTime,
});
export type StaffPayout = Static<typeof StaffPayout>;
export const StaffPayoutList = ListEnvelope(StaffPayout);
export const StaffPayoutOne = Envelope(StaffPayout);

export const HeldQuery = Strict({ ...PageQuery, orderNo: Type.Optional(Type.Integer({ minimum: 1, description: "Find one order by its number" })) });
export const HeldParams = Strict({ id: ObjectIdString });

export const HeldOrder = Strict({
  id: ObjectIdString,
  orderNo: Type.Integer(),
  module: ModuleName,
  business: Nullable(Party),
  vendor: Party,
  amount: Type.Integer({ minimum: 0, description: "Paise: the shop's share left after partial refunds" }),
  deliveredAt: Nullable(DateTime),
  releaseAt: DateTime,
  problemOpen: Type.Boolean({ description: "A customer's reported problem waits for a decision; it can't be released until then" }),
  partner: Nullable(
    Strict(
      {
        rider: Party,
        amount: Type.Integer({ minimum: 0, description: "Paise, the partner's pay; already out of the shop's share" }),
        releaseAt: DateTime,
        held: Type.Boolean({ description: "The customer said it never arrived; the pay waits until that is settled" }),
      },
      { description: "Set when a Ruxstar partner delivered it and their pay is still on hold" },
    ),
  ),
});
export type HeldOrder = Static<typeof HeldOrder>;
export const HeldList = ListEnvelope(HeldOrder);
export const ReleaseBody = Strict({ reason: Type.String({ minLength: 5, maxLength: 300, description: "Why it is released early; kept in the audit log" }) });
export const ReleaseResult = Envelope(Strict({ id: ObjectIdString, orderNo: Type.Integer(), amount: Paise, releasedAt: DateTime }));

// Audit log.

export const AuditQuery = Strict({
  ...PageQuery,
  module: Type.Optional(Type.String({ pattern: "^[a-z_]{2,40}$" })),
  action: Type.Optional(Type.String({ pattern: "^[a-z_.]{2,60}$", description: "For example kyc.approve" })),
  actor: Type.Optional(ObjectIdString),
  target: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "The id of what was changed" })),
  from: Type.Optional(DateTime),
  to: Type.Optional(DateTime),
});

export const AuditEntry = Strict({
  id: ObjectIdString,
  at: DateTime,
  actor: Strict({
    id: Nullable(ObjectIdString),
    kind: Type.Union([Type.Literal("user"), Type.Literal("staff"), Type.Literal("admin"), Type.Literal("system")]),
    name: Nullable(Type.String()),
    username: Nullable(Type.String()),
  }),
  module: Type.String(),
  action: Type.String(),
  target: Strict({ type: Type.String(), id: Type.String() }),
  diff: Type.Record(Type.String(), Type.Object({ from: Type.Optional(Type.Unknown()), to: Type.Optional(Type.Unknown()) })),
  ip: Nullable(Type.String()),
});
export type AuditEntry = Static<typeof AuditEntry>;
export const AuditList = ListEnvelope(AuditEntry);
