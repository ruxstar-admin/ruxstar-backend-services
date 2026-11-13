import { MongoServerError, ObjectId, type ClientSession, type WithId } from "mongodb";
import { writeAudit } from "../../platform/audit.js";
import { stamp, type AuditLogDoc, type CouponDoc, type Database, type PodOrderDoc, type PodOrderStatus, type SwitchableModule } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import type { Coupon, CreateCouponBody, Offer, UpdateCouponBody } from "./contracts.js";

const DAY_MS = 24 * 60 * 60_000;
/** Paid orders, whatever happened after, for "first order only". */
const PAID: PodOrderStatus[] = ["placed", "accepted", "printing", "ready", "out_for_delivery", "delivered", "refunded"];
/** An unpaid order holds its coupon for the customer this long, so two checkouts can't share one use. */
const UNPAID_HOLD_MS = DAY_MS;
const MAX_OFFERS = 20;

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const shortDate = (at: Date) => at.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
const invalid = (path: string, message: string) => new AppError("VALIDATION_FAILED", message, [{ path, message }]);

export const normalCode = (code: string) => code.trim().toUpperCase();

export const appliedView = (coupon: { code: string; fundedBy: CouponDoc["fundedBy"] } | null | undefined) =>
  coupon ? { code: coupon.code, fundedBy: coupon.fundedBy, label: coupon.fundedBy === "ruxstar" ? "Ruxstar offer" : "Shop offer" } : null;

/** What a coupon takes off the items. It always leaves at least ₹1 of them to pay. */
export function discountOf(coupon: Pick<CouponDoc, "kind" | "value" | "cap">, items: number): number {
  const raw = coupon.kind === "percent" ? Math.floor((items * coupon.value) / 100) : coupon.value;
  const capped = coupon.kind === "percent" && coupon.cap !== null ? Math.min(raw, coupon.cap) : raw;
  return Math.max(0, Math.min(capped, items - 100));
}

export const labelOf = (coupon: Pick<CouponDoc, "kind" | "value" | "cap">) =>
  coupon.kind === "percent" ? `${coupon.value}% off${coupon.cap !== null ? ` up to ${rupees(coupon.cap)}` : ""}` : `${rupees(coupon.value)} off`;

export function termsOf(coupon: Pick<CouponDoc, "minOrder" | "firstOrderOnly" | "endsAt">): string | null {
  const parts = [
    coupon.minOrder > 0 ? `On items of ${rupees(coupon.minOrder)} or more` : null,
    coupon.firstOrderOnly ? "First order only" : null,
    coupon.endsAt ? `Ends ${shortDate(coupon.endsAt)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export function stateOf(coupon: CouponDoc, now = new Date()): Coupon["state"] {
  if (!coupon.active) return "off";
  if (coupon.startsAt && coupon.startsAt > now) return "scheduled";
  if (coupon.endsAt && coupon.endsAt <= now) return "ended";
  if (coupon.limit !== null && coupon.used >= coupon.limit) return "used_up";
  return "active";
}

// Whether a coupon works on an order.

export interface CouponContext {
  module: SwitchableModule;
  shop: { id: ObjectId; name: string };
  customerId: ObjectId;
  /** Paise of items before any discount. */
  items: number;
}

type Reason = "off" | "scheduled" | "ended" | "used_up" | "module" | "shop" | "min_order" | "used" | "first_order";
interface Problem {
  reason: Reason;
  text: string;
}

/** What the customer has done that coupons care about. */
interface History {
  uses: (couponId: ObjectId) => number;
  orderedFrom: ObjectId[];
}

async function historyOf(db: Database, customerId: ObjectId, couponIds: ObjectId[]): Promise<History> {
  const [redemptions, unpaid, orderedFrom] = await Promise.all([
    db.couponRedemptions.find({ couponId: { $in: couponIds }, customerId }, { projection: { couponId: 1 } }).toArray(),
    db.podOrders
      .find(
        { customerId, status: "awaiting_payment", "price.coupon.id": { $in: couponIds }, createdAt: { $gt: new Date(Date.now() - UNPAID_HOLD_MS) } },
        { projection: { "price.coupon.id": 1 } },
      )
      .toArray(),
    db.podOrders.distinct("shopId", { customerId, status: { $in: PAID } }),
  ]);
  const ids = [...redemptions.map((r) => r.couponId), ...unpaid.map((o) => o.price.coupon!.id)];
  return { uses: (couponId) => ids.filter((id) => id.equals(couponId)).length, orderedFrom };
}

function problemOf(coupon: CouponDoc, ctx: CouponContext, history: History, now: Date): Problem | null {
  const state = stateOf(coupon, now);
  if (state === "off") return { reason: "off", text: "This coupon is switched off." };
  if (state === "scheduled") return { reason: "scheduled", text: `This coupon starts on ${shortDate(coupon.startsAt!)}.` };
  if (state === "ended") return { reason: "ended", text: "This coupon has ended." };
  if (state === "used_up") return { reason: "used_up", text: "This coupon has been used up." };
  if (!coupon.modules.includes(ctx.module)) return { reason: "module", text: "This coupon isn't for print orders." };
  if (coupon.fundedBy === "vendor" && !coupon.businessIds.some((id) => id.equals(ctx.shop.id))) {
    return { reason: "shop", text: `This coupon doesn't work at ${ctx.shop.name}.` };
  }
  if (ctx.items < coupon.minOrder) return { reason: "min_order", text: `Add ${rupees(coupon.minOrder - ctx.items)} more to use this.` };
  if (discountOf(coupon, ctx.items) <= 0) return { reason: "min_order", text: "This order is too small for this coupon." };
  if (coupon.perCustomer !== null && history.uses(coupon._id) >= coupon.perCustomer) {
    return { reason: "used", text: coupon.perCustomer === 1 ? "You've already used this coupon." : `You've used this coupon ${coupon.perCustomer} times, the most allowed.` };
  }
  if (coupon.firstOrderOnly) {
    const before = coupon.fundedBy === "ruxstar" ? history.orderedFrom.length > 0 : history.orderedFrom.some((id) => coupon.businessIds.some((b) => b.equals(id)));
    if (before) return { reason: "first_order", text: coupon.fundedBy === "ruxstar" ? "This coupon is for your first order." : "This coupon is for a first order here." };
  }
  return null;
}

