const { Router } = require('express');
const catalogController = require('../controllers/catalog.controller');

const router = Router();

router.get('/business', catalogController.catalog);
router.get('/print', catalogController.printCatalog);

module.exports = router;
