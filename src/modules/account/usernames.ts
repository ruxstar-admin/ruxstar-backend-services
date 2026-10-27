import { randomInt } from "node:crypto";
import type { ClientSession, ObjectId } from "mongodb";
import type { Database } from "../../platform/db.js";

export const USERNAME = /^[a-z0-9_.]{3,20}$/;

/** Names people would mistake for Ruxstar itself. */
const RESERVED = new Set([
  "admin", "administrator", "api", "app", "help", "info", "official", "root", "ruxstar", "ruxstarapp",
  "ruxstarofficial", "security", "staff", "support", "system", "team", "www",
]);

export const isReserved = (username: string) => RESERVED.has(username.replace(/[._]/g, ""));

/** "Éaswanth  Konduru" gives ["easwanth", "konduru"]. Digits-only words are dropped. */
function words(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !/^\d+$/.test(word));
}

const tidy = (handle: string) =>
  handle.replace(/[._]{2,}/g, ".").replace(/^[._]+/, "").slice(0, 20).replace(/[._]+$/, "");

/** Handles built from the name first, then numbered ones, most readable first. */
function candidates(name: string, typed?: string): string[] {
  const [first, ...rest] = words(name);
  const last = rest.at(-1);
  const stem = tidy(typed ?? "") || first || "star";
  const built = [
    typed,
    first,
    first && last && `${first}.${last}`,
    first && last && `${first}${last}`,
    first && last && `${first}_${last}`,
    first && last && `${first}.${last[0]}`,
    first && last && `${first[0]}.${last}`,
  ];
  const numbered = Array.from({ length: 6 }, (_, i) => `${stem.slice(0, 16)}${i < 3 ? randomInt(10, 100) : randomInt(1000, 10000)}`);
  const unique = new Set(
    [...built, ...numbered]
      .filter((h): h is string => Boolean(h))
      .map(tidy)
      .filter((h) => USERNAME.test(h) && !isReserved(h)),
  );
  return [...unique];
}

/** Up to `count` free handles, in one query. `self` is left out, since it already owns its handle. */
export async function suggestUsernames(
  db: Database,
  name: string,
  { typed, count = 4, session }: { typed?: string; count?: number; session?: ClientSession } = {},
): Promise<string[]> {
  const list = candidates(name, typed).filter((h) => h !== typed);
  const taken = new Set(
    (await db.users.find({ username: { $in: list } }, { projection: { username: 1 }, session }).toArray()).map((u) => u.username),
  );
  return list.filter((h) => !taken.has(h)).slice(0, count);
}

export async function isAvailable(db: Database, username: string, self?: ObjectId): Promise<boolean> {
  if (!USERNAME.test(username) || isReserved(username)) return false;
  const owner = await db.users.findOne({ username }, { projection: { _id: 1 } });
  return !owner || Boolean(self && owner._id.equals(self));
}

/** For signup: the most readable free handle, falling back to six random digits. */
export async function firstFreeUsername(db: Database, name: string, session?: ClientSession): Promise<string> {
  const [best] = await suggestUsernames(db, name, { count: 1, session });
  return best ?? `${tidy(words(name)[0] ?? "") || "star"}${randomInt(100000, 1000000)}`.slice(0, 20);
}
