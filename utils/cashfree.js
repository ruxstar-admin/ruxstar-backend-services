const BASE =
  process.env.CASHFREE_ENV === 'production'
    ? 'https://api.cashfree.com/verification'
    : 'https://sandbox.cashfree.com/verification';

const headers = (extra = {}) => ({
  'x-client-id': process.env.CASHFREE_CLIENT_ID,
  'x-client-secret': process.env.CASHFREE_CLIENT_SECRET,
  'x-api-version': process.env.CASHFREE_API_VERSION || '2024-12-01',
  ...(process.env.CASHFREE_SIGNATURE ? { 'x-cf-signature': process.env.CASHFREE_SIGNATURE } : {}),
  ...extra,
});

const parse = async (res) => {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || 'Cashfree request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
};

const postJson = (path, body) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  }).then(parse);

const getJson = (path) =>
  fetch(`${BASE}${path}`, { headers: headers() }).then(parse);

const postMultipart = (path, fields, files = []) => {
  const form = new FormData();
  Object.entries(fields).forEach(([k, v]) => form.append(k, v));
  files.forEach(({ name, buffer, filename, mime }) => {
    form.append(name, new Blob([buffer], { type: mime }), filename);
  });
  return fetch(`${BASE}${path}`, { method: 'POST', headers: headers(), body: form }).then(parse);
};

module.exports = { postJson, getJson, postMultipart };
