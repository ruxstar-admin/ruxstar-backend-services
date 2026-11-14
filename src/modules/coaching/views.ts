import type { FastifyInstance } from "fastify";
import type { ObjectId, WithId } from "mongodb";
import type {
  BusinessPhoto,
  CoachingBatchDoc,
  CoachingCourseDoc,
  CoachingMaterialDoc,
  CoachingOrderDoc,
  CoachingSessionDoc,
  Database,
} from "../../platform/db.js";
import { appliedView } from "../coupons/coupons.js";
import { invoiceRefs } from "../invoices/views.js";
import { coachingFileLinks } from "./checkout.js";
import type { BatchView, CoachingOrder, CourseCard, VendorCourse } from "./contracts.js";
import { coachingSettings, HOUR_MS, scheduleText } from "./rules.js";

type Request = { protocol: string; host: string };
type Count = { _id: ObjectId; n: number };
const n = (rows: Count[], id: ObjectId) => rows.find((r) => r._id.equals(id))?.n ?? 0;
const iso = (at: Date | null | undefined) => at?.toISOString() ?? null;

export const REFUND_RULE =
  "Full refund, platform fee included, if you cancel before the first class. No refunds once it starts. " +
  "If the institute cancels the batch, or it doesn't get enough students, you get everything back.";

export const photoView = (photo: BusinessPhoto | null | undefined) => (photo ? { url: photo.url, width: photo.width, height: photo.height } : null);

export function batchStatus(batch: CoachingBatchDoc, now = new Date()): BatchView["status"] {
  if (batch.status === "cancelled") return "cancelled";
  if (batch.lastEndsAt <= now) return "ended";
  if (batch.firstAt <= now) return "started";
  return batch.seatsLeft <= 0 ? "full" : "open";
}

export const isOpen = (batch: CoachingBatchDoc, now = new Date()) => batch.status === "live" && batch.firstAt > now;

/** Course cards, with the batches open for enrolment in one read. */
export async function courseCards(db: Database, courses: WithId<CoachingCourseDoc>[]): Promise<CourseCard[]> {
  if (!courses.length) return [];
  const now = new Date();
  const open = await db.coachingBatches
    .find({ courseId: { $in: courses.map((c) => c._id) }, status: "live", firstAt: { $gt: now } }, { projection: { courseId: 1, fee: 1, firstAt: 1 } })
    .toArray();
  return courses.map((c) => courseCard(c, open.filter((b) => b.courseId.equals(c._id))));
}

export function courseCard(course: WithId<CoachingCourseDoc>, open: Pick<CoachingBatchDoc, "fee" | "firstAt">[]): CourseCard {
  return {
    id: course._id.toHexString(),
    title: course.title,
    category: course.category,
    mode: course.mode,
    business: { id: course.businessId.toHexString(), name: course.businessName },
    photo: photoView(course.photo),
    city: course.venue?.city ?? null,
    venueName: course.venue?.name ?? null,
    feeFrom: open.length ? Math.min(...open.map((b) => b.fee)) : null,
    openBatches: open.length,
    nextStart: open.length ? new Date(Math.min(...open.map((b) => b.firstAt.getTime()))).toISOString() : null,
    demo: course.demo ? { fee: course.demo.fee, free: course.demo.fee === 0 } : null,
  };
}

