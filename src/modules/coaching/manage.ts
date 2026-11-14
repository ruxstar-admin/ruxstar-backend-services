import { randomUUID } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type Filter, type WithId } from "mongodb";
import type { Static } from "typebox";
import { Errors } from "../../contracts/common.js";
import { actorOf, diffOf, writeAudit } from "../../platform/audit.js";
import { requireDatabase } from "../../platform/context.js";
import {
  stamp,
  type BusinessPhoto,
  type CoachingBatchDoc,
  type CoachingCourseDoc,
  type CoachingOrderDoc,
  type CoachingRules,
  type CoachingSessionDoc,
  type Database,
} from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { isModuleLive } from "../../platform/module-switch.js";
import { findPage } from "../../platform/pagination.js";
import { notifyCoaching } from "../notifications/notify.js";
import { Done } from "../social/contracts.js";
import { toPostPhoto } from "../social/photos.js";
import { ownedBy, photoKeys, requireVendor } from "../vendor/businesses.js";
import {
  BusinessCoursesParams,
  CancelBody,
  CreateBatchBody,
  CreateCourseBody,
  IdParams,
  StudentList,
  StudentsQuery,
  UpdateBatchBody,
  UpdateCourseBody,
  VendorCourseList,
  VendorCourseOne,
  type StudentRow,
} from "./contracts.js";
import { cancelBatch, orderLink } from "./orders.js";
import { addDays, coachingSettings, dayOf, MAX_AHEAD_DAYS, planClasses, slotClash, vendorShare } from "./rules.js";
import { missingOf, vendorCourseViews } from "./views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const invalid = (path: string, message: string) => new AppError("VALIDATION_FAILED", message, [{ path, message }]);
const by = (request: FastifyRequest) => ({ actor: actorOf(request), ip: request.ip });

type CourseFields = Static<typeof CreateCourseBody>;
type BatchFields = Static<typeof CreateBatchBody>;
type ShapedCourse = Pick<CoachingCourseDoc, "title" | "description" | "category" | "mode" | "venue" | "city" | "demo" | "certificatePercent">;

/** Checks a course's details against Ruxstar's limits. The mode is fixed once the course has a batch. */
export function shapeCourse(body: CourseFields, rules: CoachingRules, before: CoachingCourseDoc | null, hasBatches: boolean): ShapedCourse {
  if (before && hasBatches && body.mode !== before.mode) throw invalid("body/mode", "The course has batches, so it can't switch between online and in person.");
  if (body.mode === "online" && body.venue) throw invalid("body/venue", "Online courses don't have a venue. Add the meeting link to each batch.");
  if (body.demo && body.demo.fee > rules.maxDemoFee) throw invalid("body/demo/fee", `A demo class costs up to ₹${rules.maxDemoFee / 100}.`);
  if (body.demo && body.demo.seats > rules.maxDemoSeats) throw invalid("body/demo/seats", `Up to ${rules.maxDemoSeats} demo students in one class.`);
  const venue = body.venue
    ? { name: body.venue.name.trim(), address: body.venue.address.trim(), city: body.venue.city.trim(), point: body.venue.point ?? null }
    : null;
  return {
    title: body.title.trim(),
    description: body.description?.trim() || null,
    category: body.category,
    mode: body.mode,
    venue,
    city: venue ? venue.city.toLowerCase() : null,
    demo: body.demo ?? null,
    certificatePercent: body.certificatePercent ?? before?.certificatePercent ?? rules.certificatePercent,
  };
}

const courseFieldsOf = (doc: CoachingCourseDoc): CourseFields => ({
  title: doc.title,
  description: doc.description,
  category: doc.category,
  mode: doc.mode,
  venue: doc.venue,
  demo: doc.demo,
  certificatePercent: doc.certificatePercent,
});

const batchFieldsOf = (doc: CoachingBatchDoc): BatchFields => ({
  name: doc.name,
  fee: doc.fee,
  capacity: doc.capacity,
  minStudents: doc.minStudents,
  slots: doc.slots,
  startDate: doc.startDate,
  classes: doc.classes,
  endDate: doc.endDate,
  onlineLink: doc.onlineLink,
  coachIds: doc.coachIds.map((id) => id.toHexString()),
});

