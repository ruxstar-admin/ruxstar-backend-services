const { Router } = require('express');
const publicController = require('../controllers/public.controller');

const router = Router();

router.get('/businesses', publicController.listBusinesses);
router.get('/businesses/:id/photos/:photoId', publicController.getPhoto);
router.get('/businesses/:id/slots', publicController.listSlots);
router.get('/businesses/:id', publicController.getBusiness);

module.exports = router;
