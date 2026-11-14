import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, writeAudit } from "../../platform/audit.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { PodProblemDoc, PodProblemKind } from "../../platform/db.js";
import { ok } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { toPrivateJpeg } from "../../platform/private-photo.js";
import { notifyOrder } from "../notifications/notify.js";
import { OrderOne, OrderParams, PROBLEM_PHOTO_MAX_BYTES, PROBLEM_PHOTOS_MAX, ProblemBody } from "./contracts.js";
import { applyDue } from "./order-rules.js";
import { canReport, orderView, photoLinks, problemPhotoKey } from "./orders.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

export const PROBLEM_LABELS: Record<PodProblemKind, string> = {
  not_received: "Not received",
  wrong_item: "Wrong print",
  poor_quality: "Poor print quality",
  damaged: "Arrived damaged",
  other: "Something else",
};

/** A customer tells Ruxstar something went wrong with an order. The shop's share waits until Ruxstar settles it. */
const problems: FastifyPluginAsyncTypebox = async (app) => {
  app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: PROBLEM_PHOTO_MAX_BYTES }, (_request, body, done) => done(null, body));
  const db = () => requireDatabase(app.db);

  const mine = async (userId: ObjectId, id: string) => {
    const doc = await db().podOrders.findOne({ _id: new ObjectId(id), customerId: userId });
    if (!doc) throw new AppError("NOT_FOUND", "Order not found.");
    return applyDue(app, db(), doc);
  };

  app.post(
    "/orders/:id/problem",
    {
      preHandler: [requireAuth, idempotent],
      config: { rateLimit: { max: 10, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["pod"],
        summary: "Report a problem with an order",
        description:
          "Within 48 hours of delivery, or any time after the ready date while it hasn't arrived. One report per order; add photos " +
          "after. The shop sees it, its share is held, and Ruxstar settles it with a refund or an answer.",
        params: OrderParams,
        body: ProblemBody,
        response: { 200: OrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const order = await mine(request.auth!.userId, request.params.id);
      if (order.problem) throw new AppError("CONFLICT", "You already reported a problem with this order.");
      if (!canReport(order)) throw new AppError("REPORT_CLOSED");
      const now = new Date();
      const problem: PodProblemDoc = {
        kind: request.body.kind,
        note: request.body.note.trim(),
        photos: [],
        status: "open",
        reportedAt: now,
        resolution: null,
      };
      const reported = await database.transaction(async (session) => {
        const after = await database.podOrders.findOneAndUpdate(
          { _id: order._id, status: order.status, problem: null, releasedAt: null },
          { $set: { problem, problemAt: now, updatedAt: now } },
          { session, returnDocument: "after" },
        );
        if (!after) return null;
        await writeAudit(
          database,
          {
            actor: actorOf(request),
            scope: { module: "pod", businessId: order.shopId },
            action: "pod_order.problem",
            target: { type: "pod_order", id: order._id },
            diff: { problem: { from: null, to: problem.kind } },
            ip: request.ip,
          },
          session,
        );
        return after;
      });
      if (!reported) throw new AppError("ORDER_STATE");
      await notifyOrder(database, app.log, {
        to: reported.vendorId,
        actor: reported.customerId,
        orderId: reported._id,
        type: "order.updated",
        forShop: true,
        title: `Problem reported: #${reported.orderNo}`,
        body: `${PROBLEM_LABELS[problem.kind]}. Ruxstar will look into it; your share is held until then.`,
      });
      return ok(request, orderView(reported, photoLinks(app, request)));
    },
  );

  app.post(
    "/orders/:id/problem/photos",
    {
      preHandler: [requireAuth, idempotent],
      config: { rateLimit: { max: 20, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["pod"],
        summary: "Add a photo to your problem report",
        description: `Send a JPEG, PNG or WebP up to 8 MB as the body, with its Content-Type. Up to ${PROBLEM_PHOTOS_MAX} photos, while Ruxstar hasn't settled it.`,
        params: OrderParams,
        response: { 200: OrderOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const data = request.body;
      if (!Buffer.isBuffer(data) || !data.length) throw new AppError("PHOTO_INVALID");
      const order = await mine(request.auth!.userId, request.params.id);
      if (order.problem?.status !== "open") throw new AppError("ORDER_STATE", "Report the problem first. Photos can't be added once Ruxstar has settled it.");
      if (order.problem.photos.length >= PROBLEM_PHOTOS_MAX) throw new AppError("CONFLICT", `Up to ${PROBLEM_PHOTOS_MAX} photos.`);
      const jpeg = await toPrivateJpeg(data);
      const id = new ObjectId();
      const key = problemPhotoKey(order._id, id);
      await app.printFiles.save(key, jpeg, "image/jpeg");
      const after = await db().podOrders.findOneAndUpdate(
        { _id: order._id, "problem.status": "open", [`problem.photos.${PROBLEM_PHOTOS_MAX - 1}`]: { $exists: false } },
        { $push: { "problem.photos": { id, key, bytes: jpeg.length } }, $set: { updatedAt: new Date() } },
        { returnDocument: "after" },
      );
      if (!after) {
        await app.printFiles.remove(key);
        throw new AppError("CONFLICT", `Up to ${PROBLEM_PHOTOS_MAX} photos, while the problem is open.`);
      }
      return ok(request, orderView(after, photoLinks(app, request)));
    },
  );
};

export default problems;
