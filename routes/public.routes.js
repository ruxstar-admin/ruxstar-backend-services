const { Router } = require('express');
const publicController = require('../controllers/public.controller');
const eventController = require('../controllers/event.controller');
const creatorController = require('../controllers/creator.controller');
const { publicLimiter } = require('../middlewares/rateLimit');

const router = Router();

router.get('/businesses', publicLimiter, publicController.listBusinesses);
router.get('/businesses/:id/photos/:photoId', publicController.getPhoto);
router.get('/commerce/products/:productId/photos/:photoId', publicController.getProductPhoto);
router.get('/businesses/:id/slots', publicLimiter, publicController.listSlots);
router.get('/businesses/:id', publicLimiter, publicController.getBusiness);

router.get('/events', publicLimiter, eventController.listPublicEvents);
router.get('/events/:id', publicLimiter, eventController.getPublicEvent);

router.get('/creator-offers', publicLimiter, creatorController.listPublicOffers);
router.get('/creator-offers/:id', publicLimiter, creatorController.getPublicOffer);

module.exports = router;
