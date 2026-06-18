const bookingService = require('../services/booking.service');
const cashfreePayments = require('../utils/cashfreePayments');

// Cashfree Payment Gateway webhook. Verifies the HMAC signature against the raw
// body, then settles/releases the booking. Always responds 200 quickly so
// Cashfree doesn't retry on our processing errors (we reconcile separately).
exports.cashfreePayments = async (req, res) => {
  const signature = req.get('x-webhook-signature');
  const timestamp = req.get('x-webhook-timestamp');
  const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});

  if (!cashfreePayments.verifyWebhookSignature(signature, timestamp, rawBody)) {
    return res.status(401).json({ message: 'invalid signature' });
  }

  try {
    await bookingService.handlePaymentWebhook(req.body);
  } catch (err) {
    // Acknowledge anyway; the status poll + sweeper will reconcile.
    console.error('cashfree webhook processing error:', err.message);
  }
  return res.json({ ok: true });
};