/** The coupon for a code, with its discount on this order, or why it can't be used. */
export async function checkCode(
  db: Database,
  code: string,
  ctx: CouponContext,
): Promise<{ coupon: WithId<CouponDoc>; discount: number; problem: null } | { coupon: null; discount: 0; problem: string }> {
  const coupon = await db.coupons.findOne({ code: normalCode(code) });
  if (!coupon) return { coupon: null, discount: 0, problem: "There's no coupon with this code." };
  const problem = problemOf(coupon, ctx, await historyOf(db, ctx.customerId, [coupon._id]), new Date());
  if (problem) return { coupon: null, discount: 0, problem: problem.text };
  return { coupon, discount: discountOf(coupon, ctx.items), problem: null };
}

/**
 * Coupons shown at checkout: listed ones that work at this shop now, best first. Ones the customer can't use
 * at all are left out; one that needs a bigger order stays, with how much more.
 */
export async function offersFor(db: Database, ctx: CouponContext): Promise<Offer[]> {
  const now = new Date();
  const docs = await db.coupons
    .find({
      modules: ctx.module,
      active: true,
      listed: true,
      $and: [
        { $or: [{ fundedBy: "ruxstar" }, { businessIds: ctx.shop.id }] },
        { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
        { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] },
      ],
    })
    .sort({ createdAt: -1 })
    .limit(MAX_OFFERS * 2)
    .toArray();
  const history = await historyOf(
    db,
    ctx.customerId,
    docs.map((d) => d._id),
  );
  return docs
    .map((coupon) => ({ coupon, problem: problemOf(coupon, ctx, history, now) }))
    .filter(({ problem }) => !problem || problem.reason === "min_order")
    .map(({ coupon, problem }) => ({
      code: coupon.code,
      fundedBy: coupon.fundedBy,
      label: labelOf(coupon),
      terms: termsOf(coupon),
      discount: problem ? 0 : discountOf(coupon, ctx.items),
      problem: problem?.text ?? null,
    }))
    .sort((a, b) => b.discount - a.discount)
    .slice(0, MAX_OFFERS);
}

/** A print order's price with a coupon taken off. A vendor's coupon lowers what commission is charged on. */
export function withCoupon(price: Omit<PodOrderDoc["price"], "discount" | "coupon">, coupon: WithId<CouponDoc> | null): PodOrderDoc["price"] {
  if (!coupon) return { ...price, discount: 0, coupon: null };
  const discount = discountOf(coupon, price.items);
  const charged = coupon.fundedBy === "vendor" ? price.items - discount : price.items;
  return {
    ...price,
    discount,
    coupon: { id: coupon._id, code: coupon.code, fundedBy: coupon.fundedBy },
    total: price.items - discount + price.platformFee,
    commission: Math.round((charged * price.commissionBps) / 10_000),
  };
}

