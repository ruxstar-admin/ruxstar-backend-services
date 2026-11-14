import type { FastifyInstance } from "fastify";
import { MongoServerError, ObjectId } from "mongodb";
import type { Transfer, TransferState } from "../../adapters/payouts.js";
import { writeAudit } from "../../platform/audit.js";
import type { AuditLogDoc, Database, LedgerEntryDoc, PayoutDoc } from "../../platform/db.js";
import { stamp } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { unseal } from "../../platform/sealed.js";
import { notifyPayout } from "../notifications/notify.js";
import { payoutMethodView } from "./businesses.js";

/** ₹5 and GST. */
export const DEFAULT_PAYOUT_FEE = 590;
export const DEFAULT_MIN_PAYOUT = 10_000;
/** Cashfree never had it after this many sends: it fails and the money goes back. */
const MAX_ATTEMPTS = 3;
/** A pending payout is asked about again after this long. */
const CHECK_AFTER_MS = 60_000;
const SWEEP_BATCH = 50;

const money = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** Who a withdrawal pays: a vendor, or a Ruxstar delivery partner (decision 59). */
export type Payee = "vendor" | "rider";
export const payeeOf = (payout: PayoutDoc): Payee => payout.payee ?? "vendor";
const accountOf = (payee: Payee, userId: ObjectId) => `${payee}:${userId.toHexString()}`;
/** One payee's withdrawals: a vendor's have no `payee`. */
export const payeeFilter = (payee: Payee) => (payee === "rider" ? { payee: "rider" as const } : { payee: { $exists: false } });
export const methodsOf = (db: Database, payee: Payee) => (payee === "rider" ? db.riderPayoutMethods : db.payoutMethods);

/** What the vendor is told when a payout comes back, by Cashfree's reason. */
const FAILURES: Record<string, string> = {
  INVALID_BENE_ACCOUNT_OR_IFSC: "The bank turned down the account number or IFSC. Check them and add the account again.",
  INVALID_ACCOUNT_FAIL: "The bank turned down the account number. Check it and add the account again.",
  INVALID_IFSC_FAIL: "The bank turned down the IFSC. Check it and add the account again.",
  INVALID_BENE_VPA: "The UPI ID was turned down. Check it and add it again.",
  ACCOUNT_BLOCKED: "The bank says this account is blocked. Add another account.",
  NRE_ACCOUNT_FAIL: "Payouts can't go to an NRE account. Add another account.",
};
export const failureText = (code: string | null) => FAILURES[code ?? ""] ?? "The bank couldn't complete it. Try again in a while.";

/** The payout fee and the least that can be withdrawn, set by Ruxstar: on the ledger module for vendors, the delivery module for partners. */
export async function payoutRules(db: Database, payee: Payee = "vendor"): Promise<{ fee: number; minimum: number }> {
  const module = payee === "rider" ? "delivery" : "ledger";
  const settings = await db.moduleSettings.findOne({ module }, { projection: { payoutFee: 1, minPayout: 1 } });
  return { fee: settings?.payoutFee ?? DEFAULT_PAYOUT_FEE, minimum: settings?.minPayout ?? DEFAULT_MIN_PAYOUT };
}

/**
 * A withdrawal takes `amount` from the payee's available balance; the fee is Ruxstar's and the rest leaves through
 * Cashfree. A failed one is the same entries the other way.
 */
function payoutLedger(kind: "payout" | "payout_return", payout: PayoutDoc, at: Date): LedgerEntryDoc[] {
  const sign = kind === "payout" ? 1 : -1;
  const rows: [string, number][] = [
    [accountOf(payeeOf(payout), payout.vendorId), -payout.amount],
    ["ruxstar", payout.fee],
    ["gateway", payout.amount - payout.fee],
  ];
  return rows
    .filter(([, paise]) => paise !== 0)
    .map(([accountId, paise]) => ({
      txnId: `${kind}:${payout._id.toHexString()}`,
      kind,
      accountId,
      bucket: "withdrawable" as const,
      signedPaise: sign * paise,
      source: { type: "payout" as const, id: payout._id },
      at,
    }));
}

