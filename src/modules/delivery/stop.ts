import type { ClientSession } from "mongodb";
import type { Database, DeliveryJobDoc, PodOrderDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";

export const OPEN_TRIP: DeliveryJobDoc["status"][] = ["offered", "accepted", "picked_up"];

export const tripActive = (order: Pick<PodOrderDoc, "delivery">) => !!order.delivery && OPEN_TRIP.includes(order.delivery.status);

/** While a rider has an order, only they move it out for delivery and delivered. */
export function riderHasIt(order: Pick<PodOrderDoc, "delivery">, to: PodOrderDoc["status"]) {
  if (tripActive(order) && (to === "out_for_delivery" || to === "delivered")) {
    throw new AppError("ORDER_STATE", "A rider has this delivery. Cancel it first to deliver the order yourself.");
  }
}

/** The order's fields to set when its trip ends without a delivery. */
export const tripEnded = (order: Pick<PodOrderDoc, "delivery">): Record<string, unknown> => (tripActive(order) ? { "delivery.status": "cancelled" } : {});

/** Cancels the order's open trip in the caller's transaction, when Ruxstar or the clock ends the order first. */
export async function stopTrip(
  db: Database,
  session: ClientSession,
  order: Pick<PodOrderDoc, "delivery">,
  by: NonNullable<DeliveryJobDoc["cancel"]>["by"],
  reason: string,
) {
  if (!tripActive(order)) return;
  const now = new Date();
  await db.deliveryJobs.updateOne(
    { _id: order.delivery!.jobId, status: { $in: OPEN_TRIP } },
    {
      $set: { status: "cancelled", cancel: { by, reason, at: now }, updatedAt: now },
      $unset: { busy: "" },
      $push: { timeline: { status: "cancelled", at: now } },
    },
    { session },
  );
}
