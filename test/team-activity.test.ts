import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeAudit } from "../src/platform/audit.js";
import { forgetModuleState } from "../src/platform/module-switch.js";
import { signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>>;
const ADDRESS = { name: "Ravi Kumar", phone: "9876501234", line: "Flat 302, Green Towers, Madhapur", city: "Hyderabad", pincode: "500081" };

describe("business activity", () => {
  let stack: Stack;
  let photo: Buffer;
  let pdf: Buffer;

  beforeAll(async () => {
    stack = await startStack();
    photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#8a6a40" } }).jpeg().toBuffer();
    const doc = await PDFDocument.create();
    doc.addPage();
    pdf = Buffer.from(await doc.save());
  });
  afterAll(() => stack?.stop());
  beforeEach(async () => {
    await Promise.all([
      stack.db.businesses.deleteMany({}),
      stack.db.podOrders.deleteMany({}),
      stack.db.printFiles.deleteMany({}),
      stack.db.ledgerEntries.deleteMany({}),
      stack.db.employments.deleteMany({}),
      stack.db.auditLogs.deleteMany({}),
    ]);
    await stack.db.moduleSettings.updateOne({ module: "pod" }, { $set: { live: true, signupsOpen: true, commissionBps: 1000, platformFee: 500 } });
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
  async function person(opts: { vendor?: boolean; verified?: boolean; name: string }) {
    const user = await signIn(stack, opts.vendor ? { vendor: true } : {});
    const username = `act${Date.now() % 1e6}${n++}`;
    await stack.db.users.updateOne({ _id: user.userId }, { $set: { name: opts.name, username, ...(opts.verified ? { "kyc.base": "approved" } : {}) } });
    return { ...user, username };
  }

  async function teeShop(owner: User) {
    const created = await call("POST", "/vendor/businesses", owner.token, {
      module: "pod",
      type: "print_shop",
      name: "Rao Prints",
      phone: "9876543210",
      location: { state: "Telangana", city: "Hyderabad", doorNo: "4-1", street: "Main Road", area: "Madhapur", pincode: "500081" },
    });
    const id = created.json().data.id as string;
    await stack.app.inject({ method: "POST", url: `/v1/vendor/businesses/${id}/photos`, headers: web(owner.token, { "content-type": "image/jpeg" }), payload: photo });
    await call("PATCH", `/vendor/businesses/${id}/pod`, owner.token, {
      products: ["tshirts"],
      cities: ["Hyderabad"],
      prices: [{ product: "tshirts", basePrice: 30_000 }],
    });
    expect((await call("POST", `/vendor/businesses/${id}/publish`, owner.token)).statusCode).toBe(200);
    return id;
  }

  async function paid(customer: User, shopId: string) {
    const file = (
      await stack.app.inject({
        method: "POST",
        url: "/v1/pod/files",
        headers: web(customer.token, { "content-type": "application/pdf", "x-file-name": "design.pdf" }),
        payload: pdf,
      })
    ).json().data;
    const res = await call("POST", "/pod/orders", customer.token, {
      shopId,
      product: "tshirts",
      options: { size: "M" },
      quantity: 2,
      fileIds: [file.id],
      address: ADDRESS,
      returnTo: "https://ruxstar.com/orders",
    });
    const url = new URL(res.json().data.checkoutUrl);
    await stack.app.inject({ method: "POST", url: `${url.pathname}/test${url.search}` });
    return res.json().data.order as { id: string; orderNo: number };
  }

  it("shows the owner who did what, newest first, naming the team but not customers or Ruxstar", async () => {
    const owner = await person({ vendor: true, verified: true, name: "Asha Rao" });
    const shopId = await teeShop(owner);
    await stack.db.auditLogs.deleteMany({});
    const crew = await person({ verified: true, name: "Kiran Das" });
    const placeId = (await call("POST", `/vendor/businesses/${shopId}/team`, owner.token, { username: crew.username, permissions: ["orders.move", "shop.open"] })).json()
      .data.id as string;
    await call("POST", `/employment/${placeId}/accept`, crew.token);
    const customer = await person({ name: "Ravi Kumar" });
    const first = await paid(customer, shopId);
    const second = await paid(customer, shopId);

    expect((await call("POST", `/employment/orders/${first.id}/status`, crew.token, { status: "accepted" })).statusCode).toBe(200);
    expect((await call("POST", `/employment/${placeId}/shop/close`, crew.token)).statusCode).toBe(200);
    expect((await call("POST", `/pod/orders/${second.id}/cancel`, customer.token)).statusCode).toBe(200);
    await call("PATCH", `/vendor/businesses/${shopId}`, owner.token, { phone: "9876500000", description: "Shirts and mugs" });
    await writeAudit(stack.db, {
      actor: { id: new ObjectId(), kind: "staff" },
      scope: { module: "pod", businessId: new ObjectId(shopId) },
      action: "business.restore",
      target: { type: "business", id: new ObjectId(shopId) },
      ip: "10.0.0.1",
    });

    const res = await call("GET", `/vendor/businesses/${shopId}/activity`, owner.token);
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as { who: { kind: string; name: string; id: string | null }; line: string; orderId: string | null }[];
    expect(rows.map((r) => [r.who.kind, r.who.name, r.line])).toEqual([
      ["ruxstar", "Ruxstar", "Took the business off hold"],
      ["you", "You", "Changed the description and phone number"],
      ["customer", "A customer", `Cancelled order #${second.orderNo}`],
      ["team", "Kiran Das", "Closed the shop"],
      ["team", "Kiran Das", `Accepted order #${first.orderNo}`],
      ["team", "Kiran Das", "Joined the team"],
      ["you", "You", "Invited Kiran Das to the team"],
    ]);
    expect(rows[4]).toMatchObject({ orderId: first.id, who: { id: crew.userId.toHexString() } });
    expect(rows[0]!.who.id).toBeNull();
    expect(rows[2]!.who.id).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("10.0.0.1");

    const theirs = (await call("GET", `/vendor/businesses/${shopId}/activity?by=${crew.userId.toHexString()}&limit=2`, owner.token)).json();
    expect(theirs.data.map((r: { line: string }) => r.line)).toEqual(["Closed the shop", `Accepted order #${first.orderNo}`]);
    const more = (await call("GET", `/vendor/businesses/${shopId}/activity?by=${crew.userId.toHexString()}&cursor=${theirs.meta.nextCursor}`, owner.token)).json();
    expect(more.data.map((r: { line: string }) => r.line)).toEqual(["Joined the team"]);

    expect((await call("GET", `/vendor/businesses/${shopId}/activity`, crew.token)).statusCode).toBe(403);
    const otherVendor = await person({ vendor: true, verified: true, name: "Other" });
    expect((await call("GET", `/vendor/businesses/${shopId}/activity`, otherVendor.token)).statusCode).toBe(404);
  }, 60_000);
});
