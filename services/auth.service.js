const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');
const User = require('../models/User');
const ROLES = require('../constants/roles');

const createUser = async ({ mobile, name, password, role, vendorId }) => {
  const m = User.normalize(mobile);
  if (await User.findByMobile(m)) throw new Error('mobile already registered');

  return User.insert({
    mobile: m,
    name,
    passwordHash: await bcrypt.hash(password, 10),
    roles: [role],
    mobileVerified: true,
    status: 'active',
    createdAt: new Date(),
    ...(vendorId ? { vendorId: new ObjectId(String(vendorId)) } : {}),
    ...(role === ROLES.VENDOR ? { vendorProfile: { businessName: name } } : {}),
  });
};

const login = async (mobile, password) => {
  const user = await User.findByMobile(mobile);
  if (!user || user.status === 'disabled') return null;
  if (!(await bcrypt.compare(password, user.passwordHash))) return null;
  return user;
};

module.exports = {
  normalize: User.normalize,
  sanitize: User.sanitize,
  findByMobile: User.findByMobile,
  findById: User.findById,
  createUser,
  login,
  listUsers: User.list,
  updateUser: User.updateById,
  updateVendorProfile: User.updateVendorProfile,
  updateProfile: User.updateProfile,
  becomeVendor: User.becomeVendor,
  becomeCustomer: User.becomeCustomer,
  ROLES,
};
