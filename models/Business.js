const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');

const collection = () => getDb().collection('businesses');

const toObjectId = (id) => new ObjectId(String(id));

const sanitize = (doc) => {
  if (!doc) return doc;
  const { vendorId, ...rest } = doc;
  return { ...rest, vendorId: vendorId ? String(vendorId) : undefined };
};

const listByVendor = async (vendorId) => {
  const rows = await collection()
    .find({ vendorId: toObjectId(vendorId) })
    .sort({ createdAt: -1 })
    .toArray();
  return rows.map(sanitize);
};

const findByIdForVendor = async (id, vendorId) => {
  if (!ObjectId.isValid(String(id))) return null;
  const doc = await collection().findOne({
    _id: toObjectId(id),
    vendorId: toObjectId(vendorId),
  });
  return sanitize(doc);
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

const countByVendor = (vendorId) =>
  collection().countDocuments({ vendorId: toObjectId(vendorId) });

module.exports = {
  sanitize,
  listByVendor,
  findByIdForVendor,
  insert,
  updateForVendor,
  deleteForVendor,
  countByVendor,
};
