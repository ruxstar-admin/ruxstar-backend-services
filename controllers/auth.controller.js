const jwt = require('jsonwebtoken');
const authService = require('../services/auth.service');
const sms = require('../utils/sms');
const ROLES = require('../constants/roles');

const sign = (user) =>
  jwt.sign({ id: String(user._id), roles: user.roles }, process.env.JWT_SECRET, { expiresIn: '7d' });

exports.sendOtp = async (req, res) => {
  const { mobile } = req.body;
  if (!mobile) return res.status(400).json({ message: 'mobile required' });
  const otp = await sms.sendOtp(mobile);
  res.json({ message: 'OTP sent', ...(otp && { otp }) });
};

exports.verifyOtp = async (req, res) => {
  const { mobile, otp, name, roles = [ROLES.CUSTOMER] } = req.body;
  if (!mobile || !otp) return res.status(400).json({ message: 'mobile and otp required' });
  const valid = await sms.verifyOtp(mobile, otp);
  if (!valid) return res.status(401).json({ message: 'invalid or expired OTP' });
  const user = await authService.findOrCreate({ mobile, name, roles });
  res.json({ token: sign(user) });
};

exports.me = (req, res) => res.json({ user: req.user });

exports.logout = (_req, res) => res.json({ message: 'logged out' });