// Uses, counted when the payment goes through and given back on a full refund.

/** In the payment's transaction. A use that arrives after the limit was reached still counts: the customer has paid that price. */
export async function redeem(db: Database, order: PodOrderDoc, session: ClientSession): Promise<void> {
  const coupon = order.price.coupon;
  if (!coupon) return;
  try {
    await db.couponRedemptions.insertOne(
      { couponId: coupon.id, customerId: order.customerId, orderId: order._id, discount: order.price.discount ?? 0, at: new Date() },
      { session },
    );
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 11000) return;
    throw err;
  }
  await db.coupons.updateOne({ _id: coupon.id }, { $inc: { used: 1 } }, { session });
}

export async function giveBack(db: Database, order: PodOrderDoc, session: ClientSession): Promise<void> {
  const coupon = order.price.coupon;
  if (!coupon) return;
  const removed = await db.couponRedemptions.deleteOne({ orderId: order._id }, { session });
  if (removed.deletedCount) await db.coupons.updateOne({ _id: coupon.id, used: { $gt: 0 } }, { $inc: { used: -1 } }, { session });
}

// Making and changing coupons, for the console and for vendors.

const date = (iso: string | null | undefined) => (iso === undefined ? undefined : iso === null ? null : new Date(iso));

/** Checks the discount and the dates together, as they will be after the change. */
function checkTerms(next: Pick<CouponDoc, "kind" | "value" | "cap" | "startsAt" | "endsAt">) {
  if (next.kind === "percent" && next.value > 100) throw invalid("body/value", "A percent coupon takes 1 to 100 percent off.");
  if (next.kind === "flat" && next.value < 100) throw invalid("body/value", "A flat coupon takes at least ₹1 off.");
  if (next.kind === "flat" && next.cap !== null) throw invalid("body/cap", "Only a percent coupon has a most-off amount.");
  if (next.startsAt && next.endsAt && next.endsAt <= next.startsAt) throw invalid("body/endsAt", "The end must be after the start.");
}

export async function createCoupon(
  db: Database,
  input: {
    body: CreateCouponBody;
    fundedBy: CouponDoc["fundedBy"];
    vendorId: ObjectId | null;
    businessIds: ObjectId[];
    actor: AuditLogDoc["actor"];
    ip: string;
    /** The shop's activity shows it: someone on its team made it. */
    shopId?: ObjectId;
  },
): Promise<WithId<CouponDoc>> {
  const { body } = input;
  const now = new Date();
  const doc: CouponDoc = {
    _id: new ObjectId(),
    code: normalCode(body.code),
    fundedBy: input.fundedBy,
    vendorId: input.vendorId,
    businessIds: input.businessIds,
    modules: ["pod"],
    kind: body.kind,
    value: body.value,
    cap: body.kind === "percent" ? (body.cap ?? null) : null,
    minOrder: body.minOrder ?? 0,
    startsAt: date(body.startsAt) ?? null,
    endsAt: date(body.endsAt) ?? null,
    limit: body.limit ?? null,
    perCustomer: body.perCustomer === undefined ? 1 : body.perCustomer,
    firstOrderOnly: body.firstOrderOnly ?? false,
    listed: body.listed ?? true,
    active: true,
    used: 0,
    createdBy: input.actor.id!,
    ...stamp(now),
  };
  if (body.kind === "flat" && body.cap != null) throw invalid("body/cap", "Only a percent coupon has a most-off amount.");
  checkTerms(doc);
  if (doc.endsAt && doc.endsAt <= now) throw invalid("body/endsAt", "The end must be in the future.");
  try {
    await db.transaction(async (session) => {
      await db.coupons.insertOne(doc, { session });
      await writeAudit(
        db,
        {
          actor: input.actor,
          scope: { module: "ledger", ...(input.shopId ? { businessId: input.shopId } : {}) },
          action: "coupon.create",
          target: { type: "coupon", id: doc._id },
          diff: { code: { from: null, to: doc.code }, discount: { from: null, to: labelOf(doc) } },
          ip: input.ip,
        },
        session,
      );
    });
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 11000) {
      throw new AppError("CONFLICT", "This code is already taken. Pick another.", [{ path: "body/code", message: "Taken" }]);
    }
    throw err;
  }
  return doc;
}

