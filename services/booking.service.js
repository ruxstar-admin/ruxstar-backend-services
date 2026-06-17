const { randomUUID } = require('crypto');
const Business = require('../models/Business');
const Booking = require('../models/Booking');
const BusinessSlotState = require('../models/BusinessSlotState');
const User = require('../models/User');
const setupService = require('./businessSetup.service');
const {
  getLiveBusiness,
  buildSlotsPayload,
  assertSlotExists,
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
    },
  };
};

const formatPublicBusinessSummary = (business) => {
  const setup = business.setup ?? {};
  return {
    id: String(business._id),
    name: business.name,
    typeLabel: business.typeLabel ?? '',
    categoryLabel: business.categoryLabel ?? '',
    module: business.module,
    address: business.address ?? '',
    description: business.description ?? '',
    pricePerSlot: setup.pricePerSlot ?? 0,
    slotMinutes: setup.slotMinutes ?? 60,
  };
};

const listPublicBusinesses = async () => {
  const rows = await Business.listLivePublic({ module: 'appointments' });
  return { businesses: rows.map(formatPublicBusinessSummary) };
};

const getPublicBusiness = async (businessId) => {
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
  const slot = assertSlotExists(business, resourceId, startAt);

  if (new Date(slot.startAt).getTime() <= Date.now()) {
    throw Object.assign(new Error('cannot book a past slot'), { status: 400 });
  }

  const existing = await BusinessSlotState.findOne(businessId, resourceId, slot.startAt);
  if (existing) {
    throw Object.assign(new Error('slot is no longer available'), { status: 409 });
  }

  const resource = business.setup.resources.find((r) => r.id === resourceId);
  const bookingMeta = {
    bookingId: randomUUID(),
    customerUserId: String(customerUserId),
    customerName: user.name ?? 'Customer',
    customerMobile: user.mobile ?? '',
  };

  const slotOk = await BusinessSlotState.insertBooked(businessId, {
    resourceId,
    startAt: slot.startAt,
    endAt: slot.endAt,
    booking: bookingMeta,
  });
  if (!slotOk) {
    throw Object.assign(new Error('slot is no longer available'), { status: 409 });
  }

  try {
    const booking = await Booking.insert({
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
    });
    return { booking };
  } catch (err) {
    await BusinessSlotState.removeBooked(businessId, resourceId, slot.startAt);
    if (err?.code === 11000) {
      throw Object.assign(new Error('slot is no longer available'), { status: 409 });
    }
    throw err;
  }
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

  await Booking.cancelById(bookingId, customerUserId);
  await BusinessSlotState.removeBooked(booking.businessId, booking.resourceId, booking.startAt);

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
