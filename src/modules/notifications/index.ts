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
  type: Type.Union([Type.Literal("post.like"), Type.Literal("post.comment"), Type.Literal("kyc.approved"), Type.Literal("kyc.rejected")]),
  title: Type.String(),
  body: Type.String(),
  link: Strict({
    screen: Type.Union([Type.Literal("post"), Type.Literal("verification")], { description: "`verification` opens the KYC screen; `id` is base or vendor" }),
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
          kind: n.type.startsWith("kyc.") ? ("account" as const) : ("social" as const),
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
