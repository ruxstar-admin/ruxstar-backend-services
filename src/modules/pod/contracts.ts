import { Type, type Static, type TSchema } from "typebox";
import { Envelope, ListEnvelope, ObjectIdString, PageQuery, Paise, Strict } from "../../contracts/common.js";
import { Photo } from "../social/contracts.js";
import { BusinessTypeId, PodProductId } from "../vendor/contracts.js";

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Unit = Type.Union([Type.Literal("unit"), Type.Literal("page")]);

/** A print shop as Discover shows it. */
export const ShopCard = Strict({
  id: ObjectIdString,
  name: Type.String(),
  type: BusinessTypeId,
  typeLabel: Type.String(),
  cover: Nullable(Photo),
  area: Nullable(Type.String()),
  city: Type.String(),
  state: Type.String(),
  open: Type.Boolean({ description: "Taking orders now" }),
  deliversEverywhere: Type.Boolean(),
  fromPrice: Nullable(Paise),
  fromUnit: Nullable(Unit),
  turnaroundDays: Type.Integer({ description: "Usual days to get an order ready; 0 is the same day" }),
  products: Type.Array(PodProductId),
});
export type ShopCard = Static<typeof ShopCard>;

const ShopProduct = Strict({
  id: PodProductId,
  label: Type.String(),
  description: Type.String(),
  pricing: Type.Union([Type.Literal("per_unit"), Type.Literal("per_page")]),
  minQuantity: Type.Integer(),
  turnaroundDays: Type.Integer({ description: "This product's own time, or the shop's usual time" }),
  basePrice: Nullable(Paise),
  bw: Nullable(Paise),
  color: Nullable(Paise),
  extras: Type.Array(Strict({ option: Type.String(), value: Type.String(), price: Paise })),
  tiers: Type.Array(Strict({ from: Type.Integer(), unitPrice: Paise })),
  options: Type.Array(Strict({ option: Type.String(), values: Type.Array(Type.String()) }), {
    description: "Every value a customer can choose, extra or not",
  }),
});

/** The public page of a print shop: what customers can order and how much it costs. The street address and phone are not shown. */
export const Shop = Strict({
  ...ShopCard.properties,
  description: Nullable(Type.String()),
  photos: Type.Array(Photo, { description: "The first is the cover" }),
  pincode: Nullable(Type.String()),
  cities: Type.Array(Type.String(), { description: "Where it delivers, when not everywhere" }),
  minOrder: Paise,
  notes: Nullable(Type.String()),
  catalog: Type.Array(ShopProduct, { description: "Products with a price, in catalog order" }),
});
export type Shop = Static<typeof Shop>;

export const ShopList = ListEnvelope(ShopCard);
export const ShopOne = Envelope(Shop);
export const ShopParams = Strict({ id: ObjectIdString });
export const ShopsQuery = Strict({
  ...PageQuery,
  city: Type.Optional(Type.String({ minLength: 2, maxLength: 60, description: "Shops in or delivering to this city" })),
  product: Type.Optional(PodProductId),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "Part of the shop name" })),
});
