const { getDb } = require('../config/database');

const collection = () => getDb().collection('business_types');

const sanitize = (doc) => {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return rest;
};

const ensureIndexes = async () => {
  await collection().createIndex({ id: 1 }, { unique: true });
  await collection().createIndex({ categoryId: 1, active: 1, sortOrder: 1 });
};

const count = () => collection().countDocuments();

const list = async ({ activeOnly = true, categoryId } = {}) => {
  const filter = {};
  if (activeOnly) filter.active = { $ne: false };
  if (categoryId) filter.categoryId = String(categoryId);
  const rows = await collection().find(filter).sort({ sortOrder: 1, label: 1 }).toArray();
  return rows.map(sanitize);
};

const findById = async (id, { activeOnly = false } = {}) => {
  const filter = { id: String(id) };
  if (activeOnly) filter.active = { $ne: false };
  return sanitize(await collection().findOne(filter));
};

const insertMany = async (docs) => {
  if (!docs.length) return;
  await collection().insertMany(docs);
};

const insert = async (data) => {
  const now = new Date();
  const doc = { active: true, sortOrder: 0, ...data, createdAt: now, updatedAt: now };
  await collection().insertOne(doc);
  return sanitize(doc);
};

const updateById = async (id, patch) => {
  const result = await collection().findOneAndUpdate(
    { id: String(id) },
    { $set: { ...patch, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  return sanitize(result?.value ?? result);
};

module.exports = {
  ensureIndexes,
  count,
  list,
  findById,
  insertMany,
  insert,
  updateById,
};
