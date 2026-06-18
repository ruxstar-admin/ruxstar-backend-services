const crypto = require('crypto');

// Cashfree Payment Gateway (PG) — separate product/endpoint from the KYC
// Verification API in utils/cashfree.js. Keep credentials distinct.
const BASE =
  process.env.CASHFREE_PG_ENV === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';

const API_VERSION = process.env.CASHFREE_PG_API_VERSION || '2023-08-01';

const headers = (extra = {}) => ({
  'x-client-id': process.env.CASHFREE_PG_CLIENT_ID,
  'x-client-secret': process.env.CASHFREE_PG_SECRET,
  'x-api-version': API_VERSION,
  ...extra,
});

const parse = async (res) => {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const parts = [
      data.message,
      data.error?.message,
      data.code,
      Array.isArray(data.details) ? data.details.map((d) => d.message || d).join('; ') : null,
    ].filter(Boolean);
    const err = new Error(parts[0] || 'Cashfree payment request failed');
    err.status = res.status;
    err.data = data;
    err.detail = parts.join(' — ') || err.message;
    throw err;
  }
  return data;
};

const isConfigured = () =>
  Boolean(process.env.CASHFREE_PG_CLIENT_ID && process.env.CASHFREE_PG_SECRET);

/** Cashfree expects a 10-digit Indian mobile (no +91 prefix). */
const normalizePhone = (raw) => {
  const digits = String(raw ?? '').replace(/\D/g, '');
  const ten = digits.length >= 10 ? digits.slice(-10) : digits;
  return ten.length === 10 ? ten : null;
};

/** Cashfree accepts ISO-8601; prefer IST offset without milliseconds. */
const formatExpiry = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  const istMs = d.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}T${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}+05:30`;
};

const createOrder = async ({
  orderId,
  amount,
  customer,
  returnUrl,
  notifyUrl,
  expiryIso,
  note,
}) => {
  const phone = normalizePhone(customer.phone);
  if (!phone) {
    throw Object.assign(new Error('customer phone must be a valid 10-digit mobile number'), {
      status: 400,
    });
  }

  const orderAmount = Number(amount);
  if (!Number.isFinite(orderAmount) || orderAmount < 1) {
    throw Object.assign(new Error('order amount must be at least ₹1'), { status: 400 });
  }

  const body = {
    order_id: String(orderId),
    order_amount: orderAmount,
    order_currency: 'INR',
    customer_details: {
      customer_id: String(customer.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50),
      customer_phone: phone,
      ...(customer.name ? { customer_name: String(customer.name).slice(0, 100) } : {}),
      ...(customer.email ? { customer_email: String(customer.email).slice(0, 100) } : {}),
    },
    order_meta: {
      ...(returnUrl ? { return_url: String(returnUrl).slice(0, 250) } : {}),
      ...(notifyUrl ? { notify_url: String(notifyUrl).slice(0, 250) } : {}),
    },
    ...(expiryIso ? { order_expiry_time: formatExpiry(expiryIso) } : {}),
    ...(note ? { order_note: String(note).slice(0, 200) } : {}),
  };

  return fetch(`${BASE}/orders`, {
    method: 'POST',
    headers: headers({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }),
    body: JSON.stringify(body),
  }).then(parse);
};

const getOrder = (orderId) =>
  fetch(`${BASE}/orders/${encodeURIComponent(orderId)}`, { headers: headers() }).then(parse);

const getOrderPayments = (orderId) =>
  fetch(`${BASE}/orders/${encodeURIComponent(orderId)}/payments`, {
    headers: headers(),
  }).then(parse);

const refundOrder = ({ orderId, refundId, amount, note }) =>
  fetch(`${BASE}/orders/${encodeURIComponent(orderId)}/refunds`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      refund_id: refundId,
      refund_amount: Number(amount),
      ...(note ? { refund_note: note } : {}),
    }),
  }).then(parse);

/**
 * Verify a Cashfree PG webhook. Signature = base64(HMAC-SHA256(timestamp + rawBody)).
 * `rawBody` must be the exact bytes received (not re-serialized JSON).
 */
const verifyWebhookSignature = (signature, timestamp, rawBody) => {
  const secret = process.env.CASHFREE_PG_SECRET;
  if (!secret || !signature || !timestamp) return false;
  const payload = `${timestamp}${rawBody}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
};

module.exports = {
  isConfigured,
  createOrder,
  getOrder,
  getOrderPayments,
  refundOrder,
  verifyWebhookSignature,
};
