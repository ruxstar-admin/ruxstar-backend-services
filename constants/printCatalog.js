/**
 * Print-on-demand catalog — product categories, per-category options, and
 * which fields the customer must fill for each product type.
 */

const APPAREL_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
const PAPER_SIZES = ['A6', 'A5', 'A4', 'A3', 'A2', 'A1', 'Custom'];
const APPAREL_PRINT = ['Screen Print', 'Digital / DTG', 'Sublimation', 'Vinyl', 'Embroidery'];
const PAPER_PRINT = ['Digital', 'Offset', 'UV Print'];
const COLOR_OPTIONS = ['Full Colour', 'Black & White', 'Single Colour', 'Custom Palette'];

const req = (key, label, opts = {}) => ({
  key,
  label,
  required: opts.required === true,
  hint: opts.hint || '',
});

const APPAREL_REQUIREMENTS = [
  req('size', 'Size', { required: true }),
  req('material', 'Fabric'),
  req('printType', 'Print method'),
  req('color', 'Colour'),
  req('designImage', 'Artwork / design', { hint: 'Upload logo or artwork for printing' }),
];

const cat = (id, label, icon, overrides = {}) => ({
  id,
  label,
  icon,
  description: overrides.description || '',
  minQuantity: overrides.minQuantity ?? 1,
  sizes: overrides.sizes ?? APPAREL_SIZES,
  printTypes: overrides.printTypes ?? APPAREL_PRINT,
  materials: overrides.materials ?? ['Cotton', 'Polyester', 'Cotton Blend', 'Other'],
  colorOptions: overrides.colorOptions ?? COLOR_OPTIONS,
  requirements: overrides.requirements ?? APPAREL_REQUIREMENTS,
});

