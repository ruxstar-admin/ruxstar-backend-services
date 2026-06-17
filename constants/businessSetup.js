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

module.exports = {
  DAYS,
  DAY_LABELS,
  DEFAULT_WEEKLY_HOURS,
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  SLOT_MINUTES_OPTIONS,
  SETUP_MODULES,
};
