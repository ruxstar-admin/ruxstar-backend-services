import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { KycCaseDoc } from "../../platform/db.js";
import { ok } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import {
  MAX_TRIES_PER_DAY,
  NAME_MATCHES,
  cardView,
  loadCase,
  maskPan,
  openCase,
  overview,
  panHash,
  triesToday,
  verificationId,
} from "./cases.js";
import { CardResult, DigilockerResult, OverviewResult, PanBody } from "./contracts.js";
import deliveryKyc from "./delivery.js";
import { SELFIE_MAX_BYTES, toSelfie } from "./selfie.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const limit = (perMinutes: number, max: number) => ({ rateLimit: { max, timeWindow: perMinutes * 60_000 } });
/** Steps can change only before submitting, or after a rejection. */
const EDITABLE: KycCaseDoc["status"][] = ["in_progress", "rejected"];

function guardEditable(doc: KycCaseDoc) {
  if (doc.status === "locked") throw new AppError("KYC_LOCKED");
  if (doc.status === "submitted") throw new AppError("CONFLICT", "This is with our team for review. We will tell you when it is done.");
  if (doc.status === "approved") throw new AppError("CONFLICT", "This is already verified.");
}

const tooMany = () =>
  new AppError("RATE_LIMITED", "Too many tries for this step today. Try again tomorrow.", [
    { message: "Daily limit reached", retryAfterSeconds: 24 * 60 * 60 },
  ]);

function checkTries(step?: { tries: number; at: Date }) {
  const tries = triesToday(step);
  if (tries >= MAX_TRIES_PER_DAY) throw tooMany();
  return tries + 1;
}

const failed = (path: string, message: string) => new AppError("KYC_CHECK_FAILED", message, [{ path, message }]);

