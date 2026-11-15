/**
 * Makes a new, empty production database ready for day one: every index, the Ruxstar admin, and every module's settings
 * switched off with the defaults the app uses, so the console shows them before anything goes live.
 *
 *   npm run setup:prod                      dry run: prints what it would write
 *   npm run setup:prod -- --apply           writes it
 *   npm run setup:prod -- --apply --resume  fills in only what is missing on a database already in use
 *
 * Reads MONGODB_URI and MONGODB_DB, and ADMIN_PHONE, ADMIN_NAME, ADMIN_USERNAME, ADMIN_PASSWORD and optionally ADMIN_EMAIL.
 * Writes only to ruxstar_prod, or the database named with --db <name>, which must also be MONGODB_DB.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MongoClient, MongoServerError, ObjectId, type Db } from "mongodb";
import { Value } from "typebox/value";
import { ConfigError, loadConfig } from "../src/config.js";
import { Phone, SignupBody } from "../src/modules/account/contracts.js";
import { checkName, TERMS_VERSION } from "../src/modules/account/index.js";
import { checkPasswordRules, hashPassword } from "../src/modules/account/passwords.js";
import { isAvailable, isReserved } from "../src/modules/account/usernames.js";
import { DEFAULT_COACHING_RULES } from "../src/modules/coaching/rules.js";
import { BUSINESS_MODULES, DEFAULT_OFFER_MINUTES, DEFAULT_RIDER_RATE, DEFAULT_SHOP_FEE_MAX } from "../src/modules/delivery/rates.js";
import { DEFAULT_EVENT_RULES } from "../src/modules/events/rules.js";
import { DEFAULT_GST_RULES, DEFAULT_GST_SELLER, GST_MODULES, moduleKey, SELLER_KEY } from "../src/modules/invoices/gst.js";
import { PAYOUT_MODULES } from "../src/modules/ruxstar/index.js";
import { DEFAULT_BANNED, loadBanned } from "../src/modules/shop/products.js";
import { DEFAULT_SHOP_RULES } from "../src/modules/shop/rules.js";
import { DEFAULT_FACILITIES, DEFAULT_STAYS_RULES } from "../src/modules/stays/rules.js";
import { loadFacilities } from "../src/modules/stays/views.js";
import { DEFAULT_SLA_HOURS, SLA_SETTING } from "../src/modules/support/tickets.js";
import { DEFAULT_SPORTS, DEFAULT_TURF_RULES } from "../src/modules/turf/rules.js";
import { loadSports } from "../src/modules/turf/views.js";
import { DEFAULT_MIN_PAYOUT, DEFAULT_PAYOUT_FEE } from "../src/modules/vendor/payouts.js";
import { writeAudit } from "../src/platform/audit.js";
import { Database, stamp, type ModuleSettingsDoc, type SwitchableModule, type UserDoc } from "../src/platform/db.js";
import { AppError } from "../src/platform/errors.js";
import { ensurePlatformIndexes, newModuleSettings, SWITCHABLE_MODULES } from "../src/platform/indexes.js";

export const PROD_DB = "ruxstar_prod";

export interface AdminInput {
  phone: string;
  name: string;
  username: string;
  password: string;
  email?: string | null;
}

export interface SetupOptions {
  /** Without it nothing is written. */
  apply: boolean;
  /** Carry on with a database that already has people or orders, filling in only what is missing. */
  resume: boolean;
  /** The only database it will touch; ruxstar_prod unless --db names another. */
  dbName?: string;
  log?: (line: string) => void;
}

export interface SetupResult {
  /** Indexes and rows written, or that a dry run would write. */
  changes: number;
}

/** A refusal or a bad input. Its message is safe to print. */
export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

interface Run {
  db: Database;
  apply: boolean;
  log: (line: string) => void;
  changes: number;
}

