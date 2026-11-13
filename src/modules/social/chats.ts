import { randomUUID } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { MongoServerError, ObjectId, type ClientSession, type WithId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { ChatMemberDoc, ChatMessageDoc, ChatMessageKind, ConversationDoc, Database } from "../../platform/db.js";
import { stamp } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import {
  AddPeople,
  ChatDetailResult,
  ChatList,
  ChatListQuery,
  ChatParams,
  ChatUnread,
  ChatUpdates,
  CreateGroup,
  GROUP_MAX,
  MemberParams,
  MessageList,
  MessagePageQuery,
  MessageParams,
  MessageResult,
  MuteBody,
  RenameGroup,
  SendMessage,
  StartDm,
  UpdatesQuery,
  type Chat,
  type Message,
} from "./chat-contracts.js";
import { chatPhotoUrl } from "./chat-photo-links.js";
import { Done } from "./contracts.js";
import { toChatPhoto } from "./photos.js";
import { blockBetween, blockedAround, blockedError } from "./relations.js";
import { AUTHOR_PROJECTION, authorView, type AuthorFields } from "./shared.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const limit = (perMinutes: number, max: number) => ({ rateLimit: { max, timeWindow: perMinutes * 60_000 } });
const isDuplicate = (err: unknown) => err instanceof MongoServerError && err.code === 11000;
/** Polls look back this far past `since`, so a message saved while the last poll ran is not missed. */
const POLL_OVERLAP_MS = 5_000;
const POLL_MAX = 100;
const PREVIEW_MAX = 120;

type Member = WithId<ChatMemberDoc>;
type Conversation = WithId<ConversationDoc>;
type Author = ReturnType<typeof authorView>;

const unavailable = () => new AppError("NOT_FOUND", "This chat isn't available.");
const adminsOnly = () => new AppError("FORBIDDEN", "Only group admins can do that.");
const pairKeyOf = (a: ObjectId, b: ObjectId) => [a.toHexString(), b.toHexString()].sort().join(":");
const nameOf = (user: { name?: string; username?: string } | undefined) => user?.name || user?.username || "Someone";
const tidy = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Someone reading a request doesn't tell the sender: Seen starts once they accept. */
const seenBy = (peerSide: Pick<ChatMemberDoc, "state" | "readAt"> | null | undefined) =>
  peerSide?.state === "active" ? (peerSide.readAt?.toISOString() ?? null) : null;

/** "Ravi", "Ravi and Kiran", "Ravi, Kiran and 3 others". */
function namesLine(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  const rest = names.length - 2;
  return `${names.slice(0, 2).join(", ")} and ${rest === 1 ? names[2] : `${rest} others`}`;
}

function previewOf(kind: ChatMessageKind, text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line) return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX - 1)}…` : line;
  return kind === "photo" ? "Sent a photo" : kind === "post" ? "Shared a post" : "";
}

/** People who can be messaged: signed up, with a username, not deleted or on hold. */
async function reachable(d: Database, ids: ObjectId[]) {
  const users = await d.users.find({ _id: { $in: ids }, status: "active", username: { $type: "string" } }, { projection: AUTHOR_PROJECTION }).toArray();
  return new Map(users.map((u) => [u._id.toHexString(), u as AuthorFields]));
}

async function authorsOf(d: Database, ids: ObjectId[]): Promise<Map<string, Author>> {
  if (ids.length === 0) return new Map();
  const unique = [...new Map(ids.map((id) => [id.toHexString(), id])).values()];
  const users = await d.users.find({ _id: { $in: unique }, status: { $ne: "deleted" } }, { projection: AUTHOR_PROJECTION }).toArray();
  return new Map(users.map((u) => [u._id.toHexString(), authorView(u as AuthorFields)]));
}

/** Of `ids`, the people who follow `them`. Chats and invites from people you follow go straight to your chats. */
async function followersAmong(d: Database, ids: ObjectId[], them: ObjectId): Promise<Set<string>> {
  const rows = await d.follows.find({ followerId: { $in: ids }, followeeId: them }, { projection: { followerId: 1 } }).toArray();
  return new Set(rows.map((r) => r.followerId.toHexString()));
}

/** One at a time: the driver refuses insertMany inside a transaction with a timeout. */
async function addMembers(d: Database, session: ClientSession, members: ChatMemberDoc[]): Promise<void> {
  for (const member of members) await d.chatMembers.insertOne(member, { session });
}

/** Writes a message and moves everyone's chat list, unread count and the chat's preview. */
async function writeMessage(
  d: Database,
  session: ClientSession,
  conversation: Conversation,
  message: ChatMessageDoc,
): Promise<void> {
  const { conversationId, senderId, createdAt: at } = message;
  await d.chatMessages.insertOne(message, { session });
  await d.conversations.updateOne(
    { _id: conversationId },
    { $set: { last: { messageId: message._id, senderId, kind: message.kind, text: previewOf(message.kind, message.text), at }, updatedAt: at } },
    { session },
  );
  const counts = message.kind !== "event";
  await d.chatMembers.updateMany({ conversationId, userId: { $ne: senderId } }, { $set: { lastAt: at } }, { session });
  if (counts) {
    await d.chatMembers.updateMany({ conversationId, userId: { $ne: senderId }, state: { $in: ["active", "request"] } }, { $inc: { unread: 1 } }, { session });
  }
  if (conversation.memberIds.some((id) => id.equals(senderId))) {
    await d.chatMembers.updateOne(
      { conversationId, userId: senderId },
      counts
        ? { $set: { lastAt: at, readAt: at, unread: 0, sentAt: at, state: "active" } }
        : { $set: { lastAt: at, readAt: at, unread: 0 } },
      { session },
    );
  }
}

const eventMessage = (conversationId: ObjectId, actorId: ObjectId, text: string, at = new Date()): ChatMessageDoc => ({
  _id: new ObjectId(),
  conversationId,
  senderId: actorId,
  kind: "event",
  text,
  postId: null,
  photo: null,
  status: "live",
  createdAt: at,
  unsentAt: null,
});

/** Sets the chat's preview to its newest live message after one was unsent or removed. */
async function refreshLast(d: Database, conversationId: ObjectId, session?: ClientSession): Promise<void> {
  const latest = await d.chatMessages.find({ conversationId, status: "live" }, { session }).sort({ createdAt: -1, _id: -1 }).limit(1).next();
  await d.conversations.updateOne(
    { _id: conversationId },
    {
      $set: {
        last: latest
          ? { messageId: latest._id, senderId: latest.senderId, kind: latest.kind, text: previewOf(latest.kind, latest.text), at: latest.createdAt }
          : null,
      },
    },
    { session },
  );
}

/** Takes someone out of a group. The longest-standing member becomes admin if the last admin goes; an empty group is deleted. */
async function removeFromGroup(
  app: FastifyInstance,
  d: Database,
  conversation: Conversation,
  userId: ObjectId,
  event: { by: ObjectId; text: string } | null,
): Promise<void> {
  const now = new Date();
  const emptied = await d.transaction(async (session) => {
    await d.chatMembers.deleteOne({ conversationId: conversation._id, userId }, { session });
    const after = await d.conversations.findOneAndUpdate(
      { _id: conversation._id },
      { $pull: { memberIds: userId, adminIds: userId }, $set: { changedAt: now, updatedAt: now } },
      { session, returnDocument: "after" },
    );
    if (!after || after.memberIds.length === 0) return true;
    if (after.adminIds.length === 0) {
      const next =
        (await d.chatMembers.find({ conversationId: conversation._id, state: "active" }, { session }).sort({ joinedAt: 1 }).limit(1).next()) ??
        (await d.chatMembers.find({ conversationId: conversation._id }, { session }).sort({ joinedAt: 1 }).limit(1).next());
      if (next) await d.conversations.updateOne({ _id: conversation._id }, { $addToSet: { adminIds: next.userId } }, { session });
    }
    if (event) await writeMessage(d, session, after, eventMessage(conversation._id, event.by, event.text, now));
    return false;
  });
  if (emptied) await deleteConversation(app, d, conversation._id);
}

async function deleteConversation(app: FastifyInstance, d: Database, conversationId: ObjectId): Promise<void> {
  const photos = await d.chatMessages.find({ conversationId, photo: { $ne: null } }, { projection: { photo: 1 } }).toArray();
  await Promise.all(photos.map((m) => app.chatPhotos.remove(m.photo!.key)));
  await d.chatMessages.deleteMany({ conversationId });
  await d.chatMembers.deleteMany({ conversationId });
  await d.conversations.deleteOne({ _id: conversationId });
}

/**
 * When an account is deleted its chats go too: 1:1 chats entirely, and in groups its messages, with
 * the person taken out of the group.
 */
export async function eraseChats(app: FastifyInstance, d: Database, userId: ObjectId): Promise<void> {
  const memberships = await d.chatMembers.find({ userId }, { projection: { conversationId: 1, kind: 1 } }).toArray();
  for (const membership of memberships) {
    if (membership.kind === "dm") {
      await deleteConversation(app, d, membership.conversationId);
      continue;
    }
    const conversation = await d.conversations.findOne({ _id: membership.conversationId });
    if (!conversation) continue;
    const photos = await d.chatMessages.find({ conversationId: conversation._id, senderId: userId, photo: { $ne: null } }, { projection: { photo: 1 } }).toArray();
    await Promise.all(photos.map((m) => app.chatPhotos.remove(m.photo!.key)));
    await d.chatMessages.deleteMany({ conversationId: conversation._id, senderId: userId });
    await removeFromGroup(app, d, conversation, userId, null);
    await refreshLast(d, conversation._id);
  }
}

/** 1:1 chats, private groups, and message requests. Mounted inside the social module. */
const chats: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const me = (request: FastifyRequest) => request.auth!.userId;

  /** Your side of a chat you can see. 1:1 chats with someone blocked either way can't be opened. */
  async function open(request: FastifyRequest, id: string): Promise<{ conversation: Conversation; mine: Member }> {
    const d = db();
    const conversationId = new ObjectId(id);
    const [conversation, mine] = await Promise.all([
      d.conversations.findOne({ _id: conversationId }),
      d.chatMembers.findOne({ conversationId, userId: me(request), state: { $in: ["active", "request"] } }),
    ]);
    if (!conversation || !mine) throw unavailable();
    if (mine.peerId && (await blockBetween(d, me(request), mine.peerId))) throw unavailable();
    return { conversation, mine };
  }

  async function asAdmin(request: FastifyRequest, id: string) {
    const found = await open(request, id);
    if (found.conversation.kind !== "group") throw new AppError("NOT_FOUND", "That's for groups.");
    if (found.mine.state !== "active" || !found.conversation.adminIds.some((a) => a.equals(me(request)))) throw adminsOnly();
    return found;
  }

  async function chatViews(request: FastifyRequest, mines: Member[]): Promise<Chat[]> {
    if (mines.length === 0) return [];
    const d = db();
    const viewer = me(request);
    const ids = mines.map((m) => m.conversationId);
    const dmIds = mines.filter((m) => m.kind === "dm").map((m) => m.conversationId);
    const [conversations, peerSides, peers] = await Promise.all([
      d.conversations.find({ _id: { $in: ids } }).toArray(),
      dmIds.length ? d.chatMembers.find({ conversationId: { $in: dmIds }, userId: { $ne: viewer } }).toArray() : Promise.resolve([]),
      authorsOf(d, mines.flatMap((m) => (m.peerId ? [m.peerId] : []))),
    ]);
    const byId = new Map(conversations.map((c) => [c._id.toHexString(), c]));
    const peerSideOf = new Map(peerSides.map((p) => [p.conversationId.toHexString(), p]));
    return mines.flatMap((mine) => {
      const conversation = byId.get(mine.conversationId.toHexString());
      if (!conversation) return [];
      const peer = mine.peerId ? (peers.get(mine.peerId.toHexString()) ?? null) : null;
      const peerSide = peerSideOf.get(mine.conversationId.toHexString());
      const waiting = conversation.kind === "dm" && !!peerSide && peerSide.state !== "active" && !!mine.sentAt;
      const last = conversation.last;
      return [
        {
          id: conversation._id.toHexString(),
          kind: conversation.kind,
          title: conversation.kind === "group" ? (conversation.title ?? "Group") : (peer?.name || peer?.username || "Ruxstar user"),
          peer,
          members: conversation.memberIds.length,
          state: mine.state === "request" ? ("request" as const) : ("active" as const),
          muted: mine.muted,
          unread: mine.unread,
          admin: conversation.adminIds.some((a) => a.equals(viewer)),
          canSend: conversation.kind === "group" || (!!peer && !!peerSide && !waiting),
          waiting,
          last: last ? { kind: last.kind, text: last.text, mine: last.senderId.equals(viewer), at: last.at.toISOString() } : null,
          createdAt: conversation.createdAt.toISOString(),
        },
      ];
    });
  }

  async function detail(request: FastifyRequest, conversation: Conversation, mine: Member) {
    const d = db();
    const viewer = me(request);
    const [[chat], members] = await Promise.all([chatViews(request, [mine]), d.chatMembers.find({ conversationId: conversation._id }).toArray()]);
    if (!chat) throw unavailable();
    const authors = await authorsOf(d, members.map((m) => m.userId));
    const people = members
      .filter((m) => m.state !== "declined")
      .flatMap((m) => {
        const author = authors.get(m.userId.toHexString());
        if (!author) return [];
        return [{ ...author, admin: conversation.adminIds.some((a) => a.equals(m.userId)), state: m.state === "request" ? ("request" as const) : ("active" as const), me: m.userId.equals(viewer) }];
      })
      .sort((a, b) => Number(b.me) - Number(a.me));
    const peerSide = conversation.kind === "dm" ? members.find((m) => !m.userId.equals(viewer)) : undefined;
    return { ...chat, people, seenAt: seenBy(peerSide) };
  }

  async function messageViews(request: FastifyRequest, messages: WithId<ChatMessageDoc>[]): Promise<Message[]> {
    if (messages.length === 0) return [];
    const d = db();
    const viewer = me(request);
    const postIds = messages.flatMap((m) => (m.postId ? [m.postId] : []));
    const [senders, posts, blocked] = await Promise.all([
      authorsOf(d, messages.filter((m) => m.kind !== "event").map((m) => m.senderId)),
      postIds.length ? d.posts.find({ _id: { $in: postIds }, status: "live" }, { projection: { authorId: 1, text: 1, media: 1 } }).toArray() : Promise.resolve([]),
      postIds.length ? blockedAround(d, viewer) : Promise.resolve([]),
    ]);
    const postAuthors = await authorsOf(d, posts.map((p) => p.authorId));
    const hidden = new Set(blocked.map((id) => id.toHexString()));
    const postById = new Map(posts.map((p) => [p._id.toHexString(), p]));
    return messages.flatMap((m) => {
      const sender = m.kind === "event" ? null : (senders.get(m.senderId.toHexString()) ?? null);
      if (m.kind !== "event" && !sender) return [];
      let post: Message["post"] = null;
      if (m.postId) {
        const found = postById.get(m.postId.toHexString());
        const author = found ? postAuthors.get(found.authorId.toHexString()) : undefined;
        const visible = !!found && !!author && !hidden.has(found.authorId.toHexString());
        const first = visible ? found!.media[0] : undefined;
        post = {
          id: m.postId.toHexString(),
          available: visible,
          author: visible ? author! : null,
          text: visible ? previewOf("text", found!.text) : "",
          photo: first ? (first.smaller?.[0]?.url ?? first.url) : null,
        };
      }
      return [
        {
          id: m._id.toHexString(),
          chatId: m.conversationId.toHexString(),
          kind: m.kind,
          sender,
          mine: m.kind !== "event" && m.senderId.equals(viewer),
          text: m.text,
          post,
          photo: m.photo ? { url: chatPhotoUrl(app, request, m._id.toHexString()), width: m.photo.width, height: m.photo.height } : null,
          createdAt: m.createdAt.toISOString(),
        },
      ];
    });
  }

  /** Refuses a send that would break the request rule: one message until the other person accepts. */
  async function assertCanSend(conversation: Conversation, mine: Member) {
    if (conversation.kind === "group") return;
    const d = db();
    const peerSide = await d.chatMembers.findOne({ conversationId: conversation._id, userId: { $ne: mine.userId } });
    if (!peerSide || !(await reachable(d, [peerSide.userId])).size) throw new AppError("FORBIDDEN", "This account can't get messages.");
    if (peerSide.state !== "active" && mine.sentAt) throw new AppError("CHAT_REQUEST_PENDING");
  }

  async function send(request: FastifyRequest, conversation: Conversation, mine: Member, fields: Pick<ChatMessageDoc, "kind" | "text" | "postId" | "photo">) {
    const d = db();
    const message: ChatMessageDoc = {
      _id: new ObjectId(),
      conversationId: conversation._id,
      senderId: me(request),
      ...fields,
      status: "live",
      createdAt: new Date(),
      unsentAt: null,
    };
    await d.transaction((session) => writeMessage(d, session, conversation, message));
    const [view] = await messageViews(request, [message]);
    return view!;
  }

  /** Starts or reopens a 1:1 chat. Someone who doesn't follow `me` gets it as a request. */
  async function dmWith(viewer: ObjectId, them: ObjectId): Promise<{ conversation: Conversation; mine: Member; created: boolean }> {
    const d = db();
    const pairKey = pairKeyOf(viewer, them);
    const existing = await d.conversations.findOne({ pairKey });
    if (!existing) {
      const now = new Date();
      const theirState = (await followersAmong(d, [them], viewer)).size ? "active" : "request";
      const conversation: ConversationDoc = {
        _id: new ObjectId(),
        kind: "dm",
        pairKey,
        title: null,
        createdBy: viewer,
        memberIds: [viewer, them],
        adminIds: [],
        last: null,
        changedAt: now,
        ...stamp(now),
      };
      const side = (userId: ObjectId, peerId: ObjectId, state: ChatMemberDoc["state"]): ChatMemberDoc => ({
        conversationId: conversation._id,
        userId,
        kind: "dm",
        peerId,
        state,
        addedBy: viewer,
        joinedAt: now,
        lastAt: null,
        unread: 0,
        readAt: null,
        muted: false,
        sentAt: null,
      });
      try {
        await d.transaction(async (session) => {
          await d.conversations.insertOne(conversation, { session });
          await addMembers(d, session, [side(viewer, them, "active"), side(them, viewer, theirState)]);
        });
        const mine = await d.chatMembers.findOne({ conversationId: conversation._id, userId: viewer });
        return { conversation, mine: mine!, created: true };
      } catch (err) {
        if (!isDuplicate(err)) throw err;
      }
    }
    const conversation = existing ?? (await d.conversations.findOne({ pairKey }));
    if (!conversation) throw unavailable();
    // Opening a chat you declined means you want it after all.
    const mine = await d.chatMembers.findOneAndUpdate(
      { conversationId: conversation._id, userId: viewer, state: "declined" },
      { $set: { state: "active" } },
      { returnDocument: "after" },
    ) ?? (await d.chatMembers.findOne({ conversationId: conversation._id, userId: viewer }));
    if (!mine) throw unavailable();
    return { conversation, mine, created: false };
  }

  /** The people being added, checked: real accounts, not you, not blocked either way. */
  async function invitees(viewer: ObjectId, userIds: string[]) {
    const d = db();
    const ids = userIds.map((id) => new ObjectId(id)).filter((id) => !id.equals(viewer));
    if (ids.length === 0) throw new AppError("VALIDATION_FAILED", "Add at least one other person.", [{ path: "body/userIds", message: "No one to add" }]);
    const [found, blocked] = await Promise.all([reachable(d, ids), blockedAround(d, viewer)]);
    if (found.size !== ids.length) throw new AppError("VALIDATION_FAILED", "Some of these people can't be added.", [{ path: "body/userIds", message: "Unknown person" }]);
    if (ids.some((id) => blocked.some((b) => b.equals(id)))) throw blockedError();
    return { ids, users: found };
  }

  const groupMember = (conversationId: ObjectId, userId: ObjectId, addedBy: ObjectId, state: ChatMemberDoc["state"], at: Date): ChatMemberDoc => ({
    conversationId,
    userId,
    kind: "group",
    peerId: null,
    state,
    addedBy,
    joinedAt: at,
    lastAt: at,
    unread: 0,
    readAt: state === "active" && userId.equals(addedBy) ? at : null,
    muted: false,
    sentAt: null,
  });

  async function myName(viewer: ObjectId) {
    return nameOf((await db().users.findOne({ _id: viewer }, { projection: { name: 1, username: 1 } })) ?? undefined);
  }

  app.get(
    "/chats",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["chats"],
        summary: "Your chats, or your message requests, latest message first",
        description: "`box: requests` lists chats and group invites from people you don't follow. 1:1 chats with someone blocked either way are left out.",
        querystring: ChatListQuery,
        response: { 200: ChatList, ...Errors },
        security,
      },
    },
    async (request) => {
      const d = db();
      const viewer = me(request);
      const blocked = await blockedAround(d, viewer);
      const result = await findPage(d.chatMembers, {
        filter: { userId: viewer, state: request.query.box === "requests" ? "request" : "active", lastAt: { $ne: null }, peerId: { $nin: blocked } },
        sortField: "lastAt",
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      return page(request, await chatViews(request, result.items), result.nextCursor);
    },
  );

  app.get(
    "/chats/unread",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["chats"],
        summary: "Unread messages for the badge, and waiting requests",
        description: "Poll every 15 seconds or so while the app or site is open. Muted chats don't count.",
        response: { 200: ChatUnread, ...Errors },
        security,
      },
    },
    async (request) => {
      const d = db();
      const viewer = me(request);
      const blocked = await blockedAround(d, viewer);
      const [sum, requests] = await Promise.all([
        d.chatMembers
          .aggregate<{ total: number }>([
            { $match: { userId: viewer, state: "active", muted: false, unread: { $gt: 0 }, peerId: { $nin: blocked } } },
            { $group: { _id: null, total: { $sum: "$unread" } } },
          ])
          .next(),
        d.chatMembers.countDocuments({ userId: viewer, state: "request", lastAt: { $ne: null }, peerId: { $nin: blocked } }),
      ]);
      return ok(request, { unread: sum?.total ?? 0, requests });
    },
  );

  app.post(
    "/chats/dm",
    {
      preHandler: requireAuth,
      config: limit(1, 30),
      schema: {
        tags: ["chats"],
        summary: "Open your 1:1 chat with someone, starting it if needed",
        description:
          "If they don't follow you, it reaches them as a request when you send your first message, and you can't send more until they accept. " +
          "Blocked either way: FORBIDDEN.",
        body: StartDm,
        response: { 200: ChatDetailResult, 201: ChatDetailResult, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const d = db();
      const viewer = me(request);
      const them = new ObjectId(request.body.userId);
      if (them.equals(viewer)) throw new AppError("VALIDATION_FAILED", "You can't message yourself.", [{ path: "body/userId", message: "That's you" }]);
      if (!(await reachable(d, [them])).size) throw new AppError("NOT_FOUND", "This account can't get messages.");
      if (await blockBetween(d, viewer, them)) throw blockedError();
      const { conversation, mine, created } = await dmWith(viewer, them);
      return reply.status(created ? 201 : 200).send(ok(request, await detail(request, conversation, mine)));
    },
  );

  app.post(
    "/chats/groups",
    {
      preHandler: requireAuth,
      config: limit(10, 10),
      schema: {
        tags: ["chats"],
        summary: "Start a private group, up to 50 people with you",
        description: "You become its admin. People who don't follow you get it as a request and join when they accept.",
        body: CreateGroup,
        response: { 201: ChatDetailResult, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const d = db();
      const viewer = me(request);
      const title = tidy(request.body.title).replace(/\n/g, " ");
      if (!title) throw new AppError("VALIDATION_FAILED", "Name the group.", [{ path: "body/title", message: "Empty" }]);
      const { ids } = await invitees(viewer, request.body.userIds);
      const following = await followersAmong(d, ids, viewer);
      const now = new Date();
      const conversation: ConversationDoc = {
        _id: new ObjectId(),
        kind: "group",
        title,
        createdBy: viewer,
        memberIds: [viewer, ...ids],
        adminIds: [viewer],
        last: null,
        changedAt: now,
        ...stamp(now),
      };
      const event = eventMessage(conversation._id, viewer, `${await myName(viewer)} created the group`, now);
      await d.transaction(async (session) => {
        await d.conversations.insertOne(conversation, { session });
        await addMembers(d, session, [
          groupMember(conversation._id, viewer, viewer, "active", now),
          ...ids.map((id) => groupMember(conversation._id, id, viewer, following.has(id.toHexString()) ? "active" : "request", now)),
        ]);
        await writeMessage(d, session, conversation, event);
      });
      const { conversation: saved, mine } = await open(request, conversation._id.toHexString());
      return reply.status(201).send(ok(request, await detail(request, saved, mine)));
    },
  );

  app.get(
    "/chats/:id",
    {
      preHandler: requireAuth,
      schema: { tags: ["chats"], summary: "One chat, with everyone in it", params: ChatParams, response: { 200: ChatDetailResult, ...Errors }, security },
    },
    async (request) => {
      const { conversation, mine } = await open(request, request.params.id);
      return ok(request, await detail(request, conversation, mine));
    },
  );

  app.get(
    "/chats/:id/messages",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["chats"],
        summary: "A chat's messages, newest first",
        description: "For opening a chat and scrolling back. Then poll /updates for new ones. Group members see messages from when they were added.",
        params: ChatParams,
        querystring: MessagePageQuery,
        response: { 200: MessageList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { conversation, mine } = await open(request, request.params.id);
      const result = await findPage(db().chatMessages, {
        filter: { conversationId: conversation._id, status: "live", createdAt: { $gte: mine.joinedAt } },
        sortField: "createdAt",
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      return page(request, await messageViews(request, result.items), result.nextCursor);
    },
  );

  app.get(
    "/chats/:id/updates",
    {
      preHandler: requireAuth,
      config: limit(1, 120),
      schema: {
        tags: ["chats"],
        summary: "What changed in an open chat since your last look",
        description: "Poll every 3 seconds or so while a chat is open. Pass the last answer's `now` as `since`.",
        params: ChatParams,
        querystring: UpdatesQuery,
        response: { 200: ChatUpdates, ...Errors },
        security,
      },
    },
    async (request) => {
      const d = db();
      const now = new Date();
      const { conversation, mine } = await open(request, request.params.id);
      const since = new Date(request.query.since);
      const from = new Date(Math.max(since.getTime() - POLL_OVERLAP_MS, mine.joinedAt.getTime() - 1));
      const [messages, unsent, peerSide] = await Promise.all([
        d.chatMessages.find({ conversationId: conversation._id, status: "live", createdAt: { $gt: from } }).sort({ createdAt: 1, _id: 1 }).limit(POLL_MAX).toArray(),
        d.chatMessages.find({ conversationId: conversation._id, status: "unsent", unsentAt: { $gt: from } }, { projection: { _id: 1 } }).toArray(),
        conversation.kind === "dm" ? d.chatMembers.findOne({ conversationId: conversation._id, userId: { $ne: mine.userId } }, { projection: { readAt: 1, state: 1 } }) : null,
      ]);
      return ok(request, {
        messages: await messageViews(request, messages),
        unsent: unsent.map((m) => m._id.toHexString()),
        seenAt: seenBy(peerSide),
        changed: (conversation.changedAt ?? conversation.createdAt) > since,
        now: now.toISOString(),
      });
    },
  );

  app.post(
    "/chats/:id/messages",
    {
      preHandler: [requireAuth, idempotent],
      config: limit(1, 120),
      schema: {
        tags: ["chats"],
        summary: "Send text, a post, or a post with a note",
        description:
          "Send an Idempotency-Key, so a retry never sends twice. Sending accepts a request you had. In a 1:1 chat the other person hasn't accepted, " +
          "you get one message: the next answers CHAT_REQUEST_PENDING.",
        params: ChatParams,
        body: SendMessage,
        response: { 201: MessageResult, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const d = db();
      const { conversation, mine } = await open(request, request.params.id);
      const text = tidy(request.body.text ?? "");
      const postId = request.body.postId ? new ObjectId(request.body.postId) : null;
      if (!text && !postId) throw new AppError("VALIDATION_FAILED", "Write something.", [{ path: "body/text", message: "Empty message" }]);
      if (postId) {
        const post = await d.posts.findOne({ _id: postId, status: "live" }, { projection: { authorId: 1 } });
        if (!post || (await blockBetween(d, me(request), post.authorId))) {
          throw new AppError("VALIDATION_FAILED", "This post can't be shared.", [{ path: "body/postId", message: "Not available" }]);
        }
      }
      await assertCanSend(conversation, mine);
      const message = await send(request, conversation, mine, { kind: postId ? "post" : "text", text, postId, photo: null });
      return reply.status(201).send(ok(request, message));
    },
  );

  app.post(
    "/chats/:id/photos",
    {
      preHandler: [requireAuth, idempotent],
      config: limit(1, 30),
      schema: {
        tags: ["chats"],
        summary: "Send a photo",
        description:
          "Send the image itself with Content-Type image/jpeg, image/png or image/webp, up to 8 MB, and an Idempotency-Key. " +
          "It is kept privately, as WebP at most 1280 pixels on its long side, without its metadata. Its link works for at least an hour.",
        params: ChatParams,
        response: { 201: MessageResult, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const { conversation, mine } = await open(request, request.params.id);
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw new AppError("PHOTO_INVALID");
      await assertCanSend(conversation, mine);
      const photo = await toChatPhoto(request.body);
      const key = `chat-media/${app.config.env}/${conversation._id.toHexString()}/${randomUUID()}.webp`;
      await app.chatPhotos.save(key, photo.data);
      try {
        const message = await send(request, conversation, mine, { kind: "photo", text: "", postId: null, photo: { key, width: photo.width, height: photo.height } });
        return reply.status(201).send(ok(request, message));
      } catch (err) {
        await app.chatPhotos.remove(key);
        throw err;
      }
    },
  );

  app.delete(
    "/chats/:id/messages/:messageId",
    {
      preHandler: requireAuth,
      config: limit(1, 60),
      schema: {
        tags: ["chats"],
        summary: "Unsend your message. It disappears for everyone.",
        params: MessageParams,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const d = db();
      const { conversation } = await open(request, request.params.id);
      const now = new Date();
      const message = await d.chatMessages.findOneAndUpdate(
        { _id: new ObjectId(request.params.messageId), conversationId: conversation._id, senderId: me(request), status: "live", kind: { $ne: "event" } },
        { $set: { status: "unsent", unsentAt: now, text: "", postId: null, photo: null } },
        { returnDocument: "before" },
      );
      if (!message) throw new AppError("NOT_FOUND", "That message is already gone.");
      if (message.photo) await app.chatPhotos.remove(message.photo.key);
      await d.chatMembers.updateMany(
        { conversationId: conversation._id, userId: { $ne: me(request) }, unread: { $gt: 0 }, $or: [{ readAt: null }, { readAt: { $lt: message.createdAt } }] },
        { $inc: { unread: -1 } },
      );
      if (conversation.last?.messageId.equals(message._id)) await refreshLast(d, conversation._id);
      return ok(request, { done: true as const });
    },
  );

  app.post(
    "/chats/:id/read",
    {
      preHandler: requireAuth,
      config: limit(1, 120),
      schema: {
        tags: ["chats"],
        summary: "Mark a chat read",
        description: "Call when a chat is opened and when new messages arrive while it is open. In 1:1 chats the other person sees Seen.",
        params: ChatParams,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const { mine } = await open(request, request.params.id);
      await db().chatMembers.updateOne({ _id: mine._id }, { $set: { unread: 0, readAt: new Date() } });
      return ok(request, { done: true as const });
    },
  );

  app.post(
    "/chats/:id/accept",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["chats"],
        summary: "Accept a message request or group invite",
        params: ChatParams,
        response: { 200: ChatDetailResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const d = db();
      const { conversation, mine } = await open(request, request.params.id);
      if (mine.state !== "request") return ok(request, await detail(request, conversation, mine));
      const now = new Date();
      const accepted = await d.chatMembers.findOneAndUpdate({ _id: mine._id }, { $set: { state: "active" } }, { returnDocument: "after" });
      if (conversation.kind === "group") {
        const line = `${await myName(mine.userId)} joined`;
        await d.transaction((session) => writeMessage(d, session, conversation, eventMessage(conversation._id, mine.userId, line, now)));
      }
      return ok(request, await detail(request, conversation, accepted ?? mine));
    },
  );

  app.post(
    "/chats/:id/decline",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["chats"],
        summary: "Turn down a message request or group invite",
        description: "A 1:1 request is hidden from you and the sender can't send more; they aren't told. A group invite takes you out of the group.",
        params: ChatParams,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const d = db();
      const { conversation, mine } = await open(request, request.params.id);
      if (mine.state !== "request") throw new AppError("CONFLICT", "This isn't a request any more.");
      if (conversation.kind === "dm") await d.chatMembers.updateOne({ _id: mine._id }, { $set: { state: "declined", unread: 0 } });
      else await removeFromGroup(app, d, conversation, mine.userId, null);
      return ok(request, { done: true as const });
    },
  );

  app.put(
    "/chats/:id/mute",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["chats"],
        summary: "Mute or unmute a chat",
        description: "A muted chat still shows its unread count but doesn't add to the badge.",
        params: ChatParams,
        body: MuteBody,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const { mine } = await open(request, request.params.id);
      await db().chatMembers.updateOne({ _id: mine._id }, { $set: { muted: request.body.muted } });
      return ok(request, { done: true as const });
    },
  );

  app.patch(
    "/chats/:id",
    {
      preHandler: requireAuth,
      config: limit(1, 10),
      schema: { tags: ["chats"], summary: "Rename a group (admins)", params: ChatParams, body: RenameGroup, response: { 200: ChatDetailResult, ...Errors }, security },
    },
    async (request) => {
      const d = db();
      const { conversation } = await asAdmin(request, request.params.id);
      const title = tidy(request.body.title).replace(/\n/g, " ");
      if (!title) throw new AppError("VALIDATION_FAILED", "Name the group.", [{ path: "body/title", message: "Empty" }]);
      if (title !== conversation.title) {
        const now = new Date();
        await d.transaction(async (session) => {
          await d.conversations.updateOne({ _id: conversation._id }, { $set: { title, changedAt: now, updatedAt: now } }, { session });
          await writeMessage(d, session, conversation, eventMessage(conversation._id, me(request), `${await myName(me(request))} named the group ${title}`, now));
        });
      }
      const { conversation: saved, mine } = await open(request, request.params.id);
      return ok(request, await detail(request, saved, mine));
    },
  );

  app.post(
    "/chats/:id/people",
    {
      preHandler: requireAuth,
      config: limit(1, 20),
      schema: {
        tags: ["chats"],
        summary: "Add people to a group (admins)",
        description: "People who don't follow you get it as a request. CHAT_GROUP_FULL past 50 people.",
        params: ChatParams,
        body: AddPeople,
        response: { 200: ChatDetailResult, ...Errors },
        security,
      },
    },
    async (request) => {
      const d = db();
      const viewer = me(request);
      const { conversation } = await asAdmin(request, request.params.id);
      const { ids, users } = await invitees(viewer, request.body.userIds);
      const fresh = ids.filter((id) => !conversation.memberIds.some((m) => m.equals(id)));
      if (fresh.length) {
        if (conversation.memberIds.length + fresh.length > GROUP_MAX) throw new AppError("CHAT_GROUP_FULL");
        const following = await followersAmong(d, fresh, viewer);
        const now = new Date();
        const line = `${await myName(viewer)} added ${namesLine(fresh.map((id) => nameOf(users.get(id.toHexString()))))}`;
        await d.transaction(async (session) => {
          const grown = await d.conversations.updateOne(
            { _id: conversation._id, [`memberIds.${GROUP_MAX - fresh.length}`]: { $exists: false } },
            { $addToSet: { memberIds: { $each: fresh } }, $set: { changedAt: now, updatedAt: now } },
            { session },
          );
          if (!grown.modifiedCount) throw new AppError("CHAT_GROUP_FULL");
          await addMembers(
            d,
            session,
            fresh.map((id) => groupMember(conversation._id, id, viewer, following.has(id.toHexString()) ? "active" : "request", now)),
          );
          await writeMessage(d, session, conversation, eventMessage(conversation._id, viewer, line, now));
        });
      }
      const { conversation: saved, mine } = await open(request, request.params.id);
      return ok(request, await detail(request, saved, mine));
    },
  );

  app.delete(
    "/chats/:id/people/:userId",
    {
      preHandler: requireAuth,
      config: limit(1, 20),
      schema: { tags: ["chats"], summary: "Remove someone from a group (admins)", params: MemberParams, response: { 200: Done, ...Errors }, security },
    },
    async (request) => {
      const d = db();
      const viewer = me(request);
      const target = new ObjectId(request.params.userId);
      if (target.equals(viewer)) throw new AppError("VALIDATION_FAILED", "Use Leave to leave the group.", [{ path: "params/userId", message: "That's you" }]);
      const { conversation } = await asAdmin(request, request.params.id);
      if (!conversation.memberIds.some((m) => m.equals(target))) throw new AppError("NOT_FOUND", "They're not in this group.");
      const them = await d.users.findOne({ _id: target }, { projection: { name: 1, username: 1 } });
      await removeFromGroup(app, d, conversation, target, { by: viewer, text: `${await myName(viewer)} removed ${nameOf(them ?? undefined)}` });
      return ok(request, { done: true as const });
    },
  );

  app.put(
    "/chats/:id/admins/:userId",
    {
      preHandler: requireAuth,
      config: limit(1, 20),
      schema: { tags: ["chats"], summary: "Make someone a group admin (admins)", params: MemberParams, response: { 200: ChatDetailResult, ...Errors }, security },
    },
    async (request) => {
      const d = db();
      const viewer = me(request);
      const target = new ObjectId(request.params.userId);
      const { conversation } = await asAdmin(request, request.params.id);
      const member = await d.chatMembers.findOne({ conversationId: conversation._id, userId: target, state: "active" });
      if (!member) throw new AppError("NOT_FOUND", "They need to be in the group first.");
      if (!conversation.adminIds.some((a) => a.equals(target))) {
        const them = await d.users.findOne({ _id: target }, { projection: { name: 1, username: 1 } });
        const now = new Date();
        await d.transaction(async (session) => {
          await d.conversations.updateOne({ _id: conversation._id }, { $addToSet: { adminIds: target }, $set: { changedAt: now, updatedAt: now } }, { session });
          await writeMessage(d, session, conversation, eventMessage(conversation._id, viewer, `${await myName(viewer)} made ${nameOf(them ?? undefined)} an admin`, now));
        });
      }
      const { conversation: saved, mine } = await open(request, request.params.id);
      return ok(request, await detail(request, saved, mine));
    },
  );

  app.post(
    "/chats/:id/leave",
    {
      preHandler: requireAuth,
      config: limit(1, 20),
      schema: {
        tags: ["chats"],
        summary: "Leave a group",
        description: "If you were its only admin, the person who has been in it longest becomes admin.",
        params: ChatParams,
        response: { 200: Done, ...Errors },
        security,
      },
    },
    async (request) => {
      const d = db();
      const { conversation, mine } = await open(request, request.params.id);
      if (conversation.kind !== "group") throw new AppError("NOT_FOUND", "That's for groups.");
      await removeFromGroup(app, d, conversation, mine.userId, mine.state === "active" ? { by: mine.userId, text: `${await myName(mine.userId)} left` } : null);
      return ok(request, { done: true as const });
    },
  );
};

export default chats;
