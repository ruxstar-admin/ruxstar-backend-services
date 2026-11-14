import type { FastifyInstance } from "fastify";
import { MongoServerError, ObjectId, type ClientSession, type WithId } from "mongodb";
import { writeAudit } from "../../platform/audit.js";
import type {
  AuditLogDoc,
  CoachingBatchDoc,
  CoachingCourseDoc,
  CoachingOrderDoc,
  CoachingSessionDoc,
  Database,
  NotificationDoc,
} from "../../platform/db.js";
import { stamp } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { checkCode, giveBack, redeem } from "../coupons/coupons.js";
import { creditOrder, invoiceCoachingOrder } from "../invoices/issue.js";
import { notifyCoaching } from "../notifications/notify.js";
import { rupees } from "../pod/orders.js";
import {
  certificateCode,
  coachingLedger,
  coachingSettings,
  DAY_MS,
  HOUR_MS,
  MAX_ORDER_TOTAL,
  nextCoachingOrderNo,
  PAY_WINDOW_MS,
  vendorShare,
} from "./rules.js";

export interface By {
  kind: "customer" | "vendor" | "staff" | "system";
  actor: AuditLogDoc["actor"];
  ip?: string | null;
}
export const SYSTEM: By = { kind: "system", actor: { id: null, kind: "system" } };

type Link = NotificationDoc["link"];
type Told = { userId: ObjectId; link: Link }[];

const invalid = (path: string, message: string) => new AppError("ORDER_INVALID", message, [{ path, message }]);
export const when = (at: Date) =>
  at.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const orderLink = (order: Pick<CoachingOrderDoc, "_id">): Link => ({ screen: "coaching_order", id: order._id.toHexString() });
export const courseLink = (courseId: ObjectId): Link => ({ screen: "vendor_course", id: courseId.toHexString() });
const OPEN = ["awaiting_payment", "confirmed"] as const;

export const seatOf = (kind: CoachingOrderDoc["kind"], course: ObjectId, batch: ObjectId, studentKey: string) =>
  kind === "batch" ? `batch:${batch.toHexString()}:${studentKey}` : `demo:${course.toHexString()}:${studentKey}`;

const returnSeat = (db: Database, order: CoachingOrderDoc, session: ClientSession) =>
  order.kind === "batch"
    ? db.coachingBatches.updateOne({ _id: order.batchId }, { $inc: { seatsLeft: 1 } }, { session })
    : db.coachingSessions.updateOne({ _id: order.sessionId!, demos: { $gt: 0 } }, { $inc: { demos: -1 } }, { session });

/**
 * Enrols a student in a batch, or books their demo class: checks the student and the course's rules, takes a place and saves
 * the order. Free ones are confirmed at once; paid ones hold the place for 20 minutes while the customer pays.
 */
