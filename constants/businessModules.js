/** Capability modules — shared by business types and runtime routing. */
const BUSINESS_MODULES = ['events', 'appointments', 'services', 'commerce', 'creator', 'print'];

const MODULE_LABELS = {
  events: 'Events & tickets',
  appointments: 'Bookings & appointments',
  services: 'Service requests',
  commerce: 'Products & shop',
  creator: 'Creator storefront',
  print: 'Print on demand',
};

// Modules that appear in the customer "book a slot" catalogue. Print and
// commerce have their own discovery paths. Creator collab offers appear in
// Discover via published offers (not PUBLIC_BOOKING_MODULES). Events list per
// published event.
const PUBLIC_BOOKING_MODULES = ['appointments'];

module.exports = { BUSINESS_MODULES, MODULE_LABELS, PUBLIC_BOOKING_MODULES };
