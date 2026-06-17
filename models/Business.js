const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');

const collection = () => getDb().collection('businesses');

const toObjectId = (id) => new ObjectId(String(id));

/** Exclude heavy base64 blobs from MongoDB reads (saves DB + memory bandwidth). */
const WITHOUT_PHOTO_DATA = { 'setup.photos.data': 0 };

const LIST_PUBLIC_PROJECTION = {
  name: 1,
  typeLabel: 1,
  categoryLabel: 1,
  module: 1,
  address: 1,
  description: 1,
  'setup.pricePerSlot': 1,
  'setup.slotMinutes': 1,
  createdAt: 1,
  status: 1,
  setupComplete: 1,
};

const sanitize = (doc) => {
  if (!doc) return doc;
  const { vendorId, ...rest } = doc;
  return { ...rest, vendorId: vendorId ? String(vendorId) : undefined };
};

const findOpts = ({ withPhotoData = true } = {}) =>
  withPhotoData ? {} : { projection: WITHOUT_PHOTO_DATA };

const listByVendor = async (vendorId, { withPhotoData = false } = {}) => {
  const rows = await collection()
    .find({ vendorId: toObjectId(vendorId) }, findOpts({ withPhotoData }))
    .sort({ createdAt: -1 })
    .toArray();
  return rows.map(sanitize);
};

const findByIdForVendor = async (id, vendorId, { withPhotoData = true } = {}) => {
  if (!ObjectId.isValid(String(id))) return null;
  const doc = await collection().findOne(
    { _id: toObjectId(id), vendorId: toObjectId(vendorId) },
    findOpts({ withPhotoData }),
  );
  return sanitize(doc);
};

const findLiveById = async (id, { withPhotoData = false } = {}) => {
  if (!ObjectId.isValid(String(id))) return null;
  const doc = await collection().findOne(
    { _id: toObjectId(id), status: 'live', setupComplete: true },
    findOpts({ withPhotoData }),
  );
  return sanitize(doc);
};

const listLivePublic = async ({ module } = {}) => {
  const filter = {
    status: 'live',
    setupComplete: true,
  };
  if (module) filter.module = module;

  const rows = await collection()
    .find(filter, { projection: LIST_PUBLIC_PROJECTION })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();
  return rows.map(sanitize);
};

const insert = async (vendorId, data) => {
  const now = new Date();
  const doc = {
    vendorId: toObjectId(vendorId),
    ...data,
    status: 'draft',
    setupComplete: false,
    createdAt: now,
    updatedAt: now,
  };
  const { insertedId } = await collection().insertOne(doc);
  return sanitize({ _id: insertedId, ...doc });
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

const findSetupPhoto = async (businessId, photoId) => {
  if (!ObjectId.isValid(String(businessId)) || !photoId) return null;
  const doc = await collection().findOne(
    { _id: toObjectId(businessId), 'setup.photos.id': String(photoId) },
    { projection: { 'setup.photos.$': 1 } },
  );
  return doc?.setup?.photos?.[0] ?? null;
};

const countByVendor = (vendorId) =>
  collection().countDocuments({ vendorId: toObjectId(vendorId) });

const ensureIndexes = async () => {
  await collection().createIndex({ vendorId: 1, createdAt: -1 });
  await collection().createIndex({ status: 1, setupComplete: 1, module: 1, createdAt: -1 });
};

module.exports = {
  sanitize,
  listByVendor,
  findByIdForVendor,
  findLiveById,
  listLivePublic,
  insert,
  updateForVendor,
  deleteForVendor,
  countByVendor,
  ensureIndexes,
  findSetupPhoto,
};
