import type { FastifyPluginAsync } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "../config.js";
import { requireDatabase } from "../platform/context.js";
import { AppError } from "../platform/errors.js";
import { sweepCoaching } from "./coaching/orders.js";
import { sweepRiderPay } from "./delivery/pay.js";
import { sweepOffers } from "./delivery/trips.js";
import { sweepEvents } from "./events/orders.js";
import { sweepGigs } from "./gigs/orders.js";
import { sweepOrders } from "./pod/order-rules.js";
import { sweepShop } from "./shop/orders.js";
import { sweepStays } from "./stays/orders.js";
import { sweepTurf } from "./turf/orders.js";
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
      const riderPay = await sweepRiderPay(db);
      const events = await sweepEvents(app, db);
      const coaching = await sweepCoaching(app, db);
      const turf = await sweepTurf(app, db);
      const stays = await sweepStays(app, db);
      const shop = await sweepShop(app, db);
      const gigs = await sweepGigs(app, db);
      const payouts = await sweepPayouts(app, db);
      request.log.info(
        { job: "orders", ...counts, ...events, ...coaching, ...turf, ...stays, ...shop, ...gigs, riderPay, payouts, offers },
        "Order, ticket, class, slot, stay, shop and freelance timers, delivery offers, partners' pay and payouts swept",
      );
      return { ok: true, ...counts, ...events, ...coaching, ...turf, ...stays, ...shop, ...gigs, riderPay, payouts, offers };
    });
  };
}
