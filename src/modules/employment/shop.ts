import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { ObjectId } from "mongodb";
import { Errors } from "../../contracts/common.js";
import { actorOf } from "../../platform/audit.js";
import { requireAuth } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { BusinessDoc, TeamPermission } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { isModuleLive } from "../../platform/module-switch.js";
import { findPage } from "../../platform/pagination.js";
import { CouponList, CouponOne, TeamCouponParams, TeamCreateCouponBody, TeamUpdateCouponBody, VendorCouponsQuery } from "../coupons/contracts.js";
import { couponViews, createCoupon, updateCoupon } from "../coupons/coupons.js";
import { POST_PHOTO_MAX_BYTES } from "../social/photos.js";
import { WorkParams } from "../team/contracts.js";
import { teamAccess } from "../team/team.js";
import { businessView } from "../vendor/businesses.js";
import { BusinessOne, MAX_BUSINESS_PHOTOS, PhotoParams, PodSetupBody, TeamUpdateBusinessBody } from "../vendor/contracts.js";
import { addPhoto, editDetails, editPod, removePhoto, setOpen } from "../vendor/shop-edits.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const limit = (perMinutes: number, max: number) => ({ rateLimit: { max, timeWindow: perMinutes * 60_000 } });
const SHOP: TeamPermission[] = ["shop.open", "shop.catalog", "shop.details"];

