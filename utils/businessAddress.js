/**
 * Business addresses are stored twice: as structured `addressParts` (used for
 * city filtering, print-order routing and future distance search) and as a
 * composed `address` string for display. Older rows only have the string, so
 * every reader must fall back to `parseAddress` on the free text.
 */

const INDIAN_STATES = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
  'Andaman and Nicobar Islands',
  'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Jammu and Kashmir',
  'Ladakh',
  'Lakshadweep',
  'Puducherry',
];

const PINCODE_RE = /^\d{6}$/;

const ADDRESS_FIELDS = ['doorNo', 'building', 'street', 'locality', 'city', 'state', 'pincode'];

const text = (v, max = 120) => String(v ?? '').trim().slice(0, max);

const matchState = (raw) => {
  const needle = text(raw).toLowerCase();
  if (!needle) return '';
  return (
    INDIAN_STATES.find((s) => s.toLowerCase() === needle) ||
    INDIAN_STATES.find((s) => needle.includes(s.toLowerCase())) ||
    ''
  );
};

/** Join segments, dropping repeated comma-separated parts (case-insensitive). */
const composeAddress = (parts = {}) => {
  const seen = new Set();
  const out = [];
  for (const field of ADDRESS_FIELDS) {
    const segment = text(parts[field]);
    if (!segment) continue;
    for (const raw of segment.split(/,\s*/)) {
      const value = raw.trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
  }
  return out.join(', ');
};

/**
 * Validate and clean structured address input. Returns `{ parts, error }`;
 * `error` is a user-facing message when a required field is missing.
 */
const normalizeAddressParts = (raw, { require: required = false } = {}) => {
  if (!raw || typeof raw !== 'object') {
    return required ? { parts: null, error: 'address is required' } : { parts: null, error: '' };
  }

  const parts = {
    doorNo: text(raw.doorNo, 60),
    building: text(raw.building, 120),
    street: text(raw.street, 160),
    locality: text(raw.locality, 160),
    city: text(raw.city, 80),
    state: matchState(raw.state) || text(raw.state, 80),
    pincode: text(raw.pincode, 6).replace(/\D/g, ''),
  };

  if (parts.pincode && !PINCODE_RE.test(parts.pincode)) {
    return { parts: null, error: 'pincode must be 6 digits' };
  }
  if (required) {
    if (!parts.state) return { parts: null, error: 'state is required' };
    if (!parts.city) return { parts: null, error: 'city is required' };
  }
  if (!ADDRESS_FIELDS.some((f) => parts[f])) {
    return required ? { parts: null, error: 'address is required' } : { parts: null, error: '' };
  }

  return { parts, error: '' };
};

/**
 * Best-effort structure for a legacy free-text address: pull out the pincode
 * and a known state name, then treat the segment before the state as the city.
 * Everything left over becomes the street line.
 */
const parseAddress = (address) => {
  const segments = String(address ?? '')
    .split(/,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length) return null;

  const parts = { doorNo: '', building: '', street: '', locality: '', city: '', state: '', pincode: '' };
  const rest = [];

  for (const segment of segments) {
    if (!parts.pincode && PINCODE_RE.test(segment)) {
      parts.pincode = segment;
      continue;
    }
    const state = matchState(segment);
    if (!parts.state && state) {
      parts.state = state;
      continue;
    }
    rest.push(segment);
  }

  // The last remaining segment before the state is almost always the city.
  if (rest.length) parts.city = rest.pop();
  if (rest.length) parts.locality = rest.pop();
  if (rest.length) parts.street = rest.join(', ');

  return parts;
};

/**
 * Coordinates for distance search. Only accepted from the device's own
 * geolocation (never derived from a typed address), so an out-of-range or
 * partial value is dropped rather than rejected.
 */
const normalizeGeo = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
};

/** City for a business, tolerating rows that predate structured addresses. */
const businessCity = (business) => {
  const stored = text(business?.addressParts?.city, 80);
  if (stored) return stored;
  return text(parseAddress(business?.address)?.city, 80);
};

module.exports = {
  INDIAN_STATES,
  PINCODE_RE,
  ADDRESS_FIELDS,
  composeAddress,
  normalizeAddressParts,
  normalizeGeo,
  parseAddress,
  businessCity,
  matchState,
};
