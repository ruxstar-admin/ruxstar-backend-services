import { MongoBulkWriteError, type WithId } from "mongodb";
import type { BusinessPhoto, Database, StayBedDoc, StayFacilityDoc, StayPropertyDoc, StayReservationDoc, StayRoomDoc } from "../../platform/db.js";
import { stamp } from "../../platform/db.js";
import { addDays } from "../coaching/rules.js";
import { appliedView } from "../coupons/coupons.js";
import { invoiceRefs } from "../invoices/views.js";
import { REVIEW_DAYS } from "../reviews/contracts.js";
import { eligibility, openUntil, type Reviewable } from "../reviews/reviews.js";
import type { ConsoleReservation, DeskReservation, PropertyCard, PropertyDetail, RoomView, StayReservation, VendorProperty } from "./contracts.js";
import { canGiveNotice, canMoveIn, canObject, customerCanCancel, ownerCanCancel, refundIfCancelled } from "./orders.js";
import { DEFAULT_FACILITIES, facilitiesOf, refundDaysOf, refundText, refundUntil, today, vendorShareOf, type StaysSettings } from "./rules.js";

const iso = (at: Date | null | undefined) => at?.toISOString() ?? null;
export const photoView = (p: BusinessPhoto) => ({ id: p.id, url: p.url, width: p.width, height: p.height });

/** Ruxstar's facilities list, in its order. The defaults are written the first time anyone asks. */
export async function loadFacilities(db: Database): Promise<WithId<StayFacilityDoc>[]> {
  const docs = await db.staysFacilities.find({}).sort({ order: 1, _id: 1 }).toArray();
  if (docs.length) return docs;
  const now = new Date();
  const defaults: StayFacilityDoc[] = DEFAULT_FACILITIES.map((f, i) => ({ _id: f.key, name: f.name, active: true, order: (i + 1) * 10, ...stamp(now) }));
  await db.staysFacilities.insertMany(defaults, { ordered: false }).catch((err: unknown) => {
    const errors = err instanceof MongoBulkWriteError ? [err.writeErrors].flat() : [];
    if (errors.length === 0 || errors.some((e) => e.code !== 11000)) throw err;
  });
  return db.staysFacilities.find({}).sort({ order: 1, _id: 1 }).toArray();
}

export const roomView = (room: WithId<StayRoomDoc>, beds: WithId<StayBedDoc>[]): RoomView => ({
  id: room._id.toHexString(),
  name: room.name,
  kind: room.kind,
  beds: room.beds,
  wholeRoom: room.kind === "private" || room.wholeRoom,
  prices: room.prices,
  features: room.features,
  status: room.status === "live" ? "live" : "paused",
  bedList: beds.filter((b) => b.roomId.equals(room._id) && b.status !== "removed").map((b) => ({ id: b._id.toHexString(), label: b.label })),
});

export function propertyCard(p: WithId<StayPropertyDoc>, facilities: Pick<StayFacilityDoc, "_id" | "name">[]): PropertyCard {
  return {
    id: p._id.toHexString(),
    name: p.name,
    kind: p.kind,
    business: { id: p.businessId.toHexString(), name: p.businessName },
    city: p.address.city,
    area: p.address.area,
    address: p.address.line,
    photo: p.photos[0] ? photoView(p.photos[0]) : null,
    for: p.for,
    occupants: p.occupants,
    food: p.food,
    facilities: facilitiesOf(facilities, p.facilities),
    priceFrom: p.priceFrom,
    units: p.units,
    roomKinds: p.roomKinds,
    noticeDays: p.noticeDays,
    deposit: p.deposit.amount,
    nearby: p.nearby,
  };
}

export async function propertyCards(db: Database, list: WithId<StayPropertyDoc>[]): Promise<PropertyCard[]> {
  if (!list.length) return [];
  const facilities = await loadFacilities(db);
  return list.map((p) => propertyCard(p, facilities));
}

/** A property's page: rooms with their beds, house rules, the deposit and the refund rule. */
export async function propertyDetail(
  db: Database,
  p: WithId<StayPropertyDoc>,
  settings: StaysSettings,
  state: { whyNot: string | null; rating?: PropertyDetail["rating"] },
): Promise<PropertyDetail> {
  const [rooms, facilities] = await Promise.all([
    db.staysRooms.find({ propertyId: p._id, status: { $ne: "removed" } }).sort({ order: 1, _id: 1 }).toArray(),
    loadFacilities(db),
  ]);
  const beds = await db.staysBeds.find({ roomId: { $in: rooms.map((r) => r._id) }, status: { $ne: "removed" } }).sort({ order: 1 }).toArray();
  const days = refundDaysOf(p.refundDays, settings);
  return {
    ...propertyCard(p, facilities),
    description: p.description,
    addressDetail: p.address,
    photos: p.photos.map(photoView),
    rules: p.rules,
    depositDetail: p.deposit,
    rooms: rooms.map((r) => roomView(r, beds)),
    refundDays: days,
    refundRule: refundText({ days }),
    platformFee: settings.platformFee,
    status: p.status,
    canReserve: state.whyNot === null,
    whyNot: state.whyNot,
    kycRequired: true,
    ...(state.rating ? { rating: state.rating } : {}),
  };
}

