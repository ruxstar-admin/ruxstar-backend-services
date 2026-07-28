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
// Modules whose vendors run the post-create setup wizard (photos + config).
const SETUP_MODULES = ['appointments', 'print', 'commerce', 'creator'];

const MAX_PRINT_CATEGORIES = 30;
const MAX_PRINT_CITIES = 60;
const MAX_TURNAROUND_DAYS = 90;

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

const PRICING_MODELS = ['per_session', 'hourly', 'daily', 'weekly', 'monthly'];
const ENROLLMENT_TYPES = ['open', 'limited', 'batch', 'monthly'];
const MAX_CLASS_PARTICIPANTS = 500;

module.exports = {
  DAYS,
  DAY_LABELS,
  DEFAULT_WEEKLY_HOURS,
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  SETUP_MODULES,
  SERVICE_TYPES,
  isServiceType,
  MAX_SERVICES,
  MAX_STAFF,
  MAX_BUFFER_MINUTES,
  MIN_SERVICE_MINUTES,
  MAX_SERVICE_MINUTES,
  SERVICE_SLOT_STEP_MINUTES,
  PRICING_MODELS,
  ENROLLMENT_TYPES,
  MAX_CLASS_PARTICIPANTS,
  MAX_PRINT_CATEGORIES,
  MAX_PRINT_CITIES,
  MAX_TURNAROUND_DAYS,
};
