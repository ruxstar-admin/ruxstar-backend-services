const creatorService = require('../services/creator.service');
const { OFFER_STATUS, BOOKING_STATUS } = require('../constants/creator');

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

// ── Vendor offers ──
exports.createOffer = handle(async (req, res) => {
  const payload = await creatorService.createOffer(req.user.id, req.body);
  res.status(201).json(payload);
});

exports.listVendorOffers = handle(async (req, res) => {
  const payload = await creatorService.listVendorOffers(req.user.id, req.query);
  res.json(payload);
});

exports.getVendorOffer = handle(async (req, res) => {
  const payload = await creatorService.getVendorOffer(req.user.id, req.params.id);
  res.json(payload);
});

exports.updateOffer = handle(async (req, res) => {
  const payload = await creatorService.updateOffer(req.user.id, req.params.id, req.body);
  res.json(payload);
});

exports.publishOffer = handle(async (req, res) => {
  const payload = await creatorService.setOfferStatus(req.user.id, req.params.id, OFFER_STATUS.PUBLISHED);
  res.json(payload);
});

exports.cancelOffer = handle(async (req, res) => {
  const payload = await creatorService.setOfferStatus(req.user.id, req.params.id, OFFER_STATUS.CANCELLED);
  res.json(payload);
});

exports.unpublishOffer = handle(async (req, res) => {
  const payload = await creatorService.setOfferStatus(req.user.id, req.params.id, OFFER_STATUS.DRAFT);
  res.json(payload);
});

exports.deleteOffer = handle(async (req, res) => {
  const payload = await creatorService.deleteOffer(req.user.id, req.params.id);
  res.json(payload);
});

// ── Vendor bookings ──
exports.listVendorBookings = handle(async (req, res) => {
  const payload = await creatorService.listVendorBookings(req.user.id, req.query);
  res.json(payload);
});

exports.updateBookingStatus = handle(async (req, res) => {
  const status = String(req.body.status ?? '').trim();
  const payload = await creatorService.updateBookingStatus(req.user.id, req.params.id, status);
  res.json(payload);
});

// ── Public ──
exports.listPublicOffers = handle(async (_req, res) => {
  const payload = await creatorService.listPublicOffers();
  res.json(payload);
});

exports.getPublicOffer = handle(async (req, res) => {
  const payload = await creatorService.getPublicOffer(req.params.id);
  res.json(payload);
});

// ── Customer ──
exports.bookOffer = handle(async (req, res) => {
  const payload = await creatorService.bookOffer(req.user.id, req.params.id, req.body);
  res.status(201).json(payload);
});

exports.listMyBookings = handle(async (req, res) => {
  const payload = await creatorService.listCustomerBookings(req.user.id);
  res.json(payload);
});

exports.getBookingStatus = handle(async (req, res) => {
  const payload = await creatorService.getBookingStatus(req.user.id, req.params.id);
  res.json(payload);
});

exports.cancelBooking = handle(async (req, res) => {
  const payload = await creatorService.cancelBooking(req.user.id, req.params.id);
  res.json(payload);
});
