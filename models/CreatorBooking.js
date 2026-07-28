const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');
const { BOOKING_STATUS } = require('../constants/creator');
const { withPrefix, REF_PREFIX } = require('../utils/referenceId');

const collection = () => getDb().collection('creator_bookings');

const toObjectId = (id) => new ObjectId(String(id));

const sanitize = (doc) => {
  if (!doc) return doc;
  return {
    id: String(doc._id),
    refId: doc.refId || null,
    offerId: String(doc.offerId),
    offerTitle: doc.offerTitle ?? '',
    offerKind: doc.offerKind ?? 'collab',
    businessId: String(doc.businessId),
    businessName: doc.businessName ?? '',
    vendorId: String(doc.vendorId),
    brief: doc.brief ?? '',
    customerName: doc.customerName ?? '',
    customerMobile: doc.customerMobile ?? '',
    amount: typeof doc.amount === 'number' ? doc.amount : 0,
    currency: doc.currency || 'INR',
    status: doc.status,
    paymentStatus: doc.paymentStatus || null,
    paymentSessionId: doc.paymentSessionId || null,
    cashfreeOrderId: doc.cashfreeOrderId || null,
    paymentRef: doc.paymentRef || null,
    paymentRefId: doc.paymentRefId || null,
    turnaroundDays: typeof doc.turnaroundDays === 'number' ? doc.turnaroundDays : null,
    expiresAt: doc.expiresAt ? doc.expiresAt.toISOString() : null,
    paidAt: doc.paidAt ? doc.paidAt.toISOString?.() ?? doc.paidAt : null,
    createdAt: doc.createdAt?.toISOString?.() ?? doc.createdAt,
    updatedAt: doc.updatedAt?.toISOString?.() ?? doc.updatedAt,
  };
};

const ensureIndexes = async () => {
  await collection().createIndex({ customerUserId: 1, createdAt: -1 });
  await collection().createIndex({ offerId: 1, createdAt: -1 });
  await collection().createIndex({ vendorId: 1, createdAt: -1 });
  await collection().createIndex({ status: 1, expiresAt: 1 });
  await collection().createIndex(
    { refId: 1 },
    { unique: true, partialFilterExpression: { refId: { $exists: true } } },
  );
};

