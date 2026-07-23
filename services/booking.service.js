const { randomUUID } = require('crypto');
const { withTransaction } = require('../config/database');
const Business = require('../models/Business');
const Booking = require('../models/Booking');
const BusinessSlotState = require('../models/BusinessSlotState');
const User = require('../models/User');
const setupService = require('./businessSetup.service');
const photoStorage = require('./photoStorage.service');
const cashfreePayments = require('../utils/cashfreePayments');
const paymentService = require('./payment.service');
const { HOLD_MINUTES, BOOKING_STATUS } = require('../constants/payments');
const { isServiceType } = require('../constants/businessSetup');
const { pendingHoldResourceId } = require('../utils/coachingService');
const {
  getLiveBusiness,
  isServiceBusiness,
  buildSlotsPayload,
  buildServiceAvailability,
  assertSlotForBooking,
  assertServiceSlotForBooking,
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
      services: setup.services ?? [],
      staff: setup.staff ?? [],
      bufferMinutes: setup.bufferMinutes ?? 0,
      bookingMode: setup.bookingMode,
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
  const serviceMode = isServiceType(business.typeId);
  const basePrice = Number(setup.pricePerSlot) || 0;
  const resources = Array.isArray(setup.resources) ? setup.resources : [];
  const services = Array.isArray(setup.services) ? setup.services : [];

  let prices;
  if (serviceMode) {
    const servicePrices = services
      .map((s) => Number(s && s.price))
      .filter((p) => Number.isFinite(p) && p >= 0);
    prices = servicePrices.length ? servicePrices : [0];
  } else {
    const resourcePrices = resources
      .map((r) => Number(r && r.pricePerSlot))
      .filter((p) => Number.isFinite(p) && p >= 0);
    prices = resourcePrices.length ? resourcePrices : [basePrice];
  }

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
    pricePerSlot: serviceMode ? Math.round(Math.min(...prices)) : basePrice,
    slotMinutes: setup.slotMinutes ?? 60,
    bookingMode: serviceMode ? 'services' : setup.bookingMode === 'fullDay' ? 'fullDay' : 'slots',
    maxGuests: setup.maxGuests ?? null,
    resourceCount: serviceMode ? services.length : resources.length,
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
  if (isServiceBusiness(business)) return buildServiceAvailability(business, query, { publicView: true });
  return buildSlotsPayload(business, query, { publicView: true });
};

