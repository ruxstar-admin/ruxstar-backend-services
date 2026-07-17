const crypto = require('crypto');

// Crockford base32 minus ambiguous characters (I, L, O, U) so codes are easy to
// read aloud and type. Used for all human-facing reference ids.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const randomCode = (length = 10) => {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
};

// Prefixed reference, e.g. withPrefix('BKG') -> "BKG-9F3KQ2M7XA".
const withPrefix = (prefix, length = 10) => `${prefix}-${randomCode(length)}`;

// Stable member id for a user account, e.g. "RUX-9F3K-Q2M7".
const userRef = () => {
  const c = randomCode(8);
  return `RUX-${c.slice(0, 4)}-${c.slice(4, 8)}`;
};

const REF_PREFIX = {
  BOOKING: 'BKG',
  REGISTRATION: 'REG',
  PAYMENT: 'PAY',
};

module.exports = { randomCode, withPrefix, userRef, REF_PREFIX };
