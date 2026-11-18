import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId, type Filter, type WithId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { requireDatabase } from "../../platform/context.js";
import type { AuditLogDoc, Database } from "../../platform/db.js";
import { page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { findPage } from "../../platform/pagination.js";
import { rupees } from "../pod/orders.js";
import { ownedBy, requireVendor } from "./businesses.js";
import { ActivityList, ActivityQuery, BusinessParams, type ActivityEntry } from "./contracts.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

type Entry = WithId<AuditLogDoc>;
type Change = { from: unknown; to: unknown } | undefined;

/** What the lines name: orders by number, coupons by code and people on the team by name. */
interface Refs {
  orders: Map<string, number>;
  coupons: Map<string, string>;
  people: Map<string, string>;
}

const DETAILS: Record<string, string> = { name: "name", description: "description", phone: "phone number", location: "address", gstin: "GSTIN" };
const SETUP: Record<string, string> = {
  products: "products",
  serveAll: "delivery area",
  cities: "delivery area",
  prices: "prices",
  turnaroundDays: "turnaround time",
  minOrder: "minimum order",
  notes: "notes for customers",
};
const MOVED: Record<string, (no: string) => string> = {
  placed: (no) => `Paid for order ${no}`,
  accepted: (no) => `Accepted order ${no}`,
  rejected: (no) => `Turned down order ${no}`,
  printing: (no) => `Started printing order ${no}`,
  ready: (no) => `Marked order ${no} ready`,
  out_for_delivery: (no) => `Sent order ${no} out for delivery`,
  delivered: (no) => `Marked order ${no} delivered`,
  cancelled: (no) => `Cancelled order ${no}`,
};
const STORE_MOVED: Record<string, (no: string) => string> = {
  accepted: (no) => `Accepted order ${no}`,
  packed: (no) => `Packed order ${no}`,
  out_for_delivery: (no) => `Sent order ${no} out for delivery`,
  ready_for_pickup: (no) => `Marked order ${no} ready for pickup`,
  delivered: (no) => `Marked order ${no} delivered`,
};

/** "a, b and c" */
const listOf = (items: string[]) => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const labels = (diff: Entry["diff"], words: Record<string, string>) => [...new Set(Object.keys(diff).flatMap((k) => (words[k] ? [words[k]] : [])))];
const amountOf = (change: Change) => Number(change?.to ?? 0) - Number(change?.from ?? 0);
const starsOf = (n: unknown) => `${Number(n)} star${Number(n) === 1 ? "" : "s"}`;
const idOf = (e: Entry) => (typeof e.target.id === "string" ? e.target.id : e.target.id.toHexString());

/** What happened, in the owner's words, without who did it. */
export function lineOf(e: Entry, refs: Refs): string {
  const d = e.diff as Record<string, Change>;
  const target = idOf(e);
  const no = refs.orders.has(target) ? `#${refs.orders.get(target)}` : "";
  const code = refs.coupons.get(target) ?? (typeof d.code?.to === "string" ? d.code.to : "");
  const person = refs.people.get(target) ?? "someone";
  const reason = typeof d.reason?.to === "string" ? `: ${d.reason.to}` : "";
  switch (e.action) {
    case "pod_order.status": {
      const to = String(d.status?.to ?? "");
      return MOVED[to]?.(no) ?? `Moved order ${no}`;
    }
    case "pod_order.refund":
      return d.status?.to === "refunded" ? `Refunded order ${no} in full` : `Refunded ${rupees(amountOf(d.refunded))} on order ${no}`;
    case "pod_order.settle":
      return d.problem?.to === "dismissed"
        ? `Closed the problem on order ${no} without a refund`
        : `Settled the problem on order ${no} with ${rupees(amountOf(d.refunded))} back to the customer`;
    case "pod_order.release":
      return `Released the shop's share of order ${no} early`;
    case "pod_order.problem":
      return `Reported a problem with order ${no}`;
    case "review.create":
      return `Rated order ${no} ${starsOf(d.rating?.to)}`;
    case "review.update":
      return d.rating ? `Changed the rating of order ${no} to ${starsOf(d.rating.to)}` : `Changed the review of order ${no}`;
    case "review.delete":
      return `Deleted the review of order ${no}`;
    case "review.reply":
      return d.reply?.from === null ? `Replied to the review of order ${no}` : `Changed the reply to the review of order ${no}`;
    case "review.reply_delete":
      return `Took down the reply to the review of order ${no}`;
    case "review.remove":
      return `Removed the review of order ${no}${reason}`;
    case "business.update": {
      const what = labels(e.diff, DETAILS);
      return what.length ? `Changed the ${listOf(what)}` : "Changed the details";
    }
    case "business.catalog": {
      const what = labels(e.diff, SETUP);
      return what.length ? `Changed the ${listOf(what)}` : "Changed the print setup";
    }
    case "business.photo_add":
      return "Added a photo";
    case "business.photo_remove":
      return "Removed a photo";
    case "business.open":
      return "Opened the shop";
    case "business.close":
      return "Closed the shop";
    case "business.publish":
      return "Published the business";
    case "business.suspend":
      return `Put the business on hold${reason}`;
    case "business.restore":
      return "Took the business off hold";
    case "coupon.create":
      return `Made coupon ${code}`;
    case "coupon.update": {
      const keys = Object.keys(d).filter((k) => k !== "stoppedByRuxstar");
      return keys.length === 1 && keys[0] === "active" ? `Switched coupon ${code} ${d.active?.to ? "on" : "off"}` : `Changed coupon ${code}`;
    }
    case "post.create":
      return "Posted for the business";
    case "team.invite":
      return `Invited ${person} to the team`;
    case "team.update":
      if (!d.pay) return `Changed what ${person} can do`;
      return d.permissions ? `Changed what ${person} can do and the pay on offer` : `Changed the pay offered to ${person}`;
    case "team.remove":
      return d.status?.from === "invited" ? `Cancelled ${person}'s invite` : `Removed ${person} from the team${reason}`;
    case "team.leave":
      return "Left the team";
    case "team.join":
      return "Joined the team";
    case "team.decline":
      return "Turned down the invite to the team";
    case "turf_booking.cancel":
      return `Cancelled booking ${no}${reason}`;
    case "turf_booking.arrival":
      return `Marked booking ${no} ${d.arrival?.to === "no_show" ? "a no-show" : "arrived"}`;
    case "turf_slot.block":
      return `Blocked ${Number(d.slots?.to ?? 0)} slot${Number(d.slots?.to ?? 0) === 1 ? "" : "s"}${typeof d.note?.to === "string" ? `: ${d.note.to}` : ""}`;
    case "turf_slot.unblock":
      return `Unblocked ${Number(d.slots?.to ?? 0)} slot${Number(d.slots?.to ?? 0) === 1 ? "" : "s"}`;
    case "turf_ground.create":
      return `Added the ground ${String(d.name?.to ?? "")}`;
    case "turf_ground.update":
      return "Changed a ground";
    case "turf_ground.publish":
      return "Published a ground";
    case "turf_ground.delete":
      return "Deleted a draft ground";
    case "turf_ground.take_down":
      return `Ruxstar took down a ground${reason}`;
    case "turf_court.create":
      return `Added the court ${String(d.name?.to ?? "")}`;
    case "turf_court.update":
      return d.prices || d.addOns ? "Changed a court's prices" : "Changed a court";
    case "turf_court.delete":
      return "Removed a court";
    case "stay_reservation.cancel":
      return `Cancelled reservation ${no}${reason}`;
    case "stay_reservation.moved_in":
      return `Marked reservation ${no} moved in`;
    case "stay_reservation.move_out":
      return `Marked the move-out for reservation ${no}`;
    case "stay_reservation.notice":
      return `The tenant of reservation ${no} gave notice`;
    case "stay_reservation.objection":
      return `The tenant of reservation ${no} objected`;
    case "stay_reservation.objection_withdraw":
      return `The tenant of reservation ${no} took back their objection`;
    case "stay_reservation.objection_decide":
      return `Ruxstar closed the objection on reservation ${no}`;
    case "stay_property.create":
      return `Added the property ${String(d.name?.to ?? "")}`;
    case "stay_property.update":
      return "Changed a property";
    case "stay_property.publish":
      return "Published a property";
    case "stay_property.delete":
      return "Deleted a draft property";
    case "stay_property.take_down":
      return `Ruxstar took down a property${reason}`;
    case "stay_room.create":
      return `Added the room ${String(d.name?.to ?? "")}`;
    case "stay_room.update":
      return "Changed a room";
    case "stay_room.prices":
      return "Changed a room's prices";
    case "stay_room.status":
      return `Marked a room ${d.status?.to === "paused" ? "full" : "free"}`;
    case "stay_room.delete":
      return "Removed a room";
    case "stay_bed.status":
      return `Marked a bed ${d.status?.to === "closed" ? "full" : "free"}`;
    case "shop_order.status":
      return STORE_MOVED[String(d.status?.to ?? "")]?.(no) ?? `Moved order ${no}`;
    case "shop_order.cancel":
      return `Cancelled order ${no}${reason}`;
    case "shop_order.return_request":
      return `The customer asked to return order ${no}`;
    case "shop_order.return_decide":
      return d.return?.to === "approved" ? `Accepted the return of order ${no}` : `Turned down the return of order ${no}`;
    case "shop_order.return_refund":
      return `Refunded the return of order ${no}`;
    case "shop_product.create":
      return `Added the product ${String(d.title?.to ?? "")}`;
    case "shop_product.update":
      return d.variants ? "Changed a product's variants" : "Changed a product";
    case "shop_product.stock":
      return "Changed a product's stock";
    case "shop_product.delete":
      return `Deleted the product ${String(d.title?.from ?? "")}`;
    case "shop_product.take_down":
      return `Ruxstar took down a product${reason}`;
    case "shop.setup":
      return "Changed delivery, pickup or returns";
    case "freelancer.start":
      return "Started freelancing";
    case "freelancer.update":
      return "Changed the freelancer profile";
    case "gig.create":
      return "Made a gig";
    case "gig.update":
      return "Changed a gig";
    case "gig.delete":
      return "Deleted a gig";
    case "gig.publish":
      return d.status?.from === "paused" ? "Took orders for a gig again" : "Published a gig";
    case "gig.pause":
      return "Paused a gig";
    case "gig.take_down":
      return `Ruxstar took down a gig${reason}`;
    case "gig_quote.withdraw":
      return "Withdrew a custom offer";
    case "gig_order.accept":
      return `Accepted order ${no}`;
    case "gig_order.deliver":
      return `Delivered order ${no}`;
    case "gig_order.cancel":
      return `Cancelled order ${no}${reason}`;
    case "gig_order.approve":
      return `The customer approved order ${no}`;
    case "gig_order.revision":
      return `The customer asked for a revision of order ${no}`;
    case "gig_order.dispute":
      return `The customer reported a problem with order ${no}`;
    case "gig_order.decide":
      return `Ruxstar decided the problem on order ${no}`;
    default:
      return "Made a change";
  }
}

async function present(db: Database, business: { _id: ObjectId; ownerId: ObjectId }, items: Entry[]): Promise<ActivityEntry[]> {
  const targets = (type: string) => items.flatMap((e) => (e.target.type === type && typeof e.target.id !== "string" ? [e.target.id] : []));
  const actorIds = items.flatMap((e) => (e.actor.id ? [e.actor.id] : []));
  const [orders, tickets, enrolments, bookings, reservations, storeOrders, gigOrders, coupons, places, crew] = await Promise.all([
    db.podOrders.find({ _id: { $in: targets("pod_order") } }, { projection: { orderNo: 1 } }).toArray(),
    db.eventOrders.find({ _id: { $in: targets("event_order") } }, { projection: { orderNo: 1 } }).toArray(),
    db.coachingOrders.find({ _id: { $in: targets("coaching_order") } }, { projection: { orderNo: 1 } }).toArray(),
    db.turfBookings.find({ _id: { $in: targets("turf_booking") } }, { projection: { orderNo: 1 } }).toArray(),
    db.staysReservations.find({ _id: { $in: targets("stay_reservation") } }, { projection: { orderNo: 1 } }).toArray(),
    db.shopOrders.find({ _id: { $in: targets("shop_order") } }, { projection: { orderNo: 1 } }).toArray(),
    db.gigOrders.find({ _id: { $in: targets("gig_order") } }, { projection: { orderNo: 1 } }).toArray(),
    db.coupons.find({ _id: { $in: targets("coupon") } }, { projection: { code: 1 } }).toArray(),
    db.employments.find({ _id: { $in: targets("employment") }, businessId: business._id }, { projection: { userId: 1 } }).toArray(),
    db.employments.find({ businessId: business._id, userId: { $in: actorIds } }, { projection: { userId: 1 } }).toArray(),
  ]);
  const team = new Set(crew.map((c) => c.userId.toHexString()));
  const userIds = [...actorIds.filter((id) => id.equals(business.ownerId) || team.has(id.toHexString())), ...places.map((p) => p.userId)];
  const users = await db.users.find({ _id: { $in: userIds } }, { projection: { name: 1, username: 1, avatar: 1 } }).toArray();
  const userBy = new Map(users.map((u) => [u._id.toHexString(), u]));
  const nameOf = (id: ObjectId) => {
    const u = userBy.get(id.toHexString());
    return u?.name || (u?.username ? `@${u.username}` : "Someone");
  };
  const refs: Refs = {
    orders: new Map([...orders, ...tickets, ...enrolments, ...bookings, ...reservations, ...storeOrders, ...gigOrders].map((o) => [o._id.toHexString(), o.orderNo])),
    coupons: new Map(coupons.map((c) => [c._id.toHexString(), c.code])),
    people: new Map(places.map((p) => [p._id.toHexString(), nameOf(p.userId)])),
  };

  return items.map((e) => {
    const id = e.actor.id;
    const kind: ActivityEntry["who"]["kind"] = id?.equals(business.ownerId)
      ? "you"
      : id && team.has(id.toHexString())
        ? "team"
        : e.actor.kind === "user" && id
          ? "customer"
          : "ruxstar";
    const user = id && (kind === "you" || kind === "team") ? userBy.get(id.toHexString()) : undefined;
    return {
      id: e._id.toHexString(),
      at: e.at.toISOString(),
      who: {
        kind,
        id: user ? id!.toHexString() : null,
        name: kind === "you" ? "You" : kind === "team" ? nameOf(id!) : kind === "customer" ? "A customer" : "Ruxstar",
        username: user?.username ?? null,
        avatar: user?.avatar ?? null,
      },
      action: e.action,
      line: lineOf(e, refs),
      orderId: e.target.type === "pod_order" ? idOf(e) : null,
    };
  });
}

/** What happened at a business, by whom: the owner, the team, customers and Ruxstar. Only the owner sees it. */
const activity: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  app.get(
    "/businesses/:id/activity",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "What happened at a business and who did it, newest first",
        description:
          "Orders moved and refunded, reviews and replies, shop and coupon changes, posts and the team, by you, the team, customers or Ruxstar. " +
          "`by` shows one person's. Customers and the Ruxstar team stay unnamed.",
        params: BusinessParams,
        querystring: ActivityQuery,
        response: { 200: ActivityList, ...Errors },
        security,
      },
    },
    async (request) => {
      const business = await db().businesses.findOne(ownedBy(new ObjectId(request.params.id), request.auth!.userId), { projection: { ownerId: 1 } });
      if (!business) throw new AppError("NOT_FOUND", "Business not found.");
      const { by, cursor, limit } = request.query;
      const filter: Filter<AuditLogDoc> = { "scope.businessId": business._id, ...(by ? { "actor.id": new ObjectId(by) } : {}) };
      const { items, nextCursor } = await findPage(db().auditLogs, { filter, sortField: "at", cursor, limit });
      return page(request, await present(db(), business, items as Entry[]), nextCursor);
    },
  );
};

export default activity;