const createBooking = async (customerUserId, body) => {
  const businessId = String(body.businessId ?? '').trim();
  if (!businessId) {
    throw Object.assign(new Error('businessId required'), { status: 400 });
  }

  const user = await User.findById(customerUserId);
  if (!user) throw Object.assign(new Error('user not found'), { status: 404 });

  const business = await getLiveBusiness(businessId);
  const target = await resolveBookingTarget(business, body);

  if (new Date(target.startAt).getTime() <= Date.now()) {
    throw Object.assign(new Error('cannot book a time in the past'), { status: 400 });
  }

  const bookingMeta = {
    bookingId: randomUUID(),
    customerUserId: String(customerUserId),
    customerName: user.name ?? 'Customer',
    customerMobile: user.mobile ?? '',
  };

  const serviceFields = target.serviceMode
    ? {
        services: target.services,
        serviceLabel: target.serviceLabel,
        durationMinutes: target.durationMinutes,
      }
    : {};

  const groupFields = target.groupClass
    ? {
        groupClass: true,
        classSessionKey: target.classSessionKey,
        holdResourceId: slotResourceIdForTarget(target, String(customerUserId)),
        maxParticipants: target.maxParticipants,
        ...(target.pricingModel ? { pricingModel: target.pricingModel } : {}),
        ...(target.periodKind && target.periodKind !== 'exact'
          ? { periodKind: target.periodKind, periodKey: target.periodKey }
          : {}),
      }
    : {};

  // Hold the slot and persist the booking atomically. On a replica set / Atlas
  // both writes commit together (or roll back together); on a standalone dev
  // mongod we fall back to a manual compensating delete.
  const booking = await withTransaction(async (session) => {
    if (target.serviceMode && target.groupClass) {
      const booked = await Booking.countActiveOccurrenceBookings(
        businessId,
        { serviceId: target.primaryServiceId, staffId: target.resourceId, startAt: target.startAt },
        { session },
      );
      if (booked >= target.maxParticipants) {
        throw Object.assign(new Error('this class is full; pick another time or batch'), { status: 409 });
      }
    } else if (target.serviceMode) {
      const overlap = await BusinessSlotState.findOverlap(
        businessId,
        target.resourceId,
        target.conflictStart,
        target.conflictEnd,
        { session },
      );
      if (overlap) {
        throw Object.assign(new Error('that time was just taken; pick another'), { status: 409 });
      }
    }

    if (!target.groupClass) {
      const claimed = [];
      for (const slot of slotsForTarget(target)) {
        const slotOk = await BusinessSlotState.insertBooked(
          businessId,
          {
            resourceId: slot.resourceId,
            startAt: slot.startAt,
            endAt: slot.endAt,
            booking: bookingMeta,
          },
          { session },
        );
        if (!slotOk) {
          if (!session) {
            for (const done of claimed) {
              await BusinessSlotState.removeBooked(businessId, done.resourceId, done.startAt);
            }
          }
          throw Object.assign(new Error('slot is no longer available'), { status: 409 });
        }
        claimed.push(slot);
      }
    }

    try {
      return await Booking.insert(
        {
          _id: bookingMeta.bookingId,
          businessId: business._id,
          businessName: business.name,
          typeLabel: business.typeLabel,
          vendorId: business.vendorId,
          resourceId: target.resourceId,
          resourceName: target.resourceName,
          startAt: new Date(target.startAt),
          endAt: new Date(target.endAt),
          pricePerSlot: target.pricePerSlot,
          customerUserId,
          customerName: bookingMeta.customerName,
          customerMobile: bookingMeta.customerMobile,
          ...serviceFields,
          ...groupFields,
          ...(target.multiSlot ? { slots: target.slots } : {}),
        },
        { session },
      );
    } catch (err) {
      if (!session && !target.groupClass) {
        for (const slot of slotsForTarget(target)) {
          await BusinessSlotState.removeBooked(businessId, slot.resourceId, slot.startAt);
        }
      }
      if (err?.code === 11000) {
        throw Object.assign(new Error('slot is no longer available'), { status: 409 });
      }
      throw err;
    }
  });

  return { booking };
};

// ───────────────────────── Payment-backed booking flow ─────────────────────────

const buildReturnUrl = (bookingId) => {
  const tpl = process.env.CASHFREE_PG_RETURN_URL;
  if (!tpl) return undefined;
  // Cashfree substitutes {order_id}; also support our own {bookingId} token.
  return tpl.replace('{bookingId}', bookingId);
};

