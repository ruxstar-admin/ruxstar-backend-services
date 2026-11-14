import { Type, type Static, type TSchema } from "typebox";
import { DateTime, Envelope, ListEnvelope, ObjectIdString, PageQuery, Strict } from "../../contracts/common.js";

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const SUBJECT_MIN = 3;
export const SUBJECT_MAX = 80;
export const SUPPORT_TEXT_MAX = 2000;
export const SUPPORT_PHOTOS_MAX = 3;
/** Photos can be added to your own message for this long after sending it. */
export const PHOTO_WINDOW_MINUTES = 30;
/** Open or waiting tickets one person can have at once. */
export const OPEN_TICKETS_MAX = 5;
/** A resolved ticket can be reopened by replying for this long. */
export const REOPEN_DAYS = 7;

export const SupportCategory = Type.Union(
  [
    Type.Literal("orders"),
    Type.Literal("refunds"),
    Type.Literal("verification"),
    Type.Literal("business"),
    Type.Literal("delivery"),
    Type.Literal("account"),
    Type.Literal("safety"),
    Type.Literal("app"),
    Type.Literal("other"),
  ],
  {
    description:
      "Orders & payments, Refunds, Verification, My business, Delivery, Account & sign-in, Safety & reports, App problem, Other",
  },
);
export const SupportPriority = Type.Union([Type.Literal("urgent"), Type.Literal("high"), Type.Literal("normal"), Type.Literal("low")]);
const StoredStatus = Type.Union([Type.Literal("open"), Type.Literal("waiting"), Type.Literal("resolved")]);
export const SupportStatus = Type.Union([Type.Literal("open"), Type.Literal("waiting"), Type.Literal("resolved"), Type.Literal("closed")], {
  description: "`waiting` is waiting on you. A resolved ticket can be reopened by replying for 7 days, then it is `closed`.",
});
const ContextType = Type.Union([Type.Literal("order"), Type.Literal("business"), Type.Literal("verification"), Type.Literal("post"), Type.Literal("coupon")]);
const Text = Type.String({ minLength: 1, maxLength: SUPPORT_TEXT_MAX });

export const TicketParams = Strict({ id: ObjectIdString });
export const MessageParams = Strict({ id: ObjectIdString, messageId: ObjectIdString });

export const TicketCreate = Strict({
  category: SupportCategory,
  subject: Type.String({ minLength: SUBJECT_MIN, maxLength: SUBJECT_MAX }),
  text: Text,
  context: Type.Optional(
    Strict(
      { type: ContextType, id: Type.String({ minLength: 1, maxLength: 40 }) },
      { description: "What it is about: an order, business, coupon or post by id, or verification by track (base or delivery). It must be yours, except a post." },
    ),
  ),
});
export const MessageCreate = Strict({ text: Text });

const Context = Strict({ type: ContextType, id: Type.String(), label: Type.String({ description: "For example Order #1042" }) });
const Photo = Strict({ id: ObjectIdString, url: Type.String({ description: "Works for 10 minutes" }) });

const messageFields = {
  id: ObjectIdString,
  from: Type.Union([Type.Literal("customer"), Type.Literal("staff")]),
  text: Type.String(),
  photos: Type.Array(Photo),
  at: DateTime,
};
export const SupportMessage = Strict({ ...messageFields, mine: Type.Boolean() });
export type SupportMessage = Static<typeof SupportMessage>;

const ticketFields = {
  id: ObjectIdString,
  number: Type.String({ description: "For example RX-1042" }),
  category: SupportCategory,
  subject: Type.String(),
  status: SupportStatus,
  context: Nullable(Context),
  createdAt: DateTime,
  lastAt: DateTime,
  resolvedAt: Nullable(DateTime),
  reopenUntil: Nullable(DateTime),
};
export const Ticket = Strict({ ...ticketFields, unread: Type.Boolean({ description: "Ruxstar replied since you last opened it" }) });
export type Ticket = Static<typeof Ticket>;
export const TicketDetail = Strict({ ...ticketFields, unread: Type.Boolean(), messages: Type.Array(SupportMessage) });
export type TicketDetail = Static<typeof TicketDetail>;

