import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { score } from "../src/modules/social/feed.js";
import { stamp, type UserRoles } from "../src/platform/db.js";
import { signIn, startStack, web, type Stack } from "./helpers.js";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
}, 120_000);
afterAll(async () => {
  await stack?.stop();
});

let seq = 0;
async function person(name: string, roles: UserRoles = {}) {
  const who = await signIn(stack, roles);
  const username = `${name.split(" ")[0]!.toLowerCase()}.${Date.now().toString(36)}${seq++}`;
  await stack.db.users.updateOne({ _id: who.userId }, { $set: { name, username } });
  return { ...who, name, username, id: who.userId.toHexString() };
}
type Person = Awaited<ReturnType<typeof person>>;

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, who?: Person | { token: string }, payload?: object) =>
  stack.app.inject({ method, url: `/v1${url}`, headers: web(who?.token, { "idempotency-key": randomUUID() }), ...(payload ? { payload } : {}) });

const makePost = async (who: Person, body: object) => {
  const res = await call("POST", "/social/posts", who, body);
  expect(res.statusCode).toBe(201);
  return res.json().data as { id: string; business: { id: string; name: string; orderable: boolean } | null };
};

const texts = (res: { json: () => { data: { text: string }[] } }) => res.json().data.map((p) => p.text);
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function shop(owner: Person, name: string, status: "draft" | "live" = "live") {
  const _id = new ObjectId();
  await stack.db.businesses.insertOne({
    _id,
    ownerId: owner.userId,
    module: "pod",
    type: "print_shop" as never,
    name,
    description: null,
    phone: null,
    location: null,
    pod: null,
    gstin: null,
    photos: [],
    status,
    open: true,
    publishedAt: status === "live" ? new Date() : null,
    ...stamp(),
  });
  return _id.toHexString();
}

describe("follows", () => {
  it("follows once, counts both sides, lists them, and tells the person once", async () => {
    const asha = await person("Asha Follow");
    const ravi = await person("Ravi Follow");

    for (let i = 0; i < 2; i++) {
      const res = await call("PUT", `/social/users/${asha.id}/follow`, ravi);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ following: true, followsMe: false, blockedByMe: false, counts: { followers: 1, following: 0 } });
    }
    expect((await call("GET", `/social/users/${ravi.username}/relation`, asha)).json().data).toMatchObject({ following: false, followsMe: true });
    expect((await call("GET", `/account/profiles/${asha.username}`)).json().data.stats).toMatchObject({ followers: 1, following: 0 });
    expect((await call("GET", `/account/profiles/${ravi.username}`)).json().data.stats).toMatchObject({ followers: 0, following: 1 });

    const followers = (await call("GET", `/social/users/${asha.username}/followers`, asha)).json().data;
    expect(followers).toEqual([expect.objectContaining({ username: ravi.username, followedByMe: false, me: false })]);
    const following = (await call("GET", `/social/users/${ravi.username}/following`, ravi)).json().data;
    expect(following).toEqual([expect.objectContaining({ username: asha.username, me: false })]);

    await call("DELETE", `/social/users/${asha.id}/follow`, ravi);
    expect((await call("DELETE", `/social/users/${asha.id}/follow`, ravi)).json().data.counts.followers).toBe(0);
    await call("PUT", `/social/users/${asha.id}/follow`, ravi);
    await settle();
    const inbox = (await call("GET", "/notifications", asha)).json().data;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ type: "user.followed", body: "Ravi Follow started following you.", link: { screen: "profile", id: ravi.id } });

    expect((await call("PUT", `/social/users/${ravi.id}/follow`, ravi)).statusCode).toBe(400);
    expect((await call("PUT", `/social/users/${asha.id}/follow`)).statusCode).toBe(401);
  });
});

