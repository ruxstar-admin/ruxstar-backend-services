const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');
const ROLES = require('../constants/roles');

const collection = () => getDb().collection('users');

const normalize = (mobile) => String(mobile).replace(/\D/g, '').slice(-10);

const sanitize = ({ passwordHash, ...user }) => user;

const findByMobile = (mobile) => collection().findOne({ mobile: normalize(mobile) });

const findById = (id) => collection().findOne({ _id: new ObjectId(id) });

const insert = async (doc) => {
  const { insertedId } = await collection().insertOne(doc);
  return { _id: insertedId, ...doc };
};

const list = (filter = {}) => collection().find(filter).toArray();

const updateById = (id, patch) =>
  collection().findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: { ...patch, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );

const updateVendorProfile = (userId, profile) =>
  collection().findOneAndUpdate(
    { _id: new ObjectId(userId), roles: { $in: [ROLES.VENDOR] } },
    { $set: { vendorProfile: profile, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );

const updateProfile = (userId, patch) => updateById(userId, patch);

const becomeVendor = (userId, name) =>
  collection().findOneAndUpdate(
    { _id: new ObjectId(userId), roles: { $in: [ROLES.CUSTOMER] } },
    {
      $set: {
        roles: [ROLES.VENDOR],
        vendorProfile: { businessName: name },
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );

const becomeCustomer = (userId) =>
  collection().findOneAndUpdate(
    { _id: new ObjectId(userId), roles: { $in: [ROLES.VENDOR] } },
    {
      $set: { roles: [ROLES.CUSTOMER], updatedAt: new Date() },
      $unset: { vendorProfile: '' },
    },
    { returnDocument: 'after' },
  );

module.exports = {
  normalize,
  sanitize,
  findByMobile,
  findById,
  insert,
  list,
  updateById,
  updateVendorProfile,
  updateProfile,
  becomeVendor,
  becomeCustomer,
};