/** Batches with their classes, enrolments and coaches, in three reads however many there are. */
export async function batchViews(db: Database, batches: WithId<CoachingBatchDoc>[]): Promise<BatchView[]> {
  if (!batches.length) return [];
  const ids = batches.map((b) => b._id);
  const [classes, enrolled, coaches] = await Promise.all([
    db.coachingSessions.aggregate<Count>([{ $match: { batchId: { $in: ids }, status: "scheduled" } }, { $group: { _id: "$batchId", n: { $sum: 1 } } }]).toArray(),
    db.coachingOrders
      .aggregate<Count>([{ $match: { batchId: { $in: ids }, kind: "batch", status: "confirmed" } }, { $group: { _id: "$batchId", n: { $sum: 1 } } }])
      .toArray(),
    db.users.find({ _id: { $in: batches.flatMap((b) => b.coachIds) } }, { projection: { name: 1, username: 1 } }).toArray(),
  ]);
  const now = new Date();
  return batches.map((b) => ({
    id: b._id.toHexString(),
    name: b.name,
    fee: b.fee,
    capacity: b.capacity,
    seatsLeft: Math.max(0, b.seatsLeft),
    slots: b.slots,
    schedule: scheduleText(b.slots),
    startDate: b.startDate,
    firstAt: b.firstAt.toISOString(),
    lastEndsAt: b.lastEndsAt.toISOString(),
    classes: n(classes, b._id),
    minStudents: b.minStudents,
    enrolled: n(enrolled, b._id),
    coaches: b.coachIds.flatMap((id) => {
      const user = coaches.find((u) => u._id.equals(id));
      return user ? [{ id: id.toHexString(), name: user.name ?? user.username ?? "Coach" }] : [];
    }),
    status: batchStatus(b, now),
    cancelReason: b.cancellation?.reason ?? null,
  }));
}

/** Upcoming batches first, soonest first, then running ones, then the rest newest first. */
export function sortBatches<T extends CoachingBatchDoc>(batches: T[], now = new Date()): T[] {
  const rank = (b: T) => (isOpen(b, now) ? 0 : b.status === "live" && b.lastEndsAt > now ? 1 : 2);
  return [...batches].sort((a, b) => rank(a) - rank(b) || (rank(a) < 2 ? a.firstAt.getTime() - b.firstAt.getTime() : b.firstAt.getTime() - a.firstAt.getTime()));
}

type ClassView = CoachingOrder["classes"][number];

export function classView(
  s: CoachingSessionDoc,
  ctx: { mark: boolean | null; onlineLink: string | null; joinMinutes: number; confirmed: boolean; now: Date },
): ClassView {
  const status = s.status === "cancelled" ? "cancelled" : s.endsAt <= ctx.now ? "done" : "upcoming";
  const joinFrom = ctx.onlineLink && status === "upcoming" ? new Date(s.startsAt.getTime() - ctx.joinMinutes * 60_000) : null;
  return {
    id: s._id.toHexString(),
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    status,
    extra: s.extra,
    movedFrom: iso(s.movedFrom?.startsAt),
    cancelReason: s.cancellation?.reason ?? null,
    attendance: ctx.mark === null ? null : ctx.mark ? "present" : "absent",
    joinLink: joinFrom && ctx.confirmed && joinFrom <= ctx.now ? ctx.onlineLink : null,
    joinFrom: joinFrom && ctx.confirmed ? joinFrom.toISOString() : null,
  };
}

