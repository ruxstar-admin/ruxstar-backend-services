import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { AppError } from "../../platform/errors.js";

const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 32;

const derive = (password: string, salt: Buffer, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key))),
  );

/** Stored as `scrypt$N$r$p$salt$hash` so the cost can be raised later without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await derive(password, Buffer.from(salt, "base64url"), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: PARAMS.maxmem,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

let dummyHash: Promise<string> | null = null;

/** Spends the same time as a real check, so a wrong number and a wrong password look alike. */
export async function verifyAgainstNothing(password: string): Promise<void> {
  dummyHash ??= hashPassword("not-a-real-password-1");
  await verifyPassword(password, await dummyHash);
}

/** Length is checked by the contract. This adds the rules a schema cannot say clearly. */
export function checkPasswordRules(password: string, phone: string): void {
  const problems: string[] = [];
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) problems.push("Use at least one letter and one number.");
  if (password.includes(phone.slice(-10))) problems.push("Do not use your phone number in your password.");
  if (problems.length) {
    throw new AppError(
      "VALIDATION_FAILED",
      undefined,
      problems.map((message) => ({ path: "body/password", message })),
    );
  }
}

/** The current hash plus the two before it. */
export async function wasUsedRecently(password: string, current: string | undefined, history: string[] = []) {
  for (const hash of [current, ...history]) {
    if (hash && (await verifyPassword(password, hash))) return true;
  }
  return false;
}
