import { Type, type Static, type TSchema } from "typebox";
import { DateTime, Envelope, ListEnvelope, ObjectIdString, PageQuery, Paise, Strict } from "../../contracts/common.js";
import { AppliedCoupon, Offer } from "../coupons/contracts.js";
import { InvoiceRefs } from "../invoices/contracts.js";
import { Rating, ReviewEligibility } from "../reviews/contracts.js";
import { Point } from "../vendor/contracts.js";
import { MAX_FEE } from "./rules.js";

const Nullable = <T extends TSchema>(schema: T, options?: { description: string }) => Type.Union([schema, Type.Null()], options);

export const TITLE_MAX = 80;
export const DESCRIPTION_MAX = 2000;

export const CourseCategory = Type.Union(
  [
    Type.Literal("tuition"),
    Type.Literal("exam_prep"),
    Type.Literal("music"),
    Type.Literal("dance"),
    Type.Literal("sports"),
    Type.Literal("fitness"),
    Type.Literal("art"),
    Type.Literal("languages"),
    Type.Literal("tech"),
    Type.Literal("other"),
  ],
  { description: "tuition: school subjects. exam_prep: entrance and competitive exams. tech: coding and computers" },
);
const Mode = Type.Union([Type.Literal("offline"), Type.Literal("online")], {
  description: "offline: at the institute's venue. online: live classes on a meeting link",
});
const Day = Type.String({ format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD, in India" });
const Photo = Nullable(Strict({ url: Type.String(), width: Type.Integer(), height: Type.Integer() }));
const Venue = Strict({ name: Type.String(), address: Type.String(), city: Type.String(), point: Nullable(Point) });
const Reason = Type.String({ minLength: 5, maxLength: 300, description: "Everyone affected is told" });

export const Slot = Strict({
  day: Type.Integer({ minimum: 0, maximum: 6, description: "0 Sunday, 1 Monday … 6 Saturday" }),
  start: Type.String({ pattern: "^([01]\\d|2[0-3]):(00|15|30|45)$", description: "HH:MM in India, in 15-minute steps" }),
  minutes: Type.Integer({ minimum: 15, maximum: 480, multipleOf: 15 }),
});
const Coach = Strict({ id: ObjectIdString, name: Type.String() });
const Student = Strict({ childId: Nullable(ObjectIdString, { description: "Null: the account holder" }), name: Type.String() });
const Refund = Nullable(Strict({ amount: Paise, status: Type.Union([Type.Literal("pending"), Type.Literal("done")]), reason: Nullable(Type.String()) }));
const OrderStatus = Type.Union([Type.Literal("awaiting_payment"), Type.Literal("confirmed"), Type.Literal("cancelled")]);
const Kind = Type.Union([Type.Literal("batch"), Type.Literal("demo")], { description: "batch: an enrolment. demo: one trial class" });

export const IdParams = Strict({ id: ObjectIdString });

// Ruxstar's rules.

export const CoachingRulesView = Strict({
  certificatePercent: Type.Integer({ description: "The default; each course can set its own" }),
  minimumHours: Type.Integer({ description: "A batch short of its minimum this many hours before the first class is cancelled and refunded" }),
  maxBatchSize: Type.Integer(),
  maxClasses: Type.Integer(),
  maxBatches: Type.Integer(),
  maxDemoFee: Paise,
  maxDemoSeats: Type.Integer(),
  joinMinutes: Type.Integer({ description: "Online class links show this many minutes before the start" }),
  commissionBps: Type.Integer(),
  platformFee: Paise,
});
export const CoachingRulesOne = Envelope(CoachingRulesView);

// Courses and batches, as customers see them.

const cardFields = {
  id: ObjectIdString,
  title: Type.String(),
  category: CourseCategory,
  mode: Mode,
  business: Strict({ id: ObjectIdString, name: Type.String() }),
  photo: Photo,
  city: Nullable(Type.String()),
  venueName: Nullable(Type.String()),
  feeFrom: Nullable(Paise, { description: "The lowest fee of a batch open for enrolment" }),
  openBatches: Type.Integer({ description: "Batches taking enrolments now" }),
  nextStart: Nullable(DateTime, { description: "The soonest first class of an open batch" }),
  demo: Nullable(Strict({ fee: Paise, free: Type.Boolean() }), { description: "Null when the course has no demo class" }),
};
export const CourseCard = Strict(cardFields);
export type CourseCard = Static<typeof CourseCard>;
export const CourseList = ListEnvelope(CourseCard);
export const CoursesQuery = Strict({
  ...PageQuery,
  city: Type.Optional(Type.String({ minLength: 2, maxLength: 60, description: "Courses taught there, and online ones unless `online` is false" })),
  category: Type.Optional(CourseCategory),
  online: Type.Optional(Type.Boolean({ description: "true: online courses only. false: in-person only" })),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "Words in the title or the institute's name" })),
});

