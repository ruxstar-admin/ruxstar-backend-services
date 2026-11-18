import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { financialYear, nextInvoiceNumber } from "../src/modules/invoices/gst.js";
import { stamp } from "../src/platform/db.js";
import { forgetModuleState } from "../src/platform/module-switch.js";
import { signIn, startStack, web, type Stack } from "./helpers.js";

type User = Awaited<ReturnType<typeof signIn>>;
const BACK = "https://ruxstar.com/orders";
const ADDRESS = { name: "Ravi Kumar", phone: "9876501234", line: "Flat 302, Green Towers, Madhapur", city: "Hyderabad", pincode: "500081" };
const FY = financialYear(new Date()).slice(2);
const TELANGANA_GSTIN = "36ABCDE1234F1Z5";
const KARNATAKA_GSTIN = "29ABCDE1234F1Z5";
const DAY = 24 * 60 * 60_000;

describe("GST invoices and credit notes", () => {
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
      stack.db.events.deleteMany({}),
      stack.db.eventOrders.deleteMany({}),
      stack.db.eventTickets.deleteMany({}),
      stack.db.ledgerEntries.deleteMany({}),
      stack.db.notifications.deleteMany({}),
      stack.db.invoices.deleteMany({}),
      stack.db.counters.deleteMany({ _id: { $regex: "^invoice:" } }),
      stack.db.platformSettings.deleteMany({ key: { $regex: "^gst\\." } }),
      stack.db.auditLogs.deleteMany({}),
    ]);
    await stack.db.moduleSettings.updateOne({ module: "pod" }, { $set: { live: true, signupsOpen: true, commissionBps: 1000, platformFee: 500 } });
    await stack.db.moduleSettings.updateOne({ module: "events" }, { $set: { live: true, signupsOpen: true, commissionBps: 1000, platformFee: 500 } });
    forgetModuleState();
  });

  const call = (method: "GET" | "POST" | "PATCH", url: string, token: string, payload?: object) =>
    stack.app.inject({
      method,
      url: `/v1${url}`,
      headers: web(token, method === "GET" ? {} : { "idempotency-key": randomUUID() }),
      ...(payload ? { payload } : {}),
    });

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

  const registered = (businessId: string, number = TELANGANA_GSTIN) =>
    stack.db.businesses.updateOne({ _id: new ObjectId(businessId) }, { $set: { gstin: { number, legalName: "Rao Prints Private Limited", status: "Active" } } });

  async function teeShop(owner: User, gstin: string | null = TELANGANA_GSTIN) {
    const created = await call("POST", "/vendor/businesses", owner.token, {
      module: "pod",
      type: "print_shop",
      name: "Rao Prints",
      phone: "9876543210",
      location: { state: "Telangana", city: "Hyderabad", doorNo: "4-1", street: "Main Road", area: "Madhapur", pincode: "500081" },
    });
    const id = created.json().data.id as string;
    await stack.app.inject({ method: "POST", url: `/v1/vendor/businesses/${id}/photos`, headers: web(owner.token, { "content-type": "image/jpeg" }), payload: photo });
    const setup = {
      products: ["tshirts"],
      cities: ["Hyderabad"],
      prices: [{ product: "tshirts", basePrice: 30_000, extras: [{ option: "size", value: "XXL", price: 5_000 }], tiers: [{ from: 10, unitPrice: 25_000 }] }],
    };
    expect((await call("PATCH", `/vendor/businesses/${id}/pod`, owner.token, setup)).statusCode).toBe(200);
    expect((await call("POST", `/vendor/businesses/${id}/publish`, owner.token)).statusCode).toBe(200);
    if (gstin) await registered(id, gstin);
    return id;
  }

  /** Twelve XXL tees at ₹300 each, so ₹3,600 plus the ₹5 platform fee, paid. */
  async function paidOrder(customer: User, shopId: string) {
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
      options: { size: "XXL" },
      quantity: 12,
      fileIds: [file.id],
      address: ADDRESS,
      returnTo: BACK,
    });
    expect(res.statusCode).toBe(201);
    const { order, checkoutUrl } = res.json().data as { order: { id: string; orderNo: number }; checkoutUrl: string };
    const url = new URL(checkoutUrl);
    const test = await stack.app.inject({ method: "POST", url: `${url.pathname}/test${url.search}` });
    expect(test.json()).toEqual({ status: "placed" });
    return order;
  }

  const invoicesOf = (orderId: string) => stack.db.invoices.find({ "source.id": new ObjectId(orderId) }).sort({ issuedAt: 1, _id: 1 }).toArray();

  async function staff(permissions = ["orders.view", "modules.view", "modules.manage"]) {
    const user = await signIn(stack, { ruxstarStaff: true });
    await stack.db.ruxstarStaff.insertOne({ _id: new ObjectId(), userId: user.userId, title: "Finance", modules: [], permissions, grantedBy: user.userId, status: "active", ...stamp() });
    return user;
  }

  it("issues the shop's tax invoice and Ruxstar's fee document when an order is paid, with CGST and SGST in the same state", async () => {
    const owner = await vendor();
    const shopId = await teeShop(owner);
    const customer = await signIn(stack);
    const order = await paidOrder(customer, shopId);

    const [sale, fee] = await invoicesOf(order.id);
    expect(sale).toMatchObject({
      kind: "tax_invoice",
      number: `INV/${FY}/00001`,
      issuer: "vendor",
      role: "supply",
      module: "pod",
      seller: { name: "Rao Prints", gstin: TELANGANA_GSTIN, state: "Telangana", stateCode: "36" },
      buyer: { name: "Ravi Kumar", state: "Telangana", stateCode: "36" },
      operator: { name: "Ruxstar", gstin: null },
      placeOfSupply: { state: "Telangana", code: "36" },
      supply: "intra",
      operatorPays: false,
      lines: [{ code: "6109", codeKind: "hsn", quantity: 12, unitPrice: 30_000, rateBps: 500, taxable: 342_857, cgst: 8_571, sgst: 8_572, igst: 0, total: 360_000 }],
      totals: { taxable: 342_857, cgst: 8_571, sgst: 8_572, igst: 0, tax: 17_143, total: 360_000, payable: 360_000 },
      tcs: { rateBps: 50, amount: 1_714 },
    });
    // Ruxstar has no GSTIN until the console sets one, so its fee document is a bill of supply.
    expect(fee).toMatchObject({ kind: "bill_of_supply", number: `RXB/${FY}/00001`, issuer: "ruxstar", role: "fee", lines: [{ code: "998599", rateBps: 0, total: 500 }] });

    const mine = (await call("GET", `/pod/orders/${order.id}`, customer.token)).json().data;
    expect(mine.invoices).toMatchObject([
      { id: sale!._id.toHexString(), kind: "tax_invoice", number: `INV/${FY}/00001`, role: "supply", total: 360_000, refundId: null },
      { id: fee!._id.toHexString(), kind: "bill_of_supply", role: "fee", total: 500 },
    ]);

    const view = (await call("GET", `/account/invoices/${sale!._id}`, customer.token)).json().data;
    expect(view).toMatchObject({ number: `INV/${FY}/00001`, order: { type: "pod_order", id: order.id, orderNo: order.orderNo }, tcs: null });
    expect(view.number.length).toBeLessThanOrEqual(16);
    const list = (await call("GET", `/account/invoices?orderId=${order.id}`, customer.token)).json().data;
    expect(list.map((i: { number: string }) => i.number)).toEqual([`RXB/${FY}/00001`, `INV/${FY}/00001`]);
    expect((await call("GET", `/account/invoices/${sale!._id}`, (await signIn(stack)).token)).statusCode).toBe(404);
  });

  it("uses IGST when the seller is registered in another state, and a bill of supply when it has no GSTIN", async () => {
    const owner = await vendor();
    const customer = await signIn(stack);
    const across = await teeShop(owner, KARNATAKA_GSTIN);
    const [inter] = await invoicesOf((await paidOrder(customer, across)).id);
    expect(inter).toMatchObject({
      kind: "tax_invoice",
      seller: { state: "Karnataka", stateCode: "29" },
      placeOfSupply: { state: "Telangana", code: "36" },
      supply: "inter",
      totals: { taxable: 342_857, cgst: 0, sgst: 0, igst: 17_143, total: 360_000 },
    });

    const unregistered = await teeShop(owner, null);
    const [bill] = await invoicesOf((await paidOrder(customer, unregistered)).id);
    expect(bill).toMatchObject({
      kind: "bill_of_supply",
      number: `BOS/${FY}/00001`,
      seller: { gstin: null, state: "Telangana" },
      lines: [{ rateBps: 0, taxable: 360_000, cgst: 0, sgst: 0, igst: 0, total: 360_000 }],
      totals: { tax: 0, total: 360_000 },
      tcs: null,
    });
    expect(bill!.notes).toContain("Bill of supply: no GST is charged on it.");
  });

  it("numbers each seller's documents consecutively, and never twice even when issued at the same moment", async () => {
    const owner = await vendor();
    const first = await teeShop(owner);
    const second = await teeShop(owner);
    const customer = await signIn(stack);
    const a = await paidOrder(customer, first);
    const b = await paidOrder(customer, first);
    const c = await paidOrder(customer, second);
    const numbers = async (id: string) => (await invoicesOf(id)).map((d) => d.number);
    expect(await numbers(a.id)).toEqual([`INV/${FY}/00001`, `RXB/${FY}/00001`]);
    expect(await numbers(b.id)).toEqual([`INV/${FY}/00002`, `RXB/${FY}/00002`]);
    expect(await numbers(c.id)).toEqual([`INV/${FY}/00001`, `RXB/${FY}/00003`]);

    const series = "invoice:ruxstar:TEST:race";
    const issued = await Promise.all(
      Array.from({ length: 8 }, () => stack.db.transaction((session) => nextInvoiceNumber(stack.db, series, "TST", "2026-27", session))),
    );
    expect(issued.sort()).toEqual(Array.from({ length: 8 }, (_, i) => `TST/26-27/0000${i + 1}`));
    await stack.db.counters.deleteOne({ _id: series });
  });

  it("issues a credit note for a partial refund and for a full one, against the right invoice", async () => {
    const owner = await vendor();
    const shopId = await teeShop(owner);
    const customer = await signIn(stack);

    const kept = await paidOrder(customer, shopId);
    await call("POST", `/vendor/orders/${kept.id}/status`, owner.token, { status: "accepted" });
    const part = await call("POST", `/vendor/orders/${kept.id}/refund`, owner.token, { amount: 50_000, reason: "Two shirts misprinted" });
    expect(part.statusCode).toBe(200);
    const [sale, , partNote] = await invoicesOf(kept.id);
    expect(partNote).toMatchObject({
      kind: "credit_note",
      number: `CN/${FY}/00001`,
      issuer: "vendor",
      role: "supply",
      against: { id: sale!._id, number: `INV/${FY}/00001` },
      refund: { id: `rf_${kept.id}_1`, reason: "Two shirts misprinted" },
      lines: [{ rateBps: 500, taxable: 47_619, cgst: 1_190, sgst: 1_191, total: 50_000 }],
      totals: { total: 50_000, tax: 2_381 },
      tcs: { rateBps: 50, amount: 238 },
    });
    expect(sale!.credited).toBe(50_000);
    expect(part.json().data.invoices.at(-1)).toMatchObject({ kind: "credit_note", refundId: `rf_${kept.id}_1`, total: 50_000 });

    const statement = (await call("GET", "/vendor/payments/statement", owner.token)).json().data;
    expect(statement.find((l: { kind: string }) => l.kind === "refund").invoice).toMatchObject({ id: partNote!._id.toHexString(), number: `CN/${FY}/00001` });
    expect(statement.find((l: { kind: string }) => l.kind === "paid").invoice).toMatchObject({ id: sale!._id.toHexString(), kind: "tax_invoice" });

    const turnedDown = await paidOrder(customer, shopId);
    await call("POST", `/vendor/orders/${turnedDown.id}/status`, owner.token, { status: "rejected", reason: "Out of XXL white shirts" });
    const docs = await invoicesOf(turnedDown.id);
    expect(docs.map((d) => [d.kind, d.number, d.totals.total])).toEqual([
      ["tax_invoice", `INV/${FY}/00002`, 360_000],
      ["bill_of_supply", `RXB/${FY}/00002`, 500],
      ["credit_note", `CN/${FY}/00002`, 360_000],
      ["credit_note", `RXC/${FY}/00001`, 500],
    ]);
    expect(docs[2]).toMatchObject({ lines: docs[0]!.lines, against: { number: `INV/${FY}/00002` }, refund: { reason: "Out of XXL white shirts" } });
    expect(await stack.db.invoices.countDocuments({ _id: { $in: [docs[0]!._id, docs[1]!._id] }, $expr: { $eq: ["$credited", "$totals.total"] } })).toBe(2);
  });

  it("invoices event tickets on confirmation, exempts cheap shows, and credits a cancellation", async () => {
    const owner = await vendor();
    const bizId = new ObjectId();
    await stack.db.businesses.insertOne({
      _id: bizId,
      ownerId: owner.userId,
      module: "events",
      type: "concert",
      name: "Live Arena",
      description: null,
      phone: "9876543210",
      location: { state: "Telangana", city: "Hyderabad", doorNo: "4-1", street: "Main Road", area: "Madhapur", pincode: "500081" },
      pod: null,
      gstin: { number: TELANGANA_GSTIN, legalName: "Live Arena LLP", status: "Active" },
      photos: [],
      status: "live",
      open: true,
      publishedAt: new Date(),
      ...stamp(),
    } as never);
    const event = async (price: number) => {
      const created = await call("POST", `/vendor/businesses/${bizId}/events`, owner.token, {
        title: "Sunburn Nights",
        description: "An evening of live music.",
        kind: "show",
        venue: { name: "Shilpakala Vedika", address: "Madhapur, near Hitech City", city: "Hyderabad" },
        online: null,
        startsAt: new Date(Date.now() + 3 * DAY).toISOString(),
        endsAt: new Date(Date.now() + 3 * DAY + 4 * 60 * 60_000).toISOString(),
        team: null,
        tiers: [{ name: "General", price, capacity: 100 }],
        questions: [],
        refunds: "standard",
      });
      const id = created.json().data.id as string;
      return (await call("POST", `/vendor/events/${id}/publish`, owner.token)).json().data as { id: string; tiers: { id: string }[] };
    };
    const customer = await signIn(stack);
    await stack.db.users.updateOne({ _id: customer.userId }, { $set: { name: "Kiran Das" } });
    const buy = async (ev: { id: string; tiers: { id: string }[] }) => {
      const res = await call("POST", `/events/${ev.id}/tickets`, customer.token, {
        tickets: [{ tierId: ev.tiers[0]!.id, name: "Kiran Das", phone: "9876512345" }],
        returnTo: "https://ruxstar.com/tickets",
      });
      const { order, checkoutUrl } = res.json().data;
      const url = new URL(checkoutUrl);
      expect((await stack.app.inject({ method: "POST", url: `${url.pathname}/test${url.search}` })).json()).toEqual({ status: "confirmed" });
      return order as { id: string };
    };

    const order = await buy(await event(100_000));
    const [sale, fee] = await invoicesOf(order.id);
    expect(sale).toMatchObject({
      kind: "tax_invoice",
      number: `INV/${FY}/00001`,
      module: "events",
      buyer: { name: "Kiran Das" },
      placeOfSupply: { state: "Telangana" },
      supply: "intra",
      lines: [{ code: "9996", codeKind: "sac", quantity: 1, unitPrice: 100_000, rateBps: 1800, taxable: 84_746, cgst: 7_627, sgst: 7_627 }],
    });
    expect(fee).toMatchObject({ role: "fee", totals: { total: 500 } });
    const view = (await call("GET", `/events/orders/${order.id}`, customer.token)).json().data;
    expect(view.invoices).toMatchObject([{ number: `INV/${FY}/00001` }, { role: "fee" }]);

    expect((await call("POST", `/events/orders/${order.id}/cancel`, customer.token)).statusCode).toBe(200);
    const notes = (await invoicesOf(order.id)).filter((d) => d.kind === "credit_note");
    expect(notes.map((n) => [n.number, n.totals.total])).toEqual([
      [`CN/${FY}/00001`, 100_000],
      [`RXC/${FY}/00001`, 500],
    ]);
    expect((await call("GET", `/events/orders/${order.id}`, customer.token)).json().data.invoices).toHaveLength(4);

    const [cheap] = await invoicesOf((await buy(await event(50_000))).id);
    expect(cheap).toMatchObject({ kind: "bill_of_supply", number: `BOS/${FY}/00001`, lines: [{ rateBps: 0, total: 50_000 }], totals: { tax: 0 } });
  });

  it("lets the console change GST settings, audited, without touching documents already issued", async () => {
    const admin = await staff();
    const owner = await vendor();
    const shopId = await teeShop(owner);
    const customer = await signIn(stack);
    const before = await paidOrder(customer, shopId);

    const settings = (await call("GET", "/ruxstar/gst", admin.token)).json().data;
    expect(settings.seller).toMatchObject({ legalName: "Ruxstar", gstin: null, feeCode: "998599", feeRateBps: 1800, updatedAt: null });
    expect(settings.modules.map((m: { module: string }) => m.module)).toEqual(["pod", "events", "coaching", "stays", "turf", "ecommerce", "gigs"]);
    expect(settings.modules[0]).toMatchObject({ enabled: true, seller: "vendor", withoutGstin: "bill_of_supply", pricesIncludeTax: true, tcsBps: 50 });

    const items = settings.modules[0].items.map((i: { key: string }) => (i.key === "tshirts" ? { ...i, rateBps: 1200, lowRate: null } : i));
    const changed = await call("PATCH", "/ruxstar/gst/modules/pod", admin.token, { items, tcsBps: 100 });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().data).toMatchObject({ tcsBps: 100, updatedAt: expect.any(String) });
    expect((await call("PATCH", "/ruxstar/gst/modules/pod", admin.token, { pricesIncludeTax: false })).statusCode).toBe(400);
    expect((await call("PATCH", "/ruxstar/gst/modules/pod", admin.token, { items: [{ ...items[0], key: "rockets" }] })).statusCode).toBe(400);

    const seller = await call("PATCH", "/ruxstar/gst/seller", admin.token, {
      legalName: "Ruxstar Technologies Private Limited",
      gstin: "36AAACR1234A1Z5",
      address: { line: "Plot 12, Hitech City", city: "Hyderabad", state: "telangana", pincode: "500081" },
    });
    expect(seller.statusCode).toBe(200);
    expect(seller.json().data).toMatchObject({ gstin: "36AAACR1234A1Z5", address: { state: "Telangana" } });
    const wrongState = await call("PATCH", "/ruxstar/gst/seller", admin.token, { gstin: KARNATAKA_GSTIN });
    expect(wrongState.json().error).toMatchObject({ code: "VALIDATION_FAILED", details: [{ path: "body/address/state" }] });

    const audits = await stack.db.auditLogs.find({ action: { $in: ["gst.module_update", "gst.seller_update"] } }).sort({ _id: 1 }).toArray();
    expect(audits.map((a) => [a.action, a.target])).toEqual([
      ["gst.module_update", { type: "platform_setting", id: "gst.module.pod" }],
      ["gst.seller_update", { type: "platform_setting", id: "gst.seller" }],
    ]);
    expect(Object.keys(audits[0]!.diff ?? {})).toEqual(expect.arrayContaining(["items", "tcsBps"]));
    const viewer = await staff(["orders.view"]);
    expect((await call("PATCH", "/ruxstar/gst/modules/pod", viewer.token, { tcsBps: 0 })).statusCode).toBe(403);

    const after = await paidOrder(customer, shopId);
    const [oldSale] = await invoicesOf(before.id);
    const [newSale, newFee] = await invoicesOf(after.id);
    expect(oldSale).toMatchObject({ lines: [{ rateBps: 500 }], tcs: { rateBps: 50 }, operator: { gstin: null } });
    expect(newSale).toMatchObject({ lines: [{ rateBps: 1200 }], tcs: { rateBps: 100 }, operator: { name: "Ruxstar Technologies Private Limited", gstin: "36AAACR1234A1Z5" } });
    expect(newFee).toMatchObject({
      kind: "tax_invoice",
      number: `RXI/${FY}/00001`,
      seller: { gstin: "36AAACR1234A1Z5", state: "Telangana" },
      lines: [{ rateBps: 1800, taxable: 424, cgst: 38, sgst: 38, total: 500 }],
    });

    const found = (await call("GET", `/ruxstar/invoices?number=${encodeURIComponent(`RXI/${FY}/00001`)}`, admin.token)).json().data;
    expect(found).toMatchObject([{ id: newFee!._id.toHexString(), tcs: null }]);
    expect((await call("GET", `/ruxstar/invoices/${newSale!._id}`, admin.token)).json().data.tcs).toMatchObject({ rateBps: 100 });
  });

  it("serves invoices as PDFs to the customer, by signed link, and to the shop, with a CSV for its returns", async () => {
    const owner = await vendor();
    const shopId = await teeShop(owner);
    const customer = await signIn(stack);
    const order = await paidOrder(customer, shopId);
    const [sale, fee] = await invoicesOf(order.id);

    const file = await call("GET", `/account/invoices/${sale!._id}/pdf`, customer.token);
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("application/pdf");
    expect(file.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await PDFDocument.load(file.rawPayload)).getPageCount()).toBe(1);

    const { pdfUrl } = (await call("GET", `/account/invoices/${sale!._id}`, customer.token)).json().data;
    const link = new URL(pdfUrl);
    const opened = await stack.app.inject({ method: "GET", url: link.pathname + link.search });
    expect(opened.statusCode).toBe(200);
    expect(opened.headers["content-type"]).toBe("application/pdf");
    link.searchParams.set("t", "forged");
    expect((await stack.app.inject({ method: "GET", url: link.pathname + link.search })).statusCode).toBe(401);

    const theirs = (await call("GET", "/vendor/invoices", owner.token)).json().data;
    expect(theirs).toMatchObject([{ id: sale!._id.toHexString(), tcs: { amount: 1_714 } }]);
    expect((await call("GET", `/vendor/invoices/${fee!._id}`, owner.token)).statusCode).toBe(404);
    expect((await call("GET", `/vendor/invoices/${sale!._id}/pdf`, owner.token)).headers["content-type"]).toBe("application/pdf");
    expect((await call("GET", "/vendor/invoices", (await vendor()).token)).json().data).toEqual([]);

    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const csv = await call("GET", `/vendor/invoices/export?from=${today}&to=${today}`, owner.token);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    const rows = csv.body.replace(/^\ufeff/, "").trim().split("\r\n");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain(`INV/${FY}/00001`);
    expect(rows[1]).toContain("3428.57");
    expect((await call("GET", `/vendor/invoices/export?from=${today}&to=2020-01-01`, owner.token)).statusCode).toBe(400);
  });
});
