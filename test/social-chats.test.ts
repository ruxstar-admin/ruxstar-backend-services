import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eraseChats } from "../src/modules/social/chats.js";
import { signIn, startStack, web, type Stack } from "./helpers.js";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
}, 120_000);
afterAll(async () => {
  await stack?.stop();
});

let seq = 0;
async function person(name: string) {
  const who = await signIn(stack);
  const username = `${name.split(" ")[0]!.toLowerCase()}.${Date.now().toString(36)}${seq++}`;
  await stack.db.users.updateOne({ _id: who.userId }, { $set: { name, username } });
  return { ...who, name, username, id: who.userId.toHexString() };
}
type Person = Awaited<ReturnType<typeof person>>;

const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, who: Person, payload?: object) =>
  stack.app.inject({ method, url: `/v1${url}`, headers: web(who.token, { "idempotency-key": randomUUID() }), ...(payload ? { payload } : {}) });

const follow = (who: Person, them: Person) => call("PUT", `/social/users/${them.id}/follow`, who);
async function dm(who: Person, them: Person) {
  const res = await call("POST", "/social/chats/dm", who, { userId: them.id });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json().data as { id: string; state: string };
}
const say = (who: Person, chatId: string, text: string) => call("POST", `/social/chats/${chatId}/messages`, who, { text });
const list = async (who: Person, box: "chats" | "requests" = "chats") =>
  (await call("GET", `/social/chats?box=${box}`, who)).json().data as { id: string; title: string; unread: number; last: { text: string } | null }[];
const unread = async (who: Person) => (await call("GET", "/social/chats/unread", who)).json().data as { unread: number; requests: number };