// Secure a paid booking once Cashfree confirms payment. Promotes the pending
// hold to a permanent `booked` slot and the booking to `confirmed`. Idempotent.
const settlePaid = async (booking, { cashfreeOrderId, paymentRef } = {}) => {
  const raw = booking._raw ?? {};
  const isGroup = raw.groupClass === true;
  const holdResourceId =
    raw.holdResourceId ||
    pendingHoldResourceId(booking.resourceId, booking.startAt, String(raw.customerUserId ?? ''));

  let settled = false;
  await withTransaction(async (session) => {
    if (isGroup) {
      await BusinessSlotState.releasePending(
        booking.businessId,
        holdResourceId,
        booking.startAt,
        booking.id,
        { session },
      );
      const serviceId = raw.services?.[0]?.id;
      const maxParticipants = Number(raw.maxParticipants) || 1;
      const booked = await Booking.countActiveOccurrenceBookings(
        booking.businessId,
        { serviceId, staffId: booking.resourceId, startAt: booking.startAt },
        { session, excludeBookingId: booking.id },
      );
      if (booked >= maxParticipants) {
        await Booking.markUnpaid(booking.id, BOOKING_STATUS.PAYMENT_FAILED, { session });
        return;
      }
    } else {
      for (const slot of slotsForBooking(booking)) {
        const confirmed = await BusinessSlotState.confirmPending(
          booking.businessId,
          slot.resourceId,
          slot.startAt,
          booking.id,
          { session },
        );
        if (!confirmed) {
          const ok = await BusinessSlotState.insertBooked(
            booking.businessId,
            {
              resourceId: slot.resourceId,
              startAt: slot.startAt,
              endAt: slot.endAt,
              booking: {
                bookingId: booking.id,
                customerUserId: String(raw.customerUserId ?? ''),
                customerName: booking.customerName,
                customerMobile: booking.customerMobile,
              },
            },
            { session },
          );
          if (!ok) {
            await Booking.markUnpaid(booking.id, BOOKING_STATUS.PAYMENT_FAILED, { session });
            return;
          }
        }
      }
    }
    await Booking.markPaid(booking.id, { cashfreeOrderId, paymentRef }, { session });
    settled = true;
  });

  // Record the payment in the unified ledger (idempotent) and link it back onto
  // the booking. Outside the slot transaction so a ledger issue can't unpay it.
  if (settled) {
    const pay = await paymentService.recordPayment({
      source: 'booking',
      sourceId: booking.id,
      sourceRef: raw.refId || booking.refId,
      vendorId: raw.vendorId,
      customerUserId: raw.customerUserId,
      amount: typeof raw.amount === 'number' ? raw.amount : booking.pricePerSlot,
      currency: raw.currency || 'INR',
      cashfreeOrderId,
      gatewayPaymentId: paymentRef,
    });
    if (pay?.refId) await Booking.setPaymentRefId(booking.id, pay.refId);
  }
};

// Release a pending hold and move the booking to a terminal unpaid state.
const releaseHold = async (booking, status) => {
  const raw = booking._raw ?? {};
  const isGroup = raw.groupClass === true;
  const holdResourceId =
    raw.holdResourceId ||
    pendingHoldResourceId(booking.resourceId, booking.startAt, String(raw.customerUserId ?? ''));

  await withTransaction(async (session) => {
    await Booking.markUnpaid(booking.id, status, { session });
    if (isGroup) {
      await BusinessSlotState.releasePending(
        booking.businessId,
        holdResourceId,
        booking.startAt,
        booking.id,
        { session },
      );
      return;
    }
    for (const slot of slotsForBooking(booking)) {
      await BusinessSlotState.releasePending(
        booking.businessId,
        slot.resourceId,
        slot.startAt,
        booking.id,
        { session },
      );
    }
  });
};

