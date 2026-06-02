const { Router } = require('express');
const authController = require('../controllers/auth.controller');
const authenticate = require('../middlewares/auth');

const router = Router();


router.post('/send-otp', authController.sendOtp);

router.post('/verify-otp', authController.verifyOtp);
router.get('/me', authenticate, authController.me);
router.post('/logout', authenticate, authController.logout);

module.exports = router;
