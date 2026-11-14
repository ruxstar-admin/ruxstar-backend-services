import { randomInt, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { MongoServerError, ObjectId, type ClientSession, type WithId } from "mongodb";
import { writeAudit } from "../../platform/audit.js";
import { stamp, type AuditLogDoc, type Database, type DeliveryJobDoc, type OrderDelivery, type PodOrderDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { toPrivateJpeg } from "../../platform/private-photo.js";
import { notifyOrder, notifyRider } from "../notifications/notify.js";
import { moveOrder, riderHeld, riderPayLedger, rupees, shopShareLeft } from "../pod/orders.js";
import type { Job } from "./contracts.js";
import { deliveryRules, rateFor, roadKm, type DeliveryRules } from "./rates.js";
import { OPEN_TRIP, tripActive } from "./stop.js";

const MAX_CODE_TRIES = 5;
/** Partner offers go to at most this many riders at once. */
const OFFER_FANOUT = 100;

type Rider = NonNullable<OrderDelivery["rider"]>;
type By = { actor: AuditLogDoc["actor"]; ip: string | null };

const cityKey = (city: string | null | undefined) => city?.trim().toLowerCase() ?? "";
const dropCode = () => String(randomInt(0, 10_000)).padStart(4, "0");
const vehicleLine = (r: Rider) => `${r.vehicle.type === "bike" ? "Bike" : "Scooter"} ${r.vehicle.number}`;

/** A delivery-verified person as a shop and its customer see them, or null when they can't deliver. */
export async function riderProfile(db: Database, userId: ObjectId): Promise<Rider | null> {
  const [user, kyc] = await Promise.all([
    db.users.findOne({ _id: userId, status: "active" }, { projection: { name: 1, username: 1, phone: 1, avatar: 1, roles: 1, kyc: 1 } }),
    db.kycCases.findOne({ userId, track: "delivery", status: "approved" }, { projection: { "steps.vehicle": 1 } }),
  ]);
  const vehicle = kyc?.steps.vehicle;
  if (!user?.roles.delivery || user.kyc.delivery !== "approved" || !vehicle?.type || !vehicle.number) return null;
  return {
    id: user._id,
    name: user.name || (user.username ? `@${user.username}` : "Your rider"),
    phone: user.phone,
    avatar: user.avatar ?? null,
    vehicle: { type: vehicle.type, number: vehicle.number },
  };
}

// The shop's side.

async function shopOf(db: Database, order: PodOrderDoc) {
  const shop = await db.businesses.findOne({ _id: order.shopId }, { projection: { name: 1, phone: 1, location: 1 } });
  if (!shop) throw new AppError("NOT_FOUND", "Shop not found.");
  return shop;
}

/** Whether a Ruxstar partner can take this order, and what they'd be paid. */
function partnerQuote(order: PodOrderDoc, shop: Awaited<ReturnType<typeof shopOf>>, rules: DeliveryRules) {
  const distanceKm = roadKm(shop.location?.point, order.address.point);
  const pay = rateFor(rules.riderRate, distanceKm);
  const reason = !rules.partners
    ? "Ruxstar delivery partners aren't available yet."
    : !shop.location?.point
      ? "Pin your shop on the map in its details to use Ruxstar partners."
      : !order.address.point
        ? "The customer's address couldn't be found on the map, so a partner can't be sent."
        : pay > shopShareLeft(order) - riderHeld(order)
          ? `Your share of this order is less than the partner's ${rupees(pay)}.`
          : null;
  return { distanceKm, pay, reason };
}

const assignProblem = (order: PodOrderDoc) =>
  tripActive(order) ? "A rider has this order. Cancel that delivery first." : order.status !== "ready" ? "Mark the order ready first." : null;

/** Who can take an order to the customer: someone on the team with "Deliver orders", or a Ruxstar partner. The shop can always do it itself. */
export async function deliveryOptions(db: Database, order: PodOrderDoc) {
  const [shop, rules, places] = await Promise.all([
    shopOf(db, order),
    deliveryRules(db),
    db.employments.find({ businessId: order.shopId, status: "active", current: true, permissions: "orders.deliver" }).toArray(),
  ]);
  const team = await Promise.all(
    places.map(async (place) => {
      const [user, rider] = await Promise.all([
        db.users.findOne({ _id: place.userId }, { projection: { name: 1, username: 1, avatar: 1 } }),
        riderProfile(db, place.userId),
      ]);
      return {
        placeId: place._id.toHexString(),
        name: user?.name || (user?.username ? `@${user.username}` : "Someone"),
        avatarUrl: user?.avatar ?? null,
        vehicle: rider?.vehicle ?? null,
        ready: !!rider,
      };
    }),
  );
  const quote = partnerQuote(order, shop, rules);
  const city = cityKey(shop.location?.city);
  const online = rules.partners && city ? await db.riderStates.countDocuments({ online: true, city }) : 0;
  const problem = assignProblem(order);
  return {
    orderStatus: order.status,
    canAssign: !problem,
    reason: problem,
    team,
    partner: { available: !quote.reason, reason: quote.reason, pay: quote.pay, distanceKm: quote.distanceKm, online },
  };
}

const alreadyRunning = (err: unknown) => err instanceof MongoServerError && err.code === 11000;

/** Hands a ready order to someone on the team, or offers it to the Ruxstar partners online in the shop's city. */
export async function assignTrip(
  app: FastifyInstance,
  db: Database,
  order: PodOrderDoc,
  choice: { carrier: "team"; placeId: string } | { carrier: "partner" },
  by: By,
): Promise<PodOrderDoc> {
  const problem = assignProblem(order);
  if (problem) throw new AppError("ORDER_STATE", problem);
  const [shop, rules] = await Promise.all([shopOf(db, order), deliveryRules(db)]);
  const now = new Date();
  const city = cityKey(shop.location?.city);

  let riderId: ObjectId | null = null;
  let placeId: ObjectId | null = null;
  let pay = 0;
  let distanceKm = roadKm(shop.location?.point, order.address.point);
  let offerUntil: Date | null = null;
  if (choice.carrier === "team") {
    const place = await db.employments.findOne({
      _id: new ObjectId(choice.placeId),
      businessId: order.shopId,
      status: "active",
      current: true,
      permissions: "orders.deliver",
    });
    if (!place) throw new AppError("VALIDATION_FAILED", 'Pick someone on the team with "Deliver orders".', [{ path: "body/placeId", message: "Not on the team" }]);
    if (!(await riderProfile(db, place.userId))) {
      throw new AppError("VALIDATION_FAILED", "They need delivery verification first, from the delivery icon on their profile.", [
        { path: "body/placeId", message: "Not delivery verified" },
      ]);
    }
    riderId = place.userId;
    placeId = place._id;
  } else {
    const quote = partnerQuote(order, shop, rules);
    if (quote.reason) throw new AppError("ORDER_STATE", quote.reason);
    pay = quote.pay;
    distanceKm = quote.distanceKm;
    offerUntil = new Date(now.getTime() + rules.offerMinutes * 60_000);
  }

  const location = shop.location;
  const job: DeliveryJobDoc = {
    _id: new ObjectId(),
    orderId: order._id,
    orderNo: order.orderNo,
    shopId: order.shopId,
    vendorId: order.vendorId,
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
    drop: { ...order.address, point: order.address.point ?? null },
    item: `${order.productLabel} × ${order.quantity}`,
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
  const delivery: OrderDelivery = {
    jobId: job._id,
    carrier: job.carrier,
    status: "offered",
    rider: null,
    pay,
    paidAt: null,
    dropCode: job.dropCode,
    offerUntil,
  };

  const updated = await db.transaction(async (session) => {
    const after = await db.podOrders.findOneAndUpdate(
      { _id: order._id, status: "ready", "delivery.status": { $nin: OPEN_TRIP } },
      { $set: { delivery, updatedAt: now } },
      { session, returnDocument: "after" },
    );
    if (!after) throw new AppError("ORDER_STATE");
    await db.deliveryJobs.insertOne(job, { session });
    await writeAudit(
      db,
      {
        actor: by.actor,
        scope: { module: "delivery", businessId: order.shopId },
        action: "delivery.assign",
        target: { type: "pod_order", id: order._id },
        diff: { carrier: { from: null, to: choice.carrier }, ...(riderId ? { rider: { from: null, to: riderId.toHexString() } } : {}) },
        ip: by.ip,
      },
      session,
    );
    return after;
  });

  const actor = by.actor.id ?? order.vendorId;
  if (riderId) {
    await notifyRider(db, app.log, {
      to: [riderId],
      actor,
      type: "delivery.offer",
      jobId: job._id,
      title: `Deliver for ${shop.name}`,
      body: `Order #${order.orderNo} to ${order.address.city}. Accept it in the Ruxstar Delivery app.`,
    });
  } else {
    const riders = await db.riderStates.find({ online: true, city }, { projection: { _id: 1 } }).limit(OFFER_FANOUT).toArray();
    await notifyRider(db, app.log, {
      to: riders.map((r) => r._id).filter((id) => !id.equals(order.vendorId)),
      actor,
      type: "delivery.offer",
      jobId: job._id,
      title: `New delivery: ${rupees(pay)}`,
      body: `${shop.name} to ${order.address.city}${distanceKm ? `, about ${distanceKm} km` : ""}. First to accept gets it.`,
    });
  }
  return updated;
}

/** Ends a trip that hasn't been picked up: the job is cancelled and the order is the shop's to deliver again. */
async function endBeforePickup(
  db: Database,
  job: Pick<DeliveryJobDoc, "_id" | "orderId">,
  from: DeliveryJobDoc["status"][],
  cancel: NonNullable<DeliveryJobDoc["cancel"]>,
  extra: { session?: ClientSession; jobFilter?: Record<string, unknown> } = {},
) {
  const run = async (session: ClientSession) => {
    const res = await db.deliveryJobs.updateOne(
      { _id: job._id, status: { $in: from }, ...extra.jobFilter },
      { $set: { status: "cancelled", cancel, updatedAt: cancel.at }, $unset: { busy: "" }, $push: { timeline: { status: "cancelled", at: cancel.at } } },
      { session },
    );
    if (res.matchedCount === 0) throw new AppError("JOB_TAKEN");
    await db.podOrders.updateOne(
      { _id: job.orderId, "delivery.jobId": job._id },
      { $set: { "delivery.status": "cancelled", updatedAt: cancel.at } },
      { session },
    );
  };
  if (extra.session) await run(extra.session);
  else await db.transaction(run);
}

/** The shop takes the delivery back before it is picked up. */
export async function cancelTrip(app: FastifyInstance, db: Database, order: PodOrderDoc, by: By): Promise<PodOrderDoc> {
  const delivery = order.delivery;
  if (!delivery || !tripActive(order)) throw new AppError("CONFLICT", "Nobody is delivering this order.");
  if (delivery.status === "picked_up") throw new AppError("ORDER_STATE", "The rider has it already. Call them if it must come back.");
  const job = await db.deliveryJobs.findOne({ _id: delivery.jobId });
  if (!job) throw new AppError("NOT_FOUND", "Delivery not found.");
  await db.transaction(async (session) => {
    await endBeforePickup(db, job, ["offered", "accepted"], { by: "shop", reason: "The shop cancelled the delivery.", at: new Date() }, { session });
    await writeAudit(
      db,
      {
        actor: by.actor,
        scope: { module: "delivery", businessId: order.shopId },
        action: "delivery.cancel",
        target: { type: "pod_order", id: order._id },
        diff: { delivery: { from: delivery.status, to: "cancelled" } },
        ip: by.ip,
      },
      session,
    );
  });
  if (job.riderId) {
    await notifyRider(db, app.log, {
      to: [job.riderId],
      actor: by.actor.id ?? order.vendorId,
      type: "delivery.updated",
      jobId: job._id,
      title: "Delivery cancelled",
      body: `The shop cancelled the delivery of order #${order.orderNo}. You don't need to pick it up.`,
    });
  }
  return (await db.podOrders.findOne({ _id: order._id }))!;
}

/** The shop hears about its delivery, as owner. */
const tellShop = (app: FastifyInstance, db: Database, job: DeliveryJobDoc, actor: ObjectId, title: string, body: string) =>
  notifyOrder(db, app.log, { to: job.vendorId, actor, orderId: job.orderId, type: "order.updated", forShop: true, title, body });

export const offerExpired = (order: PodOrderDoc, now = new Date()) =>
  order.delivery?.status === "offered" && !!order.delivery.offerUntil && order.delivery.offerUntil <= now;

/** A partner offer nobody took in time goes back to the shop. */
export async function expireOffer(app: FastifyInstance, db: Database, order: PodOrderDoc, now = new Date()): Promise<PodOrderDoc> {
  if (!offerExpired(order, now)) return order;
  const job = { _id: order.delivery!.jobId, orderId: order._id };
  try {
    await endBeforePickup(db, job, ["offered"], { by: "system", reason: "No Ruxstar partner accepted it in time.", at: now }, {
      jobFilter: { offerUntil: { $lte: now } },
    });
  } catch (err) {
    if (!(err instanceof AppError && err.code === "JOB_TAKEN")) throw err;
    return (await db.podOrders.findOne({ _id: order._id })) ?? order;
  }
  await notifyOrder(db, app.log, {
    to: order.vendorId,
    actor: order.vendorId,
    orderId: order._id,
    type: "order.updated",
    forShop: true,
    title: `Nobody took order #${order.orderNo}`,
    body: "No Ruxstar partner accepted it in time. Try again, send someone on your team, or deliver it yourself.",
  });
  return (await db.podOrders.findOne({ _id: order._id })) ?? order;
}

// The rider's side.

const iso = (at: Date | null | undefined) => at?.toISOString() ?? null;

/** A job as a rider sees it. Before it is theirs, the customer's name, phone and street stay hidden. */
export function jobView(job: DeliveryJobDoc, riderId: ObjectId): Job {
  const mine = !!job.riderId?.equals(riderId) && job.status !== "offered";
  return {
    id: job._id.toHexString(),
    orderNo: job.orderNo,
    carrier: job.carrier,
    status: job.status,
    shop: {
      name: job.pickup.name,
      phone: mine ? job.pickup.phone || null : null,
      line: job.pickup.line || null,
      area: job.pickup.city,
      point: job.pickup.point,
    },
    drop: {
      name: mine ? job.drop.name : "Customer",
      phone: mine ? job.drop.phone : null,
      line: mine ? job.drop.line : null,
      area: `${job.drop.city} ${job.drop.pincode}`,
      point: mine ? job.drop.point : null,
    },
    item: job.item,
    distanceKm: job.distanceKm,
    pay: job.pay,
    offerUntil: job.status === "offered" ? iso(job.offerUntil) : null,
    proof: !!job.proof,
    cancel: job.cancel ? { by: job.cancel.by, reason: job.cancel.reason, at: job.cancel.at.toISOString() } : null,
    timeline: job.timeline.map((t) => ({ status: t.status, at: t.at.toISOString() })),
    createdAt: job.createdAt.toISOString(),
  };
}

/** Offers a rider can see: Ruxstar partner offers in their city while they're online, and offers from shops they deliver for. */
export async function offersFor(db: Database, riderId: ObjectId, now = new Date()) {
  const state = await db.riderStates.findOne({ _id: riderId });
  const rules = await deliveryRules(db);
  const partner =
    state?.online && state.city && rules.partners
      ? { carrier: "partner" as const, status: "offered" as const, city: state.city, offerUntil: { $gt: now }, passedBy: { $ne: riderId } }
      : null;
  const team = { carrier: "team" as const, status: "offered" as const, riderId };
  return db.deliveryJobs
    .find(partner ? { $or: [partner, team] } : team)
    .sort({ createdAt: -1 })
    .limit(30)
    .toArray();
}

/** A job the rider has, or one offered to them. */
export async function jobFor(db: Database, id: string, riderId: ObjectId): Promise<WithId<DeliveryJobDoc>> {
  const job = await db.deliveryJobs.findOne({ _id: new ObjectId(id) });
  if (!job) throw new AppError("NOT_FOUND", "Delivery not found.");
  if (job.riderId?.equals(riderId) || (job.carrier === "partner" && job.status === "offered")) return job;
  if (job.carrier === "partner") throw new AppError("JOB_TAKEN");
  throw new AppError("NOT_FOUND", "Delivery not found.");
}

const riderActor = (riderId: ObjectId): AuditLogDoc["actor"] => ({ id: riderId, kind: "user" });

export async function acceptJob(app: FastifyInstance, db: Database, job: DeliveryJobDoc, riderId: ObjectId): Promise<DeliveryJobDoc> {
  const rider = await riderProfile(db, riderId);
  if (!rider) throw new AppError("KYC_REQUIRED");
  if (job.status !== "offered") throw new AppError("JOB_TAKEN");
  const now = new Date();
  if (job.carrier === "team") {
    const place = await db.employments.findOne({ _id: job.placeId!, userId: riderId, status: "active", current: true, permissions: "orders.deliver" });
    if (!place) throw new AppError("FORBIDDEN", "You no longer deliver for this shop.");
  } else {
    const state = await db.riderStates.findOne({ _id: riderId });
    if (!state?.online) throw new AppError("CONFLICT", "Go online to take deliveries.");
    if (job.vendorId.equals(riderId)) throw new AppError("FORBIDDEN", "This is your own shop's order. Deliver it from the vendor portal.");
  }
  if (await db.deliveryJobs.findOne({ riderId, busy: true }, { projection: { _id: 1 } })) {
    throw new AppError("CONFLICT", "Finish the delivery you have first.");
  }
  const filter =
    job.carrier === "team"
      ? { _id: job._id, status: "offered" as const, riderId }
      : { _id: job._id, status: "offered" as const, carrier: "partner" as const, offerUntil: { $gt: now }, passedBy: { $ne: riderId } };
  let accepted: DeliveryJobDoc | null;
  try {
    accepted = await db.transaction(async (session) => {
      const after = await db.deliveryJobs.findOneAndUpdate(
        filter,
        { $set: { status: "accepted", riderId, busy: true, updatedAt: now }, $push: { timeline: { status: "accepted", at: now } } },
        { session, returnDocument: "after" },
      );
      if (!after) throw new AppError("JOB_TAKEN");
      const res = await db.podOrders.updateOne(
        { _id: job.orderId, status: "ready", "delivery.jobId": job._id, "delivery.status": "offered" },
        { $set: { "delivery.status": "accepted", "delivery.rider": rider, "delivery.offerUntil": null, updatedAt: now } },
        { session },
      );
      if (res.matchedCount === 0) throw new AppError("JOB_TAKEN");
      return after;
    });
  } catch (err) {
    if (alreadyRunning(err)) throw new AppError("CONFLICT", "Finish the delivery you have first.");
    throw err;
  }
  await tellShop(app, db, job, riderId, `Rider for order #${job.orderNo}`, `${rider.name} is coming to pick it up. ${vehicleLine(rider)}.`);
  return accepted!;
}

/** A partner skips an offer; someone on the team turning one down sends it back to the shop. */
export async function passJob(app: FastifyInstance, db: Database, job: DeliveryJobDoc, riderId: ObjectId): Promise<DeliveryJobDoc> {
  if (job.status !== "offered") throw new AppError("JOB_TAKEN");
  if (job.carrier === "partner") {
    await db.deliveryJobs.updateOne({ _id: job._id }, { $addToSet: { passedBy: riderId } });
    return (await db.deliveryJobs.findOne({ _id: job._id }))!;
  }
  const at = new Date();
  await endBeforePickup(db, job, ["offered"], { by: "rider", reason: "Turned down by the rider.", at }, { jobFilter: { riderId } });
  const user = await db.users.findOne({ _id: riderId }, { projection: { name: 1 } });
  await tellShop(app, db, job, riderId, `Order #${job.orderNo} needs a rider`, `${user?.name || "Your team member"} can't take it. Pick someone else.`);
  return (await db.deliveryJobs.findOne({ _id: job._id }))!;
}

async function orderOf(db: Database, job: DeliveryJobDoc) {
  const order = await db.podOrders.findOne({ _id: job.orderId });
  if (!order || !order.delivery?.jobId.equals(job._id)) throw new AppError("JOB_TAKEN");
  return order;
}

const mustHave = (job: DeliveryJobDoc, riderId: ObjectId, status: DeliveryJobDoc["status"][]) => {
  if (!job.riderId?.equals(riderId) || job.status === "offered") throw new AppError("NOT_FOUND", "Delivery not found.");
  if (!status.includes(job.status)) throw new AppError("JOB_TAKEN");
};

/** The rider has the parcel: the order is out for delivery and the customer gets the code to give at the door. */
export async function pickUp(app: FastifyInstance, db: Database, job: DeliveryJobDoc, riderId: ObjectId): Promise<DeliveryJobDoc> {
  mustHave(job, riderId, ["accepted"]);
  const order = await orderOf(db, job);
  if (order.status !== "ready") throw new AppError("ORDER_STATE");
  const now = new Date();
  const name = order.delivery?.rider?.name ?? "Your rider";
  await moveOrder(app, db, order, "out_for_delivery", { kind: "rider", actor: riderActor(riderId) }, {
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
  return (await db.deliveryJobs.findOne({ _id: job._id }))!;
}

export const proofKey = (jobId: ObjectId, at: Date) => `delivery/${jobId.toHexString()}/proof-${at.getTime()}.jpg`;

/** A photo of the parcel at the door, before the code. Kept 30 days, privately. */
export async function addProof(app: FastifyInstance, db: Database, job: DeliveryJobDoc, riderId: ObjectId, image: unknown): Promise<DeliveryJobDoc> {
  mustHave(job, riderId, ["picked_up"]);
  const jpeg = await toPrivateJpeg(image);
  const now = new Date();
  const key = proofKey(job._id, now);
  await app.printFiles.save(key, jpeg, "image/jpeg");
  const res = await db.deliveryJobs.updateOne(
    { _id: job._id, status: "picked_up", riderId },
    { $set: { proof: { key, bytes: jpeg.length, at: now }, updatedAt: now } },
  );
  if (res.matchedCount === 0) {
    await app.printFiles.remove(key);
    throw new AppError("JOB_TAKEN");
  }
  if (job.proof) await app.printFiles.remove(job.proof.key);
  return (await db.deliveryJobs.findOne({ _id: job._id }))!;
}

const sameCode = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The customer's code matches: delivered, and a Ruxstar partner's pay moves to them out of the shop's share. */
export async function deliver(app: FastifyInstance, db: Database, job: DeliveryJobDoc, riderId: ObjectId, code: string): Promise<DeliveryJobDoc> {
  mustHave(job, riderId, ["picked_up"]);
  if (!job.proof) throw new AppError("CONFLICT", "Add a photo of the parcel at the door first.");
  if (job.codeTries >= MAX_CODE_TRIES) {
    throw new AppError("RATE_LIMITED", "Too many wrong codes. Call the customer, or hand the delivery back to the shop.");
  }
  if (!sameCode(code, job.dropCode)) {
    await db.deliveryJobs.updateOne({ _id: job._id }, { $inc: { codeTries: 1 } });
    throw new AppError("DROP_CODE_INVALID");
  }
  const order = await orderOf(db, job);
  if (order.status !== "out_for_delivery") throw new AppError("ORDER_STATE");
  const now = new Date();
  const partner = job.carrier === "partner";
  await moveOrder(app, db, order, "delivered", { kind: "rider", actor: riderActor(riderId) }, {
    set: { "delivery.status": "delivered", ...(partner ? { "delivery.paidAt": now } : {}) },
    inside: async (session, after) => {
      const res = await db.deliveryJobs.updateOne(
        { _id: job._id, status: "picked_up", riderId },
        { $set: { status: "delivered", updatedAt: now }, $unset: { busy: "" }, $push: { timeline: { status: "delivered", at: now } } },
        { session },
      );
      if (res.matchedCount === 0) throw new AppError("JOB_TAKEN");
      if (partner && job.pay > 0) for (const entry of riderPayLedger(after, riderId, job.pay, now)) await db.ledgerEntries.insertOne(entry, { session });
    },
  });
  const name = order.delivery?.rider?.name ?? "The rider";
  await tellShop(
    app,
    db,
    job,
    riderId,
    `Order #${job.orderNo} delivered`,
    partner ? `${name} delivered it. ${rupees(job.pay)} of your share went to them.` : `${name} delivered it.`,
  );
  return (await db.deliveryJobs.findOne({ _id: job._id }))!;
}

/** The rider can't finish: the order goes back to the shop, which is told why. After pickup it is ready again. */
export async function riderCancel(app: FastifyInstance, db: Database, job: DeliveryJobDoc, riderId: ObjectId, reason: string): Promise<DeliveryJobDoc> {
  mustHave(job, riderId, ["accepted", "picked_up"]);
  const now = new Date();
  const cancel = { by: "rider" as const, reason, at: now };
  if (job.status === "accepted") {
    await endBeforePickup(db, job, ["accepted"], cancel, { jobFilter: { riderId } });
  } else {
    const order = await orderOf(db, job);
    if (order.status !== "out_for_delivery") throw new AppError("ORDER_STATE");
    await moveOrder(app, db, order, "ready", { kind: "rider", actor: riderActor(riderId) }, {
      set: { "delivery.status": "cancelled" },
      inside: async (session) => {
        const res = await db.deliveryJobs.updateOne(
          { _id: job._id, status: "picked_up", riderId },
          { $set: { status: "cancelled", cancel, updatedAt: now }, $unset: { busy: "" }, $push: { timeline: { status: "cancelled", at: now } } },
          { session },
        );
        if (res.matchedCount === 0) throw new AppError("JOB_TAKEN");
      },
      news: ["Delivery delayed", "The rider couldn't bring it this time. The shop will send it again soon."],
    });
  }
  const user = await db.users.findOne({ _id: riderId }, { projection: { name: 1 } });
  const back = job.status === "picked_up" ? " They have the parcel, so arrange to get it back." : "";
  await tellShop(app, db, job, riderId, `Delivery of #${job.orderNo} stopped`, `${user?.name || "The rider"}: ${reason}${back}`);
  return (await db.deliveryJobs.findOne({ _id: job._id }))!;
}

/** Ruxstar partner offers nobody took in time, for the 10-minute job. */
export async function sweepOffers(app: FastifyInstance, db: Database, now = new Date()) {
  const due = await db.podOrders.find({ "delivery.status": "offered", "delivery.offerUntil": { $lte: now } }).limit(200).toArray();
  let expired = 0;
  for (const order of due) {
    try {
      const after = await expireOffer(app, db, order, now);
      if (after.delivery?.status === "cancelled") expired += 1;
    } catch (err) {
      app.log.error({ err: (err as Error).message, order: order._id.toHexString() }, "Offer expiry failed; it is retried on the next run");
    }
  }
  return { checked: due.length, expired };
}