/** Letters and spaces only, as Cashfree wants the name. */
const bankName = (name: string, payee: Payee) =>
  name
    .replace(/[^\p{L} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || (payee === "rider" ? "Ruxstar Partner" : "Ruxstar Vendor");

/** A person has one withdrawal on the way at a time, whether they are paid as a vendor or as a partner. */
async function noneOnTheWay(db: Database, userId: ObjectId, payee: Payee) {
  const other = await db.payouts.findOne({ vendorId: userId, status: "pending" }, { projection: { payee: 1 } });
  if (!other) return;
  if (payeeOf(other) === payee) throw new AppError("PAYOUT_IN_PROGRESS");
  throw new AppError(
    "PAYOUT_IN_PROGRESS",
    payee === "rider"
      ? "Your withdrawal from your shop earnings is still on the way. Wait for it to arrive."
      : "Your withdrawal from your delivery earnings is still on the way. Wait for it to arrive.",
  );
}

/** Withdraws everything available, at least the minimum, to the payee's checked account, then sends it. */
export async function withdraw(
  app: FastifyInstance,
  db: Database,
  userId: ObjectId,
  actor: AuditLogDoc["actor"],
  ip: string | null,
  payee: Payee = "vendor",
): Promise<PayoutDoc> {
  if (!app.payouts.available) throw new AppError("PAYOUTS_UNAVAILABLE", "Withdrawals aren't available right now. Try again later.");
  const [method, rules, user] = await Promise.all([
    methodsOf(db, payee).findOne({ userId }),
    payoutRules(db, payee),
    db.users.findOne({ _id: userId }, { projection: { name: 1 } }),
  ]);
  if (!method) throw new AppError("PAYOUT_METHOD_REQUIRED");
  if (method.kind === "bank" && !app.config.payoutKey) throw new AppError("PAYOUTS_UNAVAILABLE", "Withdrawals aren't available right now. Try again later.");
  await noneOnTheWay(db, userId, payee);

  const now = new Date();
  const _id = new ObjectId();
  const payout = await db
    .transaction(async (session) => {
      const [row] = await db.ledgerEntries
        .aggregate<{ total: number }>(
          [{ $match: { accountId: accountOf(payee, userId), bucket: "withdrawable" } }, { $group: { _id: null, total: { $sum: "$signedPaise" } } }],
          { session },
        )
        .toArray();
      const available = row?.total ?? 0;
      if (available < rules.minimum || available - rules.fee < 100) {
        throw new AppError("PAYOUT_TOO_SMALL", `You can withdraw once ${money(Math.max(rules.minimum, rules.fee + 100))} is available.`);
      }
      const doc: PayoutDoc = {
        _id,
        vendorId: userId,
        ...(payee === "rider" ? { payee } : {}),
        amount: available,
        fee: rules.fee,
        status: "pending",
        to: payoutMethodView(method).label,
        destination: {
          name: bankName(method.holderName ?? user?.name ?? "", payee),
          ...(method.kind === "bank" && method.bank ? { bank: { number: method.bank.number, ifsc: method.bank.ifsc } } : {}),
          ...(method.kind === "upi" && method.upi ? { upi: { vpa: method.upi.vpa } } : {}),
        },
        transferId: `rxpo_${_id.toHexString()}`,
        utr: null,
        paidAt: null,
        failure: null,
        attempts: 0,
        checkedAt: null,
        ...stamp(now),
      };
      await db.payouts.insertOne(doc, { session });
      for (const entry of payoutLedger("payout", doc, now)) await db.ledgerEntries.insertOne(entry, { session });
      await writeAudit(
        db,
        {
          actor,
          scope: { module: payee === "rider" ? "delivery" : "ledger" },
          action: "payout.request",
          target: { type: "payout", id: _id },
          diff: { amount: { from: null, to: available }, fee: { from: null, to: rules.fee }, to: { from: null, to: doc.to } },
          ip,
        },
        session,
      );
      return doc;
    })
    .catch((err: unknown) => {
      if (err instanceof MongoServerError && err.code === 11000) throw new AppError("PAYOUT_IN_PROGRESS");
      throw err;
    });
  return settlePayout(app, db, payout, now);
}

function transferOf(app: FastifyInstance, payout: PayoutDoc): Transfer {
  const { name, bank, upi } = payout.destination;
  return {
    transferId: payout.transferId,
    amount: payout.amount - payout.fee,
    name,
    to: bank ? { kind: "bank", accountNumber: unseal(bank.number, app.config.payoutKey!), ifsc: bank.ifsc } : { kind: "upi", vpa: upi!.vpa },
  };
}

/**
 * Sends a pending payout, or asks Cashfree how it is going, and settles it once Cashfree knows. Safe to repeat:
 * Cashfree is asked first, and only a transfer it never got is sent again. When Cashfree can't be reached the
 * payout stays pending for the next check.
 */
export async function settlePayout(app: FastifyInstance, db: Database, payout: PayoutDoc, now = new Date()): Promise<PayoutDoc> {
  if (payout.status !== "pending") return payout;
  let state: TransferState | null;
  try {
    state = await app.payouts.status(payout.transferId);
    if (!state && payout.attempts >= MAX_ATTEMPTS) state = { status: "failed", utr: null, failure: "NOT_SENT" };
    if (!state) {
      await db.payouts.updateOne({ _id: payout._id, status: "pending" }, { $inc: { attempts: 1 }, $set: { checkedAt: now, updatedAt: now } });
      state = await app.payouts.send(transferOf(app, payout));
    }
  } catch (err) {
    app.log.warn({ err: (err as Error).message, payout: payout._id.toHexString() }, "Payout not settled; it is checked again later");
    await db.payouts.updateOne({ _id: payout._id, status: "pending" }, { $set: { checkedAt: now, updatedAt: now } });
    return (await db.payouts.findOne({ _id: payout._id })) ?? payout;
  }

  if (state.status === "pending") {
    return (await db.payouts.findOneAndUpdate({ _id: payout._id }, { $set: { checkedAt: now, updatedAt: now } }, { returnDocument: "after" })) ?? payout;
  }
  if (state.status === "paid") {
    const paid = await db.payouts.findOneAndUpdate(
      { _id: payout._id, status: "pending" },
      { $set: { status: "paid", utr: state.utr, paidAt: now, checkedAt: now, updatedAt: now } },
      { returnDocument: "after" },
    );
    if (!paid) return (await db.payouts.findOne({ _id: payout._id })) ?? payout;
    await notifyPayout(db, app.log, {
      to: paid.vendorId,
      payoutId: paid._id,
      rider: payeeOf(paid) === "rider",
      title: `${money(paid.amount - paid.fee)} sent`,
      body: `Your withdrawal reached ${paid.to}.${paid.utr ? ` Bank reference ${paid.utr}.` : ""}`,
    });
    return paid;
  }

  const { failure } = state;
  const failed = await db.transaction(async (session) => {
    const after = await db.payouts.findOneAndUpdate(
      { _id: payout._id, status: "pending" },
      { $set: { status: "failed", failure, checkedAt: now, updatedAt: now } },
      { session, returnDocument: "after" },
    );
    if (!after) return null;
    for (const entry of payoutLedger("payout_return", after, now)) await db.ledgerEntries.insertOne(entry, { session });
    return after;
  });
  if (!failed) return (await db.payouts.findOne({ _id: payout._id })) ?? payout;
  app.log.warn({ payout: failed._id.toHexString(), failure: failed.failure, payee: payeeOf(failed) }, "Payout failed; the money is back in the balance");
  await notifyPayout(db, app.log, {
    to: failed.vendorId,
    payoutId: failed._id,
    rider: payeeOf(failed) === "rider",
    title: "Withdrawal didn't go through",
    body: `${money(failed.amount)} is back in your balance. ${failureText(failed.failure)}`,
  });
  return failed;
}

/** Settles someone's payout on the way once it is due for a check, before their balance is shown. */
export async function settleDue(app: FastifyInstance, db: Database, userId: ObjectId, now = new Date()): Promise<void> {
  const due = await db.payouts.findOne({
    vendorId: userId,
    status: "pending",
    $or: [{ checkedAt: null }, { checkedAt: { $lte: new Date(now.getTime() - CHECK_AFTER_MS) } }],
  });
  if (due) await settlePayout(app, db, due, now);
}

/** For the scheduler: every payout on the way that is due for a check. */
export async function sweepPayouts(app: FastifyInstance, db: Database, now = new Date()) {
  const due = await db.payouts
    .find({ status: "pending", $or: [{ checkedAt: null }, { checkedAt: { $lte: new Date(now.getTime() - CHECK_AFTER_MS) } }] })
    .sort({ checkedAt: 1 })
    .limit(SWEEP_BATCH)
    .toArray();
  const counts = { checked: due.length, paid: 0, failed: 0 };
  for (const payout of due) {
    const after = await settlePayout(app, db, payout, now);
    if (after.status === "paid") counts.paid += 1;
    if (after.status === "failed") counts.failed += 1;
  }
  return counts;
}