/** Orders with their courses, classes, attendance and certificates, ready to show the customer. */
export async function orderViews(app: FastifyInstance, db: Database, request: Request, orders: CoachingOrderDoc[]): Promise<CoachingOrder[]> {
  if (!orders.length) return [];
  const batchIds = [...new Set(orders.map((o) => o.batchId.toHexString()))].map((id) => orders.find((o) => o.batchId.toHexString() === id)!.batchId);
  const [courses, batches, sessions, marks, certificates, settings] = await Promise.all([
    db.coachingCourses.find({ _id: { $in: orders.map((o) => o.courseId) } }).toArray(),
    db.coachingBatches.find({ _id: { $in: batchIds } }).toArray(),
    db.coachingSessions.find({ batchId: { $in: batchIds } }).sort({ startsAt: 1 }).toArray(),
    db.coachingAttendance.find({ orderId: { $in: orders.map((o) => o._id) } }, { projection: { orderId: 1, sessionId: 1, present: 1 } }).toArray(),
    db.coachingCertificates.find({ orderId: { $in: orders.map((o) => o._id) } }).toArray(),
    coachingSettings(db),
  ]);
  const link = coachingFileLinks(app, request);
  const now = new Date();
  return orders.map((o): CoachingOrder => {
    const course = courses.find((c) => c._id.equals(o.courseId));
    const batch = batches.find((b) => b._id.equals(o.batchId));
    const mine = sessions.filter((s) => (o.kind === "demo" ? o.sessionId?.equals(s._id) : s.batchId.equals(o.batchId)));
    const markOf = (s: CoachingSessionDoc) => marks.find((m) => m.orderId.equals(o._id) && m.sessionId.equals(s._id))?.present ?? null;
    const held = mine.filter((s) => s.status === "scheduled" && s.endsAt <= now);
    const attended = held.filter((s) => markOf(s) === true).length;
    const certificate = certificates.find((c) => c.orderId.equals(o._id));
    const confirmed = o.status === "confirmed";
    const beforeFirst = o.firstAt > now;
    return {
      id: o._id.toHexString(),
      orderNo: o.orderNo,
      kind: o.kind,
      status: o.status,
      student: { childId: o.student.childId?.toHexString() ?? null, name: o.student.name },
      course: {
        id: o.courseId.toHexString(),
        title: course?.title ?? o.courseTitle,
        category: course?.category ?? "other",
        mode: course?.mode ?? "offline",
        photo: photoView(course?.photo),
        venueName: course?.venue?.name ?? null,
        address: course?.venue?.address ?? null,
        city: course?.venue?.city ?? null,
        removed: course?.status === "removed",
      },
      batch: {
        id: o.batchId.toHexString(),
        name: batch?.name ?? o.batchName,
        schedule: batch ? scheduleText(batch.slots) : "",
        firstAt: (batch?.firstAt ?? o.firstAt).toISOString(),
        lastEndsAt: (batch?.lastEndsAt ?? o.firstEndsAt).toISOString(),
        cancelled: batch?.status === "cancelled",
        cancelReason: batch?.cancellation?.reason ?? null,
      },
      business: { id: o.businessId.toHexString(), name: o.businessName },
      price: { items: o.price.items, discount: o.price.discount ?? 0, platformFee: o.price.platformFee, total: o.price.total },
      coupon: appliedView(o.price.coupon),
      refund: o.refund ? { amount: o.refund.amount, status: o.refund.status, reason: o.refund.reason } : null,
      reason: o.reason,
      canCancel: o.status === "awaiting_payment" || (confirmed && !o.releasedAt && beforeFirst),
      cancelUntil: o.status !== "cancelled" && beforeFirst ? o.firstAt.toISOString() : null,
      payBy: o.status === "awaiting_payment" ? iso(o.holdUntil) : null,
      classes: mine.map((s) =>
        classView(s, { mark: markOf(s), onlineLink: course?.mode === "online" ? (batch?.onlineLink ?? null) : null, joinMinutes: settings.joinMinutes, confirmed, now }),
      ),
      attendance: {
        attended,
        held: held.length,
        percent: held.length ? Math.round((attended * 100) / held.length) : 0,
        needed: course?.certificatePercent ?? settings.certificatePercent,
      },
      certificate: certificate
        ? { id: certificate._id.toHexString(), code: certificate.code, issuedAt: certificate.issuedAt.toISOString(), pdfUrl: link("certificate", certificate._id.toHexString()) }
        : null,
      invoices: invoiceRefs(o.invoices),
      createdAt: o.createdAt.toISOString(),
    };
  });
}

export function materialView(app: FastifyInstance, request: Request) {
  const link = coachingFileLinks(app, request);
  return (m: WithId<CoachingMaterialDoc>) => ({
    id: m._id.toHexString(),
    title: m.title,
    kind: m.kind,
    url: m.kind === "file" ? link("material", m._id.toHexString()) : (m.url ?? ""),
    fileName: m.file?.name ?? null,
    contentType: m.file?.contentType ?? null,
    bytes: m.file?.bytes ?? null,
    wholeCourse: m.batchId === null,
    addedAt: m.createdAt.toISOString(),
  });
}

