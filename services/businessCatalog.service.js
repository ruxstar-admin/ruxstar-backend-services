const BusinessCategory = require('../models/BusinessCategory');
const BusinessType = require('../models/BusinessType');
const { BUSINESS_MODULES, MODULE_LABELS } = require('../constants/businessModules');
const { BUSINESS_CATEGORIES, BUSINESS_TYPES } = require('../seeds/businessCatalog');

const CATALOG_TTL_MS = 5 * 60 * 1000;
let catalogCache = null;
let catalogCachedAt = 0;

const invalidateCatalogCache = () => {
  catalogCache = null;
  catalogCachedAt = 0;
};

const slug = (v) => String(v).trim().toLowerCase().replace(/\s+/g, '_');

const seedIfEmpty = async () => {
  await BusinessCategory.ensureIndexes();
  await BusinessType.ensureIndexes();

  const [catCount, typeCount] = await Promise.all([
    BusinessCategory.count(),
    BusinessType.count(),
  ]);

  if (catCount > 0 || typeCount > 0) return { seeded: false };

  const now = new Date();
  await BusinessCategory.insertMany(
    BUSINESS_CATEGORIES.map((c) => ({ ...c, active: true, createdAt: now, updatedAt: now })),
  );
  await BusinessType.insertMany(
    BUSINESS_TYPES.map((t) => ({ ...t, active: true, createdAt: now, updatedAt: now })),
  );

  return { seeded: true, categories: BUSINESS_CATEGORIES.length, types: BUSINESS_TYPES.length };
};

/** Public/vendor catalog — active categories with nested active types. */
const listCatalog = async () => {
  const now = Date.now();
  if (catalogCache && now - catalogCachedAt < CATALOG_TTL_MS) {
    return catalogCache;
  }

  const [categories, types] = await Promise.all([
    BusinessCategory.list({ activeOnly: true }),
    BusinessType.list({ activeOnly: true }),
  ]);

  const typesByCategory = types.reduce((acc, t) => {
    if (!acc[t.categoryId]) acc[t.categoryId] = [];
    acc[t.categoryId].push(t);
    return acc;
  }, {});

  catalogCache = {
    categories: categories.map((c) => ({
      ...c,
      types: typesByCategory[c.id] ?? [],
    })),
    modules: MODULE_LABELS,
  };
  catalogCachedAt = now;
  return catalogCache;
};

/** Resolve type for business create — validates category is active too. */
const resolveTypeForBusiness = async (typeId) => {
  const businessType = await BusinessType.findById(typeId, { activeOnly: true });
  if (!businessType) {
    throw Object.assign(new Error('invalid or inactive business type'), { status: 400 });
  }

  const category = await BusinessCategory.findById(businessType.categoryId, { activeOnly: true });
  if (!category) {
    throw Object.assign(new Error('business type category is unavailable'), { status: 400 });
  }

  return { businessType, category };
};

const listCategoriesAdmin = () => BusinessCategory.list({ activeOnly: false });

const listTypesAdmin = (categoryId) =>
  BusinessType.list({ activeOnly: false, categoryId: categoryId || undefined });

const createCategory = async (body) => {
  const id = slug(body.id || body.label);
  if (!id) throw Object.assign(new Error('category id or label required'), { status: 400 });
  if (!body.label?.trim()) throw Object.assign(new Error('label required'), { status: 400 });

  const existing = await BusinessCategory.findById(id);
  if (existing) throw Object.assign(new Error('category id already exists'), { status: 409 });

  return BusinessCategory.insert({
    id,
    label: String(body.label).trim(),
    description: String(body.description ?? '').trim(),
    icon: String(body.icon ?? '🏪').trim(),
    sortOrder: Number(body.sortOrder) || 0,
    active: body.active !== false,
  }).then((row) => {
    invalidateCatalogCache();
    return row;
  });
};

const updateCategory = async (id, body) => {
  const patch = {};
  if (body.label !== undefined) patch.label = String(body.label).trim();
  if (body.description !== undefined) patch.description = String(body.description).trim();
  if (body.icon !== undefined) patch.icon = String(body.icon).trim();
  if (body.sortOrder !== undefined) patch.sortOrder = Number(body.sortOrder) || 0;
  if (body.active !== undefined) patch.active = body.active !== false;

  if (patch.label === '') throw Object.assign(new Error('label cannot be empty'), { status: 400 });
  if (Object.keys(patch).length === 0) {
    throw Object.assign(new Error('no fields to update'), { status: 400 });
  }

  const updated = await BusinessCategory.updateById(id, patch);
  if (!updated) throw Object.assign(new Error('category not found'), { status: 404 });
  invalidateCatalogCache();
  return updated;
};

const createType = async (body) => {
  const id = slug(body.id || body.label);
  if (!id) throw Object.assign(new Error('type id or label required'), { status: 400 });
  if (!body.label?.trim()) throw Object.assign(new Error('label required'), { status: 400 });
  if (!body.categoryId?.trim()) {
    throw Object.assign(new Error('categoryId required'), { status: 400 });
  }
  if (!BUSINESS_MODULES.includes(body.module)) {
    throw Object.assign(new Error('invalid module'), { status: 400 });
  }

  const category = await BusinessCategory.findById(body.categoryId);
  if (!category) throw Object.assign(new Error('category not found'), { status: 404 });

  const existing = await BusinessType.findById(id);
  if (existing) throw Object.assign(new Error('type id already exists'), { status: 409 });

  return BusinessType.insert({
    id,
    categoryId: String(body.categoryId).trim(),
    label: String(body.label).trim(),
    description: String(body.description ?? '').trim(),
    examples: String(body.examples ?? '').trim(),
    namePlaceholder: String(body.namePlaceholder ?? '').trim(),
    detailHint: String(body.detailHint ?? '').trim(),
    module: body.module,
    sortOrder: Number(body.sortOrder) || 0,
    active: body.active !== false,
  }).then((row) => {
    invalidateCatalogCache();
    return row;
  });
};

const updateType = async (id, body) => {
  const patch = {};
  const strFields = [
    'label',
    'description',
    'examples',
    'namePlaceholder',
    'detailHint',
    'categoryId',
  ];
  for (const key of strFields) {
    if (body[key] !== undefined) patch[key] = String(body[key]).trim();
  }
  if (body.module !== undefined) {
    if (!BUSINESS_MODULES.includes(body.module)) {
      throw Object.assign(new Error('invalid module'), { status: 400 });
    }
    patch.module = body.module;
  }
  if (body.sortOrder !== undefined) patch.sortOrder = Number(body.sortOrder) || 0;
  if (body.active !== undefined) patch.active = body.active !== false;

  if (patch.label === '') throw Object.assign(new Error('label cannot be empty'), { status: 400 });
  if (patch.categoryId) {
    const category = await BusinessCategory.findById(patch.categoryId);
    if (!category) throw Object.assign(new Error('category not found'), { status: 404 });
  }
  if (Object.keys(patch).length === 0) {
    throw Object.assign(new Error('no fields to update'), { status: 400 });
  }

  const updated = await BusinessType.updateById(id, patch);
  if (!updated) throw Object.assign(new Error('type not found'), { status: 404 });
  invalidateCatalogCache();
  return updated;
};

module.exports = {
  seedIfEmpty,
  listCatalog,
  resolveTypeForBusiness,
  listCategoriesAdmin,
  listTypesAdmin,
  createCategory,
  updateCategory,
  createType,
  updateType,
};
