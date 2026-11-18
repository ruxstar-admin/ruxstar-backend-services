import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId } from "mongodb";
import { Type } from "typebox";
import { DateTime, Envelope, Errors, ListEnvelope, ObjectIdString, PageQuery, Strict } from "../../contracts/common.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import { ok, page } from "../../platform/envelope.js";
import { findPage } from "../../platform/pagination.js";

const Notification = Strict({
  id: ObjectIdString,
  kind: Type.Union([Type.Literal("social"), Type.Literal("account")]),
  type: Type.Union([
    Type.Literal("post.like"),
    Type.Literal("post.comment"),
    Type.Literal("post.removed"),
    Type.Literal("post.mention"),
    Type.Literal("report.resolved"),
    Type.Literal("kyc.approved"),
    Type.Literal("kyc.rejected"),
    Type.Literal("business.suspended"),
    Type.Literal("business.restored"),
    Type.Literal("order.placed"),
    Type.Literal("order.updated"),
    Type.Literal("user.followed"),
    Type.Literal("payout.updated"),
    Type.Literal("team.invited"),
    Type.Literal("team.joined"),
    Type.Literal("team.ended"),
    Type.Literal("review.posted"),
    Type.Literal("review.replied"),
    Type.Literal("review.removed"),
    Type.Literal("delivery.offer"),
    Type.Literal("delivery.updated"),
    Type.Literal("support.replied"),
    Type.Literal("support.resolved"),
    Type.Literal("kyc.reopened"),
    Type.Literal("event.ticket"),
    Type.Literal("event.updated"),
    Type.Literal("coaching.enrolled"),
    Type.Literal("coaching.updated"),
    Type.Literal("turf.booked"),
    Type.Literal("turf.updated"),
    Type.Literal("stays.reserved"),
    Type.Literal("stays.updated"),
    Type.Literal("shop.ordered"),
    Type.Literal("shop.updated"),
    Type.Literal("gigs.ordered"),
    Type.Literal("gigs.updated"),
  ]),
  title: Type.String(),
  body: Type.String(),
  link: Strict({
    screen: Type.Union(
      [
        Type.Literal("post"),
        Type.Literal("verification"),
        Type.Literal("business"),
        Type.Literal("order"),
        Type.Literal("shop_order"),
        Type.Literal("profile"),
        Type.Literal("payments"),
        Type.Literal("work"),
        Type.Literal("team"),
        Type.Literal("work_order"),
        Type.Literal("reviews"),
        Type.Literal("work_reviews"),
        Type.Literal("delivery_job"),
        Type.Literal("delivery_earnings"),
        Type.Literal("support"),
        Type.Literal("event"),
        Type.Literal("event_order"),
        Type.Literal("vendor_event"),
        Type.Literal("coaching_course"),
        Type.Literal("coaching_order"),
        Type.Literal("vendor_course"),
        Type.Literal("coaching_batch"),
        Type.Literal("turf_ground"),
        Type.Literal("turf_order"),
        Type.Literal("vendor_ground"),
        Type.Literal("stay_property"),
        Type.Literal("stay_order"),
        Type.Literal("vendor_property"),
        Type.Literal("store"),
        Type.Literal("store_product"),
        Type.Literal("store_order"),
        Type.Literal("vendor_store_order"),
        Type.Literal("gig"),
        Type.Literal("gig_order"),
        Type.Literal("vendor_gig_order"),
        Type.Literal("freelance"),
      ],
      {
        description:
          "`verification` opens the KYC screen (`id` is the track: base or delivery), `business` one of your businesses in the vendor portal, `order` one of your print orders, `shop_order` an order to your shop in the vendor portal, `profile` someone's profile (by user id), `payments` Payments in the vendor portal (`id` is the payout), `work` the Work area (`id` is the place on the team), `team` a business's Team in the vendor portal (`id` is the business), `work_order` an order to a shop you work at, in the Work area, `reviews` a business's reviews in the vendor portal (`id` is the business), `work_reviews` the reviews of a shop you work at (`id` is the place on the team), `delivery_job` a delivery in the Ruxstar Delivery app and `delivery_earnings` Earnings in the Ruxstar Delivery app (`id` is the payout), `support` one of your help tickets, `event` an event's page, `event_order` your tickets for an event (`id` is the ticket order), `vendor_event` one of your events in the vendor portal, `coaching_course` a course's page, `coaching_order` your enrolment or demo class, `vendor_course` one of your courses in the vendor portal, `coaching_batch` a batch's classes for its owner or coaches, `turf_ground` a ground's page, `turf_order` your turf booking, `vendor_ground` a ground's board for its owner or team, `stay_property` a PG or hostel's page, `stay_order` your PG or hostel reservation, `vendor_property` a property's bed board for its owner or team, `store` a local shop's page, `store_product` one of its products, `store_order` your order at a local shop, `vendor_store_order` an order at the desk of a local shop you own or work at, `gig` a freelancer's gig, `gig_order` your freelance order, `vendor_gig_order` an order you are doing as a freelancer, `freelance` your Freelancing home (`id` is your freelancer business; apps that don't know a screen ignore it); `id` says which",
      },
    ),
    id: Type.String(),
  }),
  read: Type.Boolean(),
  createdAt: DateTime,
});

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

const notifications: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["notifications"],
        summary: "Your notifications, newest first",
        description: "Kept for 90 days.",
        querystring: Strict(PageQuery),
        response: { 200: ListEnvelope(Notification), ...Errors },
        security,
      },
    },
    async (request) => {
      const db = requireDatabase(app.db);
      const { items, nextCursor } = await findPage(db.notifications, {
        filter: { userId: request.auth!.userId },
        sortField: "createdAt",
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      return page(
        request,
        items.map((n) => ({
          id: n._id.toHexString(),
          kind: n.type === "post.like" || n.type === "post.comment" || n.type === "post.mention" ? ("social" as const) : ("account" as const),
          type: n.type,
          title: n.title,
          body: n.body,
          link: n.link,
          read: n.readAt !== null,
          createdAt: n.createdAt.toISOString(),
        })),
        nextCursor,
      );
    },
  );

  app.get(
    "/unread-count",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["notifications"],
        summary: "How many notifications are unread",
        response: { 200: Envelope(Strict({ count: Type.Integer() })), ...Errors },
        security,
      },
    },
    async (request) => {
      const count = await requireDatabase(app.db).notifications.countDocuments({ userId: request.auth!.userId, readAt: null }, { limit: 100 });
      return ok(request, { count });
    },
  );

  app.post(
    "/read",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["notifications"],
        summary: "Mark one notification read, or all of them when no id is sent",
        body: Strict({ id: Type.Optional(ObjectIdString) }),
        response: { 200: Envelope(Strict({ done: Type.Literal(true) })), ...Errors },
        security,
      },
    },
    async (request) => {
      const { id } = request.body ?? {};
      await requireDatabase(app.db).notifications.updateMany(
        { userId: request.auth!.userId, readAt: null, ...(id ? { _id: new ObjectId(id) } : {}) },
        { $set: { readAt: new Date() } },
      );
      return ok(request, { done: true as const });
    },
  );
};

export default notifications;
