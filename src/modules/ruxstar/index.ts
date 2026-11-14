import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Errors } from "../../contracts/common.js";
import { actorOf, diffOf, writeAudit } from "../../platform/audit.js";
import { requireRuxstar } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import type { ModuleSettingsDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { forgetModuleState } from "../../platform/module-switch.js";
import { BUSINESS_MODULES, DEFAULT_OFFER_MINUTES, DEFAULT_RIDER_RATE, DEFAULT_SHOP_FEE_MAX } from "../delivery/rates.js";
import { DEFAULT_MIN_PAYOUT, DEFAULT_PAYOUT_FEE } from "../vendor/payouts.js";
import { ModuleParams, ModuleSettingsList, ModuleSettingsOne, ModuleSettingsPatch, type ModuleSettings } from "./contracts.js";
import auditLog from "./audit-log.js";
import businesses from "./businesses.js";
import consoleHome from "./console.js";
import coupons from "./coupons.js";
import kycReview from "./kyc.js";
import orderProblems from "./order-problems.js";
import payouts from "./payouts.js";
import peopleReports from "./people-reports.js";
import reports from "./reports.js";
import reviewReports from "./review-reports.js";
import staff from "./staff.js";
import supportDesk from "./support-desk.js";
import teams from "./teams.js";
import users from "./users.js";

const ORDER = ["pod", "events", "coaching", "stays", "delivery", "ledger"];
/** Vendors' withdrawals are set on the ledger module, delivery partners' on the delivery module. */
const PAYOUT_MODULES: string[] = ["ledger", "delivery"];

const view = (doc: ModuleSettingsDoc): ModuleSettings => ({
  module: doc.module,
  live: doc.live,
  signupsOpen: doc.signupsOpen,
  commissionBps: doc.commissionBps,
  platformFee: doc.platformFee ?? 0,
  payouts: PAYOUT_MODULES.includes(doc.module) ? { fee: doc.payoutFee ?? DEFAULT_PAYOUT_FEE, minimum: doc.minPayout ?? DEFAULT_MIN_PAYOUT } : null,
  deliveryEnabled: doc.deliveryEnabled,
  gstinRequired: BUSINESS_MODULES.includes(doc.module) ? Boolean(doc.gstinRequired) : null,
  delivery:
    doc.module === "delivery"
      ? {
          riderRate: doc.riderRate ?? DEFAULT_RIDER_RATE,
          shopFeeMax: doc.shopFeeMax ?? DEFAULT_SHOP_FEE_MAX,
          offerMinutes: doc.offerMinutes ?? DEFAULT_OFFER_MINUTES,
        }
      : null,
  permissionCatalog: doc.permissionCatalog,
  updatedAt: doc.updatedAt.toISOString(),
});

const ruxstar: FastifyPluginAsyncTypebox = async (app) => {
  await app.register(consoleHome);
  await app.register(kycReview);
  await app.register(reports);
  await app.register(peopleReports);
  await app.register(reviewReports);
  await app.register(orderProblems);
  await app.register(payouts);
  await app.register(coupons);
  await app.register(users);
  await app.register(staff);
  await app.register(businesses);
  await app.register(teams);
  await app.register(supportDesk);
  await app.register(auditLog);

  app.get(
    "/modules",
    {
      preHandler: requireRuxstar("modules.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "Every business module and its switches",
        response: { 200: ModuleSettingsList, ...Errors },
      },
    },
    async (request) => {
      const docs = await requireDatabase(app.db).moduleSettings.find({}).toArray();
      docs.sort((a, b) => ORDER.indexOf(a.module) - ORDER.indexOf(b.module));
      return page(request, docs.map(view), null);
    },
  );

  app.patch(
    "/modules/:module",
    {
      preHandler: [requireRuxstar("modules.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary:
          "Switch a module on or off, or change its signups, commission, platform fee or delivery; the payout fee and minimum on the ledger (vendors) and delivery (partners)",
        params: ModuleParams,
        body: ModuleSettingsPatch,
        response: { 200: ModuleSettingsOne, ...Errors },
      },
    },
    async (request) => {
      const db = requireDatabase(app.db);
      const { module } = request.params;
      const changes = request.body;
      const actor = actorOf(request);

      let changed: string[] = [];
      const updated = await db.transaction(async (session) => {
        const before = await db.moduleSettings.findOne({ module }, { session });
        if (!before) throw new AppError("NOT_FOUND", "Module not found.");
        const payoutsChanged = changes.payoutFee !== undefined || changes.minPayout !== undefined;
        if (payoutsChanged && !PAYOUT_MODULES.includes(module)) {
          throw new AppError("VALIDATION_FAILED", "The payout fee and minimum are set on the ledger module, or the delivery module for partners.", [
            { path: "body/payoutFee", message: "Ledger or delivery only" },
          ]);
        }
        if (changes.gstinRequired !== undefined && !BUSINESS_MODULES.includes(module)) {
          throw new AppError("VALIDATION_FAILED", "GSTIN is set on business modules.", [{ path: "body/gstinRequired", message: "Business modules only" }]);
        }
        const deliveryField = (["riderRate", "shopFeeMax", "offerMinutes"] as const).find((k) => changes[k] !== undefined);
        if (deliveryField && module !== "delivery") {
          throw new AppError("VALIDATION_FAILED", "Delivery rates are set on the delivery module.", [
            { path: `body/${deliveryField}`, message: "Delivery only" },
          ]);
        }
        const fee = changes.payoutFee ?? before.payoutFee ?? DEFAULT_PAYOUT_FEE;
        const minimum = changes.minPayout ?? before.minPayout ?? DEFAULT_MIN_PAYOUT;
        if (payoutsChanged && minimum < fee + 100) {
          throw new AppError("VALIDATION_FAILED", "The minimum withdrawal must be at least ₹1 more than the payout fee.", [
            { path: "body/minPayout", message: "At least ₹1 more than the fee" },
          ]);
        }
        const diff = diffOf(before, changes);
        changed = Object.keys(diff);
        if (!changed.length) return before;

        const after = await db.moduleSettings.findOneAndUpdate(
          { _id: before._id },
          { $set: { ...changes, updatedBy: actor.id, updatedAt: new Date() } },
          { session, returnDocument: "after" },
        );
        await writeAudit(
          db,
          { actor, scope: { module }, action: "module_settings.update", target: { type: "module_settings", id: before._id }, diff, ip: request.ip },
          session,
        );
        return after!;
      });

      if (changed.length) {
        forgetModuleState(module);
        app.events.emit("module.settings.changed", { module, changes: changed, by: actor.id?.toHexString() ?? "system" });
      }
      return ok(request, view(updated));
    },
  );
};

export default ruxstar;