export async function placeOrder(
  app: FastifyInstance,
  db: Database,
  input: {
    kind: CoachingOrderDoc["kind"];
    course: WithId<CoachingCourseDoc>;
    batch: WithId<CoachingBatchDoc>;
    session: WithId<CoachingSessionDoc> | null;
    customer: { id: ObjectId; phone: string; name: string | null };
    childId: string | null;
    coupon?: string;
  },
): Promise<CoachingOrderDoc> {
  const { kind, course, batch, customer } = input;
  const settings = await coachingSettings(db);
  const now = new Date();
  if (course.status !== "live" || batch.status !== "live" || !batch.courseId.equals(course._id)) {
    throw new AppError("NOT_FOUND", "This course isn't taking students.");
  }
  if (course.vendorId.equals(customer.id)) throw invalid("body/student", "You can't enrol in your own course.");

  let student: CoachingOrderDoc["student"];
  if (input.childId) {
    const child = await db.coachingChildren.findOne({ _id: new ObjectId(input.childId), parentId: customer.id });
    if (!child) throw invalid("body/student/childId", "Add this child to your account first.");
    student = { childId: child._id, name: child.name };
  } else {
    if (!customer.name) throw invalid("body/student", "Add your name to your profile first, or pick a child.");
    student = { childId: null, name: customer.name };
  }
  const studentKey = student.childId ? `child:${student.childId.toHexString()}` : `self:${customer.id.toHexString()}`;
  const who = student.childId ? student.name : "You";

  let items: number;
  let first: { startsAt: Date; endsAt: Date };
  if (kind === "batch") {
    if (batch.firstAt <= now) throw new AppError("CONFLICT", "Enrolment closed when this batch started.");
    items = batch.fee;
    first = { startsAt: batch.firstAt, endsAt: batch.firstEndsAt };
  } else {
    const session = input.session;
    if (!course.demo) throw invalid("body/sessionId", "This course doesn't offer a demo class.");
    if (!session || !session.batchId.equals(batch._id) || session.status !== "scheduled") {
      throw invalid("body/sessionId", "This class isn't on any more. Pick another.");
    }
    if (session.startsAt <= now) throw new AppError("CONFLICT", "This class has started. Pick another.");
    const enrolled = await db.coachingOrders.findOne(
      { courseId: course._id, studentKey, kind: "batch", status: { $in: [...OPEN] } },
      { projection: { _id: 1 } },
    );
    if (enrolled) throw new AppError("CONFLICT", `${who} ${student.childId ? "is" : "are"} already enrolled in this course.`);
    items = course.demo.fee;
    first = { startsAt: session.startsAt, endsAt: session.endsAt };
  }

  let coupon: CoachingOrderDoc["price"]["coupon"] = null;
  let discount = 0;
  if (input.coupon && items > 0) {
    const check = await checkCode(db, input.coupon, { module: "coaching", shop: { id: course.businessId, name: course.businessName }, customerId: customer.id, items });
    if (check.problem !== null) throw new AppError("COUPON_INVALID", check.problem, [{ path: "body/coupon", message: check.problem }]);
    coupon = { id: check.coupon._id, code: check.coupon.code, fundedBy: check.coupon.fundedBy };
    discount = check.discount;
  }
  const platformFee = items > 0 ? settings.platformFee : 0;
  const charged = coupon?.fundedBy === "vendor" ? items - discount : items;
  const total = items - discount + platformFee;
  if (total > MAX_ORDER_TOTAL) throw invalid("body", "Payments over ₹5,00,000 can't be made online.");
  const price: CoachingOrderDoc["price"] = {
    items,
    platformFee,
    total,
    commissionBps: settings.commissionBps,
    commission: Math.round((charged * settings.commissionBps) / 10_000),
    discount,
    coupon,
  };
  const free = total === 0;

  const id = new ObjectId();
  const order: CoachingOrderDoc = {
    _id: id,
    orderNo: 0,
    kind,
    courseId: course._id,
    batchId: batch._id,
    sessionId: input.session?._id ?? null,
    businessId: course.businessId,
    vendorId: course.vendorId,
    customerId: customer.id,
    student,
    studentKey,
    seat: seatOf(kind, course._id, batch._id, studentKey),
    courseTitle: course.title,
    batchName: batch.name,
    businessName: course.businessName,
    firstAt: first.startsAt,
    firstEndsAt: first.endsAt,
    price,
    status: free ? "confirmed" : "awaiting_payment",
    timeline: [
      { status: "awaiting_payment", at: now, by: "customer" },
      ...(free ? [{ status: "confirmed" as const, at: now, by: "customer" as const }] : []),
    ],
    payment: free ? null : { gatewayOrderId: `rxc_${id.toHexString()}`, sessionId: "", paymentId: null, paidAt: null },
    holdUntil: free ? null : new Date(now.getTime() + PAY_WINDOW_MS),
    refund: null,
    reason: null,
    releaseAt: null,
    releasedAt: null,
    ...stamp(now),
  };

  try {
    await db.transaction(async (session) => {
      const res =
        kind === "batch"
          ? await db.coachingBatches.updateOne({ _id: batch._id, status: "live", seatsLeft: { $gte: 1 } }, { $inc: { seatsLeft: -1 } }, { session })
          : await db.coachingSessions.updateOne(
              { _id: input.session!._id, status: "scheduled", demos: { $lt: course.demo!.seats } },
              { $inc: { demos: 1 } },
              { session },
            );
      if (!res.modifiedCount) throw new AppError("CONFLICT", kind === "batch" ? "This batch is full." : "This class has no demo places left. Pick another.");
      order.orderNo = await nextCoachingOrderNo(db, session);
      await db.coachingOrders.insertOne(order, { session });
    });
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 11000) {
      throw new AppError(
        "CONFLICT",
        kind === "batch"
          ? `${who} ${student.childId ? "is" : "are"} already in this batch.`
          : `${who} already had ${student.childId ? "their" : "your"} demo class for this course. Enrol in a batch to keep going.`,
      );
    }
    throw err;
  }

  if (free) {
    await tellEnrolled(app, db, order);
    return order;
  }
  try {
    const origin = app.config.apiUrl;
    const { sessionId } = await app.payments.createOrder({
      orderId: order.payment!.gatewayOrderId,
      amount: total,
      customer: { id: customer.id.toHexString(), phone: customer.phone.slice(-10), name: customer.name ?? student.name },
      note: `${kind === "demo" ? "Demo class" : "Batch fee"} for ${course.title}`,
      returnUrl: origin ? `${origin}/pay/coaching/${id.toHexString()}/done` : null,
      notifyUrl: origin ? `${origin}/webhooks/cashfree` : null,
    });
    const saved = await db.coachingOrders.findOneAndUpdate({ _id: id }, { $set: { "payment.sessionId": sessionId } }, { returnDocument: "after" });
    return saved ?? order;
  } catch (err) {
    await cancelOrder(app, db, order, SYSTEM, { reason: "The payment couldn't be set up.", gatewayKnown: false, quiet: true });
    throw err;
  }
}

