// Events & tournaments domain constants. Registrations reuse the Cashfree
// payment pipeline (see constants/payments.js), so statuses mirror bookings.

const EVENT_MODULE = 'events';

// What an event entity represents.
const EVENT_KIND = {
  TOURNAMENT: 'tournament',
  EVENT: 'event',
};

// How participants enter a tournament.
const EVENT_FORMAT = {
  INDIVIDUAL: 'individual',
  TEAM: 'team',
};

// Event lifecycle controlled by the vendor.
const EVENT_STATUS = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
};

// Registration lifecycle — mirrors booking statuses so the shared Cashfree
// webhook/sweeper can settle either entity.
const REGISTRATION_STATUS = {
  PENDING_PAYMENT: 'pending_payment',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  PAYMENT_FAILED: 'payment_failed',
};

module.exports = {
  EVENT_MODULE,
  EVENT_KIND,
  EVENT_FORMAT,
  EVENT_STATUS,
  REGISTRATION_STATUS,
};
