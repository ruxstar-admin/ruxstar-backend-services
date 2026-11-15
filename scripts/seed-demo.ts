/**
 * Fills the dev database with a client demo: new businesses with photos, listings, posts, follows, orders in every state,
 * delivery partners and payout accounts, on four existing accounts and nine new demo logins. Everything goes through the
 * real API routes, in-process, against ruxstar_dev; only SMS, identity checks, payments and push are stood in for.
 *
 *   npm run seed:demo                          dry run: checks the accounts and prints the plan
 *   npm run seed:demo -- --apply               writes it, once
 *   npm run seed:demo -- --apply --resume      carries on after a stop, skipping the steps already done
 *   npm run seed:demo -- --refresh --apply     just before a demo: fresh orders to accept and a fresh delivery offer
 *   npm run seed:demo -- --remove              lists what it made
 *   npm run seed:demo -- --remove --apply      deletes it
 *
 * Writes only to ruxstar_dev. Logins for the new accounts go to .temp/demo-accounts.txt; nothing secret is printed.
 */
import { execSync } from "node:child_process";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import { ObjectId, type Collection, type Document } from "mongodb";
import { PDFDocument, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import { createChatPhotoStore } from "../src/adapters/chat-photos.js";
import { FakeGateway } from "../src/adapters/payments.js";
import { createMediaStore, createPhotoStore, type PhotoStore } from "../src/adapters/photos.js";
import { createPrintFileStore, type PrintFileStore } from "../src/adapters/print-files.js";
import type { PushSender } from "../src/adapters/push.js";
import type { SmsSender } from "../src/adapters/sms.js";
import { FakeVerifier } from "../src/adapters/verification.js";
import { buildApp } from "../src/app.js";
import { ConfigError, loadConfig, type Config } from "../src/config.js";
import { startSession } from "../src/modules/account/sessions.js";
import { refreshRating } from "../src/modules/reviews/reviews.js";
import { productOf, type PodProduct } from "../src/modules/vendor/catalog.js";
import { signAccessToken } from "../src/platform/auth.js";
import { createDatabase, type BusinessDoc, type Database } from "../src/platform/db.js";

export const DEMO_DB = "ruxstar_dev";
/** Every request comes from this documentation-only address, so the audit entries it writes can be found again. */
const SEEDER_IP = "198.51.100.77";
const RUN_ID = "run";
const RETURN_TO = "ruxstar://orders";
const HERE = dirname(fileURLToPath(import.meta.url));
const TEMP = resolve(HERE, "..", ".temp");
const IMAGE_DIR = join(TEMP, "demo-images");
const ACCOUNTS_FILE = join(TEMP, "demo-accounts.txt");

/** A refusal or a failed step. Its message is safe to print. */
export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedError";
  }
}

// JSON from the API, read loosely: the routes' own schemas already checked it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = any;
type Point = { lat: number; lng: number };
type Home = { line: string; area: string; city: string; pincode: string; point: Point };

// The four accounts that already exist. The admin only approves and switches; its own data is never changed.
const EXISTING = {
  owner: { phone: "+917777912365", label: "vendor" },
  customer: { phone: "+919182465856", label: "customer" },
  rider: { phone: "+918885194997", label: "delivery partner" },
  admin: { phone: "+919949945193", label: "Ruxstar admin", username: "ruxstar.admin" },
} as const;
type ExistingKey = keyof typeof EXISTING;

const CUSTOMER_HOME: Home = { line: "Flat 302, Sai Residency, Bantumilli Road", area: "Bantumilli Road", city: "Gudivada", pincode: "521301", point: { lat: 16.4318, lng: 80.9991 } };

interface Person {
  key: string;
  role: "vendor" | "customer" | "rider";
  name: string;
  username: string;
  phone: string;
  gender: "female" | "male";
  avatar: string;
  kyc: boolean;
  home: Home;
  note: string;
}

const PEOPLE: Person[] = [
  { key: "vijaya", role: "vendor", name: "Vijaya Lakshmi Pendyala", username: "vijaya_prints", phone: "9000000101", gender: "female", avatar: "avatar_vijaya", kyc: true, note: "Vijaya Prints, Vijayawada",
    home: { line: "Flat 101, Krishna Towers, Governorpet", area: "Governorpet", city: "Vijayawada", pincode: "520002", point: { lat: 16.5148, lng: 80.6302 } } },
  { key: "arjun", role: "vendor", name: "Arjun Varma Kalidindi", username: "hyd_sportshub", phone: "9000000102", gender: "male", avatar: "avatar_arjun", kyc: true, note: "Hyderabad Sports Hub, Kondapur",
    home: { line: "Villa 14, Whitefields Road", area: "Kondapur", city: "Hyderabad", pincode: "500084", point: { lat: 17.4628, lng: 78.3649 } } },
  { key: "srinivas", role: "vendor", name: "Srinivasa Rao Gaddam", username: "ameerpet_hostel", phone: "9000000103", gender: "male", avatar: "avatar_srinivas", kyc: true, note: "Ameerpet Boys Hostel",
    home: { line: "H.No 7-1-48, Mythrivanam Road", area: "Ameerpet", city: "Hyderabad", pincode: "500038", point: { lat: 17.4379, lng: 78.4489 } } },
  { key: "lakshmi", role: "customer", name: "Lakshmi Prasanna Bandi", username: "lakshmi_prasanna", phone: "9000000104", gender: "female", avatar: "avatar_lakshmi", kyc: true, note: "Hyderabad",
    home: { line: "Flat 3B, Srinivasa Residency, Srinivasa Nagar", area: "Ameerpet", city: "Hyderabad", pincode: "500038", point: { lat: 17.4362, lng: 78.4432 } } },
  { key: "saikiran", role: "customer", name: "Sai Kiran Reddy", username: "saikiran_reddy", phone: "9000000105", gender: "male", avatar: "avatar_saikiran", kyc: true, note: "Gudivada",
    home: { line: "H.No 4-56, Mandapadu Road", area: "Mandapadu", city: "Gudivada", pincode: "521301", point: { lat: 16.4452, lng: 80.9893 } } },
  { key: "divya", role: "customer", name: "Divya Sri Kommineni", username: "divya_sri", phone: "9000000106", gender: "female", avatar: "avatar_divya", kyc: false, note: "Vijayawada",
    home: { line: "Flat 204, Sri Sai Towers, Patamata", area: "Patamata", city: "Vijayawada", pincode: "520010", point: { lat: 16.4935, lng: 80.6625 } } },
  { key: "ravi", role: "customer", name: "Ravi Teja Chowdary", username: "raviteja_c", phone: "9000000107", gender: "male", avatar: "avatar_ravi", kyc: true, note: "Hyderabad",
    home: { line: "Flat 5B, Lumbini Enclave", area: "Madhapur", city: "Hyderabad", pincode: "500081", point: { lat: 17.4486, lng: 78.3908 } } },
  { key: "harika", role: "customer", name: "Harika Nallamothu", username: "harika_n", phone: "9000000108", gender: "female", avatar: "avatar_harika", kyc: false, note: "Gudivada",
    home: { line: "Door 12-3-7, Gowri Shankar Puram", area: "Gowri Shankar Puram", city: "Gudivada", pincode: "521301", point: { lat: 16.4371, lng: 81.004 } } },
  { key: "naveen", role: "rider", name: "Naveen Kumar Yadav", username: "naveen_rides", phone: "9000000109", gender: "male", avatar: "avatar_naveen", kyc: true, note: "Vijayawada",
    home: { line: "H.No 32-14-5, Bhavanipuram", area: "Bhavanipuram", city: "Vijayawada", pincode: "520012", point: { lat: 16.5332, lng: 80.5975 } } },
];

/** Unsplash photos (Unsplash License: free to use, no attribution required), matched by hand to what they show. */
const IMAGES: Record<string, { id: string; what: string; face?: boolean }> = {
  badminton_jump: { id: "1626224583764-f87db24ac4ea", what: "badminton player on an indoor court" },
  badminton_racket: { id: "1521537634581-0dced2fee2ef", what: "badminton racket and shuttlecock" },
  badminton_player: { id: "1599474924187-334a4ae5bd3c", what: "badminton player with racket" },
  football_ball: { id: "1575361204480-aadea25e6e68", what: "football on turf" },
  football_boots: { id: "1529900748604-07564a03e7a6", what: "football boots on artificial turf" },
  football_night: { id: "1431324155629-1a6deb1dec8d", what: "floodlit football pitch at night" },
  football_stadium: { id: "1489944440615-453fc2b6a9a9", what: "football stadium" },
  football_balls: { id: "1551958219-acbc608c6377", what: "footballs on grass" },
  concert_light: { id: "1470229722913-7c0e2dbbafd3", what: "concert crowd and stage light" },
  concert_colour: { id: "1514525253161-7a46d19cd819", what: "concert crowd with colourful lights" },
  concert_singer: { id: "1493225457124-a3eb161ffa5f", what: "singer on stage" },
  concert_crowd: { id: "1459749411175-04bf5292ceea", what: "crowd at a live show" },
  concert_stage: { id: "1540039155733-5bb30b53aa14", what: "crowd facing a lit stage" },
  comedy_stage: { id: "1585699324551-f6c309eedeca", what: "audience in front of a small stage" },
  comedy_laugh: { id: "1527224857830-43a7acc85260", what: "LAUGH neon sign" },
  comedy_mic: { id: "1516280440614-37939bbacd81", what: "microphone on stage" },
  class_room: { id: "1509062522246-3755977927d7", what: "classroom with teacher and students" },
  class_student: { id: "1596495578065-6e0763fa1178", what: "student smiling at a desk" },
  class_maths: { id: "1635070041078-e363dbe005cb", what: "maths formulas on a blackboard" },
  class_board: { id: "1453733190371-0a9bedd82893", what: "chalkboard with maths" },
  class_online: { id: "1588196749597-9ff075ee6b5b", what: "online class on a laptop" },
  class_laptop: { id: "1516321318423-f06f85e504b3", what: "learning on a laptop" },
  class_group: { id: "1543269865-cbf427effbad", what: "students studying together" },
  room_bed: { id: "1505693416388-ac5ce068fe85", what: "bedroom" },
  room_white: { id: "1595526114035-0d45ed16cfbf", what: "bright white bedroom" },
  room_hotel: { id: "1631049307264-da0ec9d70304", what: "furnished bedroom" },
  room_bunk: { id: "1555854877-bab0e564b8d5", what: "bunk beds in a hostel room" },
  room_bunk_wood: { id: "1520277739336-7bf67edfa768", what: "wooden bunk beds in a hostel" },
  room_living: { id: "1560448204-e02f11c3d0e2", what: "common lounge" },
  room_lounge: { id: "1502672260266-1c1ef2d93688", what: "lounge with plants" },
  food_thali: { id: "1546833999-b9f581a1996d", what: "Indian thali" },
  food_curry: { id: "1585937421612-70a008356fbe", what: "Indian curries" },
  food_paneer: { id: "1567188040759-fb8a883dc6d8", what: "paneer tikka" },
  food_samosa: { id: "1601050690597-df0568f70950", what: "samosas" },
  food_idli: { id: "1589301760014-d929f3979dbc", what: "idli on a banana leaf" },
  grocery_shelves: { id: "1542838132-92c53300491e", what: "vegetable shelves in a grocery" },
  grocery_aisle: { id: "1604719312566-8912e9227c6a", what: "grocery store aisle" },
  grocery_veg: { id: "1579113800032-c38bd7635818", what: "fresh vegetables" },
  grocery_market: { id: "1488459716781-31db52582fe9", what: "vegetable market stall" },
  product_rice: { id: "1586201375761-83865001e31c", what: "rice grains" },
  product_oil: { id: "1474979266404-7eaacbcd87c5", what: "cooking oil" },
  product_milk: { id: "1550583724-b2692b85b150", what: "milk being poured" },
  product_tomatoes: { id: "1546094096-0df4bcaaa337", what: "tomatoes" },
  product_bananas: { id: "1571771894821-ce9b6c11b08e", what: "bananas" },
  product_eggs: { id: "1506976785307-8732e854ad03", what: "eggs in a tray" },
  product_onions: { id: "1618512496248-a07fe83aa8cb", what: "red onions" },
  product_masala: { id: "1596040033229-a9821ebd058d", what: "spices" },
  product_watermelon: { id: "1587049352846-4a222e784d38", what: "watermelon" },
  print_printer: { id: "1612815154858-60aa4c59eaa6", what: "office printer" },
  print_stickers: { id: "1572375992501-4b0892d50c69", what: "wall of printed stickers" },
  print_tee_white: { id: "1521572163474-6864f9cf17ab", what: "white t-shirt" },
  print_tee_black: { id: "1503341504253-dff4815485f1", what: "printed black t-shirt" },
  print_merch: { id: "1633533452148-a9657d2c9a5f", what: "printed merchandise" },
  print_design: { id: "1611532736597-de2d4265fba3", what: "design sketches on a tablet" },
  print_papers: { id: "1562564055-71e051d33c19", what: "printed documents" },
  avatar_vijaya: { id: "1573496359142-b8d87734a5a2", what: "portrait, woman", face: true },
  avatar_arjun: { id: "1557862921-37829c790f19", what: "portrait, man", face: true },
  avatar_srinivas: { id: "1629425733761-caae3b5f2e50", what: "portrait, man", face: true },
  avatar_lakshmi: { id: "1488426862026-3ee34a7d66df", what: "portrait, woman", face: true },
  avatar_saikiran: { id: "1595152772835-219674b2a8a6", what: "portrait, man", face: true },
  avatar_divya: { id: "1580489944761-15a19d654956", what: "portrait, woman", face: true },
  avatar_ravi: { id: "1547425260-76bcadfb4f2c", what: "portrait, man", face: true },
  avatar_harika: { id: "1607746882042-944635dfe10e", what: "portrait, woman", face: true },
  avatar_naveen: { id: "1492562080023-ab3db95bfbce", what: "portrait, man", face: true },
};

const imageUrl = (name: string) => {
  const image = IMAGES[name]!;
  const size = image.face ? "w=800&h=800&fit=crop&crop=faces" : "w=1600&fit=max";
  return `https://images.unsplash.com/photo-${image.id}?${size}&q=80&fm=jpg`;
};

