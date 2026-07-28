const { randomUUID } = require('crypto');
const Business = require('../models/Business');
const Booking = require('../models/Booking');
const photoStorage = require('./photoStorage.service');
const {
  DAYS,
  DEFAULT_WEEKLY_HOURS,
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  SETUP_MODULES,
  isServiceType,
  MAX_SERVICES,
  MAX_STAFF,
  MAX_BUFFER_MINUTES,
  MIN_SERVICE_MINUTES,
  MAX_SERVICE_MINUTES,
  MAX_PRINT_CATEGORIES,
  MAX_PRINT_CITIES,
  MAX_TURNAROUND_DAYS,
} = require('../constants/businessSetup');
const { BUSINESS_STATUS } = require('../constants/businessStatus');
const {
  PRINT_CATEGORY_IDS,
  findPrintCategory,
  pricingDimensions,
} = require('../constants/printCatalog');
const {
  normalizePricingModel,
  normalizeEnrollmentType,
  normalizeMaxParticipants,
  normalizeClassTimings,
  normalizePriceOptions,
  servicePriceOptions,
} = require('../utils/coachingService');

const defaultPrintProfile = () => ({
  serviceCategories: [],
  cities: [],
  serveAll: false,
  turnaroundDays: 3,
  minOrderValue: 0,
  notes: '',
  acceptingOrders: true,
  pricing: {},
});

const defaultCommerceProfile = () => ({
  notes: '',
  minOrderValue: 0,
  acceptingOrders: true,
  activeProductCount: 0,
});

const MAX_MONEY = 10_000_000;
const MAX_TIERS = 10;

const clampMoney = (v) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_MONEY);
};

/** Keep only allowed option keys with a positive surcharge. */
const normalizeValueMap = (raw, allowed) => {
  const out = {};
  if (!raw || typeof raw !== 'object' || !Array.isArray(allowed)) return out;
  const allow = new Set(allowed.map(String));
  for (const [k, v] of Object.entries(raw)) {
    if (!allow.has(String(k))) continue;
    const amount = clampMoney(v);
    if (amount > 0) out[String(k)] = amount;
  }
  return out;
};

const normalizeTiers = (raw, key) => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => {
      if (!t || typeof t !== 'object') return null;
      const threshold = Math.round(Number(t[key]) || 0);
      const unitPrice = clampMoney(t.unitPrice);
      if (threshold < 2 || unitPrice <= 0) return null;
      return { [key]: threshold, unitPrice };
    })
    .filter(Boolean)
    .sort((a, b) => a[key] - b[key])
    .slice(0, MAX_TIERS);
};

/** Validate + shape one category's pricing against the catalog category. */
const normalizeCategoryPricing = (categoryId, raw) => {
  const category = findPrintCategory(categoryId);
  if (!category) return null;
  const src = raw && typeof raw === 'object' ? raw : {};
  const enabled = src.enabled !== false;
  const minQuantity = Math.max(1, Math.round(Number(src.minQuantity) || category.minQuantity || 1));
  const turnaroundDays = Math.min(
    Math.max(Math.round(Number(src.turnaroundDays) || 0), 0),
    MAX_TURNAROUND_DAYS,
  );
  const srcAddons = src.addons && typeof src.addons === 'object' ? src.addons : {};

  if (category.pricingModel === 'per_page') {
    const perPageSrc = src.perPage && typeof src.perPage === 'object' ? src.perPage : {};
    const perPage = { bw: clampMoney(perPageSrc.bw), color: clampMoney(perPageSrc.color) };
    const addons = {
      doubleSided: clampMoney(srcAddons.doubleSided),
      binding: normalizeValueMap(srcAddons.binding, category.bindingOptions || []),
      paperSize: normalizeValueMap(srcAddons.paperSize, category.sizes || []),
    };
    return {
      enabled,
      minQuantity,
      turnaroundDays,
      perPage,
      addons,
      tiers: normalizeTiers(src.tiers, 'minPages'),
    };
  }

  const basePrice = clampMoney(src.basePrice);
  const addons = {};
  for (const { key, values } of pricingDimensions(category)) {
    addons[key] = normalizeValueMap(srcAddons[key], values);
  }
  return {
    enabled,
    minQuantity,
    turnaroundDays,
    basePrice,
    addons,
    tiers: normalizeTiers(src.tiers, 'minQty'),
  };
};

/** Whether a category has a usable price so it can go live / be shown. */
const hasValidPrice = (categoryId, pricing) => {
  if (!pricing || pricing.enabled === false) return false;
  const category = findPrintCategory(categoryId);
  if (!category) return false;
  if (category.pricingModel === 'per_page') {
    return clampMoney(pricing.perPage?.bw) > 0 || clampMoney(pricing.perPage?.color) > 0;
  }
  return clampMoney(pricing.basePrice) > 0;
};

