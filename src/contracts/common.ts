import { Type, type TProperties, type TSchema, type TObjectOptions } from "typebox";
import { ERROR_CODES } from "../platform/errors.js";

/** Request and response objects reject fields that are not in the contract. */
export const Strict = <T extends TProperties>(properties: T, options: TObjectOptions = {}) =>
  Type.Object(properties, { additionalProperties: false, ...options });

export const ObjectIdString = Type.String({ pattern: "^[a-f0-9]{24}$", description: "MongoDB ObjectId as hex" });

/** Money is always whole paise. ₹1 = 100. */
export const Paise = Type.Integer({ minimum: 0, description: "Amount in paise" });

export const DateTime = Type.String({ format: "date-time" });

export const Meta = Strict({
  requestId: Type.String(),
});

export const ListMeta = Strict({
  requestId: Type.String(),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

export const Envelope = <T extends TSchema>(data: T) => Strict({ data, meta: Meta });

export const ListEnvelope = <T extends TSchema>(item: T) => Strict({ data: Type.Array(item), meta: ListMeta });

export const ErrorEnvelope = Strict(
  {
    error: Strict({
      code: Type.Union(Object.keys(ERROR_CODES).map((code) => Type.Literal(code))),
      message: Type.String(),
      details: Type.Array(
        Type.Object({ path: Type.Optional(Type.String()), message: Type.String() }, { additionalProperties: true }),
      ),
    }),
  },
  { $id: "Error" },
);

/** Every route documents the same error shape. `ErrorEnvelope` is registered once in the app. */
export const Errors = { "4xx": Type.Ref("Error"), "5xx": Type.Ref("Error") };

export const PageQuery = {
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
};

export const Client = Type.Union([Type.Literal("web"), Type.Literal("app"), Type.Literal("delivery")]);

/** Modules an admin can switch on and off from `module_settings`. */
export const ModuleName = Type.Union([
  Type.Literal("pod"),
  Type.Literal("events"),
  Type.Literal("coaching"),
  Type.Literal("stays"),
  Type.Literal("delivery"),
  Type.Literal("ledger"),
]);
