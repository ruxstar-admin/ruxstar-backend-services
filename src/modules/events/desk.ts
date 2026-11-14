import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type Filter, type WithId } from "mongodb";
import type { Static } from "typebox";
import { Errors } from "../../contracts/common.js";
import { actorOf, writeAudit } from "../../platform/audit.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { Database, EventDoc, EventTicketDoc, TeamPermission } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { findPage } from "../../platform/pagination.js";
import { signingKey } from "../pod/orders.js";
import { teamAccess } from "../team/team.js";
import {
  DeskEventList,
  DeskEventOne,
  EventParams,
  GuestList,
  GuestsQuery,
  LookupList,
  LookupQuery,
  OfflineList,
  ScanBody,
  ScanResultOne,
  SyncBody,
  SyncResult,
  TicketParams,
  ScanResult,
} from "./contracts.js";

type ScanResult = Static<typeof ScanResult>;
import { dayOf, daysOf, lastFour, readQr, sha256 } from "./rules.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const time = (at: Date) => at.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
const date = (day: string) =>
  new Date(`${day}T12:00:00+05:30`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" });

interface Desk {
  event: WithId<EventDoc>;
  role: "owner" | "team";
  canSeeGuests: boolean;
}

export async function deskCounts(db: Database, eventId: ObjectId, day = dayOf(new Date())) {
  const [tickets, inToday] = await Promise.all([
    db.eventTickets.countDocuments({ eventId, status: "valid" }),
    db.eventTickets.countDocuments({ eventId, status: "valid", "checkIns.day": day }),
  ]);
  return { tickets, inToday };
}

const scanTicket = (t: EventTicketDoc) => ({ id: t._id.toHexString(), name: t.holder.name, tier: t.tierName, team: t.team, code: t.code });

/**
 * One check-in a day. Coming back the same day is amber and allowed; another event's ticket, a day the event isn't on,
 * or a cancelled ticket is red.
 */
export async function checkIn(
  db: Database,
  event: WithId<EventDoc>,
  ticket: EventTicketDoc | null,
  by: ObjectId,
  { manual, at = new Date() }: { manual: boolean; at?: Date },
): Promise<Omit<ScanResult, "counts">> {
  if (!ticket) return { result: "unknown", ticket: null, firstAt: null, message: "Not a Ruxstar ticket." };
  if (!ticket.eventId.equals(event._id)) {
    const other = await db.events.findOne({ _id: ticket.eventId }, { projection: { title: 1 } });
    return { result: "wrong_event", ticket: scanTicket(ticket), firstAt: null, message: `This ticket is for ${other?.title ?? "another event"}.` };
  }
  if (ticket.status !== "valid") {
    const message = ticket.status === "cancelled" ? "This ticket was cancelled." : "This ticket isn't paid for.";
    return { result: "cancelled", ticket: scanTicket(ticket), firstAt: null, message };
  }
  const day = dayOf(at);
  const days = daysOf(event);
  if (!days.includes(day)) {
    const on = days.length === 1 ? date(days[0]!) : `${date(days[0]!)} to ${date(days.at(-1)!)}`;
    return { result: "wrong_day", ticket: scanTicket(ticket), firstAt: null, message: `Not today. This event is on ${on}.` };
  }
  const inside = (first: EventTicketDoc["checkIns"][number]) => ({
    result: "inside" as const,
    ticket: scanTicket(ticket),
    firstAt: first.at.toISOString(),
    message: `Already inside since ${time(first.at)}.`,
  });
  const earlier = ticket.checkIns.find((c) => c.day === day);
  if (earlier) return inside(earlier);
  const res = await db.eventTickets.updateOne(
    { _id: ticket._id, status: "valid", "checkIns.day": { $ne: day } },
    { $push: { checkIns: { day, at, by, manual, offline: false } }, $set: { updatedAt: new Date() } },
  );
  if (!res.modifiedCount) {
    const now = await db.eventTickets.findOne({ _id: ticket._id });
    const first = now?.checkIns.find((c) => c.day === day);
    if (first) return inside(first);
    return { result: "cancelled", ticket: scanTicket(ticket), firstAt: null, message: "This ticket was cancelled." };
  }
  return { result: "ok", ticket: scanTicket(ticket), firstAt: null, message: `Welcome, ${ticket.holder.name}.` };
}

/** The gate: the owner, and people on the team allowed to scan, check tickets in, online or offline. */
const desk: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const key = signingKey(app);

  async function access(request: FastifyRequest, id: string, permission: TeamPermission): Promise<Desk> {
    const event = await db().events.findOne({ _id: new ObjectId(id) });
    if (!event || event.status === "draft") throw new AppError("NOT_FOUND", "Event not found.");
    if (event.online) throw new AppError("CONFLICT", "Online events have no tickets to scan.");
    const business = await db().businesses.findOne({ _id: event.businessId }, { projection: { ownerId: 1, suspension: 1 } });
    if (!business) throw new AppError("NOT_FOUND", "Event not found.");
    if (business.ownerId.equals(request.auth!.userId)) {
      if (business.suspension) throw new AppError("BUSINESS_SUSPENDED");
      return { event, role: "owner", canSeeGuests: true };
    }
    const { place } = await teamAccess(db(), request.auth!, { businessId: event.businessId }, permission);
    return { event, role: "team", canSeeGuests: place.permissions.includes("tickets.guests") && request.auth!.kyc.base === "approved" };
  }

  const deskView = async ({ event, role, canSeeGuests }: Desk) => {
    const days = daysOf(event);
    return {
      id: event._id.toHexString(),
      title: event.title,
      business: { id: event.businessId.toHexString(), name: event.businessName },
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      venueName: event.venue?.name ?? null,
      photo: event.photo ? { url: event.photo.url, width: event.photo.width, height: event.photo.height } : null,
      today: days.includes(dayOf(new Date())) && event.status === "live",
      days,
      counts: await deskCounts(db(), event._id),
      canSeeGuests,
      role,
    };
  };

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["events"],
        summary: "Events you can check people in at, soonest first",
        description: "Your own events, and those of businesses where you're on the team with “Scan tickets”. Online events have nothing to scan.",
        response: { 200: DeskEventList, ...Errors },
        security,
      },
    },
    async (request) => {
      const userId = request.auth!.userId;
      const [owned, places] = await Promise.all([
        db().businesses.find({ ownerId: userId, module: "events", suspension: { $exists: false } }, { projection: { _id: 1 } }).toArray(),
        db().employments.find({ userId, status: "active", current: true, permissions: "tickets.scan" }, { projection: { businessId: 1, permissions: 1 } }).toArray(),
      ]);
      const ownedIds = owned.map((b) => b._id);
      const teamIds = places.map((p) => p.businessId);
      const held = await db().businesses.find({ _id: { $in: teamIds }, suspension: { $exists: true } }, { projection: { _id: 1 } }).toArray();
      const ids = [...ownedIds, ...teamIds.filter((id) => !held.some((h) => h._id.equals(id)))];
      const events = await db()
        .events.find({ businessId: { $in: ids }, status: "live", online: null, endsAt: { $gt: new Date() } })
        .sort({ startsAt: 1 })
        .limit(30)
        .toArray();
      const verified = request.auth!.kyc.base === "approved";
      const views = await Promise.all(
        events.map((event) => {
          const mine = ownedIds.some((id) => id.equals(event.businessId));
          const place = places.find((p) => p.businessId.equals(event.businessId));
          return deskView({ event, role: mine ? "owner" : "team", canSeeGuests: mine || (verified && !!place?.permissions.includes("tickets.guests")) });
        }),
      );
      return page(request, views, null);
    },
  );

  app.get(
    "/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["events"],
        summary: "One event at the gate, with today's count",
        description: "Poll it every 10 seconds or so for the live count; it's two counts on indexes.",
        params: EventParams,
        response: { 200: DeskEventOne, ...Errors },
        security,
      },
    },
    async (request) => ok(request, await deskView(await access(request, request.params.id, "tickets.scan"))),
  );

  app.post(
    "/:id/scan",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 600, timeWindow: 60_000 } },
      schema: {
        tags: ["events"],
        summary: "Check in the ticket the camera read",
        params: EventParams,
        body: ScanBody,
        response: { 200: ScanResultOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { event } = await access(request, request.params.id, "tickets.scan");
      const ticketId = readQr(key, request.body.qr);
      const ticket = ticketId ? await db().eventTickets.findOne({ _id: ticketId }) : null;
      const result = await checkIn(db(), event, ticket, request.auth!.userId, { manual: false });
      return ok(request, { ...result, counts: await deskCounts(db(), event._id) });
    },
  );

  app.get(
    "/:id/lookup",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
      schema: {
        tags: ["events"],
        summary: "Find tickets by their six letters or the holder's phone number",
        description: "For a phone that won't scan. Checking someone in from here is recorded as by hand.",
        params: EventParams,
        querystring: LookupQuery,
        response: { 200: LookupList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { event } = await access(request, request.params.id, "tickets.scan");
      const q = request.query.q.trim().toUpperCase().replace(/\s+/g, "");
      const phone = q.replace(/^\+?91/, "");
      const filter: Filter<EventTicketDoc> = /^[6-9]\d{9}$/.test(phone) ? { eventId: event._id, "holder.phone": phone } : { eventId: event._id, code: q };
      const tickets = await db().eventTickets.find(filter).limit(20).toArray();
      const day = dayOf(new Date());
      return page(
        request,
        tickets.map((t) => ({
          ...scanTicket(t),
          phone: lastFour(t.holder.phone),
          status: t.status,
          inToday: t.checkIns.find((c) => c.day === day)?.at.toISOString() ?? null,
        })),
        null,
      );
    },
  );

  app.post(
    "/:id/tickets/:ticketId/check-in",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["events"],
        summary: "Check a ticket in by hand",
        description: "Recorded with who did it, for the organiser.",
        params: TicketParams,
        response: { 200: ScanResultOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { event } = await access(request, request.params.id, "tickets.scan");
      const ticket = await db().eventTickets.findOne({ _id: new ObjectId(request.params.ticketId), eventId: event._id });
      const result = await checkIn(db(), event, ticket, request.auth!.userId, { manual: true });
      if (result.result === "ok") {
        await writeAudit(db(), {
          actor: actorOf(request),
          scope: { module: "events", businessId: event.businessId },
          action: "event_ticket.check_in",
          target: { type: "event_ticket", id: ticket!._id },
          diff: { manual: { from: null, to: true } },
          ip: request.ip,
        });
      }
      return ok(request, { ...result, counts: await deskCounts(db(), event._id) });
    },
  );

  app.get(
    "/:id/offline",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
      schema: {
        tags: ["events"],
        summary: "Every ticket for checking in without a connection",
        description:
          "About 200 bytes a ticket. Each QR code is matched by its SHA-256, so the codes themselves never leave Ruxstar. " +
          "Send what was scanned to /sync once back online.",
        params: EventParams,
        response: { 200: OfflineList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { event } = await access(request, request.params.id, "tickets.scan");
      const day = dayOf(new Date());
      const tickets = await db()
        .eventTickets.find(
          { eventId: event._id, status: { $in: ["valid", "cancelled"] } },
          { projection: { hash: 1, code: 1, "holder.name": 1, "holder.phone": 1, tierName: 1, status: 1, checkIns: 1 } },
        )
        .limit(50_000)
        .toArray();
      return ok(request, {
        eventId: event._id.toHexString(),
        day,
        at: new Date().toISOString(),
        tickets: tickets.map((t) => ({
          h: t.hash,
          id: t._id.toHexString(),
          c: t.code,
          n: t.holder.name,
          t: t.tierName,
          p: t.holder.phone ? sha256(t.holder.phone) : "",
          s: t.status === "valid" ? ("v" as const) : ("x" as const),
          i: t.checkIns.find((c) => c.day === day)?.at.toISOString() ?? null,
        })),
      });
    },
  );

  app.post(
    "/:id/sync",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: 60_000 } },
      schema: {
        tags: ["events"],
        summary: "Send check-ins made offline",
        description:
          "Up to 500 at once, in the order they happened. A ticket let in as new on two phones comes back as a clash and is flagged for the organiser.",
        params: EventParams,
        body: SyncBody,
        response: { 200: SyncResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const { event } = await access(request, request.params.id, "tickets.scan");
      const userId = request.auth!.userId;
      const scans = [...request.body.scans].sort((a, b) => a.at.localeCompare(b.at));
      const tickets = await db()
        .eventTickets.find({ eventId: event._id, _id: { $in: scans.map((s) => new ObjectId(s.ticketId)) } })
        .toArray();
      const days = daysOf(event);
      const now = Date.now();
      let saved = 0;
      const clashes: Static<typeof SyncResult>["data"]["clashes"] = [];
      for (const scan of scans) {
        const ticket = tickets.find((t) => t._id.toHexString() === scan.ticketId);
        const at = new Date(Math.min(new Date(scan.at).getTime(), now));
        const day = dayOf(at);
        if (!ticket || ticket.status !== "valid" || !days.includes(day)) continue;
        const res = await db().eventTickets.updateOne(
          { _id: ticket._id, "checkIns.day": { $ne: day } },
          { $push: { checkIns: { day, at, by: userId, manual: scan.manual, offline: true } }, $set: { updatedAt: new Date() } },
        );
        if (res.modifiedCount) {
          saved++;
          ticket.checkIns.push({ day, at, by: userId, manual: scan.manual, offline: true });
          continue;
        }
        const first = (await db().eventTickets.findOne({ _id: ticket._id }, { projection: { checkIns: 1 } }))?.checkIns.find((c) => c.day === day);
        if (scan.fresh && first && !(first.by.equals(userId) && Math.abs(first.at.getTime() - at.getTime()) < 60_000)) {
          await db().eventTickets.updateOne({ _id: ticket._id }, { $push: { clashes: { day, at, by: userId } } });
          clashes.push({ ticketId: scan.ticketId, name: ticket.holder.name, code: ticket.code, firstAt: first.at.toISOString() });
        }
      }
      return ok(request, { saved, clashes, counts: await deskCounts(db(), event._id) });
    },
  );

  app.get(
    "/:id/guests",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["events"],
        summary: "The guest list: everyone, who's arrived today, or who hasn't",
        description: "For the owner, and people on the team with “See the guest list”.",
        params: EventParams,
        querystring: GuestsQuery,
        response: { 200: GuestList, ...Errors },
        security,
      },
    },
    async (request) => {
      const desk = await access(request, request.params.id, "tickets.guests");
      if (!desk.canSeeGuests) throw new AppError("KYC_REQUIRED", "Get verified to see the guest list.");
      const day = dayOf(new Date());
      const view = request.query.view ?? "all";
      const filter: Filter<EventTicketDoc> = { eventId: desk.event._id, status: "valid" };
      if (view === "arrived") filter["checkIns.day"] = day;
      if (view === "not_arrived") filter["checkIns.day"] = { $ne: day };
      const { items, nextCursor } = await findPage(db().eventTickets, { filter, sortField: "createdAt", cursor: request.query.cursor, limit: request.query.limit });
      const byIds = [...new Set(items.flatMap((t) => t.checkIns.filter((c) => c.day === day).map((c) => c.by.toHexString())))];
      const people = await db()
        .users.find({ _id: { $in: byIds.map((id) => new ObjectId(id)) } }, { projection: { name: 1, username: 1 } })
        .toArray();
      return page(
        request,
        items.map((t) => {
          const today = t.checkIns.find((c) => c.day === day);
          const who = today ? people.find((p) => p._id.equals(today.by)) : null;
          return {
            ...scanTicket(t),
            phone: t.holder.phone,
            inToday: today?.at.toISOString() ?? null,
            by: who ? (who.name ?? (who.username ? `@${who.username}` : null)) : null,
            manual: Boolean(today?.manual),
            clash: t.clashes.some((c) => c.day === day),
          };
        }),
        nextCursor,
      );
    },
  );
};

export default desk;