export async function updateCoupon(
  db: Database,
  coupon: WithId<CouponDoc>,
  input: { body: UpdateCouponBody; businessIds?: ObjectId[]; by: "staff" | "vendor"; actor: AuditLogDoc["actor"]; ip: string; shopId?: ObjectId },
): Promise<WithId<CouponDoc>> {
  const { body } = input;
  const set: Partial<CouponDoc> = {};
  if (coupon.fundedBy === "vendor" && body.active !== undefined && body.active !== coupon.active) {
    if (input.by === "staff") {
      if (body.active && !coupon.stoppedByRuxstar) throw new AppError("FORBIDDEN", "The vendor switched this coupon off. Only they can switch it back on.");
      set.stoppedByRuxstar = !body.active;
    } else if (body.active && coupon.stoppedByRuxstar) throw new AppError("FORBIDDEN", "Ruxstar switched this coupon off. Contact Ruxstar support to use it again.");
  }
  if (body.minOrder !== undefined) set.minOrder = body.minOrder;
  if (body.startsAt !== undefined) set.startsAt = date(body.startsAt)!;
  if (body.endsAt !== undefined) set.endsAt = date(body.endsAt)!;
  if (body.limit !== undefined) set.limit = body.limit;
  if (body.perCustomer !== undefined) set.perCustomer = body.perCustomer;
  if (body.firstOrderOnly !== undefined) set.firstOrderOnly = body.firstOrderOnly;
  if (body.listed !== undefined) set.listed = body.listed;
  if (body.active !== undefined) set.active = body.active;
  if (input.businessIds) set.businessIds = input.businessIds;
  checkTerms({ ...coupon, ...set });

  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(set) as (keyof CouponDoc)[]) {
    if (JSON.stringify(coupon[key]) !== JSON.stringify(set[key])) diff[key] = { from: coupon[key], to: set[key] };
  }
  if (!Object.keys(diff).length) return coupon;
  const now = new Date();
  const after = await db.transaction(async (session) => {
    const done = await db.coupons.findOneAndUpdate(
      { _id: coupon._id, updatedAt: coupon.updatedAt },
      { $set: { ...set, updatedAt: now } },
      { session, returnDocument: "after" },
    );
    if (!done) throw new AppError("CONFLICT");
    await writeAudit(
      db,
      { actor: input.actor, scope: { module: "ledger", ...(input.shopId ? { businessId: input.shopId } : {}) }, action: "coupon.update", target: { type: "coupon", id: coupon._id }, diff, ip: input.ip },
      session,
    );
    return done;
  });
  return after;
}

/** A vendor's own print shops, by id, for the coupon's `businessIds`. */
export async function vendorShops(db: Database, vendorId: ObjectId, ids: string[]): Promise<ObjectId[]> {
  const objectIds = ids.map((id) => new ObjectId(id));
  const found = await db.businesses.find({ _id: { $in: objectIds }, ownerId: vendorId, module: "pod" }, { projection: { _id: 1 } }).toArray();
  ids.forEach((id, i) => {
    if (!found.some((b) => b._id.toHexString() === id)) throw invalid(`body/businessIds/${i}`, "Pick one of your print shops.");
  });
  return objectIds;
}

export async function couponViews(db: Database, docs: WithId<CouponDoc>[]): Promise<Coupon[]> {
  const vendorIds = docs.flatMap((d) => (d.vendorId ? [d.vendorId] : []));
  const businessIds = docs.flatMap((d) => d.businessIds);
  const [users, shops] = await Promise.all([
    vendorIds.length ? db.users.find({ _id: { $in: vendorIds } }, { projection: { name: 1 } }).toArray() : [],
    businessIds.length ? db.businesses.find({ _id: { $in: businessIds } }, { projection: { name: 1 } }).toArray() : [],
  ]);
  const now = new Date();
  return docs.map((doc) => ({
    id: doc._id.toHexString(),
    code: doc.code,
    fundedBy: doc.fundedBy,
    vendor: doc.vendorId
      ? { id: doc.vendorId.toHexString(), name: users.find((u) => u._id.equals(doc.vendorId!))?.name || "Deleted account" }
      : null,
    businesses: doc.businessIds.map((id) => ({ id: id.toHexString(), name: shops.find((s) => s._id.equals(id))?.name ?? "Deleted business" })),
    modules: doc.modules,
    kind: doc.kind,
    value: doc.value,
    cap: doc.cap,
    label: labelOf(doc),
    minOrder: doc.minOrder,
    startsAt: doc.startsAt?.toISOString() ?? null,
    endsAt: doc.endsAt?.toISOString() ?? null,
    limit: doc.limit,
    perCustomer: doc.perCustomer,
    firstOrderOnly: doc.firstOrderOnly,
    listed: doc.listed,
    active: doc.active,
    stoppedByRuxstar: doc.stoppedByRuxstar ?? false,
    used: doc.used,
    state: stateOf(doc, now),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }));
}