const normalizePrintProfile = (raw) => {
  const src = raw && typeof raw === 'object' ? raw : {};
  const serviceCategories = Array.isArray(src.serviceCategories)
    ? [
        ...new Set(
          src.serviceCategories
            .map((c) => String(c))
            .filter((c) => PRINT_CATEGORY_IDS.includes(c)),
        ),
      ].slice(0, MAX_PRINT_CATEGORIES)
    : [];
  const cities = Array.isArray(src.cities)
    ? [
        ...new Set(
          src.cities
            .map((c) => String(c ?? '').trim().toLowerCase())
            .filter(Boolean),
        ),
      ].slice(0, MAX_PRINT_CITIES)
    : [];
  const serveAll = src.serveAll === true;
  const turnaroundDays = Math.min(
    Math.max(Math.round(Number(src.turnaroundDays) || 0), 0),
    MAX_TURNAROUND_DAYS,
  );
  const minOrderValue = Math.max(Math.round(Number(src.minOrderValue) || 0), 0);
  const notes = String(src.notes ?? '').trim().slice(0, 1000);
  const acceptingOrders = src.acceptingOrders !== false;
  const pricingSrc = src.pricing && typeof src.pricing === 'object' ? src.pricing : {};
  const pricing = {};
  for (const catId of serviceCategories) {
    if (pricingSrc[catId] === undefined) continue;
    const norm = normalizeCategoryPricing(catId, pricingSrc[catId]);
    if (norm) pricing[catId] = norm;
  }
  return {
    serviceCategories,
    cities,
    serveAll,
    turnaroundDays,
    minOrderValue,
    notes,
    acceptingOrders,
    pricing,
  };
};

const defaultSetup = (options = {}) => {
  const bookingMode = isServiceType(options.typeId)
    ? 'services'
    : options.bookingMode === 'fullDay'
      ? 'fullDay'
      : 'slots';
  return {
  photos: [],
  weeklyHours: { ...DEFAULT_WEEKLY_HOURS },
  slotMinutes: 60,
  pricePerSlot: 0,
  resources: [],
  services: [],
  staff: [],
  bufferMinutes: 0,
  bookingMode,
  maxGuests: null,
  venueRules: '',
  printProfile: defaultPrintProfile(),
  commerceProfile: defaultCommerceProfile(),
};
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const parseImage = (imageBase64) => {
  const match = String(imageBase64).match(/^data:(image\/\w+);base64,(.+)$/);
  const mimeType = match?.[1] || 'image/jpeg';
  const raw = (match?.[2] ?? String(imageBase64)).replace(/^data:image\/\w+;base64,/, '').trim();
  if (!raw) throw Object.assign(new Error('image required'), { status: 400 });
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) throw Object.assign(new Error('invalid image data'), { status: 400 });
  if (buffer.length > MAX_PHOTO_BYTES) {
    throw Object.assign(new Error('image too large (max 3MB)'), { status: 413 });
  }
  if (!mimeType.startsWith('image/')) {
    throw Object.assign(new Error('only image uploads are allowed'), { status: 400 });
  }
  return { mimeType, data: raw };
};

const normalizeWeeklyHours = (raw) => {
  if (!raw || typeof raw !== 'object') {
    throw Object.assign(new Error('weeklyHours required'), { status: 400 });
  }

  const weeklyHours = {};
  for (const day of DAYS) {
    const row = raw[day];
    if (!row || typeof row !== 'object') {
      weeklyHours[day] = { ...DEFAULT_WEEKLY_HOURS[day] };
      continue;
    }

    const closed = row.closed === true;
    const open = String(row.open ?? DEFAULT_WEEKLY_HOURS[day].open).trim();
    const close = String(row.close ?? DEFAULT_WEEKLY_HOURS[day].close).trim();

    if (!closed) {
      if (!TIME_RE.test(open) || !TIME_RE.test(close)) {
        throw Object.assign(new Error(`invalid hours for ${day}`), { status: 400 });
      }
      if (open >= close) {
        throw Object.assign(new Error(`${day}: open time must be before close time`), { status: 400 });
      }
    }

    weeklyHours[day] = closed ? { closed: true, open: '09:00', close: '21:00' } : { closed: false, open, close };
  }

  return weeklyHours;
};

