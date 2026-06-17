const bookingService = require('../services/booking.service');

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getBusiness = handle(async (req, res) => {
  const business = await bookingService.getPublicBusiness(req.params.id);
  res.json({ business });
});

exports.listBusinesses = handle(async (_req, res) => {
  const payload = await bookingService.listPublicBusinesses();
  res.json(payload);
});

exports.listSlots = handle(async (req, res) => {
  const payload = await bookingService.listPublicSlots(req.params.id, req.query);
  res.json(payload);
});
