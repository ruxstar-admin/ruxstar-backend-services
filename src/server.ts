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

/** Keeps trying with backoff. A failed first connect must not leave the instance unready forever. */
async function setUpDatabase(database: NonNullable<typeof db>) {
  for (let attempt = 1; ; attempt++) {
    try {
      await database.client.connect();
      await Promise.all([ensurePlatformIndexes(database), seedModuleSettings(database)]);
      app.log.info({ db: config.mongo!.db, attempt }, "Database ready");
      return;
    } catch (err) {
      const wait = Math.min(30, 2 ** attempt);
      const { name, message } = err as Error;
      app.log.error({ attempt, error: name }, `Database setup failed: ${message}. Retrying in ${wait}s`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000).unref());
    }
  }
}

// Start serving straight away; /ready reports the database until it answers.
if (db) void setUpDatabase(db);

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
