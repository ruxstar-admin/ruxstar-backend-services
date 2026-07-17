const { DAYS, PRICING_MODELS, ENROLLMENT_TYPES, MAX_CLASS_PARTICIPANTS } = require('../constants/businessSetup');

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

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

const maxParticipantsFor = (service) => normalizeMaxParticipants(service?.maxParticipants, service?.enrollmentType);

const isGroupClass = (service) => {
  const enrollment = normalizeEnrollmentType(service?.enrollmentType);
  return maxParticipantsFor(service) > 1 || enrollment === 'limited' || enrollment === 'batch' || enrollment === 'monthly';
};

const usesFixedTimings = (service) => {
  const enrollment = normalizeEnrollmentType(service?.enrollmentType);
  return enrollment === 'batch' || enrollment === 'monthly';
};

const computeBookingPrice = (service, durationMinutes) => {
  const base = Math.round(Number(service?.price) || 0);
  const model = normalizePricingModel(service?.pricingModel);
  if (model === 'hourly') {
    return Math.round(base * (Number(durationMinutes) || 60) / 60);
  }
  return base;
};

const pricingUnitLabel = (service) => {
  switch (normalizePricingModel(service?.pricingModel)) {
    case 'hourly':
      return '/hr';
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

module.exports = {
  normalizePricingModel,
  normalizeEnrollmentType,
  normalizeMaxParticipants,
  normalizeClassTimings,
  maxParticipantsFor,
  isGroupClass,
  usesFixedTimings,
  computeBookingPrice,
  pricingUnitLabel,
  classSessionKey,
  pendingHoldResourceId,
  TIME_RE,
};