const normalizeResources = (raw) => {
  if (!Array.isArray(raw)) throw Object.assign(new Error('resources must be an array'), { status: 400 });
  if (raw.length > 20) throw Object.assign(new Error('maximum 20 resources allowed'), { status: 400 });

  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const name = String(item.name ?? '').trim();
      if (!name) return null;
      const id = String(item.id ?? '').trim() || randomUUID();
      const out = { id, name: name.slice(0, 80) };
      if (item.capacity != null && item.capacity !== '') {
        const capacity = Math.round(Number(item.capacity));
        if (Number.isFinite(capacity) && capacity > 0) out.capacity = capacity;
      }
      const description = String(item.description ?? '').trim();
      if (description) out.description = description.slice(0, 500);
      if (item.pricePerSlot != null && item.pricePerSlot !== '') {
        const pricePerSlot = Math.round(Number(item.pricePerSlot));
        if (!Number.isFinite(pricePerSlot) || pricePerSlot < 0) return null;
        out.pricePerSlot = pricePerSlot;
      }
      return out;
    })
    .filter(Boolean);
};

const normalizeBookingMode = (raw) =>
  raw === 'fullDay' ? 'fullDay' : raw === 'services' ? 'services' : 'slots';

const normalizeStaff = (raw) => {
  if (!Array.isArray(raw)) throw Object.assign(new Error('staff must be an array'), { status: 400 });
  if (raw.length > MAX_STAFF) {
    throw Object.assign(new Error(`maximum ${MAX_STAFF} staff members allowed`), { status: 400 });
  }
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const name = String(item.name ?? '').trim();
      if (!name) return null;
      const id = String(item.id ?? '').trim() || randomUUID();
      const role = String(item.role ?? '').trim();
      return { id, name: name.slice(0, 80), ...(role ? { role: role.slice(0, 80) } : {}) };
    })
    .filter(Boolean);
};

const normalizeServices = (raw, staff = []) => {
  if (!Array.isArray(raw)) throw Object.assign(new Error('services must be an array'), { status: 400 });
  if (raw.length > MAX_SERVICES) {
    throw Object.assign(new Error(`maximum ${MAX_SERVICES} services allowed`), { status: 400 });
  }
  const staffIdSet = new Set(staff.map((s) => s.id));
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const name = String(item.name ?? '').trim();
      if (!name) return null;
      const id = String(item.id ?? '').trim() || randomUUID();

      const durationMinutes = Math.round(Number(item.durationMinutes));
      if (!Number.isFinite(durationMinutes) || durationMinutes < MIN_SERVICE_MINUTES || durationMinutes > MAX_SERVICE_MINUTES) {
        throw Object.assign(
          new Error(`"${name}" needs a duration between ${MIN_SERVICE_MINUTES} and ${MAX_SERVICE_MINUTES} minutes`),
          { status: 400 },
        );
      }

      const price = Math.round(Number(item.price));
      if (!Number.isFinite(price) || price < 0) {
        throw Object.assign(new Error(`"${name}" needs a valid price`), { status: 400 });
      }

      const staffIds = Array.isArray(item.staffIds)
        ? [...new Set(item.staffIds.map((x) => String(x)).filter((x) => staffIdSet.has(x)))]
        : [];

      const description = String(item.description ?? '').trim();
      const pricingModel = normalizePricingModel(item.pricingModel);
      const enrollmentType = normalizeEnrollmentType(item.enrollmentType);
      const maxParticipants = normalizeMaxParticipants(item.maxParticipants, enrollmentType);
      const classTimings = normalizeClassTimings(item.classTimings);

      if ((enrollmentType === 'batch' || enrollmentType === 'monthly') && !classTimings.length) {
        throw Object.assign(
          new Error(`"${name}" needs at least one class timing for batch/monthly enrollment`),
          { status: 400 },
        );
      }

      // A class can offer several payment options at once (hourly / daily /
      // weekly / monthly), each with its own vendor-set price. All types are
      // allowed on any class — a monthly/weekly pass simply grants access for
      // that period, whether or not the class has a fixed weekly schedule.
      let priceOptions = normalizePriceOptions(item.priceOptions, { price, pricingModel });
      if (!priceOptions.length) priceOptions = [{ pricingModel: 'per_session', price }];
      const primaryOption = priceOptions[0];

      return {
        id,
        name: name.slice(0, 80),
        durationMinutes,
        price: primaryOption.price,
        staffIds,
        ...(description ? { description: description.slice(0, 300) } : {}),
        ...(primaryOption.pricingModel !== 'per_session' ? { pricingModel: primaryOption.pricingModel } : {}),
        ...(enrollmentType !== 'open' ? { enrollmentType } : {}),
        ...(maxParticipants > 1 ? { maxParticipants } : {}),
        ...(classTimings.length ? { classTimings } : {}),
        ...(priceOptions.length > 1 ? { priceOptions } : {}),
      };
    })
    .filter(Boolean);
};

