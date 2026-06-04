const { Router } = require('express');
const vendorController = require('../controllers/vendor.controller');
const authenticate = require('../middlewares/auth');
const requireRole = require('../middlewares/role');
const ROLES = require('../constants/roles');

const router = Router();

router.use(authenticate, requireRole(ROLES.VENDOR));

router.post('/become-customer', vendorController.becomeCustomer);
router.get('/profile', vendorController.getProfile);
router.patch('/profile', vendorController.updateProfile);
router.post('/users', vendorController.createUser);
router.get('/users', vendorController.listUsers);

module.exports = router;
