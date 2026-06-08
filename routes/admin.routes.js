const { Router } = require('express');
const adminController = require('../controllers/admin.controller');
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

module.exports = router;
