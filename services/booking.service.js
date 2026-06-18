const { randomUUID } = require('crypto');
const { withTransaction } = require('../config/database');
const Business = require('../models/Business');
const Booking = require('../models/Booking');
const BusinessSlotState = require('../models/BusinessSlotState');
const User = require('../models/User');
const setupService = require('./businessSetup.service');
const photoStorage = require('./photoStorage.service');
const {
  getLiveBusiness,
  buildSlotsPayload,
  assertSlotForBooking,
} = require('./businessSlots.service');

const formatPublicBusiness = (business) => {
  const formatted = setupService.formatBusinessForClient(business);
  const setup = formatted.setup ?? {};
  return {
    id: String(formatted._id),
    name: formatted.name,
    typeId: formatted.typeId,
    typeLabel: formatted.typeLabel,
    categoryId: formatted.categoryId,
    categoryLabel: formatted.categoryLabel,
    module: formatted.module,
    phone: formatted.phone ?? '',
    address: formatted.address ?? '',
    description: formatted.description ?? '',
    setup: {
      photos: setup.photos ?? [],
      slotMinutes: setup.slotMinutes ?? 60,
      pricePerSlot: setup.pricePerSlot ?? 0,
      resources: setup.resources ?? [],
      bookingMode: setup.bookingMode === 'fullDay' ? 'fullDay' : 'slots',
      maxGuests: setup.maxGuests ?? null,
      venueRules: setup.venueRules ?? '',
    },
  };
};

const resolvePublicCoverUrl = (business) => {
  const businessId = String(business._id ?? business.id ?? '');
  const direct =
    (typeof business.thumbnailUrl === 'string' && business.thumbnailUrl.trim()) || '';
  if (direct) return direct;

  const thumbId =
    (typeof business.thumbnailPhotoId === 'string' && business.thumbnailPhotoId.trim()) || '';
  if (thumbId && businessId) return photoStorage.apiPhotoPath(businessId, thumbId);

  const photos = Array.isArray(business.setup?.photos) ? business.setup.photos : [];
  const cover = photos.find((p) => p && (p.id || p.url || p.storageKey)) ?? null;
  if (!cover) return null;

  if (cover.url && String(cover.url).trim()) return String(cover.url).trim();
  if (cover.id && businessId) return photoStorage.apiPhotoPath(businessId, String(cover.id));
  return null;
};

const formatPublicBusinessSummary = (business, vendorName = '') => {
  const setup = business.setup ?? {};
  const basePrice = Number(setup.pricePerSlot) || 0;
  const resources = Array.isArray(setup.resources) ? setup.resources : [];
  const resourcePrices = resources
    .map((r) => Number(r && r.pricePerSlot))
    .filter((p) => Number.isFinite(p) && p >= 0);
  const prices = resourcePrices.length ? resourcePrices : [basePrice];
  const coverUrl = resolvePublicCoverUrl(business);
  return {
    id: String(business._id),
    name: business.name,
    vendorName: vendorName || '',
    typeLabel: business.typeLabel ?? '',
    categoryLabel: business.categoryLabel ?? '',
    module: business.module,
    address: business.address ?? '',
    description: business.description ?? '',
    pricePerSlot: basePrice,
    slotMinutes: setup.slotMinutes ?? 60,
    bookingMode: setup.bookingMode === 'fullDay' ? 'fullDay' : 'slots',
    maxGuests: setup.maxGuests ?? null,
    resourceCount: resources.length,
    priceFrom: Math.round(Math.min(...prices)),
    priceTo: Math.round(Math.max(...prices)),
    coverUrl,
  };
};

const listPublicBusinesses = async () => {
  const rows = await Business.listLivePublic({ module: 'appointments' });
  const vendorIds = rows.map((row) => row.vendorId).filter(Boolean);
  const users = await User.findByIds(vendorIds);
  const vendorNames = new Map(
    users.map((user) => [
      String(user._id),
      user.vendorProfile?.businessName || user.name || '',
    ]),
  );
  return {
    businesses: rows.map((row) =>
      formatPublicBusinessSummary(row, vendorNames.get(String(row.vendorId)) || ''),
    ),
  };
};

