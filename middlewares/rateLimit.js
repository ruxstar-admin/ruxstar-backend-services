const rateLimit = require('express-rate-limit');

const message = (text) => ({ message: text });

// Note: this is an in-memory limiter (per instance). It's a solid first line of
// defense against OTP/SMS abuse and brute force. If we scale to many instances
// and need global limits, swap in a shared store (e.g. Redis) via the `store`
// option without changing call sites.

// Tight limit for OTP sends — these cost real money (SMS).
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_OTP_MAX) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: message('Too many OTP requests. Please wait a few minutes and try again.'),
});

// Limit for login / verify attempts — brute-force protection.
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AUTH_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: message('Too many attempts. Please wait a few minutes and try again.'),
});

// Looser limit for unauthenticated public reads (slots/business listings).
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PUBLIC_MAX) || 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: message('Too many requests. Please slow down.'),
});

module.exports = { otpLimiter, authLimiter, publicLimiter };
