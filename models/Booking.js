const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');
const { monthKeyFromIso, countActiveForOccurrence } = require('../utils/coachingService');
const { withPrefix, REF_PREFIX } = require('../utils/referenceId');

const collection = () => getDb().collection('bookings');

const toObjectId = (id) => new ObjectId(String(id));

const sanitize = (doc) => {
  if (!doc) return doc;
  return {
    id: String(doc._id),
    refId: doc.refId || null,
    businessId: String(doc.businessId),
    businessName: doc.businessName,
    typeLabel: doc.typeLabel,
    resourceId: doc.resourceId,
    resourceName: doc.resourceName,
    services: Array.isArray(doc.services) ? doc.services : [],
    serviceLabel: doc.serviceLabel || '',
    durationMinutes: typeof doc.durationMinutes === 'number' ? doc.durationMinutes : null,
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
    // paymentRef = payment gateway's id; paymentRefId = our PAY-xxxx ledger id.
    paymentRef: doc.paymentRef || null,
    paymentRefId: doc.paymentRefId || null,
    expiresAt: doc.expiresAt ? doc.expiresAt.toISOString() : null,
    paidAt: doc.paidAt ? doc.paidAt.toISOString?.() ?? doc.paidAt : null,
    createdAt: doc.createdAt?.toISOString?.() ?? doc.createdAt,
    groupClass: doc.groupClass === true,
    maxParticipants: typeof doc.maxParticipants === 'number' ? doc.maxParticipants : undefined,
    pricingModel: doc.pricingModel || undefined,
    // Period-billed enrollments (weekly/monthly) pay once for every session
    // in that week/month — periodKind + periodKey identify which one.
    periodKind: doc.periodKind || undefined,
    periodKey: doc.periodKey || undefined,
    // Multi-slot bookings (e.g. a turf booked 6–9 in one paid order) list each
    // covered slot; single-slot bookings leave this undefined.
    slots: Array.isArray(doc.slots) && doc.slots.length
      ? doc.slots.map((s) => ({
          resourceId: s.resourceId,
          resourceName: s.resourceName ?? '',
          startAt: s.startAt?.toISOString?.() ?? s.startAt,
          endAt: s.endAt?.toISOString?.() ?? s.endAt,
          pricePerSlot: typeof s.pricePerSlot === 'number' ? s.pricePerSlot : undefined,
        }))
      : undefined,
  };
};

// Bounds (as absolute instants) for a period key — "week" keys are the
// Monday date ("YYYY-MM-DD"), "month" keys are "YYYY-MM".
const periodKeyToBounds = (periodKind, periodKey) => {
  if (periodKind === 'week') {
    const start = new Date(`${periodKey}T00:00:00+05:30`);
    return { start, endExclusive: new Date(start.getTime() + 7 * 86400000) };
  }
  const [y, m] = String(periodKey).split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return {
    start: new Date(`${y}-${pad(m)}-01T00:00:00+05:30`),
    endExclusive: new Date(`${nextY}-${pad(nextM)}-01T00:00:00+05:30`),
  };
};

const SLOT_UNIQUE_INDEX = 'businessId_1_resourceId_1_startAt_1';

const SLOT_UNIQUE_PARTIAL = { status: 'confirmed', groupClass: { $ne: true } };

const slotUniqueIndexNeedsRebuild = (index) => {
  if (!index?.partialFilterExpression) return true;
  const p = index.partialFilterExpression;
  return !(p.status === 'confirmed' && p.groupClass?.$ne === true);
};

const ensureIndexes = async () => {
  await collection().createIndex({ customerUserId: 1, createdAt: -1 });
  await collection().createIndex({ customerUserId: 1, startAt: 1 });
  await collection().createIndex({ customerUserId: 1, status: 1, startAt: 1 });
  await collection().createIndex({ businessId: 1, startAt: 1 });
  await collection().createIndex({ status: 1, expiresAt: 1 });
  // Vendor order views will query by vendor + slot time.
  await collection().createIndex({ vendorId: 1, startAt: 1 });
  await collection().createIndex(
    { refId: 1 },
    { unique: true, partialFilterExpression: { refId: { $exists: true } } },
  );

  // Enforce "at most one CONFIRMED solo booking per slot". Group-class rows
  // set groupClass:true and are excluded via the partial filter below.
  try {
    const existing = await collection().indexes();
    const found = existing.find((i) => i.name === SLOT_UNIQUE_INDEX);
    if (found && slotUniqueIndexNeedsRebuild(found)) {
      await collection().dropIndex(SLOT_UNIQUE_INDEX);
    }
  } catch (err) {
    console.warn('[Booking] slot unique index migration:', err.message);
  }

  try {
    await collection().createIndex(
      { businessId: 1, resourceId: 1, startAt: 1 },
      {
        unique: true,
        partialFilterExpression: SLOT_UNIQUE_PARTIAL,
        name: SLOT_UNIQUE_INDEX,
      },
    );
  } catch (err) {
    // IndexOptionsConflict (85) when an older partial definition is still present.
    if (err?.code === 85 || err?.codeName === 'IndexOptionsConflict') {
      await collection().dropIndex(SLOT_UNIQUE_INDEX);
      await collection().createIndex(
        { businessId: 1, resourceId: 1, startAt: 1 },
        {
          unique: true,
          partialFilterExpression: SLOT_UNIQUE_PARTIAL,
          name: SLOT_UNIQUE_INDEX,
        },
      );
    } else {
      throw err;
    }
  }

  try {
    await collection().createIndex(
      { businessId: 1, classSessionKey: 1, startAt: 1, status: 1 },
      { sparse: true },
    );
  } catch (err) {
    console.warn('[Booking] classSessionKey index:', err.message);
  }
};