const getPublicBusiness = async (businessId) => {
  // Photos are served via the proxy endpoint (formatPhoto builds URLs from ids),
  // so we never need the heavy base64 blobs inline here.
  const business = await getLiveBusiness(businessId);
  return formatPublicBusiness(business);
};

const listPublicSlots = async (businessId, query) => {
  const business = await getLiveBusiness(businessId);
  return buildSlotsPayload(business, query, { publicView: true });
};

const createBooking = async (customerUserId, body) => {
  const businessId = String(body.businessId ?? '').trim();
  const resourceId = String(body.resourceId ?? '').trim();
  const startAt = String(body.startAt ?? '').trim();

  if (!businessId || !resourceId || !startAt) {
    throw Object.assign(new Error('businessId, resourceId and startAt required'), { status: 400 });
  }

  const user = await User.findById(customerUserId);
  if (!user) throw Object.assign(new Error('user not found'), { status: 404 });

  const business = await getLiveBusiness(businessId);
  const slot = await assertSlotForBooking(businessId, business, resourceId, startAt);

  if (new Date(slot.startAt).getTime() <= Date.now()) {
    throw Object.assign(new Error('cannot book a past slot'), { status: 400 });
  }

  const resource = business.setup.resources.find((r) => r.id === resourceId);
  const bookingMeta = {
    bookingId: randomUUID(),
    customerUserId: String(customerUserId),
    customerName: user.name ?? 'Customer',
    customerMobile: user.mobile ?? '',
  };

  // Hold the slot and persist the booking atomically. On a replica set / Atlas
  // both writes commit together (or roll back together); on a standalone dev
  // mongod we fall back to a manual compensating delete.
  const booking = await withTransaction(async (session) => {
    const slotOk = await BusinessSlotState.insertBooked(
      businessId,
      {
        resourceId,
        startAt: slot.startAt,
        endAt: slot.endAt,
        booking: bookingMeta,
      },
      { session },
    );
    if (!slotOk) {
      throw Object.assign(new Error('slot is no longer available'), { status: 409 });
    }

    try {
      return await Booking.insert(
        {
          _id: bookingMeta.bookingId,
          businessId: business._id,
          businessName: business.name,
          typeLabel: business.typeLabel,
          vendorId: business.vendorId,
          resourceId,
          resourceName: resource?.name ?? '',
          startAt: new Date(slot.startAt),
          endAt: new Date(slot.endAt),
          pricePerSlot: slot.pricePerSlot,
          customerUserId,
          customerName: bookingMeta.customerName,
          customerMobile: bookingMeta.customerMobile,
        },
        { session },
      );
    } catch (err) {
      // Without a transaction the slot hold won't auto-roll back, so undo it.
      if (!session) {
        await BusinessSlotState.removeBooked(businessId, resourceId, slot.startAt);
      }
      if (err?.code === 11000) {
        throw Object.assign(new Error('slot is no longer available'), { status: 409 });
      }
      throw err;
    }
  });

  return { booking };
};

const listCustomerBookings = async (customerUserId) => {
  const bookings = await Booking.listByCustomer(customerUserId);
  return { bookings };
};

const cancelBooking = async (customerUserId, bookingId) => {
  const booking = await Booking.findByIdForCustomer(bookingId, customerUserId);
  if (!booking) throw Object.assign(new Error('booking not found'), { status: 404 });

  if (new Date(booking.startAt).getTime() <= Date.now()) {
    throw Object.assign(new Error('cannot cancel a slot that has already started'), { status: 400 });
  }

  await withTransaction(async (session) => {
    await Booking.cancelById(bookingId, customerUserId, { session });
    await BusinessSlotState.removeBooked(
      booking.businessId,
      booking.resourceId,
      booking.startAt,
      { session },
    );
  });

  return { ok: true };
};

const ensureIndexes = () => Booking.ensureIndexes();

module.exports = {
  ensureIndexes,
  listPublicBusinesses,
  getPublicBusiness,
  listPublicSlots,
  createBooking,
  listCustomerBookings,
  cancelBooking,
};
