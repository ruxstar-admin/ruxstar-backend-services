const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MAX_RANGE_DAYS = 90;

const parseDateOnly = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  const [y, m, d] = String(value).split('-').map(Number);
  if (!y || !m || !d) return null;
  return { y, m, d };
};

const formatDateOnly = (y, m, d) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const addDays = (dateStr, days) => {
  const parts = parseDateOnly(dateStr);
  if (!parts) return null;
  const utc = Date.UTC(parts.y, parts.m - 1, parts.d) + days * 86400000;
  const dt = new Date(utc);
  return formatDateOnly(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
};

const todayInIst = () => {
  const now = Date.now() + IST_OFFSET_MS;
  const dt = new Date(now);
  return formatDateOnly(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
};

const dayKeyForDate = (dateStr) => {
  const parts = parseDateOnly(dateStr);
  if (!parts) return null;
  // Noon IST avoids day-boundary drift vs UTC.
  const utc = Date.UTC(parts.y, parts.m - 1, parts.d, 6, 30, 0);
  return DAY_KEYS[new Date(utc).getUTCDay()];
};

const timeToMinutes = (time) => {
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + m;
};

const minutesToTime = (minutes) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const slotIso = (dateStr, time) => `${dateStr}T${time}:00+05:30`;

const slotKey = (resourceId, startAt) => `${resourceId}|${new Date(startAt).toISOString()}`;

module.exports = {
  IST_OFFSET_MS,
  DAY_KEYS,
  MAX_RANGE_DAYS,
  parseDateOnly,
  formatDateOnly,
  addDays,
  todayInIst,
  dayKeyForDate,
  timeToMinutes,
  minutesToTime,
  slotIso,
  slotKey,
};