const normalizeBufferMinutes = (raw) => {
  if (raw === null || raw === undefined || raw === '') return 0;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_BUFFER_MINUTES);
};

const normalizeMaxGuests = (raw) => {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
};

const formatPhoto = (photo, businessId) => {
  const id = photo.id;
  const mimeType = photo.mimeType || 'image/jpeg';
  let url = photo.url;
  // Prefer fresh URL when file lives in GCS (fixes stale /api/public paths after deploy)
  if (photo.storageKey && businessId && id) {
    url = photoStorage.apiPhotoPath(String(businessId), id);
  } else if (!url && photo.storageKey && businessId) {
    url = photoStorage.apiPhotoPath(String(businessId), id);
  } else if (!url && businessId && id) {
    url = photoStorage.apiPhotoPath(String(businessId), id);
  }
  if (!url && photo.data) {
    url = `data:${mimeType};base64,${photo.data}`;
  }
  return {
    id,
    mimeType,
    url: url || '',
    createdAt: photo.createdAt,
  };
};

const formatSetupForClient = (setup, businessId, typeId) => {
  if (!setup) return defaultSetup({ typeId });
  return {
    photos: Array.isArray(setup.photos)
      ? setup.photos.map((p) => formatPhoto(p, businessId))
      : [],
    weeklyHours: setup.weeklyHours ?? { ...DEFAULT_WEEKLY_HOURS },
    slotMinutes: setup.slotMinutes ?? 60,
    pricePerSlot: setup.pricePerSlot ?? 0,
    resources: Array.isArray(setup.resources) ? setup.resources : [],
    services: Array.isArray(setup.services) ? setup.services : [],
    staff: Array.isArray(setup.staff) ? setup.staff : [],
    bufferMinutes: normalizeBufferMinutes(setup.bufferMinutes),
    // Service-first types always report `services` mode to clients, regardless
    // of any legacy value stored before the model switch.
    bookingMode: isServiceType(typeId) ? 'services' : normalizeBookingMode(setup.bookingMode),
    maxGuests: normalizeMaxGuests(setup.maxGuests),
    venueRules: typeof setup.venueRules === 'string' ? setup.venueRules : '',
    printProfile: setup.printProfile
      ? { ...defaultPrintProfile(), ...setup.printProfile }
      : defaultPrintProfile(),
    commerceProfile: setup.commerceProfile
      ? { ...defaultCommerceProfile(), ...setup.commerceProfile }
      : defaultCommerceProfile(),
  };
};

const firstPhotoUrl = (setup, businessId) => {
  const photos = Array.isArray(setup?.photos) ? setup.photos : [];
  if (!photos.length) return '';
  return formatPhoto(photos[0], businessId).url || '';
};

const formatBusinessForClient = (business) => {
  if (!business) return business;
  const { setup, ...rest } = business;
  const businessId = business._id ?? business.id;
  const formattedSetup = formatSetupForClient(setup, businessId, business.typeId);
  const thumbnailUrl =
    (typeof business.thumbnailUrl === 'string' && business.thumbnailUrl.trim()) ||
    formattedSetup.photos[0]?.url ||
    firstPhotoUrl(setup, businessId) ||
    '';
  const thumbnailPhotoId =
    (typeof business.thumbnailPhotoId === 'string' && business.thumbnailPhotoId) ||
    formattedSetup.photos[0]?.id ||
    '';
  const out = {
    ...rest,
    thumbnailUrl,
    ...(thumbnailPhotoId ? { thumbnailPhotoId } : {}),
    setup: formattedSetup,
  };
  // Readiness only means something for modules that have a setup flow.
  if (SETUP_MODULES.includes(business.module)) {
    const issues = collectGoLiveIssues(out, formattedSetup);
    out.readiness = { ready: issues.length === 0, issues };
  }
  return out;
};

const stripSetupPhotos = (business) => {
  if (!business?.setup?.photos) return business;
  const businessId = String(business._id ?? business.id ?? '');
  return {
    ...business,
    setup: {
      ...business.setup,
      photos: business.setup.photos.map((photo) => {
        const { id, mimeType, createdAt, url, storageKey } = photo;
        const formatted = formatPhoto(photo, businessId);
        return {
          id,
          mimeType,
          createdAt,
          url: formatted.url || url,
          ...(storageKey ? { storageKey } : {}),
        };
      }),
    },
  };
};

const getOwned = async (businessId, vendorId) => {
  const business = await Business.findByIdForVendor(businessId, vendorId);
  if (!business) throw Object.assign(new Error('business not found'), { status: 404 });
  return business;
};

