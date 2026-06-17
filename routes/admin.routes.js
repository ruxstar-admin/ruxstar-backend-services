const { Router } = require('express');
const adminController = require('../controllers/admin.controller');
const adminCatalogController = require('../controllers/admin.catalog.controller');
const authenticate = require('../middlewares/auth');
const requireRole = require('../middlewares/role');
const ROLES = require('../constants/roles');

const router = Router();

router.use(authenticate, requireRole(ROLES.ADMIN));

router.get('/users', adminController.listUsers);
router.post('/users', adminController.createUser);
router.patch('/users/:id', adminController.updateUser);

router.get('/kyc', adminController.listKyc);
router.get('/kyc/:userId', adminController.getKyc);
router.patch('/kyc/:userId', adminController.reviewKyc);

router.get('/business-categories', adminCatalogController.listCategories);
router.post('/business-categories', adminCatalogController.createCategory);
router.patch('/business-categories/:id', adminCatalogController.updateCategory);

router.get('/business-types', adminCatalogController.listTypes);
router.post('/business-types', adminCatalogController.createType);
router.patch('/business-types/:id', adminCatalogController.updateType);

module.exports = router;
