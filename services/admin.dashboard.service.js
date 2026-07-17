const User = require('../models/User');
const Business = require('../models/Business');
const Booking = require('../models/Booking');
const Event = require('../models/Event');
const EventRegistration = require('../models/EventRegistration');
const PrintOrder = require('../models/PrintOrder');
const Payment = require('../models/Payment');

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
      Payment.revenueTotals(),
      Payment.revenueBySource(),
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
const cancelBooking = (id) => Booking.adminCancel(id);

const listEvents = (query) => Event.listAllAdmin(query);
const setEventStatus = (id, status) => Event.setStatusAdmin(id, status);
const listEventRegistrations = (query) => EventRegistration.listAllAdmin(query);

const listPrintOrders = (query) => PrintOrder.listAllAdmin(query);
const cancelPrintOrder = (id) => PrintOrder.adminCancel(id);

const listPayments = (query) => Payment.listAllAdmin(query);

// Revenue report: totals, split by source, top vendors (hydrated), daily series.
const getRevenue = async ({ days = 30, vendorLimit = 20 } = {}) => {
  const [totals, bySource, byVendorRaw, series] = await Promise.all([
    Payment.revenueTotals(),
    Payment.revenueBySource(),
    Payment.revenueByVendor({ limit: vendorLimit }),
    Payment.revenueTimeSeries({ days }),
  ]);
  const labels = await vendorLabels(byVendorRaw.map((v) => v.vendorId).filter(Boolean));
  const byVendor = byVendorRaw.map((v) => ({ ...v, vendorName: labels[v.vendorId] || 'Vendor' }));
  return { totals, bySource, byVendor, series };
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
  getRevenue,
};
