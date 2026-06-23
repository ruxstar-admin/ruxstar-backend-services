const { Router } = require('express');
const publicController = require('../controllers/public.controller');
const eventController = require('../controllers/event.controller');
const { publicLimiter } = require('../middlewares/rateLimit');

const router = Router();

router.get('/businesses', publicLimiter, publicController.listBusinesses);
router.get('/businesses/:id/photos/:photoId', publicController.getPhoto);
router.get('/businesses/:id/slots', publicLimiter, publicController.listSlots);
router.get('/businesses/:id', publicLimiter, publicController.getBusiness);

router.get('/events', publicLimiter, eventController.listPublicEvents);
router.get('/events/:id', publicLimiter, eventController.getPublicEvent);

module.exports = router;
