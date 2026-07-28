const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');
const { OFFER_STATUS } = require('../constants/creator');

const collection = () => getDb().collection('creator_offers');

const toObjectId = (id) => new ObjectId(String(id));

const sanitize = (doc) => {
  if (!doc) return doc;
  const capacity = typeof doc.capacity === 'number' ? doc.capacity : null;
  const reserved = typeof doc.reservedCount === 'number' ? doc.reservedCount : 0;
  return {
    id: String(doc._id),
    businessId: String(doc.businessId),
    businessName: doc.businessName ?? '',
    vendorId: String(doc.vendorId),
    title: doc.title ?? '',
    description: doc.description ?? '',
    kind: doc.kind ?? 'collab',
    platforms: Array.isArray(doc.platforms) ? doc.platforms : [],
    price: typeof doc.price === 'number' ? doc.price : 0,
    currency: doc.currency || 'INR',
    turnaroundDays: typeof doc.turnaroundDays === 'number' ? doc.turnaroundDays : null,
    capacity,
    reservedCount: reserved,
    confirmedCount: typeof doc.confirmedCount === 'number' ? doc.confirmedCount : 0,
    spotsLeft: capacity == null ? null : Math.max(0, capacity - reserved),
    coverUrl: doc.coverUrl ?? null,
    status: doc.status,
    createdAt: doc.createdAt?.toISOString?.() ?? doc.createdAt,
    updatedAt: doc.updatedAt?.toISOString?.() ?? doc.updatedAt,
  };
};

const ensureIndexes = async () => {
  await collection().createIndex({ vendorId: 1, createdAt: -1 });
  await collection().createIndex({ businessId: 1, createdAt: -1 });
  await collection().createIndex({ status: 1, createdAt: -1 });
};

const insert = async (vendorId, data) => {
  const now = new Date();
  const doc = {
    vendorId: toObjectId(vendorId),
    businessId: toObjectId(data.businessId),
    businessName: data.businessName ?? '',
    title: data.title,
    description: data.description ?? '',
    kind: data.kind ?? 'collab',
    platforms: Array.isArray(data.platforms) ? data.platforms : [],
    price: typeof data.price === 'number' ? data.price : 0,
    currency: 'INR',
    turnaroundDays: typeof data.turnaroundDays === 'number' ? data.turnaroundDays : null,
    capacity: typeof data.capacity === 'number' ? data.capacity : null,
    reservedCount: 0,
    confirmedCount: 0,
    coverUrl: data.coverUrl ?? null,
    status: OFFER_STATUS.DRAFT,
    createdAt: now,
    updatedAt: now,
  };
  const { insertedId } = await collection().insertOne(doc);
  return sanitize({ _id: insertedId, ...doc });
};

const listByVendor = async (vendorId, { businessId } = {}) => {
  const filter = { vendorId: toObjectId(vendorId) };
  if (businessId && ObjectId.isValid(String(businessId))) {
    filter.businessId = toObjectId(businessId);
  }
  const rows = await collection().find(filter).sort({ createdAt: -1 }).toArray();
  return rows.map(sanitize);
};

const listByBusiness = async (businessId) => {
  const rows = await collection()
    .find({ businessId: toObjectId(businessId) })
    .sort({ createdAt: -1 })
    .toArray();
  return rows.map(sanitize);
};

const findByIdForVendor = async (id, vendorId) => {
  if (!ObjectId.isValid(String(id))) return null;
  const doc = await collection().findOne({ _id: toObjectId(id), vendorId: toObjectId(vendorId) });
  return sanitize(doc);
};

const updateForVendor = async (id, vendorId, patch) => {
  if (!ObjectId.isValid(String(id))) return null;
  const result = await collection().findOneAndUpdate(
    { _id: toObjectId(id), vendorId: toObjectId(vendorId) },
    { $set: { ...patch, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  return sanitize(result?.value ?? result);
};

const deleteForVendor = async (id, vendorId) => {
  if (!ObjectId.isValid(String(id))) return false;
  const { deletedCount } = await collection().deleteOne({
    _id: toObjectId(id),
    vendorId: toObjectId(vendorId),
  });
  return deletedCount > 0;
};

const listPublic = async ({ limit = 50 } = {}) => {
  const rows = await collection()
    .find({ status: OFFER_STATUS.PUBLISHED })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
  return rows.map(sanitize);
};

const findPublicById = async (id) => {
  if (!ObjectId.isValid(String(id))) return null;
  const doc = await collection().findOne({ _id: toObjectId(id), status: OFFER_STATUS.PUBLISHED });
  return sanitize(doc);
};

const findById = async (id) => {
  if (!ObjectId.isValid(String(id))) return null;
  const doc = await collection().findOne({ _id: toObjectId(id) });
  return doc ? { ...sanitize(doc), _raw: doc } : null;
};

const reserveSpot = async (id, { session } = {}) => {
  if (!ObjectId.isValid(String(id))) return null;
  const filter = {
    _id: toObjectId(id),
    status: OFFER_STATUS.PUBLISHED,
    $or: [
      { capacity: null },
      { $expr: { $lt: [{ $ifNull: ['$reservedCount', 0] }, '$capacity'] } },
    ],
  };
  const result = await collection().findOneAndUpdate(
    filter,
    { $inc: { reservedCount: 1 }, $set: { updatedAt: new Date() } },
    { returnDocument: 'after', ...(session ? { session } : {}) },
  );
  const doc = result?.value ?? result;
  return doc ? sanitize(doc) : null;
};

const releaseSpot = async (id, { wasConfirmed = false, session } = {}) => {
  if (!ObjectId.isValid(String(id))) return;
  const dec = { reservedCount: -1 };
  if (wasConfirmed) dec.confirmedCount = -1;
  await collection().updateOne(
    { _id: toObjectId(id) },
    { $inc: dec, $set: { updatedAt: new Date() } },
    session ? { session } : {},
  );
};

const confirmSpot = async (id, { session } = {}) => {
  if (!ObjectId.isValid(String(id))) return;
  await collection().updateOne(
    { _id: toObjectId(id) },
    { $inc: { confirmedCount: 1 }, $set: { updatedAt: new Date() } },
    session ? { session } : {},
  );
};

const countPublishedForBusiness = async (businessId) =>
  collection().countDocuments({
    businessId: toObjectId(businessId),
    status: OFFER_STATUS.PUBLISHED,
  });

module.exports = {
  sanitize,
  ensureIndexes,
  insert,
  listByVendor,
  listByBusiness,
  findByIdForVendor,
  updateForVendor,
  deleteForVendor,
  listPublic,
  findPublicById,
  findById,
  reserveSpot,
  releaseSpot,
  confirmSpot,
  countPublishedForBusiness,
};
