import type { Filter, ObjectId } from "mongodb";
import type { Database, PodOrderDoc } from "../../platform/db.js";
import { riderReleaseLedger } from "../pod/orders.js";

const SWEEP_BATCH = 100;

/** A "not received" report holds a partner's pay until Ruxstar settles it. Other problems come out of the shop's share. */
export const riderPayHeld = (order: PodOrderDoc) => order.problem?.status === "open" && order.problem.kind === "not_received";

const NOT_HELD: Filter<PodOrderDoc> = { $nor: [{ "problem.status": "open", "problem.kind": "not_received" }] };
const due = (now: Date): Filter<PodOrderDoc> => ({ "delivery.releasedAt": null, "delivery.releaseAt": { $type: "date", $lte: now }, ...NOT_HELD });

/** Moves one order's partner pay to their available balance, 48 hours after delivery. Once: the order is marked in the same transaction. */
export async function releaseRiderPay(db: Database, order: PodOrderDoc, now = new Date()): Promise<boolean> {
  const delivery = order.delivery;
  if (!delivery?.rider || !delivery.paidAt || !delivery.releaseAt || delivery.releasedAt || delivery.releaseAt > now || riderPayHeld(order)) return false;
  const riderId = delivery.rider.id;
  return db.transaction(async (session) => {
    const res = await db.podOrders.updateOne(
      { _id: order._id, "delivery.jobId": delivery.jobId, "delivery.releasedAt": null, ...NOT_HELD },
      { $set: { "delivery.releasedAt": now } },
      { session },
    );
    if (res.modifiedCount === 0) return false;
    for (const entry of riderReleaseLedger(order, riderId, delivery.pay, now)) await db.ledgerEntries.insertOne(entry, { session });
    return true;
  });
}

/** A partner's pay that is due, released before their earnings are shown. */
export async function releaseRiderPayFor(db: Database, riderId: ObjectId, now = new Date()): Promise<void> {
  const orders = await db.podOrders
    .find({ "delivery.rider.id": riderId, ...due(now) })
    .limit(50)
    .toArray();
  for (const order of orders) await releaseRiderPay(db, order, now);
}

/** For the scheduler: every partner's pay whose hold is over. */
export async function sweepRiderPay(db: Database, now = new Date()): Promise<number> {
  const orders = await db.podOrders.find(due(now)).sort({ "delivery.releaseAt": 1 }).limit(SWEEP_BATCH).toArray();
  let released = 0;
  for (const order of orders) if (await releaseRiderPay(db, order, now)) released += 1;
  return released;
}

/** Partners' pay still on hold: all of it for the console, or one partner's. */
export const heldRiderPay = (riderId?: ObjectId): Filter<PodOrderDoc> => ({
  ...(riderId ? { "delivery.rider.id": riderId } : {}),
  "delivery.releasedAt": null,
  "delivery.releaseAt": { $type: "date" },
});
