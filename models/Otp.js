const crypto = require('crypto');
const { getDb } = require('../config/database');

const expiryMin = Number(process.env.OTP_EXPIRY_MINUTES) || 10;

const normalize = (mobile) => String(mobile).replace(/\D/g, '').slice(-10);

const hash = (mobile, otp) =>
  crypto.createHash('sha256').update(`${normalize(mobile)}:${otp}`).digest('hex');

const collection = () => getDb().collection('otp_verifications');

const save = async (mobile, otp) => {
  const m = normalize(mobile);
  const doc = {
    mobile: m,
    otpHash: hash(m, otp),
    expiresAt: new Date(Date.now() + expiryMin * 60 * 1000),
  };
  await collection().updateOne({ mobile: m }, { $set: doc }, { upsert: true });
};

const find = (mobile) => collection().findOne({ mobile: normalize(mobile) });

const remove = (mobile) => collection().deleteOne({ mobile: normalize(mobile) });

const verify = async (mobile, otp) => {
  const m = normalize(mobile);
  const record = await find(m);
  if (!record || new Date(record.expiresAt) < new Date()) {
    await remove(m);
    return false;
  }
  if (record.otpHash !== hash(m, String(otp).trim())) return false;
  await remove(m);
  return true;
};

module.exports = { normalize, save, verify };
