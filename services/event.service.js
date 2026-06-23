const { randomUUID } = require('crypto');
const { withTransaction } = require('../config/database');
const Business = require('../models/Business');
const Event = require('../models/Event');
const EventRegistration = require('../models/EventRegistration');
const User = require('../models/User');
const photoStorage = require('./photoStorage.service');
const cashfreePayments = require('../utils/cashfreePayments');
const { HOLD_MINUTES } = require('../constants/payments');
const {
  EVENT_MODULE,
  EVENT_KIND,
  EVENT_FORMAT,
  EVENT_STATUS,
  REGISTRATION_STATUS,
} = require('../constants/events');

const ensureIndexes = async () => {
  await Event.ensureIndexes();
  await EventRegistration.ensureIndexes();
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

// ───────────────────────── Vendor authoring ─────────────────────────

const KIND_VALUES = Object.values(EVENT_KIND);
const FORMAT_VALUES = Object.values(EVENT_FORMAT);

const parseEventInput = (body, { partial = false } = {}) => {
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
  if (body.kind !== undefined || !partial) {
    const kind = str(body.kind) || EVENT_KIND.TOURNAMENT;
    if (!KIND_VALUES.includes(kind)) throw badRequest('invalid kind');
    out.kind = kind;
  }
  if (body.format !== undefined) {
    const format = str(body.format) || EVENT_FORMAT.INDIVIDUAL;
    if (!FORMAT_VALUES.includes(format)) throw badRequest('invalid format');
    out.format = format;
  }
  if (body.description !== undefined) out.description = str(body.description).slice(0, 4000);
  if (body.tournamentType !== undefined) out.tournamentType = str(body.tournamentType).slice(0, 80);
  if (body.venue !== undefined) out.venue = str(body.venue).slice(0, 300);
  if (body.skillLevel !== undefined) out.skillLevel = str(body.skillLevel).slice(0, 80);
  if (body.ageCategory !== undefined) out.ageCategory = str(body.ageCategory).slice(0, 80);
  if (body.genderCategory !== undefined) out.genderCategory = str(body.genderCategory).slice(0, 40);
  if (body.rules !== undefined) out.rules = str(body.rules).slice(0, 4000);

  if (body.teamSize !== undefined) {
    const n = num(body.teamSize);
    out.teamSize = n && n > 0 ? Math.min(Math.round(n), 100) : null;
  }
  if (body.capacity !== undefined) {
    const n = num(body.capacity);
    out.capacity = n && n > 0 ? Math.round(n) : null;
  }
  if (body.entryFee !== undefined) {
    const n = num(body.entryFee);
    out.entryFee = n && n > 0 ? Math.round(n) : 0;
  }

  if (body.startAt !== undefined || !partial) {
    const startAt = str(body.startAt);
    if (!startAt || Number.isNaN(Date.parse(startAt))) throw badRequest('valid startAt is required');
    out.startAt = startAt;
  }
  if (body.endAt !== undefined) {
    const endAt = str(body.endAt);
    out.endAt = endAt && !Number.isNaN(Date.parse(endAt)) ? endAt : null;
  }
  if (body.registrationDeadline !== undefined) {
    const rd = str(body.registrationDeadline);
    out.registrationDeadline = rd && !Number.isNaN(Date.parse(rd)) ? rd : null;
  }
  return out;
};

const assertEventBusiness = async (vendorId, businessId) => {
  const business = await Business.findByIdForVendor(businessId, vendorId, { withPhotoData: false });
  if (!business) throw notFound('business not found');
  if (business.module !== EVENT_MODULE) {
    throw badRequest('this business is not set up for events & tournaments');
  }
  return business;
};

const createEvent = async (vendorId, body) => {
  const businessId = String(body.businessId ?? '').trim();
  if (!businessId) throw badRequest('businessId is required');
  const business = await assertEventBusiness(vendorId, businessId);
  const input = parseEventInput(body, { partial: false });

  if (input.format === EVENT_FORMAT.TEAM && !input.teamSize) {
    throw badRequest('team tournaments need a team size');
  }

  const event = await Event.insert(vendorId, {
    ...input,
    businessId,
    businessName: business.name,
    venue: input.venue || business.address || '',
    coverUrl: resolveCoverUrl(business),
  });
  return { event };
};

const listVendorEvents = async (vendorId) => {
  const events = await Event.listByVendor(vendorId);
  return { events };
};

const getVendorEvent = async (vendorId, eventId) => {
  const event = await Event.findByIdForVendor(eventId, vendorId);
  if (!event) throw notFound('event not found');
  const registrations = await EventRegistration.listByEvent(eventId, { vendorId });
  return { event, registrations };
};

const updateEvent = async (vendorId, eventId, body) => {
  const existing = await Event.findByIdForVendor(eventId, vendorId);
  if (!existing) throw notFound('event not found');
  const patch = parseEventInput(body, { partial: true });
  const format = patch.format ?? existing.format;
  const teamSize = patch.teamSize ?? existing.teamSize;
  if (format === EVENT_FORMAT.TEAM && !teamSize) {
    throw badRequest('team tournaments need a team size');
  }
  const event = await Event.updateForVendor(eventId, vendorId, patch);
  return { event };
};

const setEventStatus = async (vendorId, eventId, status) => {
  if (!Object.values(EVENT_STATUS).includes(status)) throw badRequest('invalid status');
  const existing = await Event.findByIdForVendor(eventId, vendorId);
  if (!existing) throw notFound('event not found');

  if (status === EVENT_STATUS.PUBLISHED) {
    if (!existing.startAt) throw badRequest('set a date before publishing');
    if (new Date(existing.startAt).getTime() <= Date.now()) {
      throw badRequest('start date must be in the future to publish');
    }
  }
  const event = await Event.updateForVendor(eventId, vendorId, { status });
  return { event };
};

const deleteEvent = async (vendorId, eventId) => {
  const event = await Event.findByIdForVendor(eventId, vendorId);
  if (!event) throw notFound('event not found');
  if (event.confirmedCount > 0) {
    throw badRequest('cannot delete an event that already has registrations; cancel it instead');
  }
  await Event.deleteForVendor(eventId, vendorId);
  return { ok: true };
};

// ───────────────────────── Public discovery ─────────────────────────

const listPublicEvents = async () => {
  const events = await Event.listPublic();
  return { events };
};

const getPublicEvent = async (eventId) => {
  const event = await Event.findPublicById(eventId);
  if (!event) throw notFound('event not found');
  return { event };
};

// ───────────────────────── Registration ─────────────────────────

const normalizeParticipants = (raw, fallbackName) => {
  const list = Array.isArray(raw) ? raw : [];
  const names = list
    .map((p) => (typeof p === 'string' ? p : p?.name))
    .map((n) => String(n ?? '').trim())
    .filter(Boolean)
    .slice(0, 50);
  if (names.length === 0 && fallbackName) names.push(fallbackName);
  return names.map((name) => ({ name }));
};

const buildRegistrationDoc = ({ event, vendorId, user, customerUserId, body, registrationId }) => {
  const isTeam = event.format === EVENT_FORMAT.TEAM;
  const teamName = isTeam ? String(body.teamName ?? '').trim().slice(0, 120) : null;
  if (isTeam && !teamName) throw badRequest('team name is required');
  const participants = normalizeParticipants(body.participants, user.name);
  return {
    _id: registrationId,
    eventId: event.id,
    businessId: event.businessId,
    vendorId,
    eventTitle: event.title,
    businessName: event.businessName,
    kind: event.kind,
    format: event.format,
    teamName,
    participants,
    customerUserId,
    customerName: user.name ?? 'Customer',
    customerMobile: user.mobile ?? '',
    amount: event.entryFee,
    currency: 'INR',
    startAt: event.startAt,
    venue: event.venue,
  };
};

const buildReturnUrl = (registrationId) => {
  const tpl = process.env.CASHFREE_PG_RETURN_URL;
  if (!tpl) return undefined;
  return tpl.replace('{bookingId}', registrationId).replace('{registrationId}', registrationId);
};

const assertRegistrable = (event) => {
  if (event.status !== EVENT_STATUS.PUBLISHED) throw badRequest('registration is closed');
  if (event.startAt && new Date(event.startAt).getTime() <= Date.now()) {
    throw badRequest('this event has already started');
  }
  if (event.registrationDeadline && new Date(event.registrationDeadline).getTime() <= Date.now()) {
    throw badRequest('registration deadline has passed');
  }
  if (event.spotsLeft === 0) throw badRequest('this event is full');
};

const registerForEvent = async (customerUserId, eventId, body) => {
  const user = await User.findById(customerUserId);
  if (!user) throw notFound('user not found');

  const eventRaw = await Event.findById(eventId);
  if (!eventRaw || eventRaw.status !== EVENT_STATUS.PUBLISHED) throw notFound('event not found');
  const event = eventRaw;
  assertRegistrable(event);

  if (await EventRegistration.hasActiveRegistration(eventId, customerUserId)) {
    throw Object.assign(new Error('you are already registered for this event'), { status: 409 });
  }

  const vendorId = eventRaw._raw?.vendorId ?? null;
  if (!vendorId) throw notFound('event not found');

  const registrationId = randomUUID();
  const baseDoc = buildRegistrationDoc({
    event,
    vendorId,
    user,
    customerUserId,
    body,
    registrationId,
  });

  // Free entry → reserve + confirm immediately, no payment.
  if (event.entryFee <= 0) {
    const registration = await withTransaction(async (session) => {
      const reserved = await Event.reserveSpot(eventId, { session });
      if (!reserved) throw Object.assign(new Error('this event is full'), { status: 409 });
      try {
        const reg = await EventRegistration.insertConfirmed(baseDoc, { session });
        await Event.confirmSpot(eventId, { session });
        return reg;
      } catch (err) {
        if (!session) await Event.releaseSpot(eventId);
        throw err;
      }
    });
    return { registration, payment: null };
  }

  // Paid entry → reserve a spot, create pending registration + Cashfree order.
  if (!cashfreePayments.isConfigured()) {
    throw Object.assign(new Error('payments are not configured'), { status: 503 });
  }
  const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60 * 1000);

  await withTransaction(async (session) => {
    const reserved = await Event.reserveSpot(eventId, { session });
    if (!reserved) throw Object.assign(new Error('this event is full'), { status: 409 });
    try {
      await EventRegistration.insertPending({ ...baseDoc, expiresAt }, { session });
    } catch (err) {
      if (!session) await Event.releaseSpot(eventId);
      throw err;
    }
  });

  let order;
  try {
    order = await cashfreePayments.createOrder({
      orderId: registrationId,
      amount: event.entryFee,
      customer: {
        id: String(customerUserId),
        phone: user.mobile,
        name: user.name,
        email: user.email,
      },
      returnUrl: buildReturnUrl(registrationId),
      notifyUrl: process.env.CASHFREE_PG_NOTIFY_URL || undefined,
      expiryIso: expiresAt.toISOString(),
      note: `Entry · ${event.title}`.slice(0, 200),
    });
  } catch (err) {
    console.error('cashfree createOrder (event) failed:', err.detail || err.message);
    const pending = await EventRegistration.findById(registrationId);
    if (pending) await releaseRegistration(pending, REGISTRATION_STATUS.PAYMENT_FAILED);
    const clientMsg = err.detail || err.message || 'Could not start payment.';
    throw Object.assign(new Error(clientMsg), {
      status: err.status === 401 || err.status === 403 ? 502 : err.status || 502,
    });
  }

  const paymentSessionId = order.payment_session_id;
  const cashfreeOrderId = order.cf_order_id || order.order_id || registrationId;
  await EventRegistration.attachPaymentSession(registrationId, { paymentSessionId, cashfreeOrderId });

  const registration = await EventRegistration.getForCustomer(registrationId, customerUserId);
  return {
    registration,
    payment: {
      orderId: registrationId,
      cashfreeOrderId,
      paymentSessionId,
      amount: event.entryFee,
      currency: 'INR',
      expiresAt: expiresAt.toISOString(),
      mode: process.env.CASHFREE_PG_ENV === 'production' ? 'production' : 'sandbox',
    },
  };
};

