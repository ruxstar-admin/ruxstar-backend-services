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
