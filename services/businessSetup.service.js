const { randomUUID } = require('crypto');
const Business = require('../models/Business');
const photoStorage = require('./photoStorage.service');
const {
  DAYS,
  DEFAULT_WEEKLY_HOURS,
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  SETUP_MODULES,
} = require('../constants/businessSetup');

const defaultSetup = (options = {}) => {
  const bookingMode =
    options.bookingMode === 'fullDay' ? 'fullDay' : 'slots';
  return {
  photos: [],
  weeklyHours: { ...DEFAULT_WEEKLY_HOURS },
  slotMinutes: 60,
  pricePerSlot: 0,
  resources: [],
  bookingMode,
  maxGuests: null,
  venueRules: '',
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
      return out;
    })
    .filter(Boolean);
};

const normalizeBookingMode = (raw) => (raw === 'fullDay' ? 'fullDay' : 'slots');

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

const formatSetupForClient = (setup, businessId) => {
  if (!setup) return defaultSetup();
  return {
    photos: Array.isArray(setup.photos)
      ? setup.photos.map((p) => formatPhoto(p, businessId))
      : [],
    weeklyHours: setup.weeklyHours ?? { ...DEFAULT_WEEKLY_HOURS },
    slotMinutes: setup.slotMinutes ?? 60,
    pricePerSlot: setup.pricePerSlot ?? 0,
    resources: Array.isArray(setup.resources) ? setup.resources : [],
    bookingMode: normalizeBookingMode(setup.bookingMode),
    maxGuests: normalizeMaxGuests(setup.maxGuests),
    venueRules: typeof setup.venueRules === 'string' ? setup.venueRules : '',
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
  const formattedSetup = formatSetupForClient(setup, businessId);
  const thumbnailUrl =
    (typeof business.thumbnailUrl === 'string' && business.thumbnailUrl.trim()) ||
    formattedSetup.photos[0]?.url ||
    firstPhotoUrl(setup, businessId) ||
    '';
  const thumbnailPhotoId =
    (typeof business.thumbnailPhotoId === 'string' && business.thumbnailPhotoId) ||
    formattedSetup.photos[0]?.id ||
    '';
  return {
    ...rest,
    thumbnailUrl,
    ...(thumbnailPhotoId ? { thumbnailPhotoId } : {}),
    setup: formattedSetup,
  };
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

const validateReadyToComplete = (setup) => {
  const hours = setup.weeklyHours ?? {};
  const hasOpenDay = DAYS.some((day) => {
    const row = hours[day];
    return row && row.closed !== true;
  });
  if (!hasOpenDay) {
    throw Object.assign(new Error('set at least one open day'), { status: 400 });
  }

  const bookingMode = normalizeBookingMode(setup.bookingMode);
  if (bookingMode !== 'fullDay') {
    const slotMinutes = Number(setup.slotMinutes);
    if (!Number.isFinite(slotMinutes) || slotMinutes < 15 || slotMinutes > 480) {
      throw Object.assign(new Error('slot duration must be between 15 and 480 minutes'), { status: 400 });
    }
  }

  const pricePerSlot = Number(setup.pricePerSlot);
  if (!Number.isFinite(pricePerSlot) || pricePerSlot < 0) {
    throw Object.assign(new Error('price per slot must be zero or greater'), { status: 400 });
  }

  const resources = setup.resources ?? [];
  if (!resources.length) {
    throw Object.assign(new Error('add at least one bookable resource (court, room, etc.)'), { status: 400 });
  }
};

const getSetup = async (businessId, vendorId) => {
  const business = await getOwned(businessId, vendorId);
  if (!business.setup) {
    const updated = await Business.updateForVendor(businessId, vendorId, { setup: defaultSetup() });
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
  if (body.resources !== undefined) patch.resources = normalizeResources(body.resources);
  if (body.bookingMode !== undefined) patch.bookingMode = normalizeBookingMode(body.bookingMode);
  if (body.maxGuests !== undefined) patch.maxGuests = normalizeMaxGuests(body.maxGuests);
  if (body.venueRules !== undefined) {
    patch.venueRules = String(body.venueRules ?? '').trim().slice(0, 2000);
  }

  const preserveLive = business.setupComplete === true && business.status === 'live';
  const updated = await Business.updateForVendor(businessId, vendorId, {
    setup: patch,
    ...(preserveLive ? {} : { setupComplete: false, status: 'draft' }),
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

/** @deprecated use setBusinessThumbnail */
const setCreateThumbnail = setBusinessThumbnail;

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

  const updated = await Business.updateForVendor(businessId, vendorId, {
    setup: { ...current, photos },
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

  const updated = await Business.updateForVendor(businessId, vendorId, {
    setup: { ...current, photos },
  });
  return formatBusinessForClient(updated);
};

const completeSetup = async (businessId, vendorId) => {
  const business = await getOwned(businessId, vendorId);
  assertAppointmentsModule(business);

  const setup = business.setup ?? defaultSetup();
  validateReadyToComplete(setup);

  const updated = await Business.updateForVendor(businessId, vendorId, {
    setupComplete: true,
    status: 'live',
  });
  return formatBusinessForClient(updated);
};

module.exports = {
  defaultSetup,
  formatBusinessForClient,
  stripSetupPhotos,
  getSetup,
  updateSetup,
  setBusinessThumbnail,
  setCreateThumbnail,
  addPhoto,
  removePhoto,
  syncPhotos,
  completeSetup,
};
