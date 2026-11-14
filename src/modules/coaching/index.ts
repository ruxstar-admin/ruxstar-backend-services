import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyInstance } from "fastify";
import { ObjectId, type Filter } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { CoachingCourseDoc, CoachingOrderDoc, Database } from "../../platform/db.js";
import { stamp } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { isModuleLive } from "../../platform/module-switch.js";
import { findPage } from "../../platform/pagination.js";
import { checkCode, offersFor } from "../coupons/coupons.js";
import { safeReturn } from "../pod/orders.js";
import { escapeRegex } from "../pod/shops.js";
import { Done } from "../social/contracts.js";
import { coachingCheckoutUrl, coachingFileLinks } from "./checkout.js";
import {
  CertificateList,
  CheckoutLinkOne,
  ChildBody,
  ChildList,
  ChildOne,
  CoachingOrderList,
  CoachingOrderOne,
  CoachingRulesOne,
  CourseList,
  CourseOne,
  CoursesQuery,
  DemoBody,
  EnrolBody,
  IdParams,
  MaterialList,
  MessageList,
  MyOrdersQuery,
  OffersOne,
  OffersQuery,
  PayBody,
  PlacedOrder,
  Timetable,
  TimetableQuery,
  UpdateChildBody,
  type CourseDetail,
} from "./contracts.js";
import desk from "./desk.js";
import { cancelOrder, catchUp, placeOrder, syncCoachingPayment } from "./orders.js";
import { addDays, atTime, coachingSettings, DAY_MS, dayOf } from "./rules.js";
import { batchViews, classView, courseCard, courseCards, isOpen, materialView, orderViews, photoView, REFUND_RULE, sortBatches } from "./views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const MAX_CHILDREN = 10;

/** Runs the checks a missed sweep would leave undone on these orders' batches, and reads the orders again if anything moved. */
export async function freshOrders(app: FastifyInstance, db: Database, orders: CoachingOrderDoc[]): Promise<CoachingOrderDoc[]> {
  if (!orders.length) return orders;
  const batches = await db.coachingBatches.find({ _id: { $in: orders.map((o) => o.batchId) } }).toArray();
  if (!(await catchUp(app, db, batches))) return orders;
  const again = await db.coachingOrders.find({ _id: { $in: orders.map((o) => o._id) } }).toArray();
  return orders.map((o) => again.find((a) => a._id.equals(o._id)) ?? o);
}