async function tellEnrolled(app: FastifyInstance, db: Database, order: CoachingOrderDoc) {
  const share = vendorShare(order);
  const demo = order.kind === "demo";
  await notifyCoaching(db, app.log, {
    actor: order.customerId,
    type: "coaching.enrolled",
    title: demo ? `Demo class booked: ${order.courseTitle}` : `Enrolled: ${order.courseTitle}`,
    body: `${order.student.name}, ${order.batchName}. ${demo ? "The class is" : "First class"} ${when(order.firstAt)}.`,
    to: [{ userId: order.customerId, link: orderLink(order) }],
  });
  await notifyCoaching(db, app.log, {
    actor: order.customerId,
    type: "coaching.updated",
    title: demo ? `New demo student #${order.orderNo}` : `New enrolment #${order.orderNo}`,
    body: `${order.student.name} in ${order.courseTitle}, ${order.batchName}.${share > 0 ? ` ${rupees(share)} to you after ${demo ? "the class" : "the first class"}.` : ""}`,
    to: [{ userId: order.vendorId, link: courseLink(order.courseId) }],
  });
}

/** The payment went through: the place is the student's, and the money waits in pending until the first class ends. Safe to repeat. */
export async function confirmOrder(app: FastifyInstance, db: Database, order: CoachingOrderDoc, paymentId: string | null): Promise<CoachingOrderDoc> {
  const now = new Date();
  const after = await db.transaction(async (session) => {
    const current = await db.coachingOrders.findOne({ _id: order._id }, { session, projection: { firstEndsAt: 1 } });
    const done = await db.coachingOrders.findOneAndUpdate(
      { _id: order._id, status: "awaiting_payment" },
      {
        $set: {
          status: "confirmed",
          "payment.paymentId": paymentId,
          "payment.paidAt": now,
          holdUntil: null,
          releaseAt: current?.firstEndsAt ?? order.firstEndsAt,
          updatedAt: now,
        },
        $push: { timeline: { status: "confirmed", at: now, by: "system" } },
      },
      { session, returnDocument: "after" },
    );
    if (!done) return null;
    for (const entry of coachingLedger("payment", done, now)) await db.ledgerEntries.insertOne(entry, { session });
    await redeem(db, done, session);
    const issued = await invoiceCoachingOrder(db, done, session);
    if (issued.length) done.invoices = [...(done.invoices ?? []), ...issued];
    return done;
  });
  if (!after) return (await db.coachingOrders.findOne({ _id: order._id })) ?? order;
  await tellEnrolled(app, db, after);
  return after;
}

/**
 * Cancels an order: the place goes back and a paid order is refunded in full, platform fee included. A customer can only do
 * this before the first class it covers starts. An unpaid order's payment is stopped at Cashfree first; if it was paid
 * meanwhile, it is confirmed instead.
 */
