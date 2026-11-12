import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, writeAudit } from "../../platform/audit.js";
import { requireDatabase } from "../../platform/context.js";
import type { PayoutMethodDoc, Stamped } from "../../platform/db.js";
import { ok } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { seal } from "../../platform/sealed.js";
import { loadCase, NAME_MATCHES, verificationId } from "../kyc/cases.js";
import { payoutMethodView, requireVendor } from "./businesses.js";
import { PayoutMethodBody, PayoutMethodResult, Payments } from "./contracts.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
/** UPI answers MATCH where bank checks grade the name. */
const PAYOUT_NAME_MATCHES = new Set([...NAME_MATCHES, "MATCH"]);

const failed = (path: string, message: string) => new AppError("KYC_CHECK_FAILED", message, [{ path, message }]);

/** Where a vendor is paid, and what they have earned and been paid. */
const payments: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  app.get(
    "/payments",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Your balance, payout account and latest payouts",
        description: "Pending is your share of paid orders not delivered yet; it becomes available on delivery.",
        response: { 200: Payments, ...Errors },
        security,
      },
    },
    async (request) => {
      const vendorId = request.auth!.userId;
      const [method, payouts, paid, ledger] = await Promise.all([
        db().payoutMethods.findOne({ userId: vendorId }),
        db().payouts.find({ vendorId }).sort({ createdAt: -1, _id: -1 }).limit(20).toArray(),
        db()
          .payouts.aggregate<{ total: number }>([{ $match: { vendorId, status: "paid" } }, { $group: { _id: null, total: { $sum: "$amount" } } }])
          .toArray(),
        db()
          .ledgerEntries.aggregate<{ _id: "pending" | "withdrawable"; total: number }>([
            { $match: { accountId: `vendor:${vendorId.toHexString()}` } },
            { $group: { _id: "$bucket", total: { $sum: "$signedPaise" } } },
          ])
          .toArray(),
      ]);
      const sum = (bucket: "pending" | "withdrawable") => ledger.find((row) => row._id === bucket)?.total ?? 0;
      const paidOut = paid[0]?.total ?? 0;
      return ok(request, {
        // Earned on delivered orders, less what was paid out; pending is paid orders not delivered yet.
        balance: { available: Math.max(0, sum("withdrawable") - paidOut), pending: Math.max(0, sum("pending")), paidOut },
        payoutMethod: method ? payoutMethodView(method) : null,
        payouts: payouts.map((p) => ({
          id: p._id.toHexString(),
          amount: p.amount,
          status: p.status,
          to: p.to,
          utr: p.utr,
          paidAt: p.paidAt?.toISOString() ?? null,
          createdAt: p.createdAt.toISOString(),
        })),
      });
    },
  );

  app.get(
    "/payout-method",
    {
      preHandler: requireVendor,
      schema: { tags: ["vendor"], summary: "Where you are paid", response: { 200: PayoutMethodResult, ...Errors }, security },
    },
    async (request) => {
      const method = await db().payoutMethods.findOne({ userId: request.auth!.userId });
      return ok(request, method ? payoutMethodView(method) : null);
    },
  );

  app.put(
    "/payout-method",
    {
      preHandler: requireVendor,
      config: { rateLimit: { max: 5, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Set the bank account or UPI ID you are paid to",
        description:
          "Checked with Cashfree before it is saved, and it must be in the name on your Aadhaar. Replaces the one you had. " +
          "Only the last 4 digits of a bank account are ever shown again.",
        body: PayoutMethodBody,
        response: { 200: PayoutMethodResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const userId = request.auth!.userId;
      const body = request.body;
      const key = app.config.payoutKey;
      if (body.kind === "bank" && !key) throw new AppError("PAYOUTS_UNAVAILABLE", "Bank accounts can't be added right now. Use a UPI ID.");

      const [base, user] = await Promise.all([loadCase(database, userId, "base"), database.users.findOne({ _id: userId }, { projection: { name: 1 } })]);
      const name = base?.steps.aadhaar?.name ?? user?.name ?? "";
      const result =
        body.kind === "bank"
          ? await app.verifier.bankAccount(body.accountNumber, body.ifsc, name)
          : await app.verifier.upi(verificationId(userId, "upi"), body.vpa, name);
      const path = body.kind === "bank" ? "body/accountNumber" : "body/vpa";
      if (!result.valid) {
        throw failed(path, body.kind === "bank" ? "We couldn't verify this account. Check the number and IFSC." : "We couldn't verify this UPI ID.");
      }
      if (!PAYOUT_NAME_MATCHES.has(result.nameMatch ?? "")) throw failed(path, "This account is in another name. Use one in the name on your Aadhaar.");

      const now = new Date();
      const fields: Omit<PayoutMethodDoc, "_id" | "userId" | keyof Stamped> = {
        kind: body.kind,
        holderName: result.holderName,
        nameMatch: result.nameMatch,
        verifiedAt: now,
        ...(body.kind === "bank"
          ? { bank: { number: seal(body.accountNumber, key!), last4: body.accountNumber.slice(-4), ifsc: body.ifsc, bankName: result.bankName } }
          : { upi: { vpa: body.vpa.toLowerCase() } }),
      };
      const saved = await database.transaction(async (session) => {
        const before = await database.payoutMethods.findOne({ userId }, { session });
        const after = await database.payoutMethods.findOneAndUpdate(
          { userId },
          {
            $set: { ...fields, updatedAt: now },
            $unset: body.kind === "bank" ? { upi: "" } : { bank: "" },
            $setOnInsert: { _id: new ObjectId(), createdAt: now, schemaVersion: 1 },
          },
          { upsert: true, returnDocument: "after", session },
        );
        await writeAudit(
          database,
          {
            actor: actorOf(request),
            scope: { module: "vendor" },
            action: "payout_method.set",
            target: { type: "payout_method", id: after!._id },
            diff: { method: { from: before ? payoutMethodView(before).label : null, to: payoutMethodView(after!).label } },
            ip: request.ip,
          },
          session,
        );
        return after!;
      });
      return ok(request, payoutMethodView(saved));
    },
  );
};

export default payments;
