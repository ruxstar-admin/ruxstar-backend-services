const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');
const { EVENT_STATUS } = require('../constants/events');

const collection = () => getDb().collection('events');

const toObjectId = (id) => new ObjectId(String(id));

const sanitize = (doc) => {
  if (!doc) return doc;
  const capacity = typeof doc.capacity === 'number' ? doc.capacity : null;
  const reserved = typeof doc.reservedCount === 'number' ? doc.reservedCount : 0;
  return {
    id: String(doc._id),
    businessId: String(doc.businessId),
    businessName: doc.businessName ?? '',
    kind: doc.kind,
    title: doc.title ?? '',
    description: doc.description ?? '',
    tournamentType: doc.tournamentType ?? '',
    format: doc.format ?? 'individual',
    teamSize: typeof doc.teamSize === 'number' ? doc.teamSize : null,
    capacity,
    reservedCount: reserved,
    confirmedCount: typeof doc.confirmedCount === 'number' ? doc.confirmedCount : 0,
    spotsLeft: capacity == null ? null : Math.max(0, capacity - reserved),
    entryFee: typeof doc.entryFee === 'number' ? doc.entryFee : 0,
    currency: doc.currency || 'INR',
    venue: doc.venue ?? '',
    coverUrl: doc.coverUrl ?? null,
    skillLevel: doc.skillLevel ?? '',
    ageCategory: doc.ageCategory ?? '',
    genderCategory: doc.genderCategory ?? '',
    rules: doc.rules ?? '',
    startAt: doc.startAt ? doc.startAt.toISOString() : null,
    endAt: doc.endAt ? doc.endAt.toISOString() : null,
    registrationDeadline: doc.registrationDeadline ? doc.registrationDeadline.toISOString() : null,
    status: doc.status,
    createdAt: doc.createdAt?.toISOString?.() ?? doc.createdAt,
    updatedAt: doc.updatedAt?.toISOString?.() ?? doc.updatedAt,
  };
};

const ensureIndexes = async () => {
  await collection().createIndex({ vendorId: 1, createdAt: -1 });
  await collection().createIndex({ businessId: 1, createdAt: -1 });
  await collection().createIndex({ status: 1, startAt: 1 });
};

const insert = async (vendorId, data) => {
  const now = new Date();
  const doc = {
    vendorId: toObjectId(vendorId),
    businessId: toObjectId(data.businessId),
    businessName: data.businessName ?? '',
    kind: data.kind,
    title: data.title,
    description: data.description ?? '',
    tournamentType: data.tournamentType ?? '',
    format: data.format ?? 'individual',
    teamSize: typeof data.teamSize === 'number' ? data.teamSize : null,
    capacity: typeof data.capacity === 'number' ? data.capacity : null,
    reservedCount: 0,
    confirmedCount: 0,
    entryFee: typeof data.entryFee === 'number' ? data.entryFee : 0,
    currency: 'INR',
    venue: data.venue ?? '',
    coverUrl: data.coverUrl ?? null,
    skillLevel: data.skillLevel ?? '',
    ageCategory: data.ageCategory ?? '',
    genderCategory: data.genderCategory ?? '',
    rules: data.rules ?? '',
    startAt: data.startAt ? new Date(data.startAt) : null,
    endAt: data.endAt ? new Date(data.endAt) : null,
    registrationDeadline: data.registrationDeadline ? new Date(data.registrationDeadline) : null,
    status: EVENT_STATUS.DRAFT,
    createdAt: now,
    updatedAt: now,
  };
  const { insertedId } = await collection().insertOne(doc);
  return sanitize({ _id: insertedId, ...doc });
};

const listByVendor = async (vendorId) => {
  const rows = await collection()
    .find({ vendorId: toObjectId(vendorId) })
    .sort({ startAt: -1, createdAt: -1 })
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
  const $set = { ...patch, updatedAt: new Date() };
  for (const key of ['startAt', 'endAt', 'registrationDeadline']) {
    if (key in $set && $set[key]) $set[key] = new Date($set[key]);
  }
  const result = await collection().findOneAndUpdate(
    { _id: toObjectId(id), vendorId: toObjectId(vendorId) },
    { $set },
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

// Public: published, upcoming events (registration still open).
const listPublic = async ({ limit = 50 } = {}) => {
  const rows = await collection()
    .find({ status: EVENT_STATUS.PUBLISHED, startAt: { $gte: new Date() } })
    .sort({ startAt: 1 })
    .limit(limit)
    .toArray();
  return rows.map(sanitize);
};

const findPublicById = async (id) => {
  if (!ObjectId.isValid(String(id))) return null;
  const doc = await collection().findOne({ _id: toObjectId(id) });
  if (!doc || doc.status !== EVENT_STATUS.PUBLISHED) return null;
  return sanitize(doc);
};

const findById = async (id) => {
  if (!ObjectId.isValid(String(id))) return null;
  const doc = await collection().findOne({ _id: toObjectId(id) });
  return doc ? { ...sanitize(doc), _raw: doc } : null;
};

// Atomically reserve one spot if capacity allows and the event is open for
// registration. Returns the updated (sanitized) event, or null if full/closed.
const reserveSpot = async (id, { session } = {}) => {
  if (!ObjectId.isValid(String(id))) return null;
  const filter = {
    _id: toObjectId(id),
    status: EVENT_STATUS.PUBLISHED,
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

module.exports = {
  sanitize,
  ensureIndexes,
  insert,
  listByVendor,
  findByIdForVendor,
  updateForVendor,
  deleteForVendor,
  listPublic,
  findPublicById,
  findById,
  reserveSpot,
  releaseSpot,
  confirmSpot,
};
