const crypto = require('crypto');

const authKey = process.env.MSG91_AUTH_KEY;
const senderId = process.env.MSG91_SENDER_ID;
const templateId = process.env.MSG91_TEMPLATE_ID;
const useMsg91 = process.env.USE_MSG91 !== 'false';
const isProd = process.env.NODE_ENV === 'production';
const otpExpiryMin = Number(process.env.OTP_EXPIRY_MINUTES) || 10;

const normalize = (mobile) => String(mobile).replace(/\D/g, '').slice(-10);
const to91 = (mobile) => `91${normalize(mobile)}`;
const hash = (mobile, otp) =>
  crypto.createHash('sha256').update(`${normalize(mobile)}:${otp}`).digest('hex');

const devStore = new Map();

const otpCol = () => {
  try {
    const { getDb } = require('../config/database');
    return getDb().collection('otp_verifications');
  } catch {
    return null;
  }
};

/** Send any MSG91 template SMS (no OTP logic). templateId optional. */
const sendSMS = async ({ mobile, variables, templateId: tid = templateId }) => {
  if (!mobile) throw new Error('mobile required');
  if (!useMsg91) {
    console.log('[sms]', { mobile: normalize(mobile), variables });
    return;
  }
  if (!authKey || !tid) throw new Error('MSG91 not configured');

  const res = await fetch('https://control.msg91.com/api/v5/flow/', {
    method: 'POST',
    headers: { authkey: authKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template_id: tid,
      short_url: '0',
      ...(senderId ? { sender: senderId } : {}),
      recipients: [{ mobiles: to91(mobile), ...variables }],
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data.type && data.type !== 'success')) {
    throw new Error(data.message || 'SMS failed');
  }
};

const saveOtp = async (mobile, otp) => {
  const doc = {
    mobile,
    otpHash: hash(mobile, otp),
    expiresAt: new Date(Date.now() + otpExpiryMin * 60 * 1000),
  };
  const col = otpCol();
  if (col) await col.updateOne({ mobile }, { $set: doc }, { upsert: true });
  else devStore.set(mobile, doc);
};

const getOtp = async (mobile) => {
  const col = otpCol();
  return col ? col.findOne({ mobile }) : devStore.get(mobile) || null;
};

const clearOtp = async (mobile) => {
  const col = otpCol();
  if (col) await col.deleteOne({ mobile });
  else devStore.delete(mobile);
};

/** Generate OTP, store, send via template (##OTP##). */
const sendOtp = async (mobile) => {
  const m = normalize(mobile);
  const otp = String(crypto.randomInt(100000, 1000000));
  await saveOtp(m, otp);
  await sendSMS({ mobile: m, variables: { OTP: otp } });
  if (!isProd) return otp;
};

const verifyOtp = async (mobile, otp) => {
  const m = normalize(mobile);
  const record = await getOtp(m);
  if (!record || new Date(record.expiresAt) < new Date()) {
    await clearOtp(m);
    return false;
  }
  if (record.otpHash !== hash(m, String(otp).trim())) return false;
  await clearOtp(m);
  return true;
};

module.exports = { sendSMS, sendOtp, verifyOtp };