const batchFields = {
  id: ObjectIdString,
  name: Type.String(),
  fee: Paise,
  capacity: Type.Integer(),
  seatsLeft: Type.Integer({ minimum: 0 }),
  slots: Type.Array(Slot),
  schedule: Type.String({ description: 'In words, for example "Mon, Wed 5–6 pm"' }),
  startDate: Day,
  firstAt: DateTime,
  lastEndsAt: DateTime,
  classes: Type.Integer({ description: "Classes not cancelled, extra ones included" }),
  minStudents: Nullable(Type.Integer()),
  enrolled: Type.Integer({ description: "Paid enrolments" }),
  coaches: Type.Array(Coach),
  status: Type.Union(
    [Type.Literal("open"), Type.Literal("full"), Type.Literal("started"), Type.Literal("ended"), Type.Literal("cancelled")],
    { description: "open: taking enrolments. Enrolment closes when the first class starts" },
  ),
  cancelReason: Nullable(Type.String()),
};
export const BatchView = Strict(batchFields);
export type BatchView = Static<typeof BatchView>;

const DemoClass = Strict({
  sessionId: ObjectIdString,
  batchId: ObjectIdString,
  batchName: Type.String(),
  startsAt: DateTime,
  endsAt: DateTime,
  seatsLeft: Type.Integer(),
});

export const CourseDetail = Strict({
  ...cardFields,
  description: Nullable(Type.String()),
  venue: Nullable(Venue),
  certificatePercent: Type.Integer({ description: "Attend at least this share of classes for the certificate" }),
  batches: Type.Array(BatchView, { description: "Open and running first, soonest first" }),
  demoClasses: Type.Array(DemoClass, { description: "The next classes with a demo place, up to 20" }),
  refundRule: Type.String({ description: "The refund rule in one sentence, for above the Pay button" }),
  platformFee: Paise,
  status: Type.Union([Type.Literal("draft"), Type.Literal("live"), Type.Literal("removed")]),
  canEnrol: Type.Boolean(),
  whyNot: Nullable(Type.String({ description: "Why nobody can enrol right now" })),
  myOrders: Type.Array(
    Strict({ id: ObjectIdString, orderNo: Type.Integer(), kind: Kind, status: OrderStatus, student: Student, batchId: ObjectIdString }),
    { description: "Your enrolments and demos in it, newest first. Empty when signed out" },
  ),
  demoTaken: Type.Array(Student, { description: "Students who have had, or booked, this course's demo. Empty when signed out" }),
  rating: Type.Optional(Rating),
});
export type CourseDetail = Static<typeof CourseDetail>;
export const CourseOne = Envelope(CourseDetail);

// Enrolling and demos.

const ReturnTo = Type.String({
  maxLength: 500,
  description: "Where the checkout page sends the customer afterwards: this site, or the app's own link. `order=<id>` is added.",
});
const StudentBody = Strict({ childId: Nullable(ObjectIdString, { description: "One of your children, or null for yourself" }) });
export const EnrolBody = Strict({
  student: StudentBody,
  coupon: Type.Optional(Type.String({ minLength: 3, maxLength: 20 })),
  returnTo: ReturnTo,
});
export const DemoBody = Strict({ sessionId: ObjectIdString, student: StudentBody, returnTo: ReturnTo });
export const PayBody = Strict({ returnTo: ReturnTo });
export const OffersQuery = Strict({ code: Type.Optional(Type.String({ minLength: 3, maxLength: 20, description: "Check this code too" })) });
export const OffersOne = Envelope(
  Strict({
    offers: Type.Array(Offer),
    checked: Nullable(Strict({ code: Type.String(), discount: Paise, problem: Nullable(Type.String()) }), { description: "With `code`" }),
  }),
);

