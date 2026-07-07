const { Router } = require('express');
const notificationController = require('../controllers/notification.controller');
const authenticate = require('../middlewares/auth');

const router = Router();

// Any authenticated user (customer or vendor) has a notification inbox.
router.use(authenticate);

router.get('/', notificationController.list);
router.get('/unread-count', notificationController.unreadCount);
router.post('/read-all', notificationController.markAllRead);
router.post('/:id/read', notificationController.markRead);

module.exports = router;