// Resolve a unified booking target from the request, for both the fixed-grid
// (resource) model and the service-first (staff) model.
const resolveBookingTarget = async (business, body) => {
  const businessId = String(business._id);
  if (isServiceBusiness(business)) {
    const serviceIds = Array.isArray(body.serviceIds)
      ? body.serviceIds.join(',')
      : String(body.serviceIds ?? '');
    const startAt = String(body.startAt ?? '').trim();
    if (!serviceIds.trim() || !startAt) {
      throw Object.assign(new Error('serviceIds and startAt required'), { status: 400 });
    }
    const resolved = await assertServiceSlotForBooking(businessId, business, {
      serviceIds,
      staffId: String(body.staffId ?? '').trim() || undefined,
      startAt,
      pricingModel: String(body.pricingModel ?? '').trim() || undefined,
    });
    return {
      serviceMode: true,
      resourceId: resolved.staffId,
      resourceName: resolved.staffName,
      startAt: resolved.startAt,
      endAt: resolved.endAt,
      pricePerSlot: resolved.pricePerSlot,
      services: resolved.services,
      serviceLabel: resolved.serviceLabel,
      durationMinutes: resolved.durationMinutes,
      conflictStart: resolved.conflictStart,
      conflictEnd: resolved.conflictEnd,
      groupClass: resolved.groupClass === true,
      classSessionKey: resolved.classSessionKey,
      maxParticipants: resolved.maxParticipants,
      primaryServiceId: resolved.primaryServiceId,
      pricingModel: resolved.pricingModel,
      periodKind: resolved.periodKind,
      periodKey: resolved.periodKey,
    };
  }

  const resourceId = String(body.resourceId ?? '').trim();
  // Accept either a single `startAt` or a `startAts` array (multi-slot booking
  // — e.g. booking 6–7, 7–8 and 8–9 on the same turf in one paid order).
  const rawStarts =
    Array.isArray(body.startAts) && body.startAts.length
      ? body.startAts
      : [body.startAt];
  const starts = [...new Set(rawStarts.map((s) => String(s ?? '').trim()).filter(Boolean))];
  if (!resourceId || !starts.length) {
    throw Object.assign(new Error('resourceId and startAt required'), { status: 400 });
  }
  const resource = business.setup.resources.find((r) => r.id === resourceId);
  const resourceName = resource?.name ?? '';

  const slots = [];
  for (const s of starts) {
    const slot = await assertSlotForBooking(businessId, business, resourceId, s);
    slots.push({
      resourceId,
      resourceName,
      startAt: slot.startAt,
      endAt: slot.endAt,
      pricePerSlot: Number(slot.pricePerSlot) || 0,
    });
  }
  slots.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());

  if (slots.length === 1) {
    return {
      serviceMode: false,
      resourceId,
      resourceName,
      startAt: slots[0].startAt,
      endAt: slots[0].endAt,
      pricePerSlot: slots[0].pricePerSlot,
    };
  }

  const total = slots.reduce((sum, s) => sum + s.pricePerSlot, 0);
  return {
    serviceMode: false,
    multiSlot: true,
    resourceId,
    resourceName,
    startAt: slots[0].startAt,
    endAt: slots[slots.length - 1].endAt,
    pricePerSlot: total,
    slots,
  };
};

// Every slot a target occupies — one entry for a normal booking, many for a
// multi-slot booking. Used to hold/confirm/release/remove uniformly.
const slotsForTarget = (target) =>
  Array.isArray(target.slots) && target.slots.length
    ? target.slots
    : [
        {
          resourceId: target.resourceId,
          resourceName: target.resourceName,
          startAt: target.startAt,
          endAt: target.endAt,
          pricePerSlot: target.pricePerSlot,
        },
      ];

// Slots recorded on a persisted booking doc (falls back to its single slot).
const slotsForBooking = (booking) => {
  const raw = booking._raw ?? booking;
  return Array.isArray(raw.slots) && raw.slots.length
    ? raw.slots.map((s) => ({
        resourceId: s.resourceId,
        startAt: s.startAt?.toISOString?.() ?? s.startAt,
        endAt: s.endAt?.toISOString?.() ?? s.endAt,
      }))
    : [{ resourceId: booking.resourceId, startAt: booking.startAt, endAt: booking.endAt }];
};