const kyc: FastifyPluginAsyncTypebox = async (app) => {
  // Before the selfie parser below, so its own photo size limit applies.
  await app.register(deliveryKyc, { prefix: "/delivery" });
  app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: SELFIE_MAX_BYTES }, (_request, body, done) => done(null, body));

  const db = () => requireDatabase(app.db);
  const answer = async (userId: ObjectId) => overview(db(), userId);
  const secret = () => {
    if (!app.config.jwtSecret) throw new AppError("NOT_READY", "Verification is not configured.");
    return app.config.jwtSecret;
  };

  /** Writes a step only while the case is still editable, so a submit in another tab wins. */
  const saveStep = async (doc: KycCaseDoc, update: { $set: Record<string, unknown>; $unset?: Record<string, ""> }) => {
    const res = await db().kycCases.updateOne(
      { _id: doc._id, status: { $in: EDITABLE } },
      { ...update, $set: { ...update.$set, status: "in_progress", updatedAt: new Date() } },
    );
    if (res.matchedCount === 0) throw new AppError("CONFLICT");
  };

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["kyc"],
        summary: "Where your identity verification stands",
        response: { 200: OverviewResult, ...Errors },
        security,
      },
    },
    async (request) => ok(request, await answer(request.auth!.userId)),
  );

  app.post(
    "/base/aadhaar",
    {
      preHandler: requireAuth,
      config: limit(60, 10),
      schema: {
        tags: ["kyc"],
        summary: "Start the Aadhaar step with DigiLocker",
        description:
          "Returns a DigiLocker link. Open it in a browser; when the user comes back, call POST /base/aadhaar/check. " +
          "Starting again clears the PAN and selfie steps, since both depend on the Aadhaar. Five tries a day.",
        response: { 200: DigilockerResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const doc = await openCase(db(), userId, "base");
      guardEditable(doc);
      const tries = checkTries(doc.steps.aadhaar);
      const id = verificationId(userId, "aadhaar");
      const { url, referenceId } = await app.verifier.startDigilocker(id, app.config.kyc.redirectUrl);
      await saveStep(doc, {
        $set: {
          "steps.aadhaar": { status: "pending", verificationId: id, referenceId, name: null, last4: null, reason: null, tries, at: new Date() },
        },
        $unset: { "steps.pan": "", "steps.face": "" },
      });
      return ok(request, { url });
    },
  );

  app.post(
    "/base/aadhaar/check",
    {
      preHandler: requireAuth,
      config: limit(1, 30),
      schema: {
        tags: ["kyc"],
        summary: "Check whether DigiLocker has shared the Aadhaar",
        description: "Safe to call repeatedly. The Aadhaar step stays `pending` until the user finishes in DigiLocker.",
        response: { 200: OverviewResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const doc = await loadCase(db(), userId, "base");
      const step = doc?.steps.aadhaar;
      if (!doc || !step) throw new AppError("KYC_STEP_ORDER", "Start with your Aadhaar.");
      if (step.status !== "pending") return ok(request, await answer(userId));

      const state = await app.verifier.digilockerStatus(step.verificationId);
      if (state === "expired" || state === "denied") {
        const reason = state === "expired" ? "The DigiLocker link expired. Start again." : "DigiLocker access was not allowed. Start again and allow Aadhaar.";
        await db().kycCases.updateOne({ _id: doc._id, "steps.aadhaar.verificationId": step.verificationId }, { $set: { "steps.aadhaar.status": "failed", "steps.aadhaar.reason": reason, updatedAt: new Date() } });
        return ok(request, await answer(userId));
      }
      const document = state === "authenticated" ? await app.verifier.aadhaar(step.verificationId) : null;
      if (document) {
        await db().kycCases.updateOne(
          { _id: doc._id, "steps.aadhaar.verificationId": step.verificationId },
          {
            $set: {
              "steps.aadhaar.status": "verified",
              "steps.aadhaar.name": document.name,
              "steps.aadhaar.last4": document.last4,
              "steps.aadhaar.reason": null,
              ...(document.photo ? { "steps.aadhaar.photo": document.photo.toString("base64") } : {}),
              updatedAt: new Date(),
            },
          },
        );
      }
      return ok(request, await answer(userId));
    },
  );

  app.post(
    "/base/pan",
    {
      preHandler: requireAuth,
      config: limit(60, 10),
      schema: {
        tags: ["kyc"],
        summary: "Check your PAN against the name on your Aadhaar",
        description: "One PAN can verify only one account. Five tries a day.",
        body: PanBody,
        response: { 200: OverviewResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const doc = await loadCase(db(), userId, "base");
      if (!doc || doc.steps.aadhaar?.status !== "verified") throw new AppError("KYC_STEP_ORDER", "Verify your Aadhaar first.");
      guardEditable(doc);
      const tries = checkTries(doc.steps.pan);
      const { pan } = request.body;
      const hash = panHash(pan, secret());
      const step = { masked: maskPan(pan), hash, tries, at: new Date() };

      const taken = await db().kycCases.findOne(
        { "steps.pan.hash": hash, "steps.pan.status": "verified", userId: { $ne: userId } },
        { projection: { _id: 1 } },
      );
      const result = taken ? null : await app.verifier.pan(pan, doc.steps.aadhaar.name ?? "");
      const reason = taken
        ? "This PAN is already verified on another Ruxstar account."
        : !result!.valid
          ? "We could not find this PAN. Check the number and try again."
          : !NAME_MATCHES.has(result!.nameMatch ?? "")
            ? "The name on this PAN does not match your Aadhaar."
            : null;

      await saveStep(doc, {
        $set: {
          "steps.pan": {
            ...step,
            status: reason ? "failed" : "verified",
            registeredName: result?.registeredName ?? null,
            nameMatch: result?.nameMatch ?? null,
            reason,
          },
        },
      });
      if (reason) throw failed("body/pan", reason);
      return ok(request, await answer(userId));
    },
  );

  app.post(
    "/base/face",
    {
      preHandler: requireAuth,
      config: limit(60, 10),
      schema: {
        tags: ["kyc"],
        summary: "Send a live selfie to match against your Aadhaar photo",
        description:
          "Send the photo itself with Content-Type image/jpeg, image/png or image/webp, up to 5 MB. It is checked for " +
          "liveness, matched to the Aadhaar photo and never stored. Five tries a day; after the fifth, start the Aadhaar step again.",
        consumes: ["image/jpeg", "image/png", "image/webp"],
        response: { 200: OverviewResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const doc = await loadCase(db(), userId, "base");
      const aadhaar = doc?.steps.aadhaar;
      if (!doc || aadhaar?.status !== "verified") throw new AppError("KYC_STEP_ORDER", "Verify your Aadhaar first.");
      if (doc.steps.pan?.status !== "verified") throw new AppError("KYC_STEP_ORDER", "Verify your PAN first.");
      guardEditable(doc);
      if (!aadhaar.photo) throw new AppError("KYC_STEP_ORDER", "Verify your Aadhaar again so we can match your selfie to its photo.");
      const tries = checkTries(doc.steps.face);
      if (!Buffer.isBuffer(request.body)) throw new AppError("PHOTO_INVALID");
      const selfie = await toSelfie(request.body);

      const id = verificationId(userId, "face");
      const liveness = await app.verifier.liveness(id, selfie);
      const match = liveness.live ? await app.verifier.faceMatch(`${id}_m`, selfie, Buffer.from(aadhaar.photo, "base64")) : null;
      const reason = !liveness.live
        ? "We could not confirm a live photo. Face the camera in good light and try again."
        : !match!.match
          ? "Your selfie does not match your Aadhaar photo. Try again without glasses or a cap."
          : null;

      // The Aadhaar photo is needed only for this match. Once it passes, or the day's tries are used up, it goes.
      const dropPhoto = !reason || tries >= MAX_TRIES_PER_DAY;
      await saveStep(doc, {
        $set: {
          "steps.face": {
            status: reason ? "failed" : "verified",
            livenessScore: liveness.score,
            matchScore: match?.score ?? null,
            reason,
            tries,
            at: new Date(),
          },
        },
        ...(dropPhoto ? { $unset: { "steps.aadhaar.photo": "" } } : {}),
      });
      if (reason) throw failed("body", reason);
      return ok(request, await answer(userId));
    },
  );

  app.post(
    "/base/submit",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["kyc"],
        summary: "Send identity verification for review",
        description:
          "Needs the Aadhaar, PAN and selfie steps verified. Once our team approves it your Ruxstar Card is issued and the vendor portal opens.",
        response: { 200: OverviewResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const doc = await loadCase(db(), userId, "base");
      if (!doc) throw new AppError("KYC_STEP_ORDER", "Start with your Aadhaar.");
      guardEditable(doc);
      const { aadhaar, pan, face } = doc.steps;
      if (aadhaar?.status !== "verified" || pan?.status !== "verified" || face?.status !== "verified") {
        throw new AppError("KYC_STEP_ORDER", "Finish the Aadhaar, PAN and selfie steps first.");
      }
      await submit(doc);
      return ok(request, await answer(userId));
    },
  );

  async function submit(doc: KycCaseDoc) {
    const database = db();
    await database.transaction(async (session) => {
      const now = new Date();
      const res = await database.kycCases.updateOne(
        { _id: doc._id, status: { $in: EDITABLE } },
        { $set: { status: "submitted", submittedAt: now, updatedAt: now } },
        { session },
      );
      if (res.matchedCount === 0) throw new AppError("CONFLICT");
      await database.users.updateOne({ _id: doc.userId }, { $set: { "kyc.base": "pending", updatedAt: now } }, { session });
    });
    app.authCache.forget(doc.userId);
  }

  app.get(
    "/card",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["kyc"],
        summary: "Your Ruxstar Card",
        description: "Issued when identity verification is approved. Only you see the masked Aadhaar and PAN.",
        response: { 200: CardResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const [user, base] = await Promise.all([db().users.findOne({ _id: userId }), loadCase(db(), userId, "base")]);
      if (!user?.card || base?.status !== "approved") throw new AppError("KYC_REQUIRED", "Your Ruxstar Card arrives when your identity is verified.");
      return ok(request, cardView(user, base, app.config.siteUrl));
    },
  );
};

export default kyc;
