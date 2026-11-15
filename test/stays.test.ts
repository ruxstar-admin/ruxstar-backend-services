import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, dayOf } from "../src/modules/coaching/rules.js";
import { overlapping, pickBeds, stayWindow } from "../src/modules/stays/orders.js";
import { DEFAULT_STAYS_RULES, fullRefundNow, refundDaysOf, refundText, startOf } from "../src/modules/stays/rules.js";
import { stamp } from "../src/platform/db.js";
import { forgetModuleState } from "../src/platform/module-switch.js";
import { JOB_TOKEN, signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>> & { username: string };
const BACK = "https://ruxstar.com/stays";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const TELANGANA_GSTIN = "36AABCU9603R1ZM";

const day = (n: number) => addDays(dayOf(new Date()), n);

describe("stay dates and refunds", () => {
  it("keeps a hostel stay to its nights and a monthly stay open until notice", () => {
    const night = stayWindow("2026-12-01", "night", 2);
    expect(night.from.toISOString()).toBe(startOf("2026-12-01").toISOString());
    expect(night.until!.toISOString()).toBe(startOf("2026-12-03").toISOString());
    expect(stayWindow("2026-12-01", "month", 3).until).toBeNull();
    const filter = overlapping([new ObjectId()], night.from, night.until);
    expect(filter).toMatchObject({ from: { $lt: night.until }, $or: [{ until: null }, { until: { $gt: night.from } }] });
    expect(overlapping([new ObjectId()], night.from, null)).not.toHaveProperty("from");
  });

  it("refunds in full until the property's days before move-in, held to Ruxstar's limits", () => {
    const from = startOf("2026-12-10");
    expect(fullRefundNow({ days: 3 }, from, new Date(from.getTime() - 3 * DAY))).toBe(true);
    expect(fullRefundNow({ days: 3 }, from, new Date(from.getTime() - 3 * DAY + MINUTE))).toBe(false);
    expect(refundDaysOf(1, DEFAULT_STAYS_RULES)).toBe(3);
    expect(refundDaysOf(45, DEFAULT_STAYS_RULES)).toBe(30);
    expect(refundDaysOf(7, DEFAULT_STAYS_RULES)).toBe(7);
    expect(refundText({ days: 3 })).toContain("until 3 days before move-in");
    expect(refundText({ days: 0 })).toContain("until move-in day");
  });

  it("reserves a private room whole, and a shared room by the bed or whole", () => {
    const beds = ["A", "B", "C"].map((label, i) => ({ _id: new ObjectId(), label, status: "open" as const, order: i }) as never);
    expect(pickBeds({ kind: "private", wholeRoom: true }, beds, {})).toMatchObject({ whole: true });
    expect(pickBeds({ kind: "shared", wholeRoom: true }, beds, { whole: true }).beds).toHaveLength(3);
    expect(() => pickBeds({ kind: "shared", wholeRoom: false }, beds, { whole: true })).toThrow("one by one");
    expect(() => pickBeds({ kind: "shared", wholeRoom: true }, beds, {})).toThrow("Pick a bed");
  });
});

describe("stays", () => {
  let stack: Stack;
  let photo: Buffer;

  beforeAll(async () => {
    stack = await startStack();
    photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#8d6e63" } }).jpeg().toBuffer();
  });
  afterAll(() => stack?.stop());
  beforeEach(async () => {
    await Promise.all([
      stack.db.businesses.deleteMany({}),
      stack.db.staysProperties.deleteMany({}),
      stack.db.staysRooms.deleteMany({}),
      stack.db.staysBeds.deleteMany({}),
      stack.db.staysReservations.deleteMany({}),
      stack.db.staysFacilities.deleteMany({}),
      stack.db.coupons.deleteMany({}),
      stack.db.couponRedemptions.deleteMany({}),
      stack.db.employments.deleteMany({}),
      stack.db.ledgerEntries.deleteMany({}),
      stack.db.invoices.deleteMany({}),
      stack.db.reviews.deleteMany({}),
      stack.db.notifications.deleteMany({}),
      stack.db.auditLogs.deleteMany({}),
    ]);
    await stack.db.moduleSettings.updateOne(
      { module: "stays" },
      { $set: { live: true, signupsOpen: true, commissionBps: 1000, platformFee: 500 }, $unset: { staysRules: "" } },
      { upsert: true },
    );
    forgetModuleState();
  });

  const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, token: string, payload?: object) =>
    stack.app.inject({
      method,
      url: `/v1${url}`,
      headers: web(token, method === "GET" || method === "DELETE" ? {} : { "idempotency-key": randomUUID() }),
      ...(payload ? { payload } : {}),
    });
  const anon = (url: string) => stack.app.inject({ method: "GET", url: `/v1${url}`, headers: web() });
  const sweep = () => stack.app.inject({ method: "POST", url: "/jobs/orders", headers: { authorization: `Bearer ${JOB_TOKEN}` } });

  let n = 0;
  async function person(opts: { verified?: boolean; vendor?: boolean; name?: string } = {}): Promise<User> {
    const user = await signIn(stack, opts.vendor ? { vendor: true } : {});
    const username = `tenant${Date.now() % 1e6}${n++}`;
    await stack.db.users.updateOne(
      { _id: user.userId },
      { $set: { name: opts.name ?? "Kiran Das", username, ...(opts.verified === false ? {} : { "kyc.base": "approved" }) } },
    );
    return { ...user, username };
  }
  const vendor = () => person({ vendor: true, name: "Asha Rao" });

  async function business(owner: User, { type = "pg", gstin = false }: { type?: string; gstin?: boolean } = {}) {
    const _id = new ObjectId();
    await stack.db.businesses.insertOne({
      _id,
      ownerId: owner.userId,
      module: "stays",
      type,
      name: type === "hostel" ? "Lotus Stays" : "Sunrise Living",
      description: null,
      phone: "9876543210",
      location: { state: "Telangana", city: "Hyderabad", doorNo: "4-12", street: "Road 3", area: "Madhapur", pincode: "500081" },
      pod: null,
      gstin: gstin ? { number: TELANGANA_GSTIN, legalName: "Sunrise Living LLP", status: "Active" } : null,
      photos: [],
      status: "live",
      open: true,
      publishedAt: new Date(),
      ...stamp(),
    } as never);
    return _id.toHexString();
  }

  const pgBody = (extra: object = {}) => ({
    name: "Sunrise Boys PG",
    description: "Ten minutes from JNTU, home food twice a day.",
    address: { line: "Plot 12, Road 3, Madhapur", area: "Madhapur", city: "Hyderabad", pincode: "500081" },
    for: "men",
    occupants: ["students"],
    food: { type: "veg", meals: ["breakfast", "dinner"] },
    facilities: ["wifi", "laundry"],
    rules: { curfew: "22:00", guests: false, smoking: false, alcohol: false, pets: false, notes: "Gate closes at 10 pm." },
    noticeDays: 30,
    deposit: { amount: 1_500_000, note: "Refunded at move-out" },
    nearby: [{ kind: "college", name: "JNTU Hyderabad", km: 1.2 }],
    ...extra,
  });
  const hostelBody = (extra: object = {}) => ({
    name: "Lotus Hostel",
    kind: "hostel",
    address: { line: "8-2, Ameerpet Main Road", area: "Ameerpet", city: "Hyderabad" },
    for: "any",
    food: { type: "none", meals: [] },
    facilities: ["wifi", "ac"],
    rules: { curfew: null, guests: true, smoking: false, alcohol: false, pets: false, notes: null },
    noticeDays: 0,
    nearby: [{ kind: "metro", name: "Ameerpet Metro", km: 0.3 }],
    ...extra,
  });
  const sharedRoom = (extra: object = {}) => ({ name: "Room 101", kind: "shared", beds: 3, prices: { month: 800_000, night: null }, features: ["attached_bath"], ...extra });
  const privateRoom = (extra: object = {}) => ({ name: "Room 1", kind: "private", beds: 1, prices: { month: null, night: 90_000 }, ...extra });

  interface Room {
    id: string;
    bedList: { id: string; label: string }[];
  }
  interface Setup {
    bizId: string;
    propertyId: string;
    rooms: Room[];
  }
  async function setup(owner: User, opts: { type?: string; gstin?: boolean; body?: object; rooms?: object[] } = {}): Promise<Setup> {
    const bizId = await business(owner, { type: opts.type ?? "pg", gstin: opts.gstin ?? false });
    const created = await call("POST", `/vendor/businesses/${bizId}/properties`, owner.token, opts.body ?? pgBody());
    expect(created.statusCode).toBe(201);
    const propertyId = created.json().data.id as string;
    const uploaded = await stack.app.inject({
      method: "POST",
      url: `/v1/vendor/properties/${propertyId}/photos`,
      headers: web(owner.token, { "content-type": "image/jpeg" }),
      payload: photo,
    });
    expect(uploaded.statusCode).toBe(200);
    for (const room of opts.rooms ?? [sharedRoom()]) {
      const res = await call("POST", `/vendor/properties/${propertyId}/rooms`, owner.token, room);
      expect(res.statusCode).toBe(201);
    }
    const published = await call("POST", `/vendor/properties/${propertyId}/publish`, owner.token);
    expect(published.statusCode).toBe(200);
    return { bizId, propertyId, rooms: published.json().data.rooms };
  }

  const reserve = (customer: User, roomId: string, body: object) => call("POST", `/stays/rooms/${roomId}/reserve`, customer.token, { returnTo: BACK, ...body });

  /** Opens the checkout link the way a browser does and presses the test button. */
  async function pay(checkoutUrl: string) {
    const url = new URL(checkoutUrl);
    const page = await stack.app.inject({ method: "GET", url: url.pathname + url.search });
    expect(page.statusCode).toBe(200);
    const test = await stack.app.inject({ method: "POST", url: `${url.pathname}/test${url.search}` });
    expect(test.json()).toEqual({ status: "confirmed" });
  }
  async function reservePaid(customer: User, roomId: string, body: object) {
    const res = await reserve(customer, roomId, body);
    expect(res.statusCode).toBe(201);
    await pay(res.json().data.checkoutUrl);
    return res.json().data.reservation as { id: string; orderNo: number };
  }
  async function movedIn(owner: User, customer: User, roomId: string, bedId: string) {
    const r = await reservePaid(customer, roomId, { bedId, moveIn: day(0) });
    const res = await call("POST", `/stays/desk/orders/${r.id}/moved-in`, owner.token);
    expect(res.statusCode).toBe(200);
    return r;
  }
  /** Moves the objection window to have closed a minute ago; the release with it, unless the tenant objected. */
  async function windowClosed(id: string) {
    const _id = new ObjectId(id);
    const past = new Date(Date.now() - MINUTE);
    const r = (await stack.db.staysReservations.findOne({ _id }))!;
    await stack.db.staysReservations.updateOne({ _id }, { $set: { objectionUntil: past, ...(r.releaseAt ? { releaseAt: past } : {}) } });
  }

  async function staff(permissions: string[]) {
    const user = await signIn(stack, { ruxstarStaff: true });
    await stack.db.ruxstarStaff.insertOne({ _id: new ObjectId(), userId: user.userId, title: "Ops", modules: [], permissions, grantedBy: user.userId, status: "active", ...stamp() });
    return user;
  }
  async function teamMember(owner: User, businessId: string, permissions: string[], verified = true) {
    const who = await person({ verified, name: "Gopal Warden" });
    const invited = await call("POST", `/vendor/businesses/${businessId}/team`, owner.token, { username: who.username, permissions });
    expect(invited.statusCode).toBe(201);
    const accepted = await call("POST", `/employment/${invited.json().data.id}/accept`, who.token);
    expect(accepted.statusCode).toBe(200);
    return who;
  }

  const notesFor = (userId: ObjectId) => stack.db.notifications.find({ userId }).sort({ createdAt: 1, _id: 1 }).toArray();
  const invoicesOf = (id: string) => stack.db.invoices.find({ "source.id": new ObjectId(id) }).sort({ issuedAt: 1, _id: 1 }).toArray();
  const balanceOf = async (owner: User) =>
    (await stack.db.ledgerEntries.find({ accountId: `vendor:${owner.userId.toHexString()}` }).toArray()).reduce(
      (sum, e) => ({ ...sum, [e.bucket]: (sum[e.bucket] ?? 0) + e.signedPaise }),
      {} as Record<string, number>,
    );

  it("sets up a property with rooms and beds, says what publishing needs, and shows it signed out", async () => {
    const owner = await vendor();
    const bizId = await business(owner);
    const created = await call("POST", `/vendor/businesses/${bizId}/properties`, owner.token, pgBody());
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({
      status: "draft",
      kind: "pg",
      refundDays: 3,
      refundLimits: { min: 3, max: 30 },
      missing: ["Add at least one photo", "Add a room that's open for reservations"],
      facilities: [{ key: "wifi", name: "Wi-Fi" }, { key: "laundry", name: "Laundry" }],
    });
    const draftId = created.json().data.id as string;
    expect((await call("POST", `/vendor/properties/${draftId}/publish`, owner.token)).json().error.code).toBe("BUSINESS_INCOMPLETE");
    expect((await call("PATCH", `/vendor/properties/${draftId}`, owner.token, { refundDays: 1 })).json().error.details[0].path).toBe("body/refundDays");
    expect((await call("PATCH", `/vendor/properties/${draftId}`, owner.token, { refundDays: 31 })).json().error.details[0].path).toBe("body/refundDays");
    expect((await call("PATCH", `/vendor/properties/${draftId}`, owner.token, { facilities: ["jacuzzi"] })).json().error.details[0].path).toBe("body/facilities/0");
    expect((await call("PATCH", `/vendor/properties/${draftId}`, owner.token, { food: { type: "none", meals: ["lunch"] } })).json().error.details[0].path).toBe("body/food/meals");
    expect((await call("POST", `/vendor/properties/${draftId}/rooms`, owner.token, sharedRoom({ prices: { month: null, night: null } }))).json().error.details[0].path).toBe(
      "body/prices",
    );
    expect((await call("POST", `/vendor/properties/${draftId}/rooms`, owner.token, sharedRoom({ beds: 13 }))).json().error.details[0].path).toBe("body/beds");
    expect((await anon(`/stays/${draftId}`)).statusCode).toBe(404);
    expect((await call("DELETE", `/vendor/properties/${draftId}`, owner.token)).json().data).toEqual({ done: true });

    const { propertyId, rooms } = await setup(owner, { rooms: [sharedRoom(), sharedRoom({ name: "Room 102", beds: 2, prices: { month: 950_000, night: null }, wholeRoom: false })] });
    expect(rooms[0]!.bedList.map((b) => b.label)).toEqual(["A", "B", "C"]);
    const list = await anon("/stays?city=hyderabad");
    expect(list.headers["cache-control"]).toBe("public, max-age=60");
    expect(list.json().data).toMatchObject([
      { id: propertyId, name: "Sunrise Boys PG", priceFrom: { month: 800_000, night: null }, units: ["month"], roomKinds: ["shared"], deposit: 1_500_000, photo: { url: expect.any(String) } },
    ]);
    const detail = await anon(`/stays/${propertyId}`);
    expect(detail.headers["cache-control"]).toBe("public, max-age=60");
    expect(detail.json().data).toMatchObject({
      canReserve: true,
      kycRequired: true,
      refundDays: 3,
      platformFee: 500,
      depositDetail: { amount: 1_500_000, note: "Refunded at move-out" },
      rules: { curfew: "22:00", guests: false },
      rooms: [{ name: "Room 101", wholeRoom: true }, { name: "Room 102", wholeRoom: false }],
    });
    expect(detail.json().data.refundRule).toContain("3 days before move-in");
    expect((await anon("/stays/rules")).json().data).toMatchObject({ refundDays: 3, objectionHours: 24, holdMinutes: 15, platformFee: 500, commissionBps: 1000 });
    expect((await anon("/stays/facilities")).json().data).toContainEqual({ key: "power_backup", name: "Power backup" });

    const free = (await anon(`/stays/${propertyId}/availability?moveIn=${day(5)}`)).json().data;
    expect(free).toMatchObject({ stay: "month", until: null, reservable: true });
    expect(free.rooms[0]).toMatchObject({ bedTotal: 800_000, roomTotal: 2_400_000 });
    expect(free.rooms[1]).toMatchObject({ bedTotal: 950_000, roomTotal: null });
    expect((await anon(`/stays/${propertyId}/availability?moveIn=${day(90)}`)).json().data.reservable).toBe(false);

    await stack.db.moduleSettings.updateOne({ module: "stays" }, { $set: { live: false } });
    forgetModuleState();
    expect((await anon("/stays")).json().data).toEqual([]);
  });

  it("filters by who it's for, food, facilities, how it's let, price, room kind, nearby places, notice and house rules", async () => {
    const owner = await vendor();
    const pg = await setup(owner);
    const hostel = await setup(owner, { type: "hostel", body: hostelBody(), rooms: [privateRoom()] });
    const ids = async (query: string) => ((await anon(`/stays?${query}`)).json().data as { id: string }[]).map((p) => p.id).sort();
    const both = [pg.propertyId, hostel.propertyId].sort();

    expect(await ids("city=Hyderabad")).toEqual(both);
    expect(await ids("area=ameerpet")).toEqual([hostel.propertyId]);
    expect(await ids("for=men")).toEqual(both);
    expect(await ids("for=women")).toEqual([hostel.propertyId]);
    expect(await ids("occupant=working")).toEqual([hostel.propertyId]);
    expect(await ids("food=veg")).toEqual([pg.propertyId]);
    expect(await ids("food=any")).toEqual([pg.propertyId]);
    expect(await ids("meals=breakfast,dinner")).toEqual([pg.propertyId]);
    expect(await ids("meals=lunch")).toEqual([]);
    expect(await ids("facilities=wifi,ac")).toEqual([hostel.propertyId]);
    expect(await ids("stay=night")).toEqual([hostel.propertyId]);
    expect(await ids("priceMax=800000")).toEqual([pg.propertyId]);
    expect(await ids("priceMax=700000")).toEqual([]);
    expect(await ids("stay=night&priceMax=90000")).toEqual([hostel.propertyId]);
    expect(await ids("room=private")).toEqual([hostel.propertyId]);
    expect(await ids("near=jntu")).toEqual([pg.propertyId]);
    expect(await ids("noticeMax=7")).toEqual([hostel.propertyId]);
    expect(await ids("allows=guests,late_entry")).toEqual([hostel.propertyId]);
    expect(await ids("kind=hostel")).toEqual([hostel.propertyId]);
    expect(await ids("q=lotus")).toEqual([hostel.propertyId]);
    expect((await anon("/stays?facilities=Wi-Fi")).statusCode).toBe(400);
  });

  it("needs base KYC to reserve, then holds the bed for checkout, takes payment, issues GST documents and shows it on the board", async () => {
    const owner = await vendor();
    const { propertyId, rooms } = await setup(owner, { gstin: true });
    const room = rooms[0]!;
    const [bedA] = room.bedList;

    const unverified = await person({ verified: false });
    const refused = await reserve(unverified, room.id, { bedId: bedA!.id, moveIn: day(10) });
    expect(refused.json().error).toMatchObject({ code: "KYC_REQUIRED", details: [{ reason: "tenant_kyc", link: { screen: "verification", id: "base" } }] });
    expect((await reserve(owner, room.id, { bedId: bedA!.id, moveIn: day(10) })).json().error.message).toContain("own property");

    const customer = await person();
    expect((await reserve(customer, room.id, { moveIn: day(10) })).json().error.details[0].path).toBe("body/bedId");
    expect((await reserve(customer, room.id, { bedId: bedA!.id, moveIn: day(-1) })).json().error.details[0].path).toBe("body/moveIn");
    expect((await reserve(customer, room.id, { bedId: bedA!.id, moveIn: day(10), months: 2 })).json().error.details[0].path).toBe("body/months");
    expect((await reserve(customer, room.id, { bedId: bedA!.id, moveIn: day(10), stay: "night" })).json().error.details[0].path).toBe("body/stay");

    const placed = await reserve(customer, room.id, { bedId: bedA!.id, moveIn: day(10) });
    expect(placed.statusCode).toBe(201);
    const { reservation, checkoutUrl } = placed.json().data;
    expect(reservation).toMatchObject({
      status: "awaiting_payment",
      stay: "month",
      units: 1,
      until: null,
      beds: [{ label: "A" }],
      whole: false,
      price: { unitPrice: 800_000, quantity: 1, items: 800_000, platformFee: 500, total: 800_500 },
      deposit: { amount: 1_500_000 },
      payBy: expect.any(String),
    });
    expect(reservation.orderNo).toBeGreaterThan(80_000_000);
    const other = await person({ name: "Ravi Kumar" });
    const taken = await reserve(other, room.id, { bedId: bedA!.id, moveIn: day(20) });
    expect(taken.json().error).toMatchObject({ code: "CONFLICT" });
    expect(taken.json().error.message).toContain("Bed A is taken for these dates");

    await pay(checkoutUrl);
    const view = (await call("GET", `/stays/orders/${reservation.id}`, customer.token)).json().data;
    expect(view).toMatchObject({ status: "confirmed", canCancel: true, refundIfCancelled: 800_500, canObject: false, canReview: false, payBy: null });
    expect(view.invoices).toHaveLength(2);
    const [sale, fee] = await invoicesOf(reservation.id);
    expect(sale).toMatchObject({ kind: "bill_of_supply", module: "stays", totals: { total: 800_000 } });
    expect(fee).toMatchObject({ role: "fee", totals: { total: 500 } });
    expect(await balanceOf(owner)).toEqual({ pending: 720_000 });
    expect((await notesFor(owner.userId)).some((x) => x.title === `New reservation #${reservation.orderNo}` && x.type === "stays.reserved")).toBe(true);
    expect((await notesFor(customer.userId)).at(-1)!.title).toBe("Reserved: Sunrise Boys PG");

    const board = (await call("GET", `/stays/desk/properties/${propertyId}/board?date=${day(10)}`, owner.token)).json().data;
    expect(board.rooms[0].beds[0]).toMatchObject({ label: "A", state: "reserved", reservation: { orderNo: reservation.orderNo, tenantName: "Kiran Das" } });
    expect(board.totals).toMatchObject({ beds: 3, free: 2, reserved: 1 });
    const before = (await call("GET", `/stays/desk/properties/${propertyId}/board?date=${day(5)}`, owner.token)).json().data;
    expect(before.rooms[0].beds[0]).toMatchObject({ state: "free", next: { orderNo: reservation.orderNo } });
    const upcoming = (await call("GET", `/stays/desk/properties/${propertyId}/reservations`, owner.token)).json().data;
    expect(upcoming).toMatchObject([{ id: reservation.id, tenant: { name: "Kiran Das", phone: expect.any(String), verified: true }, vendorShare: 720_000, payout: "waiting", canMoveIn: false }]);
    expect((await call("GET", "/stays/orders", customer.token)).json().data).toHaveLength(1);

    const later = (await anon(`/stays/${propertyId}/availability?moveIn=${day(5)}`)).json().data.rooms[0];
    expect(later.beds.map((b: { state: string }) => b.state)).toEqual(["taken", "free", "free"]);
    expect(later).toMatchObject({ bedTotal: 800_000, roomTotal: null });
    for (const moveIn of ["2026-13-01", "2026-02-30"]) expect((await anon(`/stays/${propertyId}/availability?moveIn=${moveIn}`)).statusCode).toBe(400);
  });

  it("lets hostels sell nights, and frees the bed from the checkout day", async () => {
    const owner = await vendor();
    const { propertyId, rooms } = await setup(owner, { type: "hostel", body: hostelBody(), rooms: [privateRoom()] });
    const room = rooms[0]!;
    const customer = await person();
    expect((await reserve(customer, room.id, { moveIn: day(3) })).json().error.details[0].path).toBe("body/stay");
    expect((await reserve(customer, room.id, { moveIn: day(3), stay: "night", months: 1 })).json().error.details[0].path).toBe("body/months");
    expect((await reserve(customer, room.id, { moveIn: day(3), stay: "night", nights: 31 })).json().error.details[0].path).toBe("body/nights");
    expect((await reserve(customer, room.id, { bedId: room.bedList[0]!.id, moveIn: day(3), stay: "night" })).json().error.details[0].path).toBe("body/bedId");

    const first = await reservePaid(customer, room.id, { moveIn: day(3), stay: "night", nights: 2 });
    const view = (await call("GET", `/stays/orders/${first.id}`, customer.token)).json().data;
    expect(view).toMatchObject({ stay: "night", units: 2, whole: true, until: startOf(day(5)).toISOString(), price: { unitPrice: 90_000, quantity: 1, items: 180_000, total: 180_500 }, canGiveNotice: false });
    const second = await person({ name: "Ravi Kumar" });
    expect((await reserve(second, room.id, { moveIn: day(4), stay: "night" })).json().error.code).toBe("CONFLICT");
    expect((await reserve(second, room.id, { moveIn: day(5), stay: "night" })).statusCode).toBe(201);
    const nights = (await anon(`/stays/${propertyId}/availability?moveIn=${day(1)}&stay=night&nights=2`)).json().data;
    expect(nights).toMatchObject({ until: day(3), rooms: [{ roomTotal: 180_000, bedTotal: null }] });
  });

  it("never gives one bed to two people at once", async () => {
    const owner = await vendor();
    const { rooms } = await setup(owner);
    const bed = rooms[0]!.bedList[1]!;
    const customers = await Promise.all([1, 2, 3, 4, 5, 6].map(() => person()));
    const results = await Promise.all(customers.map((c, i) => reserve(c, rooms[0]!.id, { bedId: bed.id, moveIn: day(5 + i) })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    expect(await stack.db.staysReservations.countDocuments({ status: { $ne: "cancelled" } })).toBe(1);
  });

  it("reserves a shared bed or the whole room, and won't give the whole room once a bed is taken", async () => {
    const owner = await vendor();
    const { rooms } = await setup(owner, { rooms: [sharedRoom(), sharedRoom({ name: "Room 102", beds: 2, prices: { month: 600_000, night: null } }), sharedRoom({ name: "Room 103", wholeRoom: false })] });
    const [r101, r102, r103] = rooms as [Room, Room, Room];
    const first = await person();
    await reservePaid(first, r101.id, { bedId: r101.bedList[0]!.id, moveIn: day(5) });
    const second = await person();
    const whole = await reserve(second, r101.id, { whole: true, moveIn: day(5) });
    expect(whole.json().error.code).toBe("CONFLICT");
    expect(whole.json().error.message).toContain("Some beds in this room are taken");
    expect((await reserve(second, r101.id, { bedId: r101.bedList[1]!.id, moveIn: day(5) })).statusCode).toBe(201);
    expect((await reserve(second, r101.id, { bedId: r101.bedList[2]!.id, whole: true, moveIn: day(5) })).json().error.details[0].path).toBe("body/bedId");
    expect((await reserve(second, r103.id, { whole: true, moveIn: day(5) })).json().error.details[0].path).toBe("body/whole");

    const third = await person();
    const room = (await reserve(third, r102.id, { whole: true, moveIn: day(5) })).json().data.reservation;
    expect(room).toMatchObject({ whole: true, beds: [{ label: "A" }, { label: "B" }], price: { unitPrice: 600_000, quantity: 2, items: 1_200_000, total: 1_200_500 } });
    expect((await reserve(await person(), r102.id, { bedId: r102.bedList[0]!.id, moveIn: day(8) })).json().error.code).toBe("CONFLICT");
  });

  it("gives held beds back once the hold runs out, on the next reservation or the sweep", async () => {
    const owner = await vendor();
    const { rooms } = await setup(owner);
    const room = rooms[0]!;
    const held = (await reserve(await person(), room.id, { bedId: room.bedList[0]!.id, moveIn: day(4) })).json().data.reservation;
    const expire = (id: string) => stack.db.staysReservations.updateOne({ _id: new ObjectId(id) }, { $set: { holdUntil: new Date(Date.now() - MINUTE) } });
    await expire(held.id);
    expect((await reserve(await person(), room.id, { bedId: room.bedList[0]!.id, moveIn: day(4) })).statusCode).toBe(201);
    expect((await stack.db.staysReservations.findOne({ _id: new ObjectId(held.id) }))!.status).toBe("cancelled");

    const another = (await reserve(await person(), room.id, { bedId: room.bedList[1]!.id, moveIn: day(4) })).json().data.reservation;
    await expire(another.id);
    expect((await sweep()).json().staysHolds).toBe(1);
    expect((await stack.db.staysReservations.findOne({ _id: new ObjectId(another.id) }))!.status).toBe("cancelled");
  });

  it("refunds a customer in full until 3 days before move-in, nothing after, and follows a stricter property", async () => {
    const owner = await vendor();
    const { propertyId, rooms, bizId } = await setup(owner, { gstin: true });
    const room = rooms[0]!;
    const customer = await person();
    const early = await reservePaid(customer, room.id, { bedId: room.bedList[0]!.id, moveIn: day(10) });
    const full = (await call("POST", `/stays/orders/${early.id}/cancel`, customer.token, {})).json().data;
    expect(full).toMatchObject({ status: "cancelled", refund: { amount: 800_500, status: "done" }, cancellation: { by: "customer" } });
    expect((await invoicesOf(early.id)).filter((d) => d.kind === "credit_note").map((d) => d.totals.total)).toEqual([800_000, 500]);
    expect(await balanceOf(owner)).toEqual({ pending: 0 });

    const late = await reservePaid(customer, room.id, { bedId: room.bedList[0]!.id, moveIn: day(2) });
    const preview = (await call("GET", `/stays/orders/${late.id}`, customer.token)).json().data;
    expect(preview).toMatchObject({ canCancel: true, refundIfCancelled: 0 });
    const none = (await call("POST", `/stays/orders/${late.id}/cancel`, customer.token, {})).json().data;
    expect(none).toMatchObject({ status: "cancelled", refund: null });
    expect(await balanceOf(owner)).toEqual({ pending: 0, withdrawable: 720_000 });
    expect((await notesFor(owner.userId)).at(-1)!.body).toContain("moves to your balance");

    const stricter = await call("PATCH", `/vendor/properties/${propertyId}`, owner.token, { refundDays: 7 });
    expect(stricter.json().data).toMatchObject({ refundDays: 7 });
    expect((await anon(`/stays/${propertyId}`)).json().data.refundRule).toContain("7 days before move-in");
    const strict = await reservePaid(customer, room.id, { bedId: room.bedList[1]!.id, moveIn: day(5) });
    expect((await call("GET", `/stays/orders/${strict.id}`, customer.token)).json().data).toMatchObject({ refundIfCancelled: 0 });
    expect((await stack.db.staysReservations.findOne({ _id: new ObjectId(strict.id) }))!.refundRule).toEqual({ days: 7 });

    const team = await teamMember(owner, bizId, ["stays.listing"]);
    expect((await call("PATCH", `/stays/desk/properties/${propertyId}`, team.token, { noticeDays: 15 })).json().data.noticeDays).toBe(15);
  });

  it("lets the property cancel with a full refund, fee included, issuing credit notes", async () => {
    const owner = await vendor();
    const { rooms } = await setup(owner, { gstin: true });
    const customer = await person();
    const r = await reservePaid(customer, rooms[0]!.id, { bedId: rooms[0]!.bedList[0]!.id, moveIn: day(1) });
    expect((await call("POST", `/stays/desk/orders/${r.id}/cancel`, owner.token, { reason: "x" })).statusCode).toBe(400);
    const done = await call("POST", `/stays/desk/orders/${r.id}/cancel`, owner.token, { reason: "The water tank is being repaired." });
    expect(done.json().data).toMatchObject({ status: "cancelled", refund: { amount: 800_500 }, cancellation: { by: "property" }, payout: "refunded" });
    expect((await invoicesOf(r.id)).filter((d) => d.kind === "credit_note").map((d) => d.totals.total)).toEqual([800_000, 500]);
    expect((await notesFor(customer.userId)).at(-1)!.body).toContain("The water tank is being repaired.");
    expect(await balanceOf(owner)).toEqual({ pending: 0 });
    expect(await stack.db.auditLogs.countDocuments({ action: "stay_reservation.cancel" })).toBe(1);
  });

  it("marks moved in from the move-in day, then releases the owner's share once the objection window passes", async () => {
    const owner = await vendor();
    const { propertyId, rooms } = await setup(owner);
    const room = rooms[0]!;
    const customer = await person();
    const future = await reservePaid(customer, room.id, { bedId: room.bedList[1]!.id, moveIn: day(2) });
    expect((await call("POST", `/stays/desk/orders/${future.id}/moved-in`, owner.token)).json().error.message).toContain("Mark the move-in from");

    const r = await reservePaid(customer, room.id, { bedId: room.bedList[0]!.id, moveIn: day(0) });
    expect((await call("GET", `/stays/desk/orders/${r.id}`, owner.token)).json().data.canMoveIn).toBe(true);
    const moved = (await call("POST", `/stays/desk/orders/${r.id}/moved-in`, owner.token)).json().data;
    expect(moved).toMatchObject({ status: "moved_in", staying: true, payout: "waiting", releaseAt: expect.any(String), canCancel: true });
    expect(new Date(moved.objectionUntil).getTime()).toBeGreaterThan(Date.now() + 23 * 60 * MINUTE);
    expect((await call("POST", `/stays/desk/orders/${r.id}/moved-in`, owner.token)).json().error.code).toBe("ORDER_STATE");
    expect((await notesFor(customer.userId)).at(-1)!.title).toBe("Welcome to Sunrise Boys PG");
    expect((await call("GET", `/stays/orders/${r.id}`, customer.token)).json().data).toMatchObject({ canObject: true, canCancel: false, canGiveNotice: true });
    expect((await call("POST", `/stays/orders/${r.id}/cancel`, customer.token, {})).json().error.message).toContain("Give notice instead");
    const board = (await call("GET", `/stays/desk/properties/${propertyId}/board`, owner.token)).json().data;
    expect(board.rooms[0].beds[0].state).toBe("occupied");
    expect((await call("GET", `/stays/desk/properties/${propertyId}/tenants`, owner.token)).json().data).toMatchObject([{ id: r.id, tenant: { verified: true } }]);

    const waiting = (await call("GET", "/vendor/payments", owner.token)).json().data;
    expect(waiting.balance).toMatchObject({ available: 0, pending: 1_440_000 });
    expect(waiting.upcoming).toMatchObject([{ orderId: r.id, amount: 720_000, held: false }]);
    expect((await sweep()).json().staysReleases).toBe(0);

    await windowClosed(r.id);
    const after = (await call("GET", "/vendor/payments", owner.token)).json().data;
    expect(after.balance).toMatchObject({ available: 720_000, pending: 720_000 });
    const desk = (await call("GET", `/stays/desk/orders/${r.id}`, owner.token)).json().data;
    expect(desk).toMatchObject({ payout: "released", canCancel: false });
    expect((await call("POST", `/stays/desk/orders/${r.id}/cancel`, owner.token, { reason: "Changed my mind about it." })).json().error.message).toContain("released");
    const statement = (await call("GET", "/vendor/payments/statement", owner.token)).json().data;
    expect(statement.every((l: { module: string }) => l.module === "stays")).toBe(true);
    expect(statement[0]).toMatchObject({ kind: "available", amount: 720_000, order: { label: "Sunrise Boys PG, Room 101" } });
    expect(await stack.db.auditLogs.countDocuments({ action: "stay_reservation.moved_in" })).toBe(1);
  });

  it("holds the owner's money while a tenant objects, until they take it back or Ruxstar decides", async () => {
    const owner = await vendor();
    const { rooms } = await setup(owner);
    const room = rooms[0]!;
    const [a, b, c] = await Promise.all([person(), person(), person()]);
    const ra = await movedIn(owner, a, room.id, room.bedList[0]!.id);
    const rb = await movedIn(owner, b, room.id, room.bedList[1]!.id);
    const rc = await movedIn(owner, c, room.id, room.bedList[2]!.id);
    expect((await call("POST", `/stays/orders/${ra.id}/objection`, b.token, { reason: "Not my stay at all." })).statusCode).toBe(404);

    const objected = await call("POST", `/stays/orders/${ra.id}/objection`, a.token, { reason: "I never moved in; the room was locked." });
    expect(objected.json().data).toMatchObject({ canObject: false, objection: { status: "open" } });
    expect((await call("POST", `/stays/orders/${ra.id}/objection`, a.token, { reason: "Trying a second time." })).json().error.message).toContain("already");
    expect((await notesFor(owner.userId)).at(-1)!.title).toBe(`#${ra.orderNo}: tenant objected`);
    await call("POST", `/stays/orders/${rb.id}/objection`, b.token, { reason: "The AC doesn't work at all." });
    await call("POST", `/stays/orders/${rc.id}/objection`, c.token, { reason: "Not the room in the photos." });
    await Promise.all([ra, rb, rc].map((r) => windowClosed(r.id)));
    expect((await sweep()).json().staysReleases).toBe(0);
    expect((await call("GET", `/stays/desk/orders/${ra.id}`, owner.token)).json().data).toMatchObject({ payout: "objection", releaseAt: null });

    const withdrawn = await call("DELETE", `/stays/orders/${rc.id}/objection`, c.token);
    expect(withdrawn.json().data.objection.status).toBe("withdrawn");
    expect((await sweep()).json().staysReleases).toBe(1);

    const viewer = await staff(["orders.view"]);
    const manager = await staff(["orders.view", "orders.manage"]);
    const open = (await call("GET", "/ruxstar/stays/objections", viewer.token)).json().data;
    expect(open.map((r: { id: string }) => r.id).sort()).toEqual([ra.id, rb.id].sort());
    const body = { decision: "release", note: "The owner showed the tenant's signed move-in sheet." };
    expect((await call("POST", `/ruxstar/stays/reservations/${ra.id}/objection`, viewer.token, body)).statusCode).toBe(403);
    const released = (await call("POST", `/ruxstar/stays/reservations/${ra.id}/objection`, manager.token, body)).json().data;
    expect(released).toMatchObject({ objection: { status: "released", note: body.note }, releasedAt: expect.any(String) });
    const refunded = (await call("POST", `/ruxstar/stays/reservations/${rb.id}/objection`, manager.token, { decision: "refund", note: "The AC was broken all week." })).json().data;
    expect(refunded).toMatchObject({ status: "cancelled", refund: { amount: 800_500 }, objection: { status: "refunded" }, cancellation: { by: "ruxstar" } });
    expect((await call("POST", `/ruxstar/stays/reservations/${rb.id}/objection`, manager.token, body)).json().error.code).toBe("ORDER_STATE");
    expect(await balanceOf(owner)).toMatchObject({ withdrawable: 1_440_000 });
    expect(await stack.db.auditLogs.countDocuments({ action: "stay_reservation.objection_decide" })).toBe(1);
  });

  it("lets Ruxstar refund an objection that is still open after the stay ended", async () => {
    const owner = await vendor();
    const { rooms } = await setup(owner);
    const room = rooms[0]!;
    const tenant = await person();
    const r = await movedIn(owner, tenant, room.id, room.bedList[0]!.id);
    expect((await call("POST", `/stays/orders/${r.id}/objection`, tenant.token, { reason: "The room was locked when I arrived." })).statusCode).toBe(200);
    const out = (await call("POST", `/stays/desk/orders/${r.id}/move-out`, owner.token, {})).json().data;
    expect(out).toMatchObject({ status: "moved_out", canCancel: false });

    const manager = await staff(["orders.view", "orders.manage"]);
    const res = await call("POST", `/ruxstar/stays/reservations/${r.id}/objection`, manager.token, { decision: "refund", note: "The tenant never got in." });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: "cancelled", refund: { amount: 800_500 }, objection: { status: "refunded" } });
    expect(await balanceOf(owner)).toEqual({ pending: 0 });
    expect((await call("POST", `/stays/desk/orders/${r.id}/cancel`, owner.token, { reason: "Trying again." })).json().error.code).toBe("ORDER_STATE");
  });

  it("takes a tenant's notice on a monthly stay and the owner's move-out, freeing the bed from that day", async () => {
    const owner = await vendor();
    const { propertyId, rooms } = await setup(owner);
    const room = rooms[0]!;
    const [a, b] = await Promise.all([person(), person()]);
    const ra = await movedIn(owner, a, room.id, room.bedList[0]!.id);
    const rb = await movedIn(owner, b, room.id, room.bedList[1]!.id);

    expect((await call("POST", `/stays/orders/${ra.id}/notice`, a.token, { on: day(5) })).json().error.details[0].path).toBe("body/on");
    const notice = (await call("POST", `/stays/orders/${ra.id}/notice`, a.token, {})).json().data;
    expect(notice).toMatchObject({ status: "moved_in", until: startOf(day(30)).toISOString(), moveOut: { on: day(30), kind: "notice", by: "tenant" }, canGiveNotice: false });
    expect((await call("POST", `/stays/orders/${ra.id}/notice`, a.token, {})).json().error.message).toContain("given notice already");
    const later = (await anon(`/stays/${propertyId}/availability?moveIn=${day(30)}`)).json().data.rooms[0].beds[0];
    expect(later.state).toBe("free");
    expect((await anon(`/stays/${propertyId}/availability?moveIn=${day(29)}`)).json().data.rooms[0].beds[0].state).toBe("taken");
    expect((await reserve(await person(), room.id, { bedId: room.bedList[0]!.id, moveIn: day(30) })).statusCode).toBe(201);

    const out = (await call("POST", `/stays/desk/orders/${rb.id}/move-out`, owner.token, { reason: "Moved to another city." })).json().data;
    expect(out).toMatchObject({ status: "moved_out", staying: false, moveOut: { on: day(0), kind: "move_out", by: "property" } });
    expect((await call("POST", `/stays/desk/orders/${rb.id}/move-out`, owner.token, {})).json().error.message).toContain("ended already");
    expect((await reserve(await person(), room.id, { bedId: room.bedList[1]!.id, moveIn: day(0) })).statusCode).toBe(201);
    expect((await call("GET", "/stays/orders?view=past", b.token)).json().data).toMatchObject([{ id: rb.id, status: "moved_out" }]);
    expect((await call("PATCH", `/vendor/rooms/${room.id}`, owner.token, { beds: 1 })).json().error.message).toContain("is reserved");
    expect((await call("DELETE", `/vendor/rooms/${room.id}`, owner.token)).json().error.code).toBe("CONFLICT");
  });

  it("checks team permissions and verification at the desk", async () => {
    const owner = await vendor();
    const { bizId, propertyId, rooms } = await setup(owner);
    const room = rooms[0]!;
    const viewer = await teamMember(owner, bizId, ["stays.reservations"]);
    const warden = await teamMember(owner, bizId, ["stays.reservations", "stays.movein", "stays.beds"]);
    const unverified = await teamMember(owner, bizId, ["stays.reservations"], false);
    const outsider = await person();
    const customer = await person();
    const r = await reservePaid(customer, room.id, { bedId: room.bedList[0]!.id, moveIn: day(0) });

    expect((await call("GET", "/stays/desk/properties", viewer.token)).json().data).toMatchObject([{ id: propertyId, owner: false, permissions: ["stays.reservations"], rooms: 1, beds: 3 }]);
    expect((await call("GET", "/stays/desk/properties", owner.token)).json().data).toMatchObject([{ id: propertyId, owner: true }]);
    expect((await call("GET", `/stays/desk/properties/${propertyId}/board`, viewer.token)).statusCode).toBe(200);
    expect((await call("GET", `/stays/desk/orders/${r.id}`, viewer.token)).json().data.tenant.phone).toEqual(expect.any(String));
    expect((await call("POST", `/stays/desk/orders/${r.id}/moved-in`, viewer.token)).statusCode).toBe(403);
    expect((await call("POST", `/stays/desk/orders/${r.id}/cancel`, viewer.token, { reason: "Not allowed to do this." })).statusCode).toBe(403);
    expect((await call("PUT", `/stays/desk/rooms/${room.id}/prices`, viewer.token, { prices: { month: 700_000, night: null } })).statusCode).toBe(403);
    expect((await call("GET", `/stays/desk/properties/${propertyId}/board`, unverified.token)).json().error.code).toBe("KYC_REQUIRED");
    expect((await call("GET", "/stays/desk/properties", unverified.token)).json().data).toEqual([]);
    expect((await call("GET", `/stays/desk/properties/${propertyId}/board`, outsider.token)).statusCode).toBe(404);
    expect((await call("PATCH", `/vendor/rooms/${room.id}`, viewer.token, { name: "Mine" })).statusCode).toBe(403);

    expect((await call("POST", `/stays/desk/orders/${r.id}/moved-in`, warden.token)).json().data.status).toBe("moved_in");
    expect((await call("POST", `/stays/desk/beds/${room.bedList[2]!.id}/status`, warden.token, { status: "closed" })).json().data).toMatchObject({ label: "C", status: "closed" });
    const full = await reserve(await person(), room.id, { bedId: room.bedList[2]!.id, moveIn: day(3) });
    expect(full.json().error).toMatchObject({ code: "CONFLICT", message: "Bed C is marked full. Pick another bed." });
    expect((await call("POST", `/stays/desk/rooms/${room.id}/status`, warden.token, { status: "paused" })).json().data.rooms[0].status).toBe("paused");
    expect((await reserve(await person(), room.id, { bedId: room.bedList[1]!.id, moveIn: day(3) })).json().error.code).toBe("CONFLICT");
    expect((await call("POST", `/stays/desk/rooms/${room.id}/status`, owner.token, { status: "live" })).statusCode).toBe(200);

    const prices = await call("PUT", `/stays/desk/rooms/${room.id}/prices`, owner.token, { prices: { month: 750_000, night: 40_000 } });
    expect(prices.json().data).toMatchObject({ priceFrom: { month: 750_000, night: 40_000 }, units: ["month", "night"] });
    expect((await stack.db.staysReservations.findOne({ _id: new ObjectId(r.id) }))!.price.unitPrice).toBe(800_000);
    expect(await stack.db.auditLogs.countDocuments({ action: { $in: ["stay_bed.status", "stay_room.status", "stay_room.prices"] } })).toBe(4);
  });

  it("opens reviews once the tenant has moved in, and shows them on the property signed out", async () => {
    const owner = await vendor();
    const { propertyId, rooms } = await setup(owner);
    const customer = await person();
    const waiting = await reservePaid(customer, rooms[0]!.id, { bedId: rooms[0]!.bedList[1]!.id, moveIn: day(3) });
    expect((await call("PUT", `/stays/orders/${waiting.id}/review`, customer.token, { rating: 5 })).statusCode).toBe(409);
    const r = await movedIn(owner, customer, rooms[0]!.id, rooms[0]!.bedList[0]!.id);
    expect((await call("GET", `/stays/orders/${r.id}`, customer.token)).json().data).toMatchObject({ canReview: true, reviewUntil: expect.any(String) });
    const review = await call("PUT", `/stays/orders/${r.id}/review`, customer.token, { rating: 4, text: "Clean rooms and good food." });
    expect(review.statusCode).toBe(200);
    const reviews = await anon(`/stays/${propertyId}/reviews`);
    expect(reviews.statusCode).toBe(200);
    expect(reviews.json().data).toMatchObject([{ rating: 4, text: "Clean rooms and good food." }]);
    expect((await call("PUT", `/stays/orders/${r.id}/review`, (await person()).token, { rating: 1 })).statusCode).toBe(404);
  });

  it("takes a vendor's coupon on a stays business", async () => {
    const owner = await vendor();
    const { bizId, rooms } = await setup(owner);
    const room = rooms[0]!;
    const made = await call("POST", "/vendor/coupons", owner.token, { code: "STAY500", kind: "flat", value: 50_000, businessIds: [bizId] });
    expect(made.statusCode).toBe(201);
    expect((await stack.db.coupons.findOne({ code: "STAY500" }))!.modules).toEqual(["stays"]);
    const customer = await person();
    const body = { bedId: room.bedList[0]!.id, moveIn: day(6) };
    const offers = (await call("POST", `/stays/rooms/${room.id}/offers`, customer.token, { ...body, code: "stay500" })).json().data;
    expect(offers).toMatchObject({ offers: [{ code: "STAY500", discount: 50_000 }], checked: { code: "STAY500", discount: 50_000, problem: null } });
    const res = await reserve(customer, room.id, { ...body, coupon: "STAY500" });
    expect(res.json().data.reservation).toMatchObject({ price: { items: 800_000, discount: 50_000, total: 750_500 }, coupon: { code: "STAY500", fundedBy: "vendor" } });
    await pay(res.json().data.checkoutUrl);
    expect(await stack.db.couponRedemptions.countDocuments({})).toBe(1);
    expect((await stack.db.staysReservations.findOne({}))!.price.commission).toBe(75_000);
    expect(await balanceOf(owner)).toEqual({ pending: 675_000 });
  });

  it("lets the console list properties, take one down refunding reservations to come, keep the facilities list and set stays rules, audited", async () => {
    const owner = await vendor();
    const { propertyId, rooms } = await setup(owner);
    const room = rooms[0]!;
    const customer = await person();
    const upcoming = await reservePaid(customer, room.id, { bedId: room.bedList[1]!.id, moveIn: day(4) });
    const staying = await movedIn(owner, await person(), room.id, room.bedList[0]!.id);
    const viewer = await staff(["businesses.view"]);
    const manager = await staff(["businesses.view", "businesses.manage", "modules.view", "modules.manage"]);

    expect((await call("GET", "/ruxstar/stays/properties?status=live", viewer.token)).json().data).toMatchObject([{ id: propertyId, status: "live", vendorId: owner.userId.toHexString() }]);
    expect((await call("GET", `/ruxstar/stays/properties/${propertyId}`, viewer.token)).json().data.reservations).toEqual({ upcoming: 1, staying: 1, total: 2, cancelled: 0, objections: 0 });
    expect((await call("POST", `/ruxstar/stays/properties/${propertyId}/take-down`, viewer.token, { reason: "Fire safety notice." })).statusCode).toBe(403);
    const down = await call("POST", `/ruxstar/stays/properties/${propertyId}/take-down`, manager.token, { reason: "Fire safety notice from GHMC." });
    expect(down.json().data).toMatchObject({ refunded: 1, property: { status: "removed", removal: { reason: "Fire safety notice from GHMC." } } });
    expect((await call("GET", `/stays/orders/${upcoming.id}`, customer.token)).json().data).toMatchObject({ status: "cancelled", refund: { amount: 800_500 }, cancellation: { by: "ruxstar" } });
    expect((await stack.db.staysReservations.findOne({ _id: new ObjectId(staying.id) }))!.status).toBe("moved_in");
    expect((await notesFor(owner.userId)).at(-1)!.title).toBe("Ruxstar took down Sunrise Boys PG");
    expect((await anon("/stays")).json().data).toEqual([]);
    expect((await anon(`/stays/${propertyId}`)).statusCode).toBe(404);
    expect((await call("PATCH", `/vendor/properties/${propertyId}`, owner.token, { name: "Back again" })).json().error.code).toBe("CONFLICT");
    expect(await stack.db.auditLogs.countDocuments({ action: "stay_property.take_down" })).toBe(1);

    expect((await call("POST", "/ruxstar/stays/facilities", viewer.token, { key: "solar", name: "Solar water" })).statusCode).toBe(403);
    expect((await call("POST", "/ruxstar/stays/facilities", manager.token, { key: "solar", name: "Solar water" })).statusCode).toBe(201);
    expect((await call("POST", "/ruxstar/stays/facilities", manager.token, { key: "solar", name: "Solar water" })).statusCode).toBe(409);
    expect((await call("PATCH", "/ruxstar/stays/facilities/gym", manager.token, { active: false })).json().data).toMatchObject({ key: "gym", active: false });
    const keys = (await anon("/stays/facilities")).json().data.map((f: { key: string }) => f.key);
    expect(keys).toContain("solar");
    expect(keys).not.toContain("gym");
    expect(await stack.db.auditLogs.countDocuments({ action: { $in: ["stay_facility.create", "stay_facility.update"] } })).toBe(2);

    const settings = await call("PATCH", "/ruxstar/modules/stays", manager.token, { staysRules: { refundDays: 5, objectionHours: 48 } });
    expect(settings.json().data.staysRules).toMatchObject({ refundDays: 5, maxRefundDays: 30, objectionHours: 48 });
    const bad = await call("PATCH", "/ruxstar/modules/stays", manager.token, { staysRules: { refundDays: 40 } });
    expect(bad.json().error.details[0].path).toBe("body/staysRules/refundDays");
    expect((await call("PATCH", "/ruxstar/modules/events", manager.token, { staysRules: { holdMinutes: 10 } })).statusCode).toBe(400);
    expect((await anon("/stays/rules")).json().data).toMatchObject({ refundDays: 5, objectionHours: 48, commissionBps: 1000 });
  });
});
