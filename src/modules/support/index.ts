import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { requireDatabase } from "../../platform/context.js";
import type { SupportMessageDoc, SupportTicketDoc } from "../../platform/db.js";
import { stamp } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { PRIVATE_PHOTO_MAX_BYTES, toPrivateJpeg } from "../../platform/private-photo.js";
import {
  MessageCreate,
  MessageParams,
  OPEN_TICKETS_MAX,
  PHOTO_WINDOW_MINUTES,
  SUPPORT_PHOTOS_MAX,
  TicketCreate,
  TicketList,
  TicketOne,
  TicketParams,
  TicketsQuery,
} from "./contracts.js";
import { requireRequester } from "./pass.js";
import {
  customerMessages,
  detailView,
  dueAt,
  nextTicketNo,
  reopenUntil,
  resolveContext,
  slaHours,
  startingPriority,
  statusOf,
  supportPhotoKey,
  supportPhotoLinks,
  ticketView,
} from "./tickets.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

/**
 * Help tickets, for the person who opened them. An account on hold reaches these with the support pass its sign-in
 * returns, and nothing else.
 */
const support: FastifyPluginAsyncTypebox = async (app) => {
  app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: PRIVATE_PHOTO_MAX_BYTES }, (_request, body, done) => done(null, body));
  const db = () => requireDatabase(app.db);

  const mine = async (userId: ObjectId, id: string) => {
    const doc = await db().supportTickets.findOne({ _id: new ObjectId(id), requesterId: userId });
    if (!doc) throw new AppError("NOT_FOUND", "Ticket not found.");
    return doc;
  };

  const present = async (request: Parameters<typeof supportPhotoLinks>[1], doc: SupportTicketDoc, viewer: ObjectId) =>
    detailView(doc, await customerMessages(db(), doc._id), viewer, supportPhotoLinks(app, request));

  app.get(
    "/tickets",
    {
      preHandler: requireRequester,
      schema: { tags: ["support"], summary: "Your help tickets, latest activity first", querystring: TicketsQuery, response: { 200: TicketList, ...Errors }, security },
    },
    async (request) => {
      const now = new Date();
      const { items, nextCursor } = await findPage(db().supportTickets, {
        filter: { requesterId: request.auth!.userId },
        sortField: "lastAt",
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      return page(request, items.map((doc) => ticketView(doc, now)), nextCursor);
    },
  );

  app.post(
    "/tickets",
    {
      preHandler: [requireRequester, idempotent],
      config: { rateLimit: { max: 10, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["support"],
        summary: "Ask Ruxstar for help",
        description: `Up to ${OPEN_TICKETS_MAX} tickets open at once. Add photos to the first message with POST /tickets/{id}/messages/{messageId}/photos.`,
        body: TicketCreate,
        response: { 200: TicketOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const userId = request.auth!.userId;
      const { category, context } = request.body;
      const subject = request.body.subject.trim();
      const text = request.body.text.trim();
      if (subject.length < 3) throw new AppError("VALIDATION_FAILED", "Say in a few words what it is about.", [{ path: "body/subject", message: "Too short" }]);
      if (!text) throw new AppError("VALIDATION_FAILED", "Tell us what happened.", [{ path: "body/text", message: "Required" }]);
      const open = await database.supportTickets.countDocuments({ requesterId: userId, status: { $in: ["open", "waiting"] } });
      if (open >= OPEN_TICKETS_MAX) {
        throw new AppError("CONFLICT", `You have ${OPEN_TICKETS_MAX} open tickets. Reply on one of those, or wait for an answer.`);
      }
      const about = context ? await resolveContext(database, userId, context) : null;
      const priority = startingPriority(category);
      const hours = await slaHours(database);
      const now = new Date();
      const ticket = await database.transaction(async (session) => {
        const doc: SupportTicketDoc = {
          _id: new ObjectId(),
          ticketNo: await nextTicketNo(database, session),
          requesterId: userId,
          category,
          subject,
          context: about,
          status: "open",
          priority,
          assigneeId: null,
          awaitingSince: now,
          slaDueAt: dueAt(now, priority, hours),
          lastAt: now,
          lastFrom: "customer",
          seenAt: now,
          resolvedAt: null,
          reopenUntil: null,
          ...stamp(now),
        };
        const message: SupportMessageDoc = { _id: new ObjectId(), ticketId: doc._id, authorId: userId, from: "customer", text, photos: [], internal: false, at: now };
        await database.supportTickets.insertOne(doc, { session });
        await database.supportMessages.insertOne(message, { session });
        return doc;
      });
      return ok(request, await present(request, ticket, userId));
    },
  );

  app.get(
    "/tickets/:id",
    {
      preHandler: requireRequester,
      schema: { tags: ["support"], summary: "One of your tickets and its replies", description: "Opening it marks Ruxstar's replies read.", params: TicketParams, response: { 200: TicketOne, ...Errors }, security },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const doc = await mine(userId, request.params.id);
      const seen = await db().supportTickets.findOneAndUpdate({ _id: doc._id }, { $set: { seenAt: new Date() } }, { returnDocument: "after" });
      return ok(request, await present(request, seen ?? doc, userId));
    },
  );

  app.post(
    "/tickets/:id/messages",
    {
      preHandler: [requireRequester, idempotent],
      config: { rateLimit: { max: 60, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["support"],
        summary: "Reply on your ticket",
        description: "Replying to a resolved ticket reopens it, for 7 days after it was resolved. A closed ticket needs a new one.",
        params: TicketParams,
        body: MessageCreate,
        response: { 200: TicketOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const userId = request.auth!.userId;
      const doc = await mine(userId, request.params.id);
      if (statusOf(doc) === "closed") throw new AppError("CONFLICT", "This ticket is closed. Open a new one if you still need help.");
      const text = request.body.text.trim();
      if (!text) throw new AppError("VALIDATION_FAILED", "Write a message.", [{ path: "body/text", message: "Required" }]);
      const now = new Date();
      const since = doc.awaitingSince ?? now;
      const hours = await slaHours(database);
      const updated = await database.transaction(async (session) => {
        await database.supportMessages.insertOne(
          { _id: new ObjectId(), ticketId: doc._id, authorId: userId, from: "customer", text, photos: [], internal: false, at: now },
          { session },
        );
        return database.supportTickets.findOneAndUpdate(
          { _id: doc._id },
          {
            $set: {
              status: "open",
              awaitingSince: since,
              slaDueAt: dueAt(since, doc.priority, hours),
              lastAt: now,
              lastFrom: "customer",
              seenAt: now,
              resolvedAt: null,
              reopenUntil: null,
              updatedAt: now,
            },
          },
          { session, returnDocument: "after" },
        );
      });
      if (!updated) throw new AppError("CONFLICT");
      return ok(request, await present(request, updated, userId));
    },
  );

  app.post(
    "/tickets/:id/messages/:messageId/photos",
    {
      preHandler: [requireRequester, idempotent],
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["support"],
        summary: "Add a photo to your message",
        description: `Send a JPEG, PNG or WebP up to 8 MB as the body, with its Content-Type. Up to ${SUPPORT_PHOTOS_MAX} photos on a message, within ${PHOTO_WINDOW_MINUTES} minutes of sending it.`,
        params: MessageParams,
        response: { 200: TicketOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const data = request.body;
      if (!Buffer.isBuffer(data) || !data.length) throw new AppError("PHOTO_INVALID");
      const database = db();
      const userId = request.auth!.userId;
      const doc = await mine(userId, request.params.id);
      const messageId = new ObjectId(request.params.messageId);
      const message = await database.supportMessages.findOne({ _id: messageId, ticketId: doc._id, authorId: userId, from: "customer" });
      if (!message) throw new AppError("NOT_FOUND", "Message not found.");
      if (Date.now() - message.at.getTime() > PHOTO_WINDOW_MINUTES * 60_000) {
        throw new AppError("CONFLICT", "Photos can be added just after sending a message. Send a new message with them.");
      }
      if (message.photos.length >= SUPPORT_PHOTOS_MAX) throw new AppError("CONFLICT", `Up to ${SUPPORT_PHOTOS_MAX} photos on a message.`);
      const jpeg = await toPrivateJpeg(data);
      const id = new ObjectId();
      const key = supportPhotoKey(doc._id, id);
      await app.printFiles.save(key, jpeg, "image/jpeg");
      const added = await database.supportMessages.updateOne(
        { _id: messageId, [`photos.${SUPPORT_PHOTOS_MAX - 1}`]: { $exists: false } },
        { $push: { photos: { id, key, bytes: jpeg.length } } },
      );
      if (!added.modifiedCount) {
        await app.printFiles.remove(key);
        throw new AppError("CONFLICT", `Up to ${SUPPORT_PHOTOS_MAX} photos on a message.`);
      }
      return ok(request, await present(request, doc, userId));
    },
  );

  app.post(
    "/tickets/:id/resolve",
    {
      preHandler: [requireRequester, idempotent],
      schema: {
        tags: ["support"],
        summary: "Mark your ticket solved",
        description: "You can still reply to reopen it for 7 days.",
        params: TicketParams,
        response: { 200: TicketOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const doc = await mine(userId, request.params.id);
      if (doc.status === "resolved") throw new AppError("CONFLICT", "This ticket is already resolved.");
      const now = new Date();
      const updated = await db().supportTickets.findOneAndUpdate(
        { _id: doc._id, status: doc.status },
        { $set: { status: "resolved", awaitingSince: null, slaDueAt: null, resolvedAt: now, reopenUntil: reopenUntil(now), seenAt: now, updatedAt: now } },
        { returnDocument: "after" },
      );
      if (!updated) throw new AppError("CONFLICT");
      return ok(request, await present(request, updated, userId));
    },
  );
};

export default support;
