const jwt = require('jsonwebtoken');
const authService = require('../services/auth.service');
const ROLES = require('../constants/roles');

const signToken = (user) =>
  jwt.sign({ id: String(user._id), roles: user.roles }, process.env.JWT_SECRET, { expiresIn: '7d' });

exports.getProfile = async (req, res) => {
  const user = await authService.findById(req.user.id);
  if (!user) return res.status(404).json({ message: 'user not found' });
  res.json({ profile: user.vendorProfile || {} });
};

exports.updateProfile = async (req, res) => {
  const user = await authService.updateVendorProfile(req.user.id, req.body);
  if (!user) return res.status(404).json({ message: 'vendor not found' });
  res.json({ profile: user.vendorProfile });
};

/** Logged-in vendor → customer */
exports.becomeCustomer = async (req, res) => {
  const updated = await authService.becomeCustomer(req.user.id);
  if (!updated) return res.status(400).json({ message: 'only vendors can switch to customer' });
  res.json({ token: signToken(updated), user: authService.sanitize(updated) });
};

exports.createUser = async (req, res) => {
  const { mobile, name, password } = req.body;
  if (!mobile || !name || !password) {
    return res.status(400).json({ message: 'mobile, name and password required' });
  }
  if (password.length < 6) return res.status(400).json({ message: 'password min 6 characters' });
  try {
    const user = await authService.createUser({
      mobile,
      name,
      password,
      role: ROLES.CUSTOMER,
      vendorId: req.user.id,
    });
    res.status(201).json({ user: authService.sanitize(user) });
  } catch (err) {
    res.status(409).json({ message: err.message });
  }
};

exports.listUsers = async (req, res) => {
  const { ObjectId } = require('mongodb');
  const users = await authService.listUsers({ vendorId: new ObjectId(req.user.id) });
  res.json({ users: users.map(authService.sanitize) });
};
