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

const mapRow = (row) => ({
  resourceId: row.resourceId,
  startAt: row.startAt.toISOString(),
  endAt: row.endAt.toISOString(),
  status: row.status,
  booking: row.booking,
  pendingExpiresAt: row.pendingExpiresAt ? row.pendingExpiresAt.toISOString() : undefined,
  pricePerSlot: typeof row.pricePerSlot === 'number' ? row.pricePerSlot : undefined,
});

const listInRange = async (businessId, from, to, resourceId) => {
  const start = new Date(from);
  const end = new Date(to);
  const filter = {
    businessId: toObjectId(businessId),
    startAt: { $gte: start, $lt: end },
  };
  if (resourceId) filter.resourceId = String(resourceId);
  const rows = await collection().find(filter).toArray();
  return rows.map(mapRow);
};

const findOne = async (businessId, resourceId, startAt) => {
  const doc = await collection().findOne({
    businessId: toObjectId(businessId),
    resourceId: String(resourceId),
    startAt: new Date(startAt),
  });
  if (!doc) return null;
  return mapRow(doc);
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

// Find an active (booked or live-pending) reservation for this resource that
// overlaps [startAt, endAt). Used by service-mode bookings where variable
// durations mean two appointments can clash without sharing a start time.
const findOverlap = async (businessId, resourceId, startAt, endAt, { session } = {}) => {
  const now = new Date();
  const doc = await collection().findOne(
    {
      businessId: toObjectId(businessId),
      resourceId: String(resourceId),
      startAt: { $lt: new Date(endAt) },
      endAt: { $gt: new Date(startAt) },
      $or: [
        { status: 'booked' },
        { status: 'pending', pendingExpiresAt: { $gt: now } },
      ],
    },
    session ? { session } : {},
  );
  return doc ? mapRow(doc) : null;
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

// Atomically claim a slot as a short-lived `pending` hold while the customer
// pays. Succeeds only if the slot is free, a price-override-only doc, or an
// already-expired pending hold. Returns true on success, false if taken.
const claimPending = async (
  businessId,
  { resourceId, startAt, endAt, expiresAt, booking },
  { session } = {},
) => {
  const now = new Date();
  const filter = {
    businessId: toObjectId(businessId),
    resourceId: String(resourceId),
    startAt: new Date(startAt),
    $or: [
      { status: { $exists: false } },
      { status: null },
      { status: 'pending', pendingExpiresAt: { $lte: now } },
    ],
  };
  try {
    const res = await collection().findOneAndUpdate(
      filter,
      {
        $set: {
          endAt: new Date(endAt),
          status: 'pending',
          pendingExpiresAt: new Date(expiresAt),
          booking,
          updatedAt: now,
        },
        $setOnInsert: {
          businessId: toObjectId(businessId),
          resourceId: String(resourceId),
          startAt: new Date(startAt),
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: 'after', ...(session ? { session } : {}) },
    );
    return Boolean(res?.value ?? res);
  } catch (err) {
    // Duplicate key => a doc already exists for this slot that the filter
    // didn't match (booked/blocked/active-pending) => slot is taken.
    if (err?.code === 11000) return false;
    throw err;
  }
};

// Promote a pending hold owned by `bookingId` into a permanent booking.
const confirmPending = async (businessId, resourceId, startAt, bookingId, { session } = {}) => {
  const res = await collection().findOneAndUpdate(
    {
      businessId: toObjectId(businessId),
      resourceId: String(resourceId),
      startAt: new Date(startAt),
      status: 'pending',
      'booking.bookingId': String(bookingId),
    },
    {
      $set: { status: 'booked', updatedAt: new Date() },
      $unset: { pendingExpiresAt: '' },
    },
    { returnDocument: 'after', ...(session ? { session } : {}) },
  );
  return Boolean(res?.value ?? res);
};

// Release a pending hold (payment failed / expired / abandoned). If the slot
// carried a price override, keep that and just drop the hold; otherwise delete.
const releasePending = async (businessId, resourceId, startAt, bookingId, { session } = {}) => {
  const filter = {
    businessId: toObjectId(businessId),
    resourceId: String(resourceId),
    startAt: new Date(startAt),
    status: 'pending',
    ...(bookingId ? { 'booking.bookingId': String(bookingId) } : {}),
  };
  const doc = await collection().findOne(filter, session ? { session } : {});
  if (!doc) return false;
  if (typeof doc.pricePerSlot === 'number') {
    await collection().updateOne(
      filter,
      { $unset: { status: '', pendingExpiresAt: '', booking: '' }, $set: { updatedAt: new Date() } },
      session ? { session } : {},
    );
  } else {
    await collection().deleteOne(filter, session ? { session } : {});
  }
  return true;
};

// Find pending holds whose payment window has elapsed (for the sweeper).
const listExpiredPending = async (now = new Date(), limit = 200) =>
  collection()
    .find({ status: 'pending', pendingExpiresAt: { $lte: now } })
    .limit(limit)
    .toArray();

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
  findOverlap,
  upsertBlocked,
  removeBlocked,
  insertBooked,
  removeBooked,
  claimPending,
  confirmPending,
  releasePending,
  listExpiredPending,
  upsertPriceOverride,
  clearPriceOverride,
};
