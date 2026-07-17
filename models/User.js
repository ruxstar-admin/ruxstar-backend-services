const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');
const ROLES = require('../constants/roles');
const { userRef } = require('../utils/referenceId');

const collection = () => getDb().collection('users');

const normalize = (mobile) => String(mobile).replace(/\D/g, '').slice(-10);

// Deterministic fallback for accounts created before member ids were stored —
// matches the legacy Ruxstar Card format so existing cards stay consistent.
const deriveRef = (userId) => {
  const hex = String(userId).replace(/[^a-f0-9]/gi, '').toUpperCase();
  const tail = hex.slice(-8).padStart(8, '0');
  return `RUX-${tail.slice(0, 4)}-${tail.slice(4, 8)}`;
};

const sanitize = ({ passwordHash, ...user }) => ({
  ...user,
  refId: user.refId || (user._id ? deriveRef(user._id) : null),
});

const findByMobile = (mobile) => collection().findOne({ mobile: normalize(mobile) });

const findById = (id) => collection().findOne({ _id: new ObjectId(id) });

const findByIds = async (ids, projection = { name: 1, 'vendorProfile.businessName': 1 }) => {
  const oids = [...new Set(ids)]
    .filter((id) => id && ObjectId.isValid(String(id)))
    .map((id) => new ObjectId(String(id)));
  if (!oids.length) return [];
  return collection().find({ _id: { $in: oids } }, { projection }).toArray();
};

const findKycStatusById = (id) =>
  collection().findOne(
    { _id: new ObjectId(id) },
    { projection: { 'vendorProfile.kyc.status': 1 } },
  );

const insert = async (doc) => {
  const row = { refId: userRef(), ...doc };
  const { insertedId } = await collection().insertOne(row);
  return { _id: insertedId, ...row };
};

const list = (filter = {}) => collection().find(filter).toArray();

const updateById = (id, patch) =>
  collection().findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: { ...patch, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );

// Merge vendor profile fields without clobbering kyc or other existing keys.
const updateVendorProfile = (userId, patch) => {
  const set = { updatedAt: new Date() };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'kyc') continue; // kyc is owned by the KYC service, never by the client
    set[`vendorProfile.${key}`] = value;
  }
  return collection().findOneAndUpdate(
    { _id: new ObjectId(userId), roles: { $in: [ROLES.VENDOR] } },
    { $set: set },
    { returnDocument: 'after' },
  );
};

const updateProfile = (userId, patch) => updateById(userId, patch);

// Keep existing kyc if the user was a vendor before (switched away and back).
const becomeVendor = (userId, name) =>
  collection().findOneAndUpdate(
    { _id: new ObjectId(userId), roles: { $in: [ROLES.CUSTOMER] } },
    [
      {
        $set: {
          roles: [ROLES.VENDOR],
          'vendorProfile.businessName': {
            $ifNull: ['$vendorProfile.businessName', name],
          },
          'vendorProfile.kyc': {
            $ifNull: ['$vendorProfile.kyc', { status: 'pending' }],
          },
          updatedAt: new Date(),
        },
      },
    ],
    { returnDocument: 'after' },
  );

// Keep vendorProfile (incl. verified kyc) so switching back is seamless.
const becomeCustomer = (userId) =>
  collection().findOneAndUpdate(
    { _id: new ObjectId(userId), roles: { $in: [ROLES.VENDOR] } },
    { $set: { roles: [ROLES.CUSTOMER], updatedAt: new Date() } },
    { returnDocument: 'after' },
  );

const ensureIndexes = async () => {
  await collection().createIndex({ mobile: 1 }, { unique: true });
  await collection().createIndex({ roles: 1, 'vendorProfile.kyc.status': 1 });
  await collection().createIndex(
    { refId: 1 },
    { unique: true, partialFilterExpression: { refId: { $exists: true } } },
  );
};

module.exports = {
  normalize,
  sanitize,
  findByMobile,
  findById,
  findByIds,
  findKycStatusById,
  insert,
  list,
  updateById,
  updateVendorProfile,
  updateProfile,
  becomeVendor,
  becomeCustomer,
  ensureIndexes,
};