export async function cancelOrder(
  app: FastifyInstance,
  db: Database,
  order: CoachingOrderDoc,
  by: By,
  opts: { reason: string; gatewayKnown?: boolean; quiet?: boolean },
): Promise<CoachingOrderDoc> {
  if (order.status === "cancelled") return order;
  if (order.releasedAt) throw new AppError("ORDER_STATE", "This place is settled already: the first class has happened.");
  if (by.kind === "customer" && order.status === "confirmed" && order.firstAt <= new Date()) {
    throw new AppError("ORDER_STATE", "Refunds stop once the first class starts.");
  }
  if (order.status === "awaiting_payment" && order.payment && opts.gatewayKnown !== false) {
    try {
      await app.payments.terminate(order.payment.gatewayOrderId);
    } catch {
      const now = await syncCoachingPayment(app, db, order, { noExpiry: true });
      if (now.status !== "confirmed") throw new AppError("PAYMENTS_UNAVAILABLE");
      if (by.kind === "customer" || by.kind === "system") return now;
      order = now;
    }
  }
  const now = new Date();
  const paid = order.status === "confirmed" && order.price.total > 0 && !!order.payment?.paidAt;
  const refund: CoachingOrderDoc["refund"] = paid
    ? { refundId: `rfc_${order._id.toHexString()}`, amount: order.price.total, reason: opts.reason, by: by.kind, status: "pending", at: now }
    : null;
  const after = await db.transaction(async (session) => {
    const done = await db.coachingOrders.findOneAndUpdate(
      { _id: order._id, status: order.status, releasedAt: null },
      {
        $set: { status: "cancelled", reason: opts.reason, refund, holdUntil: null, releaseAt: null, updatedAt: now },
        $unset: { seat: "" },
        $push: { timeline: { status: "cancelled", at: now, by: by.kind } },
      },
      { session, returnDocument: "after" },
    );
    if (!done) return null;
    await returnSeat(db, order, session);
    if (paid) {
      for (const entry of coachingLedger("refund", done, now)) await db.ledgerEntries.insertOne(entry, { session });
      await giveBack(db, done, session);
    }
    if (refund) {
      const credited = await creditOrder(db, "coaching_order", done._id, { id: refund.refundId, reason: refund.reason, amount: null }, session);
      if (credited.length) done.invoices = [...(done.invoices ?? []), ...credited];
    }
    if (by.kind !== "system") {
      await writeAudit(
        db,
        {
          actor: by.actor,
          scope: { module: "coaching", businessId: order.businessId },
          action: "coaching_order.cancel",
          target: { type: "coaching_order", id: order._id },
          diff: { status: { from: order.status, to: "cancelled" }, reason: { from: null, to: opts.reason } },
          ip: by.ip ?? null,
        },
        session,
      );
    }
    return done;
  });
  if (!after) {
    const current = await db.coachingOrders.findOne({ _id: order._id });
    if (current?.status === "cancelled") return current;
    throw new AppError("ORDER_STATE");
  }
  const result = refund ? await askCoachingRefund(app, db, after) : after;

  if (!opts.quiet) {
    const money = refund ? ` Your ${rupees(refund.amount)} is being refunded.` : "";
    const what = order.kind === "demo" ? "demo class" : "place";
    if (by.kind === "customer") {
      await notifyCoaching(db, app.log, {
        actor: order.customerId,
        type: "coaching.updated",
        title: `#${order.orderNo} cancelled`,
        body: `${order.student.name} gave up their ${what} in ${order.courseTitle}, ${order.batchName}.`,
        to: [{ userId: order.vendorId, link: courseLink(order.courseId) }],
      });
    } else if (order.status === "awaiting_payment") {
      await notifyCoaching(db, app.log, {
        actor: order.customerId,
        type: "coaching.updated",
        title: "Enrolment not completed",
        body: `The payment for ${order.courseTitle} didn't finish in time, so the place went back. Try again any time.`,
        to: [{ userId: order.customerId, link: { screen: "coaching_course", id: order.courseId.toHexString() } }],
      });
    } else {
      await notifyCoaching(db, app.log, {
        actor: by.actor.id ?? order.vendorId,
        type: "coaching.updated",
        title: `${order.courseTitle}: ${what} cancelled`,
        body: `${opts.reason}${money}`,
        to: [{ userId: order.customerId, link: orderLink(order) }],
      });
    }
  }
  return result;
}

