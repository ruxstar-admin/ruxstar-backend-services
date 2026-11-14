import { randomUUID } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type WithId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, writeAudit } from "../../platform/audit.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type {
  CoachingBatchDoc,
  CoachingCourseDoc,
  CoachingMaterialDoc,
  CoachingSessionDoc,
  Database,
  TeamPermission,
} from "../../platform/db.js";
import { stamp } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { notifyCoaching } from "../notifications/notify.js";
import { sniff } from "../pod/orders.js";
import { Done } from "../social/contracts.js";
import { teamAccess } from "../team/team.js";
import {
  AttendanceBody,
  CancelBody,
  ClassParams,
  DeskBatchDetail,
  DeskBatchList,
  DeskStudentList,
  ExtraClassBody,
  FileMaterialQuery,
  IdParams,
  LinkMaterialBody,
  MaterialList,
  MaterialOne,
  MessageBody,
  MessageList,
  MessageOne,
  MoveBody,
  Roster,
  TodayList,
} from "./contracts.js";
import { cancelOrder, courseLink, moveDemos, orderLink, refreshDates, when, type By } from "./orders.js";
import { addDays, atTime, coachingSettings, DAY_MS, dayOf, MARK_EARLY_MS, MAX_AHEAD_DAYS, scheduleText } from "./rules.js";
import { batchStatus, materialView } from "./views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const FILE_TYPES = ["application/pdf", "image/jpeg", "image/png"];
const MATERIAL_MAX_BYTES = 20 * 1024 * 1024;
const MAX_MATERIALS = 200;
const invalid = (path: string, message: string) => new AppError("VALIDATION_FAILED", message, [{ path, message }]);

interface Desk {
  batch: WithId<CoachingBatchDoc>;
  course: WithId<CoachingCourseDoc>;
  ownerId: ObjectId;
  role: "owner" | "coach";
  can: { attendance: boolean; message: boolean; materials: boolean; reschedule: boolean };
}

const ALL = { attendance: true, message: true, materials: true, reschedule: true };
const canOf = (permissions: TeamPermission[]) => ({
  attendance: permissions.includes("classes.attendance"),
  message: permissions.includes("classes.message"),
  materials: permissions.includes("classes.materials"),
  reschedule: permissions.includes("classes.reschedule"),
});

type DeskClass = {
  id: string;
  startsAt: string;
  endsAt: string;
  status: "upcoming" | "done" | "cancelled";
  extra: boolean;
  movedFrom: string | null;
  cancelReason: string | null;
  demos: number;
  marked: boolean;
  present: number;
};

async function presentCounts(db: Database, sessions: CoachingSessionDoc[]) {
  if (!sessions.length) return [];
  return db.coachingAttendance
    .aggregate<{ _id: ObjectId; n: number }>([
      { $match: { sessionId: { $in: sessions.map((s) => s._id) }, present: true } },
      { $group: { _id: "$sessionId", n: { $sum: 1 } } },
    ])
    .toArray();
}

const deskClass = (s: CoachingSessionDoc, present: { _id: ObjectId; n: number }[], now: Date): DeskClass => ({
  id: s._id.toHexString(),
  startsAt: s.startsAt.toISOString(),
  endsAt: s.endsAt.toISOString(),
  status: s.status === "cancelled" ? "cancelled" : s.endsAt <= now ? "done" : "upcoming",
  extra: s.extra,
  movedFrom: s.movedFrom?.startsAt.toISOString() ?? null,
  cancelReason: s.cancellation?.reason ?? null,
  demos: s.demos,
  marked: s.markedAt !== null,
  present: present.find((p) => p._id.equals(s._id))?.n ?? 0,
});

/** Who's in a batch: paid enrolments, and for one class its paid demo students too. */
async function rosterOf(db: Database, batchId: ObjectId, sessionId: ObjectId | null) {
  return db.coachingOrders
    .find(
      {
        batchId,
        status: "confirmed",
        $or: [{ kind: "batch" }, ...(sessionId ? [{ kind: "demo" as const, sessionId }] : [])],
      },
      { projection: { customerId: 1, student: 1, kind: 1, sessionId: 1, firstAt: 1 } },
    )
    .sort({ kind: 1, "student.name": 1 })
    .toArray();
}

