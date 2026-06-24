const Business = require('../models/Business');
const BusinessSlotState = require('../models/BusinessSlotState');
const {
  SETUP_MODULES,
  isServiceType,
  SERVICE_SLOT_STEP_MINUTES,
} = require('../constants/businessSetup');
const {
  MAX_RANGE_DAYS,
  parseDateOnly,
  addDays,
  todayInIst,
  dayKeyForDate,
  timeToMinutes,
  minutesToTime,
  slotIso,
  slotKey,
} = require('../utils/slotTime');

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** In-memory slot template cache — avoids regenerating identical week grids. */
const templateCache = new Map();
const TEMPLATE_CACHE_MAX = 128;

const businessCacheKey = (business) => {
  const resourcePrices = (business.setup?.resources ?? [])
    .map((r) => `${r.id}:${r.pricePerSlot ?? ''}`)
    .join(',');
  return `${business._id}:${business.updatedAt ?? ''}:${business.setup?.slotMinutes}:${business.setup?.pricePerSlot}:${business.setup?.bookingMode ?? 'slots'}:${resourcePrices}`;
};

const resourceBasePrice = (resource, setup) => {
  const resourcePrice = Number(resource?.pricePerSlot);
  if (Number.isFinite(resourcePrice) && resourcePrice >= 0) return Math.round(resourcePrice);
  return Math.round(Number(setup?.pricePerSlot) || 0);
};

const isServiceBusiness = (business) => isServiceType(business?.typeId);

const hasBookableSetup = (business) => {
  if (isServiceBusiness(business)) {
    return Boolean(business.setup?.staff?.length && business.setup?.services?.length);
  }
  return Boolean(business.setup?.resources?.length);
};

const getLiveBusiness = async (businessId, { withPhotoData = false } = {}) => {
  const business = await Business.findLiveById(businessId, { withPhotoData });
  if (!business) throw Object.assign(new Error('business not found'), { status: 404 });
  if (!SETUP_MODULES.includes(business.module)) {
    throw Object.assign(new Error('booking not available for this business yet'), { status: 400 });
  }
  if (!hasBookableSetup(business)) {
    throw Object.assign(new Error('business is not ready for bookings'), { status: 400 });
  }
  return business;
};

const getOwnedLive = async (businessId, vendorId) => {
  const business = await Business.findByIdForVendor(businessId, vendorId, { withPhotoData: false });
  if (!business) throw Object.assign(new Error('business not found'), { status: 404 });
  if (!SETUP_MODULES.includes(business.module)) {
    throw Object.assign(new Error('slots not available for this business type yet'), { status: 400 });
  }
  if (!business.setupComplete) {
    throw Object.assign(new Error('complete business setup before managing slots'), { status: 400 });
  }
  if (!hasBookableSetup(business)) {
    throw Object.assign(
      new Error(isServiceBusiness(business) ? 'add staff and services in setup first' : 'add resources in setup first'),
      { status: 400 },
    );
  }
  return business;
};

const parseRange = (from, to) => {
  const fromDate = parseDateOnly(from) ? String(from) : todayInIst();
  let toDate = parseDateOnly(to) ? String(to) : addDays(fromDate, 6);
  if (!toDate) throw Object.assign(new Error('invalid date range'), { status: 400 });

  if (toDate < fromDate) {
    throw Object.assign(new Error('to must be on or after from'), { status: 400 });
  }

  const maxTo = addDays(fromDate, MAX_RANGE_DAYS - 1);
  if (maxTo && toDate > maxTo) toDate = maxTo;

  return { fromDate, toDate };
};

