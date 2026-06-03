const { Router } = require('express');
const authController = require('../controllers/auth.controller');
const authenticate = require('../middlewares/auth');

const router = Router();

router.post('/signup/send-otp', authController.signupSendOtp);
router.post('/signup/verify-otp', authController.signupVerifyOtp);
router.post('/signup/complete', authController.signupComplete);
router.post('/login/send-otp', authController.loginSendOtp);
router.post('/login/verify-otp', authController.loginVerifyOtp);
router.post('/login', authController.login);
router.get('/me', authenticate, authController.me);
router.post('/logout', authenticate, authController.logout);

module.exports = router;
