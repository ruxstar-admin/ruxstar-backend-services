const { Router } = require('express');
const vendorController = require('../controllers/vendor.controller');
const vendorKycController = require('../controllers/vendor.kyc.controller');
const authenticate = require('../middlewares/auth');
const requireRole = require('../middlewares/role');
const requireKyc = require('../middlewares/requireKyc');
const ROLES = require('../constants/roles');

const router = Router();

router.use(authenticate, requireRole(ROLES.VENDOR));

router.get('/kyc/status', vendorKycController.status);
router.post('/kyc/aadhaar/start', vendorKycController.startAadhaar);
router.get('/kyc/aadhaar/sync', vendorKycController.syncAadhaar);
router.post('/kyc/pan', vendorKycController.verifyPan);
router.post('/kyc/face', vendorKycController.verifyFace);
router.post('/become-customer', vendorController.becomeCustomer);

router.use(requireKyc);
router.get('/profile', vendorController.getProfile);
router.patch('/profile', vendorController.updateProfile);
router.post('/users', vendorController.createUser);
router.get('/users', vendorController.listUsers);

module.exports = router;
