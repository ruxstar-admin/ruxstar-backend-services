import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRoles } from "../src/platform/db.js";
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

const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, who?: Person, payload?: object) =>
  stack.app.inject({ method, url: `/v1${url}`, headers: web(who?.token), ...(payload ? { payload } : {}) });

const jpeg = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: "#32b2fa" } })
    .withExif({ IFD0: { Make: "TestCam" } })
    .jpeg()
    .toBuffer();

const upload = async (who: Person, width = 1200, height = 900) =>
  stack.app.inject({
    method: "POST",
    url: "/v1/social/media",
    headers: { ...web(who.token), "content-type": "image/jpeg" },
    payload: await jpeg(width, height),
  });

const makePost = async (who: Person, body: object) => {
  const res = await call("POST", "/social/posts", who, body);
  expect(res.statusCode).toBe(201);
  return res.json().data as { id: string; media: { url: string; width: number; height: number }[] };
};

describe("posts", () => {
  it("posts text and photos, shrinks and strips the photos, and refuses empty or borrowed ones", async () => {
    const asha = await person("Asha Rao");
    const ravi = await person("Ravi Kumar");

    const first = await upload(asha, 3000, 2000);
    expect(first.statusCode).toBe(201);
    const photo = first.json().data;
    expect(photo).toMatchObject({ width: 1440, height: 960 });
    const key = (photo.url as string).replace("https://media.test/", "");
    expect(key).toMatch(new RegExp(`^post-media/dev/${asha.id}/[\\w-]+\\.webp$`));
    const meta = await sharp(stack.media.get(key)!).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 1440, height: 960 });
    expect(meta.exif).toBeUndefined();

    const tall = (await upload(asha, 600, 2000)).json().data;
    expect(tall.width / tall.height).toBeCloseTo(0.8, 2);

    const post = await makePost(asha, { text: "  First batch of mugs.\n\n\n\nGlazed today.  ", mediaIds: [photo.id, tall.id] });
    expect(post).toMatchObject({ text: "First batch of mugs.\n\nGlazed today.", kind: "personal", mine: true, likedByMe: false });
    expect(post.media.map((m) => m.url)).toEqual([photo.url, tall.url]);

    expect((await call("POST", "/social/posts", asha, { text: "again", mediaIds: [photo.id] })).json().error.code).toBe("VALIDATION_FAILED");
    const ravisPhoto = (await upload(ravi)).json().data;
    expect((await call("POST", "/social/posts", asha, { text: "mine?", mediaIds: [ravisPhoto.id] })).statusCode).toBe(400);
    expect((await call("POST", "/social/posts", asha, { text: "   " })).statusCode).toBe(400);
    expect((await call("POST", "/social/posts", undefined, { text: "hi" })).statusCode).toBe(401);
    expect((await call("POST", "/social/posts", asha, { text: "x".repeat(501) })).statusCode).toBe(400);
    expect((await upload(asha, 100, 100)).json().error.code).toBe("PHOTO_INVALID");
  });

  it("lets only vendors post to their business tab, and shows each tab to anyone", async () => {
    const shop = await person("Meera Prints", { vendor: true });
    const fan = await person("Kiran Patel");
    expect((await call("POST", "/social/posts", fan, { text: "My shop", kind: "business" })).statusCode).toBe(403);
    await makePost(shop, { text: "Weekend offer on posters", kind: "business" });
    await makePost(shop, { text: "Off to the hills" });

    const business = await call("GET", `/social/users/${shop.username}/posts?kind=business`);
    expect(business.statusCode).toBe(200);
    expect(business.headers["cache-control"]).toBe("public, max-age=30");
    expect(business.json().data.map((p: { text: string }) => p.text)).toEqual(["Weekend offer on posters"]);
    expect(business.json().data[0].author).toMatchObject({ name: "Meera Prints", username: shop.username, vendor: true });
    const personal = await call("GET", `/social/users/${shop.id}/posts`, fan);
    expect(personal.json().data.map((p: { text: string }) => p.text)).toEqual(["Off to the hills"]);
    expect(personal.headers["cache-control"]).toBe("private, no-store");
    expect(personal.headers.vary).toContain("Cookie");
    expect((await call("GET", "/social/users/no.such.person/posts")).statusCode).toBe(404);
  });

  it("pages the feed newest first and needs sign-in", async () => {
    const writer = await person("Arjun Rao");
    for (let i = 1; i <= 5; i++) await makePost(writer, { text: `Feed post ${i}` });
    expect((await call("GET", "/social/feed")).statusCode).toBe(401);
    const first = (await call("GET", "/social/feed?limit=3", writer)).json();
    expect(first.data.map((p: { text: string }) => p.text)).toEqual(["Feed post 5", "Feed post 4", "Feed post 3"]);
    expect(first.meta.nextCursor).toEqual(expect.any(String));
    const second = (await call("GET", `/social/feed?limit=3&cursor=${first.meta.nextCursor}`, writer)).json();
    expect(second.data[0].text).toBe("Feed post 2");
  });

  it("edits and deletes only your own posts, and deleting removes its photos, comments and counts", async () => {
    const owner = await person("Sana Sheikh");
    const other = await person("Rahul Verma");
    const photo = (await upload(owner)).json().data;
    const post = await makePost(owner, { text: "Draft", mediaIds: [photo.id] });
    expect((await call("PATCH", `/social/posts/${post.id}`, other, { text: "Hacked" })).statusCode).toBe(403);
    const edited = (await call("PATCH", `/social/posts/${post.id}`, owner, { text: "Final words" })).json().data;
    expect(edited.text).toBe("Final words");
    expect(edited.editedAt).toEqual(expect.any(String));

    await call("PUT", `/social/posts/${post.id}/like`, other);
    await call("POST", `/social/posts/${post.id}/comments`, other, { text: "Nice" });
    expect((await call("GET", `/account/profiles/${owner.username}`)).json().data.stats).toEqual({ posts: 1, engagements: 2 });

    expect((await call("DELETE", `/social/posts/${post.id}`, other)).statusCode).toBe(403);
    expect((await call("DELETE", `/social/posts/${post.id}`, owner)).json().data.done).toBe(true);
    expect(stack.media.has(photo.url.replace("https://media.test/", ""))).toBe(false);
    expect((await call("GET", `/social/posts/${post.id}`)).json().error.code).toBe("NOT_FOUND");
    expect((await call("GET", `/account/profiles/${owner.username}`)).json().data.stats).toEqual({ posts: 0, engagements: 0 });
  });

  it("hides the posts of a deleted account", async () => {
    const leaving = await person("Gone Soon");
    const post = await makePost(leaving, { text: "Bye" });
    await stack.db.users.updateOne({ _id: leaving.userId }, { $set: { status: "deleted" } });
    expect((await call("GET", `/social/posts/${post.id}`)).statusCode).toBe(404);
  });
});

