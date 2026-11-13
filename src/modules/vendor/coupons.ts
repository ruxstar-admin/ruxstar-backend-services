import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireDatabase } from "../../platform/context.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { CouponList, CouponOne, CouponParams, VendorCouponsQuery, VendorCreateCouponBody, VendorUpdateCouponBody } from "../coupons/contracts.js";
import { couponViews, createCoupon, updateCoupon, vendorShops } from "../coupons/coupons.js";
import { requireVendor } from "./businesses.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

/** A vendor's own coupons for their print shops. The discount comes out of the vendor's share. */
const coupons: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);

  app.get(
    "/coupons",
    {
      preHandler: requireVendor,
      schema: { tags: ["vendor"], summary: "Your coupons, newest first", querystring: VendorCouponsQuery, response: { 200: CouponList, ...Errors }, security },
    },
    async (request) => {
      const { items, nextCursor } = await findPage(db().coupons, {
        filter: { vendorId: request.auth!.userId },
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
      preHandler: [requireVendor, idempotent],
      config: { rateLimit: { max: 30, timeWindow: 60 * 60_000 } },
      schema: {
        tags: ["vendor"],
        summary: "Make a coupon for your print shops",
        description:
          "You pay for the discount: it comes out of your share, and commission is charged on the price after it. " +
          "The code and the discount can't change afterwards. Each customer can use it once unless `perCustomer` says otherwise.",
        body: VendorCreateCouponBody,
        response: { 201: CouponOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const vendorId = request.auth!.userId;
      const businessIds = await vendorShops(db(), vendorId, request.body.businessIds);
      const doc = await createCoupon(db(), { body: request.body, fundedBy: "vendor", vendorId, businessIds, actor: actorOf(request), ip: request.ip });
      return reply.status(201).send(ok(request, (await couponViews(db(), [doc]))[0]!));
    },
  );

  app.patch(
    "/coupons/:id",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Change your coupon's shops, dates and limits, or switch it off or on",
        description: "Send only what changes. A coupon Ruxstar switched off stays off until Ruxstar switches it back on.",
        params: CouponParams,
        body: VendorUpdateCouponBody,
        response: { 200: CouponOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const vendorId = request.auth!.userId;
      const coupon = await db().coupons.findOne({ _id: new ObjectId(request.params.id), vendorId });
      if (!coupon) throw new AppError("NOT_FOUND", "Coupon not found.");
      const businessIds = request.body.businessIds ? await vendorShops(db(), vendorId, request.body.businessIds) : undefined;
      const done = await updateCoupon(db(), coupon, { body: request.body, ...(businessIds ? { businessIds } : {}), by: "vendor", actor: actorOf(request), ip: request.ip });
      return ok(request, (await couponViews(db(), [done]))[0]!);
    },
  );
};

export default coupons;
