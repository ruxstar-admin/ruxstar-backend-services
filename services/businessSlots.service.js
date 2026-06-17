const Business = require('../models/Business');
const BusinessSlotState = require('../models/BusinessSlotState');
const { SETUP_MODULES } = require('../constants/businessSetup');
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

const getLiveBusiness = async (businessId) => {
  const business = await Business.findLiveById(businessId);
  if (!business) throw Object.assign(new Error('business not found'), { status: 404 });
  if (!SETUP_MODULES.includes(business.module)) {
    throw Object.assign(new Error('booking not available for this business yet'), { status: 400 });
  }
  if (!business.setup?.resources?.length) {
    throw Object.assign(new Error('business is not ready for bookings'), { status: 400 });
  }
  return business;
};

const getOwnedLive = async (businessId, vendorId) => {
  const business = await Business.findByIdForVendor(businessId, vendorId);
  if (!business) throw Object.assign(new Error('business not found'), { status: 404 });
  if (!SETUP_MODULES.includes(business.module)) {
    throw Object.assign(new Error('slots not available for this business type yet'), { status: 400 });
  }
  if (!business.setupComplete) {
    throw Object.assign(new Error('complete business setup before managing slots'), { status: 400 });
  }
  if (!business.setup?.resources?.length) {
    throw Object.assign(new Error('add resources in setup first'), { status: 400 });
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

  const slotMinutes = Number(setup.slotMinutes) || 60;
  const pricePerSlot = Number(setup.pricePerSlot) || 0;
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
  return slots;
};

const mergeStates = (slots, states) => {
  const map = new Map(states.map((s) => [slotKey(s.resourceId, s.startAt), s]));
  return slots.map((slot) => {
    const state = map.get(slot.id);
    if (!state) return slot;
    return {
      ...slot,
      status: state.status === 'booked' ? 'booked' : state.status,
      booking: state.booking,
    };
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
    BusinessSlotState.listInRange(String(business._id), rangeStart, rangeEndExclusive),
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
    resources: business.setup.resources,
    slots,
  };
};

const assertSlotExists = (business, resourceId, startAt) => {
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) {
    throw Object.assign(new Error('invalid startAt'), { status: 400 });
  }

  const dateStr = String(startAt).slice(0, 10);
  const resource = business.setup.resources.find((r) => r.id === String(resourceId));
  if (!resource) throw Object.assign(new Error('resource not found'), { status: 404 });

  const generated = generateSlotsForDay(business, dateStr, resource);
  const normalized = generated.find(
    (s) => new Date(s.startAt).getTime() === start.getTime(),
  );
  if (!normalized) {
    throw Object.assign(new Error('slot not found for this resource and time'), { status: 404 });
  }
  return normalized;
};

const listSlots = async (businessId, vendorId, query) => {
  const business = await getOwnedLive(businessId, vendorId);
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

  return listSlots(businessId, vendorId, {
    from: slot.date,
    to: slot.date,
    resourceId,
  });
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

  return listSlots(businessId, vendorId, {
    from: slot.date,
    to: slot.date,
    resourceId,
  });
};

const ensureIndexes = () => BusinessSlotState.ensureIndexes();

module.exports = {
  ensureIndexes,
  getLiveBusiness,
  buildSlotsPayload,
  assertSlotExists,
  listSlots,
  blockSlot,
  unblockSlot,
};