// Claim a pending hold for the target inside a transaction. Service-mode also
// guards against overlapping (different-start) appointments for the staff.
const claimPendingForTarget = async (businessId, target, { expiresAt, booking }, session) => {
  // Multi-slot bookings hold every selected slot under the same booking id.
  if (target.multiSlot) {
    const claimed = [];
    for (const slot of slotsForTarget(target)) {
      const ok = await BusinessSlotState.claimPending(
        businessId,
        {
          resourceId: slot.resourceId,
          startAt: slot.startAt,
          endAt: slot.endAt,
          expiresAt,
          booking,
        },
        { session },
      );
      if (!ok) {
        // On a standalone mongod there's no transaction to roll us back, so
        // release the slots we already grabbed before failing.
        if (!session) {
          for (const done of claimed) {
            await BusinessSlotState.releasePending(
              businessId,
              done.resourceId,
              done.startAt,
              booking.bookingId,
            );
          }
        }
        return false;
      }
      claimed.push(slot);
    }
    return true;
  }

  const holdResourceId = target.groupClass
    ? pendingHoldResourceId(target.resourceId, target.startAt, booking.customerUserId)
    : target.resourceId;

  if (target.serviceMode && target.groupClass) {
    const booked = await Booking.countActiveOccurrenceBookings(businessId, {
      serviceId: target.primaryServiceId,
      staffId: target.resourceId,
      startAt: target.startAt,
    }, { session });
    if (booked >= target.maxParticipants) {
      throw Object.assign(new Error('this class is full; pick another time or batch'), { status: 409 });
    }
    const already = await Booking.hasCustomerActiveForOccurrence(businessId, booking.customerUserId, {
      serviceId: target.primaryServiceId,
      staffId: target.resourceId,
      startAt: target.startAt,
    });
    if (already) {
      throw Object.assign(
        new Error(
          target.periodKind && target.periodKind !== 'exact'
            ? `you are already enrolled in this class for this ${target.periodKind}`
            : 'you already have a booking for this class',
        ),
        { status: 409 },
      );
    }
  } else if (target.serviceMode) {
    const overlap = await BusinessSlotState.findOverlap(
      businessId,
      target.resourceId,
      target.conflictStart,
      target.conflictEnd,
      { session },
    );
    if (overlap) {
      throw Object.assign(new Error('that time was just taken; pick another'), { status: 409 });
    }
  }
  return BusinessSlotState.claimPending(
    businessId,
    {
      resourceId: holdResourceId,
      startAt: target.startAt,
      endAt: target.endAt,
      expiresAt,
      booking,
    },
    { session },
  );
};

const slotResourceIdForTarget = (target, customerUserId) =>
  target.groupClass
    ? pendingHoldResourceId(target.resourceId, target.startAt, customerUserId)
    : target.resourceId;

