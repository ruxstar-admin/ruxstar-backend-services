import { MongoBulkWriteError, ObjectId, type WithId } from "mongodb";
import { diffOf, writeAudit } from "../../platform/audit.js";
import { stamp, type AuditLogDoc, type BusinessDoc, type Database, type ShopBannedDoc, type ShopProductDoc, type ShopVariantDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { escapeRegex } from "../pod/shops.js";
import { shopSettings, type ShopSettings } from "./rules.js";

const invalid = (path: string, message: string) => new AppError("VALIDATION_FAILED", message, [{ path, message }]);

/** What products can't be about until Ruxstar changes the list. */
export const DEFAULT_BANNED: readonly { key: string; name: string; words: string[] }[] = [
  { key: "tobacco", name: "Tobacco and vapes", words: ["tobacco", "cigarette", "cigarettes", "gutka", "beedi", "vape", "e-cigarette"] },
  { key: "alcohol", name: "Alcohol", words: ["alcohol", "liquor", "beer", "whisky", "whiskey", "vodka"] },
  { key: "weapons", name: "Weapons", words: ["firearm", "pistol", "revolver", "ammunition", "bullets"] },
  { key: "drugs", name: "Drugs", words: ["cannabis", "ganja", "marijuana", "narcotics", "cocaine"] },
  { key: "medicines", name: "Prescription medicines", words: ["prescription medicine", "schedule h"] },
];

export async function loadBanned(db: Database): Promise<WithId<ShopBannedDoc>[]> {
  const docs = await db.shopBanned.find({}).sort({ name: 1, _id: 1 }).toArray();
  if (docs.length) return docs;
  const now = new Date();
  const defaults: ShopBannedDoc[] = DEFAULT_BANNED.map((b) => ({ _id: b.key, name: b.name, words: b.words, active: true, ...stamp(now) }));
  await db.shopBanned.insertMany(defaults, { ordered: false }).catch((err: unknown) => {
    const errors = err instanceof MongoBulkWriteError ? [err.writeErrors].flat() : [];
    if (errors.length === 0 || errors.some((e) => e.code !== 11000)) throw err;
  });
  return db.shopBanned.find({}).sort({ name: 1, _id: 1 }).toArray();
}

/** The banned category and word a text uses, matched as whole words in any case. */
function bannedIn(text: string, banned: Pick<ShopBannedDoc, "name" | "words">[]) {
  for (const b of banned) {
    const word = b.words.find((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(w)}($|[^\\p{L}\\p{N}])`, "iu").test(text));
    if (word) return { name: b.name, word };
  }
  return null;
}

export interface ProductInput {
  title: string;
  description?: string | null | undefined;
  options?: { name: string; values: string[] }[] | undefined;
  variants: { values?: string[] | undefined; price: number; mrp?: number | null | undefined; stock: number; sku?: string | null | undefined }[];
  hsn?: string | null | undefined;
  gstRateBps?: number | null | undefined;
  status?: "live" | "hidden" | undefined;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const key = (values: string[]) => values.map((v) => v.trim().toLowerCase()).join("\u0000");

/**
 * Checks a product as a whole: up to `maxOptions` options with distinct values, one variant per combination used (each with
 * its own price, MRP, stock and SKU), and nothing on Ruxstar's banned list. Variants keep their ids across edits by their values,
 * so carts and past orders still point at them.
 */
export async function shapeProduct(db: Database, input: ProductInput, settings: ShopSettings, before: Pick<ShopProductDoc, "variants"> | null) {
  const title = input.title.trim();
  if (title.length < 2) throw invalid("body/title", "Give the product a name.");
  const description = input.description?.trim() || null;
  const options = (input.options ?? []).map((o) => ({ name: o.name.trim(), values: o.values.map((v) => v.trim()) }));
  if (options.length > settings.maxOptions) {
    throw invalid("body/options", settings.maxOptions === 1 ? "A product can have one option, such as size." : `A product can have up to ${settings.maxOptions} options, such as size and colour.`);
  }
  options.forEach((o, i) => {
    if (!o.name) throw invalid(`body/options/${i}/name`, "Name the option, such as Size.");
    if (options.findIndex((x) => same(x.name, o.name)) !== i) throw invalid(`body/options/${i}/name`, `There are two ${o.name} options.`);
    if (!o.values.length) throw invalid(`body/options/${i}/values`, `Add the ${o.name} values.`);
    if (o.values.length > settings.maxValues) throw invalid(`body/options/${i}/values`, `An option can have up to ${settings.maxValues} values.`);
    o.values.forEach((v, k) => {
      if (!v) throw invalid(`body/options/${i}/values/${k}`, "A value can't be blank.");
      if (o.values.findIndex((x) => same(x, v)) !== k) throw invalid(`body/options/${i}/values/${k}`, `${v} is in ${o.name} twice.`);
    });
  });
  if (input.variants.length > settings.maxVariants) throw invalid("body/variants", `A product can have up to ${settings.maxVariants} variants.`);
  if (!options.length && input.variants.length !== 1) throw invalid("body/variants", "A product without options has one variant: its price and stock.");
  const seen = new Set<string>();
  const variants = input.variants.map((v, i): ShopVariantDoc => {
    const given = (v.values ?? []).map((x) => x.trim());
    if (given.length !== options.length) {
      throw invalid(`body/variants/${i}/values`, options.length ? `Give a ${options.map((o) => o.name).join(" and ")} for each variant.` : "Leave the values out: this product has no options.");
    }
    const values = given.map((x, k) => {
      const match = options[k]!.values.find((y) => same(x, y));
      if (!match) throw invalid(`body/variants/${i}/values/${k}`, `${x} isn't one of the ${options[k]!.name} values.`);
      return match;
    });
    if (seen.has(key(values))) throw invalid(`body/variants/${i}/values`, `${values.join(", ")} is in the table twice.`);
    seen.add(key(values));
    const mrp = v.mrp ?? null;
    if (mrp !== null && mrp < v.price) throw invalid(`body/variants/${i}/mrp`, "The MRP can't be less than the price.");
    const kept = before?.variants.find((x) => key(x.values) === key(values));
    return { id: kept?.id ?? new ObjectId(), values, price: v.price, mrp, stock: v.stock, sku: v.sku?.trim() || null };
  });

  const banned = (await loadBanned(db)).filter((b) => b.active);
  const texts: [string, string][] = [
    ["body/title", title],
    ["body/description", description ?? ""],
    ...options.flatMap((o, i): [string, string][] => [[`body/options/${i}/name`, o.name], ...o.values.map((v, k): [string, string] => [`body/options/${i}/values/${k}`, v])]),
  ];
  for (const [path, text] of texts) {
    const hit = bannedIn(text, banned);
    if (hit) throw invalid(path, `${hit.name} can't be sold on Ruxstar ("${hit.word}"). Remove it, or contact support if this is a mistake.`);
  }

  const cheapest = [...variants].sort((a, b) => a.price - b.price)[0]!;
  return {
    title,
    description,
    options,
    variants,
    priceFrom: cheapest.price,
    mrpFrom: cheapest.mrp,
    inStock: variants.some((v) => v.stock > 0),
    tax: { hsn: input.hsn ?? null, rateBps: input.gstRateBps ?? null },
  };
}