describe("likes, saves, comments and reports", () => {
  it("counts a like once however often it is sent, and tells the author once", async () => {
    const author = await person("Priya Nair");
    const fan = await person("Dev Shah");
    const post = await makePost(author, { text: "Clay day" });

    for (let i = 0; i < 2; i++) expect((await call("PUT", `/social/posts/${post.id}/like`, fan)).json().data).toEqual({ likes: 1, likedByMe: true });
    expect((await call("GET", `/social/posts/${post.id}`, fan)).json().data).toMatchObject({ likedByMe: true, counts: { likes: 1 } });
    expect((await call("GET", `/social/posts/${post.id}`)).json().data.likedByMe).toBe(false);
    expect((await call("DELETE", `/social/posts/${post.id}/like`, fan)).json().data).toEqual({ likes: 0, likedByMe: false });
    expect((await call("DELETE", `/social/posts/${post.id}/like`, fan)).json().data).toEqual({ likes: 0, likedByMe: false });
    await call("PUT", `/social/posts/${post.id}/like`, fan);
    await call("PUT", `/social/posts/${post.id}/like`, author);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const inbox = (await call("GET", "/notifications", author)).json().data;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ type: "post.like", body: "Dev Shah liked your post.", read: false, link: { screen: "post", id: post.id } });
  });

  it("keeps a saved list, most recently saved first", async () => {
    const author = await person("Nisha Iyer");
    const reader = await person("Om Prakash");
    const a = await makePost(author, { text: "Save me first" });
    const b = await makePost(author, { text: "Save me second" });
    expect((await call("PUT", `/social/posts/${a.id}/save`, reader)).json().data).toEqual({ savedByMe: true });
    await call("PUT", `/social/posts/${b.id}/save`, reader);
    const saved = (await call("GET", "/social/saved", reader)).json().data;
    expect(saved.map((p: { id: string; savedByMe: boolean }) => [p.id, p.savedByMe])).toEqual([[b.id, true], [a.id, true]]);
    await call("DELETE", `/social/posts/${b.id}/save`, reader);
    expect((await call("GET", "/social/saved", reader)).json().data.map((p: { id: string }) => p.id)).toEqual([a.id]);
  });

  it("adds, lists and deletes comments, and notifies the author", async () => {
    const author = await person("Tara Menon");
    const guest = await person("Vik Rao");
    const post = await makePost(author, { text: "Ask me anything" });
    const added = await call("POST", `/social/posts/${post.id}/comments`, guest, { text: "  How long did it take?  " });
    expect(added.statusCode).toBe(201);
    const comment = added.json().data;
    expect(comment).toMatchObject({ text: "How long did it take?", mine: true, author: { name: "Vik Rao" } });
    await call("POST", `/social/posts/${post.id}/comments`, author, { text: "Two weeks" });
    expect((await call("POST", `/social/posts/${post.id}/comments`, guest, { text: "   " })).statusCode).toBe(400);

    const list = (await call("GET", `/social/posts/${post.id}/comments`)).json().data;
    expect(list.map((c: { text: string }) => c.text)).toEqual(["Two weeks", "How long did it take?"]);
    expect((await call("GET", `/social/posts/${post.id}`)).json().data.counts.comments).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const inbox = (await call("GET", "/notifications", author)).json().data;
    expect(inbox.map((n: { body: string }) => n.body)).toEqual(["Vik Rao: How long did it take?"]);

    const stranger = await person("Other Person");
    expect((await call("DELETE", `/social/comments/${comment.id}`, stranger)).statusCode).toBe(403);
    expect((await call("DELETE", `/social/comments/${comment.id}`, author)).json().data.done).toBe(true);
    expect((await call("GET", `/social/posts/${post.id}`)).json().data.counts.comments).toBe(1);
  });

  it("files one report per person per post", async () => {
    const author = await person("Spammy Seller");
    const reporter = await person("Careful User");
    const post = await makePost(author, { text: "Buy now" });
    for (let i = 0; i < 2; i++) expect((await call("POST", `/social/posts/${post.id}/report`, reporter, { reason: "spam" })).statusCode).toBe(200);
    expect(await stack.db.reports.countDocuments({ "target.id": { $exists: true }, userId: reporter.userId })).toBe(1);
    expect((await call("POST", `/social/posts/${post.id}/report`, reporter, { reason: "rude" })).statusCode).toBe(400);
  });
});

describe("notifications", () => {
  it("counts unread ones and marks one or all read", async () => {
    const author = await person("Busy Creator");
    const fans = await Promise.all([person("Fan One"), person("Fan Two")]);
    const post = await makePost(author, { text: "Hello" });
    for (const fan of fans) await call("PUT", `/social/posts/${post.id}/like`, fan);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect((await call("GET", "/notifications/unread-count", author)).json().data.count).toBe(2);
    const [newest] = (await call("GET", "/notifications", author)).json().data;
    await call("POST", "/notifications/read", author, { id: newest.id });
    expect((await call("GET", "/notifications/unread-count", author)).json().data.count).toBe(1);
    await call("POST", "/notifications/read", author, {});
    expect((await call("GET", "/notifications/unread-count", author)).json().data.count).toBe(0);
    expect((await call("GET", "/notifications", fans[0])).json().data).toEqual([]);
  });
});
