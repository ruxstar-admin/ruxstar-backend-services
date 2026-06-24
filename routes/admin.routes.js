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

// Staff management — admins only.
router.get('/users', adminController.listUsers);
router.post('/users', adminOnly, adminController.createUser);
router.patch('/users/:id', adminOnly, adminController.updateUser);

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
