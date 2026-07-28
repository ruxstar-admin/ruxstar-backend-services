const { Router } = require('express');
const commerceController = require('../controllers/commerce.controller');
const authenticate = require('../middlewares/auth');
const requireRole = require('../middlewares/role');
const requireKyc = require('../middlewares/requireKyc');
const ROLES = require('../constants/roles');

const router = Router();

router.use(authenticate);

const vendorGuard = [requireRole(ROLES.VENDOR), requireKyc];
const customerGuard = requireRole(ROLES.CUSTOMER);

// Vendor products
router.get(
  '/vendor/businesses/:businessId/products',
  ...vendorGuard,
  commerceController.listVendorProducts,
);
router.post(
  '/vendor/businesses/:businessId/products',
  ...vendorGuard,
  commerceController.createProduct,
);
router.patch(
  '/vendor/businesses/:businessId/products/:productId',
  ...vendorGuard,
  commerceController.updateProduct,
);
router.delete(
  '/vendor/businesses/:businessId/products/:productId',
  ...vendorGuard,
  commerceController.deleteProduct,
);

// Vendor orders + availability
router.get('/vendor/orders', ...vendorGuard, commerceController.listVendorOrders);
router.get('/vendor/orders/:id', ...vendorGuard, commerceController.getVendorOrder);
router.post('/vendor/orders/:id/status', ...vendorGuard, commerceController.updateStatus);
router.post(
  '/vendor/businesses/:id/accepting',
  ...vendorGuard,
  commerceController.setAcceptingOrders,
);

// Customer shops + orders
router.get('/shops', customerGuard, commerceController.listShops);
router.get('/shops/:businessId', customerGuard, commerceController.getShop);
router.post('/orders', customerGuard, commerceController.createOrder);
router.get('/orders', customerGuard, commerceController.listOrders);
router.get('/orders/:id', customerGuard, commerceController.getOrder);
router.post('/orders/:id/pay', customerGuard, commerceController.pay);
router.post('/orders/:id/cancel', customerGuard, commerceController.cancelOrder);

module.exports = router;
