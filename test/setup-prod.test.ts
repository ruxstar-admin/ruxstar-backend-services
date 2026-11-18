import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { moduleDefaults, setupProd, SetupError, type AdminInput, type SetupOptions } from "../scripts/setup-prod.js";
import { DEFAULT_GST_RULES, DEFAULT_GST_SELLER, GST_MODULES, moduleKey, SELLER_KEY } from "../src/modules/invoices/gst.js";
import { PERMISSIONS } from "../src/modules/ruxstar/permissions.js";
import { DEFAULT_BANNED } from "../src/modules/shop/products.js";
import { DEFAULT_FACILITIES } from "../src/modules/stays/rules.js";
import { DEFAULT_SLA_HOURS, SLA_SETTING } from "../src/modules/support/tickets.js";
import { DEFAULT_SPORTS } from "../src/modules/turf/rules.js";
import { Database, stamp } from "../src/platform/db.js";
import { seedModuleSettings, SWITCHABLE_MODULES } from "../src/platform/indexes.js";
import { startStack, type Stack } from "./helpers.js";

const ADMIN: AdminInput = { phone: "+919876543210", name: "Asha  Rao", username: "asha.rao", password: "harvest2026", email: " Asha@Example.com " };
/** The stack's own database, named the way `--db` would name it, so the app can sign the admin in. */
const DB = "ruxstar_test";
const SLOW = 90_000;