const LABELS: Partial<Record<string, string>> = { pod: "print", ecommerce: "shop" };
const labelOf = (module: string) => LABELS[module] ?? module;
const maskPhone = (phone: string) => `+91••••${phone.slice(-4)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const ENV_OF: Record<string, string> = { "/name": "ADMIN_NAME", "/username": "ADMIN_USERNAME", "/password": "ADMIN_PASSWORD", "/email": "ADMIN_EMAIL" };

type CheckedAdmin = Omit<AdminInput, "email"> & { email: string | null };

/** The admin's details, held to the rules signup uses. The phone comes back in E.164. */
export function checkAdmin(input: AdminInput): CheckedAdmin {
  const phone = `+91${input.phone.trim().replace(/^\+91/, "")}`;
  const name = input.name.trim().replace(/\s+/g, " ");
  const username = input.username.trim();
  const email = input.email?.trim().toLowerCase() || null;
  const problems: string[] = [];
  for (const [env, value] of [["ADMIN_PHONE", input.phone], ["ADMIN_NAME", name], ["ADMIN_USERNAME", username], ["ADMIN_PASSWORD", input.password]]) {
    if (!value?.trim()) problems.push(`Set ${env}.`);
  }
  if (problems.length) throw new SetupError(problems.join("\n"));

  if (!Value.Check(Phone, phone.slice(3))) problems.push("ADMIN_PHONE must be an Indian mobile number: 10 digits starting with 6 to 9, with or without +91.");
  const body = { verificationToken: "-", name, password: input.password, acceptTerms: true, username, ...(email ? { email } : {}) };
  for (const error of Value.Errors(SignupBody, body)) problems.push(`${ENV_OF[error.instancePath] ?? error.instancePath} ${error.message}.`);
  if (isReserved(username)) problems.push("ADMIN_USERNAME is reserved. Try another.");
  for (const [env, check] of [["ADMIN_NAME", () => checkName(name)], ["ADMIN_PASSWORD", () => checkPasswordRules(input.password, phone)]] as const) {
    try {
      check();
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      problems.push(...err.details.map((d) => `${env}: ${d.message}`));
    }
  }
  if (problems.length) throw new SetupError(problems.join("\n"));
  return { phone, name, username, password: input.password, email };
}

/**
 * Prepares `db` and returns how many indexes and rows it wrote, or would write in a dry run. Throws SetupError when it
 * refuses. Never changes a value that is already stored.
 */
export async function setupProd(db: Database, input: AdminInput, options: SetupOptions): Promise<SetupResult> {
  const expected = options.dbName ?? PROD_DB;
  const name = db.db.databaseName;
  if (name !== expected) throw new SetupError(`Refusing: the database is ${name}, not ${expected}.`);
  const admin = checkAdmin(input);
  const run: Run = { db, apply: options.apply, log: options.log ?? (() => undefined), changes: 0 };

  const users = await db.users.estimatedDocumentCount();
  const orderCounts = await Promise.all(
    [db.podOrders, db.eventOrders, db.coachingOrders, db.turfBookings, db.staysReservations, db.shopOrders].map((c) => c.estimatedDocumentCount()),
  );
  const orders = orderCounts.reduce((sum, n) => sum + n, 0);
  const inUse = users > 0 || orders > 0;
  const found = `${plural(users, "user")} and ${plural(orders, "order")}`;
  if (inUse && !options.resume) throw new SetupError(`Refusing: ${name} already has ${found}. Run with --resume to fill in only what is missing.`);
  run.log(`Database ${name}: ${inUse ? `${found}, so only what is missing is filled in` : "empty"}`);
  run.log(run.apply ? "Writing." : "Dry run: nothing is written. Add --apply to write.");

  const step = async (label: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      if (err instanceof SetupError) throw err;
      throw new Error(`${label}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`, { cause: err });
    }
  };
  await step("Indexes", () => indexStep(run));
  await step("Admin account", () => adminStep(run, admin));
  for (const module of SWITCHABLE_MODULES) await step(`Module ${labelOf(module)}`, () => moduleStep(run, module));
  for (const module of GST_MODULES) {
    const label = `GST ${labelOf(module)}`;
    await step(label, () => settingStep(run, label, moduleKey(module), DEFAULT_GST_RULES[module], "default rules"));
  }
  await step("GST seller", () => settingStep(run, "GST seller", SELLER_KEY, DEFAULT_GST_SELLER, "Ruxstar's details (no GSTIN or address yet)"));
  const sla = Object.entries(DEFAULT_SLA_HOURS).map(([priority, hours]) => `${priority} ${hours}h`).join(", ");
  await step("Support reply-by times", () => settingStep(run, "Support reply-by times", SLA_SETTING, DEFAULT_SLA_HOURS, `the defaults (${sla})`));
  const lists = [
    { label: "Turf sports", defaults: DEFAULT_SPORTS.length, count: () => db.turfSports.estimatedDocumentCount(), load: () => loadSports(db) },
    { label: "Stays facilities", defaults: DEFAULT_FACILITIES.length, count: () => db.staysFacilities.estimatedDocumentCount(), load: () => loadFacilities(db) },
    { label: "Banned shop words", defaults: DEFAULT_BANNED.length, count: () => db.shopBanned.estimatedDocumentCount(), load: () => loadBanned(db) },
  ];
  for (const list of lists) await step(list.label, () => listStep(run, list.label, list.defaults, list.count, list.load));

  if (!run.apply) run.log(`Dry run done: ${run.changes} things to write. Run again with --apply to write them.`);
  else if (run.changes) run.log(`Done: ${run.changes} things written. Every module is switched off until you switch it on in the console.`);
  else run.log("Done: nothing was missing, nothing written.");
  return { changes: run.changes };
}

interface PlannedIndex {
  collection: string;
  name: string;
}

/** The app's own index list, run against a stand-in that notes each index instead of building it. */
async function plannedIndexes(): Promise<PlannedIndex[]> {
  const planned = new Map<string, PlannedIndex>();
  const collection = (name: string) => ({
    createIndex: async (keys: Record<string, number>, options?: { name?: string }) => {
      const index = options?.name ?? Object.entries(keys).map(([field, order]) => `${field}_${order}`).join("_");
      planned.set(`${name}.${index}`, { collection: name, name: index });
      return index;
    },
    indexes: async () => [],
    dropIndex: async () => undefined,
  });
  await ensurePlatformIndexes(Object.assign(Object.create(Database.prototype) as Database, { db: { collection } as unknown as Db }));
  return [...planned.values()];
}

async function missingIndexes(db: Database, planned: PlannedIndex[]): Promise<PlannedIndex[]> {
  const missing: PlannedIndex[] = [];
  for (const collection of new Set(planned.map((p) => p.collection))) {
    const existing = await db.db
      .collection(collection)
      .indexes()
      .catch((err: unknown) => {
        if (err instanceof MongoServerError && err.code === 26) return [];
        throw err;
      });
    const names = new Set(existing.map((i) => i.name));
    missing.push(...planned.filter((p) => p.collection === collection && !names.has(p.name)));
  }
  return missing;
}

const collectionCount = (indexes: PlannedIndex[]) => new Set(indexes.map((i) => i.collection)).size;

async function indexStep(run: Run): Promise<void> {
  const planned = await plannedIndexes();
  const missing = await missingIndexes(run.db, planned);
  const already = planned.length - missing.length;
  const also = already ? ` (${already} already there)` : "";
  if (!missing.length) return run.log(`Indexes: all ${planned.length} already there on ${collectionCount(planned)} collections`);
  run.changes += missing.length;
  if (!run.apply) return run.log(`Indexes: would create ${missing.length} on ${collectionCount(missing)} collections${also}`);
  await ensurePlatformIndexes(run.db);
  const left = await missingIndexes(run.db, planned);
  if (left.length) throw new SetupError(`Indexes: ${left.length} still missing after building them: ${left.map((i) => `${i.collection}.${i.name}`).join(", ")}`);
  run.log(`Indexes: created ${missing.length} on ${collectionCount(missing)} collections${also}`);
}

async function adminStep(run: Run, admin: CheckedAdmin): Promise<void> {
  const { db } = run;
  const masked = maskPhone(admin.phone);
  const existing = await db.users.findOne({ phone: admin.phone }, { projection: { roles: 1, status: 1, username: 1 } });
  if (existing) {
    if (existing.status === "deleted") throw new SetupError(`Admin account: ${masked} belongs to a deleted account. Use another ADMIN_PHONE.`);
    if (!existing.roles?.admin) {
      throw new SetupError(`Admin account: ${masked} already has an account that is not an admin. It is not made admin here; use another ADMIN_PHONE.`);
    }
    return run.log(`Admin account: already there (${masked}, @${existing.username}), left as it is`);
  }
  if (!(await isAvailable(db, admin.username))) throw new SetupError(`Admin account: @${admin.username} is taken. Use another ADMIN_USERNAME.`);
  run.changes++;
  if (!run.apply) return run.log(`Admin account: would create ${masked} (@${admin.username}), admin with every console permission`);

  const now = new Date();
  const user: UserDoc = {
    _id: new ObjectId(),
    phone: admin.phone,
    ...(admin.email ? { email: admin.email, emailVerified: false } : {}),
    passwordHash: await hashPassword(admin.password),
    passwordHistory: [],
    name: admin.name,
    username: admin.username,
    dob: null,
    gender: null,
    avatar: null,
    status: "active",
    roles: { admin: true },
    kyc: { base: "none" },
    lock: { failedCount: 0, lockedUntil: null },
    consent: { termsVersion: TERMS_VERSION, acceptedAt: now },
    home: { city: null },
    prefs: {},
    ...stamp(now),
  };
  await db.transaction(async (session) => {
    await db.users.insertOne(user, { session });
    await writeAudit(
      db,
      {
        actor: { id: null, kind: "system" },
        scope: { module: "account" },
        action: "admin.grant",
        target: { type: "user", id: user._id },
        diff: { "roles.admin": { from: null, to: true } },
      },
      session,
    );
  });
  run.log(`Admin account: created (${masked}, @${admin.username}), admin with every console permission`);
}

const MODULE_RULES: Partial<Record<SwitchableModule, Partial<ModuleSettingsDoc>>> = {
  delivery: { riderRate: DEFAULT_RIDER_RATE, shopFeeMax: DEFAULT_SHOP_FEE_MAX, offerMinutes: DEFAULT_OFFER_MINUTES },
  events: { eventRules: DEFAULT_EVENT_RULES },
  coaching: { coachingRules: DEFAULT_COACHING_RULES },
  turf: { turfRules: DEFAULT_TURF_RULES },
  stays: { staysRules: DEFAULT_STAYS_RULES },
  shop: { shopRules: DEFAULT_SHOP_RULES },
};

/** A module's row with every default the console would otherwise fill in when it shows it. */
export function moduleDefaults(module: SwitchableModule, now = new Date()): Omit<ModuleSettingsDoc, "_id"> {
  return {
    ...newModuleSettings(module, now),
    ...(BUSINESS_MODULES.includes(module) ? { gstinRequired: false } : {}),
    ...(PAYOUT_MODULES.includes(module) ? { payoutFee: DEFAULT_PAYOUT_FEE, minPayout: DEFAULT_MIN_PAYOUT } : {}),
    ...MODULE_RULES[module],
  };
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof ObjectId);

/** The defaults `stored` lacks, as `$set` paths: missing fields, and missing keys inside objects such as a module's rules. */
function missingFields(stored: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    const have = stored[key];
    if (have === undefined) set[key] = value;
    else if (isPlain(value) && isPlain(have)) {
      for (const [inner, innerValue] of Object.entries(value)) if (have[inner] === undefined) set[`${key}.${inner}`] = innerValue;
    }
  }
  return set;
}

async function moduleStep(run: Run, module: SwitchableModule): Promise<void> {
  const label = `Module ${labelOf(module)}`;
  const now = new Date();
  const defaults = moduleDefaults(module, now);
  const existing = await run.db.moduleSettings.findOne({ module });
  if (!existing) {
    run.changes++;
    if (!run.apply) return run.log(`${label}: would write settings, switched off`);
    await run.db.moduleSettings.insertOne({ _id: new ObjectId(), ...defaults });
    return run.log(`${label}: settings written, switched off`);
  }
  const state = `${existing.live ? "live" : "switched off"}${existing.signupsOpen ? ", signups open" : ""}`;
  const { createdAt: _created, updatedAt: _updated, ...wanted } = defaults;
  const missing = missingFields(existing as unknown as Record<string, unknown>, wanted);
  const fields = Object.keys(missing).join(", ");
  if (!fields) return run.log(`${label}: already there (${state}), nothing to add`);
  run.changes++;
  if (!run.apply) return run.log(`${label}: already there (${state}), would add ${fields}`);
  await run.db.moduleSettings.updateOne({ _id: existing._id }, { $set: { ...missing, updatedAt: now } });
  run.log(`${label}: already there (${state}), added ${fields}`);
}

/** A row in platform_settings, stored the way the console saves one. */
async function settingStep(run: Run, label: string, key: string, defaults: object, what: string): Promise<void> {
  const now = new Date();
  const existing = await run.db.platformSettings.findOne({ key });
  if (!existing) {
    run.changes++;
    if (!run.apply) return run.log(`${label}: would write ${what}`);
    await run.db.platformSettings.insertOne({ _id: new ObjectId(), key, value: defaults, updatedBy: null, ...stamp(now) });
    return run.log(`${label}: ${what} written`);
  }
  const missing = missingFields({ value: existing.value }, { value: defaults });
  const fields = Object.keys(missing).map((path) => path.replace(/^value\.?/, "") || "value").join(", ");
  if (!fields) return run.log(`${label}: already there, nothing to add`);
  run.changes++;
  if (!run.apply) return run.log(`${label}: already there, would add ${fields}`);
  await run.db.platformSettings.updateOne({ _id: existing._id }, { $set: { ...missing, updatedAt: now } });
  run.log(`${label}: already there, added ${fields}`);
}

/** Lists the app writes the first time anyone reads them, written now so the console shows them from the start. */
async function listStep(run: Run, label: string, defaults: number, count: () => Promise<number>, load: () => Promise<unknown[]>): Promise<void> {
  const have = await count();
  if (have) return run.log(`${label}: already there (${have}), left as they are`);
  run.changes++;
  if (!run.apply) return run.log(`${label}: would write the ${defaults} defaults`);
  run.log(`${label}: ${(await load()).length} defaults written`);
}

/** Everything that must never be printed, so error messages from the driver can be cleaned of it. */
function secretsOf(env: NodeJS.ProcessEnv): string[] {
  const uri = env.MONGODB_URI?.trim();
  const secrets = [uri, env.ADMIN_PASSWORD];
  try {
    if (uri) secrets.push(decodeURIComponent(new URL(uri).password), new URL(uri).password);
  } catch {
    // Seed lists with several hosts are not URLs; the whole URI is still hidden.
  }
  return secrets.filter((s): s is string => Boolean(s && s.length >= 4));
}

async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const { values } = parseArgs({
    options: { apply: { type: "boolean", default: false }, resume: { type: "boolean", default: false }, db: { type: "string" } },
    strict: true,
  });
  const config = loadConfig(env);
  if (!config.mongo) throw new SetupError("Set MONGODB_URI and MONGODB_DB.");
  const dbName = values.db ?? PROD_DB;
  if (config.mongo.db !== dbName) {
    throw new SetupError(
      values.db
        ? `Refusing: --db ${values.db} is not MONGODB_DB (${config.mongo.db}).`
        : `Refusing: MONGODB_DB is ${config.mongo.db}. This sets up ${PROD_DB} only; name another empty database with --db <name>.`,
    );
  }
  const input: AdminInput = {
    phone: env.ADMIN_PHONE ?? "",
    name: env.ADMIN_NAME ?? "",
    username: env.ADMIN_USERNAME ?? "",
    password: env.ADMIN_PASSWORD ?? "",
    email: env.ADMIN_EMAIL ?? null,
  };
  checkAdmin(input);
  const { uri } = config.mongo;
  // Building every index of a new database at once can queue past the API's 10 s limit per operation.
  const db = new Database(() => new MongoClient(uri, { appName: "ruxstar-setup", serverSelectionTimeoutMS: 30_000, timeoutMS: 300_000, retryWrites: true }), dbName);
  try {
    await setupProd(db, input, { apply: values.apply, resume: values.resume, dbName, log: (line) => console.log(line) });
  } finally {
    await db.close();
  }
}

// Windows paths can reach here in either case.
if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  try {
    await main(process.env);
  } catch (err) {
    const known = err instanceof SetupError || err instanceof ConfigError;
    let message = known
      ? (err as Error).message
      : `Failed: ${err instanceof Error ? err.message : String(err)}\nWhat comes after the last line above may be unfinished. Fix the problem, then run again with --apply --resume to finish it.`;
    for (const secret of secretsOf(process.env)) message = message.split(secret).join("•••");
    console.error(message);
    process.exitCode = 1;
  }
}
