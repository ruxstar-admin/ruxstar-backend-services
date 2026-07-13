/**
 * Print-on-demand price calculator.
 *
 * Vendors publish fixed prices per product (no quotes). This computes the
 * customer-facing total from a vendor's CategoryPricing and a customer
 * selection. The same logic is mirrored on the frontend for live display, so
 * keep both in sync.
 *
 * Pricing models (from the catalog category `pricingModel`):
 *  - 'per_unit': total = (base [or best bulk tier] + option add-ons) * quantity
 *  - 'per_page': total = (pages * per-page rate + options) * copies (documents)
 */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Highest-threshold bulk tier the amount satisfies (overrides the base rate). */
function bestTier(tiers, amount, key) {
  if (!Array.isArray(tiers)) return null;
  let best = null;
  for (const t of tiers) {
    if (!t || !Number.isFinite(Number(t.unitPrice))) continue;
    const threshold = num(t[key]);
    if (amount >= threshold && (!best || threshold > num(best[key]))) best = t;
  }
  return best;
}

function computePerUnit(pricing, selection) {
  const quantity = Math.max(1, Math.round(num(selection.quantity)));
  const options = selection.options || {};
  const addons = pricing.addons || {};

  const tier = bestTier(pricing.tiers, quantity, 'minQty');
  const base = tier ? num(tier.unitPrice) : num(pricing.basePrice);

  let addonSum = 0;
  const addonBreakdown = [];
  for (const [dim, value] of Object.entries(options)) {
    if (value == null || value === '') continue;
    const amount = num((addons[dim] || {})[value]);
    if (amount) {
      addonSum += amount;
      addonBreakdown.push({ dim, value, amount });
    }
  }

  const unitPrice = base + addonSum;
  const total = Math.max(0, unitPrice * quantity);
  return {
    model: 'per_unit',
    quantity,
    base,
    addonSum,
    addonBreakdown,
    unitPrice,
    total,
  };
}

function computePerPage(pricing, selection) {
  const copies = Math.max(1, Math.round(num(selection.copies ?? selection.quantity ?? 1)));
  const perPage = pricing.perPage || {};
  const addons = pricing.addons || {};

  // Sections let documents mix colour modes (e.g. colour cover + B/W body).
  const sections =
    Array.isArray(selection.sections) && selection.sections.length
      ? selection.sections
      : [{ pages: num(selection.pages), color: selection.color === 'color' ? 'color' : 'bw' }];

  const paperSizeAddon = selection.paperSize ? num((addons.paperSize || {})[selection.paperSize]) : 0;
  const doubleSidedAddon = selection.doubleSided ? num(addons.doubleSided) : 0;

  let totalPages = 0;
  let pagesCost = 0;
  for (const sec of sections) {
    const pages = Math.max(0, Math.round(num(sec.pages)));
    totalPages += pages;
    const rate = sec.color === 'color' ? num(perPage.color) : num(perPage.bw);
    pagesCost += pages * (rate + paperSizeAddon + doubleSidedAddon);
  }

  // Optional bulk override: replaces the base per-page rate for all pages.
  const tier = bestTier(pricing.tiers, totalPages, 'minPages');
  if (tier) {
    pagesCost = totalPages * (num(tier.unitPrice) + paperSizeAddon + doubleSidedAddon);
  }

  const bindingPrice = selection.binding ? num((addons.binding || {})[selection.binding]) : 0;
  const perCopy = pagesCost + bindingPrice;
  const total = Math.max(0, perCopy * copies);
  return {
    model: 'per_page',
    copies,
    totalPages,
    pagesCost,
    bindingPrice,
    perCopy,
    total,
  };
}

/**
 * @param {object} category  catalog category (needs `pricingModel`)
 * @param {object} pricing   vendor CategoryPricing for that category
 * @param {object} selection customer selection
 * @returns {{ total:number, currency:string, [key:string]:any }}
 */
function computePrice(category, pricing, selection = {}) {
  if (!pricing || pricing.enabled === false) {
    return { total: 0, currency: 'INR', unavailable: true };
  }
  const model = (category && category.pricingModel) || 'per_unit';
  const result =
    model === 'per_page' ? computePerPage(pricing, selection) : computePerUnit(pricing, selection);
  result.currency = 'INR';
  return result;
}

module.exports = { computePrice };
