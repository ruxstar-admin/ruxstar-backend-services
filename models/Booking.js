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
    amount: typeof doc.amount === 'number' ? doc.amount : doc.pricePerSlot,
    currency: doc.currency || 'INR',
    customerName: doc.customerName,
    customerMobile: doc.customerMobile,
    status: doc.status,
    paymentStatus: doc.paymentStatus || null,
    paymentSessionId: doc.paymentSessionId || null,
    cashfreeOrderId: doc.cashfreeOrderId || null,
    expiresAt: doc.expiresAt ? doc.expiresAt.toISOString() : null,
    paidAt: doc.paidAt ? doc.paidAt.toISOString?.() ?? doc.paidAt : null,
    createdAt: doc.createdAt?.toISOString?.() ?? doc.createdAt,
  };
};

const SLOT_UNIQUE_INDEX = 'businessId_1_resourceId_1_startAt_1';

const ensureIndexes = async () => {
  await collection().createIndex({ customerUserId: 1, createdAt: -1 });
  await collection().createIndex({ customerUserId: 1, startAt: 1 });
  await collection().createIndex({ customerUserId: 1, status: 1, startAt: 1 });
  await collection().createIndex({ businessId: 1, startAt: 1 });
  await collection().createIndex({ status: 1, expiresAt: 1 });
  // Vendor order views will query by vendor + slot time.
  await collection().createIndex({ vendorId: 1, startAt: 1 });

  // Enforce "at most one CONFIRMED booking per slot". A plain unique index would
  // also count expired/failed/cancelled pending rows and permanently block the
  // slot from being re-booked, so we use a partial index on confirmed only.
  try {
    const existing = await collection().indexes();
    const found = existing.find((i) => i.name === SLOT_UNIQUE_INDEX);
    if (found && !found.partialFilterExpression) {
      await collection().dropIndex(SLOT_UNIQUE_INDEX);
    }
  } catch {
    // index may not exist yet — ignore
  }
  await collection().createIndex(
    { businessId: 1, resourceId: 1, startAt: 1 },
    { unique: true, partialFilterExpression: { status: 'confirmed' }, name: SLOT_UNIQUE_INDEX },
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

// Insert a booking awaiting payment (status pending_payment). The slot is held
// separately in business_slot_states; `expiresAt` matches that hold's window.
const insertPending = async (doc, { session } = {}) => {
  const now = new Date();
  const { _id, businessId, vendorId, customerUserId, ...rest } = doc;
  const row = {
    ...( _id ? { _id: String(_id) } : {}),
    businessId: toObjectId(businessId),
    vendorId: vendorId ? toObjectId(vendorId) : undefined,
    customerUserId: toObjectId(customerUserId),
    status: 'pending_payment',
    paymentStatus: 'pending',
    ...rest,
    startAt: new Date(doc.startAt),
    endAt: new Date(doc.endAt),
    expiresAt: doc.expiresAt ? new Date(doc.expiresAt) : undefined,
    createdAt: now,
    updatedAt: now,
  };
  await collection().insertOne(row, session ? { session } : {});
  return sanitize(row);
};

const findById = async (id) => {
  if (!id) return null;
  const doc = await collection().findOne({ _id: String(id) });
  return doc ? { ...sanitize(doc), _raw: doc } : null;
};

const attachPaymentSession = async (id, { paymentSessionId, cashfreeOrderId } = {}) => {
  await collection().updateOne(
    { _id: String(id) },
    {
      $set: {
        ...(paymentSessionId ? { paymentSessionId } : {}),
        ...(cashfreeOrderId ? { cashfreeOrderId } : {}),
        updatedAt: new Date(),
      },
    },
  );
};

// Mark a pending booking paid+confirmed. Idempotent: only transitions a row
// that is still pending_payment, so duplicate webhooks are no-ops.
const markPaid = async (id, { cashfreeOrderId, paymentRef } = {}, { session } = {}) => {
  const res = await collection().findOneAndUpdate(
    { _id: String(id), status: 'pending_payment' },
    {
      $set: {
        status: 'confirmed',
        paymentStatus: 'paid',
        paidAt: new Date(),
        updatedAt: new Date(),
        ...(cashfreeOrderId ? { cashfreeOrderId } : {}),
        ...(paymentRef ? { paymentRef } : {}),
      },
    },
    { returnDocument: 'after', ...(session ? { session } : {}) },
  );
  const doc = res?.value ?? res;
  return doc ? sanitize(doc) : null;
};

// Move a pending booking to a terminal failed/expired state.
const markUnpaid = async (id, status, { session } = {}) => {
  const res = await collection().findOneAndUpdate(
    { _id: String(id), status: 'pending_payment' },
    {
      $set: {
        status,
        paymentStatus: status === 'expired' ? 'pending' : 'failed',
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after', ...(session ? { session } : {}) },
  );
  const doc = res?.value ?? res;
  return doc ? sanitize(doc) : null;
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

// Any-status lookup scoped to the owner — used for post-checkout status polling.
const getForCustomer = async (id, customerUserId) => {
  if (!id) return null;
  const doc = await collection().findOne({
    _id: String(id),
    customerUserId: toObjectId(customerUserId),
  });
  return sanitize(doc);
};

const listByCustomer = async (customerUserId) => {
  const rows = await collection()
    .find({
      customerUserId: toObjectId(customerUserId),
      status: { $in: ['confirmed', 'pending_payment'] },
    })
    .sort({ startAt: 1 })
    .toArray();
  return rows.map(sanitize);
};

// All bookings across a vendor's businesses. Vendors only see slots that were
// actually paid for (confirmed) or later cancelled — never pending holds.
const listByVendor = async (vendorId, { businessId } = {}) => {
  const query = {
    vendorId: toObjectId(vendorId),
    status: { $in: ['confirmed', 'cancelled'] },
  };
  if (businessId) query.businessId = toObjectId(businessId);
  const rows = await collection().find(query).sort({ startAt: -1 }).toArray();
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
  insertPending,
  findById,
  attachPaymentSession,
  findByIdForCustomer,
  getForCustomer,
  listByCustomer,
  listByVendor,
  markPaid,
  markUnpaid,
  cancelById,
};
