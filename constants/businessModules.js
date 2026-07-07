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

module.exports = { BUSINESS_MODULES, MODULE_LABELS };
