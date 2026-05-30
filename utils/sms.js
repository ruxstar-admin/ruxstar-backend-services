const BASE = 'https://control.msg91.com/api/v5/otp';
const mobile91 = (mobile) => `91${mobile}`;

const devStore = new Map();

const sendOtp = async (mobile) => {
  if (process.env.NODE_ENV !== 'production') {
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    devStore.set(mobile, otp);
    return otp;
  }

  const url = new URL(BASE);
  url.searchParams.set('authkey', process.env.MSG91_AUTH_KEY);
  url.searchParams.set('template_id', process.env.MSG91_TEMPLATE_ID);
  url.searchParams.set('mobile', mobile91(mobile));
  if (process.env.MSG91_SENDER_ID) url.searchParams.set('sender', process.env.MSG91_SENDER_ID);

  const res = await fetch(url.toString(), { method: 'POST' });
  const data = await res.json();
  if (data.type !== 'success') throw new Error(data.message || 'Failed to send OTP');
};

const verifyOtp = async (mobile, otp) => {
  if (process.env.NODE_ENV !== 'production') {
    const stored = devStore.get(mobile);
    if (stored === otp) { devStore.delete(mobile); return true; }
    return false;
  }

  const url = new URL(`${BASE}/verify`);
  url.searchParams.set('authkey', process.env.MSG91_AUTH_KEY);
  url.searchParams.set('mobile', mobile91(mobile));
  url.searchParams.set('otp', otp);

  const res = await fetch(url.toString());
  const data = await res.json();
  return data.type === 'success';
};

module.exports = { sendOtp, verifyOtp };
