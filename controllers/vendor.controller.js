const jwt = require('jsonwebtoken');
const authService = require('../services/auth.service');
const bookingService = require('../services/booking.service');

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

/** Logged-in vendor → customer */
exports.becomeCustomer = async (req, res) => {
  const updated = await authService.becomeCustomer(req.user.id);
  if (!updated) return res.status(400).json({ message: 'only vendors can switch to customer' });
  res.json({ token: signToken(updated), user: authService.sanitize(updated) });
};