const generateSlotsForDay = (business, dateStr, resource) => {
  const setup = business.setup;
  const dayKey = dayKeyForDate(dateStr);
  if (!dayKey) return [];

  const hours = setup.weeklyHours?.[dayKey];
  if (!hours || hours.closed) return [];

  const pricePerSlot = resourceBasePrice(resource, setup);
  const bookingMode = setup.bookingMode === 'fullDay' ? 'fullDay' : 'slots';

  if (bookingMode === 'fullDay') {
    const startTime = hours.open;
    const endTime = hours.close;
    const startAt = slotIso(dateStr, startTime);
    const endAt = slotIso(dateStr, endTime);
    return [
      {
        id: slotKey(resource.id, startAt),
        resourceId: resource.id,
        resourceName: resource.name,
        date: dateStr,
        startTime,
        endTime,
        startAt,
        endAt,
        pricePerSlot,
        status: 'available',
      },
    ];
  }

  const slotMinutes = Number(setup.slotMinutes) || 60;
  let cursor = timeToMinutes(hours.open);
  const closeMin = timeToMinutes(hours.close);
  const slots = [];

  while (cursor + slotMinutes <= closeMin) {
    const startTime = minutesToTime(cursor);
    const endTime = minutesToTime(cursor + slotMinutes);
    const startAt = slotIso(dateStr, startTime);
    const endAt = slotIso(dateStr, endTime);
    slots.push({
      id: slotKey(resource.id, startAt),
      resourceId: resource.id,
      resourceName: resource.name,
      date: dateStr,
      startTime,
      endTime,
      startAt,
      endAt,
      pricePerSlot,
      status: 'available',
    });
    cursor += slotMinutes;
  }

  return slots;
};

const generateSlots = (business, fromDate, toDate, resourceId) => {
  const cacheId = `${businessCacheKey(business)}:${fromDate}:${toDate}:${resourceId || ''}`;
  const cached = templateCache.get(cacheId);
  if (cached) return cached;

  const resources = business.setup.resources.filter(
    (r) => !resourceId || r.id === resourceId,
  );
  if (resourceId && !resources.length) {
    throw Object.assign(new Error('resource not found'), { status: 404 });
  }

  const slots = [];
  let cursor = fromDate;
  while (cursor <= toDate) {
    for (const resource of resources) {
      slots.push(...generateSlotsForDay(business, cursor, resource));
    }
    cursor = addDays(cursor, 1);
  }

  if (templateCache.size >= TEMPLATE_CACHE_MAX) {
    const oldest = templateCache.keys().next().value;
    templateCache.delete(oldest);
  }
  templateCache.set(cacheId, slots);
  return slots;
};

const mergeStates = (slots, states) => {
  const map = new Map(states.map((s) => [slotKey(s.resourceId, s.startAt), s]));
  return slots.map((slot) => {
    const state = map.get(slot.id);
    if (!state) return slot;

    const basePricePerSlot = slot.pricePerSlot;
    let next = { ...slot, basePricePerSlot };

    if (state.status === 'booked') {
      next.status = 'booked';
      next.booking = state.booking;
      if (state.pricePerSlot != null) next.pricePerSlot = state.pricePerSlot;
      return next;
    }

    // A pending hold blocks the slot only while its payment window is open.
    // Expired holds are ignored (treated as available) — the sweeper / next
    // claim will clean them up.
    if (state.status === 'pending') {
      const active = state.pendingExpiresAt && new Date(state.pendingExpiresAt).getTime() > Date.now();
      if (active) {
        next.status = 'pending';
        if (state.pricePerSlot != null) next.pricePerSlot = state.pricePerSlot;
        return next;
      }
      if (state.pricePerSlot != null) next.pricePerSlot = state.pricePerSlot;
      return next;
    }

    if (state.status === 'blocked') {
      next.status = 'blocked';
      return next;
    }

    if (state.pricePerSlot != null) {
      next.pricePerSlot = state.pricePerSlot;
    }
    return next;
  });
};

const applyPublicView = (slots) => {
  const now = Date.now();
  return slots
    .filter((slot) => new Date(slot.startAt).getTime() > now)
    .map((slot) => ({
      id: slot.id,
      resourceId: slot.resourceId,
      resourceName: slot.resourceName,
      date: slot.date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      startAt: slot.startAt,
      endAt: slot.endAt,
      pricePerSlot: slot.pricePerSlot,
      status: slot.status === 'available' ? 'available' : 'unavailable',
    }));
};

