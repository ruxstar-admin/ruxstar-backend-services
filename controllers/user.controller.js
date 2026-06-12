const jwt = require('jsonwebtoken');
const authService = require('../services/auth.service');

const signToken = (user) =>
  jwt.sign({ id: String(user._id), roles: user.roles }, process.env.JWT_SECRET, { expiresIn: '7d' });

exports.getProfile = async (req, res) => {
  const user = await authService.findById(req.user.id);
  if (!user) return res.status(404).json({ message: 'user not found' });
  res.json({ user: authService.sanitize(user) });
};

exports.updateProfile = async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ message: 'name required' });
  const user = await authService.updateProfile(req.user.id, { name });
  res.json({ user: authService.sanitize(user) });
};

exports.becomeVendor = async (req, res) => {
  const user = await authService.findById(req.user.id);
  if (!user) return res.status(404).json({ message: 'user not found' });
  const businessName =
    req.body.businessName || user.vendorProfile?.businessName || user.name;
  const updated = await authService.becomeVendor(req.user.id, businessName);
  if (!updated) return res.status(400).json({ message: 'only customers can become vendor' });
  res.json({ token: signToken(updated), user: authService.sanitize(updated) });
};
