/**
 * Print-on-demand catalog — per-product options and requirement fields.
 *
 * Requirement `type`:
 *  - select → size | material | printType | color (options from category arrays)
 *  - text | textarea → stored in attributes.extras[key]
 *  - file → designImage upload
 */

const APPAREL_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
const PAPER_SIZES = ['A6', 'A5', 'A4', 'A3', 'A2', 'A1', 'Custom'];
const APPAREL_PRINT = ['Screen Print', 'Digital / DTG', 'Sublimation', 'Vinyl', 'Embroidery'];
const PAPER_PRINT = ['Digital', 'Offset', 'UV Print'];
const COLOR_OPTIONS = ['Full Colour', 'Black & White', 'Single Colour', 'Custom Palette'];
const APPAREL_SIDES = ['Front', 'Back', 'Both'];
const DOCUMENT_BINDINGS = ['None', 'Stapled', 'Spiral bind', 'Soft cover'];

const SELECT_KEYS = new Set(['size', 'material', 'printType', 'color']);

const req = (key, label, opts = {}) => {
  let type = opts.type;
  if (!type) {
    if (key === 'designImage') type = 'file';
    else if (SELECT_KEYS.has(key)) type = 'select';
    else type = 'text';
  }
  return {
    key,
    label,
    type,
    required: opts.required === true,
    hint: opts.hint || '',
    placeholder: opts.placeholder || '',
  };
};

const cat = (id, label, icon, overrides = {}) => ({
  id,
  label,
  icon,
  description: overrides.description || '',
  // How a vendor prices this product: 'per_unit' (base + option add-ons)
  // or 'per_page' (per-page rates, used for documents).
  pricingModel: overrides.pricingModel ?? 'per_unit',
  minQuantity: overrides.minQuantity ?? 1,
  sizes: overrides.sizes ?? APPAREL_SIZES,
  printTypes: overrides.printTypes ?? APPAREL_PRINT,
  materials: overrides.materials ?? ['Cotton', 'Polyester', 'Cotton Blend', 'Other'],
  colorOptions: overrides.colorOptions ?? COLOR_OPTIONS,
  // Print sides (Front/Back/Both) — only meaningful for apparel-style products.
  sides: overrides.sides ?? null,
  // Binding options — only for per_page (document) products.
  bindingOptions: overrides.bindingOptions ?? null,
  requirements: overrides.requirements ?? [],
});

