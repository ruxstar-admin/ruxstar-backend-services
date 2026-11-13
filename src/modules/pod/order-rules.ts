import type { FastifyInstance } from "fastify";
import type { ObjectId } from "mongodb";
import { writeAudit } from "../../platform/audit.js";
import type { AuditLogDoc, Database, PodOrderDoc, PodProblemDoc, PodRefundDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { notifyOrder } from "../notifications/notify.js";
import {
  askForRefund,
  hasPendingRefund,
  IN_HAND,
  LATE_LIMIT_MS,
  ledgerFor,
  moveOrder,
  partialRefundLedger,
  refundsOf,
  rupees,
  shopShareLeft,
  unreleased,
} from "./orders.js";

export interface Staff {
  actor: AuditLogDoc["actor"];
  userId: ObjectId;
  ip: string | null;
}
type Resolution = NonNullable<PodProblemDoc["resolution"]>;

const SYSTEM = { kind: "system" as const, actor: { id: null, kind: "system" as const } };
const problemOpen = (order: PodOrderDoc) => order.problem?.status === "open";
const releaseDue = (order: PodOrderDoc, now: Date) =>
  order.status === "delivered" && !!order.releaseAt && order.releaseAt <= now && !order.releasedAt && !problemOpen(order);
const acceptOverdue = (order: PodOrderDoc, now: Date) => order.status === "placed" && !!order.acceptBy && order.acceptBy <= now;
const longLate = (order: PodOrderDoc, now: Date) =>
  IN_HAND.includes(order.status) && !!order.readyBy && order.readyBy.getTime() + LATE_LIMIT_MS <= now.getTime() && !problemOpen(order);

/** The problem's photos go with the order's files, 30 days after it is settled. */
const expirePhotos = (app: FastifyInstance, order: PodOrderDoc) => Promise.all((order.problem?.photos ?? []).map((p) => app.printFiles.expire(p.key)));

/** Moves the shop's share (less partial refunds) and Ruxstar's to available, once the hold is over and no problem is open. */
export async function releaseShare(app: FastifyInstance, db: Database, order: PodOrderDoc, now = new Date()): Promise<PodOrderDoc> {
  if (!releaseDue(order, now)) return order;
  const released = await db.transaction(async (session) => {
    const after = await db.podOrders.findOneAndUpdate(
      { _id: order._id, status: "delivered", releasedAt: null, "problem.status": { $ne: "open" } },
      { $set: { releasedAt: now, updatedAt: now } },
      { session, returnDocument: "after" },
    );
    if (!after) return null;
    for (const entry of ledgerFor("release", after, now)) await db.ledgerEntries.insertOne(entry, { session });
    return after;
  });
  if (!released) return (await db.podOrders.findOne({ _id: order._id })) ?? order;
  const amount = shopShareLeft(released);
  if (amount > 0) {
    await notifyOrder(db, app.log, {
      to: released.vendorId,
      actor: released.customerId,
      orderId: released._id,
      type: "order.updated",
      forShop: true,
      title: `${rupees(amount)} available`,
      body: `Your share of order #${released.orderNo} is in your available balance.`,
    });
  }
  return released;
}

function refundable(order: PodOrderDoc) {
  if (!order.payment.paidAt || !unreleased(order)) {
    throw new AppError("ORDER_STATE", "This order can't be refunded now: it isn't paid, it's closed, or the shop's share was already paid out.");
  }
}

/**
 * Sends part of an order back to the customer, out of the shop's share, by the shop or by Ruxstar settling a problem.
 * The order goes on as it was. Only one money change at a time: it fails if the order changed since it was read.
 */
export async function refundPart(
  app: FastifyInstance,
  db: Database,
  order: PodOrderDoc,
  input: { amount: number; reason: string; by: "vendor" | "staff"; actor: AuditLogDoc["actor"]; ip: string | null; resolve?: Resolution },
): Promise<PodOrderDoc> {
  refundable(order);
  const left = shopShareLeft(order);
  if (input.amount > left) {
    throw new AppError("ORDER_INVALID", `At most ${rupees(left)} can come out of the shop's share.`, [
      { path: "body/amount", message: `At most ${rupees(left)}` },
    ]);
  }
  const now = new Date();
  const before = refundsOf(order);
  const refund: PodRefundDoc = {
    refundId: `rf_${order._id.toHexString()}_${before.length + 1}`,
    amount: input.amount,
    kind: "partial",
    reason: input.reason,
    by: input.by,
    status: "pending",
    at: now,
  };
  const done = await db.transaction(async (session) => {
    const after = await db.podOrders.findOneAndUpdate(
      { _id: order._id, updatedAt: order.updatedAt },
      {
        $set: {
          refunds: [...before, refund],
          updatedAt: now,
          ...(input.resolve ? { "problem.status": "resolved" as const, "problem.resolution": input.resolve } : {}),
        },
      },
      { session, returnDocument: "after" },
    );
    if (!after) return null;
    for (const entry of partialRefundLedger(after, refund)) await db.ledgerEntries.insertOne(entry, { session });
    await writeAudit(
      db,
      {
        actor: input.actor,
        scope: { module: "pod", businessId: order.shopId },
        action: input.resolve ? "pod_order.settle" : "pod_order.refund",
        target: { type: "pod_order", id: order._id },
        diff: { refunded: { from: before.reduce((s, r) => s + r.amount, 0), to: before.reduce((s, r) => s + r.amount, 0) + input.amount } },
        ip: input.ip,
      },
      session,
    );
    return after;
  });
  if (!done) throw new AppError("ORDER_STATE");
  if (input.resolve) await expirePhotos(app, done);

  const no = `#${done.orderNo}`;
  const actor = input.actor.id ?? done.customerId;
  await notifyOrder(db, app.log, {
    to: done.customerId,
    actor,
    orderId: done._id,
    type: "order.updated",
    forShop: false,
    title: `${rupees(input.amount)} back for order ${no}`,
    body: input.reason,
  });
  if (input.by === "staff") {
    await notifyOrder(db, app.log, {
      to: done.vendorId,
      actor,
      orderId: done._id,
      type: "order.updated",
      forShop: true,
      title: `Refund on order ${no}`,
      body: `Ruxstar refunded ${rupees(input.amount)} from your share. ${input.reason}`,
    });
  }
  return askForRefund(app, db, done);
}

/** Ruxstar refunds all that is left of an accepted order and ends it as `refunded`. */
export async function refundWhole(
  app: FastifyInstance,
  db: Database,
  order: PodOrderDoc,
  input: { reason: string; staff: Staff; resolve?: Resolution },
): Promise<PodOrderDoc> {
  refundable(order);
  if (order.status === "placed") throw new AppError("ORDER_STATE", "The shop hasn't accepted this order; it is cancelled and refunded if they don't.");
  const now = new Date();
  const before = refundsOf(order);
  const amount = order.price.total - before.reduce((s, r) => s + r.amount, 0);
  const refund: PodRefundDoc = {
    refundId: `rf_${order._id.toHexString()}`,
    amount,
    kind: "full",
    reason: input.reason,
    by: "staff",
    status: "pending",
    at: now,
  };
  const done = await db.transaction(async (session) => {
    const after = await db.podOrders.findOneAndUpdate(
      { _id: order._id, updatedAt: order.updatedAt },
      {
        $set: {
          status: "refunded",
          refunds: amount > 0 ? [...before, refund] : before,
          reason: input.reason,
          updatedAt: now,
          ...(input.resolve ? { "problem.status": "resolved" as const, "problem.resolution": input.resolve } : {}),
        },
        $push: { timeline: { status: "refunded", at: now, by: "staff" } },
      },
      { session, returnDocument: "after" },
    );
    if (!after) return null;
    for (const entry of ledgerFor("refund", after, now)) await db.ledgerEntries.insertOne(entry, { session });
    await writeAudit(
      db,
      {
        actor: input.staff.actor,
        scope: { module: "pod", businessId: order.shopId },
        action: input.resolve ? "pod_order.settle" : "pod_order.refund",
        target: { type: "pod_order", id: order._id },
        diff: { status: { from: order.status, to: "refunded" }, refunded: { from: order.price.total - amount, to: order.price.total } },
        ip: input.staff.ip,
      },
      session,
    );
    return after;
  });
  if (!done) throw new AppError("ORDER_STATE");
  await Promise.all([...done.files.map((f) => app.printFiles.expire(f.key)), expirePhotos(app, done)]);

  const no = `#${done.orderNo}`;
  await notifyOrder(db, app.log, {
    to: done.customerId,
    actor: input.staff.userId,
    orderId: done._id,
    type: "order.updated",
    forShop: false,
    title: `Order ${no} refunded`,
    body: `${rupees(amount)} is on its way back to you. ${input.reason}`,
  });
  await notifyOrder(db, app.log, {
    to: done.vendorId,
    actor: input.staff.userId,
    orderId: done._id,
    type: "order.updated",
    forShop: true,
    title: `Order ${no} refunded`,
    body: `Ruxstar refunded the customer in full, so there is no payout for it. ${input.reason}`,
  });
  return askForRefund(app, db, done);
}

/** Ruxstar closes a problem without moving money. The order's timers carry on. */
export async function dismissProblem(app: FastifyInstance, db: Database, order: PodOrderDoc, input: { note: string; staff: Staff }): Promise<PodOrderDoc> {
  const now = new Date();
  const resolution: Resolution = { outcome: "dismissed", amount: 0, note: input.note, by: input.staff.userId, at: now };
  const done = await db.transaction(async (session) => {
    const after = await db.podOrders.findOneAndUpdate(
      { _id: order._id, "problem.status": "open" },
      { $set: { "problem.status": "resolved", "problem.resolution": resolution, updatedAt: now } },
      { session, returnDocument: "after" },
    );
    if (!after) return null;
    await writeAudit(
      db,
      {
        actor: input.staff.actor,
        scope: { module: "pod", businessId: order.shopId },
        action: "pod_order.settle",
        target: { type: "pod_order", id: order._id },
        diff: { problem: { from: "open", to: "dismissed" } },
        ip: input.staff.ip,
      },
      session,
    );
    return after;
  });
  if (!done) throw new AppError("ORDER_STATE", "This problem was already settled.");
  await expirePhotos(app, done);
  const no = `#${done.orderNo}`;
  for (const forShop of [false, true]) {
    await notifyOrder(db, app.log, {
      to: forShop ? done.vendorId : done.customerId,
      actor: input.staff.userId,
      orderId: done._id,
      type: "order.updated",
      forShop,
      title: `Problem on order ${no} closed`,
      body: input.note,
    });
  }
  return done;
}

/** Whether `applyDue` has anything to do, without a database call. */
export const isDue = (order: PodOrderDoc, now = new Date()) =>
  acceptOverdue(order, now) || longLate(order, now) || releaseDue(order, now) || hasPendingRefund(order);

/**
 * Runs whatever an order's clock says is due: cancels and refunds it when the shop didn't accept within 6 hours,
 * marks it delivered a week after its ready date, releases the shop's share after the 48-hour hold, and retries
 * refunds. Each step only happens from the state it was read in, so running it twice, or alongside the shop, is safe.
 */
export async function applyDue(app: FastifyInstance, db: Database, order: PodOrderDoc, now = new Date()): Promise<PodOrderDoc> {
  let current = order;
  try {
    if (acceptOverdue(current, now)) {
      current = await moveOrder(app, db, current, "cancelled", SYSTEM, { reason: "The shop didn't accept it within 6 hours." });
    } else if (longLate(current, now)) {
      current = await moveOrder(app, db, current, "delivered", SYSTEM);
    }
    current = await releaseShare(app, db, current, now);
    if (hasPendingRefund(current)) current = await askForRefund(app, db, current);
    return current;
  } catch (err) {
    if (err instanceof AppError && err.code === "ORDER_STATE") return (await db.podOrders.findOne({ _id: order._id })) ?? current;
    throw err;
  }
}

/** For reads: brings the orders about to be shown up to date. */
export const dueApplied = (app: FastifyInstance, db: Database, orders: PodOrderDoc[]) =>
  Promise.all(orders.map((o) => (isDue(o) ? applyDue(app, db, o) : o)));

const SWEEP_BATCH = 200;

/** Cloud Scheduler runs this every 10 minutes. Reads of orders and balances catch up the orders they show in between. */
export async function sweepOrders(app: FastifyInstance, db: Database, now = new Date()) {
  const due = await db.podOrders
    .find({
      $or: [
        { status: "placed", acceptBy: { $lte: now } },
        { status: { $in: IN_HAND }, readyBy: { $lte: new Date(now.getTime() - LATE_LIMIT_MS) }, "problem.status": { $ne: "open" } },
        { status: "delivered", releaseAt: { $lte: now }, releasedAt: null, "problem.status": { $ne: "open" } },
        { "refunds.status": "pending" },
      ],
    })
    .limit(SWEEP_BATCH)
    .toArray();
  const counts = { checked: due.length, cancelled: 0, delivered: 0, released: 0, failed: 0 };
  for (const order of due) {
    try {
      const after = await applyDue(app, db, order, now);
      if (order.status === "placed" && after.status === "cancelled") counts.cancelled += 1;
      if (order.status !== "delivered" && after.status === "delivered") counts.delivered += 1;
      if (!order.releasedAt && after.releasedAt) counts.released += 1;
    } catch (err) {
      counts.failed += 1;
      app.log.error({ err: (err as Error).message, order: order._id.toHexString() }, "Order sweep step failed; it is retried on the next run");
    }
  }
  return counts;
}