const buildSlotsPayload = async (business, query, { publicView = false } = {}) => {
  const { fromDate, toDate } = parseRange(query.from, query.to);
  const resourceId = query.resourceId ? String(query.resourceId) : undefined;

  const rangeStart = slotIso(fromDate, '00:00');
  const rangeEndExclusive = slotIso(addDays(toDate, 1), '00:00');

  const [generated, states] = await Promise.all([
    Promise.resolve(generateSlots(business, fromDate, toDate, resourceId)),
    BusinessSlotState.listInRange(String(business._id), rangeStart, rangeEndExclusive, resourceId),
  ]);

  let slots = mergeStates(generated, states);
  if (publicView) slots = applyPublicView(slots);

  return {
    businessId: String(business._id),
    from: fromDate,
    to: toDate,
    timezone: 'Asia/Kolkata',
    slotMinutes: business.setup.slotMinutes,
    pricePerSlot: business.setup.pricePerSlot,
    bookingMode: business.setup.bookingMode === 'fullDay' ? 'fullDay' : 'slots',
    resources: business.setup.resources,
    slots,
  };
};

const computeSlot = (business, resource, startAt) => {
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) return null;

  const dateStr = String(startAt).slice(0, 10);
  const startTime = String(startAt).slice(11, 16);
  if (!parseDateOnly(dateStr) || !TIME_RE.test(startTime)) return null;

  const dayKey = dayKeyForDate(dateStr);
  const hours = business.setup.weeklyHours?.[dayKey];
  if (!hours || hours.closed) return null;

  const pricePerSlot = resourceBasePrice(resource, business.setup);
  const bookingMode = business.setup.bookingMode === 'fullDay' ? 'fullDay' : 'slots';
  const startMin = timeToMinutes(startTime);
  const openMin = timeToMinutes(hours.open);
  const closeMin = timeToMinutes(hours.close);

  if (bookingMode === 'fullDay') {
    if (startTime !== hours.open) return null;
    const endTime = hours.close;
    const normalizedStartAt = slotIso(dateStr, startTime);
    if (new Date(normalizedStartAt).getTime() !== start.getTime()) return null;
    return {
      id: slotKey(resource.id, normalizedStartAt),
      resourceId: resource.id,
      resourceName: resource.name,
      date: dateStr,
      startTime,
      endTime,
      startAt: normalizedStartAt,
      endAt: slotIso(dateStr, endTime),
      pricePerSlot,
      status: 'available',
    };
  }

  const slotMinutes = Number(business.setup.slotMinutes) || 60;

  if (startMin < openMin || startMin + slotMinutes > closeMin) return null;
  if ((startMin - openMin) % slotMinutes !== 0) return null;

  const normalizedStartAt = slotIso(dateStr, startTime);
  if (new Date(normalizedStartAt).getTime() !== start.getTime()) return null;

  const endTime = minutesToTime(startMin + slotMinutes);
  return {
    id: slotKey(resource.id, normalizedStartAt),
    resourceId: resource.id,
    resourceName: resource.name,
    date: dateStr,
    startTime,
    endTime,
    startAt: normalizedStartAt,
    endAt: slotIso(dateStr, endTime),
    pricePerSlot,
    status: 'available',
  };
};

const assertSlotExists = (business, resourceId, startAt) => {
  const resource = business.setup.resources.find((r) => r.id === String(resourceId));
  if (!resource) throw Object.assign(new Error('resource not found'), { status: 404 });

  const slot = computeSlot(business, resource, startAt);
  if (!slot) {
    throw Object.assign(new Error('slot not found for this resource and time'), { status: 404 });
  }
  return slot;
};

const assertSlotForBooking = async (businessId, business, resourceId, startAt) => {
  const slot = assertSlotExists(business, resourceId, startAt);
  const state = await BusinessSlotState.findOne(businessId, resourceId, slot.startAt);
  if (state?.status === 'blocked') {
    throw Object.assign(new Error('slot is not available'), { status: 409 });
  }
  if (state?.status === 'booked') {
    throw Object.assign(new Error('slot is no longer available'), { status: 409 });
  }
  const pendingActive =
    state?.status === 'pending' &&
    state.pendingExpiresAt &&
    new Date(state.pendingExpiresAt).getTime() > Date.now();
  if (pendingActive) {
    throw Object.assign(new Error('slot is being booked by someone else; try again shortly'), {
      status: 409,
    });
  }
  return {
    ...slot,
    pricePerSlot: state?.pricePerSlot ?? slot.pricePerSlot,
  };
};

