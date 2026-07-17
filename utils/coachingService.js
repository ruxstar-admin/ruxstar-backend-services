const { DAYS, PRICING_MODELS, ENROLLMENT_TYPES, MAX_CLASS_PARTICIPANTS } = require('../constants/businessSetup');

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_PRICE_OPTIONS = 5;

const normalizePricingModel = (raw) => {
  const v = String(raw ?? 'per_session').trim();
  return PRICING_MODELS.includes(v) ? v : 'per_session';
};

const normalizeEnrollmentType = (raw) => {
  const v = String(raw ?? 'open').trim();
  return ENROLLMENT_TYPES.includes(v) ? v : 'open';
};

const normalizeMaxParticipants = (raw, enrollmentType) => {
  if (raw === null || raw === undefined || raw === '') {
    if (enrollmentType === 'limited' || enrollmentType === 'batch' || enrollmentType === 'monthly') return 10;
    return 1;
  }
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_CLASS_PARTICIPANTS);
};

const normalizeClassTimings = (raw) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const day = String(item.day ?? '').trim();
    if (!DAYS.includes(day)) continue;
    const startTime = String(item.startTime ?? '').trim();
    if (!TIME_RE.test(startTime)) continue;
    const endTimeRaw = String(item.endTime ?? '').trim();
    const endTime = endTimeRaw && TIME_RE.test(endTimeRaw) ? endTimeRaw : undefined;
    const batchLabel = String(item.batchLabel ?? '').trim();
    out.push({
      day,
      startTime,
      ...(endTime ? { endTime } : {}),
      ...(batchLabel ? { batchLabel: batchLabel.slice(0, 60) } : {}),
    });
  }
  return out;
};

// A class can offer several payment options at once (hourly/daily/weekly/
// monthly), each with its own vendor-set price. `fallback` covers legacy
// single-price services that never set `priceOptions`.
const normalizePriceOptions = (raw, fallback) => {
  const seen = new Map();
  if (Array.isArray(raw)) {
    for (const opt of raw) {
      if (!opt || typeof opt !== 'object') continue;
      const model = normalizePricingModel(opt.pricingModel);
      const price = Math.round(Number(opt.price));
      if (!Number.isFinite(price) || price < 0) continue;
      if (seen.has(model)) continue;
      seen.set(model, { pricingModel: model, price });
    }
  }
  if (!seen.size) {
    const model = normalizePricingModel(fallback?.pricingModel);
    const price = Math.round(Number(fallback?.price) || 0);
    seen.set(model, { pricingModel: model, price });
  }
  return [...seen.values()].slice(0, MAX_PRICE_OPTIONS);
};

const maxParticipantsFor = (service) => normalizeMaxParticipants(service?.maxParticipants, service?.enrollmentType);

const isGroupClass = (service) => {
  const enrollment = normalizeEnrollmentType(service?.enrollmentType);
  return (
    maxParticipantsFor(service) > 1 ||
    enrollment === 'limited' ||
    enrollment === 'batch' ||
    enrollment === 'monthly' ||
    Boolean(service?.classTimings?.length)
  );
};

const usesFixedTimings = (service) => {
  const enrollment = normalizeEnrollmentType(service?.enrollmentType);
  return enrollment === 'batch' || enrollment === 'monthly' || Boolean(service?.classTimings?.length);
};

// All payment options for a service, falling back to its legacy single
// price/pricingModel fields for older records that predate `priceOptions`.
const servicePriceOptions = (service) => {
  if (Array.isArray(service?.priceOptions) && service.priceOptions.length) {
    return normalizePriceOptions(service.priceOptions, { price: service.price, pricingModel: service.pricingModel });
  }
  return [{ pricingModel: normalizePricingModel(service?.pricingModel), price: Math.round(Number(service?.price) || 0) }];
};

// Resolve which payment option a booking request refers to. Falls back to
// the service's primary (first) option when none/an invalid one is given.
const resolvePriceOption = (service, requestedModel) => {
  const options = servicePriceOptions(service);
  if (requestedModel) {
    const wanted = normalizePricingModel(requestedModel);
    const found = options.find((o) => o.pricingModel === wanted);
    if (found) return found;
  }
  return options[0];
};

const computeBookingPrice = (service, durationMinutes, requestedModel) => {
  const option = resolvePriceOption(service, requestedModel);
  if (option.pricingModel === 'hourly') {
    return Math.round(option.price * (Number(durationMinutes) || 60) / 60);
  }
  return option.price;
};

