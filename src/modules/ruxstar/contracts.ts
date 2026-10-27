import { Type, type Static } from "typebox";
import { DateTime, Envelope, ListEnvelope, ModuleName, Strict } from "../../contracts/common.js";

export const ModuleSettings = Strict({
  module: ModuleName,
  live: Type.Boolean(),
  signupsOpen: Type.Boolean(),
  commissionBps: Type.Integer({ minimum: 0, maximum: 10000, description: "Commission in basis points. 1000 = 10%" }),
  deliveryEnabled: Type.Boolean(),
  permissionCatalog: Type.Array(Type.String()),
  updatedAt: DateTime,
});
export type ModuleSettings = Static<typeof ModuleSettings>;

export const ModuleParams = Strict({ module: ModuleName });

export const ModuleSettingsPatch = Strict(
  {
    live: Type.Optional(Type.Boolean()),
    signupsOpen: Type.Optional(Type.Boolean()),
    commissionBps: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
    deliveryEnabled: Type.Optional(Type.Boolean()),
  },
  { minProperties: 1 },
);

export const ModuleSettingsList = ListEnvelope(ModuleSettings);
export const ModuleSettingsOne = Envelope(ModuleSettings);