// Dates in India time, which every listing and slot uses.
const IST_MS = 5.5 * 3600_000;
function istParts(daysAhead: number) {
  const d = new Date(Date.now() + IST_MS + daysAhead * 86_400_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), day: d.getUTCDay() };
}
const pad = (n: number) => String(n).padStart(2, "0");
const istDate = (daysAhead: number) => {
  const p = istParts(daysAhead);
  return `${p.y}-${pad(p.m + 1)}-${pad(p.d)}`;
};
const istAt = (daysAhead: number, hhmm: string) => {
  const p = istParts(daysAhead);
  const [h, min] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(p.y, p.m, p.d, h!, min!) - IST_MS).toISOString();
};
/** Days from today to the next given weekday (0 Sunday), at least `min` days away. */
const daysUntil = (weekday: number, min = 1) => {
  for (let i = min; i < min + 7; i++) if (istParts(i).day === weekday) return i;
  return min;
};
const firstOfNextMonth = () => {
  const p = istParts(0);
  const next = new Date(Date.UTC(p.y, p.m + 1, 1));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-01`;
};

const maskPhone = (phone: string) => `+91••••${phone.slice(-4)}`;
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const HEX = /[0-9a-f]{24}/g;

// The run's record in demo_seed.

type StoreKind = "photos" | "media" | "printFiles" | "chatPhotos";

interface RunDoc {
  _id: string;
  status: "running" | "done";
  startedAt: Date;
  finishedAt: Date | null;
  /** Each finished step's result, so --resume skips it. */
  steps: Record<string, unknown>;
  /** Demo key to user id. */
  demoUsers: Record<string, string>;
  /** Ids the API answered with: businesses, listings, orders, posts, follows and the rest. */
  ids: string[];
  /** Every object written to a bucket, with its store. */
  keys: { store: StoreKind; key: string }[];
  /** Sessions minted for the seeder, revoked when it finishes. */
  sessions: string[];
  /** Values changed on things that already existed, put back by --remove. */
  before: { modules: { module: string; field: string; value: unknown }[]; riderState: { online: boolean; city: string | null; point: Point | null } | null };
  /** What the run made, by collection, worked out when it finished. */
  claimed: Record<string, string[]>;
  refreshes: number;
}

interface Actor {
  key: string;
  name: string;
  phone: string;
  userId: ObjectId;
  sessionId: ObjectId;
}

type Say = (line: string) => void;

/** Fastify's logger shape for the bucket adapters, printing only their short messages. */
function adapterLog(say: Say): FastifyBaseLogger {
  const at = (level: string) => (obj: unknown, msg?: string) => {
    const text = typeof obj === "string" ? obj : msg;
    const err = typeof obj === "object" && obj && "err" in obj ? ` (${String((obj as { err: unknown }).err)})` : "";
    if (text) say(`  [${level}] ${text}${err}`);
  };
  const log: Record<string, unknown> = { level: "warn", fatal: at("fatal"), error: at("error"), warn: at("warn"), info: () => {}, debug: () => {}, trace: () => {}, silent: () => {} };
  log.child = () => log;
  return log as unknown as FastifyBaseLogger;
}

interface BucketAuth {
  cachedCredential: unknown;
  getAccessToken(): Promise<unknown>;
}

/**
 * The stores sign in with Application Default Credentials. When those need an interactive Google re-auth,
 * the same account's gcloud CLI login is used instead, held in memory only. The buckets stay the real ones.
 */
async function bucketAuth(stores: object[], say: Say): Promise<void> {
  const auths = stores
    .map((store) => (store as { bucket?: { storage?: { authClient?: BucketAuth } } }).bucket?.storage?.authClient)
    .filter((auth): auth is BucketAuth => Boolean(auth));
  if (!auths.length) return;
  try {
    await Promise.race([auths[0]!.getAccessToken(), sleep(20_000).then(() => Promise.reject(new Error("timed out")))]);
    return;
  } catch {
    // fall through to the CLI login
  }
  let token = "";
  let fetchedAt = 0;
  const fresh = (): string => {
    if (Date.now() - fetchedAt > 40 * 60_000) {
      try {
        token = execSync("gcloud auth print-access-token", { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
      } catch {
        throw new SeedError("Google sign-in for the buckets has expired (run gcloud auth application-default login), and the gcloud CLI login did not work either.");
      }
      fetchedAt = Date.now();
    }
    return token;
  };
  fresh();
  const credential = {
    getRequestHeaders: async () => new Headers({ authorization: `Bearer ${fresh()}` }),
    getAccessToken: async () => ({ token: fresh() }),
  };
  for (const auth of auths) auth.cachedCredential = credential;
  say("  Google default credentials need a re-auth; bucket uploads use the gcloud CLI login of the same account");
}

/** Images: cached in .temp/demo-images, with the credits beside them. A failed download is skipped. */
async function loadImages(say: Say): Promise<Map<string, Buffer>> {
  mkdirSync(IMAGE_DIR, { recursive: true });
  const images = new Map<string, Buffer>();
  const credits: string[] = [
    "Demo images used by scripts/seed-demo.ts. All from Unsplash under the Unsplash License (https://unsplash.com/license):",
    "free to use, commercially too, without asking or crediting. Photo pages: https://unsplash.com/photos/<id>.",
    "",
  ];
  const missing: string[] = [];
  for (const name of Object.keys(IMAGES)) {
    const file = join(IMAGE_DIR, `${name}.jpg`);
    let data: Buffer | null = existsSync(file) ? readFileSync(file) : null;
    if (!data) {
      try {
        const res = await fetch(imageUrl(name), { signal: AbortSignal.timeout(30_000) });
        const type = res.headers.get("content-type") ?? "";
        if (res.ok && type.startsWith("image/")) {
          data = await sharp(Buffer.from(await res.arrayBuffer())).jpeg({ quality: 85 }).toBuffer();
          writeFileSync(file, data);
        }
      } catch {
        data = null;
      }
    }
    if (!data) {
      missing.push(name);
      continue;
    }
    images.set(name, data);
    credits.push(`${name}.jpg | ${IMAGES[name]!.what} | ${imageUrl(name)} | Unsplash License`);
  }
  writeFileSync(join(IMAGE_DIR, "credits.txt"), `${credits.join("\n")}\n`);
  say(`Images: ${images.size} of ${Object.keys(IMAGES).length} ready in .temp/demo-images${missing.length ? `; skipped ${missing.join(", ")}` : ""}`);
  return images;
}

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/** A plain made-up picture: for private uploads (selfie, licence, proof) and when a stock photo could not be fetched. */
async function card(title: string, sub: string, width = 1200, height = 900, colour = "#7c3aed"): Promise<Buffer> {
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${colour}"/><stop offset="1" stop-color="#111827"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="46%" font-family="Arial" font-size="${Math.round(width / 16)}" font-weight="bold" fill="#ffffff" text-anchor="middle">${escapeXml(title)}</text><text x="50%" y="58%" font-family="Arial" font-size="${Math.round(width / 32)}" fill="#e5e7eb" text-anchor="middle">${escapeXml(sub)}</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}

async function notesPdf(title: string, pages: number): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = pdf.addPage([595, 842]);
    page.drawText(title, { x: 56, y: 770, size: 20, font });
    page.drawText(`Page ${i} of ${pages}`, { x: 56, y: 740, size: 12, font });
    for (let line = 0; line < 20; line++) page.drawText(`${i}.${line + 1}  Practice problem and worked solution.`, { x: 56, y: 700 - line * 28, size: 11, font });
  }
  return Buffer.from(await pdf.save());
}

// The plan: what goes where.

const OWNER_BUSINESSES = {
  krishna: {
    module: "events", type: "concert", name: "Krishna Events", phone: "9000000201", photos: ["concert_light", "comedy_stage", "concert_stage"],
    description: "Live music nights, stand-up comedy and cultural shows in Vijayawada.",
    location: { state: "Andhra Pradesh", city: "Vijayawada", doorNo: "Plot 18", building: "Krishna Events Hall", street: "MG Road", area: "Labbipet", pincode: "520010", point: { lat: 16.504, lng: 80.646 } },
  },
  brightminds: {
    module: "coaching", type: "coaching", name: "Bright Minds Academy", phone: "9000000202", photos: ["class_room", "class_maths", "class_group"],
    description: "Maths tuition for classes 8 to 10 and spoken English courses, in Gudivada and online.",
    location: { state: "Andhra Pradesh", city: "Gudivada", doorNo: "2nd Floor", building: "Sri Lakshmi Complex", street: "NTR Stadium Road", area: "Rajendra Nagar", pincode: "521301", point: { lat: 16.4352, lng: 80.9897 } },
  },
  srisai: {
    module: "stays", type: "pg", name: "Sri Sai Ladies PG", phone: "9000000203", photos: ["room_white", "room_bed", "food_thali"],
    description: "Safe, homely PG for women near Ameerpet Metro, with three veg meals a day.",
    location: { state: "Telangana", city: "Hyderabad", doorNo: "H.No 7-1-212/A", building: null, street: "Balkampet Road", area: "Ameerpet", pincode: "500016", point: { lat: 17.441, lng: 78.444 } },
  },
  freshmart: {
    module: "shop", type: "grocery", name: "Fresh Mart", phone: "9000000204", photos: ["grocery_shelves", "grocery_aisle", "grocery_market"],
    description: "Daily groceries, fresh vegetables and dairy in Gudivada, delivered home.",
    location: { state: "Andhra Pradesh", city: "Gudivada", doorNo: "Door 9-12-34", building: null, street: "Eluru Road", area: "Near Bus Stand", pincode: "521301", point: { lat: 16.4389, lng: 80.9962 } },
  },
} as const;

const DEMO_BUSINESSES = {
  vijayaprints: {
    owner: "vijaya", module: "pod", type: "print_shop", name: "Vijaya Prints", phone: "9000000205", photos: ["print_printer", "print_stickers", "print_tee_white"],
    description: "Custom t-shirts, posters, visiting cards, stickers and document printing in Vijayawada.",
    location: { state: "Andhra Pradesh", city: "Vijayawada", doorNo: "Shop 7", building: "Sai Plaza", street: "Eluru Road", area: "Governorpet", pincode: "520002", point: { lat: 16.5143, lng: 80.6295 } },
  },
  sportshub: {
    owner: "arjun", module: "turf", type: "turf", name: "Hyderabad Sports Hub", phone: "9000000206", photos: ["football_night", "football_ball", "football_balls"],
    description: "Floodlit football turf in Kondapur with two courts, open till midnight.",
    location: { state: "Telangana", city: "Hyderabad", doorNo: "Survey No. 66", building: null, street: "Whitefields Road", area: "Kondapur", pincode: "500084", point: { lat: 17.4615, lng: 78.3657 } },
  },
  boyshostel: {
    owner: "srinivas", module: "stays", type: "hostel", name: "Ameerpet Boys Hostel", phone: "9000000207", photos: ["room_bunk", "room_bunk_wood", "food_curry"],
    description: "Budget hostel for students and working men, two minutes from Ameerpet Metro.",
    location: { state: "Telangana", city: "Hyderabad", doorNo: "Plot 45", building: null, street: "Mythrivanam Road", area: "Ameerpet", pincode: "500038", point: { lat: 17.4375, lng: 78.4483 } },
  },
} as const;

const PRODUCTS = [
  { title: "Sona Masoori Rice", description: "Aged, premium raw rice from the Godavari delta.", photo: "product_rice", options: [{ name: "Pack", values: ["5 kg", "10 kg"] }], variants: [{ values: ["5 kg"], price: 34900, mrp: 39900, stock: 60 }, { values: ["10 kg"], price: 66900, mrp: 76000, stock: 30 }] },
  { title: "Cold Pressed Groundnut Oil 1 L", description: "Wood-pressed groundnut oil.", photo: "product_oil", variants: [{ price: 18500, mrp: 21000, stock: 40 }] },
  { title: "Fresh Toned Milk 1 L", description: "Delivered fresh every morning.", photo: "product_milk", variants: [{ price: 6400, mrp: 6600, stock: 80 }] },
  { title: "Country Tomatoes 1 kg", description: "Farm-fresh tomatoes from Krishna district.", photo: "product_tomatoes", variants: [{ price: 3800, mrp: 4500, stock: 100 }] },
  { title: "Robusta Bananas (1 dozen)", description: "Ripe, sweet bananas.", photo: "product_bananas", variants: [{ price: 6000, mrp: 7000, stock: 50 }] },
  { title: "Farm Fresh Eggs (12)", description: "A tray of 12 brown eggs.", photo: "product_eggs", variants: [{ price: 9600, mrp: 10200, stock: 60 }] },
  { title: "Red Onions 1 kg", description: "Nashik red onions.", photo: "product_onions", variants: [{ price: 4200, mrp: 5000, stock: 120 }] },
  { title: "Sambar Masala 100 g", description: "Stone-ground spice blend, Andhra style.", photo: "product_masala", variants: [{ price: 5500, mrp: 6000, stock: 70 }] },
] as const;

const POSTS: { business: string; by: string; text: string; photo: string }[] = [
  { business: "collegeprint", by: "owner", text: "Exam season! Spiral binding and black-and-white printouts ready within the hour. Send your PDF on Ruxstar.", photo: "print_papers" },
  { business: "collegeprint", by: "owner", text: "Custom printed tees for college fests and cricket teams. Upload your design and pick a size.", photo: "print_tee_black" },
  { business: "playarena", by: "owner", text: "Weekend box cricket leagues are back at Play Arena. Grab your evening slot!", photo: "football_balls" },
  { business: "playarena", by: "owner", text: "Kids court now opens at 6 am. Football, box cricket and pickleball under one roof.", photo: "football_ball" },
  { business: "smash", by: "owner", text: "Three new wooden-floor badminton courts are live at Smash! Book from ₹300 an hour.", photo: "badminton_jump" },
  { business: "smash", by: "owner", text: "Racket rental and Mavis 350 shuttles at the counter. Just bring your shoes.", photo: "badminton_racket" },
  { business: "krishna", by: "owner", text: "Telugu Melodies Live is coming to Labbipet. Tickets are selling fast!", photo: "concert_singer" },
  { business: "krishna", by: "owner", text: "Laugh out loud this month: Stand-up Comedy Night, Vijayawada edition.", photo: "comedy_mic" },
  { business: "brightminds", by: "owner", text: "New Class 10 Maths batch starts this week. Small groups, weekly tests, doubt sessions.", photo: "class_board" },
  { business: "brightminds", by: "owner", text: "Speak English with confidence. Our weekend online batch opens for admissions.", photo: "class_laptop" },
  { business: "srisai", by: "owner", text: "Home-style veg food, three meals a day. Idli and chutney every Sunday!", photo: "food_idli" },
  { business: "srisai", by: "owner", text: "CCTV, a security guard and a bright common lounge, 600 m from Ameerpet Metro.", photo: "room_living" },
  { business: "freshmart", by: "owner", text: "Fresh vegetables every morning, straight from local farms. Delivered in Gudivada.", photo: "grocery_veg" },
  { business: "freshmart", by: "owner", text: "Summer special: sweet watermelons in store this week.", photo: "product_watermelon" },
  { business: "vijayaprints", by: "vijaya", text: "Team tees printed in 48 hours. Screen print, DTG or vinyl.", photo: "print_merch" },
  { business: "vijayaprints", by: "vijaya", text: "From sketch to sticker: send us your design and we'll print it.", photo: "print_design" },
  { business: "sportshub", by: "arjun", text: "Floodlit 7-a-side turf open till midnight. Bring your squad!", photo: "football_night" },
  { business: "sportshub", by: "arjun", text: "Corporate football leagues every Saturday at Kondapur.", photo: "football_stadium" },
  { business: "boyshostel", by: "srinivas", text: "Non-veg Sundays at Ameerpet Boys Hostel. Paneer for the veg folks.", photo: "food_paneer" },
  { business: "boyshostel", by: "srinivas", text: "Beds from ₹5,500 a month with Wi-Fi, power backup and a lounge.", photo: "room_lounge" },
];

const PERSONAL_POSTS: { by: string; text: string; photo: string }[] = [
  { by: "lakshmi", text: "Can't wait for the comedy night in Vijayawada with my cousins!", photo: "concert_crowd" },
  { by: "saikiran", text: "Evening smash session at the new courts in Gudivada.", photo: "badminton_player" },
  { by: "divya", text: "Evening snacks after a long day. Samosa and chai!", photo: "food_samosa" },
  { by: "ravi", text: "Sunday football with the office gang in Kondapur.", photo: "football_boots" },
  { by: "harika", text: "First week of Class 10 maths tuition. Feeling ready for the exams.", photo: "class_student" },
];

// The seeder.

class Seeder {
  private readonly runs: Collection<RunDoc>;
  doc!: RunDoc;
  app!: FastifyInstance;
  readonly verifier = new FakeVerifier();
  readonly texts = new Map<string, string>();
  readonly actors = new Map<string, Actor>();
  images = new Map<string, Buffer>();
  floor = new ObjectId();
  password = "";

  constructor(
    readonly config: Config,
    readonly db: Database,
    readonly say: Say,
  ) {
    this.runs = db.db.collection<RunDoc>("demo_seed");
  }

  async load(): Promise<RunDoc | null> {
    return this.runs.findOne({ _id: RUN_ID });
  }

  async start(resume: boolean): Promise<void> {
    const existing = await this.load();
    if (existing && !resume) {
      throw new SeedError(
        existing.status === "done"
          ? "Refusing: the demo is already seeded. Run --refresh --apply before a demo, or --remove --apply to start over."
          : "Refusing: an earlier run stopped partway. Run again with --apply --resume to finish it, or --remove --apply to undo it.",
      );
    }
    if (existing?.status === "done") throw new SeedError("The demo is already seeded; nothing to resume.");
    this.doc = existing ?? {
      _id: RUN_ID,
      status: "running",
      startedAt: new Date(),
      finishedAt: null,
      steps: {},
      demoUsers: {},
      ids: [],
      keys: [],
      sessions: [],
      before: { modules: [], riderState: null },
      claimed: {},
      refreshes: 0,
    };
    if (!existing) await this.runs.insertOne(this.doc);
    this.floor = ObjectId.createFromTime(Math.floor(this.doc.startedAt.getTime() / 1000) - 5);
  }

  async attach(): Promise<void> {
    const doc = await this.load();
    if (!doc) throw new SeedError("Nothing to do: demo_seed has no run.");
    this.doc = doc;
    this.floor = ObjectId.createFromTime(Math.floor(doc.startedAt.getTime() / 1000) - 5);
  }

  /** Runs `fn` once: its result is kept, and a resumed run gets it back without running it again. */
  async step<T>(key: string, label: string, fn: () => Promise<T>): Promise<T> {
    if (key in this.doc.steps) return this.doc.steps[key] as T;
    const value = await fn();
    this.doc.steps[key] = value ?? null;
    await this.runs.updateOne({ _id: RUN_ID }, { $set: { [`steps.${key}`]: value ?? null } });
    this.say(`  ✓ ${label}`);
    return value;
  }

  /** Keeps ids made during the run; anything older is left alone. */
  async track(...ids: (string | ObjectId | null | undefined)[]): Promise<void> {
    const fresh = ids
      .filter((id): id is string | ObjectId => Boolean(id))
      .map((id) => (typeof id === "string" ? id : id.toHexString()))
      .filter((hex) => ObjectId.isValid(hex) && new ObjectId(hex).getTimestamp() >= this.floor.getTimestamp() && !this.doc.ids.includes(hex));
    if (!fresh.length) return;
    this.doc.ids.push(...fresh);
    await this.runs.updateOne({ _id: RUN_ID }, { $addToSet: { ids: { $each: fresh } } });
  }

  async saved(store: StoreKind, key: string): Promise<void> {
    this.doc.keys.push({ store, key });
    await this.runs.updateOne({ _id: RUN_ID }, { $push: { keys: { store, key } } });
  }

  async remember(set: Partial<RunDoc>): Promise<void> {
    Object.assign(this.doc, set);
    await this.runs.updateOne({ _id: RUN_ID }, { $set: set });
  }

  // The app, built in-process with the real buckets and payouts, and stand-ins for SMS, checks, payments and push.

  async build(): Promise<void> {
    const log = adapterLog(this.say);
    const tracked = (kind: StoreKind, store: PhotoStore): PhotoStore => ({
      save: async (key, data) => {
        await this.saved(kind, key);
        return store.save(key, data);
      },
      remove: (key) => store.remove(key),
    });
    const print = createPrintFileStore(this.config, log);
    const printFiles: PrintFileStore = {
      save: async (key, data, type, options) => {
        await this.saved("printFiles", key);
        return print.save(key, data, type, options);
      },
      read: (key) => print.read(key),
      expire: (key) => print.expire(key),
      remove: (key) => print.remove(key),
    };
    const chat = createChatPhotoStore(this.config, log);
    const photos = createPhotoStore(this.config, log);
    const media = createMediaStore(this.config, log);
    await bucketAuth([photos, media, print, chat], this.say);
    const sms: SmsSender = { sendOtp: async (phone, code) => void this.texts.set(phone, code) };
    const push: PushSender = { send: async () => [] };
    const jobToken = randomBytes(24).toString("hex");
    this.app = await buildApp({
      config: { ...this.config, authCacheSeconds: 0 },
      db: this.db,
      logger: false,
      sms,
      photos: tracked("photos", photos),
      media: tracked("media", media),
      printFiles,
      chatPhotos: { save: async (key, data, type) => (await this.saved("chatPhotos", key), chat.save(key, data, type)), read: (key) => chat.read(key), remove: (key) => chat.remove(key) },
      verifier: this.verifier,
      payments: new FakeGateway(),
      push,
      jobAuth: async (token) => token === jobToken,
      rateLimit: false,
    });
    await this.app.ready();
  }

  async close(): Promise<void> {
    // Notifications are written just after some answers; give them a moment.
    await sleep(1500);
    await this.app?.close();
  }

  // Requests.

  private async token(actor: Actor): Promise<string> {
    return signAccessToken(this.config.jwtSecret!, { userId: actor.userId, sessionId: actor.sessionId, client: "web" });
  }

  async call(actor: Actor | null, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown, raw?: { data: Buffer; type: string; name?: string }): Promise<Data> {
    const headers: Record<string, string> = { "x-client": "web" };
    if (actor) headers.authorization = `Bearer ${await this.token(actor)}`;
    if (method !== "GET") headers["idempotency-key"] = randomUUID();
    let payload: string | Buffer | undefined;
    if (raw) {
      headers["content-type"] = raw.type;
      if (raw.name) headers["x-file-name"] = raw.name;
      payload = raw.data;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await this.app.inject({ method, url, headers, payload, remoteAddress: SEEDER_IP });
    const path = url.split("?")[0];
    let json: Data = null;
    try {
      json = res.body ? JSON.parse(res.body) : null;
    } catch {
      json = null;
    }
    if (res.statusCode >= 400) {
      const error = json?.error ?? {};
      const details = Array.isArray(error.details) ? error.details.map((d: Data) => `${d.path}: ${d.message}`).join("; ") : "";
      throw new SeedError(`${method} ${path} answered ${res.statusCode} ${error.code ?? ""}: ${error.message ?? res.statusMessage}${details ? ` (${details})` : ""}`);
    }
    if (method !== "GET" && res.body) {
      const ids = [...res.body.matchAll(/"id":"([0-9a-f]{24})"/g)].map((m) => m[1]!);
      await this.track(...ids);
    }
    return json?.data ?? json;
  }

  get = (actor: Actor | null, url: string) => this.call(actor, "GET", url);
  post = (actor: Actor, url: string, body?: unknown) => this.call(actor, "POST", url, body);
  put = (actor: Actor, url: string, body?: unknown) => this.call(actor, "PUT", url, body);

  image(name: string): Buffer | null {
    return this.images.get(name) ?? null;
  }

  async upload(actor: Actor, method: "POST" | "PUT", url: string, data: Buffer | null): Promise<Data> {
    if (!data) return null;
    return this.call(actor, method, url, undefined, { data, type: "image/jpeg" });
  }

  /** The stand-in gateway's test button on the checkout page: paid at once. */
  async pay(checkoutUrl: string | null): Promise<string> {
    if (!checkoutUrl) return "free";
    const url = new URL(checkoutUrl);
    const res = await this.app.inject({ method: "POST", url: `${url.pathname}/test${url.search}`, remoteAddress: SEEDER_IP });
    if (res.statusCode >= 400) throw new SeedError(`Paying ${url.pathname} answered ${res.statusCode}`);
    return (JSON.parse(res.body) as { status: string }).status;
  }

  // Accounts.

  /** A session for an account that already exists, from the app's own session code; no password involved. */
  async mint(key: string, userId: ObjectId, name: string, phone: string): Promise<Actor> {
    const request = { client: { kind: "web", version: null }, headers: { "user-agent": "ruxstar-demo-seeder" } } as unknown as FastifyRequest;
    const { sessionId } = await startSession(this.db, request, userId, { deviceName: "Demo seeder" });
    this.doc.sessions.push(sessionId.toHexString());
    await this.runs.updateOne({ _id: RUN_ID }, { $push: { sessions: sessionId.toHexString() } });
    const actor = { key, name, phone, userId, sessionId };
    this.actors.set(key, actor);
    return actor;
  }

  actor(key: string): Actor {
    const actor = this.actors.get(key);
    if (!actor) throw new SeedError(`No session for ${key}.`);
    return actor;
  }

  async existing(): Promise<void> {
    for (const [key, spec] of Object.entries(EXISTING) as [ExistingKey, (typeof EXISTING)[ExistingKey]][]) {
      const user = await this.db.users.findOne({ phone: spec.phone });
      if (!user) throw new SeedError(`The ${spec.label} account ${maskPhone(spec.phone)} is not in ${DEMO_DB}.`);
      await this.mint(key, user._id, user.name ?? spec.label, spec.phone);
    }
  }

  async demoAccounts(): Promise<void> {
    for (const person of PEOPLE) {
      const id = await this.step(`signup-${person.key}`, `${person.name} signed up (${person.role})`, async () => {
        const phone = person.phone;
        await this.call(null, "POST", "/v1/account/otp", { phone, purpose: "signup" });
        const code = this.texts.get(`+91${phone}`) ?? this.texts.get(phone);
        if (!code) throw new SeedError(`No OTP recorded for ${maskPhone(phone)}.`);
        const verified = await this.call(null, "POST", "/v1/account/otp/verify", { phone, purpose: "signup", code });
        const user = await this.call(null, "POST", "/v1/account/signup", {
          verificationToken: verified.verificationToken,
          name: person.name,
          password: this.password,
          acceptTerms: true,
          username: person.username,
          gender: person.gender,
        });
        const userId: string = user?.user?.id ?? user?.id ?? (await this.db.users.findOne({ phone: `+91${phone}` }))?._id.toHexString();
        if (!userId) throw new SeedError(`Signup for ${maskPhone(phone)} did not return the new account.`);
        this.doc.demoUsers[person.key] = userId;
        await this.runs.updateOne({ _id: RUN_ID }, { $set: { [`demoUsers.${person.key}`]: userId } });
        this.writeAccounts();
        return userId;
      });
      this.doc.demoUsers[person.key] = id;
      if (!this.actors.has(person.key)) await this.mint(person.key, new ObjectId(id), person.name, `+91${person.phone}`);
      await this.step(`avatar-${person.key}`, `${person.name}: profile photo`, async () => {
        await this.upload(this.actor(person.key), "PUT", "/v1/account/me/photo", this.image(person.avatar));
        return true;
      });
    }
    this.writeAccounts();
  }

  writeAccounts(): void {
    mkdirSync(TEMP, { recursive: true });
    const lines = [
      `Ruxstar demo logins (${DEMO_DB}), made by scripts/seed-demo.ts on ${new Date().toISOString().slice(0, 10)}.`,
      "Every demo account below signs in with its phone number and this one shared password:",
      "",
      `Password: ${this.password}`,
      "",
      "Name | Role | Phone | Username",
      ...PEOPLE.map((p) => `${p.name} | ${p.role} (${p.note}) | +91 ${p.phone.slice(0, 5)} ${p.phone.slice(5)} | @${p.username}`),
      "",
      "Existing accounts used by the demo (sign in as you usually do): vendor +91 77779 12365, customer +91 91824 65856,",
      "delivery partner Venkateswarlu +91 88851 94997. The Ruxstar admin approved the demo vendors' and rider's verification.",
      "",
    ];
    writeFileSync(ACCOUNTS_FILE, lines.join("\n"));
  }

  readPassword(): string | null {
    if (!existsSync(ACCOUNTS_FILE)) return null;
    const line = readFileSync(ACCOUNTS_FILE, "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith("Password: "));
    return line ? line.slice("Password: ".length).trim() : null;
  }

  // Verification, through the app and the console.

  async baseKyc(person: Person, index: number): Promise<void> {
    const actor = this.actor(person.key);
    await this.step(`kyc-${person.key}`, `${person.name}: identity verified and approved in the console`, async () => {
      this.verifier.aadhaarName = person.name;
      await this.post(actor, "/v1/kyc/base/aadhaar");
      await this.post(actor, "/v1/kyc/base/aadhaar/check");
      await this.post(actor, "/v1/kyc/base/pan", { pan: `DEMO${String.fromCharCode(65 + index)}${person.phone.slice(-4)}Z` });
      await this.upload(actor, "POST", "/v1/kyc/base/face", await card(person.name, "Selfie", 720, 960, "#0f766e"));
      await this.post(actor, "/v1/kyc/base/submit");
      await this.approve(actor, "base");
      return true;
    });
  }

  async approve(actor: Actor, track: "base" | "delivery"): Promise<void> {
    const kase = await this.db.kycCases.findOne({ userId: actor.userId, track });
    if (!kase) throw new SeedError(`No ${track} verification case for ${actor.name}.`);
    await this.post(this.actor("admin"), `/v1/ruxstar/kyc/${kase._id.toHexString()}/approve`);
    await this.track(kase._id);
  }

  async aadhaarName(actor: Actor): Promise<string> {
    const kase = await this.db.kycCases.findOne({ userId: actor.userId, track: "base" });
    return kase?.steps.aadhaar?.name ?? actor.name;
  }

  /** A Cashfree sandbox test bank account; the account check is the stand-in, matched to the Aadhaar name. */
  async payoutAccount(actor: Actor, as: "vendor" | "rider"): Promise<void> {
    await this.step(`payout-${actor.key}`, `${actor.name}: ${as} payout account added (sandbox test bank)`, async () => {
      const before = await (as === "vendor" ? this.db.payoutMethods : this.db.riderPayoutMethods).findOne({ userId: actor.userId });
      if (before) return "kept";
      this.verifier.accountName = (await this.aadhaarName(actor)).toUpperCase();
      this.verifier.accountMatch = "DIRECT_MATCH";
      await this.put(actor, as === "vendor" ? "/v1/vendor/payout-method" : "/v1/delivery/payout-method", { kind: "bank", accountNumber: "026291800001191", ifsc: "YESB0000262" });
      const after = await (as === "vendor" ? this.db.payoutMethods : this.db.riderPayoutMethods).findOne({ userId: actor.userId });
      await this.track(after?._id);
      return "added";
    });
  }

  async riderKyc(person: Person): Promise<void> {
    const actor = this.actor(person.key);
    await this.step(`delivery-kyc-${person.key}`, `${person.name}: delivery verification approved in the console`, async () => {
      await this.call(actor, "PATCH", "/v1/kyc/delivery", { licenceNumber: "AP16 20210004521", vehicleType: "bike", vehicleNumber: "AP16BK4521" });
      await this.upload(actor, "PUT", "/v1/kyc/delivery/photos/licence", await card("DRIVING LICENCE", `${person.name} · AP16 20210004521`, 1200, 760, "#1d4ed8"));
      await this.upload(actor, "PUT", "/v1/kyc/delivery/photos/vehicle", await card("AP16 BK 4521", "Bike with number plate", 1200, 900, "#b45309"));
      await this.post(actor, "/v1/kyc/delivery/submit");
      await this.approve(actor, "delivery");
      return true;
    });
  }

  // Module switches the demo needs, put back by --remove.

  async moduleSwitch(module: string, field: "deliveryEnabled" | "live", value: boolean): Promise<void> {
    await this.step(`module-${module}-${field}`, `${module}: ${field} switched ${value ? "on" : "off"} in the console`, async () => {
      const doc = await this.db.moduleSettings.findOne({ module: module as never });
      const before = (doc as Record<string, unknown> | null)?.[field] ?? false;
      if (before === value) return "unchanged";
      await this.call(this.actor("admin"), "PATCH", `/v1/ruxstar/modules/${module}`, { [field]: value });
      this.doc.before.modules.push({ module, field, value: before });
      await this.remember({ before: this.doc.before });
      return "changed";
    });
  }

  // Businesses.

  async business(ownerKey: string, key: string, spec: { module: string; type: string; name: string; phone: string; description: string; location: object; photos: readonly string[] }): Promise<string> {
    const owner = this.actor(ownerKey);
    return this.step(`biz-${key}`, `${spec.name}: business created with photos`, async () => {
      const biz = await this.post(owner, "/v1/vendor/businesses", { module: spec.module, type: spec.type, name: spec.name, phone: spec.phone, location: spec.location, description: spec.description });
      let photos = 0;
      for (const name of spec.photos.slice(0, 3)) {
        const data = this.image(name);
        if (!data) continue;
        await this.upload(owner, "POST", `/v1/vendor/businesses/${biz.id}/photos`, data);
        photos++;
      }
      if (!photos) await this.upload(owner, "POST", `/v1/vendor/businesses/${biz.id}/photos`, await card(spec.name, spec.description.slice(0, 60)));
      return biz.id as string;
    });
  }

  async publish(ownerKey: string, key: string, id: string, name: string): Promise<void> {
    await this.step(`publish-${key}`, `${name}: published`, async () => {
      await this.post(this.actor(ownerKey), `/v1/vendor/businesses/${id}/publish`);
      return true;
    });
  }

  async listingPhotos(owner: Actor, url: string, names: string[], method: "POST" | "PUT" = "POST"): Promise<void> {
    for (const name of names) await this.upload(owner, method, url, this.image(name));
  }
}

// What gets made, step by step.

interface Made {
  businesses: Record<string, string>;
  events: Record<string, { id: string; tiers: Record<string, string> }>;
  batches: Record<string, string>;
  courts: Record<string, string[]>;
  rooms: Record<string, { id: string; beds: string[] }[]>;
  products: { id: string; variant: string; title: string }[];
}

async function seedBusinesses(s: Seeder): Promise<Made> {
  const made: Made = { businesses: {}, events: {}, batches: {}, courts: {}, rooms: {}, products: [] };
  const owner = s.actor("owner");
  const ownerBiz = await s.db.businesses.find({ ownerId: owner.userId }).toArray();
  const byName = (name: string) => ownerBiz.find((b) => b.name.toLowerCase().startsWith(name));
  const smash = byName("smash badminton");
  const play = byName("play arena");
  const college = byName("college print");
  if (!smash || !play || !college) throw new SeedError("The vendor account is missing Smash Badminton Courts, Play Arena or College Print.");
  made.businesses.smash = smash._id.toHexString();
  made.businesses.playarena = play._id.toHexString();
  made.businesses.collegeprint = college._id.toHexString();

  s.say("Smash Badminton Courts: a ground with 3 badminton courts");
  const smashLoc = smash.location;
  const smashVenue = {
    address: [smashLoc?.doorNo, smashLoc?.building, smashLoc?.street, smashLoc?.area].filter(Boolean).join(", ") || "Eluru Road, Gudivada",
    city: smashLoc?.city ?? "Gudivada",
    pincode: smashLoc?.pincode ?? "521301",
    point: smashLoc?.point ?? { lat: 16.4328, lng: 81.0011 },
  };
  made.courts.smash = await s.step("ground-smash", "Smash Badminton Arena: 3 courts, hours, prices, photos, published", async () => {
    const ground = await s.post(owner, `/v1/vendor/businesses/${made.businesses.smash}/grounds`, {
      name: "Smash Badminton Arena",
      description: "Three indoor wooden-floor badminton courts with good lighting, racket rental and shuttles at the counter.",
      venue: { ...smashVenue, address: smashVenue.address.length >= 5 ? smashVenue.address : `${smashVenue.address}, Gudivada` },
      amenities: ["parking", "washrooms", "changing_rooms", "drinking_water", "seating", "equipment"],
    });
    await s.listingPhotos(owner, `/v1/vendor/grounds/${ground.id}/photos`, ["badminton_jump", "badminton_player", "badminton_racket"]);
    const hours = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "06:00", close: "22:00" }));
    for (const n of [1, 2, 3]) {
      await s.post(owner, `/v1/vendor/grounds/${ground.id}/courts`, {
        name: `Court ${n}`,
        sports: ["badminton"],
        slotMinutes: 60,
        hours,
        prices: { base: 30000, weekend: 35000, peak: [{ days: [1, 2, 3, 4, 5], start: "17:00", end: "21:00", price: 40000 }] },
        addOns: [
          { name: "Racket rental", price: 5000, per: "booking" },
          { name: "Mavis 350 shuttle tube", price: 15000, per: "booking" },
        ],
      });
    }
    const live = await s.post(owner, `/v1/vendor/grounds/${ground.id}/publish`);
    return (live.courtList as Data[]).map((c) => c.id as string);
  });
  made.courts.playarena = (await s.db.turfCourts.find({ businessId: play._id, status: "live" }).toArray()).map((c) => c._id.toHexString());

  s.say("Krishna Events: music night and stand-up comedy");
  const krishna = await s.business("owner", "krishna", OWNER_BUSINESSES.krishna);
  made.businesses.krishna = krishna;
  await s.publish("owner", "krishna", krishna, "Krishna Events");
  const venue = { name: "Krishna Events Hall", address: "Plot 18, MG Road, Labbipet, Vijayawada 520010", city: "Vijayawada", point: { lat: 16.504, lng: 80.646 } };
  const music = daysUntil(6, 7);
  made.events.music = await s.step("event-music", "Telugu Melodies Live: music night with 3 ticket tiers, poster, published", async () => {
    const event = await s.post(owner, `/v1/vendor/businesses/${krishna}/events`, {
      title: "Telugu Melodies Live: Music Night",
      description: "An evening of Telugu film melodies and folk hits with a 12-piece live band. Gates open at 6 pm; food stalls inside.",
      kind: "show",
      venue,
      online: null,
      startsAt: istAt(music, "18:30"),
      endsAt: istAt(music, "22:00"),
      team: null,
      tiers: [
        { name: "General", price: 49900, capacity: 300 },
        { name: "Gold", price: 99900, capacity: 120 },
        { name: "VIP", price: 199900, capacity: 40 },
      ],
      questions: [],
      refunds: "standard",
    });
    await s.upload(owner, "POST", `/v1/vendor/events/${event.id}/photo`, s.image("concert_singer") ?? (await card("Music Night", "Krishna Events")));
    await s.post(owner, `/v1/vendor/events/${event.id}/publish`);
    return { id: event.id as string, tiers: Object.fromEntries((event.tiers as Data[]).map((t) => [t.name, t.id])) };
  });
  const comedy = daysUntil(5, 14);
  made.events.comedy = await s.step("event-comedy", "Stand-up Comedy Night: 2 ticket tiers, poster, published", async () => {
    const event = await s.post(owner, `/v1/vendor/businesses/${krishna}/events`, {
      title: "Stand-up Comedy Night: Vijayawada Edition",
      description: "Four comics, two hours of Telugu and English stand-up. 16+ only.",
      kind: "show",
      venue: { name: "The Rooftop Stage", address: "4th Floor, Trendset Mall, Benz Circle, Vijayawada 520010", city: "Vijayawada", point: { lat: 16.4995, lng: 80.656 } },
      online: null,
      startsAt: istAt(comedy, "19:30"),
      endsAt: istAt(comedy, "21:30"),
      team: null,
      tiers: [
        { name: "Standard", price: 34900, capacity: 150 },
        { name: "Front Row", price: 69900, capacity: 30 },
      ],
      questions: [],
      refunds: "standard",
    });
    await s.upload(owner, "POST", `/v1/vendor/events/${event.id}/photo`, s.image("comedy_laugh") ?? (await card("Comedy Night", "Krishna Events")));
    await s.post(owner, `/v1/vendor/events/${event.id}/publish`);
    return { id: event.id as string, tiers: Object.fromEntries((event.tiers as Data[]).map((t) => [t.name, t.id])) };
  });

  s.say("Bright Minds Academy: maths tuition and spoken English");
  const bright = await s.business("owner", "brightminds", OWNER_BUSINESSES.brightminds);
  made.businesses.brightminds = bright;
  await s.publish("owner", "brightminds", bright, "Bright Minds Academy");
  made.batches.maths = await s.step("course-maths", "Class 10 Maths Tuition: in person, evening batch starting soon, published", async () => {
    const course = await s.post(owner, `/v1/vendor/businesses/${bright}/courses`, {
      title: "Class 10 Maths Tuition (AP Board)",
      description: "Algebra, geometry, trigonometry and statistics for the AP SSC exams. Weekly tests, doubt-clearing and printed notes.",
      category: "tuition",
      mode: "offline",
      venue: { name: "Bright Minds Academy", address: "2nd Floor, Sri Lakshmi Complex, NTR Stadium Road, Gudivada 521301", city: "Gudivada", point: { lat: 16.4352, lng: 80.9897 } },
      demo: null,
    });
    await s.upload(owner, "POST", `/v1/vendor/courses/${course.id}/photo`, s.image("class_maths"));
    const withBatch = await s.post(owner, `/v1/vendor/courses/${course.id}/batches`, {
      name: "Evening batch (Mon, Wed, Fri)",
      fee: 250000,
      capacity: 25,
      minStudents: null,
      slots: [1, 3, 5].map((day) => ({ day, start: "17:30", minutes: 90 })),
      startDate: istDate(daysUntil(1, 2)),
      classes: 36,
      endDate: null,
      onlineLink: null,
      coachIds: [],
    });
    await s.post(owner, `/v1/vendor/courses/${course.id}/publish`);
    return (withBatch.batches as Data[])[0].id as string;
  });
  made.batches.english = await s.step("course-english", "Spoken English for Beginners: online, weekend batch starting soon, published", async () => {
    const course = await s.post(owner, `/v1/vendor/businesses/${bright}/courses`, {
      title: "Spoken English for Beginners (Online)",
      description: "Live online classes on everyday conversation, interviews and presentations. Small groups, lots of speaking practice.",
      category: "languages",
      mode: "online",
      venue: null,
      demo: null,
    });
    await s.upload(owner, "POST", `/v1/vendor/courses/${course.id}/photo`, s.image("class_online"));
    const withBatch = await s.post(owner, `/v1/vendor/courses/${course.id}/batches`, {
      name: "Weekend batch (Sat, Sun)",
      fee: 180000,
      capacity: 30,
      minStudents: null,
      slots: [6, 0].map((day) => ({ day, start: "10:00", minutes: 60 })),
      startDate: istDate(daysUntil(6, 3)),
      classes: 16,
      endDate: null,
      onlineLink: "https://meet.jit.si/BrightMindsSpokenEnglish",
      coachIds: [],
    });
    await s.post(owner, `/v1/vendor/courses/${course.id}/publish`);
    return (withBatch.batches as Data[])[0].id as string;
  });

  s.say("Sri Sai Ladies PG: 3 rooms with beds and food");
  const facilities = new Set(((await s.get(null, "/v1/stays/facilities")) as Data[]).map((f) => f.key ?? f.id));
  const pick = (keys: string[]) => keys.filter((k) => facilities.has(k));
  const srisai = await s.business("owner", "srisai", OWNER_BUSINESSES.srisai);
  made.businesses.srisai = srisai;
  await s.publish("owner", "srisai", srisai, "Sri Sai Ladies PG");
  made.rooms.srisai = await s.step("property-srisai", "Sri Sai Ladies PG: property with 3 rooms, meals and photos, published", async () => {
    const property = await s.post(owner, `/v1/vendor/businesses/${srisai}/properties`, {
      name: "Sri Sai Ladies PG, Ameerpet",
      kind: "pg",
      description: "Clean, secure PG for students and working women. Three home-style veg meals, Wi-Fi, laundry and housekeeping.",
      address: { line: "H.No 7-1-212/A, Balkampet Road", area: "Ameerpet", city: "Hyderabad", pincode: "500016", point: { lat: 17.441, lng: 78.444 } },
      for: "women",
      occupants: ["students", "working"],
      food: { type: "veg", meals: ["breakfast", "lunch", "dinner"] },
      facilities: pick(["wifi", "power_backup", "laundry", "housekeeping", "hot_water", "ro_water", "cctv", "security", "study_table", "wardrobe"]),
      rules: { curfew: "22:00", guests: false, smoking: false, alcohol: false, pets: false, notes: "Visitors may meet residents in the lobby until 8 pm." },
      noticeDays: 30,
      deposit: { amount: 1000000, note: "Refundable; one month's rent" },
      nearby: [
        { kind: "metro", name: "Ameerpet Metro Station", km: 0.6 },
        { kind: "office", name: "Maitrivanam IT training centres", km: 0.5 },
        { kind: "college", name: "Vivekananda Degree College", km: 1.2 },
      ],
    });
    await s.listingPhotos(owner, `/v1/vendor/properties/${property.id}/photos`, ["room_white", "room_hotel", "food_thali"]);
    const rooms = [
      { name: "Room 101 · 2 sharing", kind: "shared", beds: 2, prices: { month: 850000, night: null }, features: ["attached_bath", "furnished", "window"] },
      { name: "Room 102 · 3 sharing", kind: "shared", beds: 3, prices: { month: 700000, night: null }, features: ["furnished", "window"] },
      { name: "Room 201 · Single AC", kind: "private", beds: 1, prices: { month: 1400000, night: null }, features: ["ac", "attached_bath", "furnished", "balcony"] },
    ];
    for (const room of rooms) await s.post(owner, `/v1/vendor/properties/${property.id}/rooms`, room);
    const live = await s.post(owner, `/v1/vendor/properties/${property.id}/publish`);
    return (live.rooms as Data[]).map((r) => ({ id: r.id as string, beds: (r.bedList as Data[]).map((b) => b.id as string) }));
  });

  s.say("Fresh Mart: grocery shop with 8 products and home delivery");
  const fresh = await s.business("owner", "freshmart", OWNER_BUSINESSES.freshmart);
  made.businesses.freshmart = fresh;
  await s.step("shop-setup-freshmart", "Fresh Mart: home delivery and pickup set up", async () => {
    await s.put(owner, `/v1/vendor/businesses/${fresh}/shop`, { delivery: true, pickup: true, radiusKm: 10, deliveryFee: { base: 2000, includedKm: 3, perKm: 500 }, minOrder: 10000, returns: false, notes: "Orders before 11 am are delivered the same day." });
    return true;
  });
  await s.publish("owner", "freshmart", fresh, "Fresh Mart");
  made.products = await s.step("products-freshmart", "Fresh Mart: 8 products with photos and prices", async () => {
    const out: { id: string; variant: string; title: string }[] = [];
    for (const p of PRODUCTS) {
      const product = await s.post(owner, `/v1/vendor/businesses/${fresh}/products`, { title: p.title, description: p.description, options: "options" in p ? p.options : [], variants: p.variants, status: "live" });
      await s.upload(owner, "PUT", `/v1/vendor/products/${product.id}/photo`, s.image(p.photo));
      out.push({ id: product.id, variant: (product.variants as Data[])[0].id, title: p.title });
    }
    return out;
  });

  s.say("Demo vendors: Vijaya Prints, Hyderabad Sports Hub, Ameerpet Boys Hostel");
  const vijaya = s.actor("vijaya");
  const prints = await s.business("vijaya", "vijayaprints", DEMO_BUSINESSES.vijayaprints);
  made.businesses.vijayaprints = prints;
  await s.step("pod-setup-vijayaprints", "Vijaya Prints: print products, prices and delivery area set up", async () => {
    await s.call(vijaya, "PATCH", `/v1/vendor/businesses/${prints}/pod`, {
      products: ["tshirts", "documents", "posters", "business_cards", "stickers"],
      serveAll: false,
      cities: ["Vijayawada", "Gudivada", "Hyderabad", "Guntur"],
      turnaroundDays: 2,
      minOrder: 0,
      notes: "Bulk orders of 50+ tees get 10% off. Call us for wedding invitations.",
      prices: [
        { product: "tshirts", basePrice: 34900 },
        { product: "documents", bw: 200, color: 1000 },
        { product: "posters", basePrice: 15000 },
        { product: "business_cards", basePrice: 150 },
        { product: "stickers", basePrice: 500 },
      ],
      deliveryFee: { base: 4000, includedKm: 5, perKm: 0 },
    });
    return true;
  });
  await s.publish("vijaya", "vijayaprints", prints, "Vijaya Prints");

  const arjun = s.actor("arjun");
  const hub = await s.business("arjun", "sportshub", DEMO_BUSINESSES.sportshub);
  made.businesses.sportshub = hub;
  await s.publish("arjun", "sportshub", hub, "Hyderabad Sports Hub");
  made.courts.sportshub = await s.step("ground-sportshub", "Hyderabad Sports Hub: turf with 2 football courts, published", async () => {
    const ground = await s.post(arjun, `/v1/vendor/businesses/${hub}/grounds`, {
      name: "Sports Hub Kondapur",
      description: "FIFA-grade artificial turf with floodlights, open from 5 am to midnight.",
      venue: { address: "Survey No. 66, Whitefields Road, Kondapur", city: "Hyderabad", pincode: "500084", point: { lat: 17.4615, lng: 78.3657 } },
      amenities: ["parking", "floodlights", "washrooms", "changing_rooms", "drinking_water", "seating", "first_aid"],
    });
    await s.listingPhotos(arjun, `/v1/vendor/grounds/${ground.id}/photos`, ["football_night", "football_boots", "football_ball"]);
    const hours = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "05:00", close: "24:00" }));
    for (const name of ["Football Court A (7-a-side)", "Football Court B (5-a-side)"]) {
      await s.post(arjun, `/v1/vendor/grounds/${ground.id}/courts`, {
        name,
        sports: ["football"],
        slotMinutes: 60,
        hours,
        prices: { base: 120000, weekend: 150000, peak: [{ days: [1, 2, 3, 4, 5], start: "18:00", end: "23:00", price: 140000 }] },
        addOns: [{ name: "Bibs and ball", price: 10000, per: "booking" }],
      });
    }
    const live = await s.post(arjun, `/v1/vendor/grounds/${ground.id}/publish`);
    return (live.courtList as Data[]).map((c) => c.id as string);
  });

  const srinivas = s.actor("srinivas");
  const hostel = await s.business("srinivas", "boyshostel", DEMO_BUSINESSES.boyshostel);
  made.businesses.boyshostel = hostel;
  await s.publish("srinivas", "boyshostel", hostel, "Ameerpet Boys Hostel");
  made.rooms.boyshostel = await s.step("property-boyshostel", "Ameerpet Boys Hostel: 3 rooms with beds and food, published", async () => {
    const property = await s.post(srinivas, `/v1/vendor/businesses/${hostel}/properties`, {
      name: "Ameerpet Boys Hostel",
      kind: "hostel",
      description: "Affordable beds for students and working men near the Ameerpet coaching centres, with three meals a day.",
      address: { line: "Plot 45, Mythrivanam Road", area: "Ameerpet", city: "Hyderabad", pincode: "500038", point: { lat: 17.4375, lng: 78.4483 } },
      for: "men",
      occupants: ["students", "working"],
      food: { type: "non_veg", meals: ["breakfast", "lunch", "dinner"] },
      facilities: pick(["wifi", "power_backup", "laundry", "hot_water", "ro_water", "cctv", "parking", "gym", "tv", "study_table"]),
      rules: { curfew: "23:00", guests: false, smoking: false, alcohol: false, pets: false, notes: "ID proof needed at check-in." },
      noticeDays: 15,
      deposit: { amount: 500000, note: "Refundable" },
      nearby: [
        { kind: "metro", name: "Ameerpet Metro Station", km: 0.4 },
        { kind: "office", name: "Maitrivanam IT training centres", km: 0.3 },
      ],
    });
    await s.listingPhotos(srinivas, `/v1/vendor/properties/${property.id}/photos`, ["room_bunk", "room_bunk_wood", "food_curry"]);
    const rooms = [
      { name: "Dorm A · 4 sharing", kind: "shared", beds: 4, prices: { month: 550000, night: 50000 }, features: ["furnished", "window"] },
      { name: "Room B · 3 sharing", kind: "shared", beds: 3, prices: { month: 650000, night: 60000 }, features: ["furnished", "window"] },
      { name: "Room C · 2 sharing AC", kind: "shared", beds: 2, prices: { month: 850000, night: 80000 }, features: ["ac", "attached_bath", "furnished"] },
    ];
    for (const room of rooms) await s.post(srinivas, `/v1/vendor/properties/${property.id}/rooms`, room);
    const live = await s.post(srinivas, `/v1/vendor/properties/${property.id}/publish`);
    return (live.rooms as Data[]).map((r) => ({ id: r.id as string, beds: (r.bedList as Data[]).map((b) => b.id as string) }));
  });
  return made;
}

async function seedSocial(s: Seeder, made: Made): Promise<void> {
  s.say("Posts, follows, likes and comments");
  const postIds = await s.step("posts", `${plural(POSTS.length, "business post")} and ${plural(PERSONAL_POSTS.length, "personal post")} with photos`, async () => {
    const ids: Record<string, string> = {};
    const one = async (by: string, text: string, photo: string, businessId: string | null) => {
      const actor = s.actor(by);
      const media = s.image(photo) ? await s.upload(actor, "POST", "/v1/social/media", s.image(photo)) : null;
      const post = await s.post(actor, "/v1/social/posts", { text, mediaIds: media ? [media.id] : [], kind: businessId ? "business" : "personal", businessId });
      return post.id as string;
    };
    for (const [i, p] of POSTS.entries()) ids[`${p.business}-${i}`] = await one(p.by, p.text, p.photo, made.businesses[p.business]!);
    for (const p of PERSONAL_POSTS) ids[`personal-${p.by}`] = await one(p.by, p.text, p.photo, null);
    return ids;
  });
  const post = (prefix: string, n = 0) => Object.entries(postIds).filter(([k]) => k.startsWith(prefix))[n]?.[1];

  await s.step("follows", "Follows: the customer and demo customers follow the demo businesses' owners", async () => {
    const pairs: [string, string[]][] = [
      ["customer", ["owner", "vijaya", "arjun", "srinivas"]],
      ["lakshmi", ["owner", "srinivas", "arjun"]],
      ["saikiran", ["owner", "vijaya"]],
      ["divya", ["owner", "vijaya"]],
      ["ravi", ["arjun", "srinivas", "owner"]],
      ["harika", ["owner", "vijaya"]],
    ];
    let made = 0;
    for (const [from, tos] of pairs) {
      const follower = s.actor(from);
      for (const to of tos) {
        const followee = s.actor(to);
        const since = new Date(Date.now() - 1000);
        await s.put(follower, `/v1/social/users/${followee.userId.toHexString()}/follow`);
        const follow = await s.db.follows.findOne({ followerId: follower.userId, followeeId: followee.userId, createdAt: { $gte: since } });
        if (follow) {
          made++;
          await s.track(follow._id);
          const notes = await s.db.notifications.find({ userId: followee.userId, actorId: follower.userId, createdAt: { $gte: since } }).toArray();
          await s.track(...notes.map((n) => n._id));
        }
      }
    }
    return made;
  });

  await s.step("reactions", "Likes and comments on the demo posts", async () => {
    const likes: [string, string | undefined][] = [
      ["customer", post("krishna")], ["customer", post("freshmart")], ["customer", post("smash")], ["customer", post("vijayaprints")], ["customer", post("brightminds")],
      ["lakshmi", post("srisai")], ["lakshmi", post("krishna", 1)], ["saikiran", post("smash")], ["saikiran", post("freshmart", 1)],
      ["divya", post("krishna")], ["divya", post("vijayaprints", 1)], ["ravi", post("sportshub")], ["ravi", post("boyshostel")],
      ["harika", post("brightminds")], ["harika", post("collegeprint")], ["vijaya", post("personal-divya")], ["arjun", post("personal-ravi")],
    ];
    for (const [who, id] of likes) if (id) await s.put(s.actor(who), `/v1/social/posts/${id}/like`);
    const comments: [string, string | undefined, string][] = [
      ["customer", post("krishna"), "Booked two Gold tickets already! 🎶"],
      ["customer", post("freshmart"), "Delivery was quick and the vegetables were really fresh 👍"],
      ["lakshmi", post("srisai", 1), "Felt very safe staying here. The food is like home."],
      ["saikiran", post("smash"), "The new courts are superb. See you on Monday evening!"],
      ["ravi", post("sportshub"), "Best turf in Kondapur. Booked for this week."],
      ["harika", post("brightminds"), "Sir explains trigonometry so clearly."],
      ["owner", post("personal-harika"), "All the best for your exams, Harika!"],
    ];
    for (const [who, id, text] of comments) if (id) await s.post(s.actor(who), `/v1/social/posts/${id}/comments`, { text });
    return { likes: likes.length, comments: comments.length };
  });
}

/** A print order with options the shop's setup allows: tees with a design, or document printing with a PDF. */
async function podOrder(s: Seeder, by: string, shopId: string, home: Home, label: string): Promise<{ id: string; orderNo: number }> {
  const actor = s.actor(by);
  const shop = (await s.db.businesses.findOne({ _id: new ObjectId(shopId) })) as BusinessDoc | null;
  const pod = shop?.pod;
  if (!pod) throw new SeedError(`${label}: the print shop has no setup.`);
  const priced = (product: PodProduct) => pod.products.includes(product) && pod.prices.some((p) => p.product === product);
  const choice = (["tshirts", "documents", "posters", "hoodies", "stickers", "business_cards"] as PodProduct[]).find(priced) ?? pod.products[0];
  if (!choice) throw new SeedError(`${label}: the print shop prints nothing yet.`);
  const info = productOf(choice);
  const price = pod.prices.find((p) => p.product === choice)!;
  const minimum = Math.max(price.minQuantity ?? 1, info.minQuantity);
  let body: Record<string, unknown>;
  if (info.pricing === "per_page") {
    const pdf = await notesPdf("Unit 3 Notes: Quadratic Equations", 12);
    const file = await s.call(actor, "POST", "/v1/pod/files", undefined, { data: pdf, type: "application/pdf", name: "unit-3-quadratic-equations.pdf" });
    body = { product: choice, options: { paperSize: "A4", binding: "Spiral bind" }, colour: (price.bw ?? 0) > 0 ? "bw" : "color", quantity: Math.max(2, Math.ceil(minimum / 12)), fileIds: [file.id] };
  } else {
    const design = await card("GUDIVADA STRIKERS", "Cricket Club · 2026", 1500, 1500, "#dc2626");
    const file = await s.call(actor, "POST", "/v1/pod/files", undefined, { data: design, type: "image/jpeg", name: "team-design.jpg" });
    const options: Record<string, string> = {};
    for (const [option, values] of Object.entries(info.options)) {
      const preferred: Record<string, string> = { size: "L", printType: "Screen Print", material: "Cotton", color: "Full Colour", sides: "Front" };
      const value = values?.includes(preferred[option] ?? "") ? preferred[option]! : values?.[0];
      if (value && (option === "size" || option === "sides")) options[option] = value;
    }
    body = { product: choice, options, quantity: Math.max(minimum, 4), fileIds: [file.id] };
  }
  const placed = await s.post(actor, "/v1/pod/orders", {
    shopId,
    ...body,
    address: { name: actor.name, phone: actor.phone.slice(-10), line: home.line, city: home.city, pincode: home.pincode, point: home.point },
    note: "Demo order",
    returnTo: RETURN_TO,
  });
  const status = await s.pay(placed.checkoutUrl);
  if (status !== "placed") throw new SeedError(`${label}: payment left the order ${status}.`);
  return { id: placed.order.id, orderNo: placed.order.orderNo };
}

async function podMove(s: Seeder, vendorKey: string, orderId: string, steps: string[]): Promise<void> {
  for (const status of steps) await s.post(s.actor(vendorKey), `/v1/vendor/orders/${orderId}/status`, { status });
}

async function shopOrder(s: Seeder, by: string, shopId: string, home: Home, lines: { product: number; quantity: number }[], products: Made["products"]): Promise<{ id: string; orderNo: number }> {
  const actor = s.actor(by);
  const placed = await s.post(actor, `/v1/shop/${shopId}/orders`, {
    lines: lines.map((l) => ({ productId: products[l.product]!.id, variantId: products[l.product]!.variant, quantity: l.quantity })),
    method: "delivery",
    address: { name: actor.name, phone: actor.phone.slice(-10), line: home.line, city: home.city, pincode: home.pincode, point: home.point },
    returnTo: RETURN_TO,
  });
  const status = await s.pay(placed.checkoutUrl);
  if (status !== "paid") throw new SeedError(`Fresh Mart order: payment left it ${status}.`);
  return { id: placed.order.id, orderNo: placed.order.orderNo };
}

/** Packed and offered to Ruxstar partners online in Gudivada. */
async function offerToPartners(s: Seeder, orderId: string): Promise<Data> {
  return s.post(s.actor("owner"), `/v1/shop/desk/orders/${orderId}/delivery`, { carrier: "partner" });
}

/** A Ruxstar partner takes the offer, picks up, photographs the parcel and gives the customer's code. */
async function partnerDelivers(s: Seeder, riderKey: string, customerKey: string, orderId: string): Promise<number> {
  const rider = s.actor(riderKey);
  const desk = await s.get(s.actor("owner"), `/v1/shop/desk/orders/${orderId}`);
  const jobId = desk.delivery?.jobId as string | undefined;
  if (!jobId) throw new SeedError("The shop order has no delivery job.");
  await s.post(rider, `/v1/delivery/jobs/${jobId}/accept`);
  await s.post(rider, `/v1/delivery/jobs/${jobId}/pickup`);
  await s.upload(rider, "PUT", `/v1/delivery/jobs/${jobId}/photo`, await card("Delivered", "Parcel at the door", 1200, 900, "#15803d"));
  const mine = await s.get(s.actor(customerKey), `/v1/shop/orders/${orderId}`);
  const code = mine.delivery?.dropCode as string | undefined;
  if (!code) throw new SeedError("The customer's order shows no delivery code.");
  const done = await s.post(rider, `/v1/delivery/jobs/${jobId}/deliver`, { code });
  return done.pay as number;
}

async function turfBook(s: Seeder, by: string, courtId: string, daysAhead: number, at: string): Promise<{ id: string; orderNo: number }> {
  const court = await s.db.turfCourts.findOne({ _id: new ObjectId(courtId) });
  const placed = await s.post(s.actor(by), `/v1/turf/courts/${courtId}/book`, { startAts: [istAt(daysAhead, at)], sport: court?.sports[0], returnTo: RETURN_TO });
  const status = await s.pay(placed.checkoutUrl);
  if (status !== "confirmed") throw new SeedError(`Turf booking: payment left it ${status}.`);
  return { id: placed.booking.id, orderNo: placed.booking.orderNo };
}

async function tickets(s: Seeder, by: string, event: { id: string; tiers: Record<string, string> }, tier: string, guests: string[]): Promise<{ id: string; orderNo: number }> {
  const actor = s.actor(by);
  const placed = await s.post(actor, `/v1/events/${event.id}/tickets`, {
    tickets: guests.map((name, i) => ({ tierId: event.tiers[tier], name, phone: i === 0 ? actor.phone.slice(-10) : `90000001${pad(10 + i)}` })),
    returnTo: RETURN_TO,
  });
  const status = await s.pay(placed.checkoutUrl);
  if (status !== "confirmed" && status !== "free") throw new SeedError(`Tickets: payment left them ${status}.`);
  return { id: placed.order.id, orderNo: placed.order.orderNo };
}

async function enrol(s: Seeder, by: string, batchId: string): Promise<{ id: string; orderNo: number }> {
  const placed = await s.post(s.actor(by), `/v1/coaching/batches/${batchId}/enrol`, { student: { childId: null }, returnTo: RETURN_TO });
  const status = await s.pay(placed.checkoutUrl);
  if (status !== "confirmed" && status !== "free") throw new SeedError(`Enrolment: payment left it ${status}.`);
  return { id: placed.order.id, orderNo: placed.order.orderNo };
}

async function reserve(s: Seeder, by: string, room: { id: string; beds: string[] }, bed: number, moveIn: string, months: number): Promise<{ id: string; orderNo: number }> {
  const placed = await s.post(s.actor(by), `/v1/stays/rooms/${room.id}/reserve`, { bedId: room.beds[bed], moveIn, stay: "month", months, returnTo: RETURN_TO });
  const status = await s.pay(placed.checkoutUrl);
  if (status !== "confirmed") throw new SeedError(`Reservation: payment left it ${status}.`);
  return { id: placed.reservation.id, orderNo: placed.reservation.orderNo };
}

const home = (key: string) => (key === "customer" ? CUSTOMER_HOME : PEOPLE.find((p) => p.key === key)!.home);

interface OrderNote {
  who: string;
  what: string;
  state: string;
  orderNo: number;
}

async function seedOrders(s: Seeder, made: Made): Promise<OrderNote[]> {
  const notes: OrderNote[] = [];
  const note = (who: string, what: string, state: string, order: { orderNo: number }) => notes.push({ who, what, state, orderNo: order.orderNo });
  const b = made.businesses;

  s.say("Orders: print on demand");
  const cpProgress = await s.step("order-customer-collegeprint", "Customer: College Print order, now printing", async () => {
    const o = await podOrder(s, "customer", b.collegeprint!, CUSTOMER_HOME, "College Print");
    await podMove(s, "owner", o.id, ["accepted", "printing"]);
    return o;
  });
  note("customer", "College Print print order", "printing (in progress)", cpProgress);
  const vpDone = await s.step("order-customer-vijayaprints", "Customer: Vijaya Prints order, delivered and reviewed", async () => {
    const o = await podOrder(s, "customer", b.vijayaprints!, CUSTOMER_HOME, "Vijaya Prints");
    await podMove(s, "vijaya", o.id, ["accepted", "printing", "ready", "delivered"]);
    await s.put(s.actor("customer"), `/v1/pod/orders/${o.id}/review`, { rating: 5, text: "Print quality is excellent and it reached Gudivada in two days." });
    return o;
  });
  note("customer", "Vijaya Prints print order", "delivered, reviewed 5★", vpDone);
  const cpDone = await s.step("order-harika-collegeprint", "Harika: College Print order, delivered and reviewed", async () => {
    const o = await podOrder(s, "harika", b.collegeprint!, home("harika"), "College Print");
    await podMove(s, "owner", o.id, ["accepted", "printing", "ready", "delivered"]);
    await s.put(s.actor("harika"), `/v1/pod/orders/${o.id}/review`, { rating: 4, text: "Neatly printed and bound. Will order again before exams." });
    return o;
  });
  note("harika", "College Print print order", "delivered, reviewed 4★", cpDone);
  const vpProgress = await s.step("order-ravi-vijayaprints", "Ravi Teja: Vijaya Prints order, now printing", async () => {
    const o = await podOrder(s, "ravi", b.vijayaprints!, home("ravi"), "Vijaya Prints");
    await podMove(s, "vijaya", o.id, ["accepted", "printing"]);
    return o;
  });
  note("ravi", "Vijaya Prints print order", "printing (in progress)", vpProgress);
  for (const n of await placeNewOrders(s, made, 0)) notes.push(n);

  s.say("Orders: event tickets");
  const music = made.events.music!;
  const comedy = made.events.comedy!;
  const customerName = s.actor("customer").name;
  note("customer", "2 Gold tickets, Telugu Melodies Live", "confirmed (QR tickets)", await s.step("order-customer-music", "Customer: 2 music night tickets", () => tickets(s, "customer", music, "Gold", [customerName, "Sravani K"])));
  note("divya", "1 General ticket, Telugu Melodies Live", "confirmed", await s.step("order-divya-music", "Divya Sri: 1 music night ticket", () => tickets(s, "divya", music, "General", ["Divya Sri Kommineni"])));
  note("lakshmi", "2 Standard tickets, Comedy Night", "confirmed", await s.step("order-lakshmi-comedy", "Lakshmi Prasanna: 2 comedy tickets", () => tickets(s, "lakshmi", comedy, "Standard", ["Lakshmi Prasanna Bandi", "Keerthi B"])));
  note("saikiran", "1 Front Row ticket, Comedy Night", "confirmed", await s.step("order-saikiran-comedy", "Sai Kiran: 1 comedy ticket", () => tickets(s, "saikiran", comedy, "Front Row", ["Sai Kiran Reddy"])));

  s.say("Orders: coaching");
  note("customer", "Class 10 Maths Tuition enrolment", "confirmed", await s.step("order-customer-maths", "Customer: maths tuition enrolment", () => enrol(s, "customer", made.batches.maths!)));
  note("harika", "Class 10 Maths Tuition enrolment", "confirmed", await s.step("order-harika-maths", "Harika: maths tuition enrolment", () => enrol(s, "harika", made.batches.maths!)));
  note("lakshmi", "Spoken English (online) enrolment", "confirmed", await s.step("order-lakshmi-english", "Lakshmi Prasanna: spoken English enrolment", () => enrol(s, "lakshmi", made.batches.english!)));
  note("divya", "Spoken English (online) enrolment", "confirmed", await s.step("order-divya-english", "Divya Sri: spoken English enrolment", () => enrol(s, "divya", made.batches.english!)));

  s.say("Orders: turf bookings");
  const smash = made.courts.smash!;
  note("customer", "Smash Badminton Court 1, tomorrow 7 pm", "confirmed", await s.step("order-customer-smash", "Customer: ground booking tomorrow evening", () => turfBook(s, "customer", smash[0]!, 1, "19:00")));
  note("saikiran", "Smash Badminton Court 2, in 2 days 6 pm", "confirmed", await s.step("order-saikiran-smash", "Sai Kiran: badminton booking", () => turfBook(s, "saikiran", smash[1] ?? smash[0]!, 2, "18:00")));
  if (made.courts.playarena?.[0]) {
    note("harika", "Play Arena Kids court, in 2 days 5 pm", "confirmed", await s.step("order-harika-playarena", "Harika: Play Arena booking", () => turfBook(s, "harika", made.courts.playarena![0]!, 2, "17:00")));
  }
  const hub = made.courts.sportshub!;
  note("ravi", "Sports Hub Court A, in 2 days 8 pm", "confirmed", await s.step("order-ravi-sportshub", "Ravi Teja: football turf booking", () => turfBook(s, "ravi", hub[0]!, 2, "20:00")));
  note("lakshmi", "Sports Hub Court B, in 3 days 7 am", "confirmed", await s.step("order-lakshmi-sportshub", "Lakshmi Prasanna: football turf booking", () => turfBook(s, "lakshmi", hub[1] ?? hub[0]!, 3, "07:00")));

  s.say("Orders: stays");
  const nextMonth = firstOfNextMonth();
  // Stays takes at most one month's rent up front.
  note("lakshmi", `Sri Sai Ladies PG, Room 101 bed from ${nextMonth}, first month paid`, "confirmed", await s.step("order-lakshmi-srisai", "Lakshmi Prasanna: PG reservation for next month", () => reserve(s, "lakshmi", made.rooms.srisai![0]!, 0, nextMonth, 1)));
  note("ravi", `Ameerpet Boys Hostel, Dorm A bed from ${nextMonth}, first month paid`, "confirmed", await s.step("order-ravi-boyshostel", "Ravi Teja: hostel reservation", () => reserve(s, "ravi", made.rooms.boyshostel![0]!, 0, nextMonth, 1)));
  note("saikiran", `Ameerpet Boys Hostel, Room B bed from ${nextMonth}, first month paid`, "confirmed", await s.step("order-saikiran-boyshostel", "Sai Kiran: hostel reservation", () => reserve(s, "saikiran", made.rooms.boyshostel![1]!, 0, nextMonth, 1)));

  s.say("Orders: Fresh Mart, with Ruxstar partner deliveries");
  const naveen = s.actor("naveen");
  await s.step("rider-naveen-gudivada", "Naveen online in Gudivada for the two shop deliveries", async () => {
    await s.post(naveen, "/v1/delivery/online", { online: true, city: "Gudivada" });
    return true;
  });
  const delivered = async (key: string, by: string, lines: { product: number; quantity: number }[], review: { product: number; rating: number; text: string }) =>
    s.step(key, `${by === "customer" ? "Customer" : "Sai Kiran"}: Fresh Mart order delivered by a Ruxstar partner and reviewed`, async () => {
      const o = await shopOrder(s, by, b.freshmart!, home(by), lines, made.products);
      for (const status of ["accepted", "packed"]) await s.post(s.actor("owner"), `/v1/shop/desk/orders/${o.id}/move`, { status });
      await offerToPartners(s, o.id);
      const pay = await partnerDelivers(s, "naveen", by, o.id);
      await s.put(s.actor(by), `/v1/shop/orders/${o.id}/products/${made.products[review.product]!.id}/review`, { rating: review.rating, text: review.text });
      return { ...o, pay };
    });
  const first = await delivered("order-customer-freshmart-delivered", "customer", [{ product: 0, quantity: 1 }, { product: 1, quantity: 1 }, { product: 2, quantity: 2 }], { product: 0, rating: 5, text: "Good quality rice, delivered in 30 minutes." });
  note("customer", "Fresh Mart: rice, oil, milk", `delivered by Naveen (partner pay ${rupees(first.pay)}), reviewed 5★`, first);
  const second = await delivered("order-saikiran-freshmart-delivered", "saikiran", [{ product: 1, quantity: 1 }, { product: 4, quantity: 1 }, { product: 5, quantity: 1 }], { product: 1, rating: 4, text: "Oil smells fresh. Packing could be better." });
  note("saikiran", "Fresh Mart: oil, bananas, eggs", `delivered by Naveen (partner pay ${rupees(second.pay)}), reviewed 4★`, second);
  await s.step("rider-naveen-vijayawada", "Naveen back online in Vijayawada", async () => {
    await s.post(naveen, "/v1/delivery/online", { online: true, city: "Vijayawada" });
    return true;
  });

  const ready = await s.step("order-customer-freshmart-ready", "Customer: Fresh Mart order packed and waiting for a partner", async () => {
    const o = await shopOrder(s, "customer", b.freshmart!, CUSTOMER_HOME, [{ product: 3, quantity: 2 }, { product: 6, quantity: 1 }, { product: 5, quantity: 1 }], made.products);
    for (const status of ["accepted", "packed"]) await s.post(s.actor("owner"), `/v1/shop/desk/orders/${o.id}/move`, { status });
    return o;
  });
  await riderOnline(s);
  const offer = await s.step("offer-freshmart-ready", "Fresh Mart: the packed order offered to partners in Gudivada", async () => {
    const answer = await offerToPartners(s, ready.id);
    return { offerUntil: answer?.delivery?.offerUntil ?? null, pay: answer?.delivery?.pay ?? null };
  });
  note("customer", "Fresh Mart: tomatoes, onions, eggs", `packed, offered to partners (pay ${offer.pay ? rupees(offer.pay) : "?"})`, ready);
  return notes;
}

/** Venkateswarlu online in Gudivada, the city key Fresh Mart's offers use. His state before the first run is kept. */
async function riderOnline(s: Seeder): Promise<void> {
  const rider = s.actor("rider");
  if (!s.doc.before.riderState) {
    const state = await s.db.riderStates.findOne({ _id: rider.userId });
    await s.remember({ before: { ...s.doc.before, riderState: state ? { online: state.online, city: state.city, point: state.point } : { online: false, city: null, point: null } } });
  }
  await s.post(rider, "/v1/delivery/online", { online: true, city: "Gudivada" });
}

/** One order waiting for acceptance at College Print, Vijaya Prints and Fresh Mart. Round 0 is the first run; --refresh makes the next ones. */
async function placeNewOrders(s: Seeder, made: Made, round: number): Promise<OrderNote[]> {
  const b = made.businesses;
  const tag = round ? `-r${round}` : "";
  const out: OrderNote[] = [];
  const cp = await s.step(`new-collegeprint${tag}`, "Sai Kiran: new College Print order waiting for acceptance", async () => ({ ...(await podOrder(s, "saikiran", b.collegeprint!, home("saikiran"), "College Print")), kind: "pod", vendor: "owner" }));
  out.push({ who: "saikiran", what: "College Print print order", state: "NEW (waiting for acceptance)", orderNo: cp.orderNo });
  const vp = await s.step(`new-vijayaprints${tag}`, "Divya Sri: new Vijaya Prints order waiting for acceptance", async () => ({ ...(await podOrder(s, "divya", b.vijayaprints!, home("divya"), "Vijaya Prints")), kind: "pod", vendor: "vijaya" }));
  out.push({ who: "divya", what: "Vijaya Prints print order", state: "NEW (waiting for acceptance)", orderNo: vp.orderNo });
  const fm = await s.step(`new-freshmart${tag}`, "Harika: new Fresh Mart order waiting for acceptance", async () => ({ ...(await shopOrder(s, "harika", b.freshmart!, home("harika"), [{ product: 7, quantity: 2 }, { product: 4, quantity: 1 }, { product: 2, quantity: 1 }], made.products)), kind: "shop", vendor: "owner" }));
  out.push({ who: "harika", what: "Fresh Mart: masala, bananas, milk", state: "NEW (waiting for acceptance)", orderNo: fm.orderNo });
  return out;
}

// Working out what the run made, for the counts and --remove.

const SKIP = new Set(["demo_seed"]);

/**
 * Every document made since the run started that refers to something the run made, found again and again until nothing new
 * turns up. Documents older than the run are never claimed, and existing accounts only through what the run made for them.
 */
async function claim(s: Seeder): Promise<Record<string, string[]>> {
  const since = s.doc.startedAt;
  const known = new Set<string>([...s.doc.ids, ...Object.values(s.doc.demoUsers), ...s.doc.sessions]);
  const demoUsers = new Set(Object.values(s.doc.demoUsers));
  const demoPhones = new Set(PEOPLE.map((p) => `+91${p.phone}`));
  const names = (await s.db.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !SKIP.has(n) && !n.startsWith("system."));
  const pool: { coll: string; id: string; self: string | null; refs: string[]; claimed: boolean }[] = [];
  for (const coll of names) {
    const docs = await s.db.db
      .collection(coll)
      .find({ $or: [{ _id: { $gte: s.floor } }, { _id: { $not: { $type: "objectId" } }, createdAt: { $gte: since } }] } as Document)
      .toArray();
    for (const doc of docs) {
      const self = doc._id instanceof ObjectId ? doc._id.toHexString() : null;
      const text = JSON.stringify(doc);
      const refs = [...new Set(text.match(HEX) ?? [])].filter((h) => h !== self);
      let claimed = false;
      if (coll === "users") claimed = !!self && demoUsers.has(self);
      else if (coll === "audit_logs") claimed = doc.ip === SEEDER_IP;
      else if (coll === "otps") claimed = demoPhones.has(String(doc.target));
      pool.push({ coll, id: self ?? String(doc._id), self, refs, claimed: claimed || (!!self && known.has(self)) });
    }
  }
  for (const p of pool) if (p.claimed && p.self) known.add(p.self);
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of pool) {
      if (p.claimed || p.coll === "users") continue;
      if (p.refs.some((r) => known.has(r))) {
        p.claimed = true;
        changed = true;
        if (p.self) known.add(p.self);
      }
    }
  }
  const out: Record<string, string[]> = {};
  for (const p of pool) if (p.claimed) (out[p.coll] ??= []).push(p.id);
  return out;
}

function printCounts(say: Say, claimed: Record<string, string[]>): void {
  const rows = Object.entries(claimed)
    .map(([coll, ids]) => [coll, ids.length] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  say(`Made by the demo, by collection (${rows.reduce((n, [, c]) => n + c, 0)} documents):`);
  for (const [coll, n] of rows) say(`  ${coll.padEnd(24)} ${n}`);
}

/** Public reads, as a visitor would see Discover. */
async function verify(s: Seeder): Promise<void> {
  s.say("Checking Discover through the public API:");
  const checks: [string, string, string[]][] = [
    ["Events, Vijayawada", "/v1/events/?city=Vijayawada&limit=50", ["Telugu Melodies Live", "Stand-up Comedy Night"]],
    ["Coaching, Gudivada", "/v1/coaching/?city=Gudivada&limit=50", ["Class 10 Maths Tuition"]],
    ["Coaching, online", "/v1/coaching/?online=true&limit=50", ["Spoken English for Beginners"]],
    ["Turf, Gudivada", "/v1/turf/?city=Gudivada&limit=50", ["Smash Badminton Arena"]],
    ["Turf, Hyderabad", "/v1/turf/?city=Hyderabad&limit=50", ["Sports Hub Kondapur"]],
    ["Stays, Hyderabad", "/v1/stays/?city=Hyderabad&limit=50", ["Sri Sai Ladies PG", "Ameerpet Boys Hostel"]],
    ["Shops, Gudivada", "/v1/shop/?city=Gudivada&limit=50", ["Fresh Mart"]],
    ["Print shops, Vijayawada (signed in)", "/v1/pod/shops?city=Vijayawada&limit=50", ["Vijaya Prints"]],
  ];
  const divya = PEOPLE.find((p) => p.key === "divya")!;
  const viewer = await s.mint("verify", new ObjectId(s.doc.demoUsers.divya), divya.name, `+91${divya.phone}`);
  for (const [label, url, want] of checks) {
    try {
      const text = JSON.stringify(await s.get(label.includes("signed in") ? viewer : null, url));
      const missing = want.filter((w) => !text.includes(w));
      s.say(`  ${missing.length ? "✗" : "✓"} ${label}: ${missing.length ? `missing ${missing.join(", ")}` : `shows ${want.join(", ")}`}`);
    } catch (err) {
      s.say(`  ✗ ${label}: ${(err as Error).message}`);
    }
  }
}

// Modes.

async function preflight(s: Seeder): Promise<string[]> {
  const notes: string[] = [];
  for (const [key, spec] of Object.entries(EXISTING)) {
    const user = await s.db.users.findOne({ phone: spec.phone });
    if (!user) throw new SeedError(`The ${spec.label} account ${maskPhone(spec.phone)} is not in ${DEMO_DB}.`);
    const roles = Object.entries(user.roles ?? {}).filter(([, on]) => on).map(([r]) => r).join(", ") || "none";
    notes.push(`${spec.label} ${maskPhone(spec.phone)}: found (${user.name ?? "no name"}; roles ${roles})`);
    if (key === "admin" && (!user.roles?.admin || user.username !== EXISTING.admin.username)) throw new SeedError("The admin account is not @ruxstar.admin with the admin role.");
    if (key === "owner" && !user.roles?.vendor) throw new SeedError("The vendor account has no vendor role.");
    if (key === "rider" && (!user.roles?.delivery || user.kyc?.delivery !== "approved")) throw new SeedError("Venkateswarlu's delivery verification is not approved.");
    if (key === "rider") {
      const busy = await s.db.deliveryJobs.findOne({ riderId: user._id, busy: true });
      if (busy) notes.push(`  Venkateswarlu has delivery #${busy.orderNo} in hand, so he can't take new jobs until it is finished; the demo rider makes the completed deliveries`);
    }
  }
  const taken = await s.db.users.find({ phone: { $in: PEOPLE.map((p) => `+91${p.phone}`) } }).toArray();
  const ours = new Set(Object.values(s.doc?.demoUsers ?? {}));
  const strangers = taken.filter((u) => !ours.has(u._id.toHexString()));
  if (strangers.length) throw new SeedError(`Refusing: ${plural(strangers.length, "demo number")} already belong to accounts: ${strangers.map((u) => maskPhone(u.phone)).join(", ")}.`);
  const modules = await s.db.moduleSettings.find({}).toArray();
  for (const m of ["pod", "events", "coaching", "stays", "turf", "shop", "delivery"]) {
    const doc = modules.find((d) => d.module === m) as Record<string, unknown> | undefined;
    if (!doc) throw new SeedError(`Module ${m} has no settings.`);
    if (!doc.live) throw new SeedError(`Module ${m} is not live.`);
    if (m !== "delivery" && !doc.signupsOpen) throw new SeedError(`Module ${m} is not taking new businesses (signups closed).`);
    if (doc.gstinRequired) throw new SeedError(`Module ${m} needs a GSTIN to publish; the demo businesses have none.`);
  }
  const shop = modules.find((d) => d.module === "shop");
  notes.push(`shop module: partner delivery ${shop?.deliveryEnabled ? "already on" : "off; the run switches it on in the console (--remove switches it back)"}`);
  return notes;
}

