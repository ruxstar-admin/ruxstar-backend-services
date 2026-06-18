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

router.get('/bookings', userController.listBookings);
router.post('/bookings', userController.createBooking);
router.post('/bookings/initiate', userController.initiateBooking);
router.get('/bookings/:id', userController.getBookingStatus);
router.delete('/bookings/:id', userController.cancelBooking);

module.exports = router;
