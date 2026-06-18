const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');

const collection = () => getDb().collection('bookings');

const toObjectId = (id) => new ObjectId(String(id));

const sanitize = (doc) => {
  if (!doc) return doc;
  return {
    id: String(doc._id),
    businessId: String(doc.businessId),
    businessName: doc.businessName,
    typeLabel: doc.typeLabel,
    resourceId: doc.resourceId,
    resourceName: doc.resourceName,
    startAt: doc.startAt.toISOString(),
    endAt: doc.endAt.toISOString(),
    pricePerSlot: doc.pricePerSlot,
    customerName: doc.customerName,
    customerMobile: doc.customerMobile,
    status: doc.status,
    createdAt: doc.createdAt?.toISOString?.() ?? doc.createdAt,
  };
};

const ensureIndexes = async () => {
  await collection().createIndex({ customerUserId: 1, createdAt: -1 });
  await collection().createIndex({ customerUserId: 1, startAt: 1 });
  await collection().createIndex({ customerUserId: 1, status: 1, startAt: 1 });
  await collection().createIndex({ businessId: 1, startAt: 1 });
  await collection().createIndex(
    { businessId: 1, resourceId: 1, startAt: 1 },
    { unique: true },
  );
};

const insert = async (doc, { session } = {}) => {
  const now = new Date();
  const { _id, businessId, vendorId, customerUserId, ...rest } = doc;
  const row = {
    ...( _id ? { _id: String(_id) } : {}),
    businessId: toObjectId(businessId),
    vendorId: vendorId ? toObjectId(vendorId) : undefined,
    customerUserId: toObjectId(customerUserId),
    status: 'confirmed',
    ...rest,
    startAt: new Date(doc.startAt),
    endAt: new Date(doc.endAt),
    createdAt: now,
    updatedAt: now,
  };
  const { insertedId } = await collection().insertOne(row, session ? { session } : {});
  return sanitize({ _id: insertedId, ...row });
};

const findByIdForCustomer = async (id, customerUserId) => {
  if (!id) return null;
  const doc = await collection().findOne({
    _id: String(id),
    customerUserId: toObjectId(customerUserId),
    status: 'confirmed',
  });
  return sanitize(doc);
};

const listByCustomer = async (customerUserId) => {
  const rows = await collection()
    .find({ customerUserId: toObjectId(customerUserId), status: 'confirmed' })
    .sort({ startAt: 1 })
    .toArray();
  return rows.map(sanitize);
};

const cancelById = async (id, customerUserId, { session } = {}) => {
  if (!id) return null;
  const result = await collection().findOneAndUpdate(
    {
      _id: String(id),
      customerUserId: toObjectId(customerUserId),
      status: 'confirmed',
    },
    { $set: { status: 'cancelled', updatedAt: new Date() } },
    { returnDocument: 'before', ...(session ? { session } : {}) },
  );
  const doc = result?.value ?? result;
  return sanitize(doc);
};

module.exports = {
  ensureIndexes,
  insert,
  findByIdForCustomer,
  listByCustomer,
  cancelById,
};
