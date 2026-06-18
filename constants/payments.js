// How long a slot is held for the customer to complete payment.
// Cashfree requires order_expiry_time > 15 min and < 30 days.
const CASHFREE_MIN_HOLD_MINUTES = 16;
const CASHFREE_MAX_HOLD_MINUTES = 30 * 24 * 60 - 1;
const rawHold = Number(process.env.BOOKING_HOLD_MINUTES) || 20;
const HOLD_MINUTES = Math.min(
  Math.max(Number.isFinite(rawHold) ? rawHold : 20, CASHFREE_MIN_HOLD_MINUTES),
  CASHFREE_MAX_HOLD_MINUTES,
);

// Full refund allowed only if cancelled at least this many hours before slot start.
const REFUND_WINDOW_HOURS = Number(process.env.BOOKING_REFUND_WINDOW_HOURS) || 24;

// Booking lifecycle.
const BOOKING_STATUS = {
  PENDING_PAYMENT: 'pending_payment',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  PAYMENT_FAILED: 'payment_failed',
};

// Payment lifecycle (mirrors Cashfree order outcomes).
const PAYMENT_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
  REFUNDED: 'refunded',
};

module.exports = {
  HOLD_MINUTES,
  REFUND_WINDOW_HOURS,
  BOOKING_STATUS,
  PAYMENT_STATUS,
};
