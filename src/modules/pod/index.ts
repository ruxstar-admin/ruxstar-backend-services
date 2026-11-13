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
import { ShopList, ShopOne, ShopParams, ShopsQuery } from "./contracts.js";
import orders from "./order-routes.js";
import problems from "./problem-routes.js";
import { escapeRegex, openFirst, shopCard, shopView, visibleShops } from "./shops.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

/** Print on demand for customers: shops to order from, and their own orders. Shops are businesses in the pod module. */
const pod: FastifyPluginAsyncTypebox = async (app) => {
  await app.register(orders);
  await app.register(problems);
  const db = () => requireDatabase(app.db);

  app.get(
    "/shops",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["pod"],
        summary: "Print shops customers can order from, newest first",
        description: "Live shops that are not on hold, open ones first in each page. Empty while Ruxstar has print on demand switched off.",
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
      if (product) filters.push({ "pod.products": product });
      if (q) filters.push({ name: { $regex: escapeRegex(q.trim()), $options: "i" } });
      const { items, nextCursor } = await findPage(db().businesses, {
        filter: filters.length === 1 ? visibleShops : { $and: filters },
        sortField: "publishedAt",
        cursor,
        limit,
      });
      return page(request, items.map(shopCard).sort(openFirst), nextCursor);
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
};

export default pod;
