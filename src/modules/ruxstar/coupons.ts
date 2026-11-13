import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireRuxstar } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { CouponList, CouponOne, CouponParams, StaffCouponsQuery, StaffCreateCouponBody, StaffUpdateCouponBody } from "../coupons/contracts.js";
import { couponViews, createCoupon, normalCode, updateCoupon } from "../coupons/coupons.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];

/** Ruxstar's own coupons, which Ruxstar pays for, and a look at vendors' coupons. */
const coupons: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const one = async (id: string) => {
    const doc = await db().coupons.findOne({ _id: new ObjectId(id) });
    if (!doc) throw new AppError("NOT_FOUND", "Coupon not found.");
    return doc;
  };
  const view = async (doc: Parameters<typeof couponViews>[1][number]) => (await couponViews(db(), [doc]))[0]!;

  app.get(
    "/coupons",
    {
      preHandler: requireRuxstar("coupons.view"),
      schema: { tags: ["ruxstar"], summary: "Coupons, newest first", querystring: StaffCouponsQuery, response: { 200: CouponList, ...Errors }, security },
    },
    async (request) => {
      const { funder = "ruxstar", code, cursor, limit } = request.query;
      const { items, nextCursor } = await findPage(db().coupons, {
        filter: code ? { code: normalCode(code) } : { fundedBy: funder },
        sortField: "createdAt",
        cursor,
        limit,
      });
      return page(request, await couponViews(db(), items), nextCursor);
    },
  );

  app.post(
    "/coupons",
    {
      preHandler: [requireRuxstar("coupons.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Make a Ruxstar coupon",
        description:
          "It works at every print shop and Ruxstar pays for the discount: the shop's share stays as if there were no coupon. " +
          "The code and the discount can't change afterwards. Each customer can use it once unless `perCustomer` says otherwise.",
        body: StaffCreateCouponBody,
        response: { 201: CouponOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const doc = await createCoupon(db(), { body: request.body, fundedBy: "ruxstar", vendorId: null, businessIds: [], actor: actorOf(request), ip: request.ip });
      return reply.status(201).send(ok(request, await view(doc)));
    },
  );

  app.patch(
    "/coupons/:id",
    {
      preHandler: requireRuxstar("coupons.manage"),
      schema: {
        tags: ["ruxstar"],
        summary: "Change a coupon's dates and limits, or switch it off or on",
        description: "On a vendor's coupon only `active` can change, to stop one being misused. Send only what changes.",
        params: CouponParams,
        body: StaffUpdateCouponBody,
        response: { 200: CouponOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const coupon = await one(request.params.id);
      const { active, ...rest } = request.body;
      if (coupon.fundedBy === "vendor" && Object.values(rest).some((v) => v !== undefined)) {
        throw new AppError("FORBIDDEN", "Only the vendor can change their coupon. You can switch it off.");
      }
      const done = await updateCoupon(db(), coupon, { body: request.body, by: "staff", actor: actorOf(request), ip: request.ip });
      return ok(request, await view(done));
    },
  );
};

export default coupons;