export const TicketList = ListEnvelope(Ticket);
export const TicketOne = Envelope(TicketDetail);
export const TicketsQuery = Strict(PageQuery);

// The console.

const Person = Strict({ id: ObjectIdString, name: Type.String() });

export const StaffMessage = Strict({ ...messageFields, internal: Type.Boolean({ description: "A staff note the customer never sees" }), author: Person });
export type StaffMessage = Static<typeof StaffMessage>;

const staffFields = {
  ...ticketFields,
  context: Nullable(
    Strict({
      type: ContextType,
      id: Type.String(),
      label: Type.String(),
      state: Nullable(Type.String({ description: "Where it stands now, for example a verification case's status or a business's" })),
      kycCaseId: Nullable(ObjectIdString),
    }),
  ),
  priority: SupportPriority,
  assignee: Nullable(Person),
  requester: Strict({
    id: ObjectIdString,
    name: Type.String(),
    username: Type.String(),
    status: Type.Union([Type.Literal("active"), Type.Literal("locked"), Type.Literal("deleted")], { description: "The account's status" }),
  }),
  slaDueAt: Nullable(DateTime),
  overdue: Type.Boolean({ description: "Waiting for Ruxstar past its reply-by time" }),
  lastFrom: Type.Union([Type.Literal("customer"), Type.Literal("staff")]),
};
export const StaffTicket = Strict(staffFields);
export type StaffTicket = Static<typeof StaffTicket>;
export const StaffTicketDetail = Strict({ ...staffFields, messages: Type.Array(StaffMessage) });
export type StaffTicketDetail = Static<typeof StaffTicketDetail>;

export const StaffTicketList = ListEnvelope(StaffTicket);
export const StaffTicketOne = Envelope(StaffTicketDetail);

export const QueueQuery = Strict({
  ...PageQuery,
  status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("waiting"), Type.Literal("resolved")], { default: "open", description: "`resolved` includes closed tickets" })),
  category: Type.Optional(SupportCategory),
  assignee: Type.Optional(Type.Union([Type.Literal("me"), Type.Literal("none")])),
  q: Type.Optional(Type.String({ maxLength: 20, description: "A ticket number, with or without RX-" })),
});

export const StaffReply = Strict({
  text: Text,
  internal: Type.Optional(Type.Boolean({ default: false })),
  status: Type.Optional(
    Type.Union([Type.Literal("open"), Type.Literal("waiting"), Type.Literal("resolved")], {
      description: "Where the ticket goes after a reply. Defaults to `waiting` (on the customer); notes leave it as it is.",
    }),
  ),
});

export const TicketPatch = Strict(
  {
    status: Type.Optional(StoredStatus),
    priority: Type.Optional(SupportPriority),
    category: Type.Optional(SupportCategory),
    assigneeId: Type.Optional(Nullable(ObjectIdString)),
  },
  { minProperties: 1 },
);

export const Agents = Envelope(Type.Array(Strict({ id: ObjectIdString, name: Type.String(), title: Type.String() })));

export const SummaryResult = Envelope(
  Strict({
    open: Type.Integer({ minimum: 0 }),
    waiting: Type.Integer({ minimum: 0, description: "Waiting on the customer" }),
    overdue: Type.Integer({ minimum: 0 }),
    unassigned: Type.Integer({ minimum: 0, description: "Open with nobody on it" }),
    mine: Type.Integer({ minimum: 0, description: "Open and assigned to you" }),
  }),
);

const Hours = Type.Integer({ minimum: 1, maximum: 336 });
export const SlaHours = Strict(
  { urgent: Hours, high: Hours, normal: Hours, low: Hours },
  { description: "Hours Ruxstar has to answer, by priority" },
);
export type SlaHours = Static<typeof SlaHours>;
export const SupportSettings = Strict({ hours: SlaHours, updatedAt: Nullable(DateTime) });
export const SupportSettingsOne = Envelope(SupportSettings);
export const SupportSettingsPut = Strict({ hours: SlaHours });

export const HOLD_MESSAGE = "Ruxstar put this account on hold. Message support to find out more or ask for a review.";