/** Asks Cashfree for the refund, or how it's going. Safe to repeat; a failure leaves it pending for the next sweep. */
export async function askCoachingRefund(app: FastifyInstance, db: Database, order: CoachingOrderDoc): Promise<CoachingOrderDoc> {
  if (order.refund?.status !== "pending" || !order.payment) return order;
  try {
    const { status } = await app.payments.refund(order.payment.gatewayOrderId, order.refund.refundId, order.refund.amount, `Ruxstar classes #${order.orderNo}`);
    if (status === "pending") return order;
    return (
      (await db.coachingOrders.findOneAndUpdate(
        { _id: order._id, "refund.status": "pending" },
        { $set: { "refund.status": "done", updatedAt: new Date() } },
        { returnDocument: "after" },
      )) ?? order
    );
  } catch (err) {
    app.log.error({ err: (err as Error).message, order: order._id.toHexString() }, "Coaching refund not started; it is retried on the next sweep");
    return order;
  }
}

/** While an order waits for payment, asks Cashfree whether it was paid; once the 20 minutes are up, an unpaid one gives its place back. */
export async function syncCoachingPayment(
  app: FastifyInstance,
  db: Database,
  order: CoachingOrderDoc,
  { noExpiry = false }: { noExpiry?: boolean } = {},
): Promise<CoachingOrderDoc> {
  if (order.status !== "awaiting_payment" || !order.payment) return order.refund?.status === "pending" ? askCoachingRefund(app, db, order) : order;
  let answer: Awaited<ReturnType<typeof app.payments.status>>;
  try {
    answer = await app.payments.status(order.payment.gatewayOrderId);
  } catch {
    return order;
  }
  if (answer.status === "paid") return confirmOrder(app, db, order, answer.paymentId);
  if (noExpiry) return order;
  if (answer.status === "expired" || answer.status === "terminated") {
    return cancelOrder(app, db, order, SYSTEM, { reason: "The payment didn't go through.", gatewayKnown: false });
  }
  if (order.holdUntil && order.holdUntil.getTime() <= Date.now()) {
    return cancelOrder(app, db, order, SYSTEM, { reason: "The payment didn't finish in time." });
  }
  return order;
}

// Batches and courses.

/**
 * Cancels a batch, its classes to come, and every place in it, each refunded in full. The institute can only do this before
 * the first class; Ruxstar's take-down and the minimum check can do it later, and places already settled stay as they are.
 */
export async function cancelBatch(
  app: FastifyInstance,
  db: Database,
  batch: WithId<CoachingBatchDoc>,
  by: By,
  reason: string,
  { quiet = false }: { quiet?: boolean } = {},
): Promise<{ refunded: number; kept: number }> {
  if (batch.status === "cancelled") throw new AppError("CONFLICT", "This batch is cancelled already.");
  const now = new Date();
  if (by.kind === "vendor" && batch.firstAt <= now) throw new AppError("CONFLICT", "This batch has started. Cancel single classes instead.");
  const res = await db.coachingBatches.updateOne(
    { _id: batch._id, status: "live" },
    { $set: { status: "cancelled", cancellation: { by: by.kind === "customer" ? "system" : by.kind, actorId: by.actor.id, reason, at: now }, updatedAt: now } },
  );
  if (!res.modifiedCount) throw new AppError("CONFLICT");
  await db.coachingSessions.updateMany(
    { batchId: batch._id, status: "scheduled", startsAt: { $gt: now } },
    { $set: { status: "cancelled", cancellation: { by: by.actor.id ?? batch.vendorId, reason, at: now }, updatedAt: now } },
  );
  await writeAudit(db, {
    actor: by.actor,
    scope: { module: "coaching", businessId: batch.businessId },
    action: by.kind === "system" ? "coaching_batch.auto_cancel" : "coaching_batch.cancel",
    target: { type: "coaching_batch", id: batch._id },
    diff: { status: { from: "live", to: "cancelled" }, reason: { from: null, to: reason } },
    ip: by.ip ?? null,
  });

  const told: Told = [];
  let refunded = 0;
  let kept = 0;
  for await (const order of db.coachingOrders.find({ batchId: batch._id, status: { $in: [...OPEN] } })) {
    if (order.releasedAt) {
      kept++;
      continue;
    }
    try {
      const done = await cancelOrder(app, db, order, by, { reason, quiet: true });
      if (order.status === "confirmed") {
        told.push({ userId: done.customerId, link: orderLink(done) });
        refunded++;
      }
    } catch (err) {
      app.log.error({ err: (err as Error).message, order: order._id.toHexString() }, "Place not cancelled with its batch; the sweep retries it");
    }
  }
  const course = await db.coachingCourses.findOne({ _id: batch.courseId }, { projection: { title: 1 } });
  const title = `${course?.title ?? "Course"}, ${batch.name}`;
  if (!quiet) {
    await notifyCoaching(db, app.log, {
      actor: by.actor.id ?? batch.vendorId,
      type: "coaching.updated",
      title: `Cancelled: ${title}`,
      body: `${reason} Your fee is refunded in full.`,
      to: told,
    });
  }
  if (by.kind === "system") {
    await notifyCoaching(db, app.log, {
      actor: batch.vendorId,
      type: "coaching.updated",
      title: `Batch cancelled: ${title}`,
      body: `${reason} ${count(refunded, "student")} refunded in full.`,
      to: [{ userId: batch.vendorId, link: courseLink(batch.courseId) }],
    });
  }
  return { refunded, kept };
}

