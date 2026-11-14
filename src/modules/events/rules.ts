import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { ObjectId } from "mongodb";
import type { Database, EventDoc, EventOrderDoc, EventRules, EventTicketDoc, LedgerEntryDoc } from "../../platform/db.js";
import { MAX_EVENT_DAYS, MAX_PER_ORDER, type EventCard, type TicketOrder } from "./contracts.js";

export const DEFAULT_EVENT_RULES: EventRules = { refundHours: 24, waitlistHours: 2, maxTicketTypes: 5, maxQuestions: 3 };

export const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** Seats wait this long for a payment before they go back on sale. */
export const PAY_WINDOW_MS = 20 * 60_000;
/** Cashfree takes up to ₹5,00,000 in one payment. */
export const MAX_ORDER_TOTAL = 5_00_000_00;
/** Ticket orders are numbered from here, so their numbers can't be mistaken for print orders'. */
const FIRST_ORDER_NO = 50_000_000;

export const nextEventOrderNo = async (db: Database, session?: import("mongodb").ClientSession) =>
  FIRST_ORDER_NO + (await db.nextNumber("event-order", session));

export async function eventSettings(db: Database): Promise<EventRules & { commissionBps: number; platformFee: number; live: boolean }> {
  const doc = await db.moduleSettings.findOne({ module: "events" }, { projection: { eventRules: 1, commissionBps: 1, platformFee: 1, live: 1 } });
  return { ...DEFAULT_EVENT_RULES, ...doc?.eventRules, commissionBps: doc?.commissionBps ?? 0, platformFee: doc?.platformFee ?? 0, live: Boolean(doc?.live) };
}

// Days, in India.

const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
/** YYYY-MM-DD in India. */
export const dayOf = (at: Date) => DAY_FORMAT.format(at);

/** The dates an event runs on in India, first to last. One entry a day on each. */
export function daysOf(event: Pick<EventDoc, "startsAt" | "endsAt">): string[] {
  const days: string[] = [];
  const last = dayOf(event.endsAt);
  for (let at = event.startsAt.getTime(); days.length <= MAX_EVENT_DAYS; at += DAY_MS) {
    const day = dayOf(new Date(at));
    if (days.at(-1) !== day) days.push(day);
    if (day >= last) break;
  }
  return days;
}

export const ended = (event: Pick<EventDoc, "endsAt">, now = Date.now()) => event.endsAt.getTime() <= now;

// Tickets.

