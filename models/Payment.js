const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');
const { withPrefix, REF_PREFIX } = require('../utils/referenceId');

const collection = () => getDb().collection('payments');

const toObjectId = (id) => {
  try {
    return id && ObjectId.isValid(String(id)) ? new ObjectId(String(id)) : null;
  } catch {
    return null;
  }
};

const iso = (d) => (d ? d.toISOString?.() ?? d : null);

// Refunds are only possible within this many days of payment. After that the
// payment "matures" and becomes eligible for the weekly vendor withdrawal.
const REFUND_WINDOW_DAYS = 7;
const refundCutoff = () => new Date(Date.now() - REFUND_WINDOW_DAYS * 86400000);
const withinRefundWindow = (paidAt) =>
  !!paidAt && new Date(paidAt).getTime() >= refundCutoff().getTime();

const sanitize = (doc) => {
  if (!doc) return doc;
  return {
    id: String(doc._id),
    refId: doc.refId,
    source: doc.source,
    sourceId: doc.sourceId ? String(doc.sourceId) : null,
    sourceRef: doc.sourceRef || null,
    vendorId: doc.vendorId ? String(doc.vendorId) : null,
    customerUserId: doc.customerUserId ? String(doc.customerUserId) : null,
    amount: typeof doc.amount === 'number' ? doc.amount : 0,
    currency: doc.currency || 'INR',
    status: doc.status || 'paid',
    cashfreeOrderId: doc.cashfreeOrderId || null,
    gatewayPaymentId: doc.gatewayPaymentId || null,
    refundStatus: doc.refundStatus || null,
    refundAmount: typeof doc.refundAmount === 'number' ? doc.refundAmount : null,
    gatewayRefundId: doc.gatewayRefundId || null,
    refundedAt: iso(doc.refundedAt),
    payoutId: doc.payoutId ? String(doc.payoutId) : null,
    payoutRef: doc.payoutRef || null,
    paidOutAt: iso(doc.paidOutAt),
    // Withdrawal reservation: set while a withdrawal is pending/processing.
    withdrawalId: doc.withdrawalId ? String(doc.withdrawalId) : null,
    withdrawalRef: doc.withdrawalRef || null,
    withdrawalStatus: doc.withdrawalStatus || null,
    paidAt: iso(doc.paidAt),
    // Convenience flags for the vendor ledger UI.
    refundable: doc.status === 'paid' && !doc.payoutId && !doc.withdrawalId && withinRefundWindow(doc.paidAt),
    matured: doc.status === 'paid' && !doc.payoutId && !doc.withdrawalId && !withinRefundWindow(doc.paidAt),
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
};

// A payment can be refunded to the customer only while it is still 'paid', has
// NOT been reserved/settled for a vendor withdrawal, and is inside the 7-day
// refund window (after which the money matures toward the vendor payout).
const isRefundableDoc = (doc) =>
  !!doc && doc.status === 'paid' && !doc.payoutId && !doc.withdrawalId && withinRefundWindow(doc.paidAt);

const ensureIndexes = async () => {
  await collection().createIndex({ refId: 1 }, { unique: true });
  await collection().createIndex({ source: 1, sourceId: 1 }, { unique: true });
  await collection().createIndex({ vendorId: 1, paidAt: -1 });
  await collection().createIndex({ customerUserId: 1, paidAt: -1 });
  await collection().createIndex({ withdrawalId: 1 });
};

// Idempotently record a successful payment. Keyed by (source, sourceId) so
// duplicate webhooks / reconciliation runs update the same ledger row and keep
// its original refId. Returns the sanitized payment (incl. its refId).
const record = async ({
  source,
  sourceId,
  sourceRef,
  vendorId,
  customerUserId,
  amount,
  currency = 'INR',
  cashfreeOrderId,
  gatewayPaymentId,
} = {}) => {
  if (!source || !sourceId) return null;
  const now = new Date();
  const res = await collection().findOneAndUpdate(
    { source: String(source), sourceId: String(sourceId) },
    {
      $setOnInsert: {
        refId: withPrefix(REF_PREFIX.PAYMENT),
        source: String(source),
        sourceId: String(sourceId),
        createdAt: now,
        paidAt: now,
      },
      $set: {
        ...(sourceRef ? { sourceRef: String(sourceRef) } : {}),
        ...(toObjectId(vendorId) ? { vendorId: toObjectId(vendorId) } : {}),
        ...(toObjectId(customerUserId) ? { customerUserId: toObjectId(customerUserId) } : {}),
        amount: Math.round(Number(amount) || 0),
        currency: currency || 'INR',
        status: 'paid',
        ...(cashfreeOrderId ? { cashfreeOrderId: String(cashfreeOrderId) } : {}),
        ...(gatewayPaymentId ? { gatewayPaymentId: String(gatewayPaymentId) } : {}),
        updatedAt: now,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );
  const doc = res?.value ?? res;
  return doc ? sanitize(doc) : null;
};

const findBySource = async (source, sourceId) => {
  if (!source || !sourceId) return null;
  const doc = await collection().findOne({ source: String(source), sourceId: String(sourceId) });
  return doc ? sanitize(doc) : null;
};

const findByRefId = async (refId) => {
  if (!refId) return null;
  const doc = await collection().findOne({ refId: String(refId) });
  return doc ? sanitize(doc) : null;
};

// Mark a ledger row refunded. Idempotent-ish: only flips a currently 'paid',
// not-yet-paid-out row. Returns the sanitized row, or null when not refundable.
const markRefunded = async ({ source, sourceId, refundAmount, gatewayRefundId } = {}) => {
  if (!source || !sourceId) return null;
  const now = new Date();
  const res = await collection().findOneAndUpdate(
    {
      source: String(source),
      sourceId: String(sourceId),
      status: 'paid',
      payoutId: { $in: [null, undefined] },
      withdrawalId: { $in: [null, undefined] },
      paidAt: { $gte: refundCutoff() },
    },
    {
      $set: {
        status: 'refunded',
        refundStatus: 'refunded',
        refundAmount: refundAmount != null ? Math.round(Number(refundAmount) || 0) : null,
        ...(gatewayRefundId ? { gatewayRefundId: String(gatewayRefundId) } : {}),
        refundedAt: now,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  );
  const doc = res?.value ?? res;
  return doc ? sanitize(doc) : null;
};

// Refundable 'paid' rows for a vendor (optionally a single business), up to a
// cutoff date. Used to preview / build a weekly payout batch.
const listRefundablePayments = async ({ vendorId, businessId, until } = {}) => {
  const oid = toObjectId(vendorId);
  if (!oid) return [];
  const filter = { vendorId: oid, status: 'paid', payoutId: { $in: [null, undefined] } };
  if (until) filter.paidAt = { $lte: new Date(until) };
  const rows = await collection().find(filter).sort({ paidAt: 1 }).toArray();
  const out = rows.map(sanitize);
  // businessId lives on the source entity, not the ledger; caller filters if needed.
  return businessId ? out.filter(() => true) : out;
};

// Matured 'paid' rows for a vendor: past the 7-day refund window and not yet
// reserved for or settled by a withdrawal. This is the "withdrawable" balance.
const listMaturedPayments = async ({ vendorId } = {}) => {
  const oid = toObjectId(vendorId);
  if (!oid) return [];
  const rows = await collection()
    .find({
      vendorId: oid,
      status: 'paid',
      payoutId: { $in: [null, undefined] },
      withdrawalId: { $in: [null, undefined] },
      paidAt: { $lte: refundCutoff() },
    })
    .sort({ paidAt: 1 })
    .toArray();
  return rows.map(sanitize);
};

// Reserve a set of matured rows for a pending withdrawal. Only touches rows
// that are still unreserved & unlocked. Returns the count actually reserved.
const reserveForWithdrawal = async ({ paymentIds, withdrawalId, withdrawalRef } = {}) => {
  const ids = (paymentIds || []).map(toObjectId).filter(Boolean);
  if (!ids.length || !withdrawalId) return 0;
  const now = new Date();
  const res = await collection().updateMany(
    {
      _id: { $in: ids },
      status: 'paid',
      payoutId: { $in: [null, undefined] },
      withdrawalId: { $in: [null, undefined] },
    },
    {
      $set: {
        withdrawalId: String(withdrawalId),
        ...(withdrawalRef ? { withdrawalRef: String(withdrawalRef) } : {}),
        withdrawalStatus: 'processing',
        updatedAt: now,
      },
    },
  );
  return res?.modifiedCount ?? 0;
};

// Release a rejected/failed withdrawal's reservation so the rows are eligible
// again for a future withdrawal.
const releaseWithdrawal = async (withdrawalId) => {
  if (!withdrawalId) return 0;
  const res = await collection().updateMany(
    { withdrawalId: String(withdrawalId), payoutId: { $in: [null, undefined] } },
    { $unset: { withdrawalId: '', withdrawalRef: '', withdrawalStatus: '' }, $set: { updatedAt: new Date() } },
  );
  return res?.modifiedCount ?? 0;
};

// Settle a completed withdrawal: LOCK the reserved rows permanently by stamping
// the payout ref. Once settled, refunds are no longer possible.
const settleWithdrawal = async ({ withdrawalId, payoutRef } = {}) => {
  if (!withdrawalId) return 0;
  const now = new Date();
  const res = await collection().updateMany(
    { withdrawalId: String(withdrawalId), payoutId: { $in: [null, undefined] } },
    {
      $set: {
        payoutId: String(withdrawalId),
        ...(payoutRef ? { payoutRef: String(payoutRef) } : {}),
        withdrawalStatus: 'paid',
        paidOutAt: now,
        updatedAt: now,
      },
    },
  );
  return res?.modifiedCount ?? 0;
};

// Stamp a completed payout onto a set of ledger rows. This LOCKS them: once
// paid out, refunds are no longer possible.
const attachPayout = async ({ paymentIds, payoutId, payoutRef } = {}) => {
  const ids = (paymentIds || []).map(toObjectId).filter(Boolean);
  if (!ids.length || !payoutId) return 0;
  const now = new Date();
  const res = await collection().updateMany(
    { _id: { $in: ids }, status: 'paid', payoutId: { $in: [null, undefined] } },
    {
      $set: {
        payoutId: String(payoutId),
        ...(payoutRef ? { payoutRef: String(payoutRef) } : {}),
        paidOutAt: now,
        updatedAt: now,
      },
    },
  );
  return res?.modifiedCount ?? 0;
};

const listByVendor = async (vendorId) => {
  const oid = toObjectId(vendorId);
  if (!oid) return [];
  const rows = await collection().find({ vendorId: oid }).sort({ paidAt: -1 }).toArray();
  return rows.map(sanitize);
};

const listByCustomer = async (customerUserId) => {
  const oid = toObjectId(customerUserId);
  if (!oid) return [];
  const rows = await collection().find({ customerUserId: oid }).sort({ paidAt: -1 }).toArray();
  return rows.map(sanitize);
};

// ── Admin ──

const listAllAdmin = async ({ source, vendorId, search, page = 1, limit = 20 } = {}) => {
  const filter = {};
  if (source) filter.source = source;
  if (vendorId && toObjectId(vendorId)) filter.vendorId = toObjectId(vendorId);
  if (search) {
    const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ refId: rx }, { sourceRef: rx }, { cashfreeOrderId: rx }, { gatewayPaymentId: rx }];
  }
  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
  const [rows, total] = await Promise.all([
    collection().find(filter).sort({ paidAt: -1 }).skip(skip).limit(Number(limit)).toArray(),
    collection().countDocuments(filter),
  ]);
  return { items: rows.map(sanitize), total };
};

// Grand totals across the whole ledger.
const revenueTotals = async () => {
  const rows = await collection()
    .aggregate([
      { $match: { status: 'paid' } },
      { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
    ])
    .toArray();
  return rows[0] ? { amount: rows[0].amount, count: rows[0].count } : { amount: 0, count: 0 };
};

// Revenue grouped by source (booking / event / print).
const revenueBySource = async () => {
  const rows = await collection()
    .aggregate([
      { $match: { status: 'paid' } },
      { $group: { _id: '$source', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { amount: -1 } },
    ])
    .toArray();
  return rows.map((r) => ({ source: r._id || 'unknown', amount: r.amount, count: r.count }));
};

// Top vendors by revenue. Returns raw vendorId strings — caller can hydrate names.
const revenueByVendor = async ({ limit = 20 } = {}) => {
  const rows = await collection()
    .aggregate([
      { $match: { status: 'paid', vendorId: { $ne: null } } },
      { $group: { _id: '$vendorId', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { amount: -1 } },
      { $limit: Number(limit) },
    ])
    .toArray();
  return rows.map((r) => ({ vendorId: r._id ? String(r._id) : null, amount: r.amount, count: r.count }));
};

// Daily revenue for the last N days (IST-naive, uses paidAt UTC date).
const revenueTimeSeries = async ({ days = 30 } = {}) => {
  const since = new Date(Date.now() - Number(days) * 86400000);
  const rows = await collection()
    .aggregate([
      { $match: { status: 'paid', paidAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$paidAt' } },
          amount: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  return rows.map((r) => ({ date: r._id, amount: r.amount, count: r.count }));
};

module.exports = {
  sanitize,
  ensureIndexes,
  record,
  findBySource,
  findByRefId,
  markRefunded,
  listRefundablePayments,
  listMaturedPayments,
  reserveForWithdrawal,
  releaseWithdrawal,
  settleWithdrawal,
  attachPayout,
  REFUND_WINDOW_DAYS,
  withinRefundWindow,
  isRefundableDoc,
  listByVendor,
  listByCustomer,
  listAllAdmin,
  revenueTotals,
  revenueBySource,
  revenueByVendor,
  revenueTimeSeries,
};