/** What a property still needs before it can be published. */
export function missingOf(p: StayPropertyDoc, rooms: StayRoomDoc[], businessLive: boolean): string[] {
  const missing: string[] = [];
  if (!businessLive) missing.push("Publish the business first");
  if (!p.photos.length) missing.push("Add at least one photo");
  if (!rooms.some((r) => r.status === "live")) missing.push("Add a room that's open for reservations");
  return missing;
}

export async function vendorPropertyView(db: Database, p: WithId<StayPropertyDoc>, settings: StaysSettings, whyNot: string | null = null): Promise<VendorProperty> {
  const now = new Date();
  const [detail, rooms, business, upcoming, staying] = await Promise.all([
    propertyDetail(db, p, settings, {
      whyNot: whyNot ?? (p.status === "live" ? "This is your property." : p.status === "removed" ? "Ruxstar took this property down." : "This is your draft. Publish it to take reservations."),
    }),
    db.staysRooms.find({ propertyId: p._id, status: { $ne: "removed" } }, { projection: { status: 1 } }).toArray(),
    db.businesses.findOne({ _id: p.businessId }, { projection: { status: 1 } }),
    db.staysReservations.countDocuments({ propertyId: p._id, status: "confirmed" }),
    db.staysReservations.countDocuments({ propertyId: p._id, status: "moved_in", $or: [{ until: null }, { until: { $gt: now } }] }),
  ]);
  return {
    ...detail,
    canReserve: false,
    refundLimits: { min: settings.refundDays, max: Math.max(settings.maxRefundDays, settings.refundDays) },
    publishedAt: iso(p.publishedAt),
    removal: p.removal ? { reason: p.removal.reason, at: p.removal.at.toISOString() } : null,
    missing: p.status === "draft" ? missingOf(p, rooms as StayRoomDoc[], business?.status === "live") : [],
    upcoming,
    staying,
  };
}

/**
 * A stay opens for a review once the tenant has moved in, and stays open while they live there and for 30 days after they
 * move out.
 */
export function staysReviewable(r: StayReservationDoc, now = Date.now()): Reviewable {
  const lived = r.status === "moved_in" || r.status === "moved_out";
  const ended = r.until && r.until.getTime() <= now ? r.until : null;
  const until = !lived ? null : ended ? openUntil(ended, now) : new Date(now + REVIEW_DAYS * 24 * 60 * 60_000);
  return {
    module: "stays",
    orderType: "stay_reservation",
    orderId: r._id,
    orderNo: r.orderNo,
    businessId: r.businessId,
    businessName: r.businessName,
    vendorId: r.vendorId,
    customerId: r.customerId,
    label: `${r.propertyName}, ${r.roomName}`,
    listing: { type: "property", id: r.propertyId },
    until,
    closed:
      r.status === "awaiting_payment" || r.status === "cancelled"
        ? "Only stays you've moved into can be reviewed."
        : lived
          ? `Reviews close ${REVIEW_DAYS} days after you move out.`
          : "You can review the property once you've moved in.",
  };
}

type Property = Pick<StayPropertyDoc, "_id" | "name" | "address" | "photos" | "status">;

const cancelledBy = (by: StayReservationDoc["timeline"][number]["by"]) =>
  by === "customer" ? ("customer" as const) : by === "staff" ? ("ruxstar" as const) : by === "system" ? ("system" as const) : ("property" as const);
const movedOutBy = (by: StayReservationDoc["timeline"][number]["by"]) => (by === "customer" ? ("tenant" as const) : by === "staff" ? ("ruxstar" as const) : ("property" as const));

/** Moved in and not moved out. */
export const isStaying = (r: Pick<StayReservationDoc, "status" | "until">, now = new Date()) => r.status === "moved_in" && (!r.until || r.until > now);