export const ClassView = Strict({
  id: ObjectIdString,
  startsAt: DateTime,
  endsAt: DateTime,
  status: Type.Union([Type.Literal("upcoming"), Type.Literal("done"), Type.Literal("cancelled")]),
  extra: Type.Boolean({ description: "Added beyond the weekly schedule" }),
  movedFrom: Nullable(DateTime, { description: "When it was first meant to start" }),
  cancelReason: Nullable(Type.String()),
  attendance: Nullable(Type.Union([Type.Literal("present"), Type.Literal("absent")])),
  joinLink: Nullable(Type.String({ description: "Online classes: shown from `joinFrom` until the class ends" })),
  joinFrom: Nullable(DateTime),
});

const CertificateRef = Strict({ id: ObjectIdString, code: Type.String(), issuedAt: DateTime, pdfUrl: Type.String({ description: "Works for 10 minutes without signing in" }) });

export const CoachingOrder = Strict({
  id: ObjectIdString,
  orderNo: Type.Integer(),
  kind: Kind,
  status: OrderStatus,
  student: Student,
  course: Strict({
    id: ObjectIdString,
    title: Type.String(),
    category: CourseCategory,
    mode: Mode,
    photo: Photo,
    venueName: Nullable(Type.String()),
    address: Nullable(Type.String()),
    city: Nullable(Type.String()),
    removed: Type.Boolean({ description: "Taken down by Ruxstar" }),
  }),
  batch: Strict({
    id: ObjectIdString,
    name: Type.String(),
    schedule: Type.String(),
    firstAt: DateTime,
    lastEndsAt: DateTime,
    cancelled: Type.Boolean(),
    cancelReason: Nullable(Type.String()),
  }),
  business: Strict({ id: ObjectIdString, name: Type.String() }),
  price: Strict({ items: Paise, discount: Paise, platformFee: Paise, total: Paise }),
  coupon: Nullable(AppliedCoupon),
  refund: Refund,
  reason: Nullable(Type.String()),
  canCancel: Type.Boolean(),
  cancelUntil: Nullable(DateTime, { description: "Cancel before this, the first class, for a full refund" }),
  payBy: Nullable(DateTime, { description: "Unpaid, the seat goes back after this" }),
  classes: Type.Array(ClassView, { description: "Every class of the batch, or the demo class" }),
  attendance: Strict({
    attended: Type.Integer(),
    held: Type.Integer({ description: "Classes that have happened" }),
    percent: Type.Integer(),
    needed: Type.Integer({ description: "The share needed for the certificate" }),
  }),
  certificate: Nullable(CertificateRef),
  invoices: InvoiceRefs,
  ...ReviewEligibility,
  createdAt: DateTime,
});
export type CoachingOrder = Static<typeof CoachingOrder>;
export const CoachingOrderOne = Envelope(CoachingOrder);
export const CoachingOrderList = ListEnvelope(CoachingOrder);
export const PlacedOrder = Envelope(
  Strict({ order: CoachingOrder, checkoutUrl: Nullable(Type.String({ description: "Null when it was free and is confirmed already" })) }),
);
export const CheckoutLinkOne = Envelope(Strict({ checkoutUrl: Type.String() }));
export const MyOrdersQuery = Strict({
  ...PageQuery,
  view: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("past")], { default: "current", description: "current: not ended or cancelled" })),
});

export const TimetableQuery = Strict({
  from: Type.Optional(Day),
  days: Type.Optional(Type.Integer({ minimum: 1, maximum: 31, default: 7 })),
});
export const Timetable = ListEnvelope(
  Strict({
    orderId: ObjectIdString,
    kind: Kind,
    student: Student,
    course: Strict({ id: ObjectIdString, title: Type.String(), mode: Mode }),
    batchName: Type.String(),
    business: Type.String(),
    class: ClassView,
  }),
);