/** Coaching for customers: finding courses, demos, enrolling and paying, their classes, children and certificates. Teaching is under /desk. */
const coaching: FastifyPluginAsyncTypebox = async (app) => {
  await app.register(desk, { prefix: "/desk" });
  const db = () => requireDatabase(app.db);

  async function heldBusinesses(ids: ObjectId[]) {
    const held = await db().businesses.find({ _id: { $in: ids }, suspension: { $exists: true } }, { projection: { _id: 1 } }).toArray();
    return new Set(held.map((b) => b._id.toHexString()));
  }
  async function mine(userId: ObjectId, id: string) {
    const doc = await db().coachingOrders.findOne({ _id: new ObjectId(id), customerId: userId });
    if (!doc) throw new AppError("NOT_FOUND", "Enrolment not found.");
    return doc;
  }
  async function customerOf(userId: ObjectId) {
    const user = await db().users.findOne({ _id: userId }, { projection: { phone: 1, name: 1 } });
    if (!user) throw new AppError("UNAUTHENTICATED");
    return { id: userId, phone: user.phone, name: user.name?.trim() || null };
  }
  async function takingStudents(course: CoachingCourseDoc | null) {
    if (!course || course.status !== "live") throw new AppError("NOT_FOUND", "This course isn't taking students.");
    if (!(await isModuleLive(db(), "coaching"))) throw new AppError("MODULE_OFF");
    const business = await db().businesses.findOne({ _id: course.businessId }, { projection: { suspension: 1 } });
    if (business?.suspension) throw new AppError("BUSINESS_SUSPENDED");
  }

  app.get(
    "/rules",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["coaching"],
        summary: "Ruxstar's rules for coaching: certificates, minimum batch size checks, limits and fees",
        response: { 200: CoachingRulesOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { live: _live, ...rules } = await coachingSettings(db());
      return ok(request, rules);
    },
  );

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["coaching"],
        summary: "Courses taking students, newest first",
        description:
          "With `city`, courses taught there and online ones (unless `online` is false). Courses with no batch open show `openBatches` 0. " +
          "Empty while Ruxstar has coaching switched off.",
        querystring: CoursesQuery,
        response: { 200: CourseList, ...Errors },
        security,
      },
    },
    async (request) => {
      if (!(await isModuleLive(db(), "coaching"))) return page(request, [], null);
      const { city, category, online, q, cursor, limit } = request.query;
      const filters: Filter<CoachingCourseDoc>[] = [{ status: "live" }];
      if (online !== undefined) filters.push({ mode: online ? "online" : "offline" });
      if (city) filters.push(online === false ? { city: city.trim().toLowerCase() } : { $or: [{ city: city.trim().toLowerCase() }, { mode: "online" }] });
      if (category) filters.push({ category });
      if (q?.trim()) {
        const words = { $regex: escapeRegex(q.trim()), $options: "i" };
        filters.push({ $or: [{ title: words }, { businessName: words }] });
      }
      const { items, nextCursor } = await findPage(db().coachingCourses, { filter: { $and: filters }, sortField: "publishedAt", cursor, limit });
      const held = await heldBusinesses(items.map((c) => c.businessId));
      return page(request, await courseCards(db(), items.filter((c) => !held.has(c.businessId.toHexString()))), nextCursor);
    },
  );

  app.get(
    "/orders",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["coaching"],
        summary: "Your enrolments and demo classes: current ones by first class, or past ones newest first",
        description: "Yours and your children's. Current: not cancelled, and the batch or demo class not over.",
        querystring: MyOrdersQuery,
        response: { 200: CoachingOrderList, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const now = new Date();
      if ((request.query.view ?? "current") === "current") {
        const docs = await db().coachingOrders.find({ customerId: userId, status: { $in: ["awaiting_payment", "confirmed"] } }).sort({ firstAt: 1, _id: 1 }).limit(100).toArray();
        const batches = await db().coachingBatches.find({ _id: { $in: docs.map((d) => d.batchId) } }, { projection: { lastEndsAt: 1 } }).toArray();
        const current = docs.filter((d) => {
          const end = d.kind === "demo" ? d.firstEndsAt : batches.find((b) => b._id.equals(d.batchId))?.lastEndsAt;
          return !end || end > now;
        });
        return page(request, await orderViews(app, db(), request, await freshOrders(app, db(), current)), null);
      }
      const { items, nextCursor } = await findPage(db().coachingOrders, {
        filter: { customerId: userId, $or: [{ firstEndsAt: { $lte: now } }, { status: "cancelled" }] },
        sortField: "createdAt",
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      return page(request, await orderViews(app, db(), request, await freshOrders(app, db(), items)), nextCursor);
    },
  );

  app.get(
    "/orders/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["coaching"],
        summary: "One enrolment or demo class: every class, attendance, the join link, the certificate and invoices",
        description: "While it waits for payment, Cashfree is asked whether it was paid.",
        params: IdParams,
        response: { 200: CoachingOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const order = await syncCoachingPayment(app, db(), await mine(request.auth!.userId, request.params.id));
      const [fresh] = await freshOrders(app, db(), [order]);
      return ok(request, (await orderViews(app, db(), request, [fresh!]))[0]!);
    },
  );

  app.post(
    "/orders/:id/pay",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["coaching"],
        summary: "A fresh checkout link for an enrolment waiting for payment",
        params: IdParams,
        body: PayBody,
        response: { 200: CheckoutLinkOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const back = safeReturn(app, request.body.returnTo);
      const order = await syncCoachingPayment(app, db(), await mine(request.auth!.userId, request.params.id));
      if (order.status !== "awaiting_payment") throw new AppError("ORDER_STATE", order.status === "confirmed" ? "This is paid." : "This was cancelled.");
      return ok(request, { checkoutUrl: coachingCheckoutUrl(app, request, order, back) });
    },
  );

  app.post(
    "/orders/:id/cancel",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["coaching"],
        summary: "Cancel an enrolment or demo class",
        description: "Unpaid: the place goes back. Paid: a full refund, platform fee included, until the first class it covers starts. No refunds after that.",
        params: IdParams,
        response: { 200: CoachingOrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const order = await mine(request.auth!.userId, request.params.id);
      if (order.status === "cancelled") throw new AppError("ORDER_STATE", "This is cancelled already.");
      const done = await cancelOrder(
        app,
        db(),
        order,
        { kind: "customer", actor: actorOf(request), ip: request.ip },
        { reason: order.status === "confirmed" ? "You cancelled it." : "You cancelled before paying." },
      );
      return ok(request, (await orderViews(app, db(), request, [done]))[0]!);
    },
  );

  app.get(
    "/orders/:id/materials",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["coaching"],
        summary: "Notes, files and links for an enrolment, newest first",
        description: "For paid enrolments. File links work for 10 minutes; ask again for fresh ones.",
        params: IdParams,
        response: { 200: MaterialList, ...Errors },
        security,
      },
    },
    async (request) => {
      const order = await mine(request.auth!.userId, request.params.id);
      if (order.status !== "confirmed" || order.kind !== "batch") throw new AppError("FORBIDDEN", "Materials open once you're enrolled in the batch.");
      const docs = await db()
        .coachingMaterials.find({ courseId: order.courseId, $or: [{ batchId: order.batchId }, { batchId: null }] })
        .sort({ createdAt: -1 })
        .limit(200)
        .toArray();
      return page(request, docs.map(materialView(app, request)), null);
    },
  );

  app.get(
    "/orders/:id/messages",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["coaching"],
        summary: "Messages from the institute to the batch, newest first",
        params: IdParams,
        response: { 200: MessageList, ...Errors },
        security,
      },
    },
    async (request) => {
      const order = await mine(request.auth!.userId, request.params.id);
      if (order.status !== "confirmed") throw new AppError("FORBIDDEN", "Messages open once you're enrolled.");
      const docs = await db()
        .coachingMessages.find({ batchId: order.batchId, ...(order.kind === "demo" ? { at: { $gte: order.createdAt } } : {}) })
        .sort({ at: -1 })
        .limit(100)
        .toArray();
      return page(
        request,
        docs.map((m) => ({ id: m._id.toHexString(), text: m.text, author: m.authorName, at: m.at.toISOString() })),
        null,
      );
    },
  );

  app.get(
    "/timetable",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["coaching"],
        summary: "Your and your children's classes, day by day",
        description: "Paid enrolments and demos, from `from` (today by default) for `days` days, cancelled classes included so you see what changed.",
        querystring: TimetableQuery,
        response: { 200: Timetable, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const from = request.query.from ?? dayOf(new Date());
      const start = atTime(from, "00:00");
      const end = atTime(addDays(from, request.query.days ?? 7), "00:00");
      const orders = await db().coachingOrders.find({ customerId: userId, status: "confirmed" }).limit(200).toArray();
      if (!orders.length) return page(request, [], null);
      const batchOrders = orders.filter((o) => o.kind === "batch");
      const demoOrders = orders.filter((o) => o.kind === "demo");
      const [sessions, courses, batches, settings] = await Promise.all([
        db()
          .coachingSessions.find({
            startsAt: { $gte: start, $lt: end },
            $or: [{ batchId: { $in: batchOrders.map((o) => o.batchId) } }, { _id: { $in: demoOrders.map((o) => o.sessionId!) } }],
          })
          .sort({ startsAt: 1 })
          .limit(500)
          .toArray(),
        db().coachingCourses.find({ _id: { $in: orders.map((o) => o.courseId) } }, { projection: { title: 1, mode: 1 } }).toArray(),
        db().coachingBatches.find({ _id: { $in: orders.map((o) => o.batchId) } }, { projection: { onlineLink: 1 } }).toArray(),
        coachingSettings(db()),
      ]);
      const marks = await db()
        .coachingAttendance.find({ sessionId: { $in: sessions.map((s) => s._id) }, orderId: { $in: orders.map((o) => o._id) } })
        .toArray();
      const now = new Date();
      const rows = sessions.flatMap((s) =>
        orders
          .filter((o) => (o.kind === "demo" ? o.sessionId?.equals(s._id) : o.batchId.equals(s.batchId)))
          .map((o) => {
            const course = courses.find((c) => c._id.equals(o.courseId));
            const onlineLink = course?.mode === "online" ? (batches.find((b) => b._id.equals(o.batchId))?.onlineLink ?? null) : null;
            return {
              orderId: o._id.toHexString(),
              kind: o.kind,
              student: { childId: o.student.childId?.toHexString() ?? null, name: o.student.name },
              course: { id: o.courseId.toHexString(), title: course?.title ?? o.courseTitle, mode: course?.mode ?? ("offline" as const) },
              batchName: o.batchName,
              business: o.businessName,
              class: classView(s, {
                mark: marks.find((m) => m.sessionId.equals(s._id) && m.orderId.equals(o._id))?.present ?? null,
                onlineLink,
                joinMinutes: settings.joinMinutes,
                confirmed: true,
                now,
              }),
            };
          }),
      );
      return page(request, rows, null);
    },
  );

  app.get(
    "/certificates",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["coaching"],
        summary: "Certificates you and your children have earned, newest first",
        description: "Each `pdfUrl` works for 10 minutes; ask again for fresh ones.",
        response: { 200: CertificateList, ...Errors },
        security,
      },
    },
    async (request) => {
      const docs = await db().coachingCertificates.find({ customerId: request.auth!.userId }).sort({ issuedAt: -1 }).limit(200).toArray();
      const link = coachingFileLinks(app, request);
      return page(
        request,
        docs.map((c) => ({
          id: c._id.toHexString(),
          code: c.code,
          issuedAt: c.issuedAt.toISOString(),
          pdfUrl: link("certificate", c._id.toHexString()),
          orderId: c.orderId.toHexString(),
          studentName: c.studentName,
          courseTitle: c.courseTitle,
          batchName: c.batchName,
          businessName: c.businessName,
          attended: c.attended,
          classes: c.classes,
        })),
        null,
      );
    },
  );

  // Children, who a parent enrols as students.

  const childView = async (child: { _id: ObjectId; name: string; birthYear: number | null }) => ({
    id: child._id.toHexString(),
    name: child.name,
    birthYear: child.birthYear,
    enrolments: await db().coachingOrders.countDocuments({ "student.childId": child._id, status: { $in: ["awaiting_payment", "confirmed"] } }),
  });

  app.get(
    "/children",
    {
      preHandler: requireAuth,
      schema: { tags: ["coaching"], summary: "Your children, who you can enrol as students", response: { 200: ChildList, ...Errors }, security },
    },
    async (request) => {
      const docs = await db().coachingChildren.find({ parentId: request.auth!.userId }).sort({ createdAt: 1 }).toArray();
      return page(request, await Promise.all(docs.map(childView)), null);
    },
  );

  app.post(
    "/children",
    {
      preHandler: [requireAuth, idempotent],
      schema: {
        tags: ["coaching"],
        summary: "Add a child",
        description: `Up to ${MAX_CHILDREN}. Their name goes on their classes and certificates.`,
        body: ChildBody,
        response: { 201: ChildOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const parentId = request.auth!.userId;
      if ((await db().coachingChildren.countDocuments({ parentId })) >= MAX_CHILDREN) {
        throw new AppError("CONFLICT", `You can add up to ${MAX_CHILDREN} children.`);
      }
      const name = request.body.name.trim();
      if (await db().coachingChildren.findOne({ parentId, name: { $regex: `^${escapeRegex(name)}$`, $options: "i" } })) {
        throw new AppError("CONFLICT", `${name} is already on your account.`);
      }
      const doc = { _id: new ObjectId(), parentId, name, birthYear: request.body.birthYear, ...stamp() };
      await db().coachingChildren.insertOne(doc);
      return reply.status(201).send(ok(request, await childView(doc)));
    },
  );

  app.patch(
    "/children/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["coaching"],
        summary: "Change a child's name or birth year",
        description: "Classes already booked keep the name they were booked with.",
        params: IdParams,
        body: UpdateChildBody,
        response: { 200: ChildOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const set: { name?: string; birthYear?: number | null; updatedAt: Date } = { updatedAt: new Date() };
      if (request.body.name !== undefined) set.name = request.body.name.trim();
      if (request.body.birthYear !== undefined) set.birthYear = request.body.birthYear;
      const after = await db().coachingChildren.findOneAndUpdate(
        { _id: new ObjectId(request.params.id), parentId: request.auth!.userId },
        { $set: set },
        { returnDocument: "after" },
      );
      if (!after) throw new AppError("NOT_FOUND", "Child not found.");
      return ok(request, await childView(after));
    },
  );

  app.delete(
    "/children/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["coaching"],
        summary: "Remove a child",
        description: "Not while they have a class booked; their past classes and certificates stay.",
        params: IdParams,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const child = await db().coachingChildren.findOne({ _id: new ObjectId(request.params.id), parentId: request.auth!.userId });
      if (!child) throw new AppError("NOT_FOUND", "Child not found.");
      if ((await childView(child)).enrolments > 0) throw new AppError("CONFLICT", `${child.name} has classes booked. Cancel them first.`);
      await db().coachingChildren.deleteOne({ _id: child._id });
      return ok(request, { done: true as const });
    },
  );

  // A course, its batches, demos and enrolling.

  app.get(
    "/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["coaching"],
        summary: "One course: its batches with seats left, demo classes, the refund rule, and your enrolments in it",
        params: IdParams,
        response: { 200: CourseOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const course = await db().coachingCourses.findOne({ _id: new ObjectId(request.params.id) });
      const own = course?.vendorId.equals(userId);
      if (!course || (course.status === "draft" && !own)) throw new AppError("NOT_FOUND", "This course isn't on Ruxstar.");
      const business = await db().businesses.findOne({ _id: course.businessId }, { projection: { suspension: 1 } });
      if (business?.suspension && !own) throw new AppError("NOT_FOUND", "This course isn't on Ruxstar.");
      let batches = await db().coachingBatches.find({ courseId: course._id }).toArray();
      if (await catchUp(app, db(), batches)) batches = await db().coachingBatches.find({ courseId: course._id }).toArray();
      const now = new Date();
      const open = batches.filter((b) => isOpen(b, now));
      const recently = now.getTime() - 30 * DAY_MS;
      const shown = sortBatches(
        batches.filter((b) => b.status === "live" || (b.cancellation?.at.getTime() ?? 0) > recently),
        now,
      );
      const [settings, live, orders, demoSessions] = await Promise.all([
        coachingSettings(db()),
        isModuleLive(db(), "coaching"),
        db().coachingOrders.find({ courseId: course._id, customerId: userId }).sort({ createdAt: -1 }).limit(50).toArray(),
        course.demo
          ? db()
              .coachingSessions.find({
                batchId: { $in: batches.filter((b) => b.status === "live").map((b) => b._id) },
                status: "scheduled",
                startsAt: { $gt: now },
                demos: { $lt: course.demo.seats },
              })
              .sort({ startsAt: 1 })
              .limit(20)
              .toArray()
          : [],
      ]);
      const whyNot =
        course.status === "removed"
          ? "Ruxstar took this course down."
          : course.status === "draft"
            ? "This is your draft. Publish it to take students."
            : !live
              ? "Ruxstar isn't taking coaching enrolments right now."
              : own
                ? "This is your course."
                : !open.length
                  ? "No batch is taking enrolments right now."
                  : null;
      const detail: CourseDetail = {
        ...courseCard(course, open),
        description: course.description,
        venue: course.venue,
        certificatePercent: course.certificatePercent,
        batches: await batchViews(db(), shown),
        demoClasses: demoSessions.map((s) => ({
          sessionId: s._id.toHexString(),
          batchId: s.batchId.toHexString(),
          batchName: batches.find((b) => b._id.equals(s.batchId))?.name ?? "",
          startsAt: s.startsAt.toISOString(),
          endsAt: s.endsAt.toISOString(),
          seatsLeft: Math.max(0, course.demo!.seats - s.demos),
        })),
        refundRule: REFUND_RULE,
        platformFee: settings.platformFee,
        status: course.status,
        canEnrol: whyNot === null,
        whyNot,
        myOrders: orders.map((o) => ({
          id: o._id.toHexString(),
          orderNo: o.orderNo,
          kind: o.kind,
          status: o.status,
          student: { childId: o.student.childId?.toHexString() ?? null, name: o.student.name },
          batchId: o.batchId.toHexString(),
        })),
        demoTaken: orders
          .filter((o) => o.kind === "demo" && o.status !== "cancelled")
          .map((o) => ({ childId: o.student.childId?.toHexString() ?? null, name: o.student.name })),
      };
      if (!course.photo) {
        const shop = await db().businesses.findOne({ _id: course.businessId }, { projection: { photos: { $slice: 1 } } });
        detail.photo = photoView(shop?.photos?.[0]);
      }
      return ok(request, detail);
    },
  );

  app.get(
    "/batches/:id/offers",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["coaching"],
        summary: "Coupons that work on this batch's fee, best first",
        description: "With `code`, that code is checked too. Demo classes don't take coupons.",
        params: IdParams,
        querystring: OffersQuery,
        response: { 200: OffersOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const batch = await db().coachingBatches.findOne({ _id: new ObjectId(request.params.id), status: "live" });
      const course = batch ? await db().coachingCourses.findOne({ _id: batch.courseId, status: "live" }) : null;
      if (!batch || !course) throw new AppError("NOT_FOUND", "This batch isn't taking students.");
      if (batch.fee === 0) return ok(request, { offers: [], checked: null });
      const ctx = { module: "coaching" as const, shop: { id: course.businessId, name: course.businessName }, customerId: request.auth!.userId, items: batch.fee };
      const [offers, check] = await Promise.all([offersFor(db(), ctx), request.query.code ? checkCode(db(), request.query.code, ctx) : null]);
      return ok(request, {
        offers,
        checked: check ? { code: request.query.code!.trim().toUpperCase(), discount: check.discount, problem: check.problem } : null,
      });
    },
  );

  app.post(
    "/batches/:id/enrol",
    {
      preHandler: [requireAuth, idempotent],
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["coaching"],
        summary: "Enrol yourself or a child in a batch",
        description:
          "The whole batch fee is paid up front. Free batches are confirmed at once; paid ones return a checkout link and hold the seat for 20 minutes. " +
          "Enrolment closes when the first class starts.",
        params: IdParams,
        body: EnrolBody,
        response: { 201: PlacedOrder, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const database = db();
      const back = safeReturn(app, request.body.returnTo);
      const batch = await database.coachingBatches.findOne({ _id: new ObjectId(request.params.id) });
      if (!batch) throw new AppError("NOT_FOUND", "This batch isn't taking students.");
      const course = await database.coachingCourses.findOne({ _id: batch.courseId });
      await takingStudents(course);
      const order = await placeOrder(app, database, {
        kind: "batch",
        course: course!,
        batch,
        session: null,
        customer: await customerOf(request.auth!.userId),
        childId: request.body.student.childId,
        coupon: request.body.coupon,
      });
      const [view] = await orderViews(app, database, request, [order]);
      const checkoutUrl = order.status === "awaiting_payment" ? coachingCheckoutUrl(app, request, order, back) : null;
      return reply.status(201).send(ok(request, { order: view!, checkoutUrl }));
    },
  );

  app.post(
    "/:id/demo",
    {
      preHandler: [requireAuth, idempotent],
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["coaching"],
        summary: "Book a demo class for yourself or a child",
        description:
          "One demo per student per course, in any upcoming class with a demo place, and not once enrolled. Free demos are confirmed at once; " +
          "paid ones return a checkout link. Cancel before the class for a full refund; if the class is cancelled, it's refunded.",
        params: IdParams,
        body: DemoBody,
        response: { 201: PlacedOrder, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const database = db();
      const back = safeReturn(app, request.body.returnTo);
      const course = await database.coachingCourses.findOne({ _id: new ObjectId(request.params.id) });
      await takingStudents(course);
      const session = await database.coachingSessions.findOne({ _id: new ObjectId(request.body.sessionId), courseId: course!._id });
      if (!session) throw new AppError("ORDER_INVALID", "This class isn't on any more. Pick another.", [{ path: "body/sessionId", message: "Not found" }]);
      const batch = await database.coachingBatches.findOne({ _id: session.batchId });
      if (!batch) throw new AppError("NOT_FOUND", "This class isn't on any more.");
      const order = await placeOrder(app, database, {
        kind: "demo",
        course: course!,
        batch,
        session,
        customer: await customerOf(request.auth!.userId),
        childId: request.body.student.childId,
      });
      const [view] = await orderViews(app, database, request, [order]);
      const checkoutUrl = order.status === "awaiting_payment" ? coachingCheckoutUrl(app, request, order, back) : null;
      return reply.status(201).send(ok(request, { order: view!, checkoutUrl }));
    },
  );
};

export default coaching;
