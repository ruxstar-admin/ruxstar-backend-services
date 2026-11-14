import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type Filter } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf, writeAudit, type Diff } from "../../platform/audit.js";
import { requireRuxstar } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { SupportMessageDoc, SupportTicketDoc } from "../../platform/db.js";
import { stamp } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { clip, notifySupport } from "../notifications/notify.js";
import {
  Agents,
  QueueQuery,
  StaffReply,
  StaffTicketList,
  StaffTicketOne,
  SummaryResult,
  SupportSettingsOne,
  SupportSettingsPut,
  TicketParams,
  TicketPatch,
  type StaffTicket,
  type StaffTicketDetail,
} from "../support/contracts.js";
import {
  dueAt,
  photoViews,
  reopenUntil,
  SLA_SETTING,
  slaHours,
  statusOf,
  supportPhotoLinks,
  ticketNumber,
  type SupportPhotoLinks,
} from "../support/tickets.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const STAFF_PROJECTION = { name: 1, username: 1, status: 1, deletion: 1 } as const;

/** The console's help desk: the queue, replies and notes, assigning, status and priority, and the reply-by times. */
const supportDesk: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  async function names(ids: ObjectId[]) {
    const unique = [...new Map(ids.map((id) => [id.toHexString(), id])).values()];
    const users = unique.length ? await db().users.find({ _id: { $in: unique } }, { projection: STAFF_PROJECTION }).toArray() : [];
    return new Map(users.map((u) => [u._id.toHexString(), u]));
  }

  /** Where the thing a ticket is about stands now, so staff see it without opening it. */
  async function contextNow(doc: SupportTicketDoc) {
    const context = doc.context;
    if (!context) return null;
    const d = db();
    const id = ObjectId.isValid(context.id) && context.id.length === 24 ? new ObjectId(context.id) : null;
    let state: string | null = null;
    let kycCaseId: string | null = null;
    if (context.type === "verification") {
      const found = await d.kycCases.findOne({ userId: doc.requesterId, track: context.id as "base" | "delivery" }, { projection: { status: 1 } });
      state = found?.status ?? null;
      kycCaseId = found?._id.toHexString() ?? null;
    } else if (id && context.type === "business") {
      const business = await d.businesses.findOne({ _id: id }, { projection: { status: 1, suspension: 1 } });
      state = business ? (business.suspension ? "suspended" : business.status) : "deleted";
    } else if (id && context.type === "order") {
      state = (await d.podOrders.findOne({ _id: id }, { projection: { status: 1 } }))?.status ?? null;
    } else if (id && context.type === "post") {
      state = (await d.posts.findOne({ _id: id }, { projection: { status: 1 } }))?.status ?? null;
    } else if (id && context.type === "coupon") {
      const coupon = await d.coupons.findOne({ _id: id }, { projection: { active: 1, stoppedByRuxstar: 1 } });
      state = coupon ? (coupon.stoppedByRuxstar ? "stopped" : coupon.active ? "active" : "off") : null;
    } else if (id && context.type === "delivery") {
      state = (await d.deliveryJobs.findOne({ _id: id }, { projection: { status: 1 } }))?.status ?? null;
    }
    return { ...context, state, kycCaseId };
  }

  async function present(docs: SupportTicketDoc[]): Promise<StaffTicket[]> {
    const now = new Date();
    const people = await names(docs.flatMap((d) => [d.requesterId, ...(d.assigneeId ? [d.assigneeId] : [])]));
    return docs.map((doc) => {
      const requester = people.get(doc.requesterId.toHexString());
      const assignee = doc.assigneeId ? people.get(doc.assigneeId.toHexString()) : undefined;
      return {
        id: doc._id.toHexString(),
        number: ticketNumber(doc.ticketNo),
        category: doc.category,
        subject: doc.subject,
        status: statusOf(doc, now),
        context: doc.context ? { ...doc.context, state: null, kycCaseId: null } : null,
        createdAt: doc.createdAt.toISOString(),
        lastAt: doc.lastAt.toISOString(),
        resolvedAt: doc.resolvedAt?.toISOString() ?? null,
        reopenUntil: doc.reopenUntil?.toISOString() ?? null,
        priority: doc.priority,
        assignee: doc.assigneeId ? { id: doc.assigneeId.toHexString(), name: assignee?.name || "Former staff" } : null,
        requester: {
          id: doc.requesterId.toHexString(),
          name: requester?.name || "Deleted account",
          username: requester?.username ?? requester?.deletion?.username ?? "",
          status: requester?.status ?? "deleted",
        },
        slaDueAt: doc.slaDueAt?.toISOString() ?? null,
        overdue: doc.status === "open" && !!doc.slaDueAt && doc.slaDueAt < now,
        lastFrom: doc.lastFrom,
      };
    });
  }

  async function detail(doc: SupportTicketDoc, links: SupportPhotoLinks): Promise<StaffTicketDetail> {
    const messages = await db().supportMessages.find({ ticketId: doc._id }).sort({ at: 1 }).limit(500).toArray();
    const [[row], authors, context] = await Promise.all([present([doc]), names(messages.map((m) => m.authorId)), contextNow(doc)]);
    return {
      ...row!,
      context,
      messages: messages.map((m) => ({
        id: m._id.toHexString(),
        from: m.from,
        text: m.text,
        photos: photoViews(m, links),
        at: m.at.toISOString(),
        internal: m.internal,
        author: { id: m.authorId.toHexString(), name: authors.get(m.authorId.toHexString())?.name || (m.from === "staff" ? "Ruxstar" : "Deleted account") },
      })),
    };
  }

  const one = async (id: string) => {
    const doc = await db().supportTickets.findOne({ _id: new ObjectId(id) });
    if (!doc) throw new AppError("NOT_FOUND", "Ticket not found.");
    return doc;
  };

  /** Admins and active staff who may answer tickets. */
  async function agents() {
    const d = db();
    const [admins, grants] = await Promise.all([
      d.users.find({ "roles.admin": true, status: "active" }, { projection: { name: 1 } }).toArray(),
      d.ruxstarStaff.find({ status: "active", permissions: "support.manage" }, { projection: { userId: 1, title: 1 } }).toArray(),
    ]);
    const staff = await names(grants.map((g) => g.userId));
    return [
      ...admins.map((u) => ({ id: u._id.toHexString(), name: u.name || "Admin", title: "Admin" })),
      ...grants.flatMap((g) => {
        const user = staff.get(g.userId.toHexString());
        return user && user.status === "active" ? [{ id: g.userId.toHexString(), name: user.name || user.username || "Staff", title: g.title }] : [];
      }),
    ];
  }

  const audit = (request: FastifyRequest, doc: SupportTicketDoc, action: string, diff: Diff, session?: Parameters<typeof writeAudit>[2]) =>
    writeAudit(db(), { actor: actorOf(request), scope: { module: "support" }, action, target: { type: "support_ticket", id: doc._id }, diff, ip: request.ip }, session);

  /** What changes on a ticket when it moves to `status`. */
  function moveTo(doc: SupportTicketDoc, status: SupportTicketDoc["status"], hours: Awaited<ReturnType<typeof slaHours>>, now: Date) {
    if (status === "open") {
      const since = doc.awaitingSince ?? now;
      return { status, awaitingSince: since, slaDueAt: dueAt(since, doc.priority, hours), resolvedAt: null, reopenUntil: null };
    }
    if (status === "waiting") return { status, awaitingSince: null, slaDueAt: null, resolvedAt: null, reopenUntil: null };
    return { status, awaitingSince: null, slaDueAt: null, resolvedAt: now, reopenUntil: reopenUntil(now) };
  }

  const tellResolved = (request: FastifyRequest, doc: SupportTicketDoc) =>
    notifySupport(db(), app.log, {
      to: doc.requesterId,
      actor: request.auth!.userId,
      ticketId: doc._id,
      type: "support.resolved",
      title: `${ticketNumber(doc.ticketNo)} is resolved`,
      body: "Reply within 7 days if you still need help.",
    });

  app.get(
    "/support/tickets",
    {
      preHandler: requireRuxstar("support.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "Help tickets, latest activity first",
        description: "`status` defaults to open (waiting for Ruxstar). `assignee` is `me` or `none`; `q` finds a ticket by number.",
        querystring: QueueQuery,
        response: { 200: StaffTicketList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { status = "open", category, assignee, q, cursor, limit } = request.query;
      const number = q?.trim().match(/^(?:rx-?)?(\d{1,9})$/i);
      const filter: Filter<SupportTicketDoc> = number
        ? { ticketNo: Number(number[1]) }
        : {
            status,
            ...(category ? { category } : {}),
            ...(assignee === "me" ? { assigneeId: request.auth!.userId } : assignee === "none" ? { assigneeId: null } : {}),
          };
      const { items, nextCursor } = await findPage(db().supportTickets, { filter, sortField: "lastAt", cursor, limit });
      return page(request, await present(items), nextCursor);
    },
  );

  app.get(
    "/support/summary",
    {
      preHandler: requireRuxstar("support.view"),
      schema: { tags: ["ruxstar"], summary: "Counts for the help desk", response: { 200: SummaryResult, ...Errors }, security },
    },
    async (request) => {
      const d = db();
      const [open, waiting, overdue, unassigned, mine] = await Promise.all([
        d.supportTickets.countDocuments({ status: "open" }),
        d.supportTickets.countDocuments({ status: "waiting" }),
        d.supportTickets.countDocuments({ status: "open", slaDueAt: { $lt: new Date() } }),
        d.supportTickets.countDocuments({ status: "open", assigneeId: null }),
        d.supportTickets.countDocuments({ status: "open", assigneeId: request.auth!.userId }),
      ]);
      return ok(request, { open, waiting, overdue, unassigned, mine });
    },
  );

  app.get(
    "/support/agents",
    {
      preHandler: requireRuxstar("support.view"),
      schema: { tags: ["ruxstar"], summary: "People a ticket can be assigned to", response: { 200: Agents, ...Errors }, security },
    },
    async (request) => ok(request, await agents()),
  );

  app.get(
    "/support/tickets/:id",
    {
      preHandler: requireRuxstar("support.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "One ticket with every message and note",
        params: TicketParams,
        response: { 200: StaffTicketOne, ...Errors },
        security,
      },
    },
    async (request) => ok(request, await detail(await one(request.params.id), supportPhotoLinks(app, request))),
  );

  app.post(
    "/support/tickets/:id/messages",
    {
      preHandler: [requireRuxstar("support.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Answer a ticket, or add a note only staff see",
        description:
          "A reply tells the customer and moves the ticket to `status` (`waiting` on them unless you say otherwise). A note changes nothing unless `status` is sent. " +
          "Answering an unassigned ticket assigns it to you.",
        params: TicketParams,
        body: StaffReply,
        response: { 200: StaffTicketOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const doc = await one(request.params.id);
      const { internal = false } = request.body;
      const text = request.body.text.trim();
      if (!text) throw new AppError("VALIDATION_FAILED", "Write a message.", [{ path: "body/text", message: "Required" }]);
      const status = request.body.status ?? (internal ? undefined : "waiting");
      const now = new Date();
      const me = request.auth!.userId;
      const hours = await slaHours(database);
      const message: SupportMessageDoc = { _id: new ObjectId(), ticketId: doc._id, authorId: me, from: "staff", text, photos: [], internal, at: now };
      const set: Partial<SupportTicketDoc> = {
        ...(status ? moveTo(doc, status, hours, now) : {}),
        ...(internal ? {} : { lastAt: now, lastFrom: "staff" as const }),
        ...(!internal && !doc.assigneeId ? { assigneeId: me } : {}),
        updatedAt: now,
      };
      // A public reply answers whatever was waiting; reopening after it starts the clock again.
      if (!internal && status === "open") Object.assign(set, { awaitingSince: now, slaDueAt: dueAt(now, doc.priority, hours) });
      const updated = await database.transaction(async (session) => {
        await database.supportMessages.insertOne(message, { session });
        const after = await database.supportTickets.findOneAndUpdate({ _id: doc._id }, { $set: set }, { session, returnDocument: "after" });
        await audit(
          request,
          doc,
          internal ? "support.note" : "support.reply",
          { ...(status && status !== doc.status ? { status: { from: doc.status, to: status } } : {}), ...(set.assigneeId ? { assigneeId: { from: null, to: me } } : {}) },
          session,
        );
        return after!;
      });
      if (!internal) {
        if (status === "resolved") await tellResolved(request, updated);
        else {
          await notifySupport(database, app.log, {
            to: doc.requesterId,
            actor: me,
            ticketId: doc._id,
            type: "support.replied",
            title: `Ruxstar Support replied on ${ticketNumber(doc.ticketNo)}`,
            body: clip(text, 140),
          });
        }
      }
      return ok(request, await detail(updated, supportPhotoLinks(app, request)));
    },
  );

  app.patch(
    "/support/tickets/:id",
    {
      preHandler: [requireRuxstar("support.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Change a ticket's status, priority, topic or who is on it",
        description: "A new priority moves the reply-by time. Resolving tells the customer, who can reply to reopen it for 7 days.",
        params: TicketParams,
        body: TicketPatch,
        response: { 200: StaffTicketOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const doc = await one(request.params.id);
      const { status, priority, category, assigneeId } = request.body;
      const now = new Date();
      const hours = await slaHours(database);
      const diff: Diff = {};
      let set: Partial<SupportTicketDoc> = {};

      if (assigneeId !== undefined && (assigneeId ?? null) !== (doc.assigneeId?.toHexString() ?? null)) {
        if (assigneeId && !(await agents()).some((a) => a.id === assigneeId)) {
          throw new AppError("VALIDATION_FAILED", "They can't answer tickets.", [{ path: "body/assigneeId", message: "Not on the help desk" }]);
        }
        set.assigneeId = assigneeId ? new ObjectId(assigneeId) : null;
        diff.assigneeId = { from: doc.assigneeId, to: set.assigneeId };
      }
      if (category && category !== doc.category) {
        set.category = category;
        diff.category = { from: doc.category, to: category };
      }
      if (priority && priority !== doc.priority) {
        set.priority = priority;
        set.slaDueAt = dueAt(doc.awaitingSince, priority, hours);
        diff.priority = { from: doc.priority, to: priority };
      }
      const moving = status && status !== doc.status;
      if (moving) {
        set = { ...set, ...moveTo({ ...doc, ...set }, status, hours, now) };
        diff.status = { from: doc.status, to: status };
      }
      if (!Object.keys(diff).length) return ok(request, await detail(doc, supportPhotoLinks(app, request)));

      const updated = await database.transaction(async (session) => {
        const after = await database.supportTickets.findOneAndUpdate({ _id: doc._id }, { $set: { ...set, updatedAt: now } }, { session, returnDocument: "after" });
        await audit(request, doc, "support.update", diff, session);
        return after!;
      });
      if (moving && status === "resolved") await tellResolved(request, updated);
      return ok(request, await detail(updated, supportPhotoLinks(app, request)));
    },
  );

  app.get(
    "/support/settings",
    {
      preHandler: requireRuxstar("support.view"),
      schema: { tags: ["ruxstar"], summary: "Reply-by times by priority", response: { 200: SupportSettingsOne, ...Errors }, security },
    },
    async (request) => {
      const { updatedAt, ...hours } = await slaHours(db());
      return ok(request, { hours, updatedAt: updatedAt?.toISOString() ?? null });
    },
  );

  app.put(
    "/support/settings",
    {
      preHandler: [requireRuxstar("support.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Change the reply-by times",
        description: "Applies to tickets from their next customer message or priority change; deadlines already set stay.",
        body: SupportSettingsPut,
        response: { 200: SupportSettingsOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const { hours } = request.body;
      const { updatedAt: _, ...before } = await slaHours(database);
      const now = new Date();
      await database.transaction(async (session) => {
        await database.platformSettings.updateOne(
          { key: SLA_SETTING },
          { $set: { value: hours, updatedBy: request.auth!.userId, updatedAt: now }, $setOnInsert: { _id: new ObjectId(), key: SLA_SETTING, createdAt: now, schemaVersion: stamp(now).schemaVersion } },
          { upsert: true, session },
        );
        await writeAudit(
          database,
          { actor: actorOf(request), scope: { module: "support" }, action: "support.settings", target: { type: "platform_setting", id: SLA_SETTING }, diff: { hours: { from: before, to: hours } }, ip: request.ip },
          session,
        );
      });
      return ok(request, { hours, updatedAt: now.toISOString() });
    },
  );
};

export default supportDesk;
