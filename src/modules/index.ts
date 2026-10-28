import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import account from "./account/index.js";
import ruxstar from "./ruxstar/index.js";

/** The 13 resources, each mounted at `/v1/<name>`. A module is added here once it has routes. */
export const RESOURCES = [
  "account",
  "kyc",
  "social",
  "notifications",
  "pod",
  "events",
  "coaching",
  "stays",
  "employment",
  "delivery",
  "ledger",
  "support",
  "ruxstar",
] as const;

export type Resource = (typeof RESOURCES)[number];

const MODULES: Partial<Record<Resource, FastifyPluginAsync>> = {
  account,
  ruxstar,
};

export async function registerModules(app: FastifyInstance) {
  for (const resource of RESOURCES) {
    const plugin = MODULES[resource];
    if (plugin) await app.register(plugin, { prefix: `/v1/${resource}` });
  }
}
