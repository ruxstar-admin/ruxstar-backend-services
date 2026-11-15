import { MongoBulkWriteError, type WithId } from "mongodb";
import type { BusinessPhoto, Database, TurfBookingDoc, TurfCourtDoc, TurfGroundDoc, TurfOccurrenceDoc, TurfSportDoc } from "../../platform/db.js";
import { stamp } from "../../platform/db.js";
import { appliedView } from "../coupons/coupons.js";
import { invoiceRefs } from "../invoices/views.js";
import { REVIEW_DAYS } from "../reviews/contracts.js";
import { eligibility, openUntil, type Reviewable } from "../reviews/reviews.js";
import type { CourtView, DeskBooking, GroundCard, TurfBooking, VendorGround } from "./contracts.js";
import { cancellable } from "./orders.js";
import { DEFAULT_SPORTS, refundPercent, refundText, sportsOf, vendorShareOf, type TurfSettings } from "./rules.js";

const iso = (at: Date | null | undefined) => at?.toISOString() ?? null;
export const photoView = (p: BusinessPhoto) => ({ id: p.id, url: p.url, width: p.width, height: p.height });

/** Ruxstar's sports list, in its order. The defaults are written the first time anyone asks. */
export async function loadSports(db: Database): Promise<WithId<TurfSportDoc>[]> {
  const docs = await db.turfSports.find({}).sort({ order: 1, _id: 1 }).toArray();
  if (docs.length) return docs;
  const now = new Date();
  const defaults: TurfSportDoc[] = DEFAULT_SPORTS.map((s, i) => ({ _id: s.key, name: s.name, active: true, order: (i + 1) * 10, ...stamp(now) }));
  await db.turfSports.insertMany(defaults, { ordered: false }).catch((err: unknown) => {
    const errors = err instanceof MongoBulkWriteError ? [err.writeErrors].flat() : [];
    if (errors.length === 0 || errors.some((e) => e.code !== 11000)) throw err;
  });
  return db.turfSports.find({}).sort({ order: 1, _id: 1 }).toArray();
}

export const courtView = (court: WithId<TurfCourtDoc>, sports: Pick<TurfSportDoc, "_id" | "name">[]): CourtView => ({
  id: court._id.toHexString(),
  name: court.name,
  sports: sportsOf(sports, court.sports),
  slotMinutes: court.slotMinutes,
  hours: court.hours,
  prices: court.prices,
  addOns: court.addOns,
  status: court.status === "live" ? "live" : "paused",
});

export function groundCard(ground: WithId<TurfGroundDoc>, sports: Pick<TurfSportDoc, "_id" | "name">[], liveCourts: number): GroundCard {
  return {
    id: ground._id.toHexString(),
    name: ground.name,
    business: { id: ground.businessId.toHexString(), name: ground.businessName },
    city: ground.venue.city,
    address: ground.venue.address,
    photo: ground.photos[0] ? photoView(ground.photos[0]) : null,
    sports: sportsOf(sports, ground.sports),
    amenities: ground.amenities,
    priceFrom: ground.priceFrom,
    courts: liveCourts,
  };
}

/** Cards for grounds, with their bookable courts counted in one read. */
export async function groundCards(db: Database, grounds: WithId<TurfGroundDoc>[]): Promise<GroundCard[]> {
  if (!grounds.length) return [];
  const [sports, counts] = await Promise.all([
    loadSports(db),
    db.turfCourts.aggregate<{ _id: TurfGroundDoc["_id"]; n: number }>([{ $match: { groundId: { $in: grounds.map((g) => g._id) }, status: "live" } }, { $group: { _id: "$groundId", n: { $sum: 1 } } }]).toArray(),
  ]);
  return grounds.map((g) => groundCard(g, sports, counts.find((c) => c._id.equals(g._id))?.n ?? 0));
}

/** What a ground still needs before it can be published. */
export function missingOf(ground: TurfGroundDoc, courts: TurfCourtDoc[], businessLive: boolean): string[] {
  const missing: string[] = [];
  if (!businessLive) missing.push("Publish the business first");
  if (!ground.photos.length) missing.push("Add at least one photo");
  const live = courts.filter((c) => c.status === "live");
  if (!live.length) missing.push("Add a court that's open for bookings");
  else if (!live.some((c) => c.hours.length)) missing.push("Set a court's opening hours");
  return missing;
}

