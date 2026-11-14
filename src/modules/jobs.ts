import type { FastifyPluginAsync } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "../config.js";
import { requireDatabase } from "../platform/context.js";
import { AppError } from "../platform/errors.js";
import { sweepOffers } from "./delivery/trips.js";
import { sweepOrders } from "./pod/order-rules.js";
import { sweepPayouts } from "./vendor/payouts.js";

/** Whether a bearer token is the scheduler's. */
export type JobAuth = (token: string) => Promise<boolean>;

const GOOGLE_KEYS = "https://www.googleapis.com/oauth2/v3/certs";

/** Cloud Scheduler signs each call with a Google ID token for its service account. */
export function googleJobAuth(config: Config): JobAuth | null {
  if (!config.jobs) return null;
  const { invoker, audience } = config.jobs;
  const keys = createRemoteJWKSet(new URL(GOOGLE_KEYS));
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, keys, { issuer: ["https://accounts.google.com", "accounts.google.com"], audience });
      return payload.email === invoker && payload.email_verified === true;
    } catch {
      return false;
    }
  };
}

/**
 * Timed work, called by Cloud Scheduler. Outside /v1: no app calls it, so there is no X-Client header.
 * Each run is safe to repeat, and safe alongside the reads that catch orders up on their own.
 */
export function jobs(auth: JobAuth | null): FastifyPluginAsync {
  return async (app) => {
    app.post("/jobs/orders", { schema: { hide: true }, config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, async (request) => {
      if (!auth) throw new AppError("NOT_FOUND");
      const header = request.headers.authorization;
      const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
      if (!token || !(await auth(token))) throw new AppError("UNAUTHENTICATED");
      const db = requireDatabase(app.db);
      const offers = await sweepOffers(app, db);
      const counts = await sweepOrders(app, db);
      const payouts = await sweepPayouts(app, db);
      request.log.info({ job: "orders", ...counts, payouts, offers }, "Order timers, delivery offers and payouts swept");
      return { ok: true, ...counts, payouts, offers };
    });
  };
}
