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
import { ModuleParams, ModuleSettingsList, ModuleSettingsOne, ModuleSettingsPatch, type ModuleSettings } from "./contracts.js";

const ORDER = ["pod", "events", "coaching", "stays", "delivery", "ledger"];

const view = (doc: ModuleSettingsDoc): ModuleSettings => ({
  module: doc.module,
  live: doc.live,
  signupsOpen: doc.signupsOpen,
  commissionBps: doc.commissionBps,
  deliveryEnabled: doc.deliveryEnabled,
  permissionCatalog: doc.permissionCatalog,
  updatedAt: doc.updatedAt.toISOString(),
});

const ruxstar: FastifyPluginAsyncTypebox = async (app) => {
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
        summary: "Switch a module on or off, or change its signups, commission or delivery",
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