/** What publishing a course still needs, in words. */
export function missingOf(course: CoachingCourseDoc, batches: CoachingBatchDoc[], businessLive: boolean, now = new Date()): string[] {
  const missing: string[] = [];
  if (!businessLive) missing.push("Publish your business first");
  if (course.mode === "offline" && !course.venue) missing.push("Add where the classes are");
  if (!batches.some((b) => isOpen(b, now))) missing.push("Add a batch whose first class is in the future");
  return missing;
}

/** Each course with its batches, students and money, in a few reads however many there are. */
export async function vendorCourseViews(db: Database, courses: WithId<CoachingCourseDoc>[], businessLive: (id: ObjectId) => boolean): Promise<VendorCourse[]> {
  if (!courses.length) return [];
  const ids = courses.map((c) => c._id);
  const [batches, settings, money] = await Promise.all([
    db.coachingBatches.find({ courseId: { $in: ids } }).toArray(),
    coachingSettings(db),
    db.coachingOrders
      .aggregate<{ _id: { batchId: ObjectId; kind: CoachingOrderDoc["kind"] }; orders: number; items: number; share: number }>([
        { $match: { courseId: { $in: ids }, status: "confirmed" } },
        {
          $group: {
            _id: { batchId: "$batchId", kind: "$kind" },
            orders: { $sum: 1 },
            items: { $sum: "$price.items" },
            share: {
              $sum: {
                $subtract: [
                  { $subtract: ["$price.items", "$price.commission"] },
                  { $cond: [{ $eq: ["$price.coupon.fundedBy", "vendor"] }, { $ifNull: ["$price.discount", 0] }, 0] },
                ],
              },
            },
          },
        },
      ])
      .toArray(),
  ]);
  const views = await batchViews(db, batches);
  const now = new Date();
  return courses.map((c) => {
    const mine = sortBatches(
      batches.filter((b) => b.courseId.equals(c._id)),
      now,
    );
    const rows = money.filter((m) => mine.some((b) => b._id.equals(m._id.batchId)));
    const sum = (pick: (r: (typeof rows)[number]) => number, kind?: CoachingOrderDoc["kind"]) =>
      rows.filter((r) => !kind || r._id.kind === kind).reduce((s, r) => s + pick(r), 0);
    return {
      ...courseCard(
        c,
        mine.filter((b) => isOpen(b, now)),
      ),
      description: c.description,
      venue: c.venue,
      demoSeats: c.demo?.seats ?? null,
      certificatePercent: c.certificatePercent,
      status: c.status,
      publishedAt: iso(c.publishedAt),
      removal: c.removal ? { reason: c.removal.reason, at: c.removal.at.toISOString() } : null,
      batches: mine.map((b) => {
        const view = views.find((v) => v.id === b._id.toHexString())!;
        const batchRows = rows.filter((r) => r._id.batchId.equals(b._id) && r._id.kind === "batch");
        return {
          ...view,
          held: Math.max(0, b.capacity - b.seatsLeft - view.enrolled),
          onlineLink: b.onlineLink,
          coachIds: b.coachIds.map((id) => id.toHexString()),
          minimumBy: b.minStudents ? new Date(b.firstAt.getTime() - settings.minimumHours * HOUR_MS).toISOString() : null,
          certificatesAt: iso(b.certificatesAt),
          sales: batchRows.reduce((s, r) => s + r.items, 0),
        };
      }),
      counts: { students: sum((r) => r.orders, "batch"), demos: sum((r) => r.orders, "demo") },
      money: { sales: sum((r) => r.items), share: sum((r) => r.share), commissionBps: settings.commissionBps },
      missing: c.status === "draft" ? missingOf(c, mine, businessLive(c.businessId), now) : [],
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  });
}