const initiateBooking = async (customerUserId, body) => {
  const businessId = String(body.businessId ?? '').trim();
  if (!businessId) {
    throw Object.assign(new Error('businessId required'), { status: 400 });
  }
  if (!cashfreePayments.isConfigured()) {
    throw Object.assign(new Error('payments are not configured'), { status: 503 });
  }

  const user = await User.findById(customerUserId);
  if (!user) throw Object.assign(new Error('user not found'), { status: 404 });

  const business = await getLiveBusiness(businessId);
  const target = await resolveBookingTarget(business, body);
  if (new Date(target.startAt).getTime() <= Date.now()) {
    throw Object.assign(new Error('cannot book a time in the past'), { status: 400 });
  }

  const amount = Number(target.pricePerSlot) || 0;
  if (amount <= 0) {
    throw Object.assign(new Error('this booking has no price set; contact the business'), { status: 400 });
  }

  const bookingId = randomUUID();
  const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60 * 1000);
  const bookingMeta = {
    bookingId,
    customerUserId: String(customerUserId),
    customerName: user.name ?? 'Customer',
    customerMobile: user.mobile ?? '',
  };

  const serviceFields = target.serviceMode
    ? {
        services: target.services,
        serviceLabel: target.serviceLabel,
        durationMinutes: target.durationMinutes,
      }
    : {};

  const groupFields = target.groupClass
    ? {
        groupClass: true,
        classSessionKey: target.classSessionKey,
        holdResourceId: slotResourceIdForTarget(target, String(customerUserId)),
        maxParticipants: target.maxParticipants,
        ...(target.pricingModel ? { pricingModel: target.pricingModel } : {}),
        ...(target.periodKind && target.periodKind !== 'exact'
          ? { periodKind: target.periodKind, periodKey: target.periodKey }
          : {}),
      }
    : {};

  // Hold the slot + create the pending booking atomically.
  await withTransaction(async (session) => {
    const ok = await claimPendingForTarget(businessId, target, { expiresAt, booking: bookingMeta }, session);
    if (!ok) {
      throw Object.assign(new Error('slot is no longer available'), { status: 409 });
    }
    try {
      await Booking.insertPending(
        {
          _id: bookingId,
          businessId: business._id,
          businessName: business.name,
          typeLabel: business.typeLabel,
          vendorId: business.vendorId,
          resourceId: target.resourceId,
          resourceName: target.resourceName,
          startAt: new Date(target.startAt),
          endAt: new Date(target.endAt),
          pricePerSlot: target.pricePerSlot,
          amount,
          currency: 'INR',
          customerUserId,
          customerName: bookingMeta.customerName,
          customerMobile: bookingMeta.customerMobile,
          expiresAt,
          ...serviceFields,
          ...groupFields,
          ...(target.multiSlot ? { slots: target.slots } : {}),
        },
        { session },
      );
    } catch (err) {
      if (!session) {
        if (target.multiSlot) {
          for (const slot of slotsForTarget(target)) {
            await BusinessSlotState.releasePending(businessId, slot.resourceId, slot.startAt, bookingId);
          }
        } else {
          await BusinessSlotState.releasePending(
            businessId,
            groupFields.holdResourceId ?? target.resourceId,
            target.startAt,
            bookingId,
          );
        }
      }
      throw err;
    }
  });

  // Create the Cashfree order (external call, outside the transaction).
  let order;
  try {
    order = await cashfreePayments.createOrder({
      orderId: bookingId,
      amount,
      customer: {
        id: String(customerUserId),
        phone: user.mobile,
        name: user.name,
        email: user.email,
      },
      returnUrl: buildReturnUrl(bookingId),
      notifyUrl: process.env.CASHFREE_PG_NOTIFY_URL || undefined,
      expiryIso: expiresAt.toISOString(),
      note: `Booking · ${business.name}`,
    });
  } catch (err) {
    console.error(
      'cashfree createOrder failed:',
      err.detail || err.message,
      err.data ? JSON.stringify(err.data) : '',
    );
    const pending = await Booking.findById(bookingId);
    if (pending) await releaseHold(pending, BOOKING_STATUS.PAYMENT_FAILED);
    const clientMsg =
      err.detail ||
      err.message ||
      'Could not start payment. Check Cashfree PG credentials and sandbox/prod mode match.';
    throw Object.assign(new Error(clientMsg), { status: err.status === 401 || err.status === 403 ? 502 : err.status || 502 });
  }

  const paymentSessionId = order.payment_session_id;
  const cashfreeOrderId = order.cf_order_id || order.order_id || bookingId;
  await Booking.attachPaymentSession(bookingId, { paymentSessionId, cashfreeOrderId });

  const booking = await Booking.getForCustomer(bookingId, customerUserId);
  return {
    booking,
    payment: {
      orderId: bookingId,
      cashfreeOrderId,
      paymentSessionId,
      amount,
      currency: 'INR',
      expiresAt: expiresAt.toISOString(),
      mode: process.env.CASHFREE_PG_ENV === 'production' ? 'production' : 'sandbox',
    },
  };
};

// Read a booking's current state, reconciling with Cashfree if still pending
// (covers delayed/missed webhooks). Scoped to the owning customer.
const getBookingStatus = async (customerUserId, bookingId) => {
  let booking = await Booking.getForCustomer(bookingId, customerUserId);
  if (!booking) throw Object.assign(new Error('booking not found'), { status: 404 });

  if (booking.status === BOOKING_STATUS.PENDING_PAYMENT && cashfreePayments.isConfigured()) {
    const raw = await Booking.findById(bookingId);
    let order;
    try {
      order = await cashfreePayments.getOrder(bookingId);
    } catch {
      order = null;
    }
    if (order?.order_status === 'PAID') {
      await settlePaid(raw, { cashfreeOrderId: order.cf_order_id, paymentRef: order.cf_order_id });
    } else if (['EXPIRED', 'TERMINATED', 'CANCELLED'].includes(order?.order_status)) {
      await releaseHold(raw, BOOKING_STATUS.EXPIRED);
    }
    booking = await Booking.getForCustomer(bookingId, customerUserId);
  }
  return { booking };
};