export async function vendorGroundView(db: Database, ground: WithId<TurfGroundDoc>, settings: TurfSettings, whyNot: string | null = null): Promise<VendorGround> {
  const [courts, sports, business, upcoming] = await Promise.all([
    db.turfCourts.find({ groundId: ground._id, status: { $ne: "removed" } }).sort({ order: 1, _id: 1 }).toArray(),
    loadSports(db),
    db.businesses.findOne({ _id: ground.businessId }, { projection: { status: 1, rating: 1 } }),
    db.turfBookings.countDocuments({ groundId: ground._id, status: "confirmed", lastEndsAt: { $gt: new Date() } }),
  ]);
  const refunds = { fullHours: ground.refunds.fullHours, halfHours: ground.refunds.halfHours, halfPercent: settings.halfPercent };
  return {
    ...groundCard(ground, sports, courts.filter((c) => c.status === "live").length),
    description: ground.description,
    venue: ground.venue,
    photos: ground.photos.map(photoView),
    courtList: courts.map((c) => courtView(c, sports)),
    refunds,
    refundRule: refundText(refunds),
    platformFee: settings.platformFee,
    status: ground.status,
    canBook: false,
    whyNot: whyNot ?? (ground.status === "live" ? "This is your ground." : ground.status === "removed" ? "Ruxstar took this ground down." : "This is your draft. Publish it to take bookings."),
    publishedAt: iso(ground.publishedAt),
    removal: ground.removal ? { reason: ground.removal.reason, at: ground.removal.at.toISOString() } : null,
    missing: ground.status === "draft" ? missingOf(ground, courts, business?.status === "live") : [],
    upcoming,
  };
}

/**
 * A booking opens for a review once a date has been played (it ended, or the ground marked the customer arrived), and stays
 * open until 30 days after its last date. Paid dates that weren't cancelled only.
 */
export function turfReviewable(booking: TurfBookingDoc, now = Date.now()): Reviewable {
  const kept = booking.occurrences.filter((o) => o.status === "booked");
  const played = kept.some((o) => o.endAt.getTime() <= now || o.arrival?.status === "arrived");
  const last = kept.reduce<Date | null>((latest, o) => (!latest || o.endAt > latest ? o.endAt : latest), null);
  const open = booking.status === "confirmed" && played && last;
  return {
    module: "turf",
    orderType: "turf_booking",
    orderId: booking._id,
    orderNo: booking.orderNo,
    businessId: booking.businessId,
    businessName: booking.businessName,
    vendorId: booking.vendorId,
    customerId: booking.customerId,
    label: `${booking.groundName}, ${booking.courtName}`,
    listing: { type: "ground", id: booking.groundId },
    until: open ? openUntil(last, now) : null,
    closed:
      booking.status !== "confirmed"
        ? "Only paid bookings that weren't cancelled can be reviewed."
        : open
          ? `Reviews close ${REVIEW_DAYS} days after your last slot.`
          : "You can review the ground once you've played.",
  };
}

type Ground = Pick<TurfGroundDoc, "_id" | "name" | "venue" | "photos" | "status">;

