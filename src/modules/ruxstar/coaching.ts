import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId, type Filter } from "mongodb";
import { Type } from "typebox";
import { Errors, ObjectIdString, PageQuery, Strict } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireRuxstar } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { CoachingCourseDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { escapeRegex } from "../pod/shops.js";
import { CourseCategory, VendorCourseList, VendorCourseOne } from "../coaching/contracts.js";
import { takeDownCourse } from "../coaching/orders.js";
import { vendorCourseViews } from "../coaching/views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const Query = Strict({
  ...PageQuery,
  status: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("live"), Type.Literal("removed")])),
  category: Type.Optional(CourseCategory),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "Words in the title or the institute's name" })),
});
const Params = Strict({ id: ObjectIdString });
const TakeDownBody = Strict({ reason: Type.String({ minLength: 5, maxLength: 300, description: "The institute and every enrolled student see it" }) });

/** Courses in the console. They go live without review; staff can take one down, which cancels its batches and refunds every student. */
const coaching: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const views = async (docs: CoachingCourseDoc[]) => {
    const live = await db()
      .businesses.find({ _id: { $in: docs.map((d) => d.businessId) }, status: "live" }, { projection: { _id: 1 } })
      .toArray();
    return vendorCourseViews(db(), docs, (id) => live.some((b) => b._id.equals(id)));
  };

  app.get(
    "/coaching/courses",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: { tags: ["ruxstar"], summary: "Every course, newest first", querystring: Query, response: { 200: VendorCourseList, ...Errors }, security },
    },
    async (request) => {
      const { status, category, q, cursor, limit } = request.query;
      const filter: Filter<CoachingCourseDoc> = {};
      if (status) filter.status = status;
      if (category) filter.category = category;
      if (q?.trim()) {
        const words = { $regex: escapeRegex(q.trim()), $options: "i" };
        filter.$or = [{ title: words }, { businessName: words }];
      }
      const { items, nextCursor } = await findPage(db().coachingCourses, { filter, sortField: "createdAt", cursor, limit });
      return page(request, await views(items), nextCursor);
    },
  );

  app.get(
    "/coaching/courses/:id",
    {
      preHandler: requireRuxstar("businesses.view"),
      schema: { tags: ["ruxstar"], summary: "One course, with its batches, students and money", params: Params, response: { 200: VendorCourseOne, ...Errors }, security },
    },
    async (request) => {
      const doc = await db().coachingCourses.findOne({ _id: new ObjectId(request.params.id) });
      if (!doc) throw new AppError("NOT_FOUND", "Course not found.");
      return ok(request, (await views([doc]))[0]!);
    },
  );

  app.post(
    "/coaching/courses/:id/take-down",
    {
      preHandler: [requireRuxstar("businesses.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Take a course down",
        description:
          "It leaves the listings and its batches are cancelled: every place not yet settled is refunded in full, and the institute and students are told why. " +
          "Places whose first class has happened are already paid out and aren't refunded automatically. It can't be undone.",
        params: Params,
        body: TakeDownBody,
        response: { 200: VendorCourseOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const doc = await db().coachingCourses.findOne({ _id: new ObjectId(request.params.id) });
      if (!doc) throw new AppError("NOT_FOUND", "Course not found.");
      await takeDownCourse(app, db(), doc, { kind: "staff", actor: actorOf(request), ip: request.ip }, request.body.reason.trim());
      return ok(request, (await views([(await db().coachingCourses.findOne({ _id: doc._id }))!]))[0]!);
    },
  );
};

export default coaching;