export const Material = Strict({
  id: ObjectIdString,
  title: Type.String(),
  kind: Type.Union([Type.Literal("file"), Type.Literal("link")]),
  url: Type.String({ description: "The link, or for a file a signed link that works for 10 minutes" }),
  fileName: Nullable(Type.String()),
  contentType: Nullable(Type.String()),
  bytes: Nullable(Type.Integer()),
  wholeCourse: Type.Boolean({ description: "For every batch of the course" }),
  addedAt: DateTime,
});
export const MaterialList = ListEnvelope(Material);
export const MaterialOne = Envelope(Material);

export const Message = Strict({ id: ObjectIdString, text: Type.String(), author: Type.String(), at: DateTime });
export const MessageList = ListEnvelope(Message);
export const MessageOne = Envelope(Message);

export const Child = Strict({
  id: ObjectIdString,
  name: Type.String(),
  birthYear: Nullable(Type.Integer()),
  enrolments: Type.Integer({ description: "Open enrolments and demos; a child with any can't be removed" }),
});
export const ChildList = ListEnvelope(Child);
export const ChildOne = Envelope(Child);
export const ChildBody = Strict({
  name: Type.String({ minLength: 2, maxLength: 60 }),
  birthYear: Nullable(Type.Integer({ minimum: 1990, maximum: 2030 })),
});
export const UpdateChildBody = Strict(
  { name: Type.Optional(ChildBody.properties.name), birthYear: Type.Optional(ChildBody.properties.birthYear) },
  { minProperties: 1 },
);

export const Certificate = Strict({
  ...CertificateRef.properties,
  orderId: ObjectIdString,
  studentName: Type.String(),
  courseTitle: Type.String(),
  batchName: Type.String(),
  businessName: Type.String(),
  attended: Type.Integer(),
  classes: Type.Integer(),
});
export const CertificateList = ListEnvelope(Certificate);

// The institute's side.