// ───────────────────────── Service-first availability ─────────────────────────

const intervalsOverlap = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

// Resolve the selected services from the setup, preserving setup order.
const resolveSelectedServices = (business, serviceIdsRaw) => {
  const services = Array.isArray(business.setup?.services) ? business.setup.services : [];
  const ids = String(serviceIdsRaw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) return [];
  const byId = new Map(services.map((s) => [s.id, s]));
  // Keep duplicates out, honour requested set.
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const svc = byId.get(id);
    if (svc) {
      out.push(svc);
      seen.add(id);
    }
  }
  return out;
};

// Staff who can perform every selected service (intersection of staffIds).
const eligibleStaffFor = (business, selectedServices, staffId) => {
  const staff = Array.isArray(business.setup?.staff) ? business.setup.staff : [];
  let eligible = staff;
  if (selectedServices.length) {
    eligible = staff.filter((st) =>
      selectedServices.every((svc) => (svc.staffIds ?? []).includes(st.id)),
    );
  }
  if (staffId) eligible = eligible.filter((st) => st.id === String(staffId));
  return eligible;
};

// Active (booked / live-pending) intervals grouped by staff id, in ms.
const busyIntervalsByStaff = (states) => {
  const now = Date.now();
  const map = new Map();
  for (const st of states) {
    const active =
      st.status === 'booked' ||
      (st.status === 'pending' && st.pendingExpiresAt && new Date(st.pendingExpiresAt).getTime() > now);
    if (!active) continue;
    const list = map.get(st.resourceId) ?? [];
    list.push([new Date(st.startAt).getTime(), new Date(st.endAt).getTime()]);
    map.set(st.resourceId, list);
  }
  return map;
};

const buildServiceAvailability = async (business, query) => {
  const { fromDate, toDate } = parseRange(query.from, query.to);
  const services = Array.isArray(business.setup?.services) ? business.setup.services : [];
  const staff = Array.isArray(business.setup?.staff) ? business.setup.staff : [];
  const buffer = Number(business.setup?.bufferMinutes) || 0;
  const bufMs = buffer * 60 * 1000;

  const selected = resolveSelectedServices(business, query.serviceIds);
  const totalDuration = selected.reduce((sum, s) => sum + Number(s.durationMinutes || 0), 0);
  const totalPrice = selected.reduce((sum, s) => sum + Number(s.price || 0), 0);
  const eligible = eligibleStaffFor(business, selected, query.staffId);

  const slots = [];
  if (totalDuration > 0 && eligible.length) {
    const rangeStart = slotIso(fromDate, '00:00');
    const rangeEndExclusive = slotIso(addDays(toDate, 1), '00:00');
    const states = await BusinessSlotState.listInRange(String(business._id), rangeStart, rangeEndExclusive);
    const busyByStaff = busyIntervalsByStaff(states);
    const now = Date.now();

    let cursor = fromDate;
    while (cursor <= toDate) {
      const dayKey = dayKeyForDate(cursor);
      const hours = business.setup.weeklyHours?.[dayKey];
      if (hours && !hours.closed) {
        const openMin = timeToMinutes(hours.open);
        const closeMin = timeToMinutes(hours.close);
        for (let startMin = openMin; startMin + totalDuration <= closeMin; startMin += SERVICE_SLOT_STEP_MINUTES) {
          const startTime = minutesToTime(startMin);
          const endTime = minutesToTime(startMin + totalDuration);
          const startAt = slotIso(cursor, startTime);
          const endAt = slotIso(cursor, endTime);
          const startMs = new Date(startAt).getTime();
          const endMs = new Date(endAt).getTime();
          if (startMs <= now) continue;

          const freeStaff = eligible.find((st) => {
            const busy = busyByStaff.get(st.id) ?? [];
            return !busy.some(([bs, be]) => intervalsOverlap(startMs - bufMs, endMs + bufMs, bs, be));
          });
          if (!freeStaff) continue;

          slots.push({
            id: slotKey(freeStaff.id, startAt),
            resourceId: freeStaff.id,
            resourceName: freeStaff.name,
            staffId: freeStaff.id,
            staffName: freeStaff.name,
            date: cursor,
            startTime,
            endTime,
            startAt,
            endAt,
            pricePerSlot: totalPrice,
            durationMinutes: totalDuration,
            status: 'available',
          });
        }
      }
      cursor = addDays(cursor, 1);
    }
  }

  return {
    businessId: String(business._id),
    from: fromDate,
    to: toDate,
    timezone: 'Asia/Kolkata',
    bookingMode: 'services',
    bufferMinutes: buffer,
    services,
    staff,
    selectedServiceIds: selected.map((s) => s.id),
    durationMinutes: totalDuration,
    pricePerSlot: totalPrice,
    slots,
  };
};

