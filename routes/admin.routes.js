const { Router } = require('express');
const adminController = require('../controllers/admin.controller');
const adminCatalogController = require('../controllers/admin.catalog.controller');
const authenticate = require('../middlewares/auth');
const requireRole = require('../middlewares/role');
const ROLES = require('../constants/roles');

const router = Router();

// Staff area: any authenticated admin OR employee may enter. Sensitive
// mutations (staff management, catalog edits) are gated to admins below.
router.use(authenticate, requireRole(ROLES.ADMIN, ROLES.EMPLOYEE));

const adminOnly = requireRole(ROLES.ADMIN);

// Dashboard summary — staff.
router.get('/metrics', adminController.metrics);

// Users & vendors — staff read; admin-only mutations.
router.get('/users', adminController.listUsers);
router.get('/users/:id', adminController.getUser);
router.post('/users', adminOnly, adminController.createUser);
router.patch('/users/:id', adminOnly, adminController.updateUser);

// Businesses — staff read; admin-only suspend/unsuspend.
router.get('/businesses', adminController.listBusinesses);
router.patch('/businesses/:id', adminOnly, adminController.updateBusiness);

// Bookings — staff read; admin-only force-cancel.
router.get('/bookings', adminController.listBookings);
router.patch('/bookings/:id/cancel', adminOnly, adminController.cancelBooking);

// Events & registrations — staff read; admin-only status change.
router.get('/events', adminController.listEvents);
router.patch('/events/:id', adminOnly, adminController.updateEvent);
router.get('/event-registrations', adminController.listEventRegistrations);

// Print orders — staff read; admin-only force-cancel.
router.get('/print-orders', adminController.listPrintOrders);
router.patch('/print-orders/:id/cancel', adminOnly, adminController.cancelPrintOrder);

// Payments & revenue — staff read.
router.get('/payments', adminController.listPayments);
router.get('/revenue', adminController.revenue);

// Vendor KYC review — admins and employees.
router.get('/kyc', adminController.listKyc);
router.get('/kyc/:userId', adminController.getKyc);
router.patch('/kyc/:userId', adminController.reviewKyc);

// Catalog — readable by staff, editable by admins only.
router.get('/business-categories', adminCatalogController.listCategories);
router.post('/business-categories', adminOnly, adminCatalogController.createCategory);
router.patch('/business-categories/:id', adminOnly, adminCatalogController.updateCategory);

router.get('/business-types', adminCatalogController.listTypes);
router.post('/business-types', adminOnly, adminCatalogController.createType);
router.patch('/business-types/:id', adminOnly, adminCatalogController.updateType);

module.exports = router;
