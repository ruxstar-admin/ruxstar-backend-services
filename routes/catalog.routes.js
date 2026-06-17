const { Router } = require('express');
const catalogController = require('../controllers/catalog.controller');

const router = Router();

router.get('/business', catalogController.catalog);

module.exports = router;