const assertAppointmentsModule = (business) => {
  if (!SETUP_MODULES.includes(business.module)) {
    throw Object.assign(new Error('setup not available for this business type yet'), { status: 400 });
  }
};

const resourcePrice = (resource, setup) => {
  const p = Number(resource?.pricePerSlot);
  if (Number.isFinite(p) && p >= 0) return Math.round(p);
  return Math.round(Number(setup?.pricePerSlot) || 0);
};

// ── Go-live readiness ──────────────────────────────────────────────────────
// Collects EVERY unmet requirement instead of throwing on the first one, so the
// vendor sees a complete checklist rather than fixing issues one refresh at a
// time. Each issue is { step, field, message } — `step` maps to a setup wizard
// step so the UI can deep-link the vendor straight to the fix.

const TEN_DIGITS = /^\d{10}$/;

const hasText = (v) => Boolean(String(v ?? '').trim());

// The highest price a service can be booked at, across all of its payment
// options (coaching classes can price hourly/daily/weekly/monthly at once).
const bestServicePrice = (service) => {
  const options = servicePriceOptions(service);
  return options.reduce((max, o) => Math.max(max, Math.round(Number(o.price) || 0)), 0);
};

const collectProfileIssues = (business, setup, add) => {
  if (!hasText(business.address)) {
    add('profile', 'address', 'Add your business address so customers know where to find you');
  }
  if (!TEN_DIGITS.test(String(business.phone ?? '').replace(/\D/g, '').slice(-10))) {
    add('profile', 'phone', 'Add a valid 10-digit contact number');
  }
  if (!hasText(business.description)) {
    add('profile', 'description', 'Add a short description of your business');
  }
  // A cover image OR at least one gallery photo — customers will not book a
  // listing with no imagery at all.
  const hasCover = hasText(business.thumbnailUrl);
  const hasGallery = Array.isArray(setup.photos) && setup.photos.length > 0;
  if (!hasCover && !hasGallery) {
    add('photos', 'photos', 'Add at least one photo of your business');
  }
};

const collectPrintIssues = (setup, add) => {
  const profile = setup.printProfile || defaultPrintProfile();
  if (!profile.serviceCategories.length) {
    add('printProfile', 'serviceCategories', 'Select at least one print category you offer');
  }
  if (!profile.serveAll && !profile.cities.length) {
    add('printProfile', 'cities', 'Add at least one service city or enable "serve everywhere"');
  }
  const pricing = profile.pricing || {};
  for (const catId of profile.serviceCategories) {
    if (!hasValidPrice(catId, pricing[catId])) {
      const category = findPrintCategory(catId);
      add('printPricing', `pricing.${catId}`, `Set a price for "${category ? category.label : catId}"`);
    }
  }
};

const collectCommerceIssues = (setup, add) => {
  const profile = setup.commerceProfile || defaultCommerceProfile();
  const count = Math.round(Number(profile.activeProductCount) || 0);
  if (count < 1) {
    add('products', 'products', 'Add at least one product before going live');
  }
};

const normalizeCommerceProfile = (raw, existing = {}) => {
  const base = { ...defaultCommerceProfile(), ...existing };
  if (!raw || typeof raw !== 'object') return base;
  const notes = String(raw.notes ?? base.notes ?? '').trim().slice(0, 1000);
  let minOrderValue = Math.round(Number(raw.minOrderValue));
  if (!Number.isFinite(minOrderValue) || minOrderValue < 0) minOrderValue = 0;
  const acceptingOrders =
    raw.acceptingOrders === undefined ? base.acceptingOrders !== false : raw.acceptingOrders !== false;
  // Product count is maintained by product.service — never overwrite from client.
  const activeProductCount = Math.round(Number(base.activeProductCount) || 0);
  return { notes, minOrderValue, acceptingOrders, activeProductCount };
};

const collectServiceIssues = (setup, add) => {
  const staff = Array.isArray(setup.staff) ? setup.staff : [];
  const services = Array.isArray(setup.services) ? setup.services : [];
  if (!staff.length) add('staff', 'staff', 'Add at least one staff member');
  if (!services.length) {
    add('services', 'services', 'Add at least one service');
    return;
  }
  const staffIds = new Set(staff.map((s) => s.id));
  for (const service of services) {
    const label = service.name || 'service';
    const duration = Math.round(Number(service.durationMinutes));
    if (!Number.isFinite(duration) || duration < MIN_SERVICE_MINUTES) {
      add('services', `service.${service.id}.duration`, `"${label}" needs a valid duration`);
    }
    if (bestServicePrice(service) <= 0) {
      add('services', `service.${service.id}.price`, `"${label}" needs a price above ₹0`);
    }
    const assigned = (service.staffIds ?? []).filter((id) => staffIds.has(id));
    if (!assigned.length) {
      add('services', `service.${service.id}.staffIds`, `Assign at least one staff member to "${label}"`);
    }
  }
};

