const printOrderService = require('../services/printOrder.service');

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

// ── Customer ──
exports.createOrder = handle(async (req, res) => {
  const payload = await printOrderService.createOrder(req.user.id, req.body);
  res.status(201).json(payload);
});

exports.listOrders = handle(async (req, res) => {
  const payload = await printOrderService.listCustomerOrders(req.user.id);
  res.json(payload);
});

exports.getOrder = handle(async (req, res) => {
  const payload = await printOrderService.getCustomerOrder(req.user.id, req.params.id);
  res.json(payload);
});

exports.pay = handle(async (req, res) => {
  const payload = await printOrderService.initiatePayment(req.user.id, req.params.id);
  res.json(payload);
});

exports.cancelOrder = handle(async (req, res) => {
  const payload = await printOrderService.cancelOrder(req.user.id, req.params.id);
  res.json(payload);
});

// ── Vendor ──
exports.listVendorOrders = handle(async (req, res) => {
  const payload = await printOrderService.listVendorOrders(req.user.id);
  res.json(payload);
});

exports.getVendorOrder = handle(async (req, res) => {
  const payload = await printOrderService.getVendorOrder(req.user.id, req.params.id);
  res.json(payload);
});

exports.acceptOrder = handle(async (req, res) => {
  const payload = await printOrderService.acceptOrder(req.user.id, req.params.id, req.body);
  res.json(payload);
});

exports.updateStatus = handle(async (req, res) => {
  const status = String(req.body.status ?? '').trim();
  const payload = await printOrderService.updateOrderStatus(req.user.id, req.params.id, status);
  res.json(payload);
});
