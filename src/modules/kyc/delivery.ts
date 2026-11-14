import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { KycCaseDoc } from "../../platform/db.js";
import { ok } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { PRIVATE_PHOTO_MAX_BYTES, toPrivateJpeg } from "../../platform/private-photo.js";
import { deliveryPhotoKey, loadCase, openCase, overview } from "./cases.js";
import { DeliveryBody, DeliveryPhotoParams, LICENCE_PATTERN, OverviewResult, PLATE_PATTERN } from "./contracts.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const limit = (perMinutes: number, max: number) => ({ rateLimit: { max, timeWindow: perMinutes * 60_000 } });
const EDITABLE: KycCaseDoc["status"][] = ["in_progress", "rejected"];
const LICENCE = new RegExp(LICENCE_PATTERN);
const PLATE = new RegExp(PLATE_PATTERN);

const invalid = (path: string, message: string) => new AppError("VALIDATION_FAILED", message, [{ path, message }]);
/** Upper case, without spaces, dashes or dots, as the transport department writes them. */
export const tidyNumber = (value: string) => value.toUpperCase().replace(/[\s\-./]/g, "");

function guardEditable(doc: KycCaseDoc) {
  if (doc.status === "locked") throw new AppError("KYC_LOCKED");
  if (doc.status === "submitted") throw new AppError("CONFLICT", "This is with our team for review. We will tell you when it is done.");
  if (doc.status === "approved") throw new AppError("CONFLICT", "You can already deliver with Ruxstar.");
}

/**
 * Delivery partner verification (decision 57): the driving licence and the bike or scooter, on top of approved identity. The Ruxstar team
 * checks the photos by eye; once approved the person signs in to the Ruxstar Delivery app.
 */
const deliveryKyc: FastifyPluginAsyncTypebox = async (app) => {
  app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: PRIVATE_PHOTO_MAX_BYTES }, (_request, body, done) => done(null, body));
  const db = () => requireDatabase(app.db);

  /** The case, opened on first use, once identity is approved. */
  async function editable(userId: ObjectId) {
    const base = await loadCase(db(), userId, "base");
    if (base?.status !== "approved") throw new AppError("KYC_STEP_ORDER", "Verify your identity first.");
    const doc = await openCase(db(), userId, "delivery");
    guardEditable(doc);
    return doc;
  }

  const save = async (doc: KycCaseDoc, set: Record<string, unknown>) => {
    const res = await db().kycCases.updateOne(
      { _id: doc._id, status: { $in: EDITABLE } },
      { $set: { ...set, status: "in_progress", updatedAt: new Date() } },
    );
    if (res.matchedCount === 0) throw new AppError("CONFLICT");
  };

  app.patch(
    "/",
    {
      preHandler: requireAuth,
      config: limit(60, 30),
      schema: {
        tags: ["kyc"],
        summary: "Add your driving licence number and your vehicle",
        description:
          "Needs identity verification approved first. Send only what changes. Bikes and scooters only. One licence can verify only one account.",
        body: DeliveryBody,
        response: { 200: OverviewResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const doc = await editable(userId);
      const { licenceNumber, vehicleType, vehicleNumber } = request.body;
      const now = new Date();
      const set: Record<string, unknown> = {};
      if (licenceNumber !== undefined) {
        const number = tidyNumber(licenceNumber);
        if (!LICENCE.test(number)) throw invalid("body/licenceNumber", "Type the licence number as it is on the card, like TS09 20190001234.");
        const taken = await db().kycCases.findOne(
          { track: "delivery", "steps.licence.number": number, status: { $in: ["submitted", "approved"] }, userId: { $ne: userId } },
          { projection: { _id: 1 } },
        );
        if (taken) throw invalid("body/licenceNumber", "This licence is already used on another Ruxstar account.");
        set["steps.licence"] = { number, photo: doc.steps.licence?.photo ?? null, at: now };
      }
      if (vehicleType !== undefined || vehicleNumber !== undefined) {
        const number = vehicleNumber === undefined ? (doc.steps.vehicle?.number ?? null) : tidyNumber(vehicleNumber);
        if (number && !PLATE.test(number)) throw invalid("body/vehicleNumber", "Type the number plate, like TS09AB1234.");
        set["steps.vehicle"] = { type: vehicleType ?? doc.steps.vehicle?.type ?? null, number, photo: doc.steps.vehicle?.photo ?? null, at: now };
      }
      await save(doc, set);
      return ok(request, await overview(db(), userId));
    },
  );

  app.put(
    "/photos/:kind",
    {
      preHandler: requireAuth,
      config: limit(60, 20),
      schema: {
        tags: ["kyc"],
        summary: "Add the photo of your driving licence, or of your vehicle with its number plate",
        description:
          "Send the image itself with Content-Type image/jpeg, image/png or image/webp, up to 8 MB. It is kept privately for the Ruxstar team, " +
          "upright and without the camera's location, and replaces the one before.",
        consumes: ["image/jpeg", "image/png", "image/webp"],
        params: DeliveryPhotoParams,
        response: { 200: OverviewResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const { kind } = request.params;
      const doc = await editable(userId);
      const jpeg = await toPrivateJpeg(request.body);
      const now = new Date();
      const key = deliveryPhotoKey(userId, kind, now);
      await app.printFiles.save(key, jpeg, "image/jpeg", { keep: true });
      const before = doc.steps[kind];
      const photo = { key, bytes: jpeg.length };
      try {
        await save(
          doc,
          kind === "licence"
            ? { "steps.licence": { number: doc.steps.licence?.number ?? null, photo, at: now } }
            : { "steps.vehicle": { type: doc.steps.vehicle?.type ?? null, number: doc.steps.vehicle?.number ?? null, photo, at: now } },
        );
      } catch (err) {
        await app.printFiles.remove(key);
        throw err;
      }
      if (before?.photo) await app.printFiles.remove(before.photo.key);
      return ok(request, await overview(db(), userId));
    },
  );

  app.post(
    "/submit",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["kyc"],
        summary: "Send delivery verification for review",
        description: "Needs the licence number and photo, and the vehicle's type, number and photo. The Ruxstar team checks the photos.",
        response: { 200: OverviewResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const doc = await editable(userId);
      const { licence, vehicle } = doc.steps;
      if (!licence?.number || !licence.photo) throw new AppError("KYC_STEP_ORDER", "Add your licence number and a photo of the licence.");
      if (!vehicle?.type || !vehicle.number || !vehicle.photo) {
        throw new AppError("KYC_STEP_ORDER", "Add your vehicle's type, its number and a photo showing the number plate.");
      }
      const database = db();
      await database.transaction(async (session) => {
        const now = new Date();
        const res = await database.kycCases.updateOne(
          { _id: doc._id, status: { $in: EDITABLE } },
          { $set: { status: "submitted", submittedAt: now, updatedAt: now } },
          { session },
        );
        if (res.matchedCount === 0) throw new AppError("CONFLICT");
        await database.users.updateOne({ _id: userId }, { $set: { "kyc.delivery": "pending", updatedAt: now } }, { session });
      });
      app.authCache.forget(userId);
      return ok(request, await overview(db(), userId));
    },
  );
};

export default deliveryKyc;
