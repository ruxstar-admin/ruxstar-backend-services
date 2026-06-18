const { Router } = require('express');
const webhookController = require('../controllers/webhook.controller');

const router = Router();

// Unauthenticated — secured via Cashfree webhook signature verification.
router.post('/cashfree/payments', webhookController.cashfreePayments);

module.exports = router;
