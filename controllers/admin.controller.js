const authService = require('../services/auth.service');
const kycService = require('../services/vendor.kyc.service');
const dashboard = require('../services/admin.dashboard.service');
const payoutService = require('../services/payout.service');
const ROLES = require('../constants/roles');

const ADMIN_CREATE_ROLES = [ROLES.ADMIN, ROLES.EMPLOYEE];

// Common pagination params, clamped to sane bounds.
const pageParams = (req) => ({
  page: Math.max(1, Number(req.query.page) || 1),
  limit: Math.min(100, Math.max(1, Number(req.query.limit) || 20)),
  search: req.query.search ? String(req.query.search).trim() : undefined,
});

exports.listUsers = async (req, res) => {
  const { page, limit, search } = pageParams(req);
  const { items, total } = await dashboard.listUsers({
    role: req.query.role || undefined,
    status: req.query.status || undefined,
    search,
    page,
    limit,
  });
  res.json({ users: items, total, page, limit });
};

exports.getUser = async (req, res) => {
  const detail = await dashboard.getUserDetail(req.params.id);
  if (!detail) return res.status(404).json({ message: 'user not found' });
  res.json(detail);
};

exports.createUser = async (req, res) => {
  const { mobile, name, password, role } = req.body;
  if (!mobile || !name || !password || !role) {
    return res.status(400).json({ message: 'mobile, name, password and role required' });
  }
  if (!ADMIN_CREATE_ROLES.includes(role)) {
    return res.status(400).json({ message: 'role must be admin or employee' });
  }
  try {
    const user = await authService.createUser({ mobile, name, password, role });
    res.status(201).json({ user: authService.sanitize(user) });
  } catch (err) {
    res.status(409).json({ message: err.message });
  }
};

exports.updateUser = async (req, res) => {
  const { status, roles, disabledReason } = req.body;
  const patch = {};
  if (status) patch.status = status;
  if (roles) patch.roles = roles;
  if (status === 'disabled') patch.disabledReason = disabledReason || 'disabled by admin';
  if (status === 'active') patch.disabledReason = null;

  const result = await authService.updateUser(req.params.id, patch);
  const user = result?.value ?? result;
  if (!user) return res.status(404).json({ message: 'user not found' });
  res.json({ user: authService.sanitize(user) });
};

exports.listKyc = async (req, res) => {
  const vendors = await kycService.listForAdmin(req.query.status);
  res.json({ vendors });
};

exports.getKyc = async (req, res) => {
  const vendor = await kycService.getForAdmin(req.params.userId);
  if (!vendor) return res.status(404).json({ message: 'vendor not found' });
  res.json({ vendor });
};

exports.reviewKyc = async (req, res) => {
  const { action, reason } = req.body;
  if (!action) return res.status(400).json({ message: 'action required (approve or reject)' });
  try {
    const kyc = await kycService.review(req.params.userId, { action, reason });
    res.json({ kyc });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

// ── Dashboard ──
exports.metrics = async (_req, res) => {
  res.json(await dashboard.getMetrics());
};

// ── Businesses ──
exports.listBusinesses = async (req, res) => {
  const { page, limit, search } = pageParams(req);
  const suspended =
    req.query.suspended === 'true' ? true : req.query.suspended === 'false' ? false : undefined;
  const { items, total } = await dashboard.listBusinesses({
    status: req.query.status || undefined,
    module: req.query.module || undefined,
    vendorId: req.query.vendorId || undefined,
    suspended,
    search,
    page,
    limit,
  });
  res.json({ businesses: items, total, page, limit });
};

exports.updateBusiness = async (req, res) => {
  const { suspended, reason } = req.body;
  if (typeof suspended !== 'boolean') {
    return res.status(400).json({ message: 'suspended (boolean) required' });
  }
  const business = await dashboard.setBusinessSuspended(req.params.id, suspended, reason);
  if (!business) return res.status(404).json({ message: 'business not found' });
  res.json({ business });
};

// ── Bookings ──
exports.listBookings = async (req, res) => {
  const { page, limit, search } = pageParams(req);
  const { items, total } = await dashboard.listBookings({
    status: req.query.status || undefined,
    businessId: req.query.businessId || undefined,
    vendorId: req.query.vendorId || undefined,
    search,
    page,
    limit,
  });
  res.json({ bookings: items, total, page, limit });
};

exports.cancelBooking = async (req, res) => {
  const booking = await dashboard.cancelBooking(req.params.id);
  if (!booking) return res.status(404).json({ message: 'booking not found or not cancellable' });
  res.json({ booking });
};

// ── Events ──
exports.listEvents = async (req, res) => {
  const { page, limit, search } = pageParams(req);
  const { items, total } = await dashboard.listEvents({
    status: req.query.status || undefined,
    kind: req.query.kind || undefined,
    vendorId: req.query.vendorId || undefined,
    search,
    page,
    limit,
  });
  res.json({ events: items, total, page, limit });
};

exports.updateEvent = async (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ message: 'status required' });
  const event = await dashboard.setEventStatus(req.params.id, status);
  if (!event) return res.status(404).json({ message: 'event not found' });
  res.json({ event });
};

exports.listEventRegistrations = async (req, res) => {
  const { page, limit, search } = pageParams(req);
  const { items, total } = await dashboard.listEventRegistrations({
    status: req.query.status || undefined,
    eventId: req.query.eventId || undefined,
    vendorId: req.query.vendorId || undefined,
    search,
    page,
    limit,
  });
  res.json({ registrations: items, total, page, limit });
};

// ── Print orders ──
exports.listPrintOrders = async (req, res) => {
  const { page, limit, search } = pageParams(req);
  const { items, total } = await dashboard.listPrintOrders({
    status: req.query.status || undefined,
    assignedVendorId: req.query.vendorId || undefined,
    search,
    page,
    limit,
  });
  res.json({ orders: items, total, page, limit });
};

exports.cancelPrintOrder = async (req, res) => {
  const order = await dashboard.cancelPrintOrder(req.params.id);
  if (!order) return res.status(404).json({ message: 'order not found or not cancellable' });
  res.json({ order });
};

// ── Payments & revenue ──
exports.listPayments = async (req, res) => {
  const { page, limit, search } = pageParams(req);
  const { items, total } = await dashboard.listPayments({
    source: req.query.source || undefined,
    vendorId: req.query.vendorId || undefined,
    search,
    page,
    limit,
  });
  res.json({ payments: items, total, page, limit });
};

exports.revenue = async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  res.json(await dashboard.getRevenue({ days }));
};

// ── Vendor payouts ──
exports.listPayouts = async (req, res) => {
  const { items, total } = await payoutService.listPayouts({
    vendorId: req.query.vendorId || undefined,
    page: Math.max(1, Number(req.query.page) || 1),
    limit: Math.min(100, Math.max(1, Number(req.query.limit) || 50)),
  });
  res.json({ payouts: items, total });
};

exports.previewPayout = async (req, res) => {
  try {
    const preview = await payoutService.previewPayout({
      vendorId: req.query.vendorId,
      until: req.query.until || undefined,
    });
    res.json(preview);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.completePayout = async (req, res) => {
  try {
    const { vendorId, until, note } = req.body || {};
    const result = await payoutService.completePayout({ vendorId, until, note, adminId: req.user.id });
    res.status(201).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

// ── Customer module visibility ──
exports.getUserActivity = async (req, res) => {
  const activity = await dashboard.getUserActivity(req.params.id);
  if (!activity) return res.status(404).json({ message: 'user not found' });
  res.json(activity);
};
