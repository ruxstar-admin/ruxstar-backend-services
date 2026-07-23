const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');
const { withPrefix, REF_PREFIX } = require('../utils/referenceId');

const collection = () => getDb().collection('withdrawals');

// Lifecycle: pending → processing → completed | failed, or pending → rejected.
const STATUS = {
  PENDING: 'pending', // vendor requested, awaiting admin approval
  PROCESSING: 'processing', // approved, transfer initiated at Cashfree
  COMPLETED: 'completed', // transfer succeeded, payments locked
  FAILED: 'failed', // transfer failed, reservation released
  REJECTED: 'rejected', // admin declined, reservation released
};
const ACTIVE_STATUSES = [STATUS.PENDING, STATUS.PROCESSING];

const toObjectId = (id) => {
  try {
    return id && ObjectId.isValid(String(id)) ? new ObjectId(String(id)) : null;
  } catch {
    return null;
  }
};

const iso = (d) => (d ? d.toISOString?.() ?? d : null);

const sanitize = (doc) => {
  if (!doc) return doc;
  const method = doc.payoutMethod || {};
  return {
    id: String(doc._id),
    withdrawalRef: doc.withdrawalRef,
    vendorId: doc.vendorId ? String(doc.vendorId) : null,
    vendorName: doc.vendorName || null,
    amount: typeof doc.amount === 'number' ? doc.amount : 0,
    currency: doc.currency || 'INR',
    count: typeof doc.count === 'number' ? doc.count : 0,
    paymentIds: Array.isArray(doc.paymentIds) ? doc.paymentIds.map(String) : [],
    status: doc.status || STATUS.PENDING,
    payoutMethod: {
      type: method.type || 'bank',
      accountName: method.accountName || null,
      // Mask the account number everywhere it is surfaced.
      accountNumberMasked: method.accountNumber
        ? `••••${String(method.accountNumber).slice(-4)}`
        : null,
      ifsc: method.ifsc || null,
      vpa: method.vpa || null,
    },
    cfTransferId: doc.cfTransferId || null,
    transferStatus: doc.transferStatus || null,
    failureReason: doc.failureReason || null,
    periodStart: iso(doc.periodStart),
    periodEnd: iso(doc.periodEnd),
    note: doc.note || null,
    decidedByAdminId: doc.decidedByAdminId ? String(doc.decidedByAdminId) : null,
    requestedAt: iso(doc.requestedAt),
    decidedAt: iso(doc.decidedAt),
    completedAt: iso(doc.completedAt),
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
};

const ensureIndexes = async () => {
  await collection().createIndex({ withdrawalRef: 1 }, { unique: true });
  await collection().createIndex({ vendorId: 1, createdAt: -1 });
  await collection().createIndex({ status: 1, createdAt: -1 });
};

const create = async ({ vendorId, vendorName, amount, count, paymentIds, payoutMethod, periodStart, periodEnd } = {}) => {
  const now = new Date();
  const row = {
    withdrawalRef: withPrefix(REF_PREFIX.WITHDRAWAL),
    vendorId: toObjectId(vendorId),
    ...(vendorName ? { vendorName: String(vendorName) } : {}),
    amount: Math.round(Number(amount) || 0),
    currency: 'INR',
    count: Number(count) || 0,
    paymentIds: (paymentIds || []).map(String),
    payoutMethod: payoutMethod || {},
    status: STATUS.PENDING,
    periodStart: periodStart ? new Date(periodStart) : null,
    periodEnd: periodEnd ? new Date(periodEnd) : now,
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const { insertedId } = await collection().insertOne(row);
  return sanitize({ _id: insertedId, ...row });
};

const findById = async (id) => {
  const oid = toObjectId(id);
  if (!oid) return null;
  const doc = await collection().findOne({ _id: oid });
  return doc ? sanitize(doc) : null;
};

const findActiveByVendor = async (vendorId) => {
  const oid = toObjectId(vendorId);
  if (!oid) return null;
  const doc = await collection().findOne({ vendorId: oid, status: { $in: ACTIVE_STATUSES } });
  return doc ? sanitize(doc) : null;
};

const listByVendor = async (vendorId) => {
  const oid = toObjectId(vendorId);
  if (!oid) return [];
  const rows = await collection().find({ vendorId: oid }).sort({ createdAt: -1 }).toArray();
  return rows.map(sanitize);
};

const listAll = async ({ status, vendorId, page = 1, limit = 50 } = {}) => {
  const filter = {};
  if (status) filter.status = status;
  if (vendorId && toObjectId(vendorId)) filter.vendorId = toObjectId(vendorId);
  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
  const [rows, total] = await Promise.all([
    collection().find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).toArray(),
    collection().countDocuments(filter),
  ]);
  return { items: rows.map(sanitize), total };
};

// Guarded status transition: only applies when the row is still in `expected`.
const transition = async (id, expected, patch) => {
  const oid = toObjectId(id);
  if (!oid) return null;
  const expectedList = Array.isArray(expected) ? expected : [expected];
  const res = await collection().findOneAndUpdate(
    { _id: oid, status: { $in: expectedList } },
    { $set: { ...patch, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  const doc = res?.value ?? res;
  return doc ? sanitize(doc) : null;
};

module.exports = {
  STATUS,
  ACTIVE_STATUSES,
  sanitize,
  ensureIndexes,
  create,
  findById,
  findActiveByVendor,
  listByVendor,
  listAll,
  transition,
};
