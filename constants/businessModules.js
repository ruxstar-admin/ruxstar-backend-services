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

// Modules that appear in the customer "book a slot" catalogue. Print has its
// own discovery path (an order is broadcast to eligible shops) and events are
// listed per published event, so neither belongs here. Commerce and creator are
// deactivated in the catalogue until they have a real setup flow.
const PUBLIC_BOOKING_MODULES = ['appointments'];

module.exports = { BUSINESS_MODULES, MODULE_LABELS, PUBLIC_BOOKING_MODULES };
