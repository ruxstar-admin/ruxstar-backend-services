import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import account from "./account/index.js";
import delivery from "./delivery/index.js";
import employment from "./employment/index.js";
import kyc from "./kyc/index.js";
import notifications from "./notifications/index.js";
import pod from "./pod/index.js";
import ruxstar from "./ruxstar/index.js";
import social from "./social/index.js";
import vendor from "./vendor/index.js";

/** The 14 resources, each mounted at `/v1/<name>`. A module is added here once it has routes. */
export const RESOURCES = [
  "account",
  "kyc",
  "social",
  "notifications",
  "vendor",
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
  kyc,
  social,
  notifications,
  vendor,
  pod,
  employment,
  delivery,
  ruxstar,
};

export async function registerModules(app: FastifyInstance) {
  for (const resource of RESOURCES) {
    const plugin = MODULES[resource];
    if (plugin) await app.register(plugin, { prefix: `/v1/${resource}` });
  }
}
