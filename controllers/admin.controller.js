const authService = require('../services/auth.service');
const ROLES = require('../constants/roles');

const ADMIN_CREATE_ROLES = [ROLES.ADMIN, ROLES.EMPLOYEE];

exports.listUsers = async (req, res) => {
  const filter = req.query.role ? { roles: req.query.role } : {};
  const users = await authService.listUsers(filter);
  res.json({ users: users.map(authService.sanitize) });
};

exports.createUser = async (req, res) => {
  const { mobile, name, password, role } = req.body;
  if (!mobile || !name || !password || !role) {
    return res.status(400).json({ message: 'mobile, name, password and role required' });
  }
  if (!ADMIN_CREATE_ROLES.includes(role)) {
    return res.status(400).json({ message: 'role must be admin or employee' });
  }
  try {
    const user = await authService.createUser({ mobile, name, password, role });
    res.status(201).json({ user: authService.sanitize(user) });
  } catch (err) {
    res.status(409).json({ message: err.message });
  }
};

exports.updateUser = async (req, res) => {
  const { status, roles } = req.body;
  const patch = {};
  if (status) patch.status = status;
  if (roles) patch.roles = roles;

  const user = await authService.updateUser(req.params.id, patch);
  if (!user) return res.status(404).json({ message: 'user not found' });
  res.json({ user: authService.sanitize(user) });
};
