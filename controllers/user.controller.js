const jwt = require('jsonwebtoken');
const authService = require('../services/auth.service');

const signToken = (user) =>
  jwt.sign({ id: String(user._id), roles: user.roles }, process.env.JWT_SECRET, { expiresIn: '7d' });

const bookingService = require('../services/booking.service');

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getProfile = async (req, res) => {
  const user = await authService.findById(req.user.id);
  if (!user) return res.status(404).json({ message: 'user not found' });
  res.json({ user: authService.sanitize(user) });
};

exports.updateProfile = async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ message: 'name required' });
  const user = await authService.updateProfile(req.user.id, { name });
  res.json({ user: authService.sanitize(user) });
};

exports.becomeVendor = async (req, res) => {
  const user = await authService.findById(req.user.id);
  if (!user) return res.status(404).json({ message: 'user not found' });
  const businessName =
    req.body.businessName || user.vendorProfile?.businessName || user.name;
  const updated = await authService.becomeVendor(req.user.id, businessName);
  if (!updated) return res.status(400).json({ message: 'only customers can become vendor' });
  res.json({ token: signToken(updated), user: authService.sanitize(updated) });
};

exports.listBookings = handle(async (req, res) => {
  const payload = await bookingService.listCustomerBookings(req.user.id);
  res.json(payload);
});

exports.createBooking = handle(async (req, res) => {
  const payload = await bookingService.createBooking(req.user.id, req.body);
  res.status(201).json(payload);
});

exports.initiateBooking = handle(async (req, res) => {
  const payload = await bookingService.initiateBooking(req.user.id, req.body);
  res.status(201).json(payload);
});

exports.getBookingStatus = handle(async (req, res) => {
  const payload = await bookingService.getBookingStatus(req.user.id, req.params.id);
  res.json(payload);
});

exports.cancelBooking = handle(async (req, res) => {
  const payload = await bookingService.cancelBooking(req.user.id, req.params.id);
  res.json(payload);
});