const SCHEDULE: (keyof BatchFields)[] = ["slots", "startDate", "classes", "endDate"];

/** Checks a batch against the course and Ruxstar's limits, and works out its classes when the schedule is new or changed. */
async function shapeBatch(
  db: Database,
  body: BatchFields,
  course: CoachingCourseDoc,
  rules: CoachingRules,
  before: CoachingBatchDoc | null,
  { taken, now }: { taken: number; now: Date },
) {
  if (body.capacity > rules.maxBatchSize) throw invalid("body/capacity", `A batch has up to ${rules.maxBatchSize} students.`);
  if (body.capacity < taken) throw invalid("body/capacity", `${taken} seats are taken or held, so it can't go below that.`);
  if (body.minStudents !== null && body.minStudents > body.capacity) throw invalid("body/minStudents", "The minimum can't be more than the capacity.");
  if (course.mode === "online" && !body.onlineLink) throw invalid("body/onlineLink", "Add the meeting link for online classes.");
  if (course.mode === "offline" && body.onlineLink) throw invalid("body/onlineLink", "Only online courses have a meeting link.");
  const coachIds = body.coachIds.map((id) => new ObjectId(id));
  if (coachIds.length) {
    const places = await db.employments
      .find({ businessId: course.businessId, userId: { $in: coachIds }, status: "active", current: true, permissions: "classes.view" }, { projection: { userId: 1 } })
      .toArray();
    body.coachIds.forEach((id, i) => {
      if (!places.some((p) => p.userId.toHexString() === id)) {
        throw invalid(`body/coachIds/${i}`, "Add them to your team with “See their batches and students” first.");
      }
    });
  }

  const scheduleChanged = !before || SCHEDULE.some((k) => JSON.stringify(body[k]) !== JSON.stringify(batchFieldsOf(before)[k]));
  let classes: { startsAt: Date; endsAt: Date }[] | null = null;
  if (scheduleChanged) {
    if ((body.classes === null) === (body.endDate === null)) throw invalid("body/classes", "Give the number of classes or the last day, not both.");
    const today = dayOf(now);
    if (body.startDate < today) throw invalid("body/startDate", "Pick a start date from today on.");
    if (body.startDate > addDays(today, MAX_AHEAD_DAYS)) throw invalid("body/startDate", "Pick a start date within a year.");
    if (body.endDate && body.endDate < body.startDate) throw invalid("body/endDate", "The last day can't be before the start date.");
    if (body.endDate && body.endDate > addDays(body.startDate, MAX_AHEAD_DAYS)) throw invalid("body/endDate", "A batch runs for up to a year.");
    if (body.classes !== null && body.classes > rules.maxClasses) throw invalid("body/classes", `A batch has up to ${rules.maxClasses} classes.`);
    const clash = slotClash(body.slots);
    if (clash) throw invalid(`body/slots/${clash[1]}`, "Two class times on the same day overlap.");
    classes = planClasses(body, rules.maxClasses);
    if (!classes.length) throw invalid("body/slots", "No class falls on those days between those dates.");
    if (classes.length > rules.maxClasses) throw invalid("body/endDate", `A batch has up to ${rules.maxClasses} classes; this schedule gives more.`);
    if (classes[0]!.startsAt <= now) throw invalid("body/startDate", "The first class must be in the future.");
  }
  const shaped = {
    name: body.name.trim(),
    fee: body.fee,
    capacity: body.capacity,
    minStudents: body.minStudents,
    slots: body.slots,
    startDate: body.startDate,
    classes: body.classes,
    endDate: body.endDate,
    onlineLink: body.onlineLink?.trim() ?? null,
    coachIds,
  };
  return { shaped, classes };
}

const sessionsOf = (batch: Pick<CoachingBatchDoc, "_id" | "courseId" | "businessId">, classes: { startsAt: Date; endsAt: Date }[], now: Date): CoachingSessionDoc[] =>
  classes.map((c) => ({
    _id: new ObjectId(),
    batchId: batch._id,
    courseId: batch.courseId,
    businessId: batch.businessId,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    status: "scheduled",
    extra: false,
    movedFrom: null,
    cancellation: null,
    demos: 0,
    markedAt: null,
    ...stamp(now),
  }));