function printPlan(say: Say): void {
  say("Plan:");
  say("  Vendor +91••••2365: Smash Badminton gets a ground with 3 courts; new Krishna Events (music night, comedy show), Bright Minds Academy");
  say("    (maths tuition in person, spoken English online), Sri Sai Ladies PG (3 rooms), Fresh Mart (8 products, home delivery);");
  say("    2 posts per business; sandbox payout account; orders on every business, some NEW, some completed.");
  say("  Customer +91••••5856: follows, likes, comments; print order printing; Vijaya Prints order delivered and reviewed;");
  say("    2 music tickets; maths enrolment; badminton tomorrow 7 pm; Fresh Mart order delivered and reviewed; one packed and offered.");
  say("  Rider +91••••4997: sandbox payout account; online in Gudivada with the Fresh Mart offer waiting.");
  say("  New logins +91 90000 00101 to 00109: 3 verified vendors (Vijaya Prints, Hyderabad Sports Hub, Ameerpet Boys Hostel),");
  say("    5 customers, 1 rider in Vijayawada (delivery verified), each with a profile photo; payout accounts for vendors and riders.");
  say("  Skipped: the customer's PG reservation (stays needs his identity verification, which is unfinished); demo customers reserve instead.");
}

async function apply(s: Seeder, resume: boolean): Promise<void> {
  await s.start(resume);
  const password = s.readPassword();
  if (Object.keys(s.doc.demoUsers).length && !password) throw new SeedError("The demo accounts exist but .temp/demo-accounts.txt with their password is gone. Run --remove --apply and start again.");
  s.password = password ?? `Rux${randomInt(100, 999)}${randomBytes(6).toString("base64url").replace(/[-_]/g, "x")}demo`;
  s.writeAccounts();
  s.images = await loadImages(s.say);
  await s.build();
  try {
    await s.existing();
    await s.moduleSwitch("shop", "deliveryEnabled", true);
    s.say("Demo accounts");
    await s.demoAccounts();
    s.say("Verification");
    for (const [i, person] of PEOPLE.entries()) if (person.kyc) await s.baseKyc(person, i);
    await s.riderKyc(PEOPLE.find((p) => p.role === "rider")!);
    s.say("Payout accounts");
    for (const key of ["owner", "vijaya", "arjun", "srinivas"]) await s.payoutAccount(s.actor(key), "vendor");
    for (const key of ["rider", "naveen"]) await s.payoutAccount(s.actor(key), "rider");
    const made = await seedBusinesses(s);
    await seedSocial(s, made);
    const orders = await seedOrders(s, made);
    await s.step("made", "Recorded what was made", async () => made);
    await finish(s);
    printOrders(s.say, orders);
    await verify(s);
  } finally {
    await revokeSessions(s);
    await s.close();
  }
}

