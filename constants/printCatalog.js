/**
 * Print-on-demand catalog — the product categories a customer can order and
 * the attributes they choose per order. This is static config (served via
 * GET /catalog/print) and is intentionally decoupled from the DB business
 * catalog so the two evolve independently.
 */

// Shared option pools reused across categories.
const APPAREL_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
const PAPER_SIZES = ['A6', 'A5', 'A4', 'A3', 'A2', 'A1', 'Custom'];
const PRINT_TYPES = [
  'Screen Print',
  'Digital / DTG',
  'Sublimation',
  'Vinyl',
  'Embroidery',
  'Offset',
  'UV Print',
];
const MATERIALS = [
  'Cotton',
  'Polyester',
  'Cotton Blend',
  'Art Paper',
  'Matte',
  'Glossy',
  'Vinyl',
  'Canvas',
  'Acrylic',
  'Other',
];
const COLOR_OPTIONS = ['Full Colour', 'Black & White', 'Single Colour', 'Custom Palette'];

const cat = (id, label, icon, overrides = {}) => ({
  id,
  label,
  icon,
  description: overrides.description || '',
  minQuantity: overrides.minQuantity ?? 1,
  sizes: overrides.sizes ?? APPAREL_SIZES,
  printTypes: overrides.printTypes ?? PRINT_TYPES,
  materials: overrides.materials ?? MATERIALS,
  colorOptions: overrides.colorOptions ?? COLOR_OPTIONS,
});

const PRINT_CATEGORIES = [
  cat('tshirts', 'T-Shirts', '👕', { minQuantity: 1, description: 'Custom printed tees' }),
  cat('hoodies', 'Hoodies', '🧥', { minQuantity: 1, description: 'Hooded sweatshirts' }),
  cat('jerseys', 'Jerseys', '🎽', { minQuantity: 1, description: 'Team & sports jerseys' }),
  cat('business_cards', 'Business Cards', '💼', {
    minQuantity: 100,
    sizes: ['Standard (90x54mm)', 'Square', 'Mini', 'Custom'],
    description: 'Professional visiting cards',
  }),
  cat('posters', 'Posters', '🖼️', { minQuantity: 1, sizes: PAPER_SIZES }),
  cat('flex_banners', 'Flex Banners', '🚩', {
    minQuantity: 1,
    sizes: ['2x3 ft', '3x5 ft', '4x6 ft', '6x8 ft', 'Custom'],
    materials: ['Flex Vinyl', 'Star Flex', 'Backlit', 'Fabric'],
  }),
  cat('stickers', 'Stickers', '🏷️', {
    minQuantity: 25,
    sizes: ['Small', 'Medium', 'Large', 'Custom'],
    materials: ['Vinyl', 'Paper', 'Transparent', 'Holographic'],
  }),
  cat('invitations', 'Invitations', '💌', { minQuantity: 25, sizes: PAPER_SIZES }),
  cat('photo_prints', 'Photo Prints', '📷', {
    minQuantity: 1,
    sizes: ['4x6', '5x7', '8x10', '12x18', 'Custom'],
    materials: ['Glossy', 'Matte', 'Lustre', 'Canvas'],
  }),
  cat('documents', 'Document Printing', '📄', {
    minQuantity: 1,
    sizes: PAPER_SIZES,
    materials: ['Bond Paper', 'Art Paper', 'Matte', 'Glossy'],
    colorOptions: ['Black & White', 'Full Colour'],
    description: 'Documents, reports & xerox',
  }),
];

const PRINT_CATEGORY_IDS = PRINT_CATEGORIES.map((c) => c.id);
const isPrintCategory = (id) => PRINT_CATEGORY_IDS.includes(String(id));
const findPrintCategory = (id) => PRINT_CATEGORIES.find((c) => c.id === String(id)) || null;

// Order lifecycle for print-on-demand orders.
const PRINT_ORDER_STATUS = {
  OPEN: 'open', // broadcast, awaiting a vendor to accept
  ACCEPTED: 'accepted', // a vendor claimed it + quoted a price; awaiting customer payment
  PENDING_PAYMENT: 'pending_payment', // customer started payment
  CONFIRMED: 'confirmed', // paid — vendor can start production
  IN_PRODUCTION: 'in_production',
  READY: 'ready',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
};

// How long an open order stays broadcast before it auto-expires (minutes).
const OPEN_ORDER_TTL_MINUTES = Number(process.env.POD_OPEN_ORDER_TTL_MINUTES) || 720; // 12h

module.exports = {
  PRINT_CATEGORIES,
  PRINT_CATEGORY_IDS,
  isPrintCategory,
  findPrintCategory,
  PRINT_ORDER_STATUS,
  OPEN_ORDER_TTL_MINUTES,
  PRINT_TYPES,
  MATERIALS,
  COLOR_OPTIONS,
};
