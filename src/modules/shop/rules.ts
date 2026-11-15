import type { ClientSession, ObjectId } from "mongodb";
import type { Database, LedgerEntryDoc, ShopOrderDoc, ShopRefundDoc, ShopRules, ShopSetup } from "../../platform/db.js";
import { FREE_DELIVERY } from "../delivery/rates.js";

export const DEFAULT_SHOP_RULES: ShopRules = {
  returnDays: 2,
  maxOptions: 2,
  releaseHours: 48,
  holdMinutes: 15,
  acceptHours: 6,
  maxProducts: 500,
  maxVariants: 50,
  maxValues: 10,
  maxLines: 20,
  maxQuantity: 20,
};

export const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;
/** ₹1,00,000 for one variant. */
export const MAX_PRICE = 1_00_000_00;
export const MAX_STOCK = 100_000;
/** A shop delivers up to this far, in road km. */
export const MAX_RADIUS_KM = 50;
/** Local shop orders are numbered from here, apart from the other modules' orders. */
const FIRST_ORDER_NO = 90_000_000;

export const nextShopOrderNo = async (db: Database, session?: ClientSession) => FIRST_ORDER_NO + (await db.nextNumber("shop-order", session));

export type ShopSettings = ShopRules & { commissionBps: number; platformFee: number; live: boolean; deliveryEnabled: boolean };

export async function shopSettings(db: Database): Promise<ShopSettings> {
  const doc = await db.moduleSettings.findOne({ module: "shop" }, { projection: { shopRules: 1, commissionBps: 1, platformFee: 1, live: 1, deliveryEnabled: 1 } });
  return {
    ...DEFAULT_SHOP_RULES,
    ...doc?.shopRules,
    commissionBps: doc?.commissionBps ?? 0,
    platformFee: doc?.platformFee ?? 0,
    live: Boolean(doc?.live),
    deliveryEnabled: Boolean(doc?.deliveryEnabled),
  };
}

/** What a shop has before its owner sets delivery and returns: pickup only, no returns. */
export const emptyShop = (): ShopSetup => ({ delivery: false, pickup: true, radiusKm: null, deliveryFee: FREE_DELIVERY, minOrder: 0, returns: false, notes: null });

/** When the shop's money is released: the return window's end, or `releaseHours` after delivery if that is later. */
export function releaseAtOf(order: Pick<ShopOrderDoc, "returnRule">, deliveredAt: Date, rules: Pick<ShopRules, "releaseHours">): Date {
  const window = order.returnRule ? order.returnRule.days * DAY_MS : 0;
  return new Date(deliveredAt.getTime() + Math.max(window, rules.releaseHours * HOUR_MS));
}

/** "Return within 2 days of delivery" or "No returns". */
export const returnText = (rule: ShopOrderDoc["returnRule"]) =>
  rule ? `Return within ${rule.days} day${rule.days === 1 ? "" : "s"} of delivery. The shop pays the trip back if it sent the wrong or a damaged item.` : "No returns.";

// Money.

const discountFrom = (o: Pick<ShopOrderDoc, "price">, fundedBy: "ruxstar" | "vendor") => (o.price.coupon?.fundedBy === fundedBy ? o.price.discount : 0);
/** The shop's share: items and delivery, less its own coupon and Ruxstar's commission. */
export const vendorShareOf = (o: Pick<ShopOrderDoc, "price">) => o.price.items + o.price.delivery - discountFrom(o, "vendor") - o.price.commission;
/** Ruxstar's commission and platform fee, less a Ruxstar coupon it pays for. */
export const ruxstarShareOf = (o: Pick<ShopOrderDoc, "price">) => o.price.commission + o.price.platformFee - discountFrom(o, "ruxstar");
/** A Ruxstar partner's pay, once it moved to them at delivery. */
export const riderPaidOf = (o: Pick<ShopOrderDoc, "delivery">) => (o.delivery?.paidAt ? o.delivery.pay : 0);
/** A Ruxstar partner's pay on a trip still under way. */
export const riderHeldOf = (o: Pick<ShopOrderDoc, "delivery">) =>
  o.delivery && !o.delivery.paidAt && o.delivery.status !== "cancelled" && o.delivery.status !== "delivered" ? o.delivery.pay : 0;
const returned = (o: Pick<ShopOrderDoc, "refunds">, side: "vendor" | "ruxstar") => o.refunds.filter((r) => r.kind === "return").reduce((s, r) => s + r[side], 0);
/** What the shop is still owed: its share less a partner's pay and returns. */
export const vendorLeftOf = (o: Pick<ShopOrderDoc, "price" | "delivery" | "refunds">) => vendorShareOf(o) - riderPaidOf(o) - returned(o, "vendor");
const ruxstarLeftOf = (o: Pick<ShopOrderDoc, "price" | "refunds">) => ruxstarShareOf(o) - returned(o, "ruxstar");
export const refundedOf = (o: Pick<ShopOrderDoc, "refunds">) => o.refunds.reduce((s, r) => s + r.amount, 0);

