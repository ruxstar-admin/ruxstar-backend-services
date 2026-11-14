import { randomBytes } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type ClientSession } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, writeAudit } from "../../platform/audit.js";
import { requireRuxstar } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { Database, KycCaseDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { kycPhotoLinks, REVIEW_USER_PROJECTION, reviewView } from "../kyc/cases.js";
import { CaseParams, MAX_REJECTIONS, RejectBody, ReviewList, ReviewOne, ReviewQuery } from "../kyc/contracts.js";
import { notifyKycDecision } from "../notifications/notify.js";
import { apiOrigin, signingKey } from "../pod/orders.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const REVIEWED: KycCaseDoc["track"][] = ["base", "delivery"];

/** RUX- and 8 hex digits, as on v1 cards. Random, so card numbers say nothing about sign-up order. */
async function newCardId(db: Database, session: ClientSession): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const hex = randomBytes(4).toString("hex").toUpperCase();
    const id = `RUX-${hex.slice(0, 4)}-${hex.slice(4)}`;
    if (!(await db.users.findOne({ "card.id": id }, { projection: { _id: 1 }, session }))) return id;
  }
  throw new AppError("INTERNAL", "Could not issue a card number.");
}

/** The KYC review queue. Admins, and staff granted `kyc.view` / `kyc.review`. */
const kycReview: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  /** With each person, and for delivery cases their identity case and signed photo links. */
  const withUsers = async (docs: KycCaseDoc[], request: FastifyRequest) => {
    const ids = docs.map((d) => d.userId);
    const deliveryIds = docs.filter((d) => d.track === "delivery").map((d) => d.userId);
    const [users, identities] = await Promise.all([
      db().users.find({ _id: { $in: ids } }, { projection: REVIEW_USER_PROJECTION }).toArray(),
      deliveryIds.length
        ? db().kycCases.find({ userId: { $in: deliveryIds }, track: "base" }, { projection: { "steps.aadhaar.photo": 0 } }).toArray()
        : [],
    ]);
    const byId = new Map(users.map((u) => [u._id.toHexString(), u]));
    const identityOf = new Map(identities.map((c) => [c.userId.toHexString(), c]));
    const links = kycPhotoLinks(signingKey(app), apiOrigin(app, request));
    return docs.map((d) => reviewView(d, byId.get(d.userId.toHexString()), links, identityOf.get(d.userId.toHexString())));
  };

  app.get(
    "/kyc",
    {
      preHandler: requireRuxstar("kyc.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "Verification cases, waiting for review first by default",
        description: "Newest activity first. `status` defaults to `submitted`, `track` to `base` (identity); `delivery` is delivery partners.",
        querystring: ReviewQuery,
        response: { 200: ReviewList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { status = "submitted", track = "base", cursor, limit } = request.query;
      const { items, nextCursor } = await findPage(db().kycCases, {
        filter: { status, track },
        sortField: "updatedAt",
        cursor,
        limit,
        projection: { "steps.aadhaar.photo": 0 },
      });
      return page(request, await withUsers(items, request), nextCursor);
    },
  );

  app.get(
    "/kyc/:id",
    {
      preHandler: requireRuxstar("kyc.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "One verification case",
        params: CaseParams,
        response: { 200: ReviewOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const doc = await db().kycCases.findOne(
        { _id: new ObjectId(request.params.id), track: { $in: REVIEWED } },
        { projection: { "steps.aadhaar.photo": 0 } },
      );
      if (!doc) throw new AppError("NOT_FOUND", "Case not found.");
      return ok(request, (await withUsers([doc], request))[0]!);
    },
  );

  /**
   * Decides a submitted case in one transaction with its audit entry. Approving identity issues the Ruxstar
   * Card and turns the vendor role on, and either way the held Aadhaar photo goes. Approving delivery turns the
   * delivery role on, and its photos start their 30-day countdown.
   */
  async function decide(request: FastifyRequest, id: string, decision: "approved" | "rejected", reason: string | null) {
    const database = db();
    const actor = actorOf(request);
    const now = new Date();
    let outcome: "approved" | "rejected" | "locked" = decision;

    const updated = await database.transaction(async (session) => {
      const doc = await database.kycCases.findOne({ _id: new ObjectId(id), track: { $in: REVIEWED } }, { session });
      if (!doc) throw new AppError("NOT_FOUND", "Case not found.");
      if (doc.status !== "submitted") throw new AppError("CONFLICT", "This case is not waiting for review.");

      const rejections = doc.rejections + (decision === "rejected" ? 1 : 0);
      outcome = decision === "rejected" && rejections >= MAX_REJECTIONS ? "locked" : decision;
      const after = await database.kycCases.findOneAndUpdate(
        { _id: doc._id, status: "submitted" },
        {
          $set: { status: outcome, rejections, review: { by: request.auth!.userId, at: now, decision, reason }, updatedAt: now },
          $unset: { "steps.aadhaar.photo": "" },
        },
        { session, returnDocument: "after", projection: { "steps.aadhaar.photo": 0 } },
      );
      if (!after) throw new AppError("CONFLICT");

      const set: Record<string, unknown> = { updatedAt: now };
      if (doc.track === "delivery") {
        set["kyc.delivery"] = decision;
        if (decision === "approved") set["roles.delivery"] = true;
      } else {
        const user = await database.users.findOne({ _id: doc.userId }, { session, projection: { card: 1 } });
        set["kyc.base"] = decision;
        if (decision === "approved") set["roles.vendor"] = true;
        if (decision === "approved" && !user?.card) set.card = { id: await newCardId(database, session), issuedAt: now };
      }
      await database.users.updateOne({ _id: doc.userId }, { $set: set }, { session });

      await writeAudit(
        database,
        {
          actor,
          scope: { module: doc.track === "delivery" ? "delivery" : "kyc" },
          action: decision === "approved" ? "kyc.approve" : "kyc.reject",
          target: { type: "kyc_case", id: doc._id },
          diff: { status: { from: doc.status, to: outcome }, ...(reason ? { reason: { from: null, to: reason } } : {}) },
          ip: request.ip,
        },
        session,
      );
      return after;
    });

    app.authCache.forget(updated.userId);
    const track = updated.track === "delivery" ? "delivery" : "base";
    if (track === "delivery" && outcome === "approved") {
      await Promise.all(
        [updated.steps.licence?.photo, updated.steps.vehicle?.photo].flatMap((p) => (p ? [app.printFiles.expire(p.key)] : [])),
      );
    }
    await notifyKycDecision(database, app.log, { to: updated.userId, reviewer: request.auth!.userId, decision: outcome, reason, track });
    return (await withUsers([updated], request))[0]!;
  }

  app.post(
    "/kyc/:id/approve",
    {
      preHandler: [requireRuxstar("kyc.review"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Approve a verification case",
        description: "Issues the Ruxstar Card and the Verified tick, and makes the person a vendor so the vendor portal opens.",
        params: CaseParams,
        response: { 200: ReviewOne, ...Errors },
        security,
      },
    },
    async (request) => ok(request, await decide(request, request.params.id, "approved", null)),
  );

  app.post(
    "/kyc/:id/reject",
    {
      preHandler: [requireRuxstar("kyc.review"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Send a verification case back with what to fix",
        description: `The user sees the reason and can resubmit. Rejection number ${MAX_REJECTIONS} locks the case for support.`,
        params: CaseParams,
        body: RejectBody,
        response: { 200: ReviewOne, ...Errors },
        security,
      },
    },
    async (request) => ok(request, await decide(request, request.params.id, "rejected", request.body.reason.trim())),
  );
};

export default kycReview;
