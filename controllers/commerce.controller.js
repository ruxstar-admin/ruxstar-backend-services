const productService = require('../services/product.service');
const commerceOrderService = require('../services/commerceOrder.service');
const setupService = require('../services/businessSetup.service');

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    return res.status(status).json({
      message: err.message || 'something went wrong',
      ...(err.issues ? { issues: err.issues } : {}),
    });
  }
};

// ── Products (vendor) ──
exports.listVendorProducts = handle(async (req, res) => {
  const data = await productService.listVendorProducts(req.params.businessId, req.user.id);
  res.json(data);
});

exports.createProduct = handle(async (req, res) => {
  const data = await productService.createProduct(req.params.businessId, req.user.id, req.body || {});
  res.status(201).json(data);
});

exports.updateProduct = handle(async (req, res) => {
  const data = await productService.updateProduct(
    req.params.businessId,
    req.user.id,
    req.params.productId,
    req.body || {},
  );
  res.json(data);
});

exports.deleteProduct = handle(async (req, res) => {
  const data = await productService.deleteProduct(
    req.params.businessId,
    req.user.id,
    req.params.productId,
  );
  res.json(data);
});

// ── Shops / products (customer) ──
exports.listShops = handle(async (_req, res) => {
  res.json(await productService.listLiveShops());
});

exports.getShop = handle(async (req, res) => {
  res.json(await productService.listPublicProducts(req.params.businessId));
});

// ── Orders (customer) ──
exports.createOrder = handle(async (req, res) => {
  const data = await commerceOrderService.createOrder(req.user.id, req.body || {});
  res.status(201).json(data);
});

exports.listOrders = handle(async (req, res) => {
  res.json(await commerceOrderService.listCustomerOrders(req.user.id));
});

exports.getOrder = handle(async (req, res) => {
  res.json(await commerceOrderService.getCustomerOrder(req.user.id, req.params.id));
});

exports.pay = handle(async (req, res) => {
  res.json(await commerceOrderService.initiatePayment(req.user.id, req.params.id));
});

exports.cancelOrder = handle(async (req, res) => {
  res.json(await commerceOrderService.cancelOrder(req.user.id, req.params.id));
});

// ── Orders (vendor) ──
exports.listVendorOrders = handle(async (req, res) => {
  res.json(await commerceOrderService.listVendorOrders(req.user.id));
});

exports.getVendorOrder = handle(async (req, res) => {
  res.json(await commerceOrderService.getVendorOrder(req.user.id, req.params.id));
});

exports.updateStatus = handle(async (req, res) => {
  res.json(
    await commerceOrderService.updateVendorStatus(
      req.user.id,
      req.params.id,
      String(req.body?.status || ''),
    ),
  );
});

exports.setAcceptingOrders = handle(async (req, res) => {
  const accepting = req.body?.acceptingOrders !== false;
  const { business } = await commerceOrderService.setAcceptingOrders(
    req.params.id,
    req.user.id,
    accepting,
  );
  res.json({
    business: setupService.stripSetupPhotos(setupService.formatBusinessForClient(business)),
  });
});
