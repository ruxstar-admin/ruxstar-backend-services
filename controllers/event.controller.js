const eventService = require('../services/event.service');
const { EVENT_STATUS } = require('../constants/events');

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

// ── Vendor ──
exports.createEvent = handle(async (req, res) => {
  const payload = await eventService.createEvent(req.user.id, req.body);
  res.status(201).json(payload);
});

exports.listVendorEvents = handle(async (req, res) => {
  const payload = await eventService.listVendorEvents(req.user.id);
  res.json(payload);
});

exports.getVendorEvent = handle(async (req, res) => {
  const payload = await eventService.getVendorEvent(req.user.id, req.params.id);
  res.json(payload);
});

exports.updateEvent = handle(async (req, res) => {
  const payload = await eventService.updateEvent(req.user.id, req.params.id, req.body);
  res.json(payload);
});

exports.publishEvent = handle(async (req, res) => {
  const payload = await eventService.setEventStatus(req.user.id, req.params.id, EVENT_STATUS.PUBLISHED);
  res.json(payload);
});

exports.unpublishEvent = handle(async (req, res) => {
  const payload = await eventService.setEventStatus(req.user.id, req.params.id, EVENT_STATUS.DRAFT);
  res.json(payload);
});

exports.cancelEvent = handle(async (req, res) => {
  const payload = await eventService.setEventStatus(req.user.id, req.params.id, EVENT_STATUS.CANCELLED);
  res.json(payload);
});

exports.deleteEvent = handle(async (req, res) => {
  const payload = await eventService.deleteEvent(req.user.id, req.params.id);
  res.json(payload);
});

// ── Public ──
exports.listPublicEvents = handle(async (_req, res) => {
  const payload = await eventService.listPublicEvents();
  res.json(payload);
});

exports.getPublicEvent = handle(async (req, res) => {
  const payload = await eventService.getPublicEvent(req.params.id);
  res.json(payload);
});

// ── Customer ──
exports.register = handle(async (req, res) => {
  const payload = await eventService.registerForEvent(req.user.id, req.params.id, req.body);
  res.status(201).json(payload);
});

exports.listMyRegistrations = handle(async (req, res) => {
  const payload = await eventService.listCustomerRegistrations(req.user.id);
  res.json(payload);
});

exports.getRegistrationStatus = handle(async (req, res) => {
  const payload = await eventService.getRegistrationStatus(req.user.id, req.params.id);
  res.json(payload);
});