/** Ruxstar takes a course down: it leaves the listings and its live batches are cancelled, refunding every place not yet settled. */
export async function takeDownCourse(app: FastifyInstance, db: Database, course: WithId<CoachingCourseDoc>, by: By & { kind: "staff" }, reason: string) {
  if (course.status === "removed") throw new AppError("CONFLICT", "This course is taken down already.");
  const now = new Date();
  const res = await db.coachingCourses.updateOne(
    { _id: course._id, status: course.status },
    { $set: { status: "removed", removal: { actorId: by.actor.id!, reason, at: now }, updatedAt: now } },
  );
  if (!res.modifiedCount) throw new AppError("CONFLICT");
  await writeAudit(db, {
    actor: by.actor,
    scope: { module: "coaching", businessId: course.businessId },
    action: "coaching_course.take_down",
    target: { type: "coaching_course", id: course._id },
    diff: { status: { from: course.status, to: "removed" }, reason: { from: null, to: reason } },
    ip: by.ip ?? null,
  });
  let refunded = 0;
  let kept = 0;
  for (const batch of await db.coachingBatches.find({ courseId: course._id, status: "live" }).toArray()) {
    const done = await cancelBatch(app, db, batch, by, `Ruxstar took down ${course.title}: ${reason}`);
    refunded += done.refunded;
    kept += done.kept;
  }
  await notifyCoaching(db, app.log, {
    actor: by.actor.id ?? course.vendorId,
    type: "coaching.updated",
    title: `Ruxstar took down ${course.title}`,
    body: `${reason} ${count(refunded, "student")} refunded. Contact support if you think this is wrong.`,
    to: [{ userId: course.vendorId, link: courseLink(course._id) }],
  });
  return { refunded, kept };
}

/**
 * After classes are cancelled, moved or added: the batch's first and last classes, and the first class of each place not yet
 * settled, which sets its refund cutoff and release. Demo places follow their own class.
 */
export async function refreshDates(db: Database, batchId: ObjectId): Promise<void> {
  const classes = await db.coachingSessions.find({ batchId, status: "scheduled" }, { projection: { startsAt: 1, endsAt: 1 } }).sort({ startsAt: 1 }).toArray();
  const first = classes[0];
  const last = classes.reduce<Date | null>((latest, c) => (!latest || c.endsAt > latest ? c.endsAt : latest), null);
  if (!first || !last) return;
  const now = new Date();
  await db.coachingBatches.updateOne({ _id: batchId }, { $set: { firstAt: first.startsAt, firstEndsAt: first.endsAt, lastEndsAt: last, updatedAt: now } });
  const dates = { firstAt: first.startsAt, firstEndsAt: first.endsAt, updatedAt: now };
  await db.coachingOrders.updateMany({ batchId, kind: "batch", status: "awaiting_payment" }, { $set: dates });
  await db.coachingOrders.updateMany({ batchId, kind: "batch", status: "confirmed", releasedAt: null }, { $set: { ...dates, releaseAt: first.endsAt } });
}

