const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');
const { withPrefix, REF_PREFIX } = require('../utils/referenceId');

const collection = () => getDb().collection('payouts');

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
  return {
    id: String(doc._id),
    payoutRef: doc.payoutRef,
    vendorId: doc.vendorId ? String(doc.vendorId) : null,
    vendorName: doc.vendorName || null,
    amount: typeof doc.amount === 'number' ? doc.amount : 0,
    currency: doc.currency || 'INR',
    count: typeof doc.count === 'number' ? doc.count : 0,
    paymentIds: Array.isArray(doc.paymentIds) ? doc.paymentIds.map(String) : [],
    periodStart: iso(doc.periodStart),
    periodEnd: iso(doc.periodEnd),
    status: doc.status || 'completed',
    note: doc.note || null,
    createdByAdminId: doc.createdByAdminId ? String(doc.createdByAdminId) : null,
    createdAt: iso(doc.createdAt),
  };
};

const ensureIndexes = async () => {
  await collection().createIndex({ payoutRef: 1 }, { unique: true });
  await collection().createIndex({ vendorId: 1, createdAt: -1 });
};

const create = async ({
  vendorId,
  vendorName,
  amount,
  count,
  paymentIds,
  periodStart,
  periodEnd,
  note,
  createdByAdminId,
} = {}) => {
  const now = new Date();
  const row = {
    payoutRef: withPrefix(REF_PREFIX.PAYOUT),
    vendorId: toObjectId(vendorId),
    ...(vendorName ? { vendorName: String(vendorName) } : {}),
    amount: Math.round(Number(amount) || 0),
    currency: 'INR',
    count: Number(count) || 0,
    paymentIds: (paymentIds || []).map(String),
    periodStart: periodStart ? new Date(periodStart) : null,
    periodEnd: periodEnd ? new Date(periodEnd) : now,
    status: 'completed',
    ...(note ? { note: String(note) } : {}),
    ...(toObjectId(createdByAdminId) ? { createdByAdminId: toObjectId(createdByAdminId) } : {}),
    createdAt: now,
  };
  const { insertedId } = await collection().insertOne(row);
  return sanitize({ _id: insertedId, ...row });
};

const listAll = async ({ vendorId, page = 1, limit = 50 } = {}) => {
  const filter = {};
  if (vendorId && toObjectId(vendorId)) filter.vendorId = toObjectId(vendorId);
  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
  const [rows, total] = await Promise.all([
    collection().find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).toArray(),
    collection().countDocuments(filter),
  ]);
  return { items: rows.map(sanitize), total };
};

const listByVendor = async (vendorId) => {
  const oid = toObjectId(vendorId);
  if (!oid) return [];
  const rows = await collection().find({ vendorId: oid }).sort({ createdAt: -1 }).toArray();
  return rows.map(sanitize);
};

module.exports = { sanitize, ensureIndexes, create, listAll, listByVendor };