/** The shop someone works at: opening it, its catalog, details and photos, and its coupons, each behind its own permission. */
const shop: FastifyPluginAsyncTypebox = async (app) => {
  app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: POST_PHOTO_MAX_BYTES }, (_request, body, done) => done(null, body));
  const db = () => requireDatabase(app.db);
  const by = (request: FastifyRequest) => ({ actor: actorOf(request), ip: request.ip });
  const at = (request: FastifyRequest, placeId: string, permission: TeamPermission | TeamPermission[]) =>
    teamAccess(db(), request.auth!, { placeId }, permission);
  const answer = async (id: ObjectId) => {
    const doc = (await db().businesses.findOne({ _id: id }))!;
    return businessView(doc, await isModuleLive(db(), doc.module));
  };

  app.get(
    "/:id/shop",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["employment"],
        summary: "The shop you work at, to change what you're allowed to",
        description: "Needs one of the shop permissions: open and close, catalog, or details and photos.",
        params: WorkParams,
        response: { 200: BusinessOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { business } = await at(request, request.params.id, SHOP);
      return ok(request, await answer(business._id));
    },
  );

  app.patch(
    "/:id/shop",
    {
      preHandler: requireAuth,
      config: limit(60, 60),
      schema: {
        tags: ["employment"],
        summary: "Change the shop's name, phone, address or description",
        description: 'Needs "Edit details and photos". Send only what changes. The GSTIN stays with the owner.',
        params: WorkParams,
        body: TeamUpdateBusinessBody,
        response: { 200: BusinessOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { business } = await at(request, request.params.id, "shop.details");
      await editDetails(app, db(), business, request.body, by(request));
      return ok(request, await answer(business._id));
    },
  );

  app.patch(
    "/:id/shop/pod",
    {
      preHandler: requireAuth,
      config: limit(60, 60),
      schema: {
        tags: ["employment"],
        summary: "Change the shop's products, delivery area and prices",
        description: 'Needs "Change products, prices and delivery area". The same rules as the owner\'s setup.',
        params: WorkParams,
        body: PodSetupBody,
        response: { 200: BusinessOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { business } = await at(request, request.params.id, "shop.catalog");
      await editPod(db(), business, request.body, by(request));
      return ok(request, await answer(business._id));
    },
  );

  app.post(
    "/:id/shop/photos",
    {
      preHandler: requireAuth,
      config: limit(60, 30),
      schema: {
        tags: ["employment"],
        summary: `Add a photo to the shop, up to ${MAX_BUSINESS_PHOTOS}`,
        description: 'Needs "Edit details and photos". Send the image itself, as for the owner.',
        consumes: ["image/jpeg", "image/png", "image/webp"],
        params: WorkParams,
        response: { 201: BusinessOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const { business } = await at(request, request.params.id, "shop.details");
      await addPhoto(app, db(), business, request.body, by(request));
      return reply.status(201).send(ok(request, await answer(business._id)));
    },
  );

  app.delete(
    "/:id/shop/photos/:photoId",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["employment"],
        summary: "Remove a photo from the shop",
        description: 'Needs "Edit details and photos". A live shop keeps at least one photo.',
        params: PhotoParams,
        response: { 200: BusinessOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { business } = await at(request, request.params.id, "shop.details");
      await removePhoto(app, db(), business, request.params.photoId, by(request));
      return ok(request, await answer(business._id));
    },
  );

  for (const open of [true, false]) {
    app.post(
      `/:id/shop/${open ? "open" : "close"}`,
      {
        preHandler: requireAuth,
        schema: {
          tags: ["employment"],
          summary: open ? "Open the shop for orders" : "Close the shop for now",
          description: 'Needs "Open and close the shop". Only a live shop opens or closes.',
          params: WorkParams,
          response: { 200: BusinessOne, ...Errors },
          security,
        },
      },
      async (request) => {
        const { business } = await at(request, request.params.id, "shop.open");
        await setOpen(db(), business, open, () => isModuleLive(db(), business.module), by(request));
        return ok(request, await answer(business._id));
      },
    );
  }

  /** The owner's coupons that work only at this shop are the team's to change. */
  const onlyHere = (business: BusinessDoc & { _id: ObjectId }) => ({ vendorId: business.ownerId, businessIds: [business._id] });

  app.get(
    "/:id/coupons",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["employment"],
        summary: "The shop's coupons, newest first",
        description: 'Needs "Make and change coupons". Coupons the owner made for several shops are listed too, but only the owner changes them.',
        params: WorkParams,
        querystring: VendorCouponsQuery,
        response: { 200: CouponList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { business } = await at(request, request.params.id, "coupons.manage");
      const { items, nextCursor } = await findPage(db().coupons, {
        filter: { vendorId: business.ownerId, businessIds: business._id },
        sortField: "createdAt",
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      return page(request, await couponViews(db(), items), nextCursor);
    },
  );

  app.post(
    "/:id/coupons",
    {
      preHandler: [requireAuth, idempotent],
      config: limit(60, 30),
      schema: {
        tags: ["employment"],
        summary: "Make a coupon for the shop",
        description: 'Needs "Make and change coupons". It works at this shop only, and the discount comes out of the shop\'s share.',
        params: WorkParams,
        body: TeamCreateCouponBody,
        response: { 201: CouponOne, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const { business } = await at(request, request.params.id, "coupons.manage");
      const doc = await createCoupon(db(), {
        body: request.body,
        fundedBy: "vendor",
        ...onlyHere(business),
        actor: actorOf(request),
        ip: request.ip,
        shopId: business._id,
      });
      return reply.status(201).send(ok(request, (await couponViews(db(), [doc]))[0]!));
    },
  );

  app.patch(
    "/:id/coupons/:couponId",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["employment"],
        summary: "Change one of the shop's coupons, or switch it off or on",
        description: 'Needs "Make and change coupons". Only coupons that work at this shop alone.',
        params: TeamCouponParams,
        body: TeamUpdateCouponBody,
        response: { 200: CouponOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const { business } = await at(request, request.params.id, "coupons.manage");
      const coupon = await db().coupons.findOne({ _id: new ObjectId(request.params.couponId), vendorId: business.ownerId, businessIds: business._id });
      if (!coupon) throw new AppError("NOT_FOUND", "Coupon not found.");
      if (coupon.businessIds.length > 1) throw new AppError("FORBIDDEN", "This coupon works at the owner's other shops too, so only the owner can change it.");
      const done = await updateCoupon(db(), coupon, { body: request.body, by: "vendor", actor: actorOf(request), ip: request.ip, shopId: business._id });
      return ok(request, (await couponViews(db(), [done]))[0]!);
    },
  );
};

export default shop;
