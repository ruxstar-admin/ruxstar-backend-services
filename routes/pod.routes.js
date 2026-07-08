const { Router } = require('express');
const printOrderController = require('../controllers/printOrder.controller');
const authenticate = require('../middlewares/auth');
const requireRole = require('../middlewares/role');
const requireKyc = require('../middlewares/requireKyc');
const ROLES = require('../constants/roles');

const router = Router();

router.use(authenticate);

// ── Vendor order queue (KYC-verified print vendors) ──
const vendorGuard = [requireRole(ROLES.VENDOR), requireKyc];
router.get('/vendor/orders', ...vendorGuard, printOrderController.listVendorOrders);
router.get('/vendor/orders/:id', ...vendorGuard, printOrderController.getVendorOrder);
router.post('/vendor/orders/:id/quote', ...vendorGuard, printOrderController.submitQuote);
// Back-compat alias for the previous "accept" endpoint.
router.post('/vendor/orders/:id/accept', ...vendorGuard, printOrderController.submitQuote);
router.post('/vendor/orders/:id/status', ...vendorGuard, printOrderController.updateStatus);

// ── Customer order flow ──
const customerGuard = requireRole(ROLES.CUSTOMER);
router.post('/orders', customerGuard, printOrderController.createOrder);
router.get('/orders', customerGuard, printOrderController.listOrders);
router.get('/orders/:id', customerGuard, printOrderController.getOrder);
router.post('/orders/:id/select', customerGuard, printOrderController.selectQuote);
router.post('/orders/:id/pay', customerGuard, printOrderController.pay);
router.post('/orders/:id/cancel', customerGuard, printOrderController.cancelOrder);

module.exports = router;