type Who = { actor: AuditLogDoc["actor"]; ip: string | null };

export async function createProduct(db: Database, shop: WithId<BusinessDoc>, input: ProductInput, who: Who): Promise<ShopProductDoc> {
  const settings = await shopSettings(db);
  if ((await db.shopProducts.countDocuments({ businessId: shop._id, status: { $ne: "removed" } })) >= settings.maxProducts) {
    throw new AppError("CONFLICT", `A shop can have up to ${settings.maxProducts} products. Remove some first.`);
  }
  const doc: ShopProductDoc = {
    _id: new ObjectId(),
    businessId: shop._id,
    vendorId: shop.ownerId,
    businessName: shop.name,
    city: (shop.location?.city ?? "").trim().toLowerCase(),
    ...(await shapeProduct(db, input, settings, null)),
    photo: null,
    status: input.status ?? "live",
    removal: null,
    seq: 0,
    ...stamp(),
  };
  await db.shopProducts.insertOne(doc);
  await writeAudit(db, {
    actor: who.actor,
    scope: { module: "shop", businessId: shop._id },
    action: "shop_product.create",
    target: { type: "shop_product", id: doc._id },
    diff: { title: { from: null, to: doc.title } },
    ip: who.ip,
  });
  return doc;
}

const fieldsOf = (p: ShopProductDoc): ProductInput => ({
  title: p.title,
  description: p.description,
  options: p.options,
  variants: p.variants.map((v) => ({ values: v.values, price: v.price, mrp: v.mrp, stock: v.stock, sku: v.sku })),
  hsn: p.tax.hsn,
  gstRateBps: p.tax.rateBps,
});