/** Classes for the owner and the coaches of each batch: the timetable, attendance, changes to classes, messages and materials. */
const desk: FastifyPluginAsyncTypebox = async (app) => {
  app.addContentTypeParser(FILE_TYPES, { parseAs: "buffer", bodyLimit: MATERIAL_MAX_BYTES }, (_request, body, done) => done(null, body));
  const db = () => requireDatabase(app.db);

  async function access(request: FastifyRequest, batchId: ObjectId, permission: TeamPermission): Promise<Desk> {
    const batch = await db().coachingBatches.findOne({ _id: batchId });
    const course = batch ? await db().coachingCourses.findOne({ _id: batch.courseId }) : null;
    if (!batch || !course) throw new AppError("NOT_FOUND", "Batch not found.");
    const business = await db().businesses.findOne({ _id: batch.businessId }, { projection: { ownerId: 1, suspension: 1 } });
    if (!business) throw new AppError("NOT_FOUND", "Batch not found.");
    const userId = request.auth!.userId;
    if (business.ownerId.equals(userId)) {
      if (business.suspension) throw new AppError("BUSINESS_SUSPENDED");
      return { batch, course, ownerId: business.ownerId, role: "owner", can: ALL };
    }
    const { place } = await teamAccess(db(), request.auth!, { businessId: batch.businessId }, permission);
    if (!batch.coachIds.some((id) => id.equals(userId))) throw new AppError("FORBIDDEN", "You don't teach this batch.");
    return { batch, course, ownerId: business.ownerId, role: "coach", can: canOf(place.permissions) };
  }
  async function classAccess(request: FastifyRequest, sessionId: string, permission: TeamPermission) {
    const session = await db().coachingSessions.findOne({ _id: new ObjectId(sessionId) });
    if (!session) throw new AppError("NOT_FOUND", "Class not found.");
    return { session, ...(await access(request, session.batchId, permission)) };
  }
  const by = (request: FastifyRequest): By => ({ kind: "vendor", actor: actorOf(request), ip: request.ip });
  const editable = (d: Desk) => {
    if (d.batch.status === "cancelled") throw new AppError("CONFLICT", "This batch is cancelled.");
    if (d.course.status === "removed") throw new AppError("CONFLICT", "Ruxstar took this course down.");
  };
  const actorName = async (request: FastifyRequest) => {
    const user = await db().users.findOne({ _id: request.auth!.userId }, { projection: { name: 1, username: 1 } });
    return user?.name ?? user?.username ?? "The institute";
  };

  /** Tells the batch's students, and demo students of the classes concerned, and the owner when a coach made the change. */
  async function tell(request: FastifyRequest, d: Desk, msg: { title: string; body: string }, demoSessions: ObjectId[] = []) {
    const now = new Date();
    const students = await db()
      .coachingOrders.find(
        {
          batchId: d.batch._id,
          status: "confirmed",
          $or: [{ kind: "batch" }, { kind: "demo", ...(demoSessions.length ? { sessionId: { $in: demoSessions } } : { firstEndsAt: { $gt: now } }) }],
        },
        { projection: { customerId: 1 } },
      )
      .toArray();
    const to = students.map((o) => ({ userId: o.customerId, link: orderLink(o) }));
    if (d.role === "coach") to.push({ userId: d.ownerId, link: courseLink(d.course._id) });
    await notifyCoaching(db(), request.log, { actor: request.auth!.userId, type: "coaching.updated", ...msg, to });
  }

  async function deskBatches(request: FastifyRequest, filter: { batchIds?: ObjectId[] } = {}) {
    const userId = request.auth!.userId;
    const [owned, places] = await Promise.all([
      db().businesses.find({ ownerId: userId, module: "coaching", suspension: { $exists: false } }, { projection: { _id: 1 } }).toArray(),
      db().employments.find({ userId, status: "active", current: true, permissions: "classes.view" }, { projection: { businessId: 1, permissions: 1 } }).toArray(),
    ]);
    const verified = request.auth!.kyc.base === "approved";
    const held = await db().businesses.find({ _id: { $in: places.map((p) => p.businessId) }, suspension: { $exists: true } }, { projection: { _id: 1 } }).toArray();
    const teamPlaces = verified ? places.filter((p) => !held.some((h) => h._id.equals(p.businessId))) : [];
    const recent = new Date(Date.now() - 14 * DAY_MS);
    const batches = await db()
      .coachingBatches.find({
        ...(filter.batchIds ? { _id: { $in: filter.batchIds } } : {}),
        status: "live",
        lastEndsAt: { $gt: recent },
        $or: [{ businessId: { $in: owned.map((b) => b._id) } }, { businessId: { $in: teamPlaces.map((p) => p.businessId) }, coachIds: userId }],
      })
      .sort({ firstAt: 1 })
      .limit(100)
      .toArray();
    return batches.map((batch) => {
      const mine = owned.some((b) => b._id.equals(batch.businessId));
      const place = teamPlaces.find((p) => p.businessId.equals(batch.businessId));
      return { batch, role: mine ? ("owner" as const) : ("coach" as const), can: mine ? ALL : canOf(place?.permissions ?? []) };
    });
  }

  async function batchView(entries: { batch: WithId<CoachingBatchDoc>; role: Desk["role"]; can: Desk["can"] }[], withClasses = false) {
    if (!entries.length) return [];
    const ids = entries.map((e) => e.batch._id);
    const now = new Date();
    const [courses, students, sessions] = await Promise.all([
      db().coachingCourses.find({ _id: { $in: entries.map((e) => e.batch.courseId) } }, { projection: { title: 1, mode: 1, businessName: 1 } }).toArray(),
      db()
        .coachingOrders.aggregate<{ _id: ObjectId; n: number }>([
          { $match: { batchId: { $in: ids }, kind: "batch", status: "confirmed" } },
          { $group: { _id: "$batchId", n: { $sum: 1 } } },
        ])
        .toArray(),
      withClasses
        ? db().coachingSessions.find({ batchId: { $in: ids } }).sort({ startsAt: 1 }).toArray()
        : db().coachingSessions.find({ batchId: { $in: ids }, status: "scheduled", endsAt: { $gt: now } }).sort({ startsAt: 1 }).toArray(),
    ]);
    const present = await presentCounts(db(), sessions);
    return entries.map(({ batch, role, can }) => {
      const course = courses.find((c) => c._id.equals(batch.courseId));
      const mine = sessions.filter((s) => s.batchId.equals(batch._id));
      const next = mine.find((s) => s.status === "scheduled" && s.endsAt > now);
      return {
        id: batch._id.toHexString(),
        name: batch.name,
        course: { id: batch.courseId.toHexString(), title: course?.title ?? "", mode: course?.mode ?? ("offline" as const) },
        business: { id: batch.businessId.toHexString(), name: course?.businessName ?? "" },
        schedule: scheduleText(batch.slots),
        slots: batch.slots,
        firstAt: batch.firstAt.toISOString(),
        lastEndsAt: batch.lastEndsAt.toISOString(),
        status: batchStatus(batch, now),
        onlineLink: batch.onlineLink,
        students: students.find((s) => s._id.equals(batch._id))?.n ?? 0,
        nextClass: next ? deskClass(next, present, now) : null,
        role,
        can,
        ...(withClasses ? { classes: mine.map((s) => deskClass(s, present, now)) } : {}),
      };
    });
  }

  app.get(
    "/batches",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["coaching"],
        summary: "Batches you run or teach, soonest first",
        description: "Your own institutes' batches, and those you're a coach on with “See their batches and students”. Ended ones drop off after two weeks.",
        response: { 200: DeskBatchList, ...Errors },
        security,
      },
    },
    async (request) => page(request, await batchView(await deskBatches(request)), null),
  );

  app.get(
    "/today",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["coaching"],
        summary: "Today's classes across your batches, by start time",
        response: { 200: TodayList, ...Errors },
        security,
      },
    },
    async (request) => {
      const entries = await deskBatches(request);
      const today = dayOf(new Date());
      const sessions = await db()
        .coachingSessions.find({
          batchId: { $in: entries.map((e) => e.batch._id) },
          startsAt: { $gte: atTime(today, "00:00"), $lt: atTime(addDays(today, 1), "00:00") },
        })
        .sort({ startsAt: 1 })
        .toArray();
      const [courses, students, present] = await Promise.all([
        db().coachingCourses.find({ _id: { $in: entries.map((e) => e.batch.courseId) } }, { projection: { title: 1 } }).toArray(),
        db()
          .coachingOrders.aggregate<{ _id: ObjectId; n: number }>([
            { $match: { batchId: { $in: entries.map((e) => e.batch._id) }, kind: "batch", status: "confirmed" } },
            { $group: { _id: "$batchId", n: { $sum: 1 } } },
          ])
          .toArray(),
        presentCounts(db(), sessions),
      ]);
      const now = new Date();
      return page(
        request,
        sessions.map((s) => {
          const batch = entries.find((e) => e.batch._id.equals(s.batchId))!.batch;
          return {
            ...deskClass(s, present, now),
            batch: { id: batch._id.toHexString(), name: batch.name },
            course: { id: batch.courseId.toHexString(), title: courses.find((c) => c._id.equals(batch.courseId))?.title ?? "" },
            students: (students.find((x) => x._id.equals(batch._id))?.n ?? 0) + s.demos,
          };
        }),
        null,
      );
    },
  );

  app.get(
    "/batches/:id",
    {
      preHandler: requireAuth,
      schema: { tags: ["coaching"], summary: "One batch with every class", params: IdParams, response: { 200: DeskBatchDetail, ...Errors }, security },
    },
    async (request) => {
      const d = await access(request, new ObjectId(request.params.id), "classes.view");
      const [view] = await batchView([{ batch: d.batch, role: d.role, can: d.can }], true);
      return ok(request, view as typeof view & { classes: DeskClass[] });
    },
  );

  async function rosterView(d: Desk & { session: WithId<CoachingSessionDoc> }) {
    const now = new Date();
    const [orders, marks, present] = await Promise.all([
      rosterOf(db(), d.batch._id, d.session._id),
      db().coachingAttendance.find({ sessionId: d.session._id }).toArray(),
      presentCounts(db(), [d.session]),
    ]);
    return {
      class: deskClass(d.session, present, now),
      batch: { id: d.batch._id.toHexString(), name: d.batch.name },
      canMark: d.can.attendance && markOpen(d, now) === null,
      students: orders.map((o) => ({
        orderId: o._id.toHexString(),
        name: o.student.name,
        kind: o.kind,
        child: o.student.childId !== null,
        present: marks.find((m) => m.orderId.equals(o._id))?.present ?? null,
      })),
    };
  }
  const markOpen = (d: Desk & { session: CoachingSessionDoc }, now: Date): string | null =>
    d.session.status === "cancelled"
      ? "This class was cancelled."
      : d.session.startsAt.getTime() - MARK_EARLY_MS > now.getTime()
        ? "Attendance opens 30 minutes before the class."
        : d.batch.certificatesAt
          ? "Certificates are issued, so attendance is closed."
          : null;

  app.get(
    "/classes/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["coaching"],
        summary: "A class's students, with attendance so far",
        description: "Paid students of the batch, and paid demo students booked into this class.",
        params: ClassParams,
        response: { 200: Roster, ...Errors },
        security,
      },
    },
    async (request) => ok(request, await rosterView(await classAccess(request, request.params.id, "classes.view"))),
  );

  app.put(
    "/classes/:id/attendance",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["coaching"],
        summary: "Mark who came: tick each student present or absent",
        description: "Send any of the class's students; others keep what they had. Saving again changes the marks.",
        params: ClassParams,
        body: AttendanceBody,
        response: { 200: Roster, ...Errors },
        security,
      },
    },
    async (request) => {
      const d = await classAccess(request, request.params.id, "classes.attendance");
      if (!d.can.attendance) throw new AppError("FORBIDDEN", "The owner hasn't given you attendance.");
      const now = new Date();
      const closed = markOpen(d, now);
      if (closed) throw new AppError("CONFLICT", closed);
      const roster = await rosterOf(db(), d.batch._id, d.session._id);
      const userId = request.auth!.userId;
      const ops = request.body.marks.map((m, i) => {
        const order = roster.find((o) => o._id.toHexString() === m.orderId);
        if (!order) throw invalid(`body/marks/${i}/orderId`, "This student isn't in this class.");
        return {
          updateOne: {
            filter: { sessionId: d.session._id, orderId: order._id },
            update: {
              $set: { present: m.present, by: userId, at: now, batchId: d.batch._id },
              $setOnInsert: { _id: new ObjectId(), sessionId: d.session._id, orderId: order._id },
            },
            upsert: true,
          },
        };
      });
      await db().coachingAttendance.bulkWrite(ops, { ordered: false });
      const session = await db().coachingSessions.findOneAndUpdate({ _id: d.session._id }, { $set: { markedAt: now, updatedAt: now } }, { returnDocument: "after" });
      return ok(request, await rosterView({ ...d, session: session ?? d.session }));
    },
  );

  app.post(
    "/classes/:id/cancel",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["coaching"],
        summary: "Cancel a class to come",
        description:
          "Every student is told why. There's no refund for a single class; add an extra class to make it up. Demo students booked into it are refunded in full.",
        params: ClassParams,
        body: CancelBody,
        response: { 200: DeskBatchDetail, ...Errors },
        security,
      },
    },
    async (request) => {
      const d = await classAccess(request, request.params.id, "classes.reschedule");
      if (!d.can.reschedule) throw new AppError("FORBIDDEN", "The owner hasn't given you this.");
      editable(d);
      const now = new Date();
      if (d.session.status === "cancelled") throw new AppError("CONFLICT", "This class is cancelled already.");
      if (d.session.startsAt <= now) throw new AppError("CONFLICT", "Only classes still to come can be cancelled.");
      const left = await db().coachingSessions.countDocuments({ batchId: d.batch._id, status: "scheduled" });
      if (left <= 1) throw new AppError("CONFLICT", "This is the batch's only class. Move it, or cancel the batch.");
      const reason = request.body.reason.trim();
      const res = await db().coachingSessions.updateOne(
        { _id: d.session._id, status: "scheduled" },
        { $set: { status: "cancelled", cancellation: { by: request.auth!.userId, reason, at: now }, updatedAt: now } },
      );
      if (!res.modifiedCount) throw new AppError("CONFLICT");
      await refreshDates(db(), d.batch._id);
      await writeAudit(db(), {
        actor: actorOf(request),
        scope: { module: "coaching", businessId: d.batch.businessId },
        action: "coaching_session.cancel",
        target: { type: "coaching_session", id: d.session._id },
        diff: { status: { from: "scheduled", to: "cancelled" }, reason: { from: null, to: reason } },
        ip: request.ip,
      });
      await tell(request, d, { title: `Class cancelled: ${d.course.title}`, body: `${d.batch.name}, ${when(d.session.startsAt)}. ${reason}` }, [d.session._id]);
      for (const demo of await db().coachingOrders.find({ sessionId: d.session._id, status: { $in: ["awaiting_payment", "confirmed"] } }).toArray()) {
        await cancelOrder(app, db(), demo, by(request), { reason: `The demo class on ${when(d.session.startsAt)} was cancelled: ${reason}` }).catch((err: Error) =>
          request.log.error({ err: err.message, order: demo._id.toHexString() }, "Demo not cancelled with its class"),
        );
      }
      const fresh = (await db().coachingBatches.findOne({ _id: d.batch._id }))!;
      return ok(request, (await batchView([{ batch: fresh, role: d.role, can: d.can }], true))[0] as never);
    },
  );

  async function clash(batchId: ObjectId, startsAt: Date, endsAt: Date, except: ObjectId | null) {
    return db().coachingSessions.findOne({
      batchId,
      status: "scheduled",
      ...(except ? { _id: { $ne: except } } : {}),
      startsAt: { $lt: endsAt },
      endsAt: { $gt: startsAt },
    });
  }
  const checkWhen = (startsAt: Date, now: Date, path: string) => {
    if (startsAt <= now) throw invalid(path, "Pick a time in the future.");
    if (startsAt.getTime() > now.getTime() + MAX_AHEAD_DAYS * DAY_MS) throw invalid(path, "Pick a time within a year.");
  };

  app.post(
    "/classes/:id/move",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["coaching"],
        summary: "Move a class to come to another time",
        description: "Every student, and demo students booked into it, is told the new time.",
        params: ClassParams,
        body: MoveBody,
        response: { 200: DeskBatchDetail, ...Errors },
        security,
      },
    },
    async (request) => {
      const d = await classAccess(request, request.params.id, "classes.reschedule");
      if (!d.can.reschedule) throw new AppError("FORBIDDEN", "The owner hasn't given you this.");
      editable(d);
      const now = new Date();
      if (d.session.status === "cancelled") throw new AppError("CONFLICT", "This class is cancelled.");
      if (d.session.startsAt <= now) throw new AppError("CONFLICT", "Only classes still to come can be moved.");
      const startsAt = new Date(request.body.startsAt);
      checkWhen(startsAt, now, "body/startsAt");
      const minutes = request.body.minutes ?? Math.round((d.session.endsAt.getTime() - d.session.startsAt.getTime()) / 60_000);
      const endsAt = new Date(startsAt.getTime() + minutes * 60_000);
      if (await clash(d.batch._id, startsAt, endsAt, d.session._id)) throw invalid("body/startsAt", "Another class of this batch is at that time.");
      const res = await db().coachingSessions.updateOne(
        { _id: d.session._id, status: "scheduled", startsAt: d.session.startsAt },
        { $set: { startsAt, endsAt, movedFrom: d.session.movedFrom ?? { startsAt: d.session.startsAt, endsAt: d.session.endsAt }, updatedAt: now } },
      );
      if (!res.modifiedCount) throw new AppError("CONFLICT");
      await refreshDates(db(), d.batch._id);
      await moveDemos(db(), { _id: d.session._id, startsAt, endsAt });
      await writeAudit(db(), {
        actor: actorOf(request),
        scope: { module: "coaching", businessId: d.batch.businessId },
        action: "coaching_session.move",
        target: { type: "coaching_session", id: d.session._id },
        diff: { startsAt: { from: d.session.startsAt.toISOString(), to: startsAt.toISOString() } },
        ip: request.ip,
      });
      const why = request.body.reason?.trim();
      await tell(
        request,
        d,
        { title: `Class moved: ${d.course.title}`, body: `${d.batch.name}: ${when(d.session.startsAt)} is now ${when(startsAt)}.${why ? ` ${why}` : ""}` },
        [d.session._id],
      );
      const fresh = (await db().coachingBatches.findOne({ _id: d.batch._id }))!;
      return ok(request, (await batchView([{ batch: fresh, role: d.role, can: d.can }], true))[0] as never);
    },
  );

  app.post(
    "/batches/:id/classes",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["coaching"],
        summary: "Add an extra class, for example to make up a cancelled one",
        description: "Every student is told. Up to Ruxstar's most classes per batch; not once the batch has ended.",
        params: IdParams,
        body: ExtraClassBody,
        response: { 201: DeskBatchDetail, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const d = await access(request, new ObjectId(request.params.id), "classes.reschedule");
      if (!d.can.reschedule) throw new AppError("FORBIDDEN", "The owner hasn't given you this.");
      editable(d);
      const now = new Date();
      if (d.batch.certificatesAt || d.batch.lastEndsAt <= now) throw new AppError("CONFLICT", "This batch has ended.");
      const startsAt = new Date(request.body.startsAt);
      checkWhen(startsAt, now, "body/startsAt");
      const endsAt = new Date(startsAt.getTime() + request.body.minutes * 60_000);
      const { maxClasses } = await coachingSettings(db());
      if ((await db().coachingSessions.countDocuments({ batchId: d.batch._id, status: "scheduled" })) >= maxClasses) {
        throw new AppError("CONFLICT", `A batch has up to ${maxClasses} classes.`);
      }
      if (await clash(d.batch._id, startsAt, endsAt, null)) throw invalid("body/startsAt", "Another class of this batch is at that time.");
      const session: CoachingSessionDoc = {
        _id: new ObjectId(),
        batchId: d.batch._id,
        courseId: d.course._id,
        businessId: d.batch.businessId,
        startsAt,
        endsAt,
        status: "scheduled",
        extra: true,
        movedFrom: null,
        cancellation: null,
        demos: 0,
        markedAt: null,
        ...stamp(now),
      };
      await db().coachingSessions.insertOne(session);
      await refreshDates(db(), d.batch._id);
      await writeAudit(db(), {
        actor: actorOf(request),
        scope: { module: "coaching", businessId: d.batch.businessId },
        action: "coaching_session.add",
        target: { type: "coaching_session", id: session._id },
        diff: { startsAt: { from: null, to: startsAt.toISOString() } },
        ip: request.ip,
      });
      await tell(request, d, { title: `Extra class: ${d.course.title}`, body: `${d.batch.name}, ${when(startsAt)}.` });
      const fresh = (await db().coachingBatches.findOne({ _id: d.batch._id }))!;
      return reply.status(201).send(ok(request, (await batchView([{ batch: fresh, role: d.role, can: d.can }], true))[0] as never));
    },
  );

  // Messages.

  app.get(
    "/batches/:id/messages",
    {
      preHandler: requireAuth,
      schema: { tags: ["coaching"], summary: "Messages sent to the batch, newest first", params: IdParams, response: { 200: MessageList, ...Errors }, security },
    },
    async (request) => {
      const d = await access(request, new ObjectId(request.params.id), "classes.view");
      const docs = await db().coachingMessages.find({ batchId: d.batch._id }).sort({ at: -1 }).limit(100).toArray();
      return page(request, docs.map((m) => ({ id: m._id.toHexString(), text: m.text, author: m.authorName, at: m.at.toISOString() })), null);
    },
  );

  app.post(
    "/batches/:id/messages",
    {
      preHandler: [requireAuth, idempotent],
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["coaching"],
        summary: "Message everyone in the batch",
        description: "Each student, or their parent, gets a notification and sees it on their enrolment. Demo students with a class to come get it too.",
        params: IdParams,
        body: MessageBody,
        response: { 201: MessageOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const d = await access(request, new ObjectId(request.params.id), "classes.message");
      if (!d.can.message) throw new AppError("FORBIDDEN", "The owner hasn't given you this.");
      editable(d);
      const now = new Date();
      const doc = {
        _id: new ObjectId(),
        batchId: d.batch._id,
        courseId: d.course._id,
        authorId: request.auth!.userId,
        authorName: await actorName(request),
        text: request.body.text.trim(),
        at: now,
      };
      await db().coachingMessages.insertOne(doc);
      await tell(request, { ...d, role: "owner" }, { title: `${d.course.title}: ${d.batch.name}`, body: doc.text });
      return reply.status(201).send(ok(request, { id: doc._id.toHexString(), text: doc.text, author: doc.authorName, at: now.toISOString() }));
    },
  );

  // Materials.

  app.get(
    "/batches/:id/materials",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["coaching"],
        summary: "Files and links the batch's students see, newest first",
        description: "Including the ones for every batch of the course.",
        params: IdParams,
        response: { 200: MaterialList, ...Errors },
        security,
      },
    },
    async (request) => {
      const d = await access(request, new ObjectId(request.params.id), "classes.view");
      const docs = await db()
        .coachingMaterials.find({ courseId: d.course._id, $or: [{ batchId: d.batch._id }, { batchId: null }] })
        .sort({ createdAt: -1 })
        .limit(MAX_MATERIALS)
        .toArray();
      return page(request, docs.map(materialView(app, request)), null);
    },
  );

  async function addMaterial(request: FastifyRequest, d: Desk, doc: Omit<CoachingMaterialDoc, "_id" | "courseId" | "batchId" | "businessId" | "addedBy" | "createdAt">, wholeCourse: boolean) {
    if (wholeCourse && d.role !== "owner") throw new AppError("FORBIDDEN", "Only the owner can add material for every batch.");
    if ((await db().coachingMaterials.countDocuments({ courseId: d.course._id })) >= MAX_MATERIALS) {
      throw new AppError("CONFLICT", `A course has up to ${MAX_MATERIALS} files and links. Remove some first.`);
    }
    const material: CoachingMaterialDoc = {
      _id: new ObjectId(),
      courseId: d.course._id,
      batchId: wholeCourse ? null : d.batch._id,
      businessId: d.batch.businessId,
      addedBy: request.auth!.userId,
      createdAt: new Date(),
      ...doc,
    };
    await db().coachingMaterials.insertOne(material);
    const batchIds = wholeCourse ? (await db().coachingBatches.find({ courseId: d.course._id, status: "live" }, { projection: { _id: 1 } }).toArray()).map((b) => b._id) : [d.batch._id];
    const students = await db()
      .coachingOrders.find({ batchId: { $in: batchIds }, kind: "batch", status: "confirmed" }, { projection: { customerId: 1 } })
      .toArray();
    await notifyCoaching(db(), request.log, {
      actor: request.auth!.userId,
      type: "coaching.updated",
      title: `New in ${d.course.title}: ${material.title}`,
      body: material.kind === "file" ? "A file was added for your batch." : "A link was added for your batch.",
      to: students.map((o) => ({ userId: o.customerId, link: orderLink(o) })),
    });
    return material;
  }

  app.post(
    "/batches/:id/materials",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["coaching"],
        summary: "Share a link with the batch",
        description: "With `wholeCourse`, the owner shares it with every batch of the course. Students are told.",
        params: IdParams,
        body: LinkMaterialBody,
        response: { 201: MaterialOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const d = await access(request, new ObjectId(request.params.id), "classes.materials");
      if (!d.can.materials) throw new AppError("FORBIDDEN", "The owner hasn't given you this.");
      editable(d);
      const doc = await addMaterial(request, d, { title: request.body.title.trim(), kind: "link", file: null, url: request.body.url.trim() }, Boolean(request.body.wholeCourse));
      return reply.status(201).send(ok(request, materialView(app, request)(doc)));
    },
  );

  app.post(
    "/batches/:id/materials/file",
    {
      preHandler: [requireAuth, idempotent],
      config: { rateLimit: { max: 60, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["coaching"],
        summary: "Upload a file for the batch",
        description: "Send the file itself with Content-Type application/pdf, image/jpeg or image/png, up to 20 MB. Students are told.",
        consumes: FILE_TYPES,
        params: IdParams,
        querystring: FileMaterialQuery,
        response: { 201: MaterialOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const d = await access(request, new ObjectId(request.params.id), "classes.materials");
      if (!d.can.materials) throw new AppError("FORBIDDEN", "The owner hasn't given you this.");
      editable(d);
      const data = request.body;
      if (!Buffer.isBuffer(data) || data.length === 0) throw new AppError("FILE_INVALID");
      const contentType = sniff(data);
      if (!contentType) throw new AppError("FILE_INVALID");
      const title = request.query.title.trim();
      const extension = contentType === "application/pdf" ? "pdf" : contentType === "image/png" ? "png" : "jpg";
      const key = `coaching/${d.course._id.toHexString()}/${randomUUID()}.${extension}`;
      await app.printFiles.save(key, data, contentType, { keep: true });
      const doc = await addMaterial(
        request,
        d,
        { title, kind: "file", file: { key, name: `${title}.${extension}`, contentType, bytes: data.length }, url: null },
        Boolean(request.query.wholeCourse),
      ).catch(async (err: unknown) => {
        await app.printFiles.remove(key);
        throw err;
      });
      return reply.status(201).send(ok(request, materialView(app, request)(doc)));
    },
  );

  app.delete(
    "/materials/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["coaching"],
        summary: "Remove a file or link",
        description: "Coaches remove their batch's; the owner, any.",
        params: IdParams,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const material = await db().coachingMaterials.findOne({ _id: new ObjectId(request.params.id) });
      if (!material) throw new AppError("NOT_FOUND", "Not found.");
      if (material.batchId) {
        const d = await access(request, material.batchId, "classes.materials");
        if (!d.can.materials) throw new AppError("FORBIDDEN", "The owner hasn't given you this.");
      } else {
        const business = await db().businesses.findOne({ _id: material.businessId }, { projection: { ownerId: 1 } });
        if (!business?.ownerId.equals(request.auth!.userId)) throw new AppError("FORBIDDEN", "Only the owner can remove material for every batch.");
      }
      await db().coachingMaterials.deleteOne({ _id: material._id });
      if (material.file) await app.printFiles.remove(material.file.key);
      return ok(request, { done: true as const });
    },
  );

  app.get(
    "/batches/:id/students",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["coaching"],
        summary: "The batch's paid students with their attendance so far",
        params: IdParams,
        response: { 200: DeskStudentList, ...Errors },
        security,
      },
    },
    async (request) => {
      const d = await access(request, new ObjectId(request.params.id), "classes.view");
      const now = new Date();
      const [orders, held] = await Promise.all([
        rosterOf(db(), d.batch._id, null),
        db().coachingSessions.find({ batchId: d.batch._id, status: "scheduled", endsAt: { $lte: now } }, { projection: { _id: 1 } }).toArray(),
      ]);
      const present = await db()
        .coachingAttendance.aggregate<{ _id: ObjectId; n: number }>([
          { $match: { sessionId: { $in: held.map((s) => s._id) }, orderId: { $in: orders.map((o) => o._id) }, present: true } },
          { $group: { _id: "$orderId", n: { $sum: 1 } } },
        ])
        .toArray();
      return page(
        request,
        orders.map((o) => {
          const attended = present.find((p) => p._id.equals(o._id))?.n ?? 0;
          return {
            orderId: o._id.toHexString(),
            name: o.student.name,
            child: o.student.childId !== null,
            attended,
            held: held.length,
            percent: held.length ? Math.round((attended * 100) / held.length) : 0,
            certificateAt: d.course.certificatePercent,
          };
        }),
        null,
      );
    },
  );
};

export default desk;