const collectResourceIssues = (setup, add) => {
  const bookingMode = normalizeBookingMode(setup.bookingMode);
  if (bookingMode !== 'fullDay') {
    const slotMinutes = Number(setup.slotMinutes);
    if (!Number.isFinite(slotMinutes) || slotMinutes < 15 || slotMinutes > 480) {
      add('hours', 'slotMinutes', 'Slot duration must be between 15 and 480 minutes');
    }
  }

  const resources = setup.resources ?? [];
  if (!resources.length) {
    add('resources', 'resources', 'Add at least one bookable resource (court, hall, room)');
    return;
  }
  for (const resource of resources) {
    const price = resourcePrice(resource, setup);
    if (!Number.isFinite(price) || price <= 0) {
      add('resources', `resource.${resource.id}.price`, `"${resource.name || 'Resource'}" needs a price above ₹0`);
    }
  }
};

/** Every unmet go-live requirement for a business. Empty array = ready. */
const collectGoLiveIssues = (business, setup) => {
  const issues = [];
  const add = (step, field, message) => issues.push({ step, field, message });

  collectProfileIssues(business, setup, add);

  if (business.module === 'print') {
    collectPrintIssues(setup, add);
    return issues;
  }

  if (business.module === 'commerce') {
    collectCommerceIssues(setup, add);
    return issues;
  }

  const hours = setup.weeklyHours ?? {};
  const hasOpenDay = DAYS.some((day) => {
    const row = hours[day];
    return row && row.closed !== true;
  });
  if (!hasOpenDay) add('hours', 'weeklyHours', 'Set at least one open day');

  if (isServiceType(business.typeId)) collectServiceIssues(setup, add);
  else collectResourceIssues(setup, add);

  return issues;
};

/** Throws a 400 carrying the full issue list when the business is not ready. */
const assertReadyToComplete = (business, setup) => {
  const issues = collectGoLiveIssues(business, setup);
  if (!issues.length) return;
  throw Object.assign(new Error(issues[0].message), { status: 400, issues });
};

// A completed business editing its setup must still clear the go-live gate. The
// edit is always kept (the vendor may be mid-change), but if it no longer
// qualifies we take the listing offline rather than leave it publicly bookable.
const OFFLINE_PATCH = { setupComplete: false, status: BUSINESS_STATUS.DRAFT };

const statusPatchForSetupEdit = (business, nextSetup) => {
  if (business.setupComplete !== true) return OFFLINE_PATCH;
  return collectGoLiveIssues(business, nextSetup).length ? OFFLINE_PATCH : {};
};

// Same rule for profile edits (name/phone/address/description), which live in
// the business document rather than in `setup`.
const revalidateAfterProfileEdit = async (business, vendorId) => {
  if (business.status !== BUSINESS_STATUS.LIVE || !SETUP_MODULES.includes(business.module)) {
    return business;
  }
  const setup = business.setup ?? defaultSetup({ typeId: business.typeId });
  if (!collectGoLiveIssues(business, setup).length) return business;
  const businessId = String(business._id ?? business.id);
  return (await Business.updateForVendor(businessId, vendorId, OFFLINE_PATCH)) ?? business;
};

const getSetup = async (businessId, vendorId) => {
  const business = await getOwned(businessId, vendorId);
  if (!business.setup) {
    const updated = await Business.updateForVendor(businessId, vendorId, {
      setup: defaultSetup({ typeId: business.typeId }),
    });
    return formatBusinessForClient(updated);
  }
  return formatBusinessForClient(business);
};

