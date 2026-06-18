// How long a slot is held for the customer to complete payment.
const HOLD_MINUTES = Number(process.env.BOOKING_HOLD_MINUTES) || 10;

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