/**
 * What a return gives back and who it comes out of. The items' value less their part of the discount; when the customer
 * pays the trip back, one delivery fee less too, which stays with the shop for carrying it. The shop gives up the items less
 * their commission; Ruxstar the commission, less its own coupon's part.
 */
export function returnSplit(
  o: Pick<ShopOrderDoc, "price" | "lines" | "method">,
  picked: { lineId: ObjectId; quantity: number }[],
  tripPaidBy: "shop" | "customer",
) {
  const value = picked.reduce((s, p) => s + (o.lines.find((l) => l.id.equals(p.lineId))?.unitPrice ?? 0) * p.quantity, 0);
  const part = (amount: number) => (o.price.items ? Math.round((amount * value) / o.price.items) : 0);
  const discount = part(o.price.discount);
  const commission = part(o.price.commission);
  const tripFee = tripPaidBy === "customer" && o.method === "delivery" ? Math.min(o.price.delivery, value - discount) : 0;
  const amount = value - discount - tripFee;
  const vendorPays = o.price.coupon?.fundedBy === "vendor" ? value - discount - commission - tripFee : value - commission - tripFee;
  return { value, tripFee, amount, vendor: vendorPays, ruxstar: amount - vendorPays };
}

const vendorAccount = (o: Pick<ShopOrderDoc, "vendorId">) => `vendor:${o.vendorId.toHexString()}`;
type Row = [string, LedgerEntryDoc["bucket"], number];
const entries = (txnId: string, kind: LedgerEntryDoc["kind"], o: Pick<ShopOrderDoc, "_id">, rows: Row[], at: Date): LedgerEntryDoc[] =>
  rows
    .filter(([, , paise]) => paise !== 0)
    .map(([accountId, bucket, signedPaise]) => ({ txnId, kind, accountId, bucket, signedPaise, source: { type: "shop_order" as const, id: o._id }, at }));

/**
 * A paid order: the shop's share and Ruxstar's wait in pending until the return window and the hold are over. A full refund
 * before then takes what's left of both back out (and a partner's pay out of Ruxstar's, as the partner keeps it); a release
 * moves what's left to the available balances.
 */
export function shopLedger(kind: "payment" | "release" | "refund", o: ShopOrderDoc, at: Date): LedgerEntryDoc[] {
  const shop = vendorLeftOf(o);
  const ruxstar = ruxstarLeftOf(o);
  const rider = riderPaidOf(o);
  const rows: Row[] =
    kind === "payment"
      ? [
          [vendorAccount(o), "pending", vendorShareOf(o)],
          ["ruxstar", "pending", ruxstarShareOf(o)],
          ["gateway", "withdrawable", -o.price.total],
        ]
      : kind === "release"
        ? [
            [vendorAccount(o), "pending", -shop],
            [vendorAccount(o), "withdrawable", shop],
            ["ruxstar", "pending", -ruxstar],
            ["ruxstar", "withdrawable", ruxstar],
          ]
        : [
            [vendorAccount(o), "pending", -shop],
            ["ruxstar", "pending", -ruxstar - rider],
            ["gateway", "withdrawable", shop + ruxstar + rider],
          ];
  return entries(`${kind}:${o._id.toHexString()}`, kind, o, rows, at);
}

/** A return's refund comes out of the shop's pending share and Ruxstar's. */
export const returnLedger = (o: ShopOrderDoc, refund: ShopRefundDoc): LedgerEntryDoc[] =>
  entries(
    `refund:${o._id.toHexString()}:${refund.refundId}`,
    "refund",
    o,
    [
      [vendorAccount(o), "pending", -refund.vendor],
      ["ruxstar", "pending", -refund.ruxstar],
      ["gateway", "withdrawable", refund.amount],
    ],
    refund.at,
  );

/** At delivery, a Ruxstar partner's pay moves out of the shop's pending share to theirs, on hold for 48 hours. */
export const shopRiderPayLedger = (o: Pick<ShopOrderDoc, "_id" | "vendorId">, riderId: ObjectId, pay: number, at: Date): LedgerEntryDoc[] =>
  entries(
    `rider_pay:${o._id.toHexString()}`,
    "rider_pay",
    o,
    [
      [vendorAccount(o), "pending", -pay],
      [`rider:${riderId.toHexString()}`, "pending", pay],
    ],
    at,
  );

export const shopRiderReleaseLedger = (o: Pick<ShopOrderDoc, "_id">, riderId: ObjectId, pay: number, at: Date): LedgerEntryDoc[] =>
  entries(
    `rider_release:${o._id.toHexString()}`,
    "rider_release",
    o,
    [
      [`rider:${riderId.toHexString()}`, "pending", -pay],
      [`rider:${riderId.toHexString()}`, "withdrawable", pay],
    ],
    at,
  );
