const { Router } = require('express');
const userController = require('../controllers/user.controller');
const authenticate = require('../middlewares/auth');
const requireRole = require('../middlewares/role');
const ROLES = require('../constants/roles');

const router = Router();

router.use(authenticate, requireRole(ROLES.CUSTOMER));

router.get('/profile', userController.getProfile);
router.patch('/profile', userController.updateProfile);
router.post('/become-vendor', userController.becomeVendor);

module.exports = router;
