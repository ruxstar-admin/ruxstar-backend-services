const jwt = require('jsonwebtoken');
const authService = require('../services/auth.service');
const bookingService = require('../services/booking.service');
const paymentService = require('../services/payment.service');
const withdrawalService = require('../services/withdrawal.service');

const signToken = (user) =>
  jwt.sign({ id: String(user._id), roles: user.roles }, process.env.JWT_SECRET, { expiresIn: '7d' });

exports.getProfile = async (req, res) => {
  const user = await authService.findById(req.user.id);
  if (!user) return res.status(404).json({ message: 'user not found' });
  res.json({ profile: user.vendorProfile || {} });
};

const VENDOR_PROFILE_FIELDS = ['businessName', 'category', 'description', 'phone', 'address'];

exports.updateProfile = async (req, res) => {
  const patch = {};
  for (const field of VENDOR_PROFILE_FIELDS) {
    if (req.body[field] !== undefined) patch[field] = req.body[field];
  }
  if (!patch.businessName && patch.businessName !== undefined) {
    return res.status(400).json({ message: 'businessName cannot be empty' });
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ message: 'no profile fields to update' });
  }
  const user = await authService.updateVendorProfile(req.user.id, patch);
  if (!user) return res.status(404).json({ message: 'vendor not found' });
  res.json({ profile: user.vendorProfile });
};

/** Bookings (paid orders) across the vendor's businesses */
exports.listBookings = async (req, res) => {
  const businessId = req.query.businessId ? String(req.query.businessId) : undefined;
  const { bookings } = await bookingService.listVendorBookings(req.user.id, { businessId });
  res.json({ bookings });
};

/** Full payment ledger for the vendor (bookings + print + events) + earnings/withdrawal summary */
exports.listPayments = async (req, res) => {
  const [ledger, summary] = await Promise.all([
    paymentService.listVendorPayments(req.user.id),
    withdrawalService.getVendorSummary(req.user.id),
  ]);
  res.json({ payments: ledger.payments, summary });
};

const PAYOUT_METHOD_TYPES = ['bank', 'vpa'];

/** Save the vendor's payout (bank/UPI) details, reused for every withdrawal. */
exports.updatePayoutMethod = async (req, res) => {
  const { type, accountName, accountNumber, ifsc, vpa } = req.body || {};
  const kind = PAYOUT_METHOD_TYPES.includes(type) ? type : (vpa ? 'vpa' : 'bank');

  const method = { type: kind, accountName: accountName ? String(accountName).trim() : null };
  if (kind === 'bank') {
    const acc = String(accountNumber || '').replace(/\s/g, '');
    const code = String(ifsc || '').trim().toUpperCase();
    if (!/^\d{6,25}$/.test(acc)) return res.status(400).json({ message: 'enter a valid bank account number' });
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code)) return res.status(400).json({ message: 'enter a valid IFSC code' });
    if (!method.accountName) return res.status(400).json({ message: 'account holder name is required' });
    method.accountNumber = acc;
    method.ifsc = code;
  } else {
    const handle = String(vpa || '').trim();
    if (!/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(handle)) return res.status(400).json({ message: 'enter a valid UPI ID' });
    method.vpa = handle;
  }

  const user = await authService.updateVendorProfile(req.user.id, { payoutMethod: method });
  if (!user) return res.status(404).json({ message: 'vendor not found' });
  res.json({ profile: user.vendorProfile });
};

/** Vendor requests a withdrawal of their full matured balance. */
exports.requestWithdrawal = async (req, res) => {
  const { withdrawal } = await withdrawalService.requestWithdrawal(req.user.id);
  res.status(201).json({ withdrawal });
};

/** Vendor's withdrawal history. */
exports.listWithdrawals = async (req, res) => {
  const withdrawals = await withdrawalService.listVendorWithdrawals(req.user.id);
  res.json({ withdrawals });
};

/** Logged-in vendor → customer */
exports.becomeCustomer = async (req, res) => {
  const updated = await authService.becomeCustomer(req.user.id);
  if (!updated) return res.status(400).json({ message: 'only vendors can switch to customer' });
  res.json({ token: signToken(updated), user: authService.sanitize(updated) });
};