describe("blocks", () => {
  it("ends follows both ways and hides each from the other until unblocked", async () => {
    const meera = await person("Meera Block");
    const kiran = await person("Kiran Block");
    await call("PUT", `/social/users/${meera.id}/follow`, kiran);
    await call("PUT", `/social/users/${kiran.id}/follow`, meera);
    const post = await makePost(meera, { text: "Meera's quiet post" });
    await makePost(kiran, { text: "Kiran's quiet post" });

    const blocked = (await call("PUT", `/social/users/${kiran.id}/block`, meera)).json().data;
    expect(blocked).toEqual({ following: false, followsMe: false, blockedByMe: true, counts: { followers: 0, following: 0 } });
    expect((await call("PUT", `/social/users/${kiran.id}/block`, meera)).statusCode).toBe(200);
    expect((await call("GET", `/account/profiles/${meera.username}`)).json().data.stats).toMatchObject({ followers: 0, following: 0 });

    // Kiran was blocked: Meera's profile, posts and comments are gone for him.
    expect((await call("GET", `/account/profiles/${meera.username}`, kiran)).statusCode).toBe(404);
    expect((await call("GET", `/social/users/${meera.username}/posts`, kiran)).statusCode).toBe(404);
    expect((await call("GET", `/social/posts/${post.id}`, kiran)).statusCode).toBe(404);
    expect((await call("PUT", `/social/posts/${post.id}/like`, kiran)).statusCode).toBe(403);
    expect((await call("POST", `/social/posts/${post.id}/comments`, kiran, { text: "Hi" })).statusCode).toBe(403);
    expect((await call("PUT", `/social/users/${meera.id}/follow`, kiran)).statusCode).toBe(403);
    expect((await call("GET", `/account/profiles/${meera.username}`)).statusCode).toBe(200);
    // Meera still finds his profile, so she can unblock him, but not his posts.
    expect((await call("GET", `/account/profiles/${kiran.username}`, meera)).statusCode).toBe(200);
    expect((await call("GET", `/social/users/${kiran.username}/posts`, meera)).json().data).toEqual([]);
    expect(texts(await call("GET", "/social/feed?limit=50", meera))).not.toContain("Kiran's quiet post");
    expect(texts(await call("GET", "/social/feed?limit=50", kiran))).not.toContain("Meera's quiet post");
    const search = (await call("GET", "/account/profiles?q=Block", kiran)).json().data;
    expect(search.map((p: { username: string }) => p.username)).not.toContain(meera.username);

    const list = (await call("GET", "/social/blocks", meera)).json().data;
    expect(list).toEqual([expect.objectContaining({ username: kiran.username })]);

    expect((await call("DELETE", `/social/users/${kiran.id}/block`, meera)).json().data).toMatchObject({ blockedByMe: false, following: false });
    expect((await call("GET", `/social/posts/${post.id}`, kiran)).statusCode).toBe(200);
    expect((await call("GET", "/social/blocks", meera)).json().data).toEqual([]);
  });
});

describe("feed tabs", () => {
  it("ranks For you by likes and comments, boosts followed people, and Following is newest first", () => {
    const now = Date.now();
    const at = (hoursAgo: number, likes = 0, comments = 0) => ({ createdAt: new Date(now - hoursAgo * 3_600_000), counts: { likes, comments } });
    expect(score(at(1, 10), now, false)).toBeGreaterThan(score(at(1), now, false));
    expect(score(at(1, 0, 5), now, false)).toBeGreaterThan(score(at(1, 5), now, false));
    expect(score(at(1), now, false)).toBeGreaterThan(score(at(24), now, false));
    expect(score(at(1), now, true)).toBe(2 * score(at(1), now, false));
  });

  it("shows only followed people and you on Following, and pages For you into older posts", async () => {
    const reader = await person("Feed Reader");
    const followed = await person("Feed Followed");
    const stranger = await person("Feed Stranger");
    await call("PUT", `/social/users/${followed.id}/follow`, reader);
    await makePost(stranger, { text: "Stranger news" });
    await makePost(followed, { text: "Followed news" });
    await makePost(reader, { text: "My news" });

    const following = await call("GET", "/social/feed?tab=following", reader);
    expect(texts(following)).toEqual(["My news", "Followed news"]);

    const old = await stack.db.posts.insertOne({
      _id: new ObjectId(),
      authorId: stranger.userId,
      kind: "personal",
      text: "From last month",
      media: [],
      counts: { likes: 0, comments: 0 },
      status: "live",
      createdAt: new Date(Date.now() - 30 * 86_400_000),
      updatedAt: new Date(),
    } as never);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const res = await call("GET", `/social/feed?limit=5${cursor ? `&cursor=${cursor}` : ""}`, reader);
      expect(res.statusCode).toBe(200);
      seen.push(...res.json().data.map((p: { id: string }) => p.id));
      cursor = res.json().meta.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.at(-1)).toBe(old.insertedId.toHexString());
    expect((await call("GET", "/social/feed?cursor=nope", reader)).statusCode).toBe(400);
  });
});