describe("setting up the production database", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack?.stop());
  beforeEach(async () => {
    await stack.db.db.dropDatabase();
  });

  async function setup(options: Partial<SetupOptions> = {}, input: AdminInput = ADMIN, db: Database = stack.db) {
    const lines: string[] = [];
    const result = await setupProd(db, input, { apply: false, resume: false, dbName: DB, log: (line) => lines.push(line), ...options });
    return { ...result, lines };
  }

  async function snapshot(db: Database = stack.db) {
    const collections = await db.db.listCollections({}, { nameOnly: true }).toArray();
    const out: Record<string, { docs: unknown[]; indexes: string[] }> = {};
    for (const { name } of collections.sort((a, b) => a.name.localeCompare(b.name))) {
      const collection = db.db.collection(name);
      out[name] = {
        docs: await collection.find({}).sort({ _id: 1 }).toArray(),
        indexes: (await collection.indexes()).map((i) => i.name!).sort(),
      };
    }
    return out;
  }

  const unstamped = <T extends object>(doc: T) => {
    const { createdAt: _c, updatedAt: _u, ...rest } = doc as T & { createdAt?: Date; updatedAt?: Date };
    return rest;
  };

  it("writes nothing in a dry run, and says what it would write", async () => {
    const { changes, lines } = await setup();
    expect(await snapshot()).toEqual({});
    expect(changes).toBeGreaterThan(SWITCHABLE_MODULES.length);
    expect(lines).toContain("Dry run: nothing is written. Add --apply to write.");
    expect(lines.find((l) => l.startsWith("Indexes:"))).toMatch(/^Indexes: would create \d+ on \d+ collections$/);
    expect(lines).toContain("Admin account: would create +91••••3210 (@asha.rao), admin with every console permission");
    expect(lines).toContain("Module print: would write settings, switched off");
    expect(lines.join("\n")).not.toContain(ADMIN.password);
  });

  it(
    "creates the indexes, the admin with console access, and every module's settings switched off with the app's defaults",
    async () => {
      const { lines } = await setup({ apply: true });
      expect(lines.find((l) => l.startsWith("Indexes:"))).toMatch(/^Indexes: created \d+ on \d+ collections$/);
      const userIndexes = (await stack.db.users.indexes()).map((i) => i.name);
      expect(userIndexes).toEqual(expect.arrayContaining(["phone_1", "username_1", "email_1", "purgeAt_1"]));
      expect((await stack.db.moduleSettings.indexes()).find((i) => i.name === "module_1")?.unique).toBe(true);

      const admin = await stack.db.users.findOne({ phone: "+919876543210" });
      expect(admin).toMatchObject({
        name: "Asha Rao",
        username: "asha.rao",
        email: "asha@example.com",
        emailVerified: false,
        status: "active",
        roles: { admin: true },
        kyc: { base: "none" },
      });
      expect(admin?.passwordHash).toMatch(/^scrypt\$/);
      expect(admin?.passwordHash).not.toContain(ADMIN.password);
      expect(await stack.db.auditLogs.findOne({ action: "admin.grant", "target.id": admin!._id })).toBeTruthy();
      expect(lines).toContain("Admin account: created (+91••••3210, @asha.rao), admin with every console permission");

      const rows = await stack.db.moduleSettings.find({}).toArray();
      expect(rows.map((r) => r.module).sort()).toEqual([...SWITCHABLE_MODULES].sort());
      for (const row of rows) {
        expect(row).toMatchObject(unstamped(moduleDefaults(row.module)));
        expect(row).toMatchObject({ live: false, signupsOpen: false });
      }
      expect(rows.find((r) => r.module === "ledger")).toMatchObject({ payoutFee: 590, minPayout: 10_000 });
      expect(rows.find((r) => r.module === "events")?.eventRules?.refundHours).toBe(24);
      expect(rows.find((r) => r.module === "delivery")?.riderRate).toEqual({ base: 3000, includedKm: 3, perKm: 800 });
      expect(lines).toContain("Module print: settings written, switched off");

      for (const module of GST_MODULES) expect((await stack.db.platformSettings.findOne({ key: moduleKey(module) }))?.value).toEqual(DEFAULT_GST_RULES[module]);
      expect((await stack.db.platformSettings.findOne({ key: SELLER_KEY }))?.value).toEqual(DEFAULT_GST_SELLER);
      expect((await stack.db.platformSettings.findOne({ key: SLA_SETTING }))?.value).toEqual(DEFAULT_SLA_HOURS);
      expect(await stack.db.turfSports.countDocuments()).toBe(DEFAULT_SPORTS.length);
      expect(await stack.db.staysFacilities.countDocuments()).toBe(DEFAULT_FACILITIES.length);
      expect(await stack.db.shopBanned.countDocuments()).toBe(DEFAULT_BANNED.length);
      expect(lines.join("\n")).not.toContain(ADMIN.password);
    },
    SLOW,
  );

  it(
    "lets the admin sign in with the given password and see every module switched off in the console",
    async () => {
      await setup({ apply: true });
      const login = (password: string) =>
        stack.app.inject({ method: "POST", url: "/v1/account/login", headers: { "x-client": "web" }, payload: { phone: "9876543210", password } });
      expect((await login("nottheone1")).statusCode).toBe(401);
      const res = await login(ADMIN.password);
      expect(res.statusCode).toBe(200);
      const rx_at = res.cookies.find((c) => c.name === "rx_at")!.value;
      const get = (url: string) => stack.app.inject({ method: "GET", url: `/v1/ruxstar${url}`, headers: { "x-client": "web" }, cookies: { rx_at } });

      const access = (await get("/access")).json().data;
      expect(access).toMatchObject({ admin: true, title: "Admin" });
      expect(access.permissions).toEqual(PERMISSIONS.map((p) => p.key));

      const modules = (await get("/modules")).json().data as { module: string; live: boolean; signupsOpen: boolean; updatedAt: string }[];
      expect(modules.map((m) => m.module)).toEqual(["pod", "events", "coaching", "stays", "turf", "shop", "gigs", "delivery", "ledger"]);
      expect(modules.every((m) => !m.live && !m.signupsOpen)).toBe(true);
      const gst = (await get("/gst")).json().data as { seller: { updatedAt: string | null }; modules: { updatedAt: string | null }[] };
      expect(gst.seller.updatedAt).not.toBeNull();
      expect(gst.modules.every((m) => m.updatedAt !== null)).toBe(true);
    },
    SLOW,
  );

  it(
    "changes nothing when run again with --resume",
    async () => {
      await setup({ apply: true });
      const before = await snapshot();
      const again = await setup({ apply: true, resume: true });
      expect(again.changes).toBe(0);
      expect(await snapshot()).toEqual(before);
      expect(again.lines).toContain("Admin account: already there (+91••••3210, @asha.rao), left as it is");
      expect(again.lines).toContain("Module print: already there (switched off), nothing to add");
      expect(again.lines.find((l) => l.startsWith("Indexes:"))).toMatch(/^Indexes: all \d+ already there on \d+ collections$/);
      expect(again.lines.at(-1)).toBe("Done: nothing was missing, nothing written.");
    },
    SLOW,
  );

  it("refuses a database with people or orders unless resuming", async () => {
    await stack.db.users.insertOne({ _id: new ObjectId(), phone: "+919800000001", status: "active", roles: {}, kyc: {}, ...stamp() });
    await expect(setup({ apply: true })).rejects.toThrow("Refusing: ruxstar_test already has 1 user and 0 orders. Run with --resume");
    expect(Object.keys(await snapshot())).toEqual(["users"]);

    await stack.db.users.deleteMany({});
    await stack.db.podOrders.insertOne({ _id: new ObjectId() } as never);
    await expect(setup()).rejects.toThrow("already has 0 users and 1 order.");
  });

  it(
    "on --resume fills in only what is missing and keeps every value already stored",
    async () => {
      await seedModuleSettings(stack.db);
      await stack.db.moduleSettings.updateOne({ module: "pod" }, { $set: { live: true, signupsOpen: true, commissionBps: 1500 } });
      await stack.db.moduleSettings.updateOne({ module: "events" }, { $set: { eventRules: { refundHours: 48 } as never } });
      await stack.db.platformSettings.insertOne({ _id: new ObjectId(), key: moduleKey("pod"), value: { tcsBps: 100 }, updatedBy: null, ...stamp() });
      await stack.db.users.insertOne({ _id: new ObjectId(), phone: "+919800000001", status: "active", roles: {}, kyc: {}, ...stamp() });

      const dry = await setup({ resume: true });
      expect(dry.lines).toContain("Module print: already there (live, signups open), would add gstinRequired");
      const { lines } = await setup({ apply: true, resume: true });
      expect(lines).toContain("Module print: already there (live, signups open), added gstinRequired");

      expect(await stack.db.moduleSettings.findOne({ module: "pod" })).toMatchObject({ live: true, signupsOpen: true, commissionBps: 1500, gstinRequired: false });
      expect((await stack.db.moduleSettings.findOne({ module: "events" }))?.eventRules).toEqual({ refundHours: 48, waitlistHours: 2, maxTicketTypes: 5, maxQuestions: 3 });
      expect((await stack.db.platformSettings.findOne({ key: moduleKey("pod") }))?.value).toEqual({ ...DEFAULT_GST_RULES.pod, tcsBps: 100 });
      expect(await stack.db.users.countDocuments({ "roles.admin": true })).toBe(1);
    },
    SLOW,
  );

  it("won't make an existing account admin, or take a username someone has", async () => {
    await stack.db.users.insertOne({ _id: new ObjectId(), phone: "+919876543210", status: "active", roles: {}, kyc: {}, ...stamp() });
    await expect(setup({ resume: true })).rejects.toThrow("Admin account: +91••••3210 already has an account that is not an admin");
    await stack.db.users.updateOne({ phone: "+919876543210" }, { $set: { phone: "+919800000002", username: "asha.rao" } });
    await expect(setup({ resume: true })).rejects.toThrow("@asha.rao is taken");
  });

  it("refuses any database but the one it was told to set up", async () => {
    await expect(setup({ dbName: undefined })).rejects.toThrow("Refusing: the database is ruxstar_test, not ruxstar_prod.");
    await expect(setup({ dbName: "ruxstar_prod", apply: true })).rejects.toThrow(SetupError);
    expect(await snapshot()).toEqual({});

    const prod = new Database(() => stack.db.client, "ruxstar_prod");
    const { lines } = await setup({ dbName: undefined }, ADMIN, prod);
    expect(lines[0]).toBe("Database ruxstar_prod: empty");
    expect(await snapshot(prod)).toEqual({});
  });

  it("checks the admin's details as signup does, without repeating the password", async () => {
    const refusal = (input: AdminInput) =>
      setup({}, input).then(
        () => expect.unreachable(),
        (err: unknown) => {
          expect(err).toBeInstanceOf(SetupError);
          return (err as SetupError).message;
        },
      );
    const bad = { phone: "12345", name: "123456789", username: "ruxstar", password: "9876543210a", email: "not-an-email" };
    const message = await refusal(bad);
    expect(message).toContain("ADMIN_PHONE must be an Indian mobile number");
    expect(message).toContain("ADMIN_NAME: Enter your name, not a number.");
    expect(message).toContain("ADMIN_USERNAME is reserved");
    expect(message).toContain("ADMIN_EMAIL must match format");
    expect(message).not.toContain(bad.password);

    expect(await refusal({ ...ADMIN, password: "harvests" })).toBe("ADMIN_PASSWORD: Use at least one letter and one number.");
    await expect(setup({}, { ...ADMIN, password: "" })).rejects.toThrow("Set ADMIN_PASSWORD.");
  });
});