/**
 * Changes what's sent. Sending `variants` replaces the whole table, stock included, so it's only saved if no order took stock
 * since the product was read: otherwise the edit asks to refresh rather than undo a sale.
 */
export async function editProduct(db: Database, before: WithId<ShopProductDoc>, input: Partial<ProductInput>, who: Who): Promise<ShopProductDoc> {
  if (before.status === "removed") throw new AppError("CONFLICT", "Ruxstar took this product down, so it can't be changed.");
  if (input.options !== undefined && input.variants === undefined) throw invalid("body/variants", "Send the variants table with the options.");
  const settings = await shopSettings(db);
  const shaped = await shapeProduct(db, { ...fieldsOf(before), ...input }, settings, before);
  const next = { ...shaped, status: input.status ?? before.status };
  const diff = diffOf(
    { title: before.title, description: before.description, options: before.options, variants: before.variants, tax: before.tax, status: before.status },
    next,
  );
  if (!Object.keys(diff).length) return before;
  const after = await db.shopProducts.findOneAndUpdate(
    { _id: before._id, seq: before.seq, status: { $ne: "removed" } },
    { $set: { ...next, updatedAt: new Date() }, $inc: { seq: 1 } },
    { returnDocument: "after" },
  );
  if (!after) throw new AppError("CONFLICT", "An order just changed this product's stock. Refresh and make the change again.");
  await writeAudit(db, { actor: who.actor, scope: { module: "shop", businessId: before.businessId }, action: "shop_product.update", target: { type: "shop_product", id: before._id }, diff, ip: who.ip });
  return after;
}

/** Sets how many are left of some variants, each to the number given. */
export async function setStock(db: Database, before: WithId<ShopProductDoc>, changes: { variantId: string; stock: number }[], who: Who): Promise<ShopProductDoc> {
  if (before.status === "removed") throw new AppError("CONFLICT", "Ruxstar took this product down, so it can't be changed.");
  changes.forEach((c, i) => {
    if (!before.variants.some((v) => v.id.toHexString() === c.variantId)) throw invalid(`body/variants/${i}/variantId`, "This variant isn't on the product. Refresh it.");
  });
  const now = new Date();
  for (const c of changes) {
    await db.shopProducts.updateOne(
      { _id: before._id },
      { $set: { "variants.$[v].stock": c.stock, updatedAt: now }, $inc: { seq: 1 } },
      { arrayFilters: [{ "v.id": new ObjectId(c.variantId) }] },
    );
  }
  await db.shopProducts.updateOne({ _id: before._id }, [
    { $set: { inStock: { $anyElementTrue: [{ $map: { input: "$variants", as: "v", in: { $gt: ["$$v.stock", 0] } } }] } } },
  ]);
  const after = (await db.shopProducts.findOne({ _id: before._id }))!;
  const stockOf = (p: ShopProductDoc) => Object.fromEntries(p.variants.map((v) => [v.id.toHexString(), v.stock]));
  await writeAudit(db, {
    actor: who.actor,
    scope: { module: "shop", businessId: before.businessId },
    action: "shop_product.stock",
    target: { type: "shop_product", id: before._id },
    diff: { stock: { from: stockOf(before), to: stockOf(after) } },
    ip: who.ip,
  });
  return after;
}
