const { Router } = require('express');
const userController = require('../controllers/user.controller');
const eventController = require('../controllers/event.controller');
const supportController = require('../controllers/support.controller');
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

router.get('/event-registrations', eventController.listMyRegistrations);
router.get('/event-registrations/:id', eventController.getRegistrationStatus);
router.post('/events/:id/register', eventController.register);

router.get('/support/refund-options', supportController.customerRefundOptions);
router.get('/support/tickets', supportController.customer.list);
router.post('/support/tickets', supportController.customer.create);
router.get('/support/tickets/:id', supportController.customer.get);
router.post('/support/tickets/:id/reply', supportController.customer.reply);

module.exports = router;
