const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');

const collection = () => getDb().collection('print_orders');

const toObjectId = (id) => new ObjectId(String(id));

// Heavy inline design blob — excluded from list reads.
const WITHOUT_DESIGN = { designImage: 0 };

const iso = (d) => (d ? d.toISOString?.() ?? d : null);

const sanitizeQuote = (q) => ({
  vendorId: q.vendorId ? String(q.vendorId) : '',
  businessName: q.businessName || '',
  vendorName: q.vendorName || '',
  quoteAmount: typeof q.quoteAmount === 'number' ? q.quoteAmount : null,
  vendorNote: q.vendorNote || '',
  createdAt: iso(q.createdAt),
});

// viewer: null (default, no quote data) | { role: 'customer' } | { role: 'vendor', vendorId }
const sanitize = (doc, { withDesign = false, viewer = null } = {}) => {
  if (!doc) return doc;
  const quotes = Array.isArray(doc.quotes) ? doc.quotes : [];
  const extraViewer = {};
  if (viewer?.role === 'customer') {
    extraViewer.quotes = quotes
      .map(sanitizeQuote)
      .sort((a, b) => (a.quoteAmount ?? Infinity) - (b.quoteAmount ?? Infinity));
    extraViewer.quoteCount = quotes.length;
  } else if (viewer?.role === 'vendor') {
    const mine = quotes.find((q) => String(q.vendorId) === String(viewer.vendorId));
    extraViewer.myQuote = mine
      ? {
          quoteAmount: typeof mine.quoteAmount === 'number' ? mine.quoteAmount : null,
          vendorNote: mine.vendorNote || '',
          createdAt: iso(mine.createdAt),
        }
      : null;
    extraViewer.quoteCount = quotes.length;
  }
  return {
    ...extraViewer,
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
    quotes: [],
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

const findByIdWithDesign = async (id, { viewer = null } = {}) => {
  if (!id) return null;
  const doc = await collection().findOne({ _id: String(id) });
  return doc ? sanitize(doc, { withDesign: true, viewer }) : null;
};

const CUSTOMER_VIEWER = { role: 'customer' };

const getForCustomer = async (id, customerUserId, { withDesign = false } = {}) => {
  if (!id) return null;
  const doc = await collection().findOne({
    _id: String(id),
    customerUserId: toObjectId(customerUserId),
  });
  return doc ? sanitize(doc, { withDesign, viewer: CUSTOMER_VIEWER }) : null;
};

const listByCustomer = async (customerUserId) => {
  const rows = await collection()
    .find({ customerUserId: toObjectId(customerUserId) }, { projection: WITHOUT_DESIGN })
    .sort({ createdAt: -1 })
    .toArray();
  return rows.map((r) => sanitize(r, { viewer: CUSTOMER_VIEWER }));
};

// Open orders a vendor is eligible to accept — matched by served categories and
// service area (city). serveAll bypasses the city filter.
// NOTE: vendor `cities` are normalized (lowercased), so we match against the
// order's normalized `cityKey` field — matching the raw `city` here would miss
// as-entered values like "Hyderabad" and hide orders vendors were notified about.
const listOpenForVendor = async ({ categoryIds = [], cities = [], serveAll = false, vendorId } = {}) => {
  if (!categoryIds.length) return [];
  const filter = {
    status: 'open',
    categoryId: { $in: categoryIds },
  };
  if (!serveAll && cities.length) {
    filter.$or = [
      { cityKey: { $in: cities } },
      { cityKey: { $in: ['', null] } },
      { cityKey: { $exists: false } },
    ];
  }
  const viewer = vendorId ? { role: 'vendor', vendorId } : null;
  const rows = await collection()
    .find(filter, { projection: WITHOUT_DESIGN })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
  return rows.map((r) => sanitize(r, { viewer }));
};

const listAssignedForVendor = async (vendorId) => {
  const viewer = { role: 'vendor', vendorId };
  const rows = await collection()
    .find({ assignedVendorId: toObjectId(vendorId) }, { projection: WITHOUT_DESIGN })
    .sort({ updatedAt: -1 })
    .toArray();
  return rows.map((r) => sanitize(r, { viewer }));
};

const findAssignedForVendor = async (id, vendorId, { withDesign = false } = {}) => {
  if (!id) return null;
  const doc = await collection().findOne({
    _id: String(id),
    assignedVendorId: toObjectId(vendorId),
  });
  return doc
    ? { ...sanitize(doc, { withDesign, viewer: { role: 'vendor', vendorId } }), _raw: doc }
    : null;
};

// A vendor submits (or updates) a quote on an OPEN order. Multiple vendors may
// quote; the order stays open until the customer picks one.
const addQuote = async (id, quote) => {
  const now = new Date();
  const vendorId = toObjectId(quote.vendorId);
  const entry = {
    vendorId,
    businessId: quote.businessId ? toObjectId(quote.businessId) : undefined,
    vendorName: quote.vendorName || '',
    businessName: quote.businessName || '',
    vendorMobile: quote.vendorMobile || '',
    vendorNote: quote.vendorNote || '',
    quoteAmount: quote.quoteAmount,
    createdAt: now,
  };
  // Replace any prior quote from this vendor, then append the fresh one.
  await collection().updateOne(
    { _id: String(id), status: 'open' },
    { $pull: { quotes: { vendorId } } },
  );
  const res = await collection().findOneAndUpdate(
    { _id: String(id), status: 'open' },
    { $push: { quotes: entry }, $set: { updatedAt: now } },
    { returnDocument: 'after' },
  );
  const doc = res?.value ?? res;
  return doc ? { ...sanitize(doc, { viewer: { role: 'vendor', vendorId: quote.vendorId } }), _raw: doc } : null;
};

// Customer picks a vendor's quote → assigns the order and moves it to accepted.
const selectQuote = async (id, customerUserId, vendorId) => {
  const now = new Date();
  const doc = await collection().findOne({
    _id: String(id),
    customerUserId: toObjectId(customerUserId),
    status: 'open',
  });
  if (!doc || !Array.isArray(doc.quotes)) return null;
  const q = doc.quotes.find((x) => String(x.vendorId) === String(vendorId));
  if (!q) return null;
  const res = await collection().findOneAndUpdate(
    { _id: String(id), customerUserId: toObjectId(customerUserId), status: 'open' },
    {
      $set: {
        status: 'accepted',
        assignedVendorId: q.vendorId,
        assignedBusinessId: q.businessId,
        vendorName: q.vendorName || '',
        businessName: q.businessName || '',
        vendorMobile: q.vendorMobile || '',
        vendorNote: q.vendorNote || '',
        quoteAmount: q.quoteAmount,
        acceptedAt: now,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  );
  const updated = res?.value ?? res;
  return updated
    ? { ...sanitize(updated, { viewer: CUSTOMER_VIEWER }), _raw: updated }
    : null;
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
  findByIdWithDesign,
  getForCustomer,
  listByCustomer,
  listOpenForVendor,
  listAssignedForVendor,
  findAssignedForVendor,
  addQuote,
  selectQuote,
  updateStatusForVendor,
  attachPaymentSession,
  markPaid,
  markPaymentFailed,
  cancelByCustomer,
  expireOpenOrders,
};
