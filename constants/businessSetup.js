const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const DAY_LABELS = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

const DEFAULT_WEEKLY_HOURS = Object.fromEntries(
  DAYS.map((day) => [
    day,
    {
      open: '09:00',
      close: '21:00',
      closed: day === 'sun',
    },
  ]),
);

const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const SLOT_MINUTES_OPTIONS = [15, 30, 45, 60, 90, 120];
const SETUP_MODULES = ['appointments'];

// Service-first appointment types (salon/clinic/coaching). These book by
// service + staff with variable durations, instead of a fixed resource grid.
const SERVICE_TYPES = ['salon', 'clinic', 'coaching'];
const isServiceType = (typeId) => SERVICE_TYPES.includes(String(typeId));

const MAX_SERVICES = 40;
const MAX_STAFF = 40;
const MAX_BUFFER_MINUTES = 120;
const MIN_SERVICE_MINUTES = 5;
const MAX_SERVICE_MINUTES = 480;
// Granularity for candidate appointment start times.
const SERVICE_SLOT_STEP_MINUTES = 15;

module.exports = {
  DAYS,
  DAY_LABELS,
  DEFAULT_WEEKLY_HOURS,
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  SLOT_MINUTES_OPTIONS,
  SETUP_MODULES,
  SERVICE_TYPES,
  isServiceType,
  MAX_SERVICES,
  MAX_STAFF,
  MAX_BUFFER_MINUTES,
  MIN_SERVICE_MINUTES,
  MAX_SERVICE_MINUTES,
  SERVICE_SLOT_STEP_MINUTES,
};
