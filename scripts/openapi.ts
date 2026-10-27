import { mkdir, writeFile } from "node:fs/promises";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const app = await buildApp({ config: loadConfig({ RUXSTAR_ENV: "dev" }), db: null, logger: false });
await app.ready();

const out = new URL("../openapi/openapi.json", import.meta.url);
await mkdir(new URL(".", out), { recursive: true });
await writeFile(out, `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();

console.log("Wrote openapi/openapi.json");
