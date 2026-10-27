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
  };
}