const updateSetup = async (businessId, vendorId, body) => {
  const business = await getOwned(businessId, vendorId);
  assertAppointmentsModule(business);

  const current = business.setup ?? defaultSetup();
  const patch = { ...current };

  if (body.weeklyHours !== undefined) patch.weeklyHours = normalizeWeeklyHours(body.weeklyHours);
  if (body.slotMinutes !== undefined) {
    const bookingMode = normalizeBookingMode(patch.bookingMode ?? current.bookingMode);
    if (bookingMode !== 'fullDay') {
      const slotMinutes = Number(body.slotMinutes);
      if (!Number.isFinite(slotMinutes) || slotMinutes < 15 || slotMinutes > 480) {
        throw Object.assign(new Error('slot duration must be between 15 and 480 minutes'), { status: 400 });
      }
      patch.slotMinutes = Math.round(slotMinutes);
    }
  }
  if (body.pricePerSlot !== undefined) {
    const pricePerSlot = Number(body.pricePerSlot);
    if (!Number.isFinite(pricePerSlot) || pricePerSlot < 0) {
      throw Object.assign(new Error('price per slot must be zero or greater'), { status: 400 });
    }
    patch.pricePerSlot = Math.round(pricePerSlot);
  }
  if (body.resources !== undefined) {
    patch.resources = normalizeResources(body.resources);
    const prices = patch.resources.map((r) => resourcePrice(r, patch));
    if (prices.length) patch.pricePerSlot = Math.min(...prices);
  }
  if (body.staff !== undefined) patch.staff = normalizeStaff(body.staff);
  if (body.services !== undefined) {
    const staffForServices = Array.isArray(patch.staff) ? patch.staff : [];
    patch.services = normalizeServices(body.services, staffForServices);
  }
  if (body.bufferMinutes !== undefined) patch.bufferMinutes = normalizeBufferMinutes(body.bufferMinutes);
  if (body.bookingMode !== undefined) {
    const nextMode = normalizeBookingMode(body.bookingMode);
    const currentMode = normalizeBookingMode(current.bookingMode);
    // Switching hourly ↔ full-day changes what every existing slot means, so it
    // is only allowed while nobody holds a future booking.
    if (nextMode !== currentMode && !isServiceType(business.typeId)) {
      const upcoming = await Booking.countUpcomingActive(businessId);
      if (upcoming > 0) {
        throw Object.assign(
          new Error(
            `cannot change booking style with ${upcoming} upcoming booking${upcoming === 1 ? '' : 's'} — cancel or wait for them to finish`,
          ),
          { status: 400 },
        );
      }
    }
    patch.bookingMode = nextMode;
  }
  if (body.maxGuests !== undefined) patch.maxGuests = normalizeMaxGuests(body.maxGuests);
  if (body.venueRules !== undefined) {
    patch.venueRules = String(body.venueRules ?? '').trim().slice(0, 2000);
  }
  if (body.printProfile !== undefined) {
    patch.printProfile = normalizePrintProfile(body.printProfile);
  }
  if (body.commerceProfile !== undefined) {
    patch.commerceProfile = normalizeCommerceProfile(body.commerceProfile, current.commerceProfile);
  }

  const updated = await Business.updateForVendor(businessId, vendorId, {
    setup: patch,
    ...statusPatchForSetupEdit(business, patch),
  });
  return formatBusinessForClient(updated);
};

const buildPhotoDoc = async (businessId, imageBase64) => {
  const { mimeType, data } = parseImage(imageBase64);
  const buffer = Buffer.from(data, 'base64');
  const photoId = randomUUID();
  const createdAt = new Date().toISOString();

  const { storageKey, url } = await photoStorage.uploadBusinessPhoto(
    businessId,
    photoId,
    buffer,
    mimeType,
  );

  return {
    id: photoId,
    mimeType,
    createdAt,
    url,
    ...(storageKey ? { storageKey } : {}),
    ...(photoStorage.isEnabled() ? {} : { data }),
  };
};

/** Profile thumbnail — works for every business module (not only appointments). */
const setBusinessThumbnail = async (businessId, vendorId, imageBase64) => {
  const business = await getOwned(businessId, vendorId);
  const current = business.setup ?? defaultSetup();
  const photos = Array.isArray(current.photos) ? [...current.photos] : [];

  const photoDoc = await buildPhotoDoc(businessId, imageBase64);
  const thumbnailUrl = formatPhoto(photoDoc, businessId).url;

  if (photos.length > 0) {
    const old = photos[0];
    if (old?.storageKey) await photoStorage.deleteBusinessPhoto(old.storageKey);
    photos[0] = photoDoc;
  } else {
    photos.push(photoDoc);
  }

  const updated = await Business.updateForVendor(businessId, vendorId, {
    setup: { ...current, photos },
    thumbnailUrl,
    thumbnailPhotoId: photoDoc.id,
  });
  return formatBusinessForClient(updated);
};

const addPhoto = async (businessId, vendorId, imageBase64) => {
  const business = await getOwned(businessId, vendorId);
  assertAppointmentsModule(business);

  const current = business.setup ?? defaultSetup();
  const photos = Array.isArray(current.photos) ? [...current.photos] : [];
  if (photos.length >= MAX_PHOTOS) {
    throw Object.assign(new Error(`maximum ${MAX_PHOTOS} photos allowed`), { status: 400 });
  }

  const photoDoc = await buildPhotoDoc(businessId, imageBase64);

  photos.push(photoDoc);

  const updated = await Business.updateForVendor(businessId, vendorId, {
    setup: { ...current, photos },
  });
  return formatBusinessForClient(updated);
};