const PRINT_CATEGORIES = [
  cat('tshirts', 'T-Shirts', '👕', {
    description: 'Custom printed tees',
    requirements: [
      req('size', 'T-shirt size', { required: true }),
      req('material', 'Fabric', { required: true }),
      req('printType', 'Print method'),
      req('color', 'Print colour'),
      req('designImage', 'Artwork', { required: true, hint: 'Upload your logo or graphic' }),
    ],
  }),
  cat('hoodies', 'Hoodies', '🧥', {
    description: 'Hooded sweatshirts',
    requirements: [
      req('size', 'Hoodie size', { required: true }),
      req('material', 'Fabric'),
      req('printType', 'Print / embroidery'),
      req('color', 'Garment colour'),
      req('designImage', 'Artwork', { required: true }),
    ],
  }),
  cat('jerseys', 'Jerseys', '🎽', {
    description: 'Team & sports jerseys',
    requirements: [
      req('size', 'Jersey size', { required: true }),
      req('material', 'Fabric'),
      req('printType', 'Print method', { required: true }),
      req('color', 'Primary colour'),
      req('designImage', 'Team logo / design', { required: true, hint: 'Upload logo, numbers, names layout' }),
    ],
    printTypes: ['Sublimation', 'Screen Print', 'Heat Transfer', 'Embroidery'],
  }),
  cat('business_cards', 'Business Cards', '💼', {
    minQuantity: 100,
    sizes: ['Standard (90×54 mm)', 'Square', 'Mini', 'Custom'],
    materials: ['300 GSM Art Card', '350 GSM Premium', 'Textured', 'Kraft'],
    printTypes: ['Single-sided', 'Double-sided', 'Matte lamination', 'Gloss lamination'],
    colorOptions: ['Full Colour', 'Black & White', 'Single Colour'],
    description: 'Professional visiting cards',
    requirements: [
      req('size', 'Card size', { required: true }),
      req('material', 'Paper stock', { required: true }),
      req('printType', 'Sides & finish', { required: true }),
      req('color', 'Colour mode', { required: true }),
      req('designImage', 'Card design', { required: true, hint: 'Upload front/back artwork' }),
    ],
  }),
  cat('posters', 'Posters', '🖼️', {
    minQuantity: 1,
    sizes: PAPER_SIZES,
    materials: ['Art Paper', 'Matte', 'Glossy', 'Canvas'],
    printTypes: PAPER_PRINT,
    description: 'Posters & wall prints',
    requirements: [
      req('size', 'Poster size', { required: true }),
      req('material', 'Paper / material', { required: true }),
      req('printType', 'Print type'),
      req('color', 'Colour mode'),
      req('designImage', 'Poster artwork', { required: true }),
    ],
  }),
  cat('flex_banners', 'Flex Banners', '🚩', {
    minQuantity: 1,
    sizes: ['2×3 ft', '3×5 ft', '4×6 ft', '6×8 ft', 'Custom'],
    materials: ['Flex Vinyl', 'Star Flex', 'Backlit', 'Fabric'],
    printTypes: ['Frontlit', 'Backlit', 'Star flex', 'Mesh'],
    colorOptions: ['Full Colour'],
    description: 'Outdoor & event banners',
    requirements: [
      req('size', 'Banner dimensions', { required: true }),
      req('material', 'Banner material', { required: true }),
      req('printType', 'Banner type', { required: true }),
      req('designImage', 'Banner artwork', { required: true, hint: 'High-resolution file preferred' }),
    ],
  }),
  cat('stickers', 'Stickers', '🏷️', {
    minQuantity: 25,
    sizes: ['Small (5 cm)', 'Medium (8 cm)', 'Large (12 cm)', 'Custom shape'],
    materials: ['Vinyl', 'Paper', 'Transparent', 'Holographic'],
    printTypes: ['Die-cut', 'Kiss-cut', 'Sheet stickers'],
    colorOptions: ['Full Colour', 'Single Colour', 'White ink'],
    description: 'Labels & sticker sheets',
    requirements: [
      req('size', 'Sticker size', { required: true }),
      req('material', 'Sticker material', { required: true }),
      req('printType', 'Cut type', { required: true }),
      req('color', 'Colour mode'),
      req('designImage', 'Sticker artwork', { required: true }),
    ],
  }),
  cat('invitations', 'Invitations', '💌', {
    minQuantity: 25,
    sizes: PAPER_SIZES,
    materials: ['Textured', 'Matte', 'Glossy', 'Handmade paper'],
    printTypes: ['Flat card', 'Folded card', 'With envelope'],
    colorOptions: COLOR_OPTIONS,
    description: 'Wedding & event invites',
    requirements: [
      req('size', 'Invite size', { required: true }),
      req('material', 'Paper type', { required: true }),
      req('printType', 'Card style', { required: true }),
      req('color', 'Colour theme'),
      req('designImage', 'Invite design', { required: true }),
    ],
  }),
  cat('photo_prints', 'Photo Prints', '📷', {
    minQuantity: 1,
    sizes: ['4×6 in', '5×7 in', '8×10 in', '12×18 in', 'Custom'],
    materials: ['Glossy', 'Matte', 'Lustre', 'Canvas'],
    printTypes: ['Standard print', 'Canvas wrap', 'Framed (vendor quote)'],
    colorOptions: ['Full Colour'],
    description: 'Photo lab prints',
    requirements: [
      req('size', 'Print size', { required: true }),
      req('material', 'Finish', { required: true }),
      req('printType', 'Print style'),
      req('designImage', 'Photo file', { required: true, hint: 'Upload the photo to print' }),
    ],
  }),
  cat('documents', 'Document Printing', '📄', {
    minQuantity: 1,
    sizes: PAPER_SIZES,
    materials: ['Bond paper', 'Art paper', 'Matte', 'Glossy'],
    printTypes: ['Single-sided', 'Double-sided', 'Spiral bind', 'Stapled'],
    colorOptions: ['Black & White', 'Full Colour'],
    description: 'Documents, reports & xerox',
    requirements: [
      req('size', 'Paper size', { required: true }),
      req('material', 'Paper type'),
      req('printType', 'Binding / sides', { required: true }),
      req('color', 'Print mode', { required: true }),
      req('designImage', 'Document file', { hint: 'Optional — share with vendor after accept' }),
    ],
  }),
];

const PRINT_CATEGORY_IDS = PRINT_CATEGORIES.map((c) => c.id);
const isPrintCategory = (id) => PRINT_CATEGORY_IDS.includes(String(id));
const findPrintCategory = (id) => PRINT_CATEGORIES.find((c) => c.id === String(id)) || null;

const PRINT_ORDER_STATUS = {
  OPEN: 'open',
  ACCEPTED: 'accepted',
  PENDING_PAYMENT: 'pending_payment',
  CONFIRMED: 'confirmed',
  IN_PRODUCTION: 'in_production',
  READY: 'ready',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
};

const OPEN_ORDER_TTL_MINUTES = Number(process.env.POD_OPEN_ORDER_TTL_MINUTES) || 720;

module.exports = {
  PRINT_CATEGORIES,
  PRINT_CATEGORY_IDS,
  isPrintCategory,
  findPrintCategory,
  PRINT_ORDER_STATUS,
  OPEN_ORDER_TTL_MINUTES,
};