function reservationFields(r: StayReservationDoc, property: Property | undefined, now: Date) {
  return {
    id: r._id.toHexString(),
    orderNo: r.orderNo,
    status: r.status,
    property: {
      id: r.propertyId.toHexString(),
      name: property?.name ?? r.propertyName,
      kind: r.kind,
      address: property?.address.line ?? "",
      city: property?.address.city ?? "",
      point: property?.address.point ?? null,
      photo: property?.photos[0] ? photoView(property.photos[0]) : null,
      removed: property?.status === "removed",
    },
    room: { id: r.roomId.toHexString(), name: r.roomName, kind: r.roomKind },
    beds: r.bedIds.map((id, i) => ({ id: id.toHexString(), label: r.bedLabels[i] ?? "" })),
    whole: r.whole,
    business: { id: r.businessId.toHexString(), name: r.businessName },
    stay: r.unit,
    units: r.units,
    moveIn: r.moveIn,
    from: r.from.toISOString(),
    until: iso(r.until),
    price: { unitPrice: r.price.unitPrice, quantity: r.price.quantity, items: r.price.items, discount: r.price.discount ?? 0, platformFee: r.price.platformFee, total: r.price.total },
    coupon: appliedView(r.price.coupon),
    deposit: r.deposit,
    noticeDays: r.noticeDays,
    refundRule: refundText(r.refundRule),
    refundUntil: refundUntil(r.refundRule, r.from).toISOString(),
    refund: r.refund ? { amount: r.refund.amount, status: r.refund.status, reason: r.refund.reason, at: r.refund.at.toISOString() } : null,
    cancellation: r.cancellation ? { by: cancelledBy(r.cancellation.by), reason: r.cancellation.reason, at: r.cancellation.at.toISOString() } : null,
    movedInAt: iso(r.movedIn?.at),
    objectionUntil: iso(r.objectionUntil),
    objection: r.objection
      ? { reason: r.objection.reason, at: r.objection.at.toISOString(), status: r.objection.status, note: r.objection.note, resolvedAt: iso(r.objection.resolvedAt) }
      : null,
    moveOut: r.moveOut ? { on: r.moveOut.on, kind: r.moveOut.kind, by: movedOutBy(r.moveOut.by) } : null,
    staying: isStaying(r, now),
    reason: r.reason,
    payBy: r.status === "awaiting_payment" ? iso(r.holdUntil) : null,
    createdAt: r.createdAt.toISOString(),
  };
}

async function propertiesOf(db: Database, list: StayReservationDoc[]) {
  const docs = await db.staysProperties
    .find({ _id: { $in: list.map((r) => r.propertyId) } }, { projection: { name: 1, address: 1, photos: { $slice: 1 }, status: 1 } })
    .toArray();
  return (r: StayReservationDoc) => docs.find((p) => p._id.equals(r.propertyId)) as Property | undefined;
}

/** Reservations as the tenant sees them, with what cancelling gives back, objection and notice, and whether it can be reviewed. */
export async function reservationViews(db: Database, list: StayReservationDoc[]): Promise<StayReservation[]> {
  if (!list.length) return [];
  const now = new Date();
  const [property, reviews] = await Promise.all([propertiesOf(db, list), eligibility(db, list.map((r) => staysReviewable(r, now.getTime())))]);
  return list.map((r) => {
    const notice = canGiveNotice(r);
    return {
      ...reservationFields(r, property(r), now),
      canCancel: customerCanCancel(r),
      refundIfCancelled: customerCanCancel(r) ? refundIfCancelled(r, "customer", now) : null,
      canObject: canObject(r, now),
      canGiveNotice: notice,
      noticeFrom: notice ? addDays(today(now), r.noticeDays) : null,
      invoices: invoiceRefs(r.invoices),
      ...reviews.get(r._id.toHexString()),
    };
  });
}

const payoutOf = (r: StayReservationDoc): DeskReservation["payout"] => {
  if (r.status === "awaiting_payment") return "none";
  if (r.refund) return "refunded";
  if (r.releasedAt) return "released";
  if (r.objection?.status === "open") return "objection";
  return "waiting";
};

/** Reservations as the property's owner and team see them, with the tenant's phone and whether they're verified. */
export async function deskReservationViews(db: Database, list: StayReservationDoc[]): Promise<DeskReservation[]> {
  if (!list.length) return [];
  const now = new Date();
  const [property, users] = await Promise.all([
    propertiesOf(db, list),
    db.users.find({ _id: { $in: list.map((r) => r.customerId) } }, { projection: { phone: 1, kyc: 1 } }).toArray(),
  ]);
  return list.map((r) => {
    const user = users.find((u) => u._id.equals(r.customerId));
    return {
      ...reservationFields(r, property(r), now),
      tenant: {
        name: r.customerName,
        phone: r.status === "awaiting_payment" ? null : (user?.phone ?? null),
        verified: user ? user.kyc?.base === "approved" : r.tenantVerified,
      },
      vendorShare: vendorShareOf(r),
      payout: payoutOf(r),
      releaseAt: iso(r.releaseAt),
      canMoveIn: canMoveIn(r, now),
      canMoveOut: r.status === "moved_in",
      canCancel: ownerCanCancel(r),
    };
  });
}

/** Reservations as Ruxstar staff see them, with when the owner's money moves. */
export async function consoleReservationViews(db: Database, list: StayReservationDoc[]): Promise<ConsoleReservation[]> {
  if (!list.length) return [];
  const now = new Date();
  const property = await propertiesOf(db, list);
  return list.map((r) => ({
    ...reservationFields(r, property(r), now),
    tenant: { id: r.customerId.toHexString(), name: r.customerName },
    vendorId: r.vendorId.toHexString(),
    releaseAt: iso(r.releaseAt),
    releasedAt: iso(r.releasedAt),
  }));
}