async function finish(s: Seeder): Promise<void> {
  await revokeSessions(s);
  const claimed = await claim(s);
  await s.remember({ claimed, status: "done", finishedAt: new Date() });
  printCounts(s.say, claimed);
}

/** Ends the seeder's own sessions and the ones signup opened for the demo accounts, so their logins start fresh. */
async function revokeSessions(s: Seeder): Promise<void> {
  const now = new Date();
  const ids = s.doc.sessions.map((id) => new ObjectId(id));
  const demo = Object.values(s.doc.demoUsers).map((id) => new ObjectId(id));
  await s.db.sessions.updateMany({ $or: [{ _id: { $in: ids } }, { userId: { $in: demo } }], revokedAt: null }, { $set: { revokedAt: now, updatedAt: now } });
}

function printOrders(say: Say, notes: OrderNote[]): void {
  const names: Record<string, string> = { customer: "Customer (+91••••5856)", ...Object.fromEntries(PEOPLE.map((p) => [p.key, p.name])) };
  say("Orders:");
  for (const n of notes) say(`  #${n.orderNo}  ${names[n.who] ?? n.who}: ${n.what}: ${n.state}`);
}

/** Before a demo: the orders waiting for acceptance replaced with fresh ones (6 hours to accept), and the delivery offer re-sent. */
async function refresh(s: Seeder): Promise<void> {
  await s.attach();
  if (s.doc.status !== "done") throw new SeedError("The demo run is not finished; run --apply --resume first.");
  const made = s.doc.steps.made as Made | undefined;
  if (!made) throw new SeedError("The run has no record of what it made.");
  s.password = s.readPassword() ?? "";
  await s.build();
  try {
    await s.existing();
    for (const person of PEOPLE) await s.mint(person.key, new ObjectId(s.doc.demoUsers[person.key]!), person.name, `+91${person.phone}`);
    const round = s.doc.refreshes + 1;
    const tag = s.doc.refreshes ? `-r${s.doc.refreshes}` : "";
    for (const key of ["collegeprint", "vijayaprints", "freshmart"]) {
      const last = s.doc.steps[`new-${key}${tag}`] as { id: string; kind: string; vendor: string } | undefined;
      if (!last) continue;
      const vendor = s.actor(last.vendor);
      if (last.kind === "pod") {
        const order = await s.get(vendor, `/v1/vendor/orders/${last.id}`);
        if (order.status === "placed") await s.post(vendor, `/v1/vendor/orders/${last.id}/status`, { status: "rejected", reason: "Replaced with a fresh demo order." });
      } else {
        const order = await s.get(vendor, `/v1/shop/desk/orders/${last.id}`);
        if (order.status === "paid") await s.post(vendor, `/v1/shop/desk/orders/${last.id}/cancel`, { reason: "Replaced with a fresh demo order." });
      }
    }
    const fresh = await placeNewOrders(s, made, round);
    await s.remember({ refreshes: round });
    const ready = s.doc.steps["order-customer-freshmart-ready"] as { id: string; orderNo: number };
    await riderOnline(s);
    const desk = await s.get(s.actor("owner"), `/v1/shop/desk/orders/${ready.id}`);
    const status = desk.delivery?.status as string | undefined;
    const until = desk.delivery?.offerUntil ? new Date(desk.delivery.offerUntil) : null;
    let offer = `Fresh Mart order #${ready.orderNo}: `;
    if (desk.status !== "packed") offer += `left as it is (${desk.status})`;
    else if (status === "offered" && until && until.getTime() > Date.now() + 5 * 60_000) offer += `still offered until ${until.toISOString()}`;
    else {
      if (status === "offered") await s.call(s.actor("owner"), "DELETE", `/v1/shop/desk/orders/${ready.id}/delivery`);
      const answer = await offerToPartners(s, ready.id);
      offer += `offered again to partners in Gudivada until ${answer?.delivery?.offerUntil ?? "?"}`;
    }
    await revokeSessions(s);
    const claimed = await claim(s);
    await s.remember({ claimed });
    printOrders(s.say, fresh);
    s.say(offer);
    s.say("Venkateswarlu is online in Gudivada. If he still has his College Print delivery in hand, he must finish it before accepting.");
    await verify(s);
  } finally {
    await revokeSessions(s);
    await s.close();
  }
}

