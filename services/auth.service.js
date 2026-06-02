const User = require('../models/User');

const findByMobile = (mobile) => User.collection().findOne({ mobile });

const findOrCreate = async ({ mobile, name, roles }) => {
  const existing = await findByMobile(mobile);
  if (existing) return existing;
  const doc = { mobile, name, roles, createdAt: new Date() };
  const { insertedId } = await User.collection().insertOne(doc);
  return { _id: insertedId, ...doc };
};

module.exports = { findByMobile, findOrCreate };
