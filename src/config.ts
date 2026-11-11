export type RuxstarEnv = "dev" | "staging" | "prod";

export interface Config {
  env: RuxstarEnv;
  port: number;
  logLevel: string;
  revision: string;
  mongo: { uri: string; db: string } | null;
  jwtSecret: Uint8Array | null;
  corsOrigins: string[];
  cookieDomain: string | undefined;
  minVersions: { app: string | null; delivery: string | null };
  /** `log` prints codes to the terminal and is refused in prod. */
  otp: { provider: "log" | "msg91"; msg91: { authKey: string; templateId: string; senderId?: string } | null };
  /** Texts per India day before the log warns. Sending carries on past it. */
  smsDailyLimit: number;
  /** `log` prints email codes to the terminal and is refused in prod. */
  email: {
    provider: "log" | "smtp";
    smtp: { host: string; port: number; user: string; pass: string; from: string } | null;
  };
  /** Profile photos. Null leaves uploads off; they answer PHOTO_UNAVAILABLE. */
  photos: BucketSettings | null;
  /** Post photos, in their own public bucket. Null leaves post photos off. */
  media: BucketSettings | null;
  /**
   * How long one instance trusts a checked session before reading it again. A logout or role change
   * on another instance can take this long to apply; 0 checks every request.
   */
  authCacheSeconds: number;
}

export interface BucketSettings {
  bucket: string;
  publicBaseUrl: string;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const ENVS: readonly RuxstarEnv[] = ["dev", "staging", "prod"];

type Env = Record<string, string | undefined>;

const read = (env: Env, key: string): string | undefined => {
  const value = env[key]?.trim();
  return value ? value : undefined;
};

/** Messages name the variable, never its value. */
export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  const ruxstarEnv = read(env, "RUXSTAR_ENV") ?? (env.NODE_ENV === "production" ? "prod" : "dev");
  if (!ENVS.includes(ruxstarEnv as RuxstarEnv)) problems.push("RUXSTAR_ENV must be dev, staging or prod");

  const port = Number(read(env, "PORT") ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push("PORT must be a whole number from 1 to 65535");

  const mongoUri = read(env, "MONGODB_URI");
  const mongoDb = read(env, "MONGODB_DB");
  if (mongoUri && !mongoDb) problems.push("MONGODB_DB is required when MONGODB_URI is set");
  if (mongoDb && !mongoUri) problems.push("MONGODB_URI is required when MONGODB_DB is set");
  if (mongoDb && !/^[A-Za-z0-9_-]{1,38}$/.test(mongoDb)) problems.push("MONGODB_DB may only use letters, digits, _ and -");

  const jwt = read(env, "JWT_SECRET");
  if (jwt && jwt.length < 32) problems.push("JWT_SECRET must be at least 32 characters");

  const minApp = read(env, "MIN_APP_VERSION") ?? null;
  const minDelivery = read(env, "MIN_DELIVERY_APP_VERSION") ?? null;
  if (minApp && !SEMVER.test(minApp)) problems.push("MIN_APP_VERSION must look like 1.2.3");
  if (minDelivery && !SEMVER.test(minDelivery)) problems.push("MIN_DELIVERY_APP_VERSION must look like 1.2.3");

  const corsOrigins = (read(env, "CORS_ORIGINS") ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of corsOrigins) {
    if (!/^https?:\/\/[^/\s]+$/.test(origin)) problems.push("CORS_ORIGINS must be origins like https://ruxstar.com, comma separated");
  }

  const otpProvider = read(env, "OTP_PROVIDER") ?? (ruxstarEnv === "prod" ? "msg91" : "log");
  if (otpProvider !== "log" && otpProvider !== "msg91") problems.push("OTP_PROVIDER must be log or msg91");
  if (otpProvider === "log" && ruxstarEnv === "prod") problems.push("OTP_PROVIDER=log is not allowed in prod");
  const msg91Key = read(env, "MSG91_AUTH_KEY");
  const msg91Template = read(env, "MSG91_TEMPLATE_ID");
  const msg91Sender = read(env, "MSG91_SENDER_ID");

  const smsDailyLimit = Number(read(env, "SMS_DAILY_LIMIT") ?? 5000);
  if (!Number.isInteger(smsDailyLimit) || smsDailyLimit < 1) problems.push("SMS_DAILY_LIMIT must be a whole number above 0");

  const emailProvider = read(env, "EMAIL_PROVIDER") ?? (ruxstarEnv === "prod" ? "smtp" : "log");
  if (emailProvider !== "log" && emailProvider !== "smtp") problems.push("EMAIL_PROVIDER must be log or smtp");
  if (emailProvider === "log" && ruxstarEnv === "prod") problems.push("EMAIL_PROVIDER=log is not allowed in prod");
  const smtpHost = read(env, "SMTP_HOST");
  const smtpPort = Number(read(env, "SMTP_PORT") ?? 587);
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) problems.push("SMTP_PORT must be a whole number from 1 to 65535");
  const smtpUser = read(env, "SMTP_USER");
  const smtpPass = read(env, "SMTP_PASS");
  const emailFrom = read(env, "EMAIL_FROM") ?? smtpUser;

  const bucketOf = (nameKey: string, urlKey: string, example: string): BucketSettings | null => {
    const bucket = read(env, nameKey);
    if (bucket && !/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucket)) problems.push(`${nameKey} must be a bucket name like ${example}`);
    const publicBaseUrl = read(env, urlKey)?.replace(/\/+$/, "");
    if (publicBaseUrl && !/^https:\/\/[^\s]+$/.test(publicBaseUrl)) problems.push(`${urlKey} must start with https://`);
    return bucket ? { bucket, publicBaseUrl: publicBaseUrl ?? `https://storage.googleapis.com/${bucket}` } : null;
  };
  const photos = bucketOf("GCS_BUCKET", "GCS_PUBLIC_BASE_URL", "ruxstar-profile-pictures");
  const media = bucketOf("GCS_MEDIA_BUCKET", "GCS_MEDIA_PUBLIC_BASE_URL", "ruxstar-post-media");

  const authCacheSeconds = Number(read(env, "AUTH_CACHE_SECONDS") ?? 30);
  if (!Number.isInteger(authCacheSeconds) || authCacheSeconds < 0 || authCacheSeconds > 300) {
    problems.push("AUTH_CACHE_SECONDS must be a whole number from 0 to 300");
  }

  if (problems.length) throw new ConfigError(problems);

  return {
    env: ruxstarEnv as RuxstarEnv,
    port,
    logLevel: read(env, "LOG_LEVEL") ?? "info",
    revision: read(env, "K_REVISION") ?? "local",
    mongo: mongoUri && mongoDb ? { uri: mongoUri, db: mongoDb } : null,
    jwtSecret: jwt ? new TextEncoder().encode(jwt) : null,
    corsOrigins,
    cookieDomain: read(env, "COOKIE_DOMAIN"),
    minVersions: { app: minApp, delivery: minDelivery },
    otp: {
      provider: otpProvider as "log" | "msg91",
      msg91:
        msg91Key && msg91Template
          ? { authKey: msg91Key, templateId: msg91Template, ...(msg91Sender ? { senderId: msg91Sender } : {}) }
          : null,
    },
    smsDailyLimit,
    email: {
      provider: emailProvider as "log" | "smtp",
      smtp:
        smtpHost && smtpUser && smtpPass && emailFrom
          ? { host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass, from: emailFrom }
          : null,
    },
    photos,
    media,
    authCacheSeconds,
  };
}