const pricingUnitLabel = (service, requestedModel) => {
  const option = resolvePriceOption(service, requestedModel);
  switch (option.pricingModel) {
    case 'hourly':
      return '/hr';
    case 'daily':
      return '/class';
    case 'weekly':
      return '/week';
    case 'monthly':
      return '/month';
    default:
      return '';
  }
};

const classSessionKey = (serviceId, staffId, startAt) =>
  `${String(serviceId)}:${String(staffId)}:${String(startAt)}`;

const pendingHoldResourceId = (staffId, startAt, customerUserId) =>
  `hold:${String(staffId)}:${String(startAt)}:${String(customerUserId)}`;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const istPartsFromIso = (iso) => {
  const d = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    dow: d.getUTCDay(), // 0=Sun..6=Sat
  };
};

// "YYYY-MM" for the IST calendar month a UTC-backed startAt instant falls in.
const monthKeyFromIso = (iso) => {
  const p = istPartsFromIso(iso);
  return `${p.y}-${String(p.m).padStart(2, '0')}`;
};

// "YYYY-MM-DD" of the Monday that starts the IST week an instant falls in.
const weekKeyFromIso = (iso) => {
  const p = istPartsFromIso(iso);
  const utcMidnight = Date.UTC(p.y, p.m - 1, p.day);
  const daysSinceMonday = (p.dow + 6) % 7;
  const monday = new Date(utcMidnight - daysSinceMonday * 86400000);
  return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, '0')}-${String(monday.getUTCDate()).padStart(2, '0')}`;
};

// Payment options that bill once for a whole period (week/month) instead of
// a single occurrence — capacity/dedup must be grouped by that period.
const periodKindForModel = (pricingModel) => {
  if (pricingModel === 'monthly') return 'month';
  if (pricingModel === 'weekly') return 'week';
  return 'exact';
};

const isPeriodEnrollment = (pricingModel) => periodKindForModel(pricingModel) !== 'exact';

// Stable grouping key for capacity/dedup checks: exact session for one-off
// payments, or the shared week/month key for period-billed enrollments.
const enrollmentGroupKey = (serviceId, staffId, pricingModel, startAtIso) => {
  const kind = periodKindForModel(pricingModel);
  if (kind === 'month') return `${serviceId}:${staffId}:m:${monthKeyFromIso(startAtIso)}`;
  if (kind === 'week') return `${serviceId}:${staffId}:w:${weekKeyFromIso(startAtIso)}`;
  return classSessionKey(serviceId, staffId, startAtIso);
};

const periodKeyForModel = (pricingModel, startAtIso) => {
  const kind = periodKindForModel(pricingModel);
  if (kind === 'month') return monthKeyFromIso(startAtIso);
  if (kind === 'week') return weekKeyFromIso(startAtIso);
  return undefined;
};

// Combined seat usage for one specific occurrence, across bookings made
// under ANY of a class's payment options: a monthly/weekly booking occupies
// a seat at every occurrence within its period, an exact one just its own.
const countActiveForOccurrence = (rows, occurrenceIso, excludeBookingId) => {
  const occExact = new Date(occurrenceIso).toISOString();
  let count = 0;
  for (const row of rows) {
    if (excludeBookingId && String(row._id) === String(excludeBookingId)) continue;
    const rowIso = row.startAt instanceof Date ? row.startAt.toISOString() : new Date(row.startAt).toISOString();
    const kind = periodKindForModel(row.pricingModel);
    if (kind === 'month') {
      if (monthKeyFromIso(rowIso) === monthKeyFromIso(occExact)) count += 1;
    } else if (kind === 'week') {
      if (weekKeyFromIso(rowIso) === weekKeyFromIso(occExact)) count += 1;
    } else if (rowIso === occExact) {
      count += 1;
    }
  }
  return count;
};

// Legacy helper kept for older callers — a service's *enrollment type* (not
// its chosen payment option) used to double as "billed monthly".
const isMonthlyEnrollment = (service) => normalizeEnrollmentType(service?.enrollmentType) === 'monthly';

module.exports = {
  normalizePricingModel,
  normalizeEnrollmentType,
  normalizeMaxParticipants,
  normalizeClassTimings,
  normalizePriceOptions,
  servicePriceOptions,
  resolvePriceOption,
  maxParticipantsFor,
  isGroupClass,
  usesFixedTimings,
  isMonthlyEnrollment,
  monthKeyFromIso,
  weekKeyFromIso,
  periodKindForModel,
  isPeriodEnrollment,
  enrollmentGroupKey,
  periodKeyForModel,
  countActiveForOccurrence,
  computeBookingPrice,
  pricingUnitLabel,
  classSessionKey,
  pendingHoldResourceId,
  MAX_PRICE_OPTIONS,
  TIME_RE,
};