const buildRow = (doc, extra) => {
  const now = new Date();
  return {
    ...doc,
    _id: String(doc._id),
    refId: doc.refId || withPrefix('CRB'),
    offerId: toObjectId(doc.offerId),
    businessId: toObjectId(doc.businessId),
    vendorId: toObjectId(doc.vendorId),
    customerUserId: toObjectId(doc.customerUserId),
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
};

const insertConfirmed = async (doc, { session } = {}) => {
  const row = buildRow(doc, {
    status: BOOKING_STATUS.CONFIRMED,
    paymentStatus: 'paid',
    paidAt: new Date(),
  });
  await collection().insertOne(row, session ? { session } : {});
  return sanitize(row);
};

const insertPending = async (doc, { session } = {}) => {
  const row = buildRow(doc, {
    status: BOOKING_STATUS.PENDING_PAYMENT,
    paymentStatus: 'pending',
    expiresAt: doc.expiresAt ? new Date(doc.expiresAt) : undefined,
  });
  await collection().insertOne(row, session ? { session } : {});
  return sanitize(row);
};

const findById = async (id) => {
  if (!id) return null;
  const doc = await collection().findOne({ _id: String(id) });
  return doc ? { ...sanitize(doc), _raw: doc } : null;
};

const getForCustomer = async (id, customerUserId) => {
  if (!id) return null;
  const doc = await collection().findOne({
    _id: String(id),
    customerUserId: toObjectId(customerUserId),
  });
  return sanitize(doc);
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

const setPaymentRefId = async (id, paymentRefId, { session } = {}) => {
  if (!id || !paymentRefId) return;
  await collection().updateOne(
    { _id: String(id) },
    { $set: { paymentRefId: String(paymentRefId), updatedAt: new Date() } },
    session ? { session } : {},
  );
};

const markPaid = async (id, { cashfreeOrderId, paymentRef } = {}, { session } = {}) => {
  const res = await collection().findOneAndUpdate(
    { _id: String(id), status: BOOKING_STATUS.PENDING_PAYMENT },
    {
      $set: {
        status: BOOKING_STATUS.CONFIRMED,
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

const markUnpaid = async (id, status, { session } = {}) => {
  const res = await collection().findOneAndUpdate(
    { _id: String(id), status: BOOKING_STATUS.PENDING_PAYMENT },
    {
      $set: {
        status,
        paymentStatus: status === BOOKING_STATUS.EXPIRED ? 'pending' : 'failed',
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after', ...(session ? { session } : {}) },
  );
  const doc = res?.value ?? res;
  return doc ? sanitize(doc) : null;
};

const updateStatusForVendor = async (id, vendorId, status) => {
  const res = await collection().findOneAndUpdate(
    {
      _id: String(id),
      vendorId: toObjectId(vendorId),
      status: { $in: [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.IN_PROGRESS] },
    },
    { $set: { status, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  const doc = res?.value ?? res;
  return doc ? sanitize(doc) : null;
};

const listByCustomer = async (customerUserId) => {
  const rows = await collection()
    .find({
      customerUserId: toObjectId(customerUserId),
      status: {
        $in: [
          BOOKING_STATUS.CONFIRMED,
          BOOKING_STATUS.IN_PROGRESS,
          BOOKING_STATUS.COMPLETED,
          BOOKING_STATUS.PENDING_PAYMENT,
        ],
      },
    })
    .sort({ createdAt: -1 })
    .toArray();
  return rows.map(sanitize);
};

const listByVendor = async (vendorId, { businessId } = {}) => {
  const filter = {
    vendorId: toObjectId(vendorId),
    status: {
      $in: [
        BOOKING_STATUS.CONFIRMED,
        BOOKING_STATUS.IN_PROGRESS,
        BOOKING_STATUS.COMPLETED,
        BOOKING_STATUS.PENDING_PAYMENT,
      ],
    },
  };
  if (businessId && ObjectId.isValid(String(businessId))) {
    filter.businessId = toObjectId(businessId);
  }
  const rows = await collection().find(filter).sort({ createdAt: -1 }).toArray();
  return rows.map(sanitize);
};

const listByOffer = async (offerId, { vendorId } = {}) => {
  const filter = { offerId: toObjectId(offerId) };
  if (vendorId) filter.vendorId = toObjectId(vendorId);
  const rows = await collection().find(filter).sort({ createdAt: -1 }).toArray();
  return rows.map(sanitize);
};

const hasActiveBooking = async (offerId, customerUserId) => {
  const doc = await collection().findOne({
    offerId: toObjectId(offerId),
    customerUserId: toObjectId(customerUserId),
    status: { $in: [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.PENDING_PAYMENT, BOOKING_STATUS.IN_PROGRESS] },
  });
  return !!doc;
};

const listExpiredPending = async () => {
  const rows = await collection()
    .find({
      status: BOOKING_STATUS.PENDING_PAYMENT,
      expiresAt: { $lte: new Date() },
    })
    .toArray();
  return rows.map((doc) => ({ ...sanitize(doc), _raw: doc }));
};

const cancelPendingForCustomer = async (id, customerUserId) => {
  const res = await collection().findOneAndUpdate(
    {
      _id: String(id),
      customerUserId: toObjectId(customerUserId),
      status: BOOKING_STATUS.PENDING_PAYMENT,
    },
    { $set: { status: BOOKING_STATUS.CANCELLED, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  const doc = res?.value ?? res;
  return doc ? { ...sanitize(doc), _raw: doc } : null;
};

const countOpenForBusiness = async (businessId) => {
  if (!ObjectId.isValid(String(businessId))) return 0;
  return collection().countDocuments({
    businessId: toObjectId(businessId),
    status: { $in: [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.IN_PROGRESS, BOOKING_STATUS.PENDING_PAYMENT] },
  });
};

module.exports = {
  sanitize,
  ensureIndexes,
  insertConfirmed,
  insertPending,
  findById,
  getForCustomer,
  attachPaymentSession,
  setPaymentRefId,
  markPaid,
  markUnpaid,
  updateStatusForVendor,
  listByCustomer,
  listByVendor,
  listByOffer,
  hasActiveBooking,
  listExpiredPending,
  cancelPendingForCustomer,
  countOpenForBusiness,
};
