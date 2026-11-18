import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId, type Filter } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireDatabase } from "../../platform/context.js";
import type { CouponDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { CouponList, CouponOne, CouponParams, VendorCouponsQuery, VendorCreateCouponBody, VendorUpdateCouponBody } from "../coupons/contracts.js";
import { couponViews, createCoupon, updateCoupon, vendorShops } from "../coupons/coupons.js";
import { requireEarner } from "./businesses.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

/** Freelancers who aren't vendors: only coupons on their freelancer profiles, never on anything else. */
const freelanceOnly = (request: FastifyRequest) => !request.auth!.roles.vendor;
const GIGS_ONLY: Filter<CouponDoc> = { modules: { $not: { $elemMatch: { $ne: "gigs" } } } };

/** A vendor's own coupons for their businesses, or a freelancer's for their gigs. The discount comes out of their share. */
const coupons: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const mine = (request: FastifyRequest): Filter<CouponDoc> => ({ vendorId: request.auth!.userId, ...(freelanceOnly(request) ? GIGS_ONLY : {}) });

  app.get(
    "/coupons",
    {
      preHandler: requireEarner,
      schema: { tags: ["vendor"], summary: "Your coupons, newest first", querystring: VendorCouponsQuery, response: { 200: CouponList, ...Errors }, security },
    },
    async (request) => {
      const { items, nextCursor } = await findPage(db().coupons, {
        filter: mine(request),
        sortField: "createdAt",
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      return page(request, await couponViews(db(), items), nextCursor);
    },
  );

  app.post(
    "/coupons",
    {
      preHandler: [requireEarner, idempotent],
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Make a coupon for your businesses",
        description:
          "You pay for the discount: it comes out of your share, and commission is charged on the price after it. " +
          "The code and the discount can't change afterwards. Each customer can use it once unless `perCustomer` says otherwise. " +
          "Freelancers who aren't vendors can make them only for their freelancer profile.",
        body: VendorCreateCouponBody,
        response: { 201: CouponOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const vendorId = request.auth!.userId;
      const businessIds = await vendorShops(db(), vendorId, request.body.businessIds, freelanceOnly(request));
      const doc = await createCoupon(db(), { body: request.body, fundedBy: "vendor", vendorId, businessIds, actor: actorOf(request), ip: request.ip });
      return reply.status(201).send(ok(request, (await couponViews(db(), [doc]))[0]!));
    },
  );

  app.patch(
    "/coupons/:id",
    {
      preHandler: requireEarner,
      schema: {
        tags: ["vendor"],
        summary: "Change your coupon's businesses, dates and limits, or switch it off or on",
        description: "Send only what changes. A coupon Ruxstar switched off stays off until Ruxstar switches it back on.",
        params: CouponParams,
        body: VendorUpdateCouponBody,
        response: { 200: CouponOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const vendorId = request.auth!.userId;
      const coupon = await db().coupons.findOne({ _id: new ObjectId(request.params.id), ...mine(request) });
      if (!coupon) throw new AppError("NOT_FOUND", "Coupon not found.");
      const businessIds = request.body.businessIds ? await vendorShops(db(), vendorId, request.body.businessIds, freelanceOnly(request)) : undefined;
      const done = await updateCoupon(db(), coupon, { body: request.body, ...(businessIds ? { businessIds } : {}), by: "vendor", actor: actorOf(request), ip: request.ip });
      return ok(request, (await couponViews(db(), [done]))[0]!);
    },
  );
};

export default coupons;
