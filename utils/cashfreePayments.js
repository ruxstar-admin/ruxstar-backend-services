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
    const err = new Error(data.message || 'Cashfree payment request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
};

const isConfigured = () =>
  Boolean(process.env.CASHFREE_PG_CLIENT_ID && process.env.CASHFREE_PG_SECRET);

/**
 * Create a Cashfree order. `amount` is in rupees (Cashfree expects a decimal
 * order_amount, not paise). Returns the order incl. payment_session_id.
 */
const createOrder = async ({
  orderId,
  amount,
  customer,
  returnUrl,
  notifyUrl,
  expiryIso,
  note,
}) => {
  const body = {
    order_id: orderId,
    order_amount: Number(amount),
    order_currency: 'INR',
    customer_details: {
      customer_id: String(customer.id),
      customer_phone: String(customer.phone || ''),
      ...(customer.name ? { customer_name: customer.name } : {}),
      ...(customer.email ? { customer_email: customer.email } : {}),
    },
    order_meta: {
      ...(returnUrl ? { return_url: returnUrl } : {}),
      ...(notifyUrl ? { notify_url: notifyUrl } : {}),
    },
    ...(expiryIso ? { order_expiry_time: expiryIso } : {}),
    ...(note ? { order_note: note } : {}),
  };
  return fetch(`${BASE}/orders`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
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
