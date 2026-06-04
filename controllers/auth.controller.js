const jwt = require('jsonwebtoken');
const authService = require('../services/auth.service');
const sms = require('../utils/sms');
const ROLES = require('../constants/roles');

const SIGNUP_ROLES = ROLES.SIGNUP_ROLES;

const signToken = (user) =>
  jwt.sign({ id: String(user._id), roles: user.roles }, process.env.JWT_SECRET, { expiresIn: '7d' });

const signSignupToken = (mobile) =>
  jwt.sign({ mobile: authService.normalize(mobile), purpose: 'signup' }, process.env.JWT_SECRET, {
    expiresIn: '15m',
  });

exports.signupSendOtp = async (req, res) => {
  const { mobile } = req.body;
  if (!mobile) return res.status(400).json({ message: 'mobile required' });
  if (await authService.findByMobile(mobile)) {
    return res.status(409).json({ message: 'mobile already registered' });
  }
  try {
    const otp = await sms.sendOtp(mobile);
    res.json({ message: 'OTP sent', ...(otp && { otp }) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.signupVerifyOtp = async (req, res) => {
  const { mobile, otp } = req.body;
  if (!mobile || !otp) return res.status(400).json({ message: 'mobile and otp required' });
  if (!(await sms.verifyOtp(mobile, otp))) {
    return res.status(401).json({ message: 'invalid or expired OTP' });
  }
  res.json({ signupToken: signSignupToken(mobile) });
};

exports.signupComplete = async (req, res) => {
  const { signupToken, name, password, role = ROLES.CUSTOMER } = req.body;
  if (!signupToken || !name || !password) {
    return res.status(400).json({ message: 'signupToken, name and password required' });
  }
  if (!SIGNUP_ROLES.includes(role)) {
    return res.status(400).json({ message: 'invalid role for signup' });
  }
  if (password.length < 6) return res.status(400).json({ message: 'password min 6 characters' });

  let payload;
  try {
    payload = jwt.verify(signupToken, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: 'invalid or expired signup token' });
  }
  if (payload.purpose !== 'signup') return res.status(401).json({ message: 'invalid signup token' });

  try {
    const user = await authService.createUser({
      mobile: payload.mobile,
      name,
      password,
      role,
    });
    res.status(201).json({ token: signToken(user), user: authService.sanitize(user) });
  } catch (err) {
    res.status(409).json({ message: err.message });
  }
};

exports.loginSendOtp = async (req, res) => {
  const { mobile } = req.body;
  if (!mobile) return res.status(400).json({ message: 'mobile required' });
  const user = await authService.findByMobile(mobile);
  if (!user || user.status === 'disabled') {
    return res.status(404).json({ message: 'user not found' });
  }
  try {
    const otp = await sms.sendOtp(mobile);
    res.json({ message: 'OTP sent', ...(otp && { otp }) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.loginVerifyOtp = async (req, res) => {
  const { mobile, otp } = req.body;
  if (!mobile || !otp) return res.status(400).json({ message: 'mobile and otp required' });
  const user = await authService.findByMobile(mobile);
  if (!user || user.status === 'disabled') {
    return res.status(401).json({ message: 'invalid credentials' });
  }
  if (!(await sms.verifyOtp(mobile, otp))) {
    return res.status(401).json({ message: 'invalid or expired OTP' });
  }
  res.json({ token: signToken(user), user: authService.sanitize(user) });
};

exports.login = async (req, res) => {
  const { mobile, password } = req.body;
  if (!mobile || !password) return res.status(400).json({ message: 'mobile and password required' });

  const user = await authService.login(mobile, password);
  if (!user) return res.status(401).json({ message: 'invalid credentials' });

  res.json({ token: signToken(user), user: authService.sanitize(user) });
};

exports.me = async (req, res) => {
  const user = await authService.findById(req.user.id);
  if (!user) return res.status(404).json({ message: 'user not found' });
  res.json({ user: authService.sanitize(user) });
};

exports.logout = (_req, res) => res.json({ message: 'logged out' });