describe("business posts", () => {
  it("links the business, asks which one when there are several, and is orderable only from a live print shop", async () => {
    const vendor = await person("Print Vendor", { vendor: true });
    const live = await shop(vendor, "Sharp Prints");
    const first = await makePost(vendor, { text: "Posters this week", kind: "business" });
    expect(first.business).toEqual({ id: live, name: "Sharp Prints", module: "pod", orderable: false });

    await stack.db.moduleSettings.updateOne({ module: "pod" }, { $set: { live: true } });
    expect((await call("GET", `/social/posts/${first.id}`)).json().data.business.orderable).toBe(true);

    const draft = await shop(vendor, "Second Shop", "draft");
    expect((await call("POST", "/social/posts", vendor, { text: "Which one?", kind: "business" })).statusCode).toBe(400);
    const picked = await makePost(vendor, { text: "Coming soon", kind: "business", businessId: draft });
    expect(picked.business).toMatchObject({ id: draft, orderable: false });

    const other = await person("Other Vendor", { vendor: true });
    const theirs = await shop(other, "Not Yours");
    expect((await call("POST", "/social/posts", vendor, { text: "Borrowed", kind: "business", businessId: theirs })).statusCode).toBe(400);
    expect((await makePost(vendor, { text: "Just me" })).business).toBeNull();
  });
});

describe("reporting people", () => {
  it("keeps one open report per reporter, groups them for the Ruxstar team, and closes them on dismiss or hold", async () => {
    const admin = await signIn(stack, { admin: true });
    const target = await person("Scam Account");
    const reporters = await Promise.all([person("Reporter One"), person("Reporter Two")]);
    for (let i = 0; i < 2; i++) expect((await call("POST", `/social/users/${target.id}/report`, reporters[0], { reason: "scam", note: "Asked for money" })).statusCode).toBe(200);
    await call("POST", `/social/users/${target.id}/report`, reporters[1], { reason: "fake" });
    expect((await call("POST", `/social/users/${target.id}/report`, reporters[1], { reason: "rude" })).statusCode).toBe(400);
    expect((await call("POST", `/social/users/${target.id}/report`, target, { reason: "spam" })).statusCode).toBe(400);

    const open = (await call("GET", "/ruxstar/reports/people", admin)).json().data;
    const row = open.find((c: { userId: string }) => c.userId === target.id);
    expect(row).toMatchObject({ status: "open", reports: 2, reasons: { scam: 1, fake: 1 }, notes: ["Asked for money"], user: { username: target.username } });
    expect((await call("GET", "/ruxstar/overview", admin)).json().data.reports.people).toBeGreaterThanOrEqual(1);
    expect((await call("GET", "/ruxstar/reports/people", reporters[0])).statusCode).toBe(403);

    const dismissed = (await call("POST", `/ruxstar/reports/people/${target.id}/dismiss`, admin)).json().data;
    expect(dismissed).toMatchObject({ status: "closed", outcome: "dismissed", reports: 2 });
    expect((await call("POST", `/ruxstar/reports/people/${target.id}/dismiss`, admin)).statusCode).toBe(409);

    await call("POST", `/social/users/${target.id}/report`, reporters[0], { reason: "abuse" });
    expect((await call("POST", `/ruxstar/users/${target.id}/suspend`, admin, { reason: "Scamming buyers" })).statusCode).toBe(200);
    expect(await stack.db.userReports.countDocuments({ userId: target.userId, status: "open" })).toBe(0);
    expect(await stack.db.userReports.countDocuments({ userId: target.userId, outcome: "held" })).toBe(1);
  });
});
