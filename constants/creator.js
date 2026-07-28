const CREATOR_MODULE = 'creator';

const OFFER_KIND = {
  SHOUTOUT: 'shoutout',
  COLLAB: 'collab',
  APPEARANCE: 'appearance',
};

const OFFER_STATUS = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
  CANCELLED: 'cancelled',
};

const BOOKING_STATUS = {
  PENDING_PAYMENT: 'pending_payment',
  CONFIRMED: 'confirmed',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  PAYMENT_FAILED: 'payment_failed',
};

const PLATFORM_VALUES = ['instagram', 'youtube', 'other'];

module.exports = {
  CREATOR_MODULE,
  OFFER_KIND,
  OFFER_STATUS,
  BOOKING_STATUS,
  PLATFORM_VALUES,
};
