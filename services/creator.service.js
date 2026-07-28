const { randomUUID } = require('crypto');
const { withTransaction } = require('../config/database');
const Business = require('../models/Business');
const CreatorOffer = require('../models/CreatorOffer');
const CreatorBooking = require('../models/CreatorBooking');
const User = require('../models/User');
const photoStorage = require('./photoStorage.service');
const cashfreePayments = require('../utils/cashfreePayments');
const paymentService = require('./payment.service');
const { HOLD_MINUTES } = require('../constants/payments');
const {
  CREATOR_MODULE,
  OFFER_KIND,
  OFFER_STATUS,
  BOOKING_STATUS,
  PLATFORM_VALUES,
} = require('../constants/creator');

const ensureIndexes = async () => {
  await CreatorOffer.ensureIndexes();
  await CreatorBooking.ensureIndexes();
};

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const notFound = (message) => Object.assign(new Error(message), { status: 404 });

const resolveCoverUrl = (business) => {
  const businessId = String(business._id ?? business.id ?? '');
  const direct = (typeof business.thumbnailUrl === 'string' && business.thumbnailUrl.trim()) || '';
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

const assertCreatorBusiness = async (vendorId, businessId) => {
  const business = await Business.findByIdForVendor(businessId, vendorId, { withPhotoData: false });
  if (!business) throw notFound('business not found');
  if (business.module !== CREATOR_MODULE) {
    throw badRequest('this business is not set up for creator collabs');
  }
  return business;
};

const KIND_VALUES = Object.values(OFFER_KIND);

const parseOfferInput = (body, { partial = false } = {}) => {
  const out = {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  if (body.title !== undefined || !partial) {
    const title = str(body.title);
    if (!title) throw badRequest('title is required');
    out.title = title.slice(0, 140);
  }
  if (body.description !== undefined || !partial) {
    out.description = str(body.description ?? '').slice(0, 4000);
  }
  if (body.kind !== undefined || !partial) {
    const kind = str(body.kind) || OFFER_KIND.COLLAB;
    if (!KIND_VALUES.includes(kind)) throw badRequest('invalid kind');
    out.kind = kind;
  }
  if (body.platforms !== undefined) {
    const list = Array.isArray(body.platforms) ? body.platforms : [];
    out.platforms = list
      .map((p) => str(p).toLowerCase())
      .filter((p) => PLATFORM_VALUES.includes(p))
      .slice(0, 5);
  }
  if (body.price !== undefined || !partial) {
    const n = num(body.price);
    out.price = n && n > 0 ? Math.round(n) : 0;
  }
  if (body.turnaroundDays !== undefined) {
    const n = num(body.turnaroundDays);
    out.turnaroundDays = n && n > 0 ? Math.min(Math.round(n), 90) : null;
  }
  if (body.capacity !== undefined) {
    const n = num(body.capacity);
    out.capacity = n && n > 0 ? Math.round(n) : null;
  }
  return out;
};

const createOffer = async (vendorId, body) => {
  const businessId = String(body.businessId ?? '').trim();
  if (!businessId) throw badRequest('businessId is required');
  const business = await assertCreatorBusiness(vendorId, businessId);
  const input = parseOfferInput(body, { partial: false });
  if (input.price < 1) throw badRequest('price must be at least ₹1');

  const offer = await CreatorOffer.insert(vendorId, {
    ...input,
    businessId,
    businessName: business.name,
    coverUrl: resolveCoverUrl(business),
  });
  return { offer };
};

const listVendorOffers = async (vendorId, query = {}) => {
  const offers = await CreatorOffer.listByVendor(vendorId, {
    businessId: query.businessId,
  });
  return { offers };
};

const getVendorOffer = async (vendorId, offerId) => {
  const offer = await CreatorOffer.findByIdForVendor(offerId, vendorId);
  if (!offer) throw notFound('offer not found');
  const bookings = await CreatorBooking.listByOffer(offerId, { vendorId });
  return { offer, bookings };
};

const updateOffer = async (vendorId, offerId, body) => {
  const existing = await CreatorOffer.findByIdForVendor(offerId, vendorId);
  if (!existing) throw notFound('offer not found');
  const patch = parseOfferInput(body, { partial: true });
  const offer = await CreatorOffer.updateForVendor(offerId, vendorId, patch);
  return { offer };
};

const setOfferStatus = async (vendorId, offerId, status) => {
  if (!Object.values(OFFER_STATUS).includes(status)) throw badRequest('invalid status');
  const existing = await CreatorOffer.findByIdForVendor(offerId, vendorId);
  if (!existing) throw notFound('offer not found');

  if (status === OFFER_STATUS.PUBLISHED) {
    if (!existing.title?.trim()) throw badRequest('add a title before publishing');
    if (existing.price < 1) throw badRequest('set a price before publishing');
    const profile = (await Business.findByIdForVendor(existing.businessId, vendorId))?.setup
      ?.creatorProfile;
    if (profile?.acceptingBookings === false) {
      throw badRequest('turn on accepting bookings in your creator profile first');
    }
  }

  const offer = await CreatorOffer.updateForVendor(offerId, vendorId, { status });
  return { offer };
};

const deleteOffer = async (vendorId, offerId) => {
  const offer = await CreatorOffer.findByIdForVendor(offerId, vendorId);
  if (!offer) throw notFound('offer not found');
  if (offer.confirmedCount > 0) {
    throw badRequest('cannot delete an offer with bookings; cancel it instead');
  }
  await CreatorOffer.deleteForVendor(offerId, vendorId);
  return { ok: true };
};

const listPublicOffers = async () => {
  const offers = await CreatorOffer.listPublic();
  return { offers };
};

const getPublicOffer = async (offerId) => {
  const offer = await CreatorOffer.findPublicById(offerId);
  if (!offer) throw notFound('offer not found');
  return { offer };
};

const buildReturnUrl = (bookingId) => {
  const tpl = process.env.CASHFREE_PG_RETURN_URL;
  if (!tpl) return undefined;
  return tpl.replace('{bookingId}', bookingId).replace('{registrationId}', bookingId);
};

const assertBookable = (offer) => {
  if (offer.status !== OFFER_STATUS.PUBLISHED) throw badRequest('booking is closed');
  if (offer.spotsLeft === 0) throw badRequest('this offer is full');
};

const bookOffer = async (customerUserId, offerId, body) => {
  const user = await User.findById(customerUserId);
  if (!user) throw notFound('user not found');

  const offerRaw = await CreatorOffer.findById(offerId);
  if (!offerRaw || offerRaw.status !== OFFER_STATUS.PUBLISHED) throw notFound('offer not found');
  const offer = offerRaw;
  assertBookable(offer);

  const hostBusiness = await Business.findByIdAny(offer.businessId);
  if (hostBusiness?.suspended) throw badRequest('bookings are closed for this creator');

  if (await CreatorBooking.hasActiveBooking(offerId, customerUserId)) {
    throw Object.assign(new Error('you already have an active booking for this offer'), {
      status: 409,
    });
  }

  const brief = String(body.brief ?? '').trim().slice(0, 2000);
  if (!brief) throw badRequest('describe what you need for this collab');

  const vendorId = offerRaw._raw?.vendorId ?? offer.vendorId;
  const bookingId = randomUUID();
  const baseDoc = {
    _id: bookingId,
    offerId: offer.id,
    offerTitle: offer.title,
    offerKind: offer.kind,
    businessId: offer.businessId,
    businessName: offer.businessName,
    vendorId,
    brief,
    customerUserId,
    customerName: user.name ?? 'Customer',
    customerMobile: user.mobile ?? '',
    amount: offer.price,
    currency: 'INR',
    turnaroundDays: offer.turnaroundDays,
  };

  if (offer.price <= 0) {
    const booking = await withTransaction(async (session) => {
      const reserved = await CreatorOffer.reserveSpot(offerId, { session });
      if (!reserved) throw Object.assign(new Error('this offer is full'), { status: 409 });
      try {
        const row = await CreatorBooking.insertConfirmed(baseDoc, { session });
        await CreatorOffer.confirmSpot(offerId, { session });
        return row;
      } catch (err) {
        if (!session) await CreatorOffer.releaseSpot(offerId);
        throw err;
      }
    });
    return { booking, payment: null };
  }

  if (!cashfreePayments.isConfigured()) {
    throw Object.assign(new Error('payments are not configured'), { status: 503 });
  }
  const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60 * 1000);

  await withTransaction(async (session) => {
    const reserved = await CreatorOffer.reserveSpot(offerId, { session });
    if (!reserved) throw Object.assign(new Error('this offer is full'), { status: 409 });
    try {
      await CreatorBooking.insertPending({ ...baseDoc, expiresAt }, { session });
    } catch (err) {
      if (!session) await CreatorOffer.releaseSpot(offerId);
      throw err;
    }
  });

  let order;
  try {
    order = await cashfreePayments.createOrder({
      orderId: bookingId,
      amount: offer.price,
      customer: {
        id: String(customerUserId),
        phone: user.mobile,
        name: user.name,
        email: user.email,
      },
      returnUrl: buildReturnUrl(bookingId),
      notifyUrl: process.env.CASHFREE_PG_NOTIFY_URL || undefined,
      expiryIso: expiresAt.toISOString(),
      note: `Collab · ${offer.title}`.slice(0, 200),
    });
  } catch (err) {
    console.error('cashfree createOrder (creator) failed:', err.detail || err.message);
    const pending = await CreatorBooking.findById(bookingId);
    if (pending) await releaseBooking(pending, BOOKING_STATUS.PAYMENT_FAILED);
    const clientMsg = err.detail || err.message || 'Could not start payment.';
    throw Object.assign(new Error(clientMsg), {
      status: err.status === 401 || err.status === 403 ? 502 : err.status || 502,
    });
  }

  const paymentSessionId = order.payment_session_id;
  const cashfreeOrderId = order.cf_order_id || order.order_id || bookingId;
  await CreatorBooking.attachPaymentSession(bookingId, { paymentSessionId, cashfreeOrderId });

  const booking = await CreatorBooking.getForCustomer(bookingId, customerUserId);
  return {
    booking,
    payment: {
      orderId: bookingId,
      cashfreeOrderId,
      paymentSessionId,
      amount: offer.price,
      currency: 'INR',
      expiresAt: expiresAt.toISOString(),
      mode: process.env.CASHFREE_PG_ENV === 'production' ? 'production' : 'sandbox',
    },
  };
};

const settlePaid = async (booking, { cashfreeOrderId, paymentRef } = {}) => {
  const raw = booking._raw ?? {};
  let confirmed = booking.status === BOOKING_STATUS.CONFIRMED;
  await withTransaction(async (session) => {
    const paid = await CreatorBooking.markPaid(
      booking.id,
      { cashfreeOrderId, paymentRef },
      { session },
    );
    if (paid) {
      await CreatorOffer.confirmSpot(booking.offerId, { session });
      confirmed = true;
    }
  });

  if (!confirmed) return;
  const pay = await paymentService.recordPayment({
    source: 'creator',
    sourceId: booking.id,
    sourceRef: raw.refId || booking.refId,
    vendorId: raw.vendorId,
    customerUserId: raw.customerUserId,
    amount: typeof raw.amount === 'number' ? raw.amount : booking.amount,
    currency: raw.currency || booking.currency || 'INR',
    cashfreeOrderId,
    gatewayPaymentId: paymentRef,
  });
  if (pay?.refId) await CreatorBooking.setPaymentRefId(booking.id, pay.refId);
};

const releaseBooking = async (booking, status) => {
  await withTransaction(async (session) => {
    const updated = await CreatorBooking.markUnpaid(booking.id, status, { session });
    if (updated) await CreatorOffer.releaseSpot(booking.offerId, { session });
  });
};

const getBookingStatus = async (customerUserId, bookingId) => {
  let booking = await CreatorBooking.getForCustomer(bookingId, customerUserId);
  if (!booking) throw notFound('booking not found');

  if (
    booking.status === BOOKING_STATUS.PENDING_PAYMENT &&
    cashfreePayments.isConfigured()
  ) {
    const raw = await CreatorBooking.findById(bookingId);
    let order;
    try {
      order = await cashfreePayments.getOrder(bookingId);
    } catch {
      order = null;
    }
    if (order?.order_status === 'PAID') {
      await settlePaid(raw, { cashfreeOrderId: order.cf_order_id, paymentRef: order.cf_order_id });
    } else if (['EXPIRED', 'TERMINATED', 'CANCELLED'].includes(order?.order_status)) {
      await releaseBooking(raw, BOOKING_STATUS.EXPIRED);
    }
    booking = await CreatorBooking.getForCustomer(bookingId, customerUserId);
  }
  return { booking };
};

const cancelBooking = async (customerUserId, bookingId) => {
  const raw = await CreatorBooking.cancelPendingForCustomer(bookingId, customerUserId);
  if (!raw) throw badRequest('only pending bookings can be cancelled');
  await CreatorOffer.releaseSpot(raw.offerId);
  return { booking: raw };
};

const listCustomerBookings = async (customerUserId) => {
  const bookings = await CreatorBooking.listByCustomer(customerUserId);
  return { bookings };
};

const listVendorBookings = async (vendorId, query = {}) => {
  const bookings = await CreatorBooking.listByVendor(vendorId, {
    businessId: query.businessId,
  });
  return { bookings };
};

const updateBookingStatus = async (vendorId, bookingId, status) => {
  const allowed = [BOOKING_STATUS.IN_PROGRESS, BOOKING_STATUS.COMPLETED];
  if (!allowed.includes(status)) throw badRequest('invalid status');
  const booking = await CreatorBooking.updateStatusForVendor(bookingId, vendorId, status);
  if (!booking) throw badRequest('booking not found or cannot be updated');
  return { booking };
};

const handlePaymentWebhook = async (payload) => {
  const data = payload?.data || {};
  const orderId = data.order?.order_id;
  if (!orderId) return false;

  const booking = await CreatorBooking.findById(orderId);
  if (!booking || booking.status !== BOOKING_STATUS.PENDING_PAYMENT) {
    return false;
  }

  const paymentStatus = data.payment?.payment_status;
  const orderStatus = data.order?.order_status;
  const cashfreeOrderId = data.order?.cf_order_id || booking.cashfreeOrderId;
  const paymentRef = data.payment?.cf_payment_id;

  if (paymentStatus === 'SUCCESS' || orderStatus === 'PAID') {
    await settlePaid(booking, { cashfreeOrderId, paymentRef });
  } else if (['FAILED', 'USER_DROPPED', 'CANCELLED'].includes(paymentStatus)) {
    await releaseBooking(booking, BOOKING_STATUS.PAYMENT_FAILED);
  }
  return true;
};

const releaseExpiredHolds = async () => {
  const expired = await CreatorBooking.listExpiredPending();
  let released = 0;
  let confirmed = 0;
  for (const row of expired) {
    if (cashfreePayments.isConfigured()) {
      try {
        const order = await cashfreePayments.getOrder(row.id);
        if (order?.order_status === 'PAID') {
          await settlePaid(row, { cashfreeOrderId: order.cf_order_id, paymentRef: order.cf_order_id });
          confirmed += 1;
          continue;
        }
      } catch {
        // fall through
      }
    }
    await releaseBooking(row, BOOKING_STATUS.EXPIRED);
    released += 1;
  }
  return { scanned: expired.length, released, confirmed };
};

module.exports = {
  ensureIndexes,
  createOffer,
  listVendorOffers,
  getVendorOffer,
  updateOffer,
  setOfferStatus,
  deleteOffer,
  listPublicOffers,
  getPublicOffer,
  bookOffer,
  getBookingStatus,
  cancelBooking,
  listCustomerBookings,
  listVendorBookings,
  updateBookingStatus,
  handlePaymentWebhook,
  releaseExpiredHolds,
};