function bookingFields(b: TurfBookingDoc, ground: Ground | undefined, sports: Pick<TurfSportDoc, "_id" | "name">[], who: "customer" | "ground", now: Date) {
  const open = new Set(cancellable(b, who === "customer" ? "customer" : "vendor", now).map((o) => o.n));
  const occurrence = (o: TurfOccurrenceDoc) => {
    const percent = who === "customer" ? refundPercent(b.refundRule, o.startAt, now) : 100;
    const by = o.cancellation?.by;
    return {
      n: o.n,
      startAt: o.startAt.toISOString(),
      endAt: o.endAt.toISOString(),
      slots: o.slots.map((s) => ({ startAt: s.startAt.toISOString(), endAt: s.endAt.toISOString(), price: s.price, peak: s.peak })),
      items: o.items,
      paid: o.paid,
      status: o.status,
      refund: o.cancellation ? { percent: o.cancellation.percent, amount: o.cancellation.refund } : null,
      cancelledBy: by ? (by === "customer" ? ("customer" as const) : by === "staff" ? ("ruxstar" as const) : ("ground" as const)) : null,
      cancelReason: o.cancellation?.reason ?? null,
      arrival: o.arrival?.status ?? null,
      canCancel: open.has(o.n),
      refundIfCancelled: open.has(o.n) ? { percent, amount: Math.round((o.paid * percent) / 100) } : null,
    };
  };
  return {
    id: b._id.toHexString(),
    orderNo: b.orderNo,
    status: b.status,
    ground: {
      id: b.groundId.toHexString(),
      name: ground?.name ?? b.groundName,
      address: ground?.venue.address ?? "",
      city: ground?.venue.city ?? "",
      point: ground?.venue.point ?? null,
      photo: ground?.photos[0] ? photoView(ground.photos[0]) : null,
      removed: ground?.status === "removed",
    },
    court: { id: b.courtId.toHexString(), name: b.courtName },
    business: { id: b.businessId.toHexString(), name: b.businessName },
    sport: b.sport ? sportsOf(sports, [b.sport])[0]! : null,
    slotMinutes: b.slotMinutes,
    addOns: b.addOns.map((a) => ({ id: a.id, name: a.name, price: a.price, per: a.per, quantity: a.quantity })),
    weeks: b.weeks,
    occurrences: b.occurrences.map(occurrence),
    firstAt: b.firstAt.toISOString(),
    lastEndsAt: b.lastEndsAt.toISOString(),
    price: { items: b.price.items, discount: b.price.discount ?? 0, platformFee: b.price.platformFee, total: b.price.total },
    coupon: appliedView(b.price.coupon),
    refundRule: refundText(b.refundRule),
    refunds: b.refunds.map((r) => ({ amount: r.amount, status: r.status, reason: r.reason, at: r.at.toISOString() })),
    reason: b.reason,
    payBy: b.status === "awaiting_payment" ? iso(b.holdUntil) : null,
    createdAt: b.createdAt.toISOString(),
    open: open.size > 0,
  };
}

async function contextOf(db: Database, bookings: TurfBookingDoc[]) {
  const [grounds, sports] = await Promise.all([
    db.turfGrounds.find({ _id: { $in: bookings.map((b) => b.groundId) } }, { projection: { name: 1, venue: 1, photos: { $slice: 1 }, status: 1 } }).toArray(),
    loadSports(db),
  ]);
  return { ground: (b: TurfBookingDoc) => grounds.find((g) => g._id.equals(b.groundId)) as Ground | undefined, sports };
}

/** Bookings as the customer sees them, with what cancelling each date gives back and whether it can be reviewed. */
export async function bookingViews(db: Database, bookings: TurfBookingDoc[]): Promise<TurfBooking[]> {
  if (!bookings.length) return [];
  const now = new Date();
  const [{ ground, sports }, reviews] = await Promise.all([contextOf(db, bookings), eligibility(db, bookings.map((b) => turfReviewable(b, now.getTime())))]);
  return bookings.map((b) => {
    const { open, ...fields } = bookingFields(b, ground(b), sports, "customer", now);
    return { ...fields, canCancel: b.status === "awaiting_payment" || open, invoices: invoiceRefs(b.invoices), ...reviews.get(b._id.toHexString()) };
  });
}

/** Bookings as the ground's owner and team see them, with the customer's phone. */
export async function deskBookingViews(db: Database, bookings: TurfBookingDoc[]): Promise<DeskBooking[]> {
  if (!bookings.length) return [];
  const now = new Date();
  const [{ ground, sports }, users] = await Promise.all([
    contextOf(db, bookings),
    db.users.find({ _id: { $in: bookings.map((b) => b.customerId) } }, { projection: { phone: 1 } }).toArray(),
  ]);
  return bookings.map((b) => {
    const { open, ...fields } = bookingFields(b, ground(b), sports, "ground", now);
    const phone = users.find((u) => u._id.equals(b.customerId))?.phone ?? null;
    return { ...fields, customer: { name: b.customerName, phone: b.status === "awaiting_payment" ? null : phone }, vendorShare: vendorShareOf(b), canCancel: open };
  });
}