// Validate a service booking request and resolve the concrete staff + window.
const assertServiceSlotForBooking = async (businessId, business, { serviceIds, staffId, startAt }) => {
  const selected = resolveSelectedServices(business, serviceIds);
  if (!selected.length) {
    throw Object.assign(new Error('select at least one service'), { status: 400 });
  }
  const totalDuration = selected.reduce((sum, s) => sum + Number(s.durationMinutes || 0), 0);
  const totalPrice = selected.reduce((sum, s) => sum + Number(s.price || 0), 0);

  const dateStr = String(startAt).slice(0, 10);
  const startTime = String(startAt).slice(11, 16);
  if (!parseDateOnly(dateStr) || !TIME_RE.test(startTime)) {
    throw Object.assign(new Error('invalid start time'), { status: 400 });
  }
  const dayKey = dayKeyForDate(dateStr);
  const hours = business.setup.weeklyHours?.[dayKey];
  if (!hours || hours.closed) {
    throw Object.assign(new Error('closed on this day'), { status: 409 });
  }
  const startMinutes = timeToMinutes(startTime);
  const openMin = timeToMinutes(hours.open);
  const closeMin = timeToMinutes(hours.close);
  if (startMinutes < openMin || startMinutes + totalDuration > closeMin) {
    throw Object.assign(new Error('that time is outside opening hours'), { status: 409 });
  }

  const normalizedStartAt = slotIso(dateStr, startTime);
  const endTime = minutesToTime(startMinutes + totalDuration);
  const normalizedEndAt = slotIso(dateStr, endTime);

  const eligible = eligibleStaffFor(business, selected, staffId);
  if (!eligible.length) {
    throw Object.assign(new Error('no staff can perform the selected services'), { status: 409 });
  }

  const buffer = Number(business.setup?.bufferMinutes) || 0;
  const bufMs = buffer * 60 * 1000;
  const startMs = new Date(normalizedStartAt).getTime();
  const endMs = new Date(normalizedEndAt).getTime();
  const conflictStart = new Date(startMs - bufMs);
  const conflictEnd = new Date(endMs + bufMs);

  // Pick the first eligible staff member who is free for the whole window.
  let chosen = null;
  for (const st of eligible) {
    const overlap = await BusinessSlotState.findOverlap(businessId, st.id, conflictStart, conflictEnd);
    if (!overlap) {
      chosen = st;
      break;
    }
  }
  if (!chosen) {
    throw Object.assign(new Error('that time was just taken; pick another'), { status: 409 });
  }

  return {
    staffId: chosen.id,
    staffName: chosen.name,
    startAt: normalizedStartAt,
    endAt: normalizedEndAt,
    startTime,
    endTime,
    conflictStart,
    conflictEnd,
    durationMinutes: totalDuration,
    pricePerSlot: totalPrice,
    services: selected.map((s) => ({ id: s.id, name: s.name })),
    serviceLabel: selected.map((s) => s.name).join(', '),
  };
};

const listSlots = async (businessId, vendorId, query) => {
  const business = await getOwnedLive(businessId, vendorId);
  if (isServiceBusiness(business)) return buildServiceAvailability(business, query);
  return buildSlotsPayload(business, query, { publicView: false });
};