// Cashfree webhook (signature already verified at the route). Trusts the
// verified payload for happy/fail paths; reconciliation covers the rest.
const handlePaymentWebhook = async (payload) => {
  const data = payload?.data || {};
  const orderId = data.order?.order_id;
  if (!orderId) return { ok: true, ignored: true };

  const booking = await Booking.findById(orderId);
  if (!booking || booking.status !== BOOKING_STATUS.PENDING_PAYMENT) {
    return { ok: true, ignored: true };
  }

  const paymentStatus = data.payment?.payment_status;
  const orderStatus = data.order?.order_status;
  const cashfreeOrderId = data.order?.cf_order_id || booking.cashfreeOrderId;
  const paymentRef = data.payment?.cf_payment_id;

  if (paymentStatus === 'SUCCESS' || orderStatus === 'PAID') {
    await settlePaid(booking, { cashfreeOrderId, paymentRef });
  } else if (['FAILED', 'USER_DROPPED', 'CANCELLED'].includes(paymentStatus)) {
    await releaseHold(booking, BOOKING_STATUS.PAYMENT_FAILED);
  }
  return { ok: true };
};

// Periodic sweeper: release holds whose payment window elapsed. Verifies with
// Cashfree first so a slot paid at the boundary is confirmed, not released.
const releaseExpiredHolds = async () => {
  const expired = await BusinessSlotState.listExpiredPending();
  let released = 0;
  let confirmed = 0;
  for (const hold of expired) {
    const bookingId = hold.booking?.bookingId;
    if (!bookingId) continue;
    const booking = await Booking.findById(bookingId);
    if (!booking || booking.status !== BOOKING_STATUS.PENDING_PAYMENT) continue;

    if (cashfreePayments.isConfigured()) {
      try {
        const order = await cashfreePayments.getOrder(bookingId);
        if (order?.order_status === 'PAID') {
          await settlePaid(booking, {
            cashfreeOrderId: order.cf_order_id,
            paymentRef: order.cf_order_id,
          });
          confirmed += 1;
          continue;
        }
      } catch {
        // Cashfree unreachable — fall through and release the stale hold.
      }
    }
    await releaseHold(booking, BOOKING_STATUS.EXPIRED);
    released += 1;
  }
  return { scanned: expired.length, released, confirmed };
};

const listCustomerBookings = async (customerUserId) => {
  const bookings = await Booking.listByCustomer(customerUserId);
  return { bookings };
};

const listVendorBookings = async (vendorId, { businessId } = {}) => {
  const bookings = await Booking.listByVendor(vendorId, { businessId });
  return { bookings };
};

const cancelBooking = async (customerUserId, bookingId) => {
  const booking = await Booking.findByIdForCustomer(bookingId, customerUserId);
  if (!booking) throw Object.assign(new Error('booking not found'), { status: 404 });

  if (new Date(booking.startAt).getTime() <= Date.now()) {
    throw Object.assign(new Error('cannot cancel a slot that has already started'), { status: 400 });
  }

  const full = await Booking.findById(bookingId);
  const isGroup = full?._raw?.groupClass === true;

  await withTransaction(async (session) => {
    await Booking.cancelById(bookingId, customerUserId, { session });
    if (!isGroup) {
      for (const slot of slotsForBooking(full ?? booking)) {
        await BusinessSlotState.removeBooked(
          booking.businessId,
          slot.resourceId,
          slot.startAt,
          { session },
        );
      }
    }
  });

  // Cancelling no longer auto-refunds. Refunds are issued by support after the
  // customer raises a refund ticket (subject to the 7-day window / not-yet-paid-out).
  const refund = { refunded: false, reason: booking.paymentStatus === 'paid' ? 'via_support' : 'not_paid' };
  return { ok: true, refund };
};

const ensureIndexes = () => Booking.ensureIndexes();

module.exports = {
  ensureIndexes,
  listPublicBusinesses,
  getPublicBusiness,
  listPublicSlots,
  createBooking,
  initiateBooking,
  getBookingStatus,
  handlePaymentWebhook,
  releaseExpiredHolds,
  listCustomerBookings,
  listVendorBookings,
  cancelBooking,
};