describe("1:1 chats and requests", () => {
  it("lands in Requests from someone you don't follow, allows one message, and opens up on accept", async () => {
    const asha = await person("Asha Request");
    const ravi = await person("Ravi Request");

    const first = await call("POST", "/social/chats/dm", ravi, { userId: asha.id });
    expect(first.statusCode).toBe(201);
    const chat = first.json().data;
    expect(chat).toMatchObject({ kind: "dm", title: asha.name, state: "active", canSend: true, waiting: false });
    expect((await call("POST", "/social/chats/dm", ravi, { userId: asha.id })).statusCode).toBe(200);

    // Nothing reaches Asha until there's a message.
    expect(await list(asha, "requests")).toEqual([]);
    expect((await say(ravi, chat.id, "Hi Asha")).statusCode).toBe(201);
    const second = await say(ravi, chat.id, "Are you there?");
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("CHAT_REQUEST_PENDING");
    expect((await call("GET", `/social/chats/${chat.id}`, ravi)).json().data).toMatchObject({ canSend: false, waiting: true });

    expect(await list(asha)).toEqual([]);
    expect(await list(asha, "requests")).toEqual([expect.objectContaining({ id: chat.id, title: ravi.name, unread: 1, last: expect.objectContaining({ text: "Hi Asha" }) })]);
    expect(await unread(asha)).toEqual({ unread: 0, requests: 1 });
    // Reading a request isn't Seen.
    await call("POST", `/social/chats/${chat.id}/read`, asha);
    expect((await call("GET", `/social/chats/${chat.id}`, ravi)).json().data.seenAt).toBeNull();

    const accepted = await call("POST", `/social/chats/${chat.id}/accept`, asha);
    expect(accepted.json().data.state).toBe("active");
    expect(await unread(asha)).toEqual({ unread: 0, requests: 0 });
    expect((await say(ravi, chat.id, "Great")).statusCode).toBe(201);
    expect(await unread(asha)).toEqual({ unread: 1, requests: 0 });

    // Seen: Ravi sees when Asha read it.
    await call("POST", `/social/chats/${chat.id}/read`, asha);
    expect(await unread(asha)).toEqual({ unread: 0, requests: 0 });
    expect((await call("GET", `/social/chats/${chat.id}`, ravi)).json().data.seenAt).not.toBeNull();

    const messages = (await call("GET", `/social/chats/${chat.id}/messages`, asha)).json().data;
    expect(messages.map((m: { text: string }) => m.text)).toEqual(["Great", "Hi Asha"]);
    expect(messages[0]).toMatchObject({ kind: "text", mine: false, sender: expect.objectContaining({ username: ravi.username }) });
  });

  it("goes straight to chats when they follow you, and a reply accepts a request", async () => {
    const asha = await person("Asha Direct");
    const ravi = await person("Ravi Direct");
    const kiran = await person("Kiran Direct");
    await follow(asha, ravi);

    const chat = await dm(ravi, asha);
    await say(ravi, chat.id, "Hello");
    expect((await list(asha)).map((c) => c.id)).toEqual([chat.id]);

    const other = await dm(kiran, asha);
    await say(kiran, other.id, "Hey");
    expect((await say(asha, other.id, "Hi Kiran")).statusCode).toBe(201);
    expect(await list(asha, "requests")).toEqual([]);
    expect((await say(kiran, other.id, "Yay")).statusCode).toBe(201);
  });

  it("hides the request on decline and keeps the sender waiting", async () => {
    const asha = await person("Asha Decline");
    const ravi = await person("Ravi Decline");
    const chat = await dm(ravi, asha);
    await say(ravi, chat.id, "Hi");
    expect((await call("POST", `/social/chats/${chat.id}/decline`, asha)).statusCode).toBe(200);
    expect(await list(asha, "requests")).toEqual([]);
    expect((await call("GET", `/social/chats/${chat.id}`, asha)).statusCode).toBe(404);
    expect((await say(ravi, chat.id, "Hello?")).json().error.code).toBe("CHAT_REQUEST_PENDING");
    // Asha changes her mind from Ravi's profile.
    expect((await dm(asha, ravi)).id).toBe(chat.id);
    expect((await say(asha, chat.id, "Sorry, hi")).statusCode).toBe(201);
  });

  it("can't be started, seen or used with someone blocked either way", async () => {
    const asha = await person("Asha Block");
    const ravi = await person("Ravi Block");
    await follow(asha, ravi);
    const chat = await dm(ravi, asha);
    await say(ravi, chat.id, "Hi");
    expect((await call("PUT", `/social/users/${ravi.id}/block`, asha)).statusCode).toBe(200);

    expect(await list(asha)).toEqual([]);
    expect(await list(ravi)).toEqual([]);
    expect((await call("GET", `/social/chats/${chat.id}`, ravi)).statusCode).toBe(404);
    expect((await say(ravi, chat.id, "Hello")).statusCode).toBe(404);
    expect((await call("POST", "/social/chats/dm", ravi, { userId: asha.id })).statusCode).toBe(403);
    expect((await call("POST", "/social/chats/dm", ravi, { userId: ravi.id })).statusCode).toBe(400);
  });
});

