const cashfree = require('../utils/cashfreePayments');
const Payment = require('../models/Payment');
const { randomCode } = require('../utils/referenceId');

// Reasons surfaced to callers so cancel flows can tell the customer what happened.
const REASON = {
  REFUNDED: 'refunded',
  ALREADY_REFUNDED: 'already_refunded',
  NO_PAYMENT: 'no_payment',
  NOT_PAID: 'not_paid',
  PAID_OUT: 'paid_out',
  WINDOW_EXPIRED: 'window_expired',
  NO_GATEWAY_ORDER: 'no_gateway_order',
  GATEWAY_ERROR: 'gateway_error',
};

/**
 * Refund a paid source entity (booking / print / event) back to the customer's
 * original payment method via Cashfree. A refund is only possible while the
 * ledger row is still `paid` and has NOT been included in a completed vendor
 * payout — once paid out, the money is with the vendor and cannot be reversed.
 *
 * Returns { refunded: boolean, reason, amount?, gatewayRefundId?, payment? }.
 * Never throws — the caller decides how to surface the outcome.
 */
const issueRefund = async ({ source, sourceId, note } = {}) => {
  const ledger = await Payment.findBySource(source, sourceId);
  if (!ledger) return { refunded: false, reason: REASON.NO_PAYMENT };
  if (ledger.status === 'refunded') {
    return { refunded: true, reason: REASON.ALREADY_REFUNDED, payment: ledger, amount: ledger.refundAmount ?? ledger.amount };
  }
  // Once a payment has been reserved for or settled by a vendor withdrawal, the
  // money is on its way to (or with) the vendor and can no longer be reversed.
  if (ledger.payoutId || ledger.withdrawalId) return { refunded: false, reason: REASON.PAID_OUT, payment: ledger };
  if (ledger.status !== 'paid') return { refunded: false, reason: REASON.NOT_PAID, payment: ledger };
  if (!Payment.withinRefundWindow(ledger.paidAt)) {
    return { refunded: false, reason: REASON.WINDOW_EXPIRED, payment: ledger };
  }
  if (!ledger.cashfreeOrderId) return { refunded: false, reason: REASON.NO_GATEWAY_ORDER, payment: ledger };

  const amount = ledger.amount;
  const refundId = `RFND-${randomCode(10)}`;
  let gatewayRefundId = refundId;

  if (cashfree.isConfigured()) {
    try {
      const res = await cashfree.refundOrder({
        orderId: ledger.cashfreeOrderId,
        refundId,
        amount,
        note: note || 'Order cancelled by customer',
      });
      gatewayRefundId = res?.cf_refund_id ? String(res.cf_refund_id) : refundId;
    } catch (err) {
      return {
        refunded: false,
        reason: REASON.GATEWAY_ERROR,
        error: err.detail || err.message,
        payment: ledger,
      };
    }
  }

  const updated = await Payment.markRefunded({ source, sourceId, refundAmount: amount, gatewayRefundId });
  if (!updated) {
    // Someone paid out or refunded between our checks — re-read and report.
    const latest = await Payment.findBySource(source, sourceId);
    if (latest?.payoutId || latest?.withdrawalId) return { refunded: false, reason: REASON.PAID_OUT, payment: latest };
    if (latest?.status === 'refunded') {
      return { refunded: true, reason: REASON.ALREADY_REFUNDED, payment: latest, amount };
    }
    if (latest && !Payment.withinRefundWindow(latest.paidAt)) {
      return { refunded: false, reason: REASON.WINDOW_EXPIRED, payment: latest };
    }
  }
  await markSourceRefunded(source, sourceId);
  return { refunded: true, reason: REASON.REFUNDED, amount, gatewayRefundId, payment: updated || ledger };
};

// Flag the underlying source entity as refunded so its own status stays in sync
// with the ledger. Best-effort — never throws.
const markSourceRefunded = async (source, sourceId) => {
  try {
    if (source === 'booking') await require('../models/Booking').markRefunded(sourceId);
    else if (source === 'print') await require('../models/PrintOrder').markRefunded(sourceId);
  } catch {
    /* cosmetic sync only */
  }
};

/**
 * Refund a payment identified by its ledger reference id (PAY-…). Used by the
 * support flow: an admin resolves a customer's refund ticket by entering the
 * payment reference. Resolves the source/sourceId, then delegates to
 * issueRefund (which enforces the 7-day window + not-yet-withdrawn checks).
 */
const issueRefundByRef = async (refId, { note } = {}) => {
  const ledger = await Payment.findByRefId(refId);
  if (!ledger) return { refunded: false, reason: REASON.NO_PAYMENT };
  return issueRefund({ source: ledger.source, sourceId: ledger.sourceId, note });
};

module.exports = { issueRefund, issueRefundByRef, REASON };