const datesOf = (classes: { startsAt: Date; endsAt: Date }[]) => ({
  firstAt: classes[0]!.startsAt,
  firstEndsAt: classes[0]!.endsAt,
  lastEndsAt: classes.reduce((latest, c) => (c.endsAt > latest ? c.endsAt : latest), classes[0]!.endsAt),
});

/** A coaching business's courses and batches, and who's enrolled. Only the owner manages them; coaches work from /v1/coaching/desk. */
const manage: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  async function business(request: FastifyRequest, id: string | ObjectId) {
    const doc = await db().businesses.findOne(ownedBy(new ObjectId(id), request.auth!.userId));
    if (!doc) throw new AppError("NOT_FOUND", "Business not found.");
    if (doc.module !== "coaching") throw new AppError("CONFLICT", "Courses are for coaching businesses.");
    return doc;
  }
  async function owned(request: FastifyRequest, id: string, { editing = true } = {}) {
    const doc = await db().coachingCourses.findOne({ _id: new ObjectId(id), vendorId: request.auth!.userId });
    if (!doc) throw new AppError("NOT_FOUND", "Course not found.");
    if (editing) {
      const shop = await db().businesses.findOne({ _id: doc.businessId }, { projection: { suspension: 1 } });
      if (shop?.suspension) throw new AppError("BUSINESS_SUSPENDED");
      if (doc.status === "removed") throw new AppError("CONFLICT", "Ruxstar took this course down.");
    }
    return doc;
  }
  async function ownedBatch(request: FastifyRequest, id: string) {
    const batch = await db().coachingBatches.findOne({ _id: new ObjectId(id), vendorId: request.auth!.userId });
    if (!batch) throw new AppError("NOT_FOUND", "Batch not found.");
    const course = await owned(request, batch.courseId.toHexString());
    if (batch.status === "cancelled") throw new AppError("CONFLICT", "This batch is cancelled.");
    return { batch, course };
  }
  async function view(course: WithId<CoachingCourseDoc>) {
    const shop = await db().businesses.findOne({ _id: course.businessId }, { projection: { status: 1 } });
    return (await vendorCourseViews(db(), [course], () => shop?.status === "live"))[0]!;
  }
  const audit = (request: FastifyRequest, course: CoachingCourseDoc, action: string, target: { type: string; id: ObjectId }, diff: Record<string, { from: unknown; to: unknown }>) =>
    writeAudit(db(), { ...by(request), scope: { module: "coaching", businessId: course.businessId }, action, target, diff });

  async function tellStudents(request: FastifyRequest, filter: Filter<CoachingOrderDoc>, title: string, body: string) {
    const orders = await db().coachingOrders.find({ ...filter, status: "confirmed" }, { projection: { customerId: 1 } }).toArray();
    await notifyCoaching(db(), request.log, {
      actor: request.auth!.userId,
      type: "coaching.updated",
      title,
      body,
      to: orders.map((o) => ({ userId: o.customerId, link: orderLink(o) })),
    });
  }

  app.get(
    "/businesses/:id/courses",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "A coaching business's courses, newest first, with batches, students and money",
        params: BusinessCoursesParams,
        response: { 200: VendorCourseList, ...Errors },
        security,
      },
    },
    async (request) => {
      const shop = await business(request, request.params.id);
      const docs = await db().coachingCourses.find({ businessId: shop._id }).sort({ createdAt: -1 }).limit(100).toArray();
      return page(request, await vendorCourseViews(db(), docs, () => shop.status === "live"), null);
    },
  );

  app.post(
    "/businesses/:id/courses",
    {
      preHandler: [requireVendor, idempotent],
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Make a course as a draft",
        description: "Add batches next, then publish it. Limits follow GET /v1/coaching/rules.",
        params: BusinessCoursesParams,
        body: CreateCourseBody,
        response: { 201: VendorCourseOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const shop = await business(request, request.params.id);
      if (shop.suspension) throw new AppError("BUSINESS_SUSPENDED");
      if (!(await isModuleLive(db(), "coaching"))) throw new AppError("MODULE_OFF");
      const doc: CoachingCourseDoc = {
        _id: new ObjectId(),
        businessId: shop._id,
        vendorId: shop.ownerId,
        businessName: shop.name,
        ...shapeCourse(request.body, await coachingSettings(db()), null, false),
        photo: null,
        status: "draft",
        publishedAt: null,
        removal: null,
        ...stamp(),
      };
      await db().coachingCourses.insertOne(doc);
      await audit(request, doc, "coaching_course.create", { type: "coaching_course", id: doc._id }, { title: { from: null, to: doc.title } });
      return reply.status(201).send(ok(request, await view(doc)));
    },
  );

  app.get(
    "/courses/:id",
    {
      preHandler: requireVendor,
      schema: { tags: ["vendor"], summary: "One of your courses, with its batches and money", params: IdParams, response: { 200: VendorCourseOne, ...Errors }, security },
    },
    async (request) => ok(request, await view(await owned(request, request.params.id, { editing: false }))),
  );

  app.patch(
    "/courses/:id",
    {
      preHandler: requireVendor,
      config: { rateLimit: { max: 60, timeWindow: 60 * 60_000 } },
      schema: { tags: ["vendor"], summary: "Change a course", params: IdParams, body: UpdateCourseBody, response: { 200: VendorCourseOne, ...Errors }, security },
    },
    async (request) => {
      const before = await owned(request, request.params.id);
      const hasBatches = (await db().coachingBatches.countDocuments({ courseId: before._id })) > 0;
      const shaped = shapeCourse({ ...courseFieldsOf(before), ...request.body } as CourseFields, await coachingSettings(db()), before, hasBatches);
      if (before.status === "live" && before.mode === "offline" && !shaped.venue) throw invalid("body/venue", "A live course needs its venue.");
      const diff = diffOf(before as unknown as Record<string, unknown>, shaped as unknown as Record<string, unknown>);
      if (!Object.keys(diff).length) return ok(request, await view(before));
      const after = await db().coachingCourses.findOneAndUpdate({ _id: before._id }, { $set: { ...shaped, updatedAt: new Date() } }, { returnDocument: "after" });
      await audit(request, before, "coaching_course.update", { type: "coaching_course", id: before._id }, diff);
      if (after!.title !== before.title) {
        await db().coachingOrders.updateMany({ courseId: before._id, status: { $ne: "cancelled" } }, { $set: { courseTitle: after!.title } });
      }
      if (after!.status === "live" && JSON.stringify(after!.venue) !== JSON.stringify(before.venue) && after!.venue) {
        await tellStudents(request, { courseId: before._id }, `New venue: ${after!.title}`, `Classes are now at ${after!.venue.name}, ${after!.venue.address}.`);
      }
      return ok(request, await view(after!));
    },
  );

  app.post(
    "/courses/:id/photo",
    {
      preHandler: requireVendor,
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Set the course's photo",
        description: "Send the image itself with Content-Type image/jpeg, image/png or image/webp, up to 8 MB. It replaces the one there was.",
        consumes: ["image/jpeg", "image/png", "image/webp"],
        params: IdParams,
        response: { 200: VendorCourseOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const course = await owned(request, request.params.id);
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw new AppError("PHOTO_INVALID");
      const { full, smaller } = await toPostPhoto(request.body);
      const id = randomUUID();
      const base = `coaching-media/${app.config.env}/${course._id.toHexString()}/${id}`;
      const save = async (file: typeof full, suffix: string) => {
        const key = `${base}${suffix}.webp`;
        return { key, url: await app.media.save(key, file.data), width: file.width, height: file.height };
      };
      const [saved, ...copies] = await Promise.all([save(full, ""), ...smaller.map((file) => save(file, `-${file.width}w`))]);
      const photo: BusinessPhoto = { id, ...saved!, smaller: copies };
      const after = await db().coachingCourses.findOneAndUpdate({ _id: course._id }, { $set: { photo, updatedAt: new Date() } }, { returnDocument: "after" });
      if (course.photo) await Promise.all(photoKeys(course.photo).map((key) => app.media.remove(key)));
      return ok(request, await view(after!));
    },
  );

  app.post(
    "/courses/:id/publish",
    {
      preHandler: [requireVendor, idempotent],
      schema: {
        tags: ["vendor"],
        summary: "Put a draft course up for enrolment",
        description: "Needs the business published, the venue for an in-person course, and a batch whose first class is in the future. Everything missing comes back at once.",
        params: IdParams,
        response: { 200: VendorCourseOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const course = await owned(request, request.params.id);
      if (course.status !== "draft") throw new AppError("CONFLICT", "This course is published already.");
      const shop = await db().businesses.findOne({ _id: course.businessId });
      const batches = await db().coachingBatches.find({ courseId: course._id }).toArray();
      const missing = missingOf(course, batches, shop?.status === "live");
      if (missing.length) throw new AppError("BUSINESS_INCOMPLETE", missing.join(". "), missing.map((message) => ({ path: "body", message })));
      if (!(await isModuleLive(db(), "coaching"))) throw new AppError("MODULE_OFF");
      const now = new Date();
      const after = await db().coachingCourses.findOneAndUpdate(
        { _id: course._id, status: "draft" },
        { $set: { status: "live", publishedAt: now, businessName: shop!.name, updatedAt: now } },
        { returnDocument: "after" },
      );
      if (!after) throw new AppError("CONFLICT");
      await audit(request, course, "coaching_course.publish", { type: "coaching_course", id: course._id }, { status: { from: "draft", to: "live" } });
      return ok(request, await view(after));
    },
  );

  app.delete(
    "/courses/:id",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Delete a draft course, with its batches and materials",
        description: "Published courses stay; cancel their batches instead.",
        params: IdParams,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const course = await owned(request, request.params.id, { editing: false });
      if (course.status !== "draft") throw new AppError("CONFLICT", "Only drafts can be deleted. Cancel its batches instead.");
      if (await db().coachingOrders.findOne({ courseId: course._id }, { projection: { _id: 1 } })) throw new AppError("CONFLICT", "This course has had students, so it stays.");
      const res = await db().coachingCourses.deleteOne({ _id: course._id, status: "draft" });
      if (!res.deletedCount) throw new AppError("CONFLICT");
      const files = await db().coachingMaterials.find({ courseId: course._id, file: { $ne: null } }, { projection: { file: 1 } }).toArray();
      await Promise.all([
        db().coachingBatches.deleteMany({ courseId: course._id }),
        db().coachingSessions.deleteMany({ courseId: course._id }),
        db().coachingMaterials.deleteMany({ courseId: course._id }),
      ]);
      await Promise.all(files.map((m) => app.printFiles.remove(m.file!.key)));
      if (course.photo) await Promise.all(photoKeys(course.photo).map((key) => app.media.remove(key)));
      return ok(request, { done: true as const });
    },
  );

  // Batches.

  app.post(
    "/courses/:id/batches",
    {
      preHandler: [requireVendor, idempotent],
      config: { rateLimit: { max: 60, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Add a batch: its fee, seats and weekly schedule",
        description:
          "Classes are made from the weekly slots, from the start date for `classes` classes or until `endDate`. On a live course it takes students at once.",
        params: IdParams,
        body: CreateBatchBody,
        response: { 201: VendorCourseOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const course = await owned(request, request.params.id);
      const rules = await coachingSettings(db());
      const now = new Date();
      if ((await db().coachingBatches.countDocuments({ courseId: course._id, status: "live", lastEndsAt: { $gt: now } })) >= rules.maxBatches) {
        throw new AppError("CONFLICT", `A course has up to ${rules.maxBatches} batches running or to come.`);
      }
      const { shaped, classes } = await shapeBatch(db(), request.body, course, rules, null, { taken: 0, now });
      const batch: CoachingBatchDoc = {
        _id: new ObjectId(),
        courseId: course._id,
        businessId: course.businessId,
        vendorId: course.vendorId,
        ...shaped,
        seatsLeft: shaped.capacity,
        minimumCheckedAt: null,
        ...datesOf(classes!),
        status: "live",
        cancellation: null,
        certificatesAt: null,
        ...stamp(now),
      };
      await db().coachingBatches.insertOne(batch);
      await db().coachingSessions.insertMany(sessionsOf(batch, classes!, now));
      await audit(request, course, "coaching_batch.create", { type: "coaching_batch", id: batch._id }, { name: { from: null, to: batch.name } });
      return reply.status(201).send(ok(request, await view(course)));
    },
  );

  app.patch(
    "/batches/:id",
    {
      preHandler: requireVendor,
      config: { rateLimit: { max: 60, timeWindow: 60 * 60_000 } },
      schema: { tags: ["vendor"], summary: "Change a batch", params: IdParams, body: UpdateBatchBody, response: { 200: VendorCourseOne, ...Errors }, security },
    },
    async (request) => {
      const { batch: before, course } = await ownedBatch(request, request.params.id);
      const now = new Date();
      const rules = await coachingSettings(db());
      const merged = { ...batchFieldsOf(before), ...request.body } as BatchFields;
      const touchesSchedule = SCHEDULE.some((k) => k in request.body && JSON.stringify(merged[k]) !== JSON.stringify(batchFieldsOf(before)[k]));
      if (touchesSchedule) {
        if (before.firstAt <= now) throw new AppError("CONFLICT", "The batch has started. Move, cancel or add single classes instead.");
        const anyone = await db().coachingOrders.findOne({ batchId: before._id, status: { $in: ["awaiting_payment", "confirmed"] } }, { projection: { _id: 1 } });
        if (anyone) throw new AppError("CONFLICT", "Students have enrolled or booked demos, so the schedule is fixed. Move, cancel or add single classes instead.");
      }
      const { shaped, classes } = await shapeBatch(db(), merged, course, rules, before, { taken: before.capacity - before.seatsLeft, now });
      const diff = diffOf(batchFieldsOf(before) as unknown as Record<string, unknown>, { ...shaped, coachIds: shaped.coachIds.map(String) } as unknown as Record<string, unknown>);
      if (!Object.keys(diff).length) return ok(request, await view(course));
      const set: Partial<CoachingBatchDoc> = { ...shaped, updatedAt: now, ...(classes ? datesOf(classes) : {}) };
      // Enrolments change the seats left, so capacity lands on the count as it was read.
      const after = await db().coachingBatches.findOneAndUpdate(
        { _id: before._id, status: "live", seatsLeft: before.seatsLeft },
        { $set: { ...set, seatsLeft: before.seatsLeft + (shaped.capacity - before.capacity) } },
        { returnDocument: "after" },
      );
      if (!after) throw new AppError("CONFLICT", "Someone just enrolled. Check the numbers and save again.");
      if (classes) {
        await db().coachingSessions.deleteMany({ batchId: before._id });
        await db().coachingSessions.insertMany(sessionsOf(after, classes, now));
      }
      await audit(request, course, "coaching_batch.update", { type: "coaching_batch", id: before._id }, diff);
      if (after.name !== before.name) await db().coachingOrders.updateMany({ batchId: before._id, status: { $ne: "cancelled" } }, { $set: { batchName: after.name } });
      if (after.onlineLink && after.onlineLink !== before.onlineLink) {
        await tellStudents(request, { batchId: before._id }, `New class link: ${course.title}`, `${after.name} has a new meeting link. It shows on your classes shortly before each one.`);
      }
      return ok(request, await view(course));
    },
  );

  app.post(
    "/batches/:id/cancel",
    {
      preHandler: [requireVendor, idempotent],
      schema: {
        tags: ["vendor"],
        summary: "Cancel a whole batch before its first class",
        description: "Every student and demo student is refunded in full, platform fee included, and told why. Once classes have started, cancel single classes instead.",
        params: IdParams,
        body: CancelBody,
        response: { 200: VendorCourseOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { batch, course } = await ownedBatch(request, request.params.id);
      await cancelBatch(app, db(), batch, { kind: "vendor", ...by(request) }, request.body.reason.trim());
      return ok(request, await view(course));
    },
  );

  app.delete(
    "/batches/:id",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Delete a batch nobody has enrolled in",
        description: "One that has had students stays; cancel it instead.",
        params: IdParams,
        response: { 200: VendorCourseOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { batch, course } = await ownedBatch(request, request.params.id);
      if (await db().coachingOrders.findOne({ batchId: batch._id }, { projection: { _id: 1 } })) throw new AppError("CONFLICT", "This batch has had students. Cancel it instead.");
      const res = await db().coachingBatches.deleteOne({ _id: batch._id, seatsLeft: batch.capacity });
      if (!res.deletedCount) throw new AppError("CONFLICT");
      await db().coachingSessions.deleteMany({ batchId: batch._id });
      await audit(request, course, "coaching_batch.delete", { type: "coaching_batch", id: batch._id }, { name: { from: batch.name, to: null } });
      return ok(request, await view(course));
    },
  );

  app.get(
    "/courses/:id/students",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Who enrolled or booked a demo, newest first",
        description: "With `kind=demo`, demo class bookings only. Each row has the parent's contact, the money and attendance so far.",
        params: IdParams,
        querystring: StudentsQuery,
        response: { 200: StudentList, ...Errors },
        security,
      },
    },
    async (request) => {
      const course = await owned(request, request.params.id, { editing: false });
      const { batchId, kind, status, cursor, limit } = request.query;
      const filter: Filter<CoachingOrderDoc> = { courseId: course._id, status: status ?? { $in: ["confirmed", "cancelled"] } };
      if (batchId) filter.batchId = new ObjectId(batchId);
      if (kind) filter.kind = kind;
      const { items, nextCursor } = await findPage(db().coachingOrders, { filter, sortField: "createdAt", cursor, limit });
      const now = new Date();
      const [parents, batches, held, sessions] = await Promise.all([
        db().users.find({ _id: { $in: items.map((o) => o.customerId) } }, { projection: { name: 1, username: 1, phone: 1 } }).toArray(),
        db().coachingBatches.find({ _id: { $in: items.map((o) => o.batchId) } }, { projection: { name: 1 } }).toArray(),
        db()
          .coachingSessions.find({ batchId: { $in: items.map((o) => o.batchId) }, status: "scheduled", endsAt: { $lte: now } }, { projection: { batchId: 1 } })
          .toArray(),
        db()
          .coachingSessions.find({ _id: { $in: items.flatMap((o) => (o.sessionId ? [o.sessionId] : [])) } }, { projection: { startsAt: 1, endsAt: 1, status: 1 } })
          .toArray(),
      ]);
      const marks = await db().coachingAttendance.find({ orderId: { $in: items.map((o) => o._id) }, present: true }, { projection: { orderId: 1, sessionId: 1 } }).toArray();
      const rows = items.map((o): StudentRow => {
        const parent = parents.find((u) => u._id.equals(o.customerId));
        const demo = o.sessionId ? sessions.find((s) => s._id.equals(o.sessionId!)) : null;
        const heldIds = o.kind === "demo" ? (demo && demo.status === "scheduled" && demo.endsAt <= now ? [demo._id] : []) : held.filter((s) => s.batchId.equals(o.batchId)).map((s) => s._id);
        return {
          id: o._id.toHexString(),
          orderNo: o.orderNo,
          kind: o.kind,
          status: o.status,
          student: { name: o.student.name, child: o.student.childId !== null },
          parent: { id: o.customerId.toHexString(), name: parent?.name ?? parent?.username ?? "Customer", phone: o.status === "confirmed" ? (parent?.phone ?? null) : null },
          batch: { id: o.batchId.toHexString(), name: batches.find((b) => b._id.equals(o.batchId))?.name ?? o.batchName },
          demoAt: demo?.startsAt.toISOString() ?? null,
          total: o.price.total,
          share: o.status === "confirmed" ? vendorShare(o) : 0,
          refunded: o.refund?.amount ?? 0,
          attendance: { attended: marks.filter((m) => m.orderId.equals(o._id) && heldIds.some((id) => id.equals(m.sessionId))).length, held: heldIds.length },
          createdAt: o.createdAt.toISOString(),
        };
      });
      return page(request, rows, nextCursor);
    },
  );
};

export default manage;