const insert = async (doc, { session } = {}) => {
  const now = new Date();
  const { _id, businessId, vendorId, customerUserId, ...rest } = doc;
  const row = {
    ...( _id ? { _id: String(_id) } : {}),
    refId: doc.refId || withPrefix(REF_PREFIX.BOOKING),
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
    refId: doc.refId || withPrefix(REF_PREFIX.BOOKING),
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

// Link the confirmed booking to its ledger payment (PAY-xxxx). Idempotent.
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

// All active (confirmed + live pending) bookings for a class+coach that
// could occupy a seat during the given IST calendar month — the widest
// window any single payment option (exact/week/month) can cover.
const listActiveClassBookingsInMonth = async (
  businessId,
  { serviceId, staffId, monthKey },
  { session, customerUserId } = {},
) => {
  const { start, endExclusive } = periodKeyToBounds('month', monthKey);
  const now = new Date();
  const filter = {
    businessId: toObjectId(businessId),
    resourceId: String(staffId),
    startAt: { $gte: start, $lt: endExclusive },
    services: { $elemMatch: { id: String(serviceId) } },
    $or: [
      { status: 'confirmed' },
      { status: 'pending_payment', expiresAt: { $gt: now } },
    ],
    ...(customerUserId ? { customerUserId: toObjectId(customerUserId) } : {}),
  };
  return collection().find(filter, session ? { session } : {}).toArray();
};

// Seats already taken for one specific class occurrence, combining exact
// bookings for that session with any weekly/monthly enrollment whose period
// covers it (a monthly student occupies a seat at every session that month).
const countActiveOccurrenceBookings = async (
  businessId,
  { serviceId, staffId, startAt },
  { session, excludeBookingId } = {},
) => {
  const rows = await listActiveClassBookingsInMonth(
    businessId,
    { serviceId, staffId, monthKey: monthKeyFromIso(startAt) },
    { session },
  );
  return countActiveForOccurrence(rows, startAt, excludeBookingId);
};

// Whether this customer already has an active booking (of any payment type)
// covering this occurrence — prevents accidental double-booking.
const hasCustomerActiveForOccurrence = async (
  businessId,
  customerUserId,
  { serviceId, staffId, startAt },
) => {
  const rows = await listActiveClassBookingsInMonth(
    businessId,
    { serviceId, staffId, monthKey: monthKeyFromIso(startAt) },
    { customerUserId },
  );
  return countActiveForOccurrence(rows, startAt) > 0;
};

const listActiveServiceBookingsInRange = async (businessId, from, to) => {
  const now = new Date();
  const rows = await collection()
    .find({
      businessId: toObjectId(businessId),
      startAt: { $gte: new Date(from), $lt: new Date(to) },
      $or: [
        { status: 'confirmed' },
        { status: 'pending_payment', expiresAt: { $gt: now } },
      ],
      services: { $exists: true, $ne: [] },
    })
    .toArray();
  return rows;
};

// ── Admin ──

// Global, paginated booking list with optional filters and ref/customer search.
const listAllAdmin = async ({ status, businessId, vendorId, search, page = 1, limit = 20 } = {}) => {
  const filter = {};
  if (status) filter.status = status;
  if (businessId && ObjectId.isValid(String(businessId))) filter.businessId = toObjectId(businessId);
  if (vendorId && ObjectId.isValid(String(vendorId))) filter.vendorId = toObjectId(vendorId);
  if (search) {
    const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { refId: rx },
      { paymentRefId: rx },
      { customerName: rx },
      { customerMobile: rx },
      { businessName: rx },
    ];
  }
  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
  const [rows, total] = await Promise.all([
    collection().find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).toArray(),
    collection().countDocuments(filter),
  ]);
  return { items: rows.map(sanitize), total };
};

// Admin force-cancel (any confirmed booking, regardless of owner).
const adminCancel = async (id) => {
  if (!id) return null;
  const result = await collection().findOneAndUpdate(
    { _id: String(id), status: { $in: ['confirmed', 'pending_payment'] } },
    { $set: { status: 'cancelled', updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  const doc = result?.value ?? result;
  return doc ? sanitize(doc) : null;
};

const countConfirmed = () => collection().countDocuments({ status: 'confirmed' });

module.exports = {
  ensureIndexes,
  insert,
  insertPending,
  findById,
  listAllAdmin,
  adminCancel,
  countConfirmed,
  setPaymentRefId,
  attachPaymentSession,
  findByIdForCustomer,
  getForCustomer,
  listByCustomer,
  listByVendor,
  markPaid,
  markUnpaid,
  cancelById,
  listActiveClassBookingsInMonth,
  countActiveOccurrenceBookings,
  hasCustomerActiveForOccurrence,
  listActiveServiceBookingsInRange,
};
