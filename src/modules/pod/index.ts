import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId, type Filter } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { BusinessDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { isModuleLive } from "../../platform/module-switch.js";
import { findPage } from "../../platform/pagination.js";
import { payoutRules } from "../vendor/payouts.js";
import { ShopList, ShopOne, ShopParams, ShopsQuery, TermsOne } from "./contracts.js";
import { ACCEPT_WINDOW_MS, chargesOf, FILES_KEPT_MS, HOLD_MS } from "./orders.js";
import orders from "./order-routes.js";
import problems from "./problem-routes.js";
import reviews from "./review-routes.js";
import { escapeRegex, nearFirst, shopCard, shopSearch, shopView, visibleShops } from "./shops.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** What customers are told a bank can take to show a refund. */
const REFUND_DAYS = 7;

/** Print on demand for customers: shops to order from, and their own orders. Shops are businesses in the pod module. */
const pod: FastifyPluginAsyncTypebox = async (app) => {
  await app.register(orders);
  await app.register(problems);
  await app.register(reviews);
  const db = () => requireDatabase(app.db);

  app.get(
    "/shops",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["pod"],
        summary: "Print shops customers can order from, newest first",
        description:
          "Live shops that are not on hold. In each page, shops in your city (from your profile) come first, then open ones. Empty while Ruxstar has print on demand switched off.",
        querystring: ShopsQuery,
        response: { 200: ShopList, ...Errors },
        security,
      },
    },
    async (request) => {
      if (!(await isModuleLive(db(), "pod"))) return page(request, [], null);
      const { city, product, q, cursor, limit } = request.query;
      const filters: Filter<BusinessDoc>[] = [visibleShops];
      if (city) {
        const name = city.trim();
        filters.push({
          $or: [
            { "pod.serveAll": true },
            { "pod.cities": name.toLowerCase() },
            { "location.city": { $regex: `^${escapeRegex(name)}$`, $options: "i" } },
          ],
        });
      }
      if (product) {
        filters.push({
          "pod.products": product,
          "pod.prices": { $elemMatch: { product, $or: [{ basePrice: { $gt: 0 } }, { bw: { $gt: 0 } }, { color: { $gt: 0 } }] } },
        });
      }
      if (q?.trim()) filters.push(shopSearch(q));
      const [{ items, nextCursor }, me] = await Promise.all([
        findPage(db().businesses, {
          filter: filters.length === 1 ? visibleShops : { $and: filters },
          sortField: "publishedAt",
          cursor,
          limit,
        }),
        db().users.findOne({ _id: request.auth!.userId }, { projection: { home: 1 } }),
      ]);
      return page(request, items.map(shopCard).sort(nearFirst(me?.home?.city)), nextCursor);
    },
  );

  app.get(
    "/shops/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["pod"],
        summary: "One print shop: photos, products and prices",
        params: ShopParams,
        response: { 200: ShopOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const doc = await db().businesses.findOne({ ...visibleShops, _id: new ObjectId(request.params.id) });
      if (!doc || !(await isModuleLive(db(), "pod"))) throw new AppError("NOT_FOUND", "This shop is not on Ruxstar right now.");
      return ok(request, shopView(doc));
    },
  );

  app.get(
    "/terms",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["pod"],
        summary: "Payment conditions for print orders and print shops",
        description: "What customers see before paying and vendors before opening a shop. The commission and fees are Ruxstar's current settings.",
        response: { 200: TermsOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const [charges, payouts] = await Promise.all([chargesOf(db()), payoutRules(db())]);
      return ok(request, {
        commissionBps: charges.commissionBps,
        platformFee: charges.platformFee,
        acceptHours: ACCEPT_WINDOW_MS / HOUR_MS,
        reportHours: HOLD_MS / HOUR_MS,
        filesDays: FILES_KEPT_MS / DAY_MS,
        refundDays: REFUND_DAYS,
        payoutFee: payouts.fee,
        minPayout: payouts.minimum,
      });
    },
  );
};

export default pod;
