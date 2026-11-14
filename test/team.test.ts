import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stamp } from "../src/platform/db.js";
import { forgetModuleState } from "../src/platform/module-switch.js";
import { endPlacesFor, teamAccess } from "../src/modules/team/team.js";
import { signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>>;
const DAY = 24 * 60 * 60_000;

describe("vendor team", () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack?.stop());
  beforeEach(async () => {
    await Promise.all([
      stack.db.businesses.deleteMany({}),
      stack.db.employments.deleteMany({}),
      stack.db.notifications.deleteMany({}),
      stack.db.blocks.deleteMany({}),
      stack.db.auditLogs.deleteMany({}),
    ]);
    await stack.db.moduleSettings.updateOne({ module: "pod" }, { $set: { live: true, signupsOpen: true } });
    forgetModuleState();
  });

  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, token: string, payload?: object) =>
    stack.app.inject({
      method,
      url: `/v1${url}`,
      headers: web(token, method === "GET" || method === "DELETE" ? {} : { "idempotency-key": randomUUID() }),
      ...(payload ? { payload } : {}),
    });

  let n = 0;
  async function person(opts: { verified?: boolean; vendor?: boolean; name?: string } = {}) {
    const user = await signIn(stack, opts.vendor ? { vendor: true } : {});
    const username = `member${Date.now() % 1e6}${n++}`;
    await stack.db.users.updateOne(
      { _id: user.userId },
      { $set: { name: opts.name ?? "Kiran Das", username, ...(opts.verified ? { "kyc.base": "approved" } : {}) } },
    );
    return { ...user, username };
  }

  async function shop(owner: User, module: "pod" | "food" = "pod") {
    const now = new Date();
    const _id = new ObjectId();
    await stack.db.businesses.insertOne({
      _id,
      ownerId: owner.userId,
      module,
      type: module === "pod" ? "print_shop" : "restaurant",
      name: "Rao Prints",
      phone: "9876543210",
      location: { state: "Telangana", city: "Hyderabad", doorNo: "4-1", street: "Main Road", area: "Madhapur", pincode: "500081" },
      photos: [],
      status: "live",
      open: true,
      ...stamp(now),
    } as never);
    return _id.toHexString();
  }

  async function staff(permissions: string[]) {
    const user = await signIn(stack, { ruxstarStaff: true });
    await stack.db.ruxstarStaff.insertOne({ _id: new ObjectId(), userId: user.userId, title: "Ops", modules: [], permissions, grantedBy: user.userId, status: "active", ...stamp() });
    return user;
  }

  const notes = (user: User) => stack.db.notifications.find({ userId: user.userId }).sort({ createdAt: 1 }).toArray();

  it("invites by username, adds what a permission needs, and lets the person accept", async () => {
    const owner = await person({ vendor: true, verified: true, name: "Asha Rao" });
    const kiran = await person({ verified: true });
    const id = await shop(owner);

    const invited = await call("POST", `/vendor/businesses/${id}/team`, owner.token, { username: `@${kiran.username.toUpperCase()}`, permissions: ["orders.move", "shop.open"] });
    expect(invited.statusCode).toBe(201);
    const member = invited.json().data;
    expect(member).toMatchObject({
      person: { id: kiran.userId.toHexString(), name: "Kiran Das", username: kiran.username },
      status: "invited",
      permissions: ["orders.view", "orders.move", "shop.open"],
      joinedAt: null,
    });
    expect(new Date(member.expiresAt).getTime() - new Date(member.invitedAt).getTime()).toBe(7 * DAY);

    const [invite] = await notes(kiran);
    expect(invite).toMatchObject({ type: "team.invited", body: "Asha Rao invited you to work at Rao Prints.", link: { screen: "work", id: member.id } });

    const again = await call("POST", `/vendor/businesses/${id}/team`, owner.token, { username: kiran.username, permissions: ["shop.open"] });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe("Kiran Das already has an invite.");

    const work = (await call("GET", "/employment", kiran.token)).json().data;
    expect(work.places).toEqual([]);
    expect(work.invites).toMatchObject([{ id: member.id, business: { id, name: "Rao Prints", city: "Hyderabad" }, owner: { name: "Asha Rao" } }]);
    expect(work.permissions).toHaveLength(11);

    const accepted = await call("POST", `/employment/${member.id}/accept`, kiran.token);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data).toMatchObject({ id: member.id, access: "on", permissions: ["orders.view", "orders.move", "shop.open"] });
    expect((await call("POST", `/employment/${member.id}/accept`, kiran.token)).statusCode).toBe(409);

    const team = (await call("GET", `/vendor/businesses/${id}/team`, owner.token)).json().data;
    expect(team.max).toBe(20);
    expect(team.members).toMatchObject([{ id: member.id, status: "active", expiresAt: null }]);
    expect((await notes(owner)).map((x) => [x.type, x.body])).toEqual([["team.joined", "Kiran Das joined Rao Prints's team."]]);

    const changed = await call("PATCH", `/vendor/businesses/${id}/team/${member.id}`, owner.token, { permissions: ["earnings.view"] });
    expect(changed.json().data.permissions).toEqual(["orders.view", "earnings.view"]);

    const actions = (await stack.db.auditLogs.find({ "scope.businessId": new ObjectId(id) }).sort({ createdAt: 1 }).toArray()).map((a) => a.action);
    expect(actions).toEqual(["team.invite", "team.join", "team.update"]);
  });

  it("shows the pay on offer, lets the owner change it until they accept, then keeps it", async () => {
    const owner = await person({ vendor: true, verified: true });
    const kiran = await person({ verified: true });
    const id = await shop(owner);
    const invite = (pay: unknown) => call("POST", `/vendor/businesses/${id}/team`, owner.token, { username: kiran.username, permissions: ["orders.view"], pay });

    expect((await invite({ amount: 50, per: "month", note: null })).statusCode).toBe(400);
    expect((await invite({ amount: 1_500_000, per: "year", note: null })).statusCode).toBe(400);
    const member = (await invite({ amount: 1_500_000, per: "month", note: "  Plus petrol allowance " })).json().data;
    expect(member.pay).toEqual({ amount: 1_500_000, per: "month", note: "Plus petrol allowance" });

    const offer = async () => (await call("GET", "/employment", kiran.token)).json().data.invites[0].pay;
    expect(await offer()).toEqual(member.pay);

    const patch = (body: object) => call("PATCH", `/vendor/businesses/${id}/team/${member.id}`, owner.token, body);
    expect((await patch({})).statusCode).toBe(400);
    expect((await patch({ pay: { amount: 80_000, per: "day", note: null } })).json().data.pay).toEqual({ amount: 80_000, per: "day", note: null });
    expect(await offer()).toEqual({ amount: 80_000, per: "day", note: null });

    await call("POST", `/employment/${member.id}/accept`, kiran.token);
    const place = (await call("GET", "/employment", kiran.token)).json().data.places[0];
    expect(place.pay).toEqual({ amount: 80_000, per: "day", note: null });
    const locked = await patch({ pay: null });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.details[0].path).toBe("body/pay");
    expect((await patch({ permissions: ["shop.open"] })).json().data).toMatchObject({ permissions: ["shop.open"], pay: { amount: 80_000 } });

    const lines = (await call("GET", `/vendor/businesses/${id}/activity`, owner.token)).json().data.map((e: { line: string }) => e.line);
    expect(lines).toEqual(expect.arrayContaining(["Changed the pay offered to Kiran Das", "Changed what Kiran Das can do"]));

    const stranger = await person({ verified: true });
    const none = (await call("POST", `/vendor/businesses/${id}/team`, owner.token, { username: stranger.username, permissions: ["orders.view"] })).json().data;
    expect(none.pay).toBeNull();
  });

  it("refuses unknown people, the owner, blocked people, other people's shops and food places", async () => {
    const owner = await person({ vendor: true, verified: true });
    const other = await person({ vendor: true, verified: true });
    const blocked = await person();
    const id = await shop(owner);
    await stack.db.blocks.insertOne({ blockerId: blocked.userId, blockedId: owner.userId, createdAt: new Date() });

    const invite = (username: string, token = owner.token, business = id) =>
      call("POST", `/vendor/businesses/${business}/team`, token, { username, permissions: ["orders.view"] });
    expect((await invite("nobody_here")).statusCode).toBe(404);
    expect((await invite(owner.username)).statusCode).toBe(409);
    expect((await invite(blocked.username)).statusCode).toBe(403);
    expect((await invite(blocked.username, other.token)).statusCode).toBe(404);
    expect((await call("GET", `/vendor/businesses/${id}/team`, other.token)).statusCode).toBe(404);
    const someone = await person();
    expect((await call("GET", `/vendor/businesses/${id}/team`, someone.token)).statusCode).toBe(403);

    const food = await shop(owner, "food");
    const res = await invite(blocked.username, owner.token, food);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe("Teams are for print shops for now.");

    await stack.db.businesses.updateOne({ _id: new ObjectId(id) }, { $set: { suspension: { at: new Date(), reason: "Checks", by: owner.userId } } as never });
    const fine = await person();
    expect((await invite(fine.username)).json().error.code).toBe("BUSINESS_SUSPENDED");
  });

  it("holds 20 places, invites included, and frees a place when an invite runs out", async () => {
    const owner = await person({ vendor: true, verified: true });
    const id = await shop(owner);
    const people = await Promise.all(Array.from({ length: 21 }, () => person()));
    for (const p of people.slice(0, 20)) {
      expect((await call("POST", `/vendor/businesses/${id}/team`, owner.token, { username: p.username, permissions: ["shop.open"] })).statusCode).toBe(201);
    }
    const full = await call("POST", `/vendor/businesses/${id}/team`, owner.token, { username: people[20]!.username, permissions: ["shop.open"] });
    expect(full.statusCode).toBe(409);
    expect(full.json().error.message).toBe("A team holds up to 20 people, invites included. Remove someone first.");

    await stack.db.employments.updateOne({ userId: people[0]!.userId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call("GET", `/vendor/businesses/${id}/team`, owner.token)).json().data.members).toHaveLength(19);
    expect((await call("POST", `/vendor/businesses/${id}/team`, owner.token, { username: people[20]!.username, permissions: ["shop.open"] })).statusCode).toBe(201);

    const late = await stack.db.employments.findOne({ userId: people[0]!.userId });
    const res = await call("POST", `/employment/${late!._id.toHexString()}/accept`, people[0]!.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe("This invite ran out. Ask the owner to invite you again.");
    expect((await stack.db.employments.findOne({ _id: late!._id }))!.status).toBe("expired");
    expect((await call("POST", `/vendor/businesses/${id}/team`, owner.token, { username: people[0]!.username, permissions: ["shop.open"] })).statusCode).toBe(409);
  }, 60_000);

  it("keeps access off until the person is verified, and checks each permission", async () => {
    const owner = await person({ vendor: true, verified: true });
    const waiting = await person();
    const id = await shop(owner);
    const member = (await call("POST", `/vendor/businesses/${id}/team`, owner.token, { username: waiting.username, permissions: ["orders.view"] })).json().data;
    expect((await call("POST", `/employment/${member.id}/accept`, waiting.token)).json().data.access).toBe("verify");
    expect((await call("GET", `/vendor/businesses/${id}/team`, owner.token)).json().data.members[0].status).toBe("waiting");

    const businessId = new ObjectId(id);
    const at = { businessId };
    await expect(teamAccess(stack.db, { userId: waiting.userId, kyc: {} }, at, "orders.view")).rejects.toMatchObject({ code: "KYC_REQUIRED" });
    const verified = { userId: waiting.userId, kyc: { base: "approved" as const } };
    await expect(teamAccess(stack.db, verified, at, "orders.view")).resolves.toMatchObject({ business: { name: "Rao Prints" } });
    await expect(teamAccess(stack.db, verified, { placeId: member.id }, "orders.view")).resolves.toMatchObject({ business: { name: "Rao Prints" } });
    await expect(teamAccess(stack.db, verified, at, "orders.refund")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(teamAccess(stack.db, { userId: owner.userId, kyc: { base: "approved" } }, at, "orders.view")).rejects.toMatchObject({ code: "NOT_FOUND" });

    await stack.db.businesses.updateOne({ _id: businessId }, { $set: { suspension: { at: new Date(), reason: "Checks", by: owner.userId } } as never });
    await expect(teamAccess(stack.db, verified, at, "orders.view")).rejects.toMatchObject({ code: "BUSINESS_SUSPENDED" });
  });

  it("lets the person decline or leave, and the owner remove or cancel, telling the right people", async () => {
    const owner = await person({ vendor: true, verified: true, name: "Asha Rao" });
    const [a, b, c, d] = await Promise.all([person({ name: "Anil" }), person({ name: "Bina" }), person({ name: "Chetan" }), person({ name: "Divya" })]);
    const id = await shop(owner);
    const invite = async (p: { username: string }) =>
      (await call("POST", `/vendor/businesses/${id}/team`, owner.token, { username: p.username, permissions: ["shop.open"] })).json().data.id as string;
    const [ia, ib, ic, idd] = [await invite(a), await invite(b), await invite(c), await invite(d)];

    expect((await call("POST", `/employment/${ia}/decline`, a.token)).statusCode).toBe(200);
    expect((await call("POST", `/employment/${ib}/accept`, b.token)).statusCode).toBe(200);
    expect((await call("POST", `/employment/${ic}/accept`, c.token)).statusCode).toBe(200);
    expect((await call("POST", `/employment/${ib}/accept`, a.token)).statusCode).toBe(404);

    expect((await call("POST", `/employment/${ib}/leave`, b.token)).statusCode).toBe(200);
    expect((await call("POST", `/employment/${ib}/leave`, b.token)).statusCode).toBe(409);
    expect((await call("DELETE", `/vendor/businesses/${id}/team/${ic}`, owner.token)).statusCode).toBe(200);
    expect((await call("DELETE", `/vendor/businesses/${id}/team/${idd}`, owner.token)).statusCode).toBe(200);
    expect((await call("DELETE", `/vendor/businesses/${id}/team/${idd}`, owner.token)).statusCode).toBe(404);

    expect((await call("GET", `/vendor/businesses/${id}/team`, owner.token)).json().data.members).toEqual([]);
    expect((await call("GET", "/employment", c.token)).json().data.places).toEqual([]);
    const status = async (memberId: string) => (await stack.db.employments.findOne({ _id: new ObjectId(memberId) }))!;
    expect(await status(ia)).toMatchObject({ status: "declined", endedBy: "member" });
    expect(await status(ib)).toMatchObject({ status: "left", endedBy: "member" });
    expect(await status(ic)).toMatchObject({ status: "removed", endedBy: "owner" });
    expect((await status(idd)).current).toBeUndefined();

    expect((await notes(owner)).map((x) => x.body)).toEqual(["Bina joined Rao Prints's team.", "Chetan joined Rao Prints's team.", "Bina left Rao Prints's team."]);
    expect((await notes(c)).map((x) => x.type)).toEqual(["team.invited", "team.ended"]);
    expect((await notes(d)).map((x) => x.type)).toEqual(["team.invited"]);

    expect((await call("POST", `/vendor/businesses/${id}/team`, owner.token, { username: b.username, permissions: ["shop.open"] })).statusCode).toBe(201);
  });

  it("shows a team in the console and lets the Ruxstar team remove someone with a reason", async () => {
    const owner = await person({ vendor: true, verified: true });
    const kiran = await person({ verified: true });
    const id = await shop(owner);
    const memberId = (await call("POST", `/vendor/businesses/${id}/team`, owner.token, { username: kiran.username, permissions: ["shop.open"] })).json().data.id;
    await call("POST", `/employment/${memberId}/accept`, kiran.token);

    const viewer = await staff(["businesses.view"]);
    const manager = await staff(["businesses.view", "businesses.manage"]);
    expect((await call("GET", `/ruxstar/businesses/${id}/team`, viewer.token)).json().data.members).toHaveLength(1);
    const remove = (token: string, reason = "Reported for misuse") => call("POST", `/ruxstar/businesses/${id}/team/${memberId}/remove`, token, { reason });
    expect((await remove(viewer.token)).statusCode).toBe(403);
    expect((await remove(manager.token, "no")).statusCode).toBe(400);
    expect((await remove(manager.token)).statusCode).toBe(200);

    expect((await stack.db.employments.findOne({ _id: new ObjectId(memberId) }))).toMatchObject({ status: "removed", endedBy: "ruxstar" });
    expect((await notes(kiran)).at(-1)!.body).toBe("The Ruxstar team removed you from Rao Prints: Reported for misuse");
    expect((await notes(owner)).at(-1)!.body).toBe("Kiran Das was removed from Rao Prints: Reported for misuse");
    const log = await stack.db.auditLogs.findOne({ action: "team.remove" });
    expect(log).toMatchObject({ actor: { id: manager.userId }, scope: { module: "pod", businessId: new ObjectId(id) } });
  });

  it("ends someone's places when they delete their account", async () => {
    const owner = await person({ vendor: true, verified: true });
    const kiran = await person({ verified: true });
    const id = await shop(owner);
    const memberId = (await call("POST", `/vendor/businesses/${id}/team`, owner.token, { username: kiran.username, permissions: ["shop.open"] })).json().data.id;
    await call("POST", `/employment/${memberId}/accept`, kiran.token);

    await endPlacesFor(stack.db, { userId: kiran.userId }, "member");
    expect((await stack.db.employments.findOne({ _id: new ObjectId(memberId) }))).toMatchObject({ status: "left", endedBy: "member" });
    expect((await call("GET", `/vendor/businesses/${id}/team`, owner.token)).json().data.members).toEqual([]);
  });
});
