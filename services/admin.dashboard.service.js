const User = require('../models/User');
const Business = require('../models/Business');
const Booking = require('../models/Booking');
const Event = require('../models/Event');
const EventRegistration = require('../models/EventRegistration');
const PrintOrder = require('../models/PrintOrder');
const Payment = require('../models/Payment');
const refundService = require('./refund.service');
const { getDb } = require('../config/database');

const PAID_PRINT_STATUSES = ['confirmed', 'in_production', 'ready', 'completed'];

// Sum confirmed paid rows from source collections. Used when the payment ledger
// is empty (e.g. settlements that happened before ledger backfill).
const platformRevenue = async ({ since } = {}) => {
  const db = getDb();
  const sinceMatch = since ? { paidAt: { $gte: since } } : {};

  const [bookings, events, print] = await Promise.all([
    db
      .collection('bookings')
      .aggregate([
        { $match: { status: 'confirmed', ...sinceMatch } },
        {
          $group: {
            _id: null,
            amount: { $sum: { $ifNull: ['$amount', '$pricePerSlot'] } },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray(),
    db
      .collection('event_registrations')
      .aggregate([
        { $match: { status: 'confirmed', ...sinceMatch } },
        { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      ])
      .toArray(),
    db
      .collection('print_orders')
      .aggregate([
        {
          $match: {
            status: { $in: PAID_PRINT_STATUSES },
            quoteAmount: { $type: 'number' },
            ...(since ? { paidAt: { $gte: since } } : {}),
          },
        },
        { $group: { _id: null, amount: { $sum: '$quoteAmount' }, count: { $sum: 1 } } },
      ])
      .toArray(),
  ]);

  const b = bookings[0] || { amount: 0, count: 0 };
  const e = events[0] || { amount: 0, count: 0 };
  const p = print[0] || { amount: 0, count: 0 };

  return {
    totals: { amount: b.amount + e.amount + p.amount, count: b.count + e.count + p.count },
    bySource: [
      { source: 'booking', amount: b.amount, count: b.count },
      { source: 'event', amount: e.amount, count: e.count },
      { source: 'print', amount: p.amount, count: p.count },
    ].filter((row) => row.count > 0),
  };
};

const platformRevenueByVendor = async ({ limit = 20 } = {}) => {
  const db = getDb();
  const [bookings, events, print] = await Promise.all([
    db
      .collection('bookings')
      .aggregate([
        { $match: { status: 'confirmed', vendorId: { $ne: null } } },
        {
          $group: {
            _id: '$vendorId',
            amount: { $sum: { $ifNull: ['$amount', '$pricePerSlot'] } },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray(),
    db
      .collection('event_registrations')
      .aggregate([
        { $match: { status: 'confirmed', vendorId: { $ne: null } } },
        { $group: { _id: '$vendorId', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      ])
      .toArray(),
    db
      .collection('print_orders')
      .aggregate([
        {
          $match: {
            status: { $in: PAID_PRINT_STATUSES },
            assignedVendorId: { $ne: null },
            quoteAmount: { $type: 'number' },
          },
        },
        { $group: { _id: '$assignedVendorId', amount: { $sum: '$quoteAmount' }, count: { $sum: 1 } } },
      ])
      .toArray(),
  ]);

  const merged = new Map();
  for (const rows of [bookings, events, print]) {
    for (const row of rows) {
      const id = String(row._id);
      const prev = merged.get(id) || { amount: 0, count: 0 };
      merged.set(id, { amount: prev.amount + row.amount, count: prev.count + row.count });
    }
  }

  return [...merged.entries()]
    .map(([vendorId, stats]) => ({ vendorId, ...stats }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, Number(limit));
};

const platformRevenueSeries = async ({ days = 30 } = {}) => {
  const db = getDb();
  const since = new Date(Date.now() - Number(days) * 86400000);
  const dateField = (field) => ({
    $dateToString: { format: '%Y-%m-%d', date: { $ifNull: [`$${field}`, '$createdAt'] } },
  });

  const [bookings, events, print] = await Promise.all([
    db
      .collection('bookings')
      .aggregate([
        { $match: { status: 'confirmed', paidAt: { $gte: since } } },
        { $group: { _id: dateField('paidAt'), amount: { $sum: { $ifNull: ['$amount', '$pricePerSlot'] } }, count: { $sum: 1 } } },
      ])
      .toArray(),
    db
      .collection('event_registrations')
      .aggregate([
        { $match: { status: 'confirmed', paidAt: { $gte: since } } },
        { $group: { _id: dateField('paidAt'), amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      ])
      .toArray(),
    db
      .collection('print_orders')
      .aggregate([
        {
          $match: {
            status: { $in: PAID_PRINT_STATUSES },
            quoteAmount: { $type: 'number' },
            paidAt: { $gte: since },
          },
        },
        { $group: { _id: dateField('paidAt'), amount: { $sum: '$quoteAmount' }, count: { $sum: 1 } } },
      ])
      .toArray(),
  ]);

  const byDate = new Map();
  for (const rows of [bookings, events, print]) {
    for (const row of rows) {
      const date = row._id;
      const prev = byDate.get(date) || { amount: 0, count: 0 };
      byDate.set(date, { amount: prev.amount + row.amount, count: prev.count + row.count });
    }
  }

  return [...byDate.entries()]
    .map(([date, stats]) => ({ date, ...stats }))
    .sort((a, b) => a.date.localeCompare(b.date));
};

// Prefer the payment ledger when it has rows; otherwise fall back to source docs.
const resolveRevenueTotals = async (since) => {
  const ledger = since
    ? await Payment.revenueTimeSeries({ days: Math.ceil((Date.now() - since.getTime()) / 86400000) }).then(
        (series) => ({
          amount: series.reduce((s, d) => s + d.amount, 0),
          count: series.reduce((s, d) => s + d.count, 0),
        }),
      )
    : await Payment.revenueTotals();
  if (ledger.count > 0) return ledger;
  const platform = await platformRevenue({ since });
  return platform.totals;
};

const resolveRevenueBySource = async () => {
  const ledger = await Payment.revenueBySource();
  if (ledger.length > 0) return ledger;
  const platform = await platformRevenue();
  return platform.bySource;
};

// Map a set of vendor ids -> display label ({ id: "Name (BusinessName)" }).
const vendorLabels = async (ids) => {
  const rows = await User.findByIds(ids, { name: 1, 'vendorProfile.businessName': 1 });
  return Object.fromEntries(
    rows.map((r) => [
      String(r._id),
      r.name || r.vendorProfile?.businessName || 'Vendor',
    ]),
  );
};

// Dashboard summary: counts across every domain plus revenue snapshot.
const getMetrics = async () => {
  const [users, businesses, confirmedBookings, printOrders, events, revenue, revenueBySource] =
    await Promise.all([
      User.countByRole(),
      Business.countByStatus(),
      Booking.countConfirmed(),
      PrintOrder.countAll(),
      Event.countAll(),
      resolveRevenueTotals(),
      resolveRevenueBySource(),
    ]);
  return {
    users,
    businesses,
    bookings: { confirmed: confirmedBookings },
    printOrders: { total: printOrders },
    events: { total: events },
    revenue,
    revenueBySource,
  };
};

const listUsers = (query) => User.listAllAdmin(query);

// Rich single-user view: profile + their businesses and lifetime revenue.
const getUserDetail = async (id) => {
  const user = await User.findById(id);
  if (!user) return null;
  const safe = User.sanitize(user);
  const [businesses, payments] = await Promise.all([
    Business.listAllAdmin({ vendorId: id, limit: 100 }),
    Payment.listByVendor(id),
  ]);
  const revenue = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  return {
    user: safe,
    businesses: businesses.items,
    revenue: { amount: revenue, count: payments.length },
    recentPayments: payments.slice(0, 10),
  };
};

// Businesses list with the owner's name attached for readability.
const listBusinesses = async (query) => {
  const { items, total } = await Business.listAllAdmin(query);
  const labels = await vendorLabels(items.map((b) => b.vendorId).filter(Boolean));
  return { items: items.map((b) => ({ ...b, vendorName: labels[b.vendorId] || null })), total };
};

const setBusinessSuspended = (id, suspended, reason) =>
  Business.setSuspended(id, suspended, reason);

const listBookings = (query) => Booking.listAllAdmin(query);
const cancelBooking = async (id) => {
  const cancelled = await Booking.adminCancel(id);
  if (!cancelled) return null;
  let refund = { refunded: false, reason: 'not_paid' };
  if (cancelled.paymentStatus === 'paid') {
    refund = await refundService.issueRefund({
      source: 'booking',
      sourceId: id,
      note: `Admin-cancelled booking ${cancelled.refId || id}`,
    });
    if (refund.refunded) {
      const updated = await Booking.markRefunded(id);
      if (updated) Object.assign(cancelled, updated);
    }
  }
  return { ...cancelled, refund };
};

const listEvents = (query) => Event.listAllAdmin(query);
const setEventStatus = (id, status) => Event.setStatusAdmin(id, status);
const listEventRegistrations = (query) => EventRegistration.listAllAdmin(query);

const listPrintOrders = (query) => PrintOrder.listAllAdmin(query);
const cancelPrintOrder = async (id) => {
  const cancelled = await PrintOrder.adminCancel(id);
  if (!cancelled) return null;
  let refund = { refunded: false, reason: 'not_paid' };
  if (cancelled.paymentStatus === 'paid') {
    refund = await refundService.issueRefund({
      source: 'print',
      sourceId: id,
      note: `Admin-cancelled print order ${cancelled.paymentRefId || id}`,
    });
    if (refund.refunded) {
      const updated = await PrintOrder.markRefunded(id);
      if (updated) Object.assign(cancelled, updated);
    }
  }
  return { ...cancelled, refund };
};

const listPayments = (query) => Payment.listAllAdmin(query);

// Everything a single customer has done — for admin visibility into the
// customer module. Bookings, print orders and the payment ledger (incl. refunds).
const getUserActivity = async (userId) => {
  const detail = await getUserDetail(userId);
  if (!detail) return null;
  const [bookings, printOrders, payments] = await Promise.all([
    Booking.listByCustomer(userId).catch(() => []),
    PrintOrder.listByCustomer(userId).catch(() => []),
    Payment.listByCustomer(userId).catch(() => []),
  ]);
  return { user: detail.user ?? detail, bookings, printOrders, payments };
};

// Revenue report: totals, split by source, top vendors (hydrated), daily series.
const getRevenue = async ({ days = 30, vendorLimit = 20 } = {}) => {
  const ledgerTotals = await Payment.revenueTotals();
  const useLedger = ledgerTotals.count > 0;

  if (useLedger) {
    const [bySource, byVendorRaw, series] = await Promise.all([
      Payment.revenueBySource(),
      Payment.revenueByVendor({ limit: vendorLimit }),
      Payment.revenueTimeSeries({ days }),
    ]);
    const labels = await vendorLabels(byVendorRaw.map((v) => v.vendorId).filter(Boolean));
    return {
      totals: ledgerTotals,
      bySource,
      byVendor: byVendorRaw.map((v) => ({ ...v, vendorName: labels[v.vendorId] || 'Vendor' })),
      series,
    };
  }

  const [platform, byVendorRaw, series] = await Promise.all([
    platformRevenue(),
    platformRevenueByVendor({ limit: vendorLimit }),
    platformRevenueSeries({ days }),
  ]);
  const labels = await vendorLabels(byVendorRaw.map((v) => v.vendorId).filter(Boolean));
  return {
    totals: platform.totals,
    bySource: platform.bySource,
    byVendor: byVendorRaw.map((v) => ({ ...v, vendorName: labels[v.vendorId] || 'Vendor' })),
    series,
  };
};

module.exports = {
  getMetrics,
  listUsers,
  getUserDetail,
  listBusinesses,
  setBusinessSuspended,
  listBookings,
  cancelBooking,
  listEvents,
  setEventStatus,
  listEventRegistrations,
  listPrintOrders,
  cancelPrintOrder,
  listPayments,
  getUserActivity,
  getRevenue,
};
