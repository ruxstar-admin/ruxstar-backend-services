const { Router } = require('express');
const vendorController = require('../controllers/vendor.controller');
const vendorKycController = require('../controllers/vendor.kyc.controller');
const businessController = require('../controllers/business.controller');
const authenticate = require('../middlewares/auth');
const requireRole = require('../middlewares/role');
const requireKyc = require('../middlewares/requireKyc');
const ROLES = require('../constants/roles');

const router = Router();

router.use(authenticate, requireRole(ROLES.VENDOR));

router.get('/kyc/status', vendorKycController.status);
router.get('/card', vendorKycController.card);
router.post('/kyc/aadhaar/start', vendorKycController.startAadhaar);
router.get('/kyc/aadhaar/sync', vendorKycController.syncAadhaar);
router.post('/kyc/pan', vendorKycController.verifyPan);
router.post('/kyc/face', vendorKycController.verifyFace);
router.post('/become-customer', vendorController.becomeCustomer);

router.use(requireKyc);
router.get('/profile', vendorController.getProfile);
router.patch('/profile', vendorController.updateProfile);

router.get('/businesses', businessController.list);
router.post('/businesses', businessController.create);
router.get('/businesses/:id/setup', businessController.getSetup);
router.patch('/businesses/:id/setup', businessController.updateSetup);
router.post('/businesses/:id/setup/photos/sync', businessController.syncSetupPhotos);
router.post('/businesses/:id/setup/photos', businessController.addSetupPhoto);
router.delete('/businesses/:id/setup/photos/:photoId', businessController.removeSetupPhoto);
router.post('/businesses/:id/setup/complete', businessController.completeSetup);
router.get('/businesses/:id/slots', businessController.listSlots);
router.post('/businesses/:id/slots/block', businessController.blockSlot);
router.post('/businesses/:id/slots/unblock', businessController.unblockSlot);
router.post('/businesses/:id/slots/price', businessController.setSlotPrice);
router.post('/businesses/:id/slots/price/clear', businessController.clearSlotPrice);
router.get('/businesses/:id', businessController.get);
router.patch('/businesses/:id', businessController.update);
router.delete('/businesses/:id', businessController.remove);

module.exports = router;