// Promote a pending registration to confirmed. Idempotent.
const settlePaid = async (registration, { cashfreeOrderId, paymentRef } = {}) => {
  await withTransaction(async (session) => {
    const paid = await EventRegistration.markPaid(
      registration.id,
      { cashfreeOrderId, paymentRef },
      { session },
    );
    if (paid) await Event.confirmSpot(registration.eventId, { session });
  });
};

// Release a reserved spot and move the registration to a terminal unpaid state.
const releaseRegistration = async (registration, status) => {
  await withTransaction(async (session) => {
    const updated = await EventRegistration.markUnpaid(registration.id, status, { session });
    if (updated) await Event.releaseSpot(registration.eventId, { session });
  });
};

const getRegistrationStatus = async (customerUserId, registrationId) => {
  let registration = await EventRegistration.getForCustomer(registrationId, customerUserId);
  if (!registration) throw notFound('registration not found');

  if (
    registration.status === REGISTRATION_STATUS.PENDING_PAYMENT &&
    cashfreePayments.isConfigured()
  ) {
    const raw = await EventRegistration.findById(registrationId);
    let order;
    try {
      order = await cashfreePayments.getOrder(registrationId);
    } catch {
      order = null;
    }
    if (order?.order_status === 'PAID') {
      await settlePaid(raw, { cashfreeOrderId: order.cf_order_id, paymentRef: order.cf_order_id });
    } else if (['EXPIRED', 'TERMINATED', 'CANCELLED'].includes(order?.order_status)) {
      await releaseRegistration(raw, REGISTRATION_STATUS.EXPIRED);
    }
    registration = await EventRegistration.getForCustomer(registrationId, customerUserId);
  }
  return { registration };
};