/** A demo class moved: its places follow it. */
export async function moveDemos(db: Database, session: Pick<CoachingSessionDoc, "_id" | "startsAt" | "endsAt">): Promise<void> {
  const dates = { firstAt: session.startsAt, firstEndsAt: session.endsAt, updatedAt: new Date() };
  await db.coachingOrders.updateMany({ sessionId: session._id, status: "awaiting_payment" }, { $set: dates });
  await db.coachingOrders.updateMany({ sessionId: session._id, status: "confirmed", releasedAt: null }, { $set: { ...dates, releaseAt: session.endsAt } });
}

/** Once the first class a place covers ends, the institute's share moves to its available balance. */
export async function releaseCoachingShares(app: FastifyInstance, db: Database, filter: { vendorId?: ObjectId }, now = new Date()): Promise<number> {
  const due = await db.coachingOrders
    .find({ ...filter, status: "confirmed", releasedAt: null, releaseAt: { $lte: now } })
    .limit(100)
    .toArray();
  let released = 0;
  for (const order of due) {
    const done = await db.transaction(async (session) => {
      const after = await db.coachingOrders.findOneAndUpdate(
        { _id: order._id, status: "confirmed", releasedAt: null },
        { $set: { releasedAt: now, updatedAt: now } },
        { session, returnDocument: "after" },
      );
      if (!after) return false;
      for (const entry of coachingLedger("release", after, now)) await db.ledgerEntries.insertOne(entry, { session });
      return true;
    });
    if (done) released++;
  }
  return released;
}

/**
 * The minimum check, once per batch, `minimumHours` before the first class: a batch short of students is cancelled and
 * everyone refunded. A check that comes after the first class ended only records itself, as money may have moved.
 */
export async function checkMinimum(app: FastifyInstance, db: Database, batch: WithId<CoachingBatchDoc>, minimumHours: number, now = new Date()): Promise<boolean> {
  if (batch.status !== "live" || !batch.minStudents || batch.minimumCheckedAt) return false;
  if (now.getTime() < batch.firstAt.getTime() - minimumHours * HOUR_MS) return false;
  const claimed = await db.coachingBatches.updateOne({ _id: batch._id, minimumCheckedAt: null }, { $set: { minimumCheckedAt: now, updatedAt: now } });
  if (!claimed.modifiedCount) return false;
  const enrolled = await db.coachingOrders.countDocuments({ batchId: batch._id, kind: "batch", status: "confirmed" });
  if (enrolled >= batch.minStudents || batch.firstEndsAt <= now) return false;
  const course = await db.coachingCourses.findOne({ _id: batch.courseId }, { projection: { title: 1 } });
  await cancelBatch(
    app,
    db,
    batch,
    SYSTEM,
    `${batch.name} of ${course?.title ?? "the course"} needed at least ${count(batch.minStudents, "student")} and has ${enrolled}, so it won't run.`,
  );
  return true;
}

/** After a batch's last class: a certificate for each student who attended enough of the classes held. Once per batch. */
export async function issueCertificates(app: FastifyInstance, db: Database, batch: WithId<CoachingBatchDoc>, now = new Date()): Promise<number> {
  if (batch.status !== "live" || batch.certificatesAt || batch.lastEndsAt > now) return 0;
  const claimed = await db.coachingBatches.updateOne({ _id: batch._id, certificatesAt: null }, { $set: { certificatesAt: now, updatedAt: now } });
  if (!claimed.modifiedCount) return 0;
  const course = await db.coachingCourses.findOne({ _id: batch.courseId });
  const held = await db.coachingSessions.find({ batchId: batch._id, status: "scheduled", endsAt: { $lte: now } }, { projection: { _id: 1 } }).toArray();
  if (!course || !held.length) return 0;
  const orders = await db.coachingOrders.find({ batchId: batch._id, kind: "batch", status: "confirmed" }).toArray();
  const present = await db.coachingAttendance
    .aggregate<{ _id: ObjectId; n: number }>([
      { $match: { sessionId: { $in: held.map((s) => s._id) }, orderId: { $in: orders.map((o) => o._id) }, present: true } },
      { $group: { _id: "$orderId", n: { $sum: 1 } } },
    ])
    .toArray();
  const told: Told = [];
  for (const order of orders) {
    const attended = present.find((p) => p._id.equals(order._id))?.n ?? 0;
    if (attended * 100 < course.certificatePercent * held.length) continue;
    try {
      await db.coachingCertificates.insertOne({
        _id: new ObjectId(),
        orderId: order._id,
        courseId: course._id,
        batchId: batch._id,
        businessId: course.businessId,
        customerId: order.customerId,
        code: certificateCode(),
        studentName: order.student.name,
        courseTitle: course.title,
        batchName: batch.name,
        businessName: course.businessName,
        attended,
        classes: held.length,
        issuedAt: now,
      });
      told.push({ userId: order.customerId, link: orderLink(order) });
    } catch (err) {
      if (!(err instanceof MongoServerError && err.code === 11000)) throw err;
    }
  }
  for (const to of told) {
    await notifyCoaching(db, app.log, {
      actor: batch.vendorId,
      type: "coaching.updated",
      title: `Certificate ready: ${course.title}`,
      body: `${batch.name} is complete. Download the certificate from your classes.`,
      to: [to],
    });
  }
  return told.length;
}

