import type { FastifyRequest } from "fastify";
import { requireDatabase } from "./context.js";
import type { Database, SwitchableModule } from "./db.js";
import { AppError } from "./errors.js";

/** Other instances pick up a switch within this window. */
const CACHE_MS = 5000;
const cache = new Map<SwitchableModule, { live: boolean; at: number }>();

export function forgetModuleState(module?: SwitchableModule) {
  if (module) cache.delete(module);
  else cache.clear();
}

export async function isModuleLive(db: Database, module: SwitchableModule): Promise<boolean> {
  const hit = cache.get(module);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.live;
  const doc = await db.moduleSettings.findOne({ module }, { projection: { live: 1 } });
  const live = doc?.live === true;
  cache.set(module, { live, at: Date.now() });
  return live;
}

/** Register on every user and vendor route of a business module. Admin routes skip it. */
export function requireModuleLive(module: SwitchableModule) {
  return async function moduleSwitch(request: FastifyRequest): Promise<void> {
    if (!(await isModuleLive(requireDatabase(request.server.db), module))) throw new AppError("MODULE_OFF");
  };
}