const listCustomerRegistrations = async (customerUserId) => {
  const registrations = await EventRegistration.listByCustomer(customerUserId);
  return { registrations };
};

// Shared Cashfree webhook fan-out: returns true if this order is an event
// registration we handled, false so the caller can try other entities.
const handlePaymentWebhook = async (payload) => {
  const data = payload?.data || {};
  const orderId = data.order?.order_id;
  if (!orderId) return false;

  const registration = await EventRegistration.findById(orderId);
  if (!registration || registration.status !== REGISTRATION_STATUS.PENDING_PAYMENT) {
    return false;
  }

  const paymentStatus = data.payment?.payment_status;
  const orderStatus = data.order?.order_status;
  const cashfreeOrderId = data.order?.cf_order_id || registration.cashfreeOrderId;
  const paymentRef = data.payment?.cf_payment_id;

  if (paymentStatus === 'SUCCESS' || orderStatus === 'PAID') {
    await settlePaid(registration, { cashfreeOrderId, paymentRef });
  } else if (['FAILED', 'USER_DROPPED', 'CANCELLED'].includes(paymentStatus)) {
    await releaseRegistration(registration, REGISTRATION_STATUS.PAYMENT_FAILED);
  }
  return true;
};

// Periodic sweeper: release reservations whose payment window elapsed.
const releaseExpiredHolds = async () => {
  const expired = await EventRegistration.listExpiredPending();
  let released = 0;
  let confirmed = 0;
  for (const reg of expired) {
    if (cashfreePayments.isConfigured()) {
      try {
        const order = await cashfreePayments.getOrder(reg.id);
        if (order?.order_status === 'PAID') {
          await settlePaid(reg, { cashfreeOrderId: order.cf_order_id, paymentRef: order.cf_order_id });
          confirmed += 1;
          continue;
        }
      } catch {
        // fall through and release
      }
    }
    await releaseRegistration(reg, REGISTRATION_STATUS.EXPIRED);
    released += 1;
  }
  return { scanned: expired.length, released, confirmed };
};

module.exports = {
  ensureIndexes,
  createEvent,
  listVendorEvents,
  getVendorEvent,
  updateEvent,
  setEventStatus,
  deleteEvent,
  listPublicEvents,
  getPublicEvent,
  registerForEvent,
  getRegistrationStatus,
  listCustomerRegistrations,
  handlePaymentWebhook,
  releaseExpiredHolds,
};