const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const newCode = () => Array.from({ length: 6 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join("");

const signature = (key: Uint8Array, id: string) => createHmac("sha256", key).update(`ticket.${id}`).digest("base64url").slice(0, 22);
/** What a ticket's QR code holds. Signed, so it can't be made up from a ticket id. */
export const ticketQr = (key: Uint8Array, ticketId: ObjectId) => `RX1.${ticketId.toHexString()}.${signature(key, ticketId.toHexString())}`;
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The ticket a scanned QR code is for, or null when it isn't a Ruxstar ticket. */
export function readQr(key: Uint8Array, text: string): ObjectId | null {
  const match = /^RX1\.([0-9a-f]{24})\.([A-Za-z0-9_-]{22})$/.exec(text.trim());
  if (!match) return null;
  const expected = Buffer.from(signature(key, match[1]!));
  const given = Buffer.from(match[2]!);
  return given.length === expected.length && timingSafeEqual(given, expected) ? new ObjectId(match[1]) : null;
}

export const lastFour = (phone: string | null) => (phone ? `••${phone.slice(-4)}` : "");

// Money.

const vendorAccount = (order: EventOrderDoc) => `vendor:${order.vendorId.toHexString()}`;
export const vendorShare = (order: Pick<EventOrderDoc, "price">) => order.price.items - order.price.commission;
const ruxstarShare = (order: Pick<EventOrderDoc, "price">) => order.price.commission + order.price.platformFee;

type Row = [string, LedgerEntryDoc["bucket"], number];
/**
 * A paid order: the organiser's share and Ruxstar's commission and fee wait in pending until the event ends. A refund before
 * then takes all of it back out; nothing is refunded after the release.
 */
export function eventLedger(kind: "payment" | "release" | "refund", order: EventOrderDoc, at: Date): LedgerEntryDoc[] {
  const shop = vendorShare(order);
  const ruxstar = ruxstarShare(order);
  const rows: Row[] =
    kind === "payment"
      ? [
          [vendorAccount(order), "pending", shop],
          ["ruxstar", "pending", ruxstar],
          ["gateway", "withdrawable", -order.price.total],
        ]
      : kind === "release"
        ? [
            [vendorAccount(order), "pending", -shop],
            [vendorAccount(order), "withdrawable", shop],
            ["ruxstar", "pending", -ruxstar],
            ["ruxstar", "withdrawable", ruxstar],
          ]
        : [
            [vendorAccount(order), "pending", -shop],
            ["ruxstar", "pending", -ruxstar],
            ["gateway", "withdrawable", shop + ruxstar],
          ];
  return rows
    .filter(([, , paise]) => paise !== 0)
    .map(([accountId, bucket, signedPaise]) => ({
      txnId: `${kind}:${order._id.toHexString()}`,
      kind,
      accountId,
      bucket,
      signedPaise,
      source: { type: "event_order" as const, id: order._id },
      at,
    }));
}

/** Customers cancel for a full refund until then; null when they can't. */
export function cancelUntil(event: Pick<EventDoc, "refunds" | "startsAt">, rules: Pick<EventRules, "refundHours">): Date | null {
  if (event.refunds === "none") return null;
  return new Date(event.startsAt.getTime() - rules.refundHours * HOUR_MS);
}

// Views.

const photoOf = (event: EventDoc, businessPhoto?: EventCard["photo"]) =>
  event.photo ? { url: event.photo.url, width: event.photo.width, height: event.photo.height } : (businessPhoto ?? null);

export function eventCard(event: EventDoc, businessPhoto?: EventCard["photo"]): EventCard {
  const prices = event.tiers.map((t) => t.price);
  return {
    id: event._id.toHexString(),
    title: event.title,
    kind: event.kind,
    business: { id: event.businessId.toHexString(), name: event.businessName },
    photo: photoOf(event, businessPhoto),
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    city: event.venue?.city ?? null,
    venueName: event.venue?.name ?? (event.online ? "Online" : null),
    online: Boolean(event.online),
    team: Boolean(event.team),
    priceFrom: prices.length ? Math.min(...prices) : 0,
    free: prices.every((p) => p === 0),
    soldOut: event.tiers.every((t) => t.left <= 0),
  };
}

export function ticketOrderView(
  order: EventOrderDoc,
  event: EventDoc | null,
  tickets: EventTicketDoc[],
  ctx: { key: Uint8Array; rules: Pick<EventRules, "refundHours">; now?: number },
): TicketOrder {
  const now = ctx.now ?? Date.now();
  const until = event ? cancelUntil(event, ctx.rules) : null;
  const confirmed = order.status === "confirmed";
  const canCancel =
    (order.status === "awaiting_payment" || (confirmed && !!until && until.getTime() > now)) && event?.status === "live";
  return {
    id: order._id.toHexString(),
    orderNo: order.orderNo,
    status: order.status,
    event: {
      id: order.eventId.toHexString(),
      title: order.eventTitle,
      startsAt: (event?.startsAt ?? order.startsAt).toISOString(),
      endsAt: (event?.endsAt ?? order.endsAt).toISOString(),
      venueName: event?.venue?.name ?? null,
      address: event?.venue?.address ?? null,
      city: event?.venue?.city ?? null,
      online: Boolean(event?.online),
      onlineLink: confirmed ? (event?.online?.link ?? null) : null,
      photo: event ? photoOf(event) : null,
      cancelled: event?.status === "cancelled",
    },
    business: { id: order.businessId.toHexString(), name: order.businessName },
    lines: order.lines,
    team: order.team?.name ?? null,
    price: { items: order.price.items, platformFee: order.price.platformFee, total: order.price.total },
    refund: order.refund ? { amount: order.refund.amount, status: order.refund.status, reason: order.refund.reason } : null,
    reason: order.reason,
    canCancel,
    cancelUntil: confirmed && until ? until.toISOString() : null,
    payBy: order.status === "awaiting_payment" ? (order.holdUntil?.toISOString() ?? null) : null,
    tickets: tickets.map((t) => ({
      id: t._id.toHexString(),
      name: t.holder.name,
      phone: t.holder.phone,
      tier: t.tierName,
      team: t.team,
      code: t.code,
      qr: t.status === "valid" && !event?.online ? ticketQr(ctx.key, t._id) : null,
      status: t.status,
      checkedInAt: t.checkIns.at(-1)?.at.toISOString() ?? null,
    })),
    createdAt: order.createdAt.toISOString(),
  };
}

export { MAX_PER_ORDER };
