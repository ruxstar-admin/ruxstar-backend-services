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
import { DEFAULT_EVENT_RULES } from "../events/rules.js";
import { DEFAULT_COACHING_RULES } from "../coaching/rules.js";
import { DEFAULT_TURF_RULES, turfRulesProblem, turfRulesView } from "../turf/rules.js";
import { DEFAULT_STAYS_RULES, staysRulesProblem } from "../stays/rules.js";
import { DEFAULT_SHOP_RULES } from "../shop/rules.js";
import { consoleInvoices } from "../invoices/routes.js";
import { ModuleParams, ModuleSettingsList, ModuleSettingsOne, ModuleSettingsPatch, type ModuleSettings } from "./contracts.js";
import auditLog from "./audit-log.js";
import businesses from "./businesses.js";
import consoleHome from "./console.js";
import coaching from "./coaching.js";
import coupons from "./coupons.js";
import events from "./events.js";
import kycReview from "./kyc.js";
import orderProblems from "./order-problems.js";
import payouts from "./payouts.js";
import peopleReports from "./people-reports.js";
import reports from "./reports.js";
import reviewReports from "./review-reports.js";
import staff from "./staff.js";
import supportDesk from "./support-desk.js";
import teams from "./teams.js";
import turf from "./turf.js";
import stays from "./stays.js";
import shop from "./shop.js";
import users from "./users.js";

const ORDER = ["pod", "events", "coaching", "stays", "turf", "shop", "delivery", "ledger"];
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
  eventRules: doc.module === "events" ? { ...DEFAULT_EVENT_RULES, ...doc.eventRules } : null,
  coachingRules: doc.module === "coaching" ? { ...DEFAULT_COACHING_RULES, ...doc.coachingRules } : null,
  turfRules: doc.module === "turf" ? turfRulesView({ ...DEFAULT_TURF_RULES, ...doc.turfRules }) : null,
  staysRules: doc.module === "stays" ? { ...DEFAULT_STAYS_RULES, ...doc.staysRules } : null,
  shopRules: doc.module === "shop" ? { ...DEFAULT_SHOP_RULES, ...doc.shopRules } : null,
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
  await app.register(events);
  await app.register(coaching);
  await app.register(turf);
  await app.register(stays);
  await app.register(shop);
  await app.register(consoleInvoices);
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
        if (changes.eventRules !== undefined && module !== "events") {
          throw new AppError("VALIDATION_FAILED", "Event rules are set on the events module.", [{ path: "body/eventRules", message: "Events only" }]);
        }
        if (changes.coachingRules !== undefined && module !== "coaching") {
          throw new AppError("VALIDATION_FAILED", "Coaching rules are set on the coaching module.", [{ path: "body/coachingRules", message: "Coaching only" }]);
        }
        if (changes.turfRules !== undefined && module !== "turf") {
          throw new AppError("VALIDATION_FAILED", "Turf rules are set on the turf module.", [{ path: "body/turfRules", message: "Turf only" }]);
        }
        const turfRules = changes.turfRules ? { ...DEFAULT_TURF_RULES, ...before.turfRules, ...changes.turfRules } : null;
        const turfProblem = turfRules ? turfRulesProblem(turfRules) : null;
        if (turfProblem) throw new AppError("VALIDATION_FAILED", turfProblem.message, [{ path: `body/turfRules/${turfProblem.field}`, message: turfProblem.message }]);
        if (changes.staysRules !== undefined && module !== "stays") {
          throw new AppError("VALIDATION_FAILED", "Stays rules are set on the stays module.", [{ path: "body/staysRules", message: "Stays only" }]);
        }
        const staysRules = changes.staysRules ? { ...DEFAULT_STAYS_RULES, ...before.staysRules, ...changes.staysRules } : null;
        const staysProblem = staysRules ? staysRulesProblem(staysRules) : null;
        if (staysProblem) {
          throw new AppError("VALIDATION_FAILED", staysProblem.message, [{ path: `body/staysRules/${staysProblem.field}`, message: staysProblem.message }]);
        }
        if (changes.shopRules !== undefined && module !== "shop") {
          throw new AppError("VALIDATION_FAILED", "Shop rules are set on the shop module.", [{ path: "body/shopRules", message: "Local shops only" }]);
        }
        const fee = changes.payoutFee ?? before.payoutFee ?? DEFAULT_PAYOUT_FEE;
        const minimum = changes.minPayout ?? before.minPayout ?? DEFAULT_MIN_PAYOUT;
        if (payoutsChanged && minimum < fee + 100) {
          throw new AppError("VALIDATION_FAILED", "The minimum withdrawal must be at least ₹1 more than the payout fee.", [
            { path: "body/minPayout", message: "At least ₹1 more than the fee" },
          ]);
        }
        const { eventRules, coachingRules, turfRules: _turf, staysRules: _stays, shopRules, ...rest } = changes;
        const next = {
          ...rest,
          ...(shopRules ? { shopRules: { ...DEFAULT_SHOP_RULES, ...before.shopRules, ...shopRules } } : {}),
          ...(eventRules ? { eventRules: { ...DEFAULT_EVENT_RULES, ...before.eventRules, ...eventRules } } : {}),
          ...(coachingRules ? { coachingRules: { ...DEFAULT_COACHING_RULES, ...before.coachingRules, ...coachingRules } } : {}),
          ...(turfRules ? { turfRules } : {}),
          ...(staysRules ? { staysRules } : {}),
        };
        const diff = diffOf(before, next);
        changed = Object.keys(diff);
        if (!changed.length) return before;

        const after = await db.moduleSettings.findOneAndUpdate(
          { _id: before._id },
          { $set: { ...next, updatedBy: actor.id, updatedAt: new Date() } },
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