describe("messages", () => {
  it("polls new and unsent messages, and unsending fixes the preview and unread count", async () => {
    const asha = await person("Asha Poll");
    const ravi = await person("Ravi Poll");
    await follow(asha, ravi);
    const chat = await dm(ravi, asha);
    const since = new Date(Date.now() - 60_000).toISOString();
    await say(ravi, chat.id, "One");
    const two = (await say(ravi, chat.id, "Two")).json().data;

    let poll = (await call("GET", `/social/chats/${chat.id}/updates?since=${since}`, asha)).json().data;
    expect(poll.messages.map((m: { text: string }) => m.text)).toEqual(["One", "Two"]);
    expect(poll.unsent).toEqual([]);
    expect(await unread(asha)).toEqual({ unread: 2, requests: 0 });

    expect((await call("DELETE", `/social/chats/${chat.id}/messages/${two.id}`, asha)).statusCode).toBe(404);
    expect((await call("DELETE", `/social/chats/${chat.id}/messages/${two.id}`, ravi)).statusCode).toBe(200);
    poll = (await call("GET", `/social/chats/${chat.id}/updates?since=${poll.now}`, asha)).json().data;
    expect(poll.unsent).toEqual([two.id]);
    expect(await unread(asha)).toEqual({ unread: 1, requests: 0 });
    expect((await list(asha))[0]!.last!.text).toBe("One");
    expect((await call("GET", `/social/chats/${chat.id}/messages`, asha)).json().data.map((m: { text: string }) => m.text)).toEqual(["One"]);
  });

  it("leaves muted chats out of the badge", async () => {
    const asha = await person("Asha Mute");
    const ravi = await person("Ravi Mute");
    await follow(asha, ravi);
    const chat = await dm(ravi, asha);
    await say(ravi, chat.id, "Ping");
    await call("PUT", `/social/chats/${chat.id}/mute`, asha, { muted: true });
    expect(await unread(asha)).toEqual({ unread: 0, requests: 0 });
    expect((await list(asha))[0]).toMatchObject({ unread: 1, muted: true });
  });

  it("shares posts and sends photos through private links", async () => {
    const asha = await person("Asha Share");
    const ravi = await person("Ravi Share");
    await follow(asha, ravi);
    const chat = await dm(ravi, asha);
    const post = (await call("POST", "/social/posts", asha, { text: "My new shop is open" })).json().data;

    const shared = await call("POST", `/social/chats/${chat.id}/messages`, ravi, { postId: post.id, text: "Look" });
    expect(shared.statusCode).toBe(201);
    expect(shared.json().data).toMatchObject({ kind: "post", text: "Look", post: { id: post.id, available: true, text: "My new shop is open" } });
    expect((await call("POST", `/social/chats/${chat.id}/messages`, ravi, { postId: "0".repeat(24) })).statusCode).toBe(400);

    const image = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#6c4cf5" } }).png().toBuffer();
    const sent = await stack.app.inject({
      method: "POST",
      url: `/v1/social/chats/${chat.id}/photos`,
      headers: { ...web(ravi.token, { "idempotency-key": randomUUID() }), "content-type": "image/png" },
      payload: image,
    });
    expect(sent.statusCode).toBe(201);
    const photo = sent.json().data;
    expect(photo).toMatchObject({ kind: "photo", photo: { width: 1280, height: 640 } });
    expect((await list(asha))[0]!.last!.text).toBe("Sent a photo");

    const link = new URL(photo.photo.url);
    const fetched = await stack.app.inject({ method: "GET", url: `${link.pathname}${link.search}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers["content-type"]).toBe("image/webp");
    const forged = await stack.app.inject({ method: "GET", url: `${link.pathname}?exp=${link.searchParams.get("exp")}&t=nope` });
    expect(forged.statusCode).toBe(401);

    await call("DELETE", `/social/chats/${chat.id}/messages/${photo.id}`, ravi);
    expect(stack.chatPhotos.size).toBe(0);
    expect((await stack.app.inject({ method: "GET", url: `${link.pathname}${link.search}` })).statusCode).toBe(404);

    await call("DELETE", `/social/posts/${post.id}`, asha);
    const after = (await call("GET", `/social/chats/${chat.id}/messages`, ravi)).json().data;
    expect(after[0].post).toMatchObject({ available: false, author: null });
  });
});

describe("groups", () => {
  it("invites by follow, lets admins manage it, and hands over admin when the last one leaves", async () => {
    const asha = await person("Asha Group");
    const ravi = await person("Ravi Group");
    const kiran = await person("Kiran Group");
    const meera = await person("Meera Group");
    await follow(ravi, asha);

    const created = await call("POST", "/social/chats/groups", asha, { title: "  Book club ", userIds: [ravi.id, kiran.id] });
    expect(created.statusCode).toBe(201);
    const group = created.json().data;
    expect(group).toMatchObject({ kind: "group", title: "Book club", members: 3, admin: true, state: "active" });
    expect(group.people.map((p: { username: string; state: string }) => [p.username, p.state])).toEqual([
      [asha.username, "active"],
      [ravi.username, "active"],
      [kiran.username, "request"],
    ]);
    expect((await list(ravi))[0]!.last!.text).toBe(`${asha.name} created the group`);
    expect((await list(kiran, "requests")).map((c) => c.id)).toEqual([group.id]);

    expect((await call("PATCH", `/social/chats/${group.id}`, ravi, { title: "Mine" })).statusCode).toBe(403);
    const renamed = await call("PATCH", `/social/chats/${group.id}`, asha, { title: "Readers" });
    expect(renamed.json().data.title).toBe("Readers");

    const poll = (await call("GET", `/social/chats/${group.id}/updates?since=${new Date(Date.now() - 1000).toISOString()}`, ravi)).json().data;
    expect(poll.changed).toBe(true);
    expect(poll.messages.at(-1)).toMatchObject({ kind: "event", sender: null, text: `${asha.name} named the group Readers` });

    const added = await call("POST", `/social/chats/${group.id}/people`, asha, { userIds: [meera.id] });
    expect(added.json().data.members).toBe(4);
    expect((await call("POST", `/social/chats/${group.id}/decline`, meera)).statusCode).toBe(200);
    expect((await call("GET", `/social/chats/${group.id}`, asha)).json().data.members).toBe(3);

    expect((await call("PUT", `/social/chats/${group.id}/admins/${kiran.id}`, asha)).statusCode).toBe(404);
    await call("POST", `/social/chats/${group.id}/accept`, kiran);
    expect((await call("PUT", `/social/chats/${group.id}/admins/${kiran.id}`, asha)).json().data.people.find((p: { username: string }) => p.username === kiran.username).admin).toBe(true);
    expect((await call("DELETE", `/social/chats/${group.id}/people/${ravi.id}`, kiran)).statusCode).toBe(200);
    expect((await call("GET", `/social/chats/${group.id}`, ravi)).statusCode).toBe(404);

    await call("POST", `/social/chats/${group.id}/leave`, kiran);
    await call("POST", `/social/chats/${group.id}/leave`, asha);
    expect(await stack.db.conversations.countDocuments({ _id: new ObjectId(group.id) })).toBe(0);
  });

  it("hands admin to the longest member, stops at 50 people, and refuses blocked people", async () => {
    const asha = await person("Asha Full");
    const ravi = await person("Ravi Full");
    const kiran = await person("Kiran Full");
    await follow(ravi, asha);
    const group = (await call("POST", "/social/chats/groups", asha, { title: "Crew", userIds: [ravi.id, kiran.id] })).json().data;

    await call("POST", `/social/chats/${group.id}/leave`, asha);
    expect((await call("GET", `/social/chats/${group.id}`, ravi)).json().data).toMatchObject({ admin: true, members: 2 });

    const others = await Promise.all(Array.from({ length: 48 }, (_, i) => person(`Filler${i} Full`)));
    const full = await call("POST", `/social/chats/${group.id}/people`, ravi, { userIds: others.map((o) => o.id) });
    expect(full.json().data.members).toBe(50);
    const extra = await person("Extra Full");
    expect((await call("POST", `/social/chats/${group.id}/people`, ravi, { userIds: [extra.id] })).json().error.code).toBe("CHAT_GROUP_FULL");

    await call("PUT", `/social/users/${ravi.id}/block`, extra);
    expect((await call("POST", "/social/chats/groups", ravi, { title: "Nope", userIds: [extra.id] })).statusCode).toBe(403);
  }, 60_000);

  it("shows new members messages from when they joined", async () => {
    const asha = await person("Asha Join");
    const ravi = await person("Ravi Join");
    const kiran = await person("Kiran Join");
    await follow(ravi, asha);
    await follow(kiran, asha);
    const group = (await call("POST", "/social/chats/groups", asha, { title: "Early", userIds: [ravi.id] })).json().data;
    await say(asha, group.id, "Before Kiran");
    await call("POST", `/social/chats/${group.id}/people`, asha, { userIds: [kiran.id] });
    await say(asha, group.id, "After Kiran");
    const seen = (await call("GET", `/social/chats/${group.id}/messages`, kiran)).json().data.map((m: { text: string }) => m.text);
    expect(seen).toEqual(["After Kiran", `${asha.name} added ${kiran.name}`]);
  });
});

describe("live chat", () => {
  async function pair(tag: string) {
    const asha = await person(`Asha ${tag}`);
    const ravi = await person(`Ravi ${tag}`);
    await follow(asha, ravi);
    await follow(ravi, asha);
    const chat = await dm(ravi, asha);
    return { asha, ravi, chat };
  }
  const updates = (who: Person, chatId: string, since: string, wait = 0) => call("GET", `/social/chats/${chatId}/updates?since=${since}&wait=${wait}`, who);
  const fakeM4a = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypM4A "), Buffer.alloc(400, 7)]);

  it("holds /updates open until a message arrives, and answers when the wait runs out", async () => {
    const { asha, ravi, chat } = await pair("Wait");
    const since = new Date().toISOString();

    const started = Date.now();
    const waiting = updates(asha, chat.id, since, 10);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await say(ravi, chat.id, "Right now");
    const answer = (await waiting).json().data;
    expect(Date.now() - started).toBeLessThan(3000);
    expect(answer.messages.map((m: { text: string }) => m.text)).toEqual(["Right now"]);

    const quiet = Date.now();
    const empty = (await updates(asha, chat.id, answer.now, 1)).json().data;
    expect(Date.now() - quiet).toBeGreaterThanOrEqual(900);
    // Only the overlap that guards against missed messages: nothing new.
    expect(empty.messages.map((m: { text: string }) => m.text)).toEqual(["Right now"]);
    expect(empty).toMatchObject({ updated: [], unsent: [], typing: [] });
  });

  it("shows typing… until they stop or send", async () => {
    const { asha, ravi, chat } = await pair("Typing");
    const since = new Date(Date.now() - 1000).toISOString();
    await call("POST", `/social/chats/${chat.id}/typing`, ravi, { typing: true });
    expect((await updates(asha, chat.id, since)).json().data.typing).toEqual([expect.objectContaining({ username: ravi.username })]);
    expect((await updates(ravi, chat.id, since)).json().data.typing).toEqual([]);
    await say(ravi, chat.id, "Done typing");
    expect((await updates(asha, chat.id, since)).json().data.typing).toEqual([]);
    await call("POST", `/social/chats/${chat.id}/typing`, ravi, { typing: true });
    await call("POST", `/social/chats/${chat.id}/typing`, ravi, { typing: false });
    expect((await updates(asha, chat.id, since)).json().data.typing).toEqual([]);
  });

  it("keeps one reaction per person, swaps it, and tells open chats", async () => {
    const { asha, ravi, chat } = await pair("React");
    const hello = (await say(ravi, chat.id, "Hello")).json().data;
    expect(hello.reactions).toEqual([]);
    // Make it a minute old, so a poll from now only gets it for its reactions.
    const minuteAgo = new Date(Date.now() - 60_000);
    await stack.db.chatMessages.updateOne({ _id: new ObjectId(hello.id) }, { $set: { createdAt: minuteAgo } });
    await stack.db.chatMembers.updateMany({ conversationId: new ObjectId(chat.id) }, { $set: { joinedAt: new Date(minuteAgo.getTime() - 1000) } });
    const since = new Date().toISOString();

    const react = (who: Person, emoji: string) => call("PUT", `/social/chats/${chat.id}/messages/${hello.id}/reaction`, who, { emoji });
    expect((await react(asha, "❤️")).json().data.reactions).toEqual([{ emoji: "❤️", count: 1, mine: true }]);
    expect((await react(ravi, "❤️")).json().data.reactions).toEqual([{ emoji: "❤️", count: 2, mine: true }]);
    expect((await react(asha, "😂")).json().data.reactions).toEqual([
      { emoji: "❤️", count: 1, mine: false },
      { emoji: "😂", count: 1, mine: true },
    ]);
    expect((await react(asha, "hi")).statusCode).toBe(400);
    expect((await react(asha, "👍👍")).statusCode).toBe(400);
    expect((await react(asha, "👍🏽")).statusCode).toBe(200);

    const fromLater = (await updates(ravi, chat.id, since)).json().data;
    expect(fromLater.messages).toEqual([]);
    expect(fromLater.updated).toEqual([expect.objectContaining({ id: hello.id, reactions: expect.arrayContaining([{ emoji: "👍🏽", count: 1, mine: false }]) })]);

    const undone = await call("DELETE", `/social/chats/${chat.id}/messages/${hello.id}/reaction`, asha);
    expect(undone.json().data.reactions).toEqual([{ emoji: "❤️", count: 1, mine: false }]);
  });

  it("replies show what they answer, even after it is unsent", async () => {
    const { asha, ravi, chat } = await pair("Reply");
    const question = (await say(asha, chat.id, "Coffee at 5?")).json().data;
    const answer = await call("POST", `/social/chats/${chat.id}/messages`, ravi, { text: "Yes!", replyToId: question.id });
    expect(answer.statusCode).toBe(201);
    expect(answer.json().data.replyTo).toEqual({ id: question.id, available: true, sender: asha.name, mine: false, kind: "text", text: "Coffee at 5?" });

    const mineView = (await call("GET", `/social/chats/${chat.id}/messages`, asha)).json().data[0];
    expect(mineView.replyTo).toMatchObject({ sender: "You", mine: true });

    await call("DELETE", `/social/chats/${chat.id}/messages/${question.id}`, asha);
    const after = (await call("GET", `/social/chats/${chat.id}/messages`, ravi)).json().data[0];
    expect(after.replyTo).toMatchObject({ id: question.id, available: false, text: "" });

    const other = await pair("Reply Other");
    const elsewhere = (await say(other.asha, other.chat.id, "Not yours")).json().data;
    expect((await call("POST", `/social/chats/${chat.id}/messages`, ravi, { text: "Hm", replyToId: elsewhere.id })).statusCode).toBe(400);
  });

  it("sends voice messages that play from a private link in pieces", async () => {
    const { asha, ravi, chat } = await pair("Voice");
    const upload = (body: Buffer, query: string, type = "audio/mp4") =>
      stack.app.inject({
        method: "POST",
        url: `/v1/social/chats/${chat.id}/voice?${query}`,
        headers: { ...web(ravi.token, { "idempotency-key": randomUUID() }), "content-type": type },
        payload: body,
      });

    expect((await upload(Buffer.from("not audio at all"), "durationMs=1200")).statusCode).toBe(400);
    expect((await upload(fakeM4a(), "durationMs=100")).statusCode).toBe(400);
    const sent = await upload(fakeM4a(), "durationMs=4200&levels=10,80,35");
    expect(sent.statusCode, sent.body).toBe(201);
    const voice = sent.json().data;
    expect(voice).toMatchObject({ kind: "voice", text: "", voice: { durationMs: 4200, levels: [10, 80, 35] } });
    expect((await list(asha))[0]!.last!.text).toBe("Sent a voice message");

    const link = new URL(voice.voice.url);
    const whole = await stack.app.inject({ method: "GET", url: `${link.pathname}${link.search}` });
    expect(whole.statusCode).toBe(200);
    expect(whole.headers).toMatchObject({ "content-type": "audio/mp4", "accept-ranges": "bytes" });
    expect(whole.rawPayload.length).toBe(fakeM4a().length);
    const piece = await stack.app.inject({ method: "GET", url: `${link.pathname}${link.search}`, headers: { range: "bytes=0-1" } });
    expect(piece.statusCode).toBe(206);
    expect(piece.headers["content-range"]).toBe(`bytes 0-1/${fakeM4a().length}`);
    expect(piece.rawPayload.length).toBe(2);
    expect((await stack.app.inject({ method: "GET", url: `${link.pathname}${link.search}`, headers: { range: "bytes=99999-" } })).statusCode).toBe(416);
    // A photo link's signature doesn't open a voice message.
    expect((await stack.app.inject({ method: "GET", url: `/chat-photos/${voice.id}${link.search}` })).statusCode).toBe(401);

    const before = stack.chatPhotos.size;
    await call("DELETE", `/social/chats/${chat.id}/messages/${voice.id}`, ravi);
    expect(stack.chatPhotos.size).toBe(before - 1);
  });

  it("shows when the other person was last active, but not before they accept", async () => {
    const { asha, ravi, chat } = await pair("Active");
    await call("GET", "/social/chats/unread", asha);
    const detail = (await call("GET", `/social/chats/${chat.id}`, ravi)).json().data;
    expect(Date.now() - Date.parse(detail.activeAt)).toBeLessThan(60_000);

    const stranger = await person("Kiran Active");
    const request = await dm(stranger, asha);
    await say(stranger, request.id, "Hi");
    expect((await call("GET", `/social/chats/${request.id}`, stranger)).json().data.activeAt).toBeNull();
  });

  it("hides activity both ways while either person has activity status off", async () => {
    const { asha, ravi, chat } = await pair("Hidden");
    await call("GET", "/social/chats/unread", asha);
    await call("GET", "/social/chats/unread", ravi);

    const off = await call("PATCH", "/account/me", asha, { showActivity: false });
    expect(off.statusCode).toBe(200);
    expect(off.json().data.showActivity).toBe(false);
    await call("GET", "/social/chats/unread", asha);
    expect((await call("GET", `/social/chats/${chat.id}`, ravi)).json().data.activeAt).toBeNull();
    expect((await call("GET", `/social/chats/${chat.id}`, asha)).json().data.activeAt).toBeNull();

    expect((await call("PATCH", "/account/me", asha, { showActivity: true })).json().data.showActivity).toBe(true);
    await call("GET", "/social/chats/unread", asha);
    expect((await call("GET", `/social/chats/${chat.id}`, asha)).json().data.activeAt).not.toBeNull();
    expect((await call("GET", `/social/chats/${chat.id}`, ravi)).json().data.activeAt).not.toBeNull();
  });
});

describe("account deletion", () => {
  it("erases the person's 1:1 chats and their group messages", async () => {
    const asha = await person("Asha Erase");
    const ravi = await person("Ravi Erase");
    await follow(asha, ravi);
    await follow(ravi, asha);
    const chat = await dm(ravi, asha);
    await say(ravi, chat.id, "Bye");
    const group = (await call("POST", "/social/chats/groups", asha, { title: "Pair", userIds: [ravi.id] })).json().data;
    await say(ravi, group.id, "From Ravi");
    await say(asha, group.id, "From Asha");

    await eraseChats(stack.app, stack.db, ravi.userId);
    expect(await list(asha)).toEqual([expect.objectContaining({ id: group.id, last: expect.objectContaining({ text: "From Asha" }) })]);
    const texts = (await call("GET", `/social/chats/${group.id}/messages`, asha)).json().data.map((m: { text: string }) => m.text);
    expect(texts).not.toContain("From Ravi");
    expect((await call("GET", `/social/chats/${group.id}`, asha)).json().data.members).toBe(1);
  });
});
