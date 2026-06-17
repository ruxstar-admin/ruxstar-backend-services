const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');

const collection = () => getDb().collection('business_slot_states');

const toObjectId = (id) => new ObjectId(String(id));

const ensureIndexes = async () => {
  await collection().createIndex(
    { businessId: 1, resourceId: 1, startAt: 1 },
    { unique: true },
  );
  await collection().createIndex({ businessId: 1, startAt: 1 });
};

const listInRange = async (businessId, from, to) => {
  const start = new Date(from);
  const end = new Date(to);
  const rows = await collection()
    .find({
      businessId: toObjectId(businessId),
      startAt: { $gte: start, $lt: end },
    })
    .toArray();
  return rows.map((row) => ({
    resourceId: row.resourceId,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    status: row.status,
    booking: row.booking,
  }));
};

const findOne = async (businessId, resourceId, startAt) => {
  const doc = await collection().findOne({
    businessId: toObjectId(businessId),
    resourceId: String(resourceId),
    startAt: new Date(startAt),
  });
  if (!doc) return null;
  return {
    resourceId: doc.resourceId,
    startAt: doc.startAt.toISOString(),
    endAt: doc.endAt.toISOString(),
    status: doc.status,
    booking: doc.booking,
  };
};

const upsertBlocked = async (businessId, { resourceId, startAt, endAt }) => {
  const filter = {
    businessId: toObjectId(businessId),
    resourceId: String(resourceId),
    startAt: new Date(startAt),
  };
  const now = new Date();
  await collection().updateOne(
    filter,
    {
      $set: {
        endAt: new Date(endAt),
        status: 'blocked',
        updatedAt: now,
      },
      $setOnInsert: {
        businessId: toObjectId(businessId),
        resourceId: String(resourceId),
        startAt: new Date(startAt),
        createdAt: now,
      },
    },
    { upsert: true },
  );
};

const removeBlocked = async (businessId, resourceId, startAt) => {
  const { deletedCount } = await collection().deleteOne({
    businessId: toObjectId(businessId),
    resourceId: String(resourceId),
    startAt: new Date(startAt),
    status: 'blocked',
  });
  return deletedCount > 0;
};

const insertBooked = async (businessId, { resourceId, startAt, endAt, booking }) => {
  const doc = {
    businessId: toObjectId(businessId),
    resourceId: String(resourceId),
    startAt: new Date(startAt),
    endAt: new Date(endAt),
    status: 'booked',
    booking,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  try {
    await collection().insertOne(doc);
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
};

const removeBooked = async (businessId, resourceId, startAt) => {
  const { deletedCount } = await collection().deleteOne({
    businessId: toObjectId(businessId),
    resourceId: String(resourceId),
    startAt: new Date(startAt),
    status: 'booked',
  });
  return deletedCount > 0;
};

module.exports = {
  ensureIndexes,
  listInRange,
  findOne,
  upsertBlocked,
  removeBlocked,
  insertBooked,
  removeBooked,
};
