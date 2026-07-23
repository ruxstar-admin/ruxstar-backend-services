// Cashfree Payouts V2 — used to transfer vendor withdrawals to their bank/UPI.
// This is a SEPARATE product (and separate credentials) from the Payment
// Gateway in utils/cashfreePayments.js and the Verification API in utils/cashfree.js.
//
// Docs: https://www.cashfree.com/docs/api-reference/payouts/v2
//   POST /beneficiary        create a payout beneficiary
//   GET  /beneficiary        fetch a beneficiary (by beneficiary_id)
//   POST /transfers          initiate a standard transfer
//   GET  /transfers          fetch a transfer's status

const crypto = require('crypto');

const BASE =
  process.env.CASHFREE_PAYOUT_ENV === 'production'
    ? 'https://payout-api.cashfree.com/payout'
    : 'https://payout-gamma.cashfree.com/payout';

const API_VERSION = process.env.CASHFREE_PAYOUT_API_VERSION || '2024-01-01';

const headers = (extra = {}) => ({
  'x-client-id': process.env.CASHFREE_PAYOUT_CLIENT_ID,
  'x-client-secret': process.env.CASHFREE_PAYOUT_SECRET,
  'x-api-version': API_VERSION,
  ...extra,
});

const parse = async (res) => {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const parts = [data.message, data.error?.message, data.code].filter(Boolean);
    const err = new Error(parts[0] || 'Cashfree payout request failed');
    err.status = res.status;
    err.data = data;
    err.detail = parts.join(' — ') || err.message;
    throw err;
  }
  return data;
};

const isConfigured = () =>
  Boolean(process.env.CASHFREE_PAYOUT_CLIENT_ID && process.env.CASHFREE_PAYOUT_SECRET);

// beneficiary_id: alphanumeric + - _ | . , max 50 chars.
const safeBeneId = (raw) =>
  String(raw || '')
    .replace(/[^a-zA-Z0-9\-_|.]/g, '')
    .slice(0, 50);

/** Fetch a beneficiary by id. Returns null on 404 (not found). */
const getBeneficiary = async (beneficiaryId) => {
  const res = await fetch(
    `${BASE}/beneficiary?beneficiary_id=${encodeURIComponent(beneficiaryId)}`,
    { headers: headers() },
  );
  if (res.status === 404) return null;
  return parse(res);
};

/**
 * Create a beneficiary. Pass bank (accountNumber + ifsc) and/or vpa.
 * Treats a 409 "already exists" as success (idempotent).
 */
const createBeneficiary = async ({ beneficiaryId, name, accountNumber, ifsc, vpa, email, phone }) => {
  const instrument = {};
  if (accountNumber && ifsc) {
    instrument.bank_account_number = String(accountNumber);
    instrument.bank_ifsc = String(ifsc).toUpperCase();
  }
  if (vpa) instrument.vpa = String(vpa);

  const body = {
    beneficiary_id: safeBeneId(beneficiaryId),
    // Only letters + whitespace are allowed for beneficiary_name.
    beneficiary_name: String(name || 'Vendor').replace(/[^a-zA-Z ]/g, '').slice(0, 100) || 'Vendor',
    beneficiary_instrument_details: instrument,
    ...(email || phone
      ? {
          beneficiary_contact_details: {
            ...(email ? { beneficiary_email: String(email).slice(0, 100) } : {}),
            ...(phone ? { beneficiary_phone: String(phone).replace(/\D/g, '').slice(-10) } : {}),
          },
        }
      : {}),
  };

  const res = await fetch(`${BASE}/beneficiary`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (res.status === 409) return { beneficiary_id: body.beneficiary_id, existed: true };
  return parse(res);
};

/**
 * Initiate a standard transfer to an existing beneficiary.
 * transfer_id: our unique id (alphanumeric, ≤ 40 chars). transfer_amount > 1.00.
 */
const createTransfer = async ({ transferId, amount, beneficiaryId, remarks }) => {
  const body = {
    transfer_id: String(transferId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 40),
    transfer_amount: Number(amount),
    beneficiary_details: { beneficiary_id: safeBeneId(beneficiaryId) },
    ...(remarks ? { transfer_remarks: String(remarks).slice(0, 70) } : {}),
  };
  return fetch(`${BASE}/transfers`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  }).then(parse);
};

/** Fetch a transfer's status by our transfer_id. */
const getTransfer = (transferId) =>
  fetch(`${BASE}/transfers?transfer_id=${encodeURIComponent(transferId)}`, {
    headers: headers(),
  }).then(parse);

/**
 * Verify a Cashfree Payouts webhook. Same scheme as the PG webhook:
 * signature = base64(HMAC-SHA256(timestamp + rawBody)) using the client secret.
 * `rawBody` must be the exact bytes received (not re-serialized JSON).
 */
const verifyWebhookSignature = (signature, timestamp, rawBody) => {
  const secret = process.env.CASHFREE_PAYOUT_SECRET;
  if (!secret || !signature || !timestamp) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}${rawBody}`)
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
};

module.exports = {
  isConfigured,
  safeBeneId,
  getBeneficiary,
  createBeneficiary,
  createTransfer,
  getTransfer,
  verifyWebhookSignature,
};