const SlotsBody = Type.Array(Slot, { minItems: 1, maxItems: 14 });
const DemoBodyFields = Strict(
  {
    fee: Type.Integer({ minimum: 0, description: "Paise; 0 is a free demo. Up to Ruxstar's most" }),
    seats: Type.Integer({ minimum: 1, maximum: 50, description: "Demo students in one class. Up to Ruxstar's most" }),
  },
  { description: "One demo class per student per course, in any upcoming class" },
);
const VenueBody = Strict({
  name: Type.String({ minLength: 2, maxLength: 80 }),
  address: Type.String({ minLength: 5, maxLength: 200 }),
  city: Type.String({ minLength: 2, maxLength: 60 }),
  point: Type.Optional(Nullable(Point)),
});
const courseFields = {
  title: Type.String({ minLength: 3, maxLength: TITLE_MAX }),
  description: Nullable(Type.String({ maxLength: DESCRIPTION_MAX })),
  category: CourseCategory,
  mode: Mode,
  venue: Nullable(VenueBody, { description: "Offline courses: where classes are. Null online" }),
  demo: Nullable(DemoBodyFields, { description: "Null: no demo class" }),
  certificatePercent: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Leave out for Ruxstar's default" })),
};
export const CreateCourseBody = Strict(courseFields);
export const UpdateCourseBody = Strict(
  {
    title: Type.Optional(courseFields.title),
    description: Type.Optional(courseFields.description),
    category: Type.Optional(courseFields.category),
    mode: Type.Optional(courseFields.mode),
    venue: Type.Optional(courseFields.venue),
    demo: Type.Optional(courseFields.demo),
    certificatePercent: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { minProperties: 1, description: "Send only what changes. The mode can't change once the course has a batch. Enrolled students are told when the venue changes." },
);

const batchBodyFields = {
  name: Type.String({ minLength: 2, maxLength: 60, description: "For example Weekend mornings" }),
  fee: Type.Integer({ minimum: 0, maximum: MAX_FEE, description: "Paise for the whole batch, paid up front" }),
  capacity: Type.Integer({ minimum: 1, maximum: 1000, description: "Up to Ruxstar's most" }),
  minStudents: Nullable(Type.Integer({ minimum: 2, maximum: 1000 }), {
    description: "If fewer have enrolled Ruxstar's minimum hours before the first class, the batch is cancelled and everyone refunded",
  }),
  slots: SlotsBody,
  startDate: Day,
  classes: Nullable(Type.Integer({ minimum: 1, maximum: 500 }), { description: "How many classes; or null with `endDate`" }),
  endDate: Nullable(Day, { description: "The last day classes can be on; or null with `classes`" }),
  onlineLink: Nullable(Type.String({ pattern: "^https://", maxLength: 500 }), { description: "Online courses only" }),
  coachIds: Type.Array(ObjectIdString, { maxItems: 10, uniqueItems: true, description: "Team members with “See their batches and students”" }),
};
export const CreateBatchBody = Strict(batchBodyFields);
export const UpdateBatchBody = Strict(
  {
    name: Type.Optional(batchBodyFields.name),
    fee: Type.Optional(batchBodyFields.fee),
    capacity: Type.Optional(batchBodyFields.capacity),
    minStudents: Type.Optional(batchBodyFields.minStudents),
    slots: Type.Optional(batchBodyFields.slots),
    startDate: Type.Optional(batchBodyFields.startDate),
    classes: Type.Optional(batchBodyFields.classes),
    endDate: Type.Optional(batchBodyFields.endDate),
    onlineLink: Type.Optional(batchBodyFields.onlineLink),
    coachIds: Type.Optional(batchBodyFields.coachIds),
  },
  {
    minProperties: 1,
    description:
      "Send only what changes. Once anyone has enrolled the schedule is fixed: move, cancel or add single classes instead. " +
      "The fee applies to new enrolments; capacity can't go below the seats taken.",
  },
);
export const CancelBody = Strict({ reason: Reason });

const VendorBatch = Strict({
  ...batchFields,
  held: Type.Integer({ description: "Seats waiting for a payment" }),
  onlineLink: Nullable(Type.String()),
  coachIds: Type.Array(ObjectIdString),
  minimumBy: Nullable(DateTime, { description: "When the minimum is checked" }),
  certificatesAt: Nullable(DateTime),
  sales: Paise,
});
export const VendorCourse = Strict({
  ...cardFields,
  description: Nullable(Type.String()),
  venue: Nullable(Venue),
  demoSeats: Nullable(Type.Integer()),
  certificatePercent: Type.Integer(),
  status: Type.Union([Type.Literal("draft"), Type.Literal("live"), Type.Literal("removed")]),
  publishedAt: Nullable(DateTime),
  removal: Nullable(Strict({ reason: Type.String(), at: DateTime })),
  batches: Type.Array(VendorBatch),
  counts: Strict({ students: Type.Integer({ description: "Paid enrolments" }), demos: Type.Integer({ description: "Demo classes booked" }) }),
  money: Strict({ sales: Paise, share: Paise, commissionBps: Type.Integer() }),
  missing: Type.Array(Type.String(), { description: "What publishing still needs, in words" }),
  createdAt: DateTime,
  updatedAt: DateTime,
});
export type VendorCourse = Static<typeof VendorCourse>;
export const VendorCourseOne = Envelope(VendorCourse);
export const VendorCourseList = ListEnvelope(VendorCourse);

export const StudentsQuery = Strict({
  ...PageQuery,
  batchId: Type.Optional(ObjectIdString),
  kind: Type.Optional(Kind),
  status: Type.Optional(Type.Union([Type.Literal("confirmed"), Type.Literal("cancelled")])),
});
export const BusinessCoursesParams = Strict({ id: ObjectIdString });
export const StudentRow = Strict({
  id: ObjectIdString,
  orderNo: Type.Integer(),
  kind: Kind,
  status: OrderStatus,
  student: Strict({ name: Type.String(), child: Type.Boolean() }),
  parent: Strict({ id: ObjectIdString, name: Type.String(), phone: Nullable(Type.String()) }),
  batch: Strict({ id: ObjectIdString, name: Type.String() }),
  demoAt: Nullable(DateTime, { description: "Demo classes: when" }),
  total: Paise,
  share: Paise,
  refunded: Paise,
  attendance: Strict({ attended: Type.Integer(), held: Type.Integer() }),
  createdAt: DateTime,
});
export type StudentRow = Static<typeof StudentRow>;
export const StudentList = ListEnvelope(StudentRow);

// Classes, for the owner and coaches.

const Can = Strict({
  attendance: Type.Boolean(),
  message: Type.Boolean(),
  materials: Type.Boolean(),
  reschedule: Type.Boolean(),
});
const DeskClass = Strict({
  id: ObjectIdString,
  startsAt: DateTime,
  endsAt: DateTime,
  status: Type.Union([Type.Literal("upcoming"), Type.Literal("done"), Type.Literal("cancelled")]),
  extra: Type.Boolean(),
  movedFrom: Nullable(DateTime),
  cancelReason: Nullable(Type.String()),
  demos: Type.Integer({ description: "Demo students booked" }),
  marked: Type.Boolean({ description: "Attendance saved" }),
  present: Type.Integer(),
});
export const DeskBatch = Strict({
  id: ObjectIdString,
  name: Type.String(),
  course: Strict({ id: ObjectIdString, title: Type.String(), mode: Mode }),
  business: Strict({ id: ObjectIdString, name: Type.String() }),
  schedule: Type.String(),
  slots: Type.Array(Slot),
  firstAt: DateTime,
  lastEndsAt: DateTime,
  status: BatchView.properties.status,
  onlineLink: Nullable(Type.String()),
  students: Type.Integer(),
  nextClass: Nullable(DeskClass),
  role: Type.Union([Type.Literal("owner"), Type.Literal("coach")]),
  can: Can,
});
export const DeskBatchList = ListEnvelope(DeskBatch);
export const DeskBatchDetail = Envelope(Strict({ ...DeskBatch.properties, classes: Type.Array(DeskClass) }));
export const TodayList = ListEnvelope(
  Strict({ ...DeskClass.properties, batch: Strict({ id: ObjectIdString, name: Type.String() }), course: Strict({ id: ObjectIdString, title: Type.String() }), students: Type.Integer() }),
);
export const Roster = Envelope(
  Strict({
    class: DeskClass,
    batch: Strict({ id: ObjectIdString, name: Type.String() }),
    canMark: Type.Boolean({ description: "Attendance opens 30 minutes before the class and closes when certificates are issued" }),
    students: Type.Array(
      Strict({ orderId: ObjectIdString, name: Type.String(), kind: Kind, child: Type.Boolean(), present: Nullable(Type.Boolean({ description: "Null: not marked" })) }),
    ),
  }),
);
export const DeskStudentList = ListEnvelope(
  Strict({
    orderId: ObjectIdString,
    name: Type.String(),
    child: Type.Boolean(),
    attended: Type.Integer(),
    held: Type.Integer({ description: "Classes that have happened" }),
    percent: Type.Integer(),
    certificateAt: Type.Integer({ description: "The percent the course needs for the certificate" }),
  }),
);
export const AttendanceBody = Strict({
  marks: Type.Array(Strict({ orderId: ObjectIdString, present: Type.Boolean() }), { minItems: 1, maxItems: 1100 }),
});
export const MoveBody = Strict({
  startsAt: DateTime,
  minutes: Type.Optional(Slot.properties.minutes),
  reason: Type.Optional(Type.String({ minLength: 3, maxLength: 300 })),
});
export const ExtraClassBody = Strict({ startsAt: DateTime, minutes: Slot.properties.minutes });
export const MessageBody = Strict({ text: Type.String({ minLength: 1, maxLength: 1000 }) });
export const LinkMaterialBody = Strict({
  title: Type.String({ minLength: 2, maxLength: 100 }),
  url: Type.String({ pattern: "^https?://", maxLength: 500 }),
  wholeCourse: Type.Optional(Type.Boolean({ description: "Owner only: for every batch of the course" })),
});
export const FileMaterialQuery = Strict({
  title: Type.String({ minLength: 2, maxLength: 100 }),
  wholeCourse: Type.Optional(Type.Boolean({ description: "Owner only: for every batch of the course" })),
});
export const ClassParams = Strict({ id: ObjectIdString });
