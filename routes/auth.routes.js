const { Router } = require('express');
const authController = require('../controllers/auth.controller');
const authenticate = require('../middlewares/auth');
const { otpLimiter, authLimiter } = require('../middlewares/rateLimit');

const router = Router();

router.post('/signup/send-otp', otpLimiter, authController.signupSendOtp);
router.post('/signup/verify-otp', authLimiter, authController.signupVerifyOtp);
router.post('/signup/complete', authLimiter, authController.signupComplete);
router.post('/login/send-otp', otpLimiter, authController.loginSendOtp);
router.post('/login/verify-otp', authLimiter, authController.loginVerifyOtp);
router.post('/login', authLimiter, authController.login);
router.get('/me', authenticate, authController.me);
router.post('/logout', authenticate, authController.logout);

module.exports = router;
