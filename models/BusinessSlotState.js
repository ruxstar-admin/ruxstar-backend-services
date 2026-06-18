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

const listInRange = async (businessId, from, to, resourceId) => {
  const start = new Date(from);
  const end = new Date(to);
  const filter = {
    businessId: toObjectId(businessId),
    startAt: { $gte: start, $lt: end },
  };
  if (resourceId) filter.resourceId = String(resourceId);
  const rows = await collection().find(filter).toArray();
  return rows.map((row) => ({
    resourceId: row.resourceId,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    status: row.status,
    booking: row.booking,
    pricePerSlot: typeof row.pricePerSlot === 'number' ? row.pricePerSlot : undefined,
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
    pricePerSlot: typeof doc.pricePerSlot === 'number' ? doc.pricePerSlot : undefined,
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

const insertBooked = async (businessId, { resourceId, startAt, endAt, booking }, { session } = {}) => {
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
    await collection().insertOne(doc, session ? { session } : {});
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
};

const removeBooked = async (businessId, resourceId, startAt, { session } = {}) => {
  const { deletedCount } = await collection().deleteOne(
    {
      businessId: toObjectId(businessId),
      resourceId: String(resourceId),
      startAt: new Date(startAt),
      status: 'booked',
    },
    session ? { session } : {},
  );
  return deletedCount > 0;
};

const upsertPriceOverride = async (businessId, { resourceId, startAt, endAt, pricePerSlot }) => {
  const price = Math.round(Number(pricePerSlot));
  if (!Number.isFinite(price) || price < 0) {
    throw Object.assign(new Error('price must be zero or greater'), { status: 400 });
  }

  const filter = {
    businessId: toObjectId(businessId),
    resourceId: String(resourceId),
    startAt: new Date(startAt),
  };
  const existing = await collection().findOne(filter);
  if (existing?.status === 'booked') {
    throw Object.assign(new Error('cannot change price on a booked slot'), { status: 409 });
  }
  if (existing?.status === 'blocked') {
    throw Object.assign(new Error('unblock the slot before setting a demand price'), { status: 400 });
  }

  const now = new Date();
  await collection().updateOne(
    filter,
    {
      $set: {
        endAt: new Date(endAt),
        pricePerSlot: price,
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

const clearPriceOverride = async (businessId, resourceId, startAt) => {
  const filter = {
    businessId: toObjectId(businessId),
    resourceId: String(resourceId),
    startAt: new Date(startAt),
  };
  const existing = await collection().findOne(filter);
  if (!existing || existing.pricePerSlot == null) return false;
  if (existing.status === 'booked') {
    throw Object.assign(new Error('cannot change price on a booked slot'), { status: 409 });
  }
  if (existing.status === 'blocked') {
    await collection().updateOne(filter, { $unset: { pricePerSlot: '' }, $set: { updatedAt: new Date() } });
    return true;
  }
  const { deletedCount } = await collection().deleteOne(filter);
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
  upsertPriceOverride,
  clearPriceOverride,
};
