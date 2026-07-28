const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');
const { COMMERCE_ORDER_STATUS } = require('../constants/commerce');

const collection = () => getDb().collection('commerce_orders');

const toObjectId = (id) => new ObjectId(String(id));

const iso = (d) => (d ? d.toISOString?.() ?? d : null);

const sanitize = (doc) => {
  if (!doc) return doc;
  return {
    id: String(doc._id),
    customerUserId: doc.customerUserId ? String(doc.customerUserId) : undefined,
    customerName: doc.customerName || '',
    customerMobile: doc.customerMobile || '',
    vendorId: doc.vendorId ? String(doc.vendorId) : null,
    businessId: doc.businessId ? String(doc.businessId) : null,
    businessName: doc.businessName || '',
    vendorName: doc.vendorName || '',
    vendorMobile: doc.vendorMobile || null,
    items: Array.isArray(doc.items)
      ? doc.items.map((i) => ({
          productId: String(i.productId),
          name: i.name || '',
          price: typeof i.price === 'number' ? i.price : 0,
          quantity: typeof i.quantity === 'number' ? i.quantity : 0,
          coverUrl: i.coverUrl || null,
        }))
      : [],
    notes: doc.notes || '',
    amount: typeof doc.amount === 'number' ? doc.amount : 0,
    currency: doc.currency || 'INR',
    status: doc.status,
    paymentStatus: doc.paymentStatus || null,
    paymentRef: doc.paymentRef || null,
    paymentRefId: doc.paymentRefId || null,
    paymentSessionId: doc.paymentSessionId || null,
    cashfreeOrderId: doc.cashfreeOrderId || null,
    refundStatus: doc.refundStatus || null,
    refundedAt: iso(doc.refundedAt),
    paidAt: iso(doc.paidAt),
    expiresAt: iso(doc.expiresAt),
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
};

const ensureIndexes = async () => {
  await collection().createIndex({ customerUserId: 1, createdAt: -1 });
  await collection().createIndex({ vendorId: 1, createdAt: -1 });
  await collection().createIndex({ businessId: 1, createdAt: -1 });
  await collection().createIndex({ status: 1, expiresAt: 1 });
};

const insert = async (doc) => {
  const now = new Date();
  const row = {
    _id: doc._id ? String(doc._id) : undefined,
    customerUserId: toObjectId(doc.customerUserId),
    customerName: doc.customerName || '',
    customerMobile: doc.customerMobile || '',
    vendorId: toObjectId(doc.vendorId),
    businessId: toObjectId(doc.businessId),
    businessName: doc.businessName || '',
    vendorName: doc.vendorName || '',
    vendorMobile: doc.vendorMobile || null,
    items: doc.items || [],
    notes: doc.notes || '',
    amount: doc.amount,
    currency: 'INR',
    status: doc.status || COMMERCE_ORDER_STATUS.PENDING_PAYMENT,
    paymentStatus: doc.paymentStatus || null,
    createdAt: now,
    updatedAt: now,
  };
  if (!row._id) delete row._id;
  await collection().insertOne(row);
  return sanitize(row);
};

const findById = async (id) => {
  const doc = await collection().findOne({ _id: String(id) });
  return sanitize(doc);
};

const getForCustomer = async (id, customerUserId) => {
  const doc = await collection().findOne({
    _id: String(id),
    customerUserId: toObjectId(customerUserId),
  });
  return sanitize(doc);
};

const getForVendor = async (id, vendorId) => {
  const doc = await collection().findOne({
    _id: String(id),
    vendorId: toObjectId(vendorId),
  });
  return sanitize(doc);
};

const listByCustomer = async (customerUserId) => {
  const rows = await collection()
    .find({ customerUserId: toObjectId(customerUserId) })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
  return rows.map(sanitize);
};

const listByVendor = async (vendorId) => {
  const rows = await collection()
    .find({
      vendorId: toObjectId(vendorId),
      status: {
        $in: [
          COMMERCE_ORDER_STATUS.CONFIRMED,
          COMMERCE_ORDER_STATUS.PREPARING,
          COMMERCE_ORDER_STATUS.READY,
          COMMERCE_ORDER_STATUS.COMPLETED,
        ],
      },
    })
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray();
  return rows.map(sanitize);
};

const countOpenForBusiness = async (businessId) =>
  collection().countDocuments({
    businessId: toObjectId(businessId),
    status: {
      $in: [
        COMMERCE_ORDER_STATUS.PENDING_PAYMENT,
        COMMERCE_ORDER_STATUS.CONFIRMED,
        COMMERCE_ORDER_STATUS.PREPARING,
        COMMERCE_ORDER_STATUS.READY,
      ],
    },
  });

const attachPaymentSession = async (id, { paymentSessionId, cashfreeOrderId }) => {
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  const result = await collection().findOneAndUpdate(
    {
      _id: String(id),
      status: {
        $in: [COMMERCE_ORDER_STATUS.PENDING_PAYMENT, COMMERCE_ORDER_STATUS.CONFIRMED],
      },
    },
    {
      $set: {
        status: COMMERCE_ORDER_STATUS.PENDING_PAYMENT,
        paymentSessionId,
        cashfreeOrderId,
        expiresAt,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
  return sanitize(result?.value ?? result);
};

const markPaid = async (id, { cashfreeOrderId, paymentRef } = {}) => {
  const result = await collection().findOneAndUpdate(
    {
      _id: String(id),
      status: {
        $in: [COMMERCE_ORDER_STATUS.PENDING_PAYMENT],
      },
      paymentStatus: { $ne: 'paid' },
    },
    {
      $set: {
        status: COMMERCE_ORDER_STATUS.CONFIRMED,
        paymentStatus: 'paid',
        paidAt: new Date(),
        cashfreeOrderId: cashfreeOrderId || null,
        paymentRef: paymentRef || null,
        updatedAt: new Date(),
      },
      $unset: { expiresAt: '' },
    },
    { returnDocument: 'after' },
  );
  return sanitize(result?.value ?? result);
};

const setPaymentRefId = async (id, paymentRefId) => {
  await collection().updateOne(
    { _id: String(id) },
    { $set: { paymentRefId, updatedAt: new Date() } },
  );
};

const updateStatus = async (id, vendorId, status) => {
  const result = await collection().findOneAndUpdate(
    { _id: String(id), vendorId: toObjectId(vendorId) },
    { $set: { status, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  return sanitize(result?.value ?? result);
};

const cancelForCustomer = async (id, customerUserId) => {
  const result = await collection().findOneAndUpdate(
    {
      _id: String(id),
      customerUserId: toObjectId(customerUserId),
      status: { $in: [COMMERCE_ORDER_STATUS.PENDING_PAYMENT] },
    },
    {
      $set: {
        status: COMMERCE_ORDER_STATUS.CANCELLED,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
  return sanitize(result?.value ?? result);
};

const markRefunded = async (id) => {
  const result = await collection().findOneAndUpdate(
    { _id: String(id) },
    {
      $set: {
        refundStatus: 'refunded',
        refundedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
  return sanitize(result?.value ?? result);
};

module.exports = {
  sanitize,
  ensureIndexes,
  insert,
  findById,
  getForCustomer,
  getForVendor,
  listByCustomer,
  listByVendor,
  countOpenForBusiness,
  attachPaymentSession,
  markPaid,
  setPaymentRefId,
  updateStatus,
  cancelForCustomer,
  markRefunded,
};