const MEDIA_PREFIXES = ["post-media/", "business-media/", "turf-media/", "stays-media/", "shop-media/", "events-media/", "coaching-media/"];

/** Deletes what the run made and puts back what it changed. Without --apply, only lists it. */
async function remove(s: Seeder, write: boolean): Promise<void> {
  await s.attach();
  const claimed = await claim(s);
  printCounts(s.say, claimed);
  const docs = new Map<string, Document[]>();
  for (const [coll, ids] of Object.entries(claimed)) {
    const keys = ids.map((id) => (ObjectId.isValid(id) && id.length === 24 ? new ObjectId(id) : id));
    docs.set(coll, await s.db.db.collection(coll).find({ _id: { $in: keys } } as Document).toArray());
  }
  const keys = new Map<string, StoreKind | null>(s.doc.keys.map((k) => [k.key, k.store]));
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object" && !(value instanceof ObjectId) && !(value instanceof Date)) {
      for (const [k, v] of Object.entries(value)) {
        if (k === "key" && typeof v === "string" && v.includes("/") && !keys.has(v)) keys.set(v, null);
        else walk(v);
      }
    }
  };
  for (const list of docs.values()) list.forEach(walk);
  s.say(`Bucket objects: ${keys.size}`);
  s.say(`Put back: ${s.doc.before.modules.map((m) => `${m.module}.${m.field} = ${String(m.value)}`).join(", ") || "no module settings"}${s.doc.before.riderState ? "; Venkateswarlu's online state" : ""}`);
  if (!write) return s.say("Dry run: nothing deleted. Add --apply to delete it.");

  s.password = "";
  await s.build();
  try {
    const admin = await s.db.users.findOne({ phone: EXISTING.admin.phone });
    if (!admin) throw new SeedError("The admin account is gone.");
    const adminActor = await s.mint("admin", admin._id, admin.name ?? "Ruxstar admin", EXISTING.admin.phone);
    for (const m of s.doc.before.modules) await s.call(adminActor, "PATCH", `/v1/ruxstar/modules/${m.module}`, { [m.field]: m.value });

    // Counts kept on people who stay: posts, likes, comments and follows on the existing accounts.
    const gone = (coll: string) => docs.get(coll) ?? [];
    const goneIds = (coll: string) => new Set(gone(coll).map((d) => String(d._id)));
    const demo = new Set(Object.values(s.doc.demoUsers));
    const postsGone = goneIds("posts");
    const inc = new Map<string, Record<string, number>>();
    const bump = (userId: unknown, field: string, by: number) => {
      const id = String(userId);
      if (demo.has(id)) return;
      const row = inc.get(id) ?? {};
      row[field] = (row[field] ?? 0) + by;
      inc.set(id, row);
    };
    for (const post of gone("posts")) {
      bump(post.authorId, "social.posts", -1);
      bump(post.authorId, "social.engagements", -((post.counts?.likes ?? 0) + (post.counts?.comments ?? 0)));
    }
    const survivingPost = async (postId: unknown) => (postsGone.has(String(postId)) ? null : s.db.posts.findOne({ _id: postId as ObjectId }));
    for (const r of gone("post_reactions")) {
      if (r.kind !== "like") continue;
      const post = await survivingPost(r.postId);
      if (post) {
        await s.db.posts.updateOne({ _id: post._id }, { $inc: { "counts.likes": -1 } });
        bump(post.authorId, "social.engagements", -1);
      }
    }
    for (const c of gone("post_comments")) {
      const post = await survivingPost(c.postId);
      if (post && c.status === "live") {
        await s.db.posts.updateOne({ _id: post._id }, { $inc: { "counts.comments": -1 } });
        bump(post.authorId, "social.engagements", -1);
      }
    }
    for (const f of gone("follows")) {
      bump(f.followerId, "social.following", -1);
      bump(f.followeeId, "social.followers", -1);
    }

    for (const [coll, list] of docs) {
      if (!list.length) continue;
      const res = await s.db.db.collection(coll).deleteMany({ _id: { $in: list.map((d) => d._id) } } as Document);
      s.say(`  deleted ${String(res.deletedCount).padStart(4)} from ${coll}`);
    }
    for (const [id, set] of inc) await s.db.users.updateOne({ _id: new ObjectId(id) }, { $inc: set });
    const shops = new Set(gone("pod_reviews").map((r) => String(r.shopId)));
    const businessesGone = goneIds("businesses");
    for (const shopId of shops) if (!businessesGone.has(shopId)) await refreshRating(s.db, new ObjectId(shopId));

    const before = s.doc.before.riderState;
    const rider = await s.db.users.findOne({ phone: EXISTING.rider.phone });
    if (before && rider) await s.db.riderStates.updateOne({ _id: rider._id }, { $set: { online: before.online, city: before.city, point: before.point, updatedAt: new Date() } });

    let removed = 0;
    for (const [key, store] of keys) {
      const stores: StoreKind[] = store ? [store] : key.startsWith("avatars/") || key.startsWith("profile") ? ["photos"] : MEDIA_PREFIXES.some((p) => key.startsWith(p)) ? ["media"] : ["printFiles"];
      for (const kind of stores) await s.app[kind].remove(key);
      removed++;
    }
    s.say(`  removed ${removed} bucket objects`);
    await s.db.db.collection("demo_seed").deleteMany({});
    s.say("Demo removed. .temp/demo-accounts.txt and .temp/demo-images are left on disk.");
  } finally {
    await s.close();
  }
}

