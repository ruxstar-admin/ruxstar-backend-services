import { buildApp } from "./app.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { createDatabase } from "./platform/db.js";
import { ensurePlatformIndexes, seedModuleSettings } from "./platform/indexes.js";

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const db = config.mongo ? createDatabase(config.mongo.uri, config.mongo.db) : null;
const app = await buildApp({ config, db });

if (!db) app.log.warn("MONGODB_URI and MONGODB_DB are not set. Only /health works until they are.");
if (!config.jwtSecret) app.log.warn("JWT_SECRET is not set. Every signed-in route will return 401.");

/** Connects and builds the indexes once. A failed client is swapped for a new one before the next try. */
async function setUpDatabase(database: NonNullable<typeof db>, attempt: number): Promise<boolean> {
  try {
    await database.client.connect();
    // The unique index on module must exist before seeding, or two instances starting together can insert twins.
    await ensurePlatformIndexes(database);
    await seedModuleSettings(database);
    database.ready = true;
    app.log.info({ db: config.mongo!.db, attempt }, "Database ready");
    return true;
  } catch (err) {
    const { name, message } = err as Error;
    app.log.error({ attempt, error: name }, `Database setup failed: ${message}. Retrying with a new connection`);
    database.renew();
    return false;
  }
}

/** Keeps trying with backoff. A failed first connect must not leave the instance unready forever. */
async function keepSettingUp(database: NonNullable<typeof db>) {
  for (let attempt = 2; ; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(30, 2 ** (attempt - 1)) * 1000).unref());
    if (await setUpDatabase(database, attempt)) return;
  }
}

// Cloud Run gives the container full CPU only until the port opens, then throttles it between requests,
// which starves a background TLS handshake. So the first try runs before listening; later ones run behind /ready.
if (db && !(await setUpDatabase(db, 1))) void keepSettingUp(db);

await app.listen({ port: config.port, host: "0.0.0.0" });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "Shutting down");
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