const removePhoto = async (businessId, vendorId, photoId) => {
  const business = await getOwned(businessId, vendorId);
  assertAppointmentsModule(business);

  const current = business.setup ?? defaultSetup();
  const photos = (current.photos ?? []).filter((p) => p.id !== photoId);
  if (photos.length === (current.photos ?? []).length) {
    throw Object.assign(new Error('photo not found'), { status: 404 });
  }

  const removed = (current.photos ?? []).find((p) => p.id === photoId);
  if (removed?.storageKey) {
    await photoStorage.deleteBusinessPhoto(removed.storageKey);
  }

  const nextSetup = { ...current, photos };
  const updated = await Business.updateForVendor(businessId, vendorId, {
    setup: nextSetup,
    ...statusPatchForSetupEdit(business, nextSetup),
  });
  return formatBusinessForClient(updated);
};

/** Apply photo adds/removes in one request — parallel GCS uploads, single DB write. */
const syncPhotos = async (businessId, vendorId, { images = [], removeIds = [] } = {}) => {
  const business = await getOwned(businessId, vendorId);
  assertAppointmentsModule(business);

  const current = business.setup ?? defaultSetup();
  let photos = Array.isArray(current.photos) ? [...current.photos] : [];
  const removeSet = new Set(removeIds.map(String));

  const toRemove = photos.filter((p) => removeSet.has(String(p.id)));
  photos = photos.filter((p) => !removeSet.has(String(p.id)));

  if (toRemove.length) {
    await Promise.all(
      toRemove
        .filter((p) => p.storageKey)
        .map((p) => photoStorage.deleteBusinessPhoto(p.storageKey)),
    );
  }

  const incoming = Array.isArray(images) ? images : [];
  const slotsLeft = MAX_PHOTOS - photos.length;
  if (incoming.length > slotsLeft) {
    throw Object.assign(new Error(`maximum ${MAX_PHOTOS} photos allowed`), { status: 400 });
  }

  if (incoming.length) {
    const newDocs = await Promise.all(
      incoming.map((image) => buildPhotoDoc(businessId, image)),
    );
    photos.push(...newDocs);
  }

  const nextSetup = { ...current, photos };
  const updated = await Business.updateForVendor(businessId, vendorId, {
    setup: nextSetup,
    ...statusPatchForSetupEdit(business, nextSetup),
  });
  return formatBusinessForClient(updated);
};

/** Fast operational toggle — does not reset the business's live status. */
const setAcceptingOrders = async (businessId, vendorId, accepting) => {
  const business = await getOwned(businessId, vendorId);
  if (business.module !== 'print') {
    throw Object.assign(new Error('only print shops can toggle order availability'), { status: 400 });
  }
  const current = business.setup ?? defaultSetup({ typeId: business.typeId });
  const printProfile = {
    ...defaultPrintProfile(),
    ...(current.printProfile || {}),
    acceptingOrders: accepting === true,
  };
  const updated = await Business.updateForVendor(businessId, vendorId, {
    setup: { ...current, printProfile },
  });
  return formatBusinessForClient(updated);
};

const completeSetup = async (businessId, vendorId) => {
  const business = await getOwned(businessId, vendorId);
  assertAppointmentsModule(business);

  const setup = business.setup ?? defaultSetup({ typeId: business.typeId });
  assertReadyToComplete(business, setup);

  const updated = await Business.updateForVendor(businessId, vendorId, {
    setupComplete: true,
    status: BUSINESS_STATUS.LIVE,
  });
  return formatBusinessForClient(updated);
};

// Re-publish a business that was demoted to draft by an edit that broke its
// go-live requirements. Vendors cannot take a listing offline by hand — they
// pause incoming work with the per-shop "accepting orders" switch instead.
const publish = async (businessId, vendorId) => {
  const business = await getOwned(businessId, vendorId);
  assertAppointmentsModule(business);
  if (business.status === BUSINESS_STATUS.LIVE) return formatBusinessForClient(business);

  const setup = business.setup ?? defaultSetup({ typeId: business.typeId });
  assertReadyToComplete(business, setup);

  const updated = await Business.updateForVendor(businessId, vendorId, {
    setupComplete: true,
    status: BUSINESS_STATUS.LIVE,
  });
  return formatBusinessForClient(updated);
};

module.exports = {
  defaultSetup,
  formatBusinessForClient,
  collectGoLiveIssues,
  assertReadyToComplete,
  revalidateAfterProfileEdit,
  stripSetupPhotos,
  getSetup,
  updateSetup,
  setBusinessThumbnail,
  addPhoto,
  removePhoto,
  syncPhotos,
  setAcceptingOrders,
  completeSetup,
  publish,
};
