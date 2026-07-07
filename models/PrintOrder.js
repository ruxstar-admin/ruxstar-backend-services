const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');

const collection = () => getDb().collection('print_orders');

const toObjectId = (id) => new ObjectId(String(id));

// Heavy inline design blob — excluded from list reads.
const WITHOUT_DESIGN = { designImage: 0 };

const iso = (d) => (d ? d.toISOString?.() ?? d : null);

const sanitize = (doc, { withDesign = false } = {}) => {
  if (!doc) return doc;
  return {
    id: String(doc._id),
    customerUserId: doc.customerUserId ? String(doc.customerUserId) : undefined,
    customerName: doc.customerName || '',
    customerMobile: doc.customerMobile || '',
    categoryId: doc.categoryId,
    categoryLabel: doc.categoryLabel || '',
    title: doc.title || '',
    attributes: doc.attributes && typeof doc.attributes === 'object' ? doc.attributes : {},
    quantity: typeof doc.quantity === 'number' ? doc.quantity : null,
    notes: doc.notes || '',
    city: doc.city || '',
    pincode: doc.pincode || '',
    hasDesign: Boolean(doc.designImage || doc.designImageUrl),
    designImageUrl: doc.designImageUrl || null,
    ...(withDesign && doc.designImage
      ? { designImage: `data:${doc.designImage.mimeType};base64,${doc.designImage.data}` }
      : {}),
    status: doc.status,
    assignedVendorId: doc.assignedVendorId ? String(doc.assignedVendorId) : null,
    assignedBusinessId: doc.assignedBusinessId ? String(doc.assignedBusinessId) : null,
    vendorName: doc.vendorName || null,
    businessName: doc.businessName || null,
    vendorMobile: doc.vendorMobile || null,
    vendorNote: doc.vendorNote || '',
    quoteAmount: typeof doc.quoteAmount === 'number' ? doc.quoteAmount : null,
    currency: doc.currency || 'INR',
    paymentStatus: doc.paymentStatus || null,
    paymentSessionId: doc.paymentSessionId || null,
    cashfreeOrderId: doc.cashfreeOrderId || null,
    acceptedAt: iso(doc.acceptedAt),
    paidAt: iso(doc.paidAt),
    expiresAt: iso(doc.expiresAt),
    openExpiresAt: iso(doc.openExpiresAt),
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
};

const ensureIndexes = async () => {
  await collection().createIndex({ customerUserId: 1, createdAt: -1 });
  await collection().createIndex({ status: 1, categoryId: 1, createdAt: -1 });
  await collection().createIndex({ assignedVendorId: 1, createdAt: -1 });
  await collection().createIndex({ status: 1, openExpiresAt: 1 });
  await collection().createIndex({ status: 1, expiresAt: 1 });
};

const insert = async (doc) => {
  const now = new Date();
  const { _id, customerUserId, ...rest } = doc;
  const row = {
    ...(_id ? { _id: String(_id) } : {}),
    customerUserId: toObjectId(customerUserId),
    status: 'open',
    currency: 'INR',
    ...rest,
    openExpiresAt: doc.openExpiresAt ? new Date(doc.openExpiresAt) : undefined,
    createdAt: now,
    updatedAt: now,
  };
  await collection().insertOne(row);
  return sanitize(row);
};

const findById = async (id) => {
  if (!id) return null;
  const doc = await collection().findOne({ _id: String(id) });
  return doc ? { ...sanitize(doc), _raw: doc } : null;
};

const getForCustomer = async (id, customerUserId, { withDesign = false } = {}) => {
  if (!id) return null;
  const doc = await collection().findOne({
    _id: String(id),
    customerUserId: toObjectId(customerUserId),
  });
  return doc ? sanitize(doc, { withDesign }) : null;
};

const listByCustomer = async (customerUserId) => {
  const rows = await collection()
    .find({ customerUserId: toObjectId(customerUserId) }, { projection: WITHOUT_DESIGN })
    .sort({ createdAt: -1 })
    .toArray();
  return rows.map((r) => sanitize(r));
};

// Open orders a vendor is eligible to accept — matched by served categories and
// service area (city). serveAll bypasses the city filter.
const listOpenForVendor = async ({ categoryIds = [], cities = [], serveAll = false } = {}) => {
  if (!categoryIds.length) return [];
  const filter = {
    status: 'open',
    categoryId: { $in: categoryIds },
  };
  if (!serveAll && cities.length) {
    filter.$or = [
      { city: { $in: cities } },
      { city: '' },
      { city: { $exists: false } },
    ];
  }
  const rows = await collection()
    .find(filter, { projection: WITHOUT_DESIGN })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
  return rows.map((r) => sanitize(r));
};

const listAssignedForVendor = async (vendorId) => {
  const rows = await collection()
    .find({ assignedVendorId: toObjectId(vendorId) }, { projection: WITHOUT_DESIGN })
    .sort({ updatedAt: -1 })
    .toArray();
  return rows.map((r) => sanitize(r));
};

const findAssignedForVendor = async (id, vendorId, { withDesign = false } = {}) => {
  if (!id) return null;
  const doc = await collection().findOne({
    _id: String(id),
    assignedVendorId: toObjectId(vendorId),
  });
  return doc ? { ...sanitize(doc, { withDesign }), _raw: doc } : null;
};

// Atomic claim: only the first vendor to accept an OPEN order wins.
const accept = async (id, vendor) => {
  const now = new Date();
  const res = await collection().findOneAndUpdate(
    { _id: String(id), status: 'open' },
    {
      $set: {
        status: 'accepted',
        assignedVendorId: toObjectId(vendor.vendorId),
        assignedBusinessId: vendor.businessId ? toObjectId(vendor.businessId) : undefined,
        vendorName: vendor.vendorName || '',
        businessName: vendor.businessName || '',
        vendorMobile: vendor.vendorMobile || '',
        vendorNote: vendor.vendorNote || '',
        quoteAmount: vendor.quoteAmount,
        acceptedAt: now,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  );
  const doc = res?.value ?? res;
  return doc ? sanitize(doc) : null;
};

const updateStatusForVendor = async (id, vendorId, status, extra = {}) => {
  const res = await collection().findOneAndUpdate(
    { _id: String(id), assignedVendorId: toObjectId(vendorId) },
    { $set: { status, ...extra, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  const doc = res?.value ?? res;
  return doc ? sanitize(doc) : null;
};

const attachPaymentSession = async (id, { paymentSessionId, cashfreeOrderId } = {}) => {
  await collection().updateOne(
    { _id: String(id) },
    {
      $set: {
        status: 'pending_payment',
        paymentStatus: 'pending',
        ...(paymentSessionId ? { paymentSessionId } : {}),
        ...(cashfreeOrderId ? { cashfreeOrderId } : {}),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        updatedAt: new Date(),
      },
    },
  );
};

const markPaid = async (id, { cashfreeOrderId, paymentRef } = {}) => {
  const res = await collection().findOneAndUpdate(
    { _id: String(id), status: { $in: ['pending_payment', 'accepted'] } },
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
    { returnDocument: 'after' },
  );
  const doc = res?.value ?? res;
  return doc ? sanitize(doc) : null;
};

const markPaymentFailed = async (id) => {
  await collection().updateOne(
    { _id: String(id), status: 'pending_payment' },
    { $set: { status: 'accepted', paymentStatus: 'failed', updatedAt: new Date() } },
  );
};

const cancelByCustomer = async (id, customerUserId) => {
  const res = await collection().findOneAndUpdate(
    {
      _id: String(id),
      customerUserId: toObjectId(customerUserId),
      status: { $in: ['open', 'accepted'] },
    },
    { $set: { status: 'cancelled', updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  const doc = res?.value ?? res;
  return doc ? sanitize(doc) : null;
};

const expireOpenOrders = async () => {
  const { modifiedCount } = await collection().updateMany(
    { status: 'open', openExpiresAt: { $lte: new Date() } },
    { $set: { status: 'expired', updatedAt: new Date() } },
  );
  return modifiedCount;
};

module.exports = {
  sanitize,
  ensureIndexes,
  insert,
  findById,
  getForCustomer,
  listByCustomer,
  listOpenForVendor,
  listAssignedForVendor,
  findAssignedForVendor,
  accept,
  updateStatusForVendor,
  attachPaymentSession,
  markPaid,
  markPaymentFailed,
  cancelByCustomer,
  expireOpenOrders,
};
