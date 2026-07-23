const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');
const { REGISTRATION_STATUS } = require('../constants/events');
const { withPrefix, REF_PREFIX } = require('../utils/referenceId');

const collection = () => getDb().collection('event_registrations');

const toObjectId = (id) => new ObjectId(String(id));

const sanitize = (doc) => {
  if (!doc) return doc;
  return {
    id: String(doc._id),
    refId: doc.refId || null,
    eventId: String(doc.eventId),
    eventTitle: doc.eventTitle ?? '',
    businessId: String(doc.businessId),
    businessName: doc.businessName ?? '',
    kind: doc.kind,
    format: doc.format ?? 'individual',
    teamName: doc.teamName ?? null,
    participants: Array.isArray(doc.participants) ? doc.participants : [],
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
    refundStatus: doc.refundStatus || null,
    refundedAt: doc.refundedAt ? doc.refundedAt.toISOString?.() ?? doc.refundedAt : null,
    startAt: doc.startAt ? doc.startAt.toISOString() : null,
    venue: doc.venue ?? '',
    expiresAt: doc.expiresAt ? doc.expiresAt.toISOString() : null,
    paidAt: doc.paidAt ? doc.paidAt.toISOString?.() ?? doc.paidAt : null,
    createdAt: doc.createdAt?.toISOString?.() ?? doc.createdAt,
  };
};

const ensureIndexes = async () => {
  await collection().createIndex({ customerUserId: 1, createdAt: -1 });
  await collection().createIndex({ eventId: 1, createdAt: -1 });
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
    refId: doc.refId || withPrefix(REF_PREFIX.REGISTRATION),
    eventId: toObjectId(doc.eventId),
    businessId: toObjectId(doc.businessId),
    vendorId: toObjectId(doc.vendorId),
    customerUserId: toObjectId(doc.customerUserId),
    eventTitle: doc.eventTitle ?? '',
    businessName: doc.businessName ?? '',
    startAt: doc.startAt ? new Date(doc.startAt) : null,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
};

// Insert a free registration as immediately confirmed (no payment).
const insertConfirmed = async (doc, { session } = {}) => {
  const row = buildRow(doc, {
    status: REGISTRATION_STATUS.CONFIRMED,
    paymentStatus: 'paid',
    paidAt: new Date(),
  });
  await collection().insertOne(row, session ? { session } : {});
  return sanitize(row);
};

// Insert a registration awaiting payment.
const insertPending = async (doc, { session } = {}) => {
  const row = buildRow(doc, {
    status: REGISTRATION_STATUS.PENDING_PAYMENT,
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

const setPaymentRefId = async (id, paymentRefId, { session } = {}) => {
  if (!id || !paymentRefId) return;
  await collection().updateOne(
    { _id: String(id) },
    { $set: { paymentRefId: String(paymentRefId), updatedAt: new Date() } },
    session ? { session } : {},
  );
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

const markPaid = async (id, { cashfreeOrderId, paymentRef } = {}, { session } = {}) => {
  const res = await collection().findOneAndUpdate(
    { _id: String(id), status: REGISTRATION_STATUS.PENDING_PAYMENT },
    {
      $set: {
        status: REGISTRATION_STATUS.CONFIRMED,
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
    { _id: String(id), status: REGISTRATION_STATUS.PENDING_PAYMENT },
    {
      $set: {
        status,
        paymentStatus: status === REGISTRATION_STATUS.EXPIRED ? 'pending' : 'failed',
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after', ...(session ? { session } : {}) },
  );
  const doc = res?.value ?? res;
  return doc ? sanitize(doc) : null;
};

const listByCustomer = async (customerUserId) => {
  const rows = await collection()
    .find({
      customerUserId: toObjectId(customerUserId),
      status: { $in: [REGISTRATION_STATUS.CONFIRMED, REGISTRATION_STATUS.PENDING_PAYMENT] },
    })
    .sort({ startAt: 1, createdAt: -1 })
    .toArray();
  return rows.map(sanitize);
};

// Vendor view: all active and historical registrants for one event.
const listByEvent = async (eventId, { vendorId } = {}) => {
  const filter = {
    eventId: toObjectId(eventId),
    status: {
      $in: [
        REGISTRATION_STATUS.CONFIRMED,
        REGISTRATION_STATUS.PENDING_PAYMENT,
        REGISTRATION_STATUS.CANCELLED,
      ],
    },
  };
  if (vendorId) filter.vendorId = toObjectId(vendorId);
  const rows = await collection().find(filter).sort({ createdAt: -1 }).toArray();
  return rows.map(sanitize);
};

const hasActiveRegistration = async (eventId, customerUserId) => {
  const doc = await collection().findOne({
    eventId: toObjectId(eventId),
    customerUserId: toObjectId(customerUserId),
    status: { $in: [REGISTRATION_STATUS.CONFIRMED, REGISTRATION_STATUS.PENDING_PAYMENT] },
  });
  return Boolean(doc);
};

const listExpiredPending = async () => {
  const rows = await collection()
    .find({
      status: REGISTRATION_STATUS.PENDING_PAYMENT,
      expiresAt: { $lte: new Date() },
    })
    .limit(100)
    .toArray();
  return rows.map((r) => ({ ...sanitize(r), _raw: r }));
};

// ── Admin ──

const listAllAdmin = async ({ status, eventId, vendorId, search, page = 1, limit = 20 } = {}) => {
  const filter = {};
  if (status) filter.status = status;
  if (eventId && ObjectId.isValid(String(eventId))) filter.eventId = toObjectId(eventId);
  if (vendorId && ObjectId.isValid(String(vendorId))) filter.vendorId = toObjectId(vendorId);
  if (search) {
    const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { refId: rx },
      { eventTitle: rx },
      { teamName: rx },
      { customerName: rx },
      { customerMobile: rx },
    ];
  }
  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
  const [rows, total] = await Promise.all([
    collection().find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).toArray(),
    collection().countDocuments(filter),
  ]);
  return { items: rows.map(sanitize), total };
};

const markRefunded = async (id) => {
  if (!id) return null;
  const res = await collection().findOneAndUpdate(
    { _id: String(id) },
    {
      $set: {
        paymentStatus: 'refunded',
        refundStatus: 'refunded',
        refundedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
  const doc = res?.value ?? res;
  return doc ? sanitize(doc) : null;
};

module.exports = {
  sanitize,
  ensureIndexes,
  listAllAdmin,
  insertConfirmed,
  insertPending,
  findById,
  getForCustomer,
  setPaymentRefId,
  attachPaymentSession,
  markPaid,
  markUnpaid,
  markRefunded,
  listByCustomer,
  listByEvent,
  hasActiveRegistration,
  listExpiredPending,
};