/** Everything that must never be printed. */
function secretsOf(env: NodeJS.ProcessEnv, extra: string[]): string[] {
  const uri = env.MONGODB_URI?.trim();
  const secrets = [uri, env.PAYOUT_ENCRYPTION_KEY, env.JWT_SECRET, ...extra];
  try {
    if (uri) secrets.push(decodeURIComponent(new URL(uri).password), new URL(uri).password);
  } catch {
    // Seed lists with several hosts are not URLs; the whole URI is still hidden.
  }
  return secrets.filter((s): s is string => Boolean(s && s.length >= 4));
}

async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      resume: { type: "boolean", default: false },
      refresh: { type: "boolean", default: false },
      remove: { type: "boolean", default: false },
    },
    strict: true,
  });
  const config = loadConfig(env);
  if (config.mongo?.db !== DEMO_DB) throw new SeedError(`Refusing: this seeds ${DEMO_DB} only, and MONGODB_DB is ${config.mongo?.db ?? "not set"}.`);
  if (!config.jwtSecret) throw new SeedError("Set JWT_SECRET; the seeder signs in through the app's own sessions.");
  const db = createDatabase(config.mongo.uri, config.mongo.db);
  let password = "";
  const say: Say = (line) => {
    let text = line;
    for (const secret of secretsOf(env, password ? [password] : [])) text = text.split(secret).join("•••");
    console.log(text);
  };
  await db.client.connect();
  db.ready = true;
  const s = new Seeder(config, db, (line) => {
    password = s.password;
    say(line);
  });
  try {
    if (values.remove) return await remove(s, values.apply);
    if (values.refresh) {
      if (!values.apply) {
        await s.attach();
        return say("Dry run: --refresh --apply replaces the 3 orders waiting for acceptance and re-offers the packed Fresh Mart order.");
      }
      return await refresh(s);
    }
    const run = await s.load();
    if (run) s.doc = run;
    say(`Database ${DEMO_DB}: ${run ? `a demo run is already recorded (${run.status}, started ${run.startedAt.toISOString()})` : "no demo run recorded yet"}`);
    for (const line of await preflight(s)) say(`  ${line}`);
    printPlan(say);
    if (!values.apply) {
      await loadImages(say);
      return say("Dry run: nothing written. Add --apply to write it.");
    }
    await apply(s, values.resume);
  } finally {
    await db.close();
  }
}

// Windows paths can reach here in either case.
if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  try {
    await main(process.env);
  } catch (err) {
    const known = err instanceof SeedError || err instanceof ConfigError;
    let message = known
      ? (err as Error).message
      : `Failed: ${err instanceof Error ? err.message : String(err)}\nSteps after the last ✓ above are unfinished. Fix the problem, then run again with --apply --resume.`;
    for (const secret of secretsOf(process.env, [])) message = message.split(secret).join("•••");
    console.error(message);
    process.exitCode = 1;
  }
}
