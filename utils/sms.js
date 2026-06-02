const crypto = require('crypto');
const Otp = require('../models/Otp');

const authKey = process.env.MSG91_AUTH_KEY;
const senderId = process.env.MSG91_SENDER_ID;
const templateId = process.env.MSG91_TEMPLATE_ID;
const isProd = process.env.NODE_ENV === 'production';

const to91 = (mobile) => `91${Otp.normalize(mobile)}`;

/** Send any MSG91 template SMS (no OTP logic). templateId optional. */
const sendSMS = async ({ mobile, variables, templateId: tid = templateId }) => {
  if (!mobile) throw new Error('mobile required');
  if (!isProd) {
    console.log('[sms:dev]', { mobile: Otp.normalize(mobile), variables });
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

/** Generate OTP, store, send via template (##OTP##). */
const sendOtp = async (mobile) => {
  const m = Otp.normalize(mobile);
  const otp = String(crypto.randomInt(100000, 1000000));
  await Otp.save(m, otp);
  await sendSMS({ mobile: m, variables: { OTP: otp } });
  if (!isProd) return otp;
};

const verifyOtp = (mobile, otp) => Otp.verify(mobile, otp);

module.exports = { sendSMS, sendOtp, verifyOtp };
