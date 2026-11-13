import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stamp } from "../src/platform/db.js";
import { forgetModuleState } from "../src/platform/module-switch.js";
import { signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>>;

describe("print shops for customers", () => {
  let stack: Stack;
  let customer: User;
  let photo: Buffer;

  beforeAll(async () => {
    stack = await startStack();
    customer = await signIn(stack);
    photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#8a6a40" } }).jpeg().toBuffer();
  });
  afterAll(() => stack?.stop());
  beforeEach(async () => {
    await stack.db.businesses.deleteMany({});
    await setPod(true);
  });

  const call = (method: "GET" | "POST" | "PATCH", url: string, token: string, payload?: object) =>
    stack.app.inject({
      method,
      url: `/v1${url}`,
      headers: web(token, method === "GET" ? {} : { "idempotency-key": randomUUID() }),
      ...(payload ? { payload } : {}),
    });
  const setPod = async (live: boolean) => {
    await stack.db.moduleSettings.updateOne({ module: "pod" }, { $set: { live, signupsOpen: live } });
    forgetModuleState();
  };

  async function vendor() {
    const user = await signIn(stack, { vendor: true });
    await stack.db.users.updateOne({ _id: user.userId }, { $set: { name: "Asha Rao", "kyc.base": "approved" } });
    await stack.db.kycCases.insertOne({
      _id: new ObjectId(),
      userId: user.userId,
      track: "base",
      status: "approved",
      rejections: 0,
      steps: { aadhaar: { status: "verified", verificationId: "v", referenceId: null, name: "Asha Rao", last4: "1234", reason: null, tries: 1, at: new Date() } },
      submittedAt: new Date(),
      review: null,
      ...stamp(),
    });
    return user;
  }

  /** A published print shop. */
  async function shop(owner: User, name: string, setup: object, { city = "Hyderabad", publish = true } = {}) {
    const created = await call("POST", "/vendor/businesses", owner.token, {
      module: "pod",
      type: "print_shop",
      name,
      phone: "9876543210",
      location: { state: "Telangana", city, doorNo: "4-1", street: "Main Road", area: "Madhapur", pincode: "500081" },
    });
    const id = created.json().data.id as string;
    await stack.app.inject({ method: "POST", url: `/v1/vendor/businesses/${id}/photos`, headers: web(owner.token, { "content-type": "image/jpeg" }), payload: photo });
    expect((await call("PATCH", `/vendor/businesses/${id}/pod`, owner.token, setup)).statusCode).toBe(200);
    if (publish) expect((await call("POST", `/vendor/businesses/${id}/publish`, owner.token)).statusCode).toBe(200);
    return id;
  }

  it("lists live shops with their cover, area and lowest price, hiding drafts and shops on hold", async () => {
    const owner = await vendor();
    const tees = await shop(owner, "Rao Tees", {
      products: ["tshirts", "posters"],
      serveAll: true,
      turnaroundDays: 2,
      prices: [
        { product: "tshirts", basePrice: 29_900, tiers: [{ from: 50, unitPrice: 24_900 }] },
        { product: "posters", basePrice: 9_900 },
      ],
    });
    const xerox = await shop(owner, "Copy Corner", { products: ["documents"], cities: ["Hyderabad"], prices: [{ product: "documents", bw: 200, color: 1_000 }] });
    await shop(owner, "Half Done", { products: ["stickers"], serveAll: true, prices: [{ product: "stickers", basePrice: 500 }] }, { publish: false });
    const held = await shop(owner, "Held Prints", { products: ["stickers"], serveAll: true, prices: [{ product: "stickers", basePrice: 500 }] });
    await stack.db.businesses.updateOne({ _id: new ObjectId(held) }, { $set: { suspension: { reason: "Photos of another shop", at: new Date(), by: new ObjectId() } } });

    const res = await call("GET", "/pod/shops", customer.token);
    expect(res.statusCode).toBe(200);
    const cards = res.json().data;
    expect(cards.map((c: { id: string }) => c.id).sort()).toEqual([tees, xerox].sort());
    const card = cards.find((c: { id: string }) => c.id === tees);
    expect(card).toMatchObject({
      name: "Rao Tees",
      typeLabel: "Print on demand",
      area: "Madhapur",
      city: "Hyderabad",
      open: true,
      deliversEverywhere: true,
      fromPrice: 9_900,
      fromUnit: "unit",
      turnaroundDays: 2,
      products: ["tshirts", "posters"],
    });
    expect(card.cover.url).toContain(`business-media/dev/${tees}/`);
    expect(card.cover.smaller.length).toBeGreaterThan(0);
    expect(cards.find((c: { id: string }) => c.id === xerox)).toMatchObject({ fromPrice: 200, fromUnit: "page" });
  });

  it("filters by city, product and name, and puts open shops first", async () => {
    const owner = await vendor();
    const everywhere = await shop(owner, "Rao Tees", { products: ["tshirts"], serveAll: true, prices: [{ product: "tshirts", basePrice: 29_900 }] });
    const local = await shop(owner, "Pune Posters", { products: ["posters"], cities: ["Pune"], prices: [{ product: "posters", basePrice: 9_900 }] }, { city: "Pune" });
    await call("POST", `/vendor/businesses/${everywhere}/close`, owner.token);

    const ids = async (query: string) => (await call("GET", `/pod/shops${query}`, customer.token)).json().data.map((c: { id: string }) => c.id);
    expect(await ids("")).toEqual([local, everywhere]);
    expect(await ids("?city=pune")).toEqual([local, everywhere]);
    expect(await ids("?city=Chennai")).toEqual([everywhere]);
    expect(await ids("?product=posters")).toEqual([local]);
    expect(await ids("?q=tee")).toEqual([everywhere]);
    expect(await ids("?q=(")).toEqual([]);
  });

  it("shows a shop's priced products without its street address or phone", async () => {
    const owner = await vendor();
    const id = await shop(owner, "Rao Tees", {
      products: ["tshirts", "posters"],
      serveAll: false,
      cities: ["Hyderabad", "Secunderabad"],
      minOrder: 50_000,
      notes: "PDF or PNG only",
      prices: [
        { product: "tshirts", basePrice: 29_900, extras: [{ option: "size", value: "XXL", price: 5_000 }] },
        { product: "posters", basePrice: 9_900 },
      ],
    });
    // Unpriced products stop a draft going live, so drop the poster price after publishing to check it stays hidden.
    await stack.db.businesses.updateOne({ _id: new ObjectId(id) }, { $pull: { "pod.prices": { product: "posters" } } });

    const res = await call("GET", `/pod/shops/${id}`, customer.token);
    expect(res.statusCode).toBe(200);
    const page = res.json().data;
    expect(page).toMatchObject({ name: "Rao Tees", pincode: "500081", cities: ["hyderabad", "secunderabad"], minOrder: 50_000, notes: "PDF or PNG only" });
    expect(page.photos).toHaveLength(1);
    expect(page.catalog.map((p: { id: string }) => p.id)).toEqual(["tshirts"]);
    expect(page.catalog[0]).toMatchObject({ basePrice: 29_900, turnaroundDays: 3, extras: [{ option: "size", value: "XXL", price: 5_000 }] });
    expect(page.catalog[0].options.find((o: { option: string }) => o.option === "size").values).toContain("XXL");
    expect(JSON.stringify(page)).not.toContain("9876543210");
    expect(JSON.stringify(page)).not.toContain("Main Road");
  });

  it("hides every shop while print on demand is switched off", async () => {
    const owner = await vendor();
    const id = await shop(owner, "Rao Tees", { products: ["tshirts"], serveAll: true, prices: [{ product: "tshirts", basePrice: 29_900 }] });
    await setPod(false);
    expect((await call("GET", "/pod/shops", customer.token)).json().data).toEqual([]);
    expect((await call("GET", `/pod/shops/${id}`, customer.token)).statusCode).toBe(404);
  });

  it("needs a signed-in person", async () => {
    expect((await stack.app.inject({ method: "GET", url: "/v1/pod/shops", headers: web() })).statusCode).toBe(401);
  });
});