const PRINT_CATEGORIES = [
  cat('tshirts', 'T-Shirts', '👕', {
    description: 'Custom printed tees',
    sides: APPAREL_SIDES,
    requirements: [
      req('size', 'T-shirt size', { required: true }),
      req('material', 'Fabric', { required: true }),
      req('printType', 'Print method'),
      req('color', 'Print colour'),
      req('placement', 'Print placement', {
        required: true,
        placeholder: 'e.g. Front chest, full back, sleeve',
      }),
      req('designImage', 'Artwork', {
        type: 'file',
        required: true,
        hint: 'Upload your logo or graphic',
      }),
    ],
  }),
  cat('hoodies', 'Hoodies', '🧥', {
    description: 'Hooded sweatshirts',
    sides: APPAREL_SIDES,
    requirements: [
      req('size', 'Hoodie size', { required: true }),
      req('material', 'Fabric'),
      req('printType', 'Print / embroidery'),
      req('color', 'Garment colour'),
      req('placement', 'Print placement', { placeholder: 'Front, back, hood, sleeve…' }),
      req('designImage', 'Artwork', { type: 'file', required: true }),
    ],
  }),
  cat('jerseys', 'Jerseys', '🎽', {
    description: 'Team & sports jerseys',
    printTypes: ['Sublimation', 'Screen Print', 'Heat Transfer', 'Embroidery'],
    sides: APPAREL_SIDES,
    requirements: [
      req('size', 'Jersey size', { required: true }),
      req('material', 'Fabric', { required: true }),
      req('printType', 'Print method', { required: true }),
      req('color', 'Primary colour'),
      req('teamName', 'Team / club name', { required: true, placeholder: 'Team or academy name' }),
      req('playerDetails', 'Names & numbers', {
        type: 'textarea',
        placeholder: 'Player names, numbers, sizes (one per line)',
      }),
      req('designImage', 'Team logo / design', {
        type: 'file',
        required: true,
        hint: 'Upload logo and layout reference',
      }),
    ],
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
      req('contactDetails', 'Contact info to print', {
        type: 'textarea',
        required: true,
        placeholder: 'Name, phone, email, address, website…',
      }),
      req('designImage', 'Card design', {
        type: 'file',
        required: true,
        hint: 'Upload front/back artwork',
      }),
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
      req('finishing', 'Finishing', { placeholder: 'Lamination, mounting, eyelets…' }),
      req('designImage', 'Poster artwork', { type: 'file', required: true }),
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
      req('customDimensions', 'Exact size (if custom)', {
        placeholder: 'Width × height in feet or metres',
      }),
      req('installation', 'Installation needs', {
        placeholder: 'Eyelets, pole pockets, rope, stand…',
      }),
      req('designImage', 'Banner artwork', {
        type: 'file',
        required: true,
        hint: 'High-resolution file preferred',
      }),
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
      req('shape', 'Shape / outline', { placeholder: 'Circle, rectangle, custom die-cut…' }),
      req('designImage', 'Sticker artwork', { type: 'file', required: true }),
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
      req('eventDate', 'Event date', { required: true, placeholder: 'Date and time of event' }),
      req('eventDetails', 'Event wording', {
        type: 'textarea',
        placeholder: 'Names, venue, RSVP line…',
      }),
      req('designImage', 'Invite design', { type: 'file', required: true }),
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
      req('cropNotes', 'Crop / border instructions', {
        placeholder: 'Full bleed, white border, crop area…',
      }),
      req('designImage', 'Photo file', {
        type: 'file',
        required: true,
        hint: 'Upload the photo to print',
      }),
    ],
  }),
  cat('documents', 'Document Printing', '📄', {
    pricingModel: 'per_page',
    minQuantity: 1,
    sizes: PAPER_SIZES,
    materials: ['Bond paper', 'Art paper', 'Matte', 'Glossy'],
    printTypes: ['Single-sided', 'Double-sided', 'Spiral bind', 'Stapled'],
    colorOptions: ['Black & White', 'Full Colour'],
    bindingOptions: DOCUMENT_BINDINGS,
    description: 'Documents, reports & xerox',
    requirements: [
      req('size', 'Paper size', { required: true }),
      req('printType', 'Binding / sides', { required: true }),
      req('color', 'Print mode', { required: true }),
      req('pageCount', 'Number of pages', {
        required: true,
        placeholder: 'Total pages to print',
      }),
      req('designImage', 'Document scan', {
        type: 'file',
        hint: 'Optional — you can share files with the vendor later',
      }),
    ],
  }),
];

const PRINT_CATEGORY_IDS = PRINT_CATEGORIES.map((c) => c.id);
const isPrintCategory = (id) => PRINT_CATEGORY_IDS.includes(String(id));
const findPrintCategory = (id) => PRINT_CATEGORIES.find((c) => c.id === String(id)) || null;
const printPricingModel = (id) => {
  const c = findPrintCategory(id);
  return c ? c.pricingModel : 'per_unit';
};

// Priceable option dimensions for a per_unit category, mapping the pricing key
// to the list of valid values (used to validate & render add-on surcharges).
const PRICING_DIMENSIONS = [
  { key: 'sides', field: 'sides' },
  { key: 'size', field: 'sizes' },
  { key: 'printType', field: 'printTypes' },
  { key: 'material', field: 'materials' },
  { key: 'color', field: 'colorOptions' },
];
const pricingDimensions = (category) => {
  if (!category) return [];
  const out = [];
  for (const d of PRICING_DIMENSIONS) {
    const values = category[d.field];
    if (Array.isArray(values) && values.length) out.push({ key: d.key, values });
  }
  return out;
};

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
  printPricingModel,
  pricingDimensions,
  PRINT_ORDER_STATUS,
  OPEN_ORDER_TTL_MINUTES,
  SELECT_KEYS,
};
