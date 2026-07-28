const { Router } = require('express');
const creatorController = require('../controllers/creator.controller');
const authenticate = require('../middlewares/auth');
const requireRole = require('../middlewares/role');
const requireKyc = require('../middlewares/requireKyc');
const ROLES = require('../constants/roles');

const router = Router();

router.use(authenticate);

const vendorGuard = [requireRole(ROLES.VENDOR), requireKyc];
const customerGuard = requireRole(ROLES.CUSTOMER);

// Vendor offers
router.get('/vendor/offers', ...vendorGuard, creatorController.listVendorOffers);
router.post('/vendor/offers', ...vendorGuard, creatorController.createOffer);
router.get('/vendor/offers/:id', ...vendorGuard, creatorController.getVendorOffer);
router.patch('/vendor/offers/:id', ...vendorGuard, creatorController.updateOffer);
router.post('/vendor/offers/:id/publish', ...vendorGuard, creatorController.publishOffer);
router.post('/vendor/offers/:id/unpublish', ...vendorGuard, creatorController.unpublishOffer);
router.post('/vendor/offers/:id/cancel', ...vendorGuard, creatorController.cancelOffer);
router.delete('/vendor/offers/:id', ...vendorGuard, creatorController.deleteOffer);

// Vendor bookings
router.get('/vendor/bookings', ...vendorGuard, creatorController.listVendorBookings);
router.post('/vendor/bookings/:id/status', ...vendorGuard, creatorController.updateBookingStatus);

// Customer
router.get('/offers', customerGuard, creatorController.listPublicOffers);
router.get('/offers/:id', customerGuard, creatorController.getPublicOffer);
router.post('/offers/:id/book', customerGuard, creatorController.bookOffer);
router.get('/bookings', customerGuard, creatorController.listMyBookings);
router.get('/bookings/:id', customerGuard, creatorController.getBookingStatus);
router.post('/bookings/:id/cancel', customerGuard, creatorController.cancelBooking);

module.exports = router;
