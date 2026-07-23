const bookingService = require('../services/booking.service');
const eventService = require('../services/event.service');
const printOrderService = require('../services/printOrder.service');
const withdrawalService = require('../services/withdrawal.service');
const cashfreePayments = require('../utils/cashfreePayments');
const cashfreePayouts = require('../utils/cashfreePayouts');

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
    // One Cashfree account funds both venue bookings and event registrations.
    // Try the booking handler first; if the order isn't a booking, fan out to
    // the event-registration handler. (order_id disambiguates the two.)
    const result = await bookingService.handlePaymentWebhook(req.body);
    if (result?.ignored) {
      const handledByEvent = await eventService.handlePaymentWebhook(req.body);
      if (!handledByEvent) {
        await printOrderService.handlePaymentWebhook(req.body);
      }
    }
  } catch (err) {
    // Acknowledge anyway; the status poll + sweeper will reconcile.
    console.error('cashfree webhook processing error:', err.message);
  }
  return res.json({ ok: true });
};

// Cashfree Payouts webhook. Settles/fails a vendor withdrawal when its transfer
// reaches a terminal state. Always acknowledges 200 — the admin "Refresh status"
// button and re-checks reconcile anything we miss.
exports.cashfreePayouts = async (req, res) => {
  const signature = req.get('x-webhook-signature');
  const timestamp = req.get('x-webhook-timestamp');
  const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});

  if (!cashfreePayouts.verifyWebhookSignature(signature, timestamp, rawBody)) {
    return res.status(401).json({ message: 'invalid signature' });
  }

  try {
    await withdrawalService.handleTransferWebhook(req.body);
  } catch (err) {
    console.error('cashfree payout webhook processing error:', err.message);
  }
  return res.json({ ok: true });
};
