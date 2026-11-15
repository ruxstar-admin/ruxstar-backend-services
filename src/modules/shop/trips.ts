import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { writeAudit } from "../../platform/audit.js";
import { stamp, type AuditLogDoc, type Database, type DeliveryJobDoc, type OrderDelivery, type ShopOrderDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { deliveryRules, rateFor, roadKm, type DeliveryRules } from "../delivery/rates.js";
import { OPEN_TRIP, tripActive } from "../delivery/stop.js";
import { cityKey, dropCode, endBeforePickup, OFFER_FANOUT, riderProfile } from "../delivery/trips.js";
import { notifyRider, notifyShop } from "../notifications/notify.js";
import { HOLD_MS, rupees } from "../pod/orders.js";
import { itemsText, moveShopOrder, shopPeople } from "./orders.js";
import { riderHeldOf, shopRiderPayLedger, vendorLeftOf } from "./rules.js";

type By = { actor: AuditLogDoc["actor"]; ip: string | null };
const riderActor = (riderId: ObjectId): AuditLogDoc["actor"] => ({ id: riderId, kind: "user" });

async function shopOf(db: Database, o: ShopOrderDoc) {
  const shop = await db.businesses.findOne({ _id: o.businessId }, { projection: { name: 1, phone: 1, location: 1 } });
  if (!shop) throw new AppError("NOT_FOUND", "Shop not found.");
  return shop;
}

function partnerQuote(o: ShopOrderDoc, shop: Awaited<ReturnType<typeof shopOf>>, rules: DeliveryRules) {
  const distanceKm = roadKm(shop.location?.point, o.address?.point);
  const pay = rateFor(rules.riderRate, distanceKm);
  const reason = !rules.shopPartners
    ? "Ruxstar delivery partners aren't available for local shops yet."
    : !shop.location?.point
      ? "Pin your shop on the map in its details to use Ruxstar partners."
      : !o.address?.point
        ? "The customer's address couldn't be found on the map, so a partner can't be sent."
        : pay > vendorLeftOf(o) - riderHeldOf(o)
          ? `Your share of this order is less than the partner's ${rupees(pay)}.`
          : null;
  return { distanceKm, pay, reason };
}

const assignProblem = (o: ShopOrderDoc) =>
  o.method === "pickup"
    ? "This order is for pickup at the shop."
    : tripActive(o)
      ? "A rider has this order. Cancel that delivery first."
      : o.status !== "packed"
        ? "Pack the order first."
        : null;

/** Who can take an order to the customer: someone on the team with "Deliver orders", or a Ruxstar partner. The shop can always do it itself. */
export async function shopDeliveryOptions(db: Database, o: ShopOrderDoc) {
  const [shop, rules, places] = await Promise.all([
    shopOf(db, o),
    deliveryRules(db),
    db.employments.find({ businessId: o.businessId, status: "active", current: true, permissions: "orders.deliver" }).toArray(),
  ]);
  const team = await Promise.all(
    places.map(async (place) => {
      const [user, rider] = await Promise.all([db.users.findOne({ _id: place.userId }, { projection: { name: 1, username: 1, avatar: 1 } }), riderProfile(db, place.userId)]);
      return {
        placeId: place._id.toHexString(),
        name: user?.name || (user?.username ? `@${user.username}` : "Someone"),
        avatarUrl: user?.avatar ?? null,
        vehicle: rider?.vehicle ?? null,
        ready: !!rider,
      };
    }),
  );
  const quote = partnerQuote(o, shop, rules);
  const city = cityKey(shop.location?.city);
  const online = rules.shopPartners && city ? await db.riderStates.countDocuments({ online: true, city }) : 0;
  const problem = assignProblem(o);
  return {
    orderStatus: o.status,
    canAssign: !problem,
    reason: problem,
    team,
    partner: { available: !quote.reason, reason: quote.reason, pay: quote.pay, distanceKm: quote.distanceKm, online },
  };
}

/** Hands a packed order to someone on the team, or offers it to the Ruxstar partners online in the shop's city, as print orders do. */
export async function assignShopTrip(app: FastifyInstance, db: Database, o: ShopOrderDoc, choice: { carrier: "team"; placeId: string } | { carrier: "partner" }, by: By): Promise<ShopOrderDoc> {
  const problem = assignProblem(o);
  if (problem) throw new AppError("ORDER_STATE", problem);
  const [shop, rules] = await Promise.all([shopOf(db, o), deliveryRules(db)]);
  const now = new Date();
  const city = cityKey(shop.location?.city);
  const address = o.address!;

  let riderId: ObjectId | null = null;
  let placeId: ObjectId | null = null;
  let pay = 0;
  let distanceKm = roadKm(shop.location?.point, address.point);
  let offerUntil: Date | null = null;
  if (choice.carrier === "team") {
    const place = await db.employments.findOne({ _id: new ObjectId(choice.placeId), businessId: o.businessId, status: "active", current: true, permissions: "orders.deliver" });
    if (!place) throw new AppError("VALIDATION_FAILED", 'Pick someone on the team with "Deliver orders".', [{ path: "body/placeId", message: "Not on the team" }]);
    if (!(await riderProfile(db, place.userId))) {
      throw new AppError("VALIDATION_FAILED", "They need delivery verification first, from the delivery icon on their profile.", [{ path: "body/placeId", message: "Not delivery verified" }]);
    }
    riderId = place.userId;
    placeId = place._id;
  } else {
    const quote = partnerQuote(o, shop, rules);
    if (quote.reason) throw new AppError("ORDER_STATE", quote.reason);
    pay = quote.pay;
    distanceKm = quote.distanceKm;
    offerUntil = new Date(now.getTime() + rules.offerMinutes * 60_000);
  }

  const location = shop.location;
  const job: DeliveryJobDoc = {
    _id: new ObjectId(),
    orderType: "shop_order",
    orderId: o._id,
    orderNo: o.orderNo,
    shopId: o.businessId,
    vendorId: o.vendorId,
    carrier: choice.carrier,
    city,
    riderId,
    placeId,
    status: "offered",
    offerUntil,
    pickup: {
      name: shop.name,
      phone: shop.phone ?? "",
      line: [location?.doorNo, location?.building, location?.street, location?.area, location?.pincode].filter(Boolean).join(", "),
      city: location?.city ?? "",
      point: location?.point ?? null,
    },
    drop: { name: address.name, phone: address.phone, line: address.line, city: address.city, pincode: address.pincode, point: address.point },
    item: itemsText(o),
    distanceKm,
    pay,
    dropCode: dropCode(),
    proof: null,
    passedBy: [],
    codeTries: 0,
    cancel: null,
    timeline: [{ status: "offered", at: now }],
    ...stamp(now),
  };
  const delivery: OrderDelivery = { jobId: job._id, carrier: job.carrier, status: "offered", rider: null, pay, paidAt: null, dropCode: job.dropCode, offerUntil };

  const updated = await db.transaction(async (session) => {
    const after = await db.shopOrders.findOneAndUpdate(
      { _id: o._id, status: "packed", "delivery.status": { $nin: OPEN_TRIP } },
      { $set: { delivery, updatedAt: now } },
      { session, returnDocument: "after" },
    );
    if (!after) throw new AppError("ORDER_STATE");
    await db.deliveryJobs.insertOne(job, { session });
    await writeAudit(
      db,
      {
        actor: by.actor,
        scope: { module: "delivery", businessId: o.businessId },
        action: "delivery.assign",
        target: { type: "shop_order", id: o._id },
        diff: { carrier: { from: null, to: choice.carrier }, ...(riderId ? { rider: { from: null, to: riderId.toHexString() } } : {}) },
        ip: by.ip,
      },
      session,
    );
    return after;
  });

  const actor = by.actor.id ?? o.vendorId;
  if (riderId) {
    await notifyRider(db, app.log, {
      to: [riderId],
      actor,
      type: "delivery.offer",
      jobId: job._id,
      title: `Deliver for ${shop.name}`,
      body: `Order #${o.orderNo} to ${address.city}. Accept it in the Ruxstar Delivery app.`,
    });
  } else {
    const riders = await db.riderStates.find({ online: true, city }, { projection: { _id: 1 } }).limit(OFFER_FANOUT).toArray();
    await notifyRider(db, app.log, {
      to: riders.map((r) => r._id).filter((id) => !id.equals(o.vendorId)),
      actor,
      type: "delivery.offer",
      jobId: job._id,
      title: `New delivery: ${rupees(pay)}`,
      body: `${shop.name} to ${address.city}${distanceKm ? `, about ${distanceKm} km` : ""}. First to accept gets it.`,
    });
  }
  return updated;
}

/** The shop takes the delivery back before it is picked up. */
export async function cancelShopTrip(app: FastifyInstance, db: Database, o: ShopOrderDoc, by: By): Promise<ShopOrderDoc> {
  const delivery = o.delivery;
  if (!delivery || !tripActive(o)) throw new AppError("CONFLICT", "Nobody is delivering this order.");
  if (delivery.status === "picked_up") throw new AppError("ORDER_STATE", "The rider has it already. Call them if it must come back.");
  const job = await db.deliveryJobs.findOne({ _id: delivery.jobId });
  if (!job) throw new AppError("NOT_FOUND", "Delivery not found.");
  await db.transaction(async (session) => {
    await endBeforePickup(db, job, ["offered", "accepted"], { by: "shop", reason: "The shop cancelled the delivery.", at: new Date() }, { session });
    await writeAudit(
      db,
      {
        actor: by.actor,
        scope: { module: "delivery", businessId: o.businessId },
        action: "delivery.cancel",
        target: { type: "shop_order", id: o._id },
        diff: { delivery: { from: delivery.status, to: "cancelled" } },
        ip: by.ip,
      },
      session,
    );
  });
  if (job.riderId) {
    await notifyRider(db, app.log, {
      to: [job.riderId],
      actor: by.actor.id ?? o.vendorId,
      type: "delivery.updated",
      jobId: job._id,
      title: "Delivery cancelled",
      body: `The shop cancelled the delivery of order #${o.orderNo}. You don't need to pick it up.`,
    });
  }
  return (await db.shopOrders.findOne({ _id: o._id }))!;
}

/** The shop and its order desk hear about the delivery. */
export async function tellStore(app: FastifyInstance, db: Database, job: Pick<DeliveryJobDoc, "orderId" | "shopId" | "vendorId">, actor: ObjectId, title: string, body: string) {
  await notifyShop(db, app.log, { actor, type: "shop.updated", title, body, to: await shopPeople(db, { _id: job.orderId, businessId: job.shopId, vendorId: job.vendorId }) });
}

/** A partner offer nobody took in time goes back to the shop. */
async function expireShopOffer(app: FastifyInstance, db: Database, o: ShopOrderDoc, now: Date): Promise<boolean> {
  if (o.delivery?.status !== "offered" || !o.delivery.offerUntil || o.delivery.offerUntil > now) return false;
  try {
    await endBeforePickup(db, { _id: o.delivery.jobId, orderId: o._id, orderType: "shop_order" }, ["offered"], { by: "system", reason: "No Ruxstar partner accepted it in time.", at: now }, {
      jobFilter: { offerUntil: { $lte: now } },
    });
  } catch (err) {
    if (err instanceof AppError && err.code === "JOB_TAKEN") return false;
    throw err;
  }
  await tellStore(app, db, { orderId: o._id, shopId: o.businessId, vendorId: o.vendorId }, o.vendorId, `Nobody took order #${o.orderNo}`, "No Ruxstar partner accepted it in time. Try again, send someone on your team, or deliver it yourself.");
  return true;
}

export async function sweepShopOffers(app: FastifyInstance, db: Database, now = new Date()) {
  const due = await db.shopOrders.find({ "delivery.status": "offered", "delivery.offerUntil": { $lte: now } }).limit(200).toArray();
  let expired = 0;
  for (const o of due) {
    try {
      if (await expireShopOffer(app, db, o, now)) expired += 1;
    } catch (err) {
      app.log.error({ err: (err as Error).message, order: o._id.toHexString() }, "Offer expiry failed; it is retried on the next run");
    }
  }
  return { checked: due.length, expired };
}

// The rider's side, called by the delivery app's routes for a local shop's job.

async function orderOf(db: Database, job: DeliveryJobDoc) {
  const o = await db.shopOrders.findOne({ _id: job.orderId });
  if (!o || !o.delivery?.jobId.equals(job._id)) throw new AppError("JOB_TAKEN");
  return o;
}

/** The rider has the parcel: the order is out for delivery and the customer gets the code to give at the door. */
export async function shopPickedUp(app: FastifyInstance, db: Database, job: DeliveryJobDoc, riderId: ObjectId) {
  const o = await orderOf(db, job);
  if (o.status !== "packed") throw new AppError("ORDER_STATE");
  const now = new Date();
  const name = o.delivery?.rider?.name ?? "Your rider";
  await moveShopOrder(app, db, o, "out_for_delivery", { kind: "rider", actor: riderActor(riderId) }, {
    set: { "delivery.status": "picked_up" },
    inside: async (session) => {
      const res = await db.deliveryJobs.updateOne(
        { _id: job._id, status: "accepted", riderId },
        { $set: { status: "picked_up", updatedAt: now }, $push: { timeline: { status: "picked_up", at: now } } },
        { session },
      );
      if (res.matchedCount === 0) throw new AppError("JOB_TAKEN");
    },
    news: ["On the way", `${name} has your order. Give them the code ${job.dropCode} at the door.`],
  });
}

/** The customer's code matched: delivered, and a Ruxstar partner's pay moves to them out of the shop's share. */
export async function shopDelivered(app: FastifyInstance, db: Database, job: DeliveryJobDoc, riderId: ObjectId) {
  const o = await orderOf(db, job);
  if (o.status !== "out_for_delivery") throw new AppError("ORDER_STATE");
  const now = new Date();
  const partner = job.carrier === "partner";
  const hold = partner && job.pay > 0 ? { "delivery.releaseAt": new Date(now.getTime() + HOLD_MS), "delivery.releasedAt": null } : {};
  await moveShopOrder(app, db, o, "delivered", { kind: "rider", actor: riderActor(riderId) }, {
    set: { "delivery.status": "delivered", ...(partner ? { "delivery.paidAt": now } : {}), ...hold },
    inside: async (session, after) => {
      const res = await db.deliveryJobs.updateOne(
        { _id: job._id, status: "picked_up", riderId },
        { $set: { status: "delivered", updatedAt: now }, $unset: { busy: "" }, $push: { timeline: { status: "delivered", at: now } } },
        { session },
      );
      if (res.matchedCount === 0) throw new AppError("JOB_TAKEN");
      if (partner && job.pay > 0) for (const entry of shopRiderPayLedger(after, riderId, job.pay, now)) await db.ledgerEntries.insertOne(entry, { session });
    },
  });
  const name = o.delivery?.rider?.name ?? "The rider";
  await tellStore(app, db, job, riderId, `Order #${job.orderNo} delivered`, partner ? `${name} delivered it. ${rupees(job.pay)} of your share goes to them.` : `${name} delivered it.`);
}

/** The rider can't finish after pickup: the order is packed again, for the shop to send another way. */
export async function shopTripBack(app: FastifyInstance, db: Database, job: DeliveryJobDoc, riderId: ObjectId, cancel: NonNullable<DeliveryJobDoc["cancel"]>) {
  const o = await orderOf(db, job);
  if (o.status !== "out_for_delivery") throw new AppError("ORDER_STATE");
  await moveShopOrder(app, db, o, "packed", { kind: "rider", actor: riderActor(riderId) }, {
    set: { "delivery.status": "cancelled" },
    inside: async (session) => {
      const res = await db.deliveryJobs.updateOne(
        { _id: job._id, status: "picked_up", riderId },
        { $set: { status: "cancelled", cancel, updatedAt: cancel.at }, $unset: { busy: "" }, $push: { timeline: { status: "cancelled", at: cancel.at } } },
        { session },
      );
      if (res.matchedCount === 0) throw new AppError("JOB_TAKEN");
    },
    news: ["Delivery delayed", "The rider couldn't bring it this time. The shop will send it again soon."],
  });
}
