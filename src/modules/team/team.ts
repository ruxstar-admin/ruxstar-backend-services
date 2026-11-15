import type { FastifyBaseLogger } from "fastify";
import { ObjectId, type WithId } from "mongodb";
import type { AuthContext } from "../../platform/context.js";
import { writeAudit } from "../../platform/audit.js";
import { stamp, type AuditLogDoc, type BusinessDoc, type Database, type EmploymentDoc, type TeamPermission, type UserDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { notifyTeam } from "../notifications/notify.js";
import { blockBetween } from "../social/relations.js";
import { INVITE_DAYS, MAX_TEAM, type Pay, type TeamMember, type WorkPlace } from "./contracts.js";

const DAY_MS = 24 * 60 * 60_000;

type PermissionInfo = { key: TeamPermission; label: string; hint: string | null; needs: TeamPermission | null; verify: boolean };

/** What doesn't need the person verified: a gate keeper only checks tickets, so anyone the owner invites can do it. */
export const NO_KYC: readonly TeamPermission[] = ["tickets.scan"];
const info = (p: { key: string; label: string; hint: string | null; needs: string | null }): PermissionInfo =>
  ({ ...p, verify: !NO_KYC.includes(p.key as TeamPermission) }) as PermissionInfo;

/** What an owner can give, by kind of business. Modules not listed have no team yet. */
const CATALOGS: Partial<Record<BusinessDoc["module"], PermissionInfo[]>> = {
  pod: [
    { key: "orders.view", label: "See orders", hint: "New and past orders, and the files to print", needs: null },
    { key: "orders.move", label: "Accept and move orders", hint: "Accept, printing, ready, out for delivery and delivered", needs: "orders.view" },
    { key: "orders.reject", label: "Turn down orders", hint: "Before accepting; the customer gets a full refund", needs: "orders.view" },
    { key: "orders.refund", label: "Refund part of an order", hint: "It comes out of the shop's share", needs: "orders.view" },
    {
      key: "orders.deliver",
      label: "Deliver orders",
      hint: "The shop can send them orders to take in the Ruxstar Delivery app. Needs delivery verification",
      needs: "orders.view",
    },
    { key: "earnings.view", label: "See the shop's earnings", hint: "The shop's share and Ruxstar's commission on each order", needs: "orders.view" },
    { key: "shop.open", label: "Open and close the shop", hint: null, needs: null },
    { key: "shop.catalog", label: "Change products, prices and delivery area", hint: null, needs: null },
    { key: "shop.details", label: "Edit details and photos", hint: "Name, phone, address, description and photos", needs: null },
    { key: "coupons.manage", label: "Make and change coupons", hint: "For this shop. The discount comes out of the shop's share", needs: null },
    { key: "posts.create", label: "Post as the business", hint: null, needs: null },
    { key: "reviews.reply", label: "Reply to reviews", hint: "Answer customers' reviews for the shop", needs: null },
  ].map(info),
  events: [
    {
      key: "tickets.scan",
      label: "Scan tickets at the gate",
      hint: "Check people in with the phone camera, at every event of this business. No verification needed",
      needs: null,
    },
    {
      key: "tickets.guests",
      label: "See the guest list",
      hint: "Who bought tickets, their phone numbers and answers, and who hasn't arrived yet",
      needs: "tickets.scan",
    },
    { key: "reviews.reply", label: "Reply to reviews", hint: "Answer customers' reviews of the business", needs: null },
  ].map(info),
  coaching: [
    { key: "classes.view", label: "See their batches and students", hint: "Only the batches you assign them to, with the class list", needs: null },
    { key: "classes.attendance", label: "Mark attendance", hint: "Tick who came to each class", needs: "classes.view" },
    { key: "classes.message", label: "Message students and parents", hint: "Send a message to everyone in their batches", needs: "classes.view" },
    { key: "classes.materials", label: "Upload materials", hint: "Notes, worksheets and links for their batches", needs: "classes.view" },
    {
      key: "classes.reschedule",
      label: "Cancel or move a class",
      hint: "Everyone in the batch is told. Nothing is refunded. They can also add an extra class",
      needs: "classes.view",
    },
    { key: "reviews.reply", label: "Reply to reviews", hint: "Answer customers' reviews of the business", needs: null },
  ].map(info),
  turf: [
    { key: "turf.bookings", label: "See bookings", hint: "The board of every ground, and who booked, with their phone numbers", needs: null },
    { key: "turf.block", label: "Block and unblock slots", hint: "For maintenance or bookings taken by phone", needs: "turf.bookings" },
    { key: "turf.cancel", label: "Cancel bookings", hint: "The customer gets a full refund, platform fee included", needs: "turf.bookings" },
    { key: "turf.arrivals", label: "Mark arrived or no-show", hint: null, needs: "turf.bookings" },
    { key: "turf.prices", label: "Change prices and add-ons", hint: "Base, weekend and peak prices of every court", needs: null },
    { key: "reviews.reply", label: "Reply to reviews", hint: "Answer customers' reviews of the business", needs: null },
  ].map(info),
};

/** Every permission once, for labelling places at any kind of business. */
export const PERMISSIONS: PermissionInfo[] = Object.values(CATALOGS)
  .flat()
  .filter((p, i, all) => all.findIndex((q) => q.key === p.key) === i);

export const permissionsFor = (module: BusinessDoc["module"]): PermissionInfo[] => CATALOGS[module] ?? [];

/** Only what this kind of business offers, in its order, with whatever each one needs added. */
export function withNeeds(permissions: TeamPermission[], module: BusinessDoc["module"]): TeamPermission[] {
  const catalog = permissionsFor(module);
  const unknown = permissions.findIndex((p) => !catalog.some((c) => c.key === p));
  if (unknown >= 0) {
    throw new AppError("VALIDATION_FAILED", "This kind of business doesn't offer that permission.", [
      { path: `body/permissions/${unknown}`, message: "Not offered here" },
    ]);
  }
  const set = new Set(permissions);
  for (const p of catalog) if (set.has(p.key) && p.needs) set.add(p.needs);
  return catalog.filter((p) => set.has(p.key)).map((p) => p.key);
}

/** Everything in the place works without verification. */
export const kycFree = (permissions: TeamPermission[]) => permissions.every((p) => NO_KYC.includes(p));

const cleanPay = (pay: Pay | null | undefined): Pay | null => (pay ? { amount: pay.amount, per: pay.per, note: pay.note?.trim() || null } : null);
const payOf = (d: Pick<EmploymentDoc, "pay">): Pay | null => d.pay ?? null;
const samePay = (a: Pay | null, b: Pay | null) => JSON.stringify(a) === JSON.stringify(b);

const nameOf = (user: Pick<UserDoc, "name" | "username"> | null | undefined) => user?.name || (user?.username ? `@${user.username}` : "Someone");
const verified = (user: Pick<UserDoc, "kyc"> | null | undefined) => user?.kyc?.base === "approved";

/** Invited and not run out, or active. */
export const openFilter = (now: Date) => ({ current: true as const, $or: [{ status: "active" as const }, { expiresAt: { $gt: now } }] });

/** Invites that ran out stop holding a place, so the person can be invited again. */
async function expireInvites(db: Database, filter: { businessId?: ObjectId; userId?: ObjectId }, now: Date) {
  await db.employments.updateMany(
    { ...filter, current: true, status: "invited", expiresAt: { $lte: now } },
    { $set: { status: "expired", endedAt: now, updatedAt: now }, $unset: { current: "" } },
  );
}

export async function teamOf(db: Database, businessId: ObjectId): Promise<TeamMember[]> {
  const now = new Date();
  const docs = await db.employments.find({ businessId, ...openFilter(now) }).sort({ invitedAt: 1 }).toArray();
  const users = await db.users
    .find({ _id: { $in: docs.map((d) => d.userId) } }, { projection: { name: 1, username: 1, avatar: 1, kyc: 1 } })
    .toArray();
  const byId = new Map(users.map((u) => [u._id.toHexString(), u]));
  const members = docs.map((d): TeamMember => {
    const user = byId.get(d.userId.toHexString());
    return {
      id: d._id.toHexString(),
      person: { id: d.userId.toHexString(), name: nameOf(user), username: user?.username ?? null, avatar: user?.avatar ?? null },
      status: d.status === "invited" ? "invited" : verified(user) || kycFree(d.permissions) ? "active" : "waiting",
      permissions: d.permissions,
      pay: payOf(d),
      invitedAt: d.invitedAt.toISOString(),
      expiresAt: d.status === "invited" ? d.expiresAt.toISOString() : null,
      joinedAt: d.joinedAt?.toISOString() ?? null,
    };
  });
  return [...members.filter((m) => m.status !== "invited"), ...members.filter((m) => m.status === "invited")];
}

export const teamView = async (db: Database, business: Pick<BusinessDoc, "module"> & { _id: ObjectId }) => ({
  members: await teamOf(db, business._id),
  permissions: permissionsFor(business.module),
  max: MAX_TEAM,
});

const audit = (
  db: Database,
  employment: Pick<EmploymentDoc, "_id" | "module" | "businessId">,
  action: string,
  actor: AuditLogDoc["actor"],
  ip: string | null,
  diff: AuditLogDoc["diff"] = {},
) => writeAudit(db, { actor, scope: { module: employment.module, businessId: employment.businessId }, action, target: { type: "employment", id: employment._id }, diff, ip });

export function assertTeamBusiness(business: BusinessDoc) {
  if (business.suspension) throw new AppError("BUSINESS_SUSPENDED");
  if (!permissionsFor(business.module).length) throw new AppError("CONFLICT", "Teams come to this kind of business soon.");
}

interface Ctx {
  actor: AuditLogDoc["actor"];
  ip: string | null;
  log: FastifyBaseLogger;
}

export async function invite(
  db: Database,
  business: WithId<BusinessDoc>,
  input: { username: string; permissions: TeamPermission[]; pay?: Pay | null },
  ctx: Ctx & { by: ObjectId },
) {
  assertTeamBusiness(business);
  const username = input.username.trim().replace(/^@/, "").toLowerCase();
  const user = await db.users.findOne({ username, status: "active" }, { projection: { name: 1, username: 1 } });
  const field = (message: string) => [{ path: "body/username", message }];
  if (!user) throw new AppError("NOT_FOUND", "There's no one with this username.", field("Not found"));
  if (user._id.equals(business.ownerId)) throw new AppError("CONFLICT", "You own this business, so you can do everything already.", field("Owner"));
  if (await blockBetween(db, business.ownerId, user._id)) throw new AppError("FORBIDDEN", "You can't invite this person.", field("Blocked"));

  const now = new Date();
  await expireInvites(db, { businessId: business._id }, now);
  const existing = await db.employments.findOne({ businessId: business._id, userId: user._id, current: true });
  if (existing) {
    const who = nameOf(user);
    throw new AppError("CONFLICT", existing.status === "active" ? `${who} is already on the team.` : `${who} already has an invite.`, field("Already"));
  }
  if ((await db.employments.countDocuments({ businessId: business._id, ...openFilter(now) })) >= MAX_TEAM) {
    throw new AppError("CONFLICT", `A team holds up to ${MAX_TEAM} people, invites included. Remove someone first.`);
  }

  const doc: EmploymentDoc = {
    _id: new ObjectId(),
    businessId: business._id,
    module: business.module,
    ownerId: business.ownerId,
    userId: user._id,
    status: "invited",
    current: true,
    permissions: withNeeds(input.permissions, business.module),
    pay: cleanPay(input.pay),
    invitedBy: ctx.by,
    invitedAt: now,
    expiresAt: new Date(now.getTime() + INVITE_DAYS * DAY_MS),
    joinedAt: null,
    endedAt: null,
    endedBy: null,
    ...stamp(now),
  };
  try {
    await db.employments.insertOne(doc);
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw new AppError("CONFLICT", `${nameOf(user)} already has an invite.`, field("Already"));
    throw err;
  }
  await audit(db, doc, "team.invite", ctx.actor, ctx.ip, {
    person: { from: null, to: user._id },
    permissions: { from: [], to: doc.permissions },
    ...(doc.pay ? { pay: { from: null, to: doc.pay } } : {}),
  });
  const owner = await db.users.findOne({ _id: business.ownerId }, { projection: { name: 1, username: 1 } });
  await notifyTeam(db, ctx.log, {
    to: user._id,
    actor: ctx.by,
    type: "team.invited",
    title: "Team invite",
    body: `${nameOf(owner)} invited you to work at ${business.name}.`,
    link: { screen: "work", id: doc._id.toHexString() },
  });
  return doc;
}

/** An open place on the business's team: active, or invited and not run out. */
export async function memberOf(db: Database, businessId: ObjectId, memberId: string) {
  const doc = await db.employments.findOne({ _id: new ObjectId(memberId), businessId, ...openFilter(new Date()) });
  if (!doc) throw new AppError("NOT_FOUND", "This person isn't on the team.");
  return doc;
}

/** What a member may do, and while they're invited, the pay on offer. */
export async function updateMember(db: Database, member: WithId<EmploymentDoc>, input: { permissions?: TeamPermission[]; pay?: Pay | null }, ctx: Ctx) {
  const permissions = input.permissions ? withNeeds(input.permissions, member.module) : member.permissions;
  const pay = input.pay === undefined ? payOf(member) : cleanPay(input.pay);
  const payChanged = !samePay(pay, payOf(member));
  if (payChanged && member.status !== "invited") {
    throw new AppError("CONFLICT", "Pay is part of the offer, so it can't change once they accept.", [{ path: "body/pay", message: "Accepted" }]);
  }
  const permissionsChanged = permissions.join() !== member.permissions.join();
  if (!permissionsChanged && !payChanged) return member;
  const now = new Date();
  const done = await db.employments.findOneAndUpdate(
    { _id: member._id, current: true, updatedAt: member.updatedAt },
    { $set: { permissions, pay, updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!done) throw new AppError("CONFLICT");
  await audit(db, member, "team.update", ctx.actor, ctx.ip, {
    ...(permissionsChanged ? { permissions: { from: member.permissions, to: permissions } } : {}),
    ...(payChanged ? { pay: { from: payOf(member), to: pay } } : {}),
  });
  return done;
}

/**
 * Ends a place: the owner removing someone or cancelling an invite, the person leaving, or the Ruxstar team removing them.
 * The person is told unless they left themselves, and the owner is told unless they did it.
 */
export async function endPlace(
  db: Database,
  member: WithId<EmploymentDoc>,
  ctx: Ctx & { by: EmploymentDoc["endedBy"] & string; actorId: ObjectId; reason?: string },
) {
  const now = new Date();
  const status = ctx.by === "member" ? "left" : "removed";
  const res = await db.employments.updateOne(
    { _id: member._id, current: true },
    { $set: { status, endedAt: now, endedBy: ctx.by, updatedAt: now }, $unset: { current: "" } },
  );
  if (res.modifiedCount === 0) throw new AppError("NOT_FOUND", "This person isn't on the team.");
  const action = ctx.by === "member" ? "team.leave" : "team.remove";
  await audit(db, member, action, ctx.actor, ctx.ip, { status: { from: member.status, to: status }, ...(ctx.reason ? { reason: { from: null, to: ctx.reason } } : {}) });

  const [business, person] = await Promise.all([
    db.businesses.findOne({ _id: member.businessId }, { projection: { name: 1 } }),
    db.users.findOne({ _id: member.userId }, { projection: { name: 1, username: 1 } }),
  ]);
  const shop = business?.name ?? "the business";
  if (ctx.by !== "member" && member.status === "active") {
    await notifyTeam(db, ctx.log, {
      to: member.userId,
      actor: ctx.actorId,
      type: "team.ended",
      title: "Removed from a team",
      body: ctx.by === "ruxstar" ? `The Ruxstar team removed you from ${shop}: ${ctx.reason ?? ""}` : `You're no longer on ${shop}'s team.`,
      link: { screen: "work", id: member._id.toHexString() },
    });
  }
  if (ctx.by !== "owner" && member.status === "active") {
    await notifyTeam(db, ctx.log, {
      to: member.ownerId,
      actor: ctx.actorId,
      type: "team.ended",
      title: ctx.by === "member" ? "Someone left your team" : "Ruxstar removed someone",
      body: ctx.by === "member" ? `${nameOf(person)} left ${shop}'s team.` : `${nameOf(person)} was removed from ${shop}: ${ctx.reason ?? ""}`,
      link: { screen: "team", id: member.businessId.toHexString() },
    });
  }
}

/** Your own invite or place, whatever its state. */
export async function ownPlace(db: Database, userId: ObjectId, id: string) {
  const doc = await db.employments.findOne({ _id: new ObjectId(id), userId });
  if (!doc) throw new AppError("NOT_FOUND", "Invite not found.");
  return doc;
}

export async function answerInvite(db: Database, invite: WithId<EmploymentDoc>, accept: boolean, ctx: Ctx & { userId: ObjectId }) {
  const now = new Date();
  const ranOut = () => new AppError("CONFLICT", "This invite ran out. Ask the owner to invite you again.");
  if (invite.status === "expired") throw ranOut();
  if (invite.status !== "invited" || !invite.current) throw new AppError("CONFLICT", "This invite isn't open any more.");
  if (invite.expiresAt <= now) {
    await expireInvites(db, { userId: invite.userId }, now);
    throw ranOut();
  }
  const business = await db.businesses.findOne({ _id: invite.businessId });
  if (accept && (!business || business.suspension)) throw new AppError("CONFLICT", "This business can't take new team members right now.");
  const done = await db.employments.findOneAndUpdate(
    { _id: invite._id, status: "invited", current: true },
    accept
      ? { $set: { status: "active", joinedAt: now, updatedAt: now } }
      : { $set: { status: "declined", endedAt: now, endedBy: "member", updatedAt: now }, $unset: { current: "" } },
    { returnDocument: "after" },
  );
  if (!done) throw new AppError("CONFLICT", "This invite isn't open any more.");
  await audit(db, invite, accept ? "team.join" : "team.decline", ctx.actor, ctx.ip, { status: { from: "invited", to: done.status } });
  if (accept) {
    const person = await db.users.findOne({ _id: ctx.userId }, { projection: { name: 1, username: 1 } });
    await notifyTeam(db, ctx.log, {
      to: invite.ownerId,
      actor: ctx.userId,
      type: "team.joined",
      title: "New team member",
      body: `${nameOf(person)} joined ${business?.name ?? "your business"}'s team.`,
      link: { screen: "team", id: invite.businessId.toHexString() },
    });
  }
  return done;
}

type Workplace = { business: WithId<BusinessDoc> | undefined; owner: Pick<UserDoc, "name" | "username"> | undefined };

const workBusiness = (b: WithId<BusinessDoc>) => ({
  id: b._id.toHexString(),
  name: b.name,
  module: b.module,
  type: b.type,
  city: b.location?.city ?? null,
  photo: b.photos[0]?.url ?? null,
  status: b.status,
  open: b.open,
});

/** Someone's invites and the businesses they work at. */
export async function workOf(db: Database, auth: Pick<AuthContext, "userId" | "kyc">) {
  const now = new Date();
  await expireInvites(db, { userId: auth.userId }, now);
  const docs = await db.employments.find({ userId: auth.userId, current: true }).sort({ invitedAt: -1 }).toArray();
  const businesses = await db.businesses.find({ _id: { $in: docs.map((d) => d.businessId) } }).toArray();
  const owners = await db.users.find({ _id: { $in: docs.map((d) => d.ownerId) } }, { projection: { name: 1, username: 1 } }).toArray();
  const of = (d: EmploymentDoc): Workplace => ({
    business: businesses.find((b) => b._id.equals(d.businessId)),
    owner: owners.find((o) => o._id.equals(d.ownerId)),
  });
  const isVerified = auth.kyc.base === "approved";
  const invites = docs.flatMap((d) => {
    const { business, owner } = of(d);
    if (d.status !== "invited" || !business) return [];
    return [
      {
        id: d._id.toHexString(),
        business: workBusiness(business),
        owner: { name: nameOf(owner) },
        permissions: d.permissions,
        pay: payOf(d),
        invitedAt: d.invitedAt.toISOString(),
        expiresAt: d.expiresAt.toISOString(),
      },
    ];
  });
  const places = docs.flatMap((d) => {
    const { business, owner } = of(d);
    if (d.status !== "active" || !business) return [];
    return [placeView(d, business, owner, isVerified)];
  });
  return { invites, places, permissions: PERMISSIONS };
}

export function placeView(d: EmploymentDoc, business: WithId<BusinessDoc>, owner: Pick<UserDoc, "name" | "username"> | null | undefined, isVerified: boolean): WorkPlace {
  return {
    id: d._id.toHexString(),
    business: workBusiness(business),
    owner: { name: nameOf(owner) },
    permissions: d.permissions,
    pay: payOf(d),
    joinedAt: (d.joinedAt ?? d.invitedAt).toISOString(),
    access: business.suspension ? "on_hold" : isVerified || kycFree(d.permissions) ? "on" : "verify",
  };
}

/**
 * What a team member may do at a business: their active place must include `permission` (or one of them), they must be verified
 * unless every permission asked for works without it (scanning tickets), and the business must not be on hold. Owners use the
 * vendor routes, not this.
 */
export async function teamAccess(
  db: Database,
  auth: Pick<AuthContext, "userId" | "kyc">,
  where: { placeId: string } | { businessId: ObjectId },
  permission: TeamPermission | TeamPermission[],
) {
  const at = "placeId" in where ? { _id: new ObjectId(where.placeId) } : { businessId: where.businessId };
  const place = await db.employments.findOne({ ...at, userId: auth.userId, status: "active", current: true });
  if (!place) throw new AppError("NOT_FOUND", "You're not on this business's team.");
  const asked = [permission].flat();
  if (auth.kyc.base !== "approved" && !kycFree(asked)) throw new AppError("KYC_REQUIRED", "Get verified to work at this business.");
  if (!asked.some((p) => place.permissions.includes(p))) throw new AppError("FORBIDDEN", "The owner hasn't given you this.");
  const business = await db.businesses.findOne({ _id: place.businessId });
  if (!business) throw new AppError("NOT_FOUND", "Business not found.");
  if (business.suspension) throw new AppError("BUSINESS_SUSPENDED");
  return { place, business };
}

/** When an account or a draft business goes, its places on teams end too. */
export async function endPlacesFor(db: Database, filter: { userId: ObjectId } | { businessId: ObjectId }, endedBy: "member" | "owner") {
  const now = new Date();
  await db.employments.updateMany(
    { ...filter, current: true },
    { $set: { status: endedBy === "member" ? "left" : "removed", endedAt: now, endedBy, updatedAt: now }, $unset: { current: "" } },
  );
}
