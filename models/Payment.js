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
    paidAt: iso(doc.paidAt),
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
};

const ensureIndexes = async () => {
  await collection().createIndex({ refId: 1 }, { unique: true });
  await collection().createIndex({ source: 1, sourceId: 1 }, { unique: true });
  await collection().createIndex({ vendorId: 1, paidAt: -1 });
  await collection().createIndex({ customerUserId: 1, paidAt: -1 });
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

module.exports = { sanitize, ensureIndexes, record, listByVendor, listByCustomer };
