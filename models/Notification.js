const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');

const collection = () => getDb().collection('notifications');

const toObjectId = (id) => new ObjectId(String(id));

const sanitize = (doc) => {
  if (!doc) return doc;
  return {
    id: String(doc._id),
    type: doc.type,
    title: doc.title,
    body: doc.body || '',
    data: doc.data && typeof doc.data === 'object' ? doc.data : {},
    read: doc.read === true,
    createdAt: doc.createdAt?.toISOString?.() ?? doc.createdAt,
  };
};

const ensureIndexes = async () => {
  await collection().createIndex({ userId: 1, createdAt: -1 });
  await collection().createIndex({ userId: 1, read: 1 });
  // Auto-purge old notifications after 30 days.
  await collection().createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
};

const insert = async (doc) => {
  const now = new Date();
  const row = {
    userId: toObjectId(doc.userId),
    type: String(doc.type || 'info'),
    title: String(doc.title || ''),
    body: String(doc.body || ''),
    data: doc.data && typeof doc.data === 'object' ? doc.data : {},
    read: false,
    createdAt: now,
  };
  const { insertedId } = await collection().insertOne(row);
  return sanitize({ _id: insertedId, ...row });
};

const insertMany = async (docs) => {
  if (!Array.isArray(docs) || !docs.length) return [];
  const now = new Date();
  const rows = docs.map((doc) => ({
    userId: toObjectId(doc.userId),
    type: String(doc.type || 'info'),
    title: String(doc.title || ''),
    body: String(doc.body || ''),
    data: doc.data && typeof doc.data === 'object' ? doc.data : {},
    read: false,
    createdAt: now,
  }));
  await collection().insertMany(rows);
  return rows.map(sanitize);
};

const listForUser = async (userId, { limit = 50 } = {}) => {
  const rows = await collection()
    .find({ userId: toObjectId(userId) })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
  return rows.map(sanitize);
};

const unreadCount = (userId) =>
  collection().countDocuments({ userId: toObjectId(userId), read: { $ne: true } });

const markRead = async (userId, id) => {
  if (!ObjectId.isValid(String(id))) return false;
  const { modifiedCount } = await collection().updateOne(
    { _id: toObjectId(id), userId: toObjectId(userId) },
    { $set: { read: true } },
  );
  return modifiedCount > 0;
};

const markAllRead = async (userId) => {
  const { modifiedCount } = await collection().updateMany(
    { userId: toObjectId(userId), read: { $ne: true } },
    { $set: { read: true } },
  );
  return modifiedCount;
};

module.exports = {
  ensureIndexes,
  insert,
  insertMany,
  listForUser,
  unreadCount,
  markRead,
  markAllRead,
};