const blockSlot = async (businessId, vendorId, body) => {
  const business = await getOwnedLive(businessId, vendorId);
  const resourceId = String(body.resourceId ?? '').trim();
  const startAt = String(body.startAt ?? '').trim();
  if (!resourceId || !startAt) {
    throw Object.assign(new Error('resourceId and startAt required'), { status: 400 });
  }

  const slot = assertSlotExists(business, resourceId, startAt);
  const existing = await BusinessSlotState.findOne(businessId, resourceId, slot.startAt);
  if (existing?.status === 'booked') {
    throw Object.assign(new Error('cannot block a booked slot'), { status: 409 });
  }

  await BusinessSlotState.upsertBlocked(businessId, {
    resourceId,
    startAt: slot.startAt,
    endAt: slot.endAt,
  });

  return { ok: true };
};

const unblockSlot = async (businessId, vendorId, body) => {
  const business = await getOwnedLive(businessId, vendorId);
  const resourceId = String(body.resourceId ?? '').trim();
  const startAt = String(body.startAt ?? '').trim();
  if (!resourceId || !startAt) {
    throw Object.assign(new Error('resourceId and startAt required'), { status: 400 });
  }

  const slot = assertSlotExists(business, resourceId, startAt);
  const existing = await BusinessSlotState.findOne(businessId, resourceId, slot.startAt);
  if (existing?.status === 'booked') {
    throw Object.assign(new Error('cannot unblock a booked slot'), { status: 409 });
  }

  const ok = await BusinessSlotState.removeBlocked(businessId, resourceId, slot.startAt);
  if (!ok) throw Object.assign(new Error('slot is not blocked'), { status: 404 });

  return { ok: true };
};

const setSlotPrice = async (businessId, vendorId, body) => {
  const business = await getOwnedLive(businessId, vendorId);
  const resourceId = String(body.resourceId ?? '').trim();
  const startAt = String(body.startAt ?? '').trim();
  const pricePerSlot = body.pricePerSlot;
  if (!resourceId || !startAt || pricePerSlot === undefined) {
    throw Object.assign(new Error('resourceId, startAt and pricePerSlot required'), { status: 400 });
  }

  const slot = assertSlotExists(business, resourceId, startAt);
  const resource = business.setup.resources.find((r) => r.id === resourceId);
  const base = resourceBasePrice(resource, business.setup);
  const price = Math.round(Number(pricePerSlot));
  if (price < base) {
    throw Object.assign(new Error('demand price must be at least the base slot price'), { status: 400 });
  }

  if (price === base) {
    await BusinessSlotState.clearPriceOverride(businessId, resourceId, slot.startAt);
    return { ok: true, pricePerSlot: base };
  }

  await BusinessSlotState.upsertPriceOverride(businessId, {
    resourceId,
    startAt: slot.startAt,
    endAt: slot.endAt,
    pricePerSlot: price,
  });

  return { ok: true, pricePerSlot: price };
};

const clearSlotPrice = async (businessId, vendorId, body) => {
  const business = await getOwnedLive(businessId, vendorId);
  const resourceId = String(body.resourceId ?? '').trim();
  const startAt = String(body.startAt ?? '').trim();
  if (!resourceId || !startAt) {
    throw Object.assign(new Error('resourceId and startAt required'), { status: 400 });
  }

  const slot = assertSlotExists(business, resourceId, startAt);
  const ok = await BusinessSlotState.clearPriceOverride(businessId, resourceId, slot.startAt);
  if (!ok) throw Object.assign(new Error('slot has no demand price set'), { status: 404 });

  return { ok: true };
};

const ensureIndexes = () => BusinessSlotState.ensureIndexes();

module.exports = {
  ensureIndexes,
  getLiveBusiness,
  isServiceBusiness,
  buildSlotsPayload,
  buildServiceAvailability,
  assertSlotExists,
  assertSlotForBooking,
  assertServiceSlotForBooking,
  listSlots,
  blockSlot,
  unblockSlot,
  setSlotPrice,
  clearSlotPrice,
};