/** The checks reads make for themselves, so a missed sweep doesn't leave a batch waiting: the minimum and the certificates. */
export async function catchUp(app: FastifyInstance, db: Database, batches: WithId<CoachingBatchDoc>[]): Promise<boolean> {
  const now = new Date();
  const due = batches.filter(
    (b) => b.status === "live" && ((b.minStudents && !b.minimumCheckedAt && b.firstAt.getTime() - now.getTime() < 7 * DAY_MS) || (!b.certificatesAt && b.lastEndsAt <= now)),
  );
  if (!due.length) return false;
  const { minimumHours } = await coachingSettings(db);
  for (const batch of due) {
    if (!(await checkMinimum(app, db, batch, minimumHours, now))) await issueCertificates(app, db, batch, now);
  }
  return true;
}

/** The coaching timers: unpaid places past their 20 minutes, shares due, refunds to retry, places of cancelled batches, minimums, certificates. */
export async function sweepCoaching(app: FastifyInstance, db: Database) {
  const now = new Date();
  let holds = 0;
  for (const order of await db.coachingOrders.find({ status: "awaiting_payment", holdUntil: { $lte: now } }).limit(100).toArray()) {
    const after = await syncCoachingPayment(app, db, order).catch(() => order);
    if (after.status !== "awaiting_payment") holds++;
  }
  const releases = await releaseCoachingShares(app, db, {}, now);
  let refunds = 0;
  for (const order of await db.coachingOrders.find({ "refund.status": "pending" }).limit(100).toArray()) {
    if ((await askCoachingRefund(app, db, order)).refund?.status === "done") refunds++;
  }
  const cancelled = await db.coachingBatches
    .find({ status: "cancelled", "cancellation.at": { $gte: new Date(now.getTime() - 7 * DAY_MS) } }, { projection: { _id: 1 } })
    .toArray();
  for (const order of await db.coachingOrders
    .find({ batchId: { $in: cancelled.map((b) => b._id) }, status: { $in: [...OPEN] }, releasedAt: null })
    .limit(100)
    .toArray()) {
    await cancelOrder(app, db, order, SYSTEM, { reason: "The batch was cancelled." }).catch(() => undefined);
  }
  const { minimumHours } = await coachingSettings(db);
  let minimums = 0;
  for (const batch of await db.coachingBatches
    .find({ status: "live", minStudents: { $ne: null }, minimumCheckedAt: null, firstAt: { $lte: new Date(now.getTime() + minimumHours * HOUR_MS) } })
    .limit(50)
    .toArray()) {
    if (await checkMinimum(app, db, batch, minimumHours, now).catch(() => false)) minimums++;
  }
  let certificates = 0;
  for (const batch of await db.coachingBatches.find({ status: "live", certificatesAt: null, lastEndsAt: { $lte: now } }).limit(50).toArray()) {
    certificates += await issueCertificates(app, db, batch, now).catch(() => 0);
  }
  return { coachingHolds: holds, coachingReleases: releases, coachingRefunds: refunds, coachingMinimums: minimums, coachingCertificates: certificates };
}
