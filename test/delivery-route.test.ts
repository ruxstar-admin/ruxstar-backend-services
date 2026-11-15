import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodePolyline, metresBetween } from "../src/modules/delivery/routing.js";
import { stamp, type DeliveryJobDoc } from "../src/platform/db.js";
import { forgetModuleState } from "../src/platform/module-switch.js";
import { signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>>;
const SHOP = { lat: 17.4486, lng: 78.3908 };
const DROP = { lat: 17.48, lng: 78.42 };
const HERE = { lat: 17.44, lng: 78.38 };

/** Answers like OSRM, with a bend halfway, and records each URL and its headers. */
function fakeOsrm() {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    const [from, to] = new URL(url).pathname.split("/").pop()!.split(";").map((pair) => pair.split(",").map(Number) as [number, number]);
    const bend: [number, number] = [(from![0] + to![0]) / 2 + 0.001, (from![1] + to![1]) / 2];
    return Response.json({ code: "Ok", routes: [{ distance: 2480.4, duration: 401.6, geometry: { type: "LineString", coordinates: [from, bend, to] } }] });
  });
  return calls;
}

describe("delivery routes", () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack?.stop());
  beforeEach(async () => {
    await Promise.all([stack.db.deliveryJobs.deleteMany({}), stack.db.deliveryRoutes.deleteMany({}), stack.db.kycCases.deleteMany({})]);
    await stack.db.moduleSettings.updateOne({ module: "delivery" }, { $set: { live: true } });
    forgetModuleState();
    stack.app.config.googleRoutesKey = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function rider() {
    const user = await signIn(stack);
    await stack.db.kycCases.insertOne({
      _id: new ObjectId(),
      userId: user.userId,
      track: "delivery",
      status: "approved",
      rejections: 0,
      steps: { vehicle: { type: "bike", number: "TS09AB1234", photo: null, at: new Date() } },
      submittedAt: new Date(),
      review: null,
      ...stamp(),
    });
    await stack.db.users.updateOne({ _id: user.userId }, { $set: { name: "Kiran Das", "roles.delivery": true, "kyc.delivery": "approved" } });
    return user;
  }

  async function job(riderId: ObjectId | null, extra: Partial<DeliveryJobDoc> = {}) {
    const doc: DeliveryJobDoc = {
      _id: new ObjectId(),
      orderId: new ObjectId(),
      orderNo: 1001,
      shopId: new ObjectId(),
      vendorId: new ObjectId(),
      carrier: "partner",
      city: "hyderabad",
      riderId,
      placeId: null,
      status: "accepted",
      offerUntil: null,
      pickup: { name: "Rao Prints", phone: "9876543210", line: "4-1, Main Road, Madhapur", city: "Hyderabad", point: SHOP },
      drop: { name: "Ravi Kumar", phone: "9876501234", line: "Flat 302, Green Towers", city: "Hyderabad", pincode: "500084", point: DROP },
      item: "T-shirts × 12",
      itemCount: 12,
      distanceKm: 5,
      pay: 4000,
      dropCode: "1234",
      proof: null,
      passedBy: [],
      codeTries: 0,
      cancel: null,
      timeline: [{ status: "accepted", at: new Date() }],
      ...stamp(),
      ...extra,
    };
    await stack.db.deliveryJobs.insertOne(doc);
    return doc._id.toHexString();
  }

  const route = (u: User | null, id: string, query = "") => stack.app.inject({ url: `/v1/delivery/jobs/${id}/route${query}`, headers: web(u?.token) });
  const at = (p: { lat: number; lng: number }) => `?lat=${p.lat}&lng=${p.lng}`;

  it("routes from the rider to the shop and on to the customer with OSRM, and reuses the routes nearby", async () => {
    const kiran = await rider();
    const id = await job(kiran.userId);
    const calls = fakeOsrm();

    const res = await route(kiran, id, at(HERE));
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.provider).toBe("osrm");
    expect(data.legs).toMatchObject([
      { from: "here", to: "shop", distanceM: 2480, durationS: 402, provider: "osrm" },
      { from: "shop", to: "drop", provider: "osrm" },
    ]);
    expect(data.legs[0].polyline[0]).toEqual([HERE.lat, HERE.lng]);
    expect(data.legs[0].polyline.at(-1)).toEqual([SHOP.lat, SHOP.lng]);
    expect(data.legs[1].polyline).toHaveLength(3);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain(`router.project-osrm.org/route/v1/driving/${HERE.lng},${HERE.lat};${SHOP.lng},${SHOP.lat}?overview=full&geometries=geojson`);
    expect(calls[0]!.headers["User-Agent"]).toMatch(/^ruxstar-api/);

    expect((await route(kiran, id, at({ lat: HERE.lat + 0.0002, lng: HERE.lng }))).json().data.legs).toHaveLength(2);
    expect(calls).toHaveLength(2);
    await route(kiran, id, at({ lat: HERE.lat + 0.01, lng: HERE.lng }));
    expect(calls).toHaveLength(3);
    expect(calls[2]!.url).toContain(`${HERE.lng},${HERE.lat + 0.01};`);

    const saved = await stack.db.deliveryRoutes.findOne({ _id: `${id}:shop-drop` });
    expect(saved).toMatchObject({ provider: "osrm", distanceM: 2480 });
    expect(saved!.expiresAt.getTime() - saved!.createdAt.getTime()).toBe(24 * 60 * 60_000);

    await stack.db.deliveryJobs.updateOne({ _id: new ObjectId(id) }, { $set: { status: "picked_up" } });
    const after = (await route(kiran, id, at(HERE))).json().data;
    expect(after.legs).toMatchObject([{ from: "here", to: "drop" }]);
    expect((await route(kiran, id)).json().data.legs).toMatchObject([{ from: "shop", to: "drop" }]);
  });

  it("draws straight lines at 20 km/h when the router fails, and tries the router again soon", async () => {
    const kiran = await rider();
    const id = await job(kiran.userId);
    vi.stubGlobal("fetch", async () => new Response("busy", { status: 503 }));

    const data = (await route(kiran, id, at(HERE))).json().data;
    expect(data.provider).toBe("straight");
    const metres = Math.round(metresBetween(HERE, SHOP));
    expect(data.legs[0]).toEqual({
      from: "here",
      to: "shop",
      polyline: [
        [HERE.lat, HERE.lng],
        [SHOP.lat, SHOP.lng],
      ],
      distanceM: metres,
      durationS: Math.round(metres / (20_000 / 3600)),
      provider: "straight",
    });
    const saved = await stack.db.deliveryRoutes.findOne({ _id: `${id}:shop-drop` });
    expect(saved!.expiresAt.getTime() - saved!.createdAt.getTime()).toBeLessThanOrEqual(10 * 60_000);

    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await stack.db.deliveryRoutes.deleteMany({});
    expect((await route(kiran, id, at(HERE))).json().data.provider).toBe("straight");
  });

  it("gives up on a router that doesn't answer within 4 seconds", async () => {
    const kiran = await rider();
    const id = await job(kiran.userId, { drop: { name: "Ravi", phone: "1", line: "x", city: "Hyderabad", pincode: "500084", point: null } });
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    const started = Date.now();
    const data = (await route(kiran, id, at(HERE))).json().data;
    expect(Date.now() - started).toBeGreaterThanOrEqual(3900);
    expect(data).toMatchObject({ provider: "straight", legs: [{ from: "here", to: "shop", provider: "straight" }] });
  }, 20_000);

  it("uses Google's Routes API when a key is set", async () => {
    const kiran = await rider();
    const id = await job(kiran.userId);
    stack.app.config.googleRoutesKey = "test-routes-key";
    const calls: { url: string; headers: Record<string, string>; body: { travelMode: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
      return Response.json({ routes: [{ distanceMeters: 3120, duration: "655s", polyline: { encodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" } }] });
    });

    const data = (await route(kiran, id, at(HERE))).json().data;
    expect(data.provider).toBe("google");
    expect(data.legs[0]).toMatchObject({
      distanceM: 3120,
      durationS: 655,
      polyline: [
        [38.5, -120.2],
        [40.7, -120.95],
        [43.252, -126.453],
      ],
    });
    expect(calls[0]!.url).toBe("https://routes.googleapis.com/directions/v2:computeRoutes");
    expect(calls[0]!.headers["X-Goog-Api-Key"]).toBe("test-routes-key");
    expect(calls[0]!.body.travelMode).toBe("TWO_WHEELER");
    expect(decodePolyline("")).toEqual([]);
  });

  it("is only for the rider who has the delivery, while it is under way", async () => {
    const kiran = await rider();
    const asha = await rider();
    const mine = await job(kiran.userId);
    const calls = fakeOsrm();

    expect((await route(null, mine, at(HERE))).statusCode).toBe(401);
    const stranger = await signIn(stack);
    expect((await route(stranger, mine)).json().error.code).toBe("KYC_REQUIRED");
    expect((await route(asha, mine, at(HERE))).json().error.code).toBe("JOB_TAKEN");
    const team = await job(kiran.userId, { carrier: "team" });
    expect((await route(asha, team)).json().error.code).toBe("NOT_FOUND");
    const offer = await job(null, { status: "offered", offerUntil: new Date(Date.now() + 60_000) });
    expect((await route(asha, offer)).json().error.code).toBe("NOT_FOUND");
    const done = await job(kiran.userId, { status: "delivered" });
    expect((await route(kiran, done)).json().error.code).toBe("JOB_TAKEN");
    expect((await route(kiran, new ObjectId().toHexString())).json().error.code).toBe("NOT_FOUND");
    expect(calls).toHaveLength(0);
  });

  it("checks the location it is sent, and ignores 0,0 and missing pins", async () => {
    const kiran = await rider();
    const id = await job(kiran.userId);
    fakeOsrm();

    expect((await route(kiran, id, `?lat=${HERE.lat}`)).json().error).toMatchObject({ code: "VALIDATION_FAILED", details: [{ path: "querystring/lng" }] });
    expect((await route(kiran, id, "?lat=95&lng=78")).statusCode).toBe(400);
    expect((await route(kiran, id, "?lat=17&lng=-181")).statusCode).toBe(400);
    expect((await route(kiran, id, "?lat=north&lng=78")).statusCode).toBe(400);
    expect((await route(kiran, "not-an-id")).statusCode).toBe(400);
    expect((await route(kiran, id, "?lat=0&lng=0")).json().data.legs).toMatchObject([{ from: "shop", to: "drop" }]);

    const unpinned = await job(kiran.userId, { pickup: { name: "Rao Prints", phone: "1", line: "x", city: "Hyderabad", point: { lat: 0, lng: 0 } } });
    expect((await route(kiran, unpinned, at(HERE))).json().data).toEqual({ legs: [], provider: "straight" });
  });
});
