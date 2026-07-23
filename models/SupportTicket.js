const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');
const { withPrefix, REF_PREFIX } = require('../utils/referenceId');

const collection = () => getDb().collection('support_tickets');

const toObjectId = (id) => {
  try {
    return id && ObjectId.isValid(String(id)) ? new ObjectId(String(id)) : null;
  } catch {
    return null;
  }
};

const iso = (d) => (d ? d.toISOString?.() ?? d : null);

const STATUSES = ['open', 'pending', 'resolved', 'closed'];
const CATEGORIES = ['payment', 'booking', 'order', 'refund', 'account', 'other'];
const SUMMARY_PROJECTION = { messages: 0 };

const sanitizeMessage = (m) => ({
  authorUserId: m.authorUserId ? String(m.authorUserId) : null,
  authorRole: m.authorRole || 'user',
  authorName: m.authorName || null,
  body: m.body || '',
  createdAt: iso(m.createdAt),
});

const sanitize = (doc) => {
  if (!doc) return doc;
  return {
    id: String(doc._id),
    ticketRef: doc.ticketRef,
    raisedByUserId: doc.raisedByUserId ? String(doc.raisedByUserId) : null,
    raisedByRole: doc.raisedByRole || 'customer',
    raisedByName: doc.raisedByName || null,
    subject: doc.subject || '',
    category: doc.category || 'other',
    status: doc.status || 'open',
    relatedType: doc.relatedType || null,
    relatedId: doc.relatedId || null,
    assignedTo: doc.assignedTo ? String(doc.assignedTo) : null,
    messages: Array.isArray(doc.messages) ? doc.messages.map(sanitizeMessage) : [],
    lastMessageAt: iso(doc.lastMessageAt),
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
};

const ensureIndexes = async () => {
  await collection().createIndex({ ticketRef: 1 }, { unique: true });
  await collection().createIndex({ raisedByUserId: 1, updatedAt: -1 });
  await collection().createIndex({ updatedAt: -1 });
  await collection().createIndex({ status: 1, updatedAt: -1 });
  await collection().createIndex({ raisedByRole: 1, updatedAt: -1 });
  await collection().createIndex({ status: 1, raisedByRole: 1, updatedAt: -1 });
};

const create = async ({
  raisedByUserId,
  raisedByRole,
  raisedByName,
  subject,
  category,
  relatedType,
  relatedId,
  message,
} = {}) => {
  const now = new Date();
  const firstMessage = {
    authorUserId: toObjectId(raisedByUserId),
    authorRole: 'user',
    authorName: raisedByName || null,
    body: String(message || '').trim(),
    createdAt: now,
  };
  const row = {
    ticketRef: withPrefix(REF_PREFIX.TICKET),
    raisedByUserId: toObjectId(raisedByUserId),
    raisedByRole: raisedByRole === 'vendor' ? 'vendor' : 'customer',
    ...(raisedByName ? { raisedByName: String(raisedByName) } : {}),
    subject: String(subject || '').trim().slice(0, 160),
    category: CATEGORIES.includes(category) ? category : 'other',
    status: 'open',
    ...(relatedType ? { relatedType: String(relatedType) } : {}),
    ...(relatedId ? { relatedId: String(relatedId) } : {}),
    assignedTo: null,
    messages: firstMessage.body ? [firstMessage] : [],
    lastMessageAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const { insertedId } = await collection().insertOne(row);
  return sanitize({ _id: insertedId, ...row });
};

const findByIdForUser = async (id, userId) => {
  const oid = toObjectId(id);
  if (!oid) return null;
  const doc = await collection().findOne({ _id: oid, raisedByUserId: toObjectId(userId) });
  return doc ? sanitize(doc) : null;
};

const findByIdAdmin = async (id) => {
  const oid = toObjectId(id);
  if (!oid) return null;
  const doc = await collection().findOne({ _id: oid });
  return doc ? sanitize(doc) : null;
};

const listByUser = async (userId, { limit = 50 } = {}) => {
  const oid = toObjectId(userId);
  if (!oid) return [];
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const rows = await collection()
    .find({ raisedByUserId: oid }, { projection: SUMMARY_PROJECTION })
    .sort({ updatedAt: -1 })
    .limit(safeLimit)
    .toArray();
  return rows.map(sanitize);
};

// Add a reply. `author` is { userId, role: 'user'|'admin', name }. When an admin
// replies to an open ticket it moves to `pending` (awaiting the user); a user
// reply re-opens a pending/resolved ticket.
const addMessage = async (id, { userId, role, name, body }, { scopeUserId } = {}) => {
  const oid = toObjectId(id);
  if (!oid) return null;
  const filter = { _id: oid };
  if (scopeUserId) filter.raisedByUserId = toObjectId(scopeUserId);
  const now = new Date();
  const message = {
    authorUserId: toObjectId(userId),
    authorRole: role === 'admin' ? 'admin' : 'user',
    authorName: name || null,
    body: String(body || '').trim(),
    createdAt: now,
  };
  if (!message.body) return null;
  const nextStatus = role === 'admin' ? 'pending' : 'open';
  const res = await collection().findOneAndUpdate(
    filter,
    {
      $push: { messages: message },
      $set: { status: nextStatus, lastMessageAt: now, updatedAt: now },
    },
    { returnDocument: 'after' },
  );
  const doc = res?.value ?? res;
  return doc ? sanitize(doc) : null;
};

// ── Admin ──

const listAllAdmin = async ({ status, role, search, page = 1, limit = 20 } = {}) => {
  const filter = {};
  if (status && STATUSES.includes(status)) filter.status = status;
  if (role) filter.raisedByRole = role;
  if (search) {
    const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ ticketRef: rx }, { subject: rx }, { raisedByName: rx }, { relatedId: rx }];
  }
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const skip = (Math.max(1, Number(page)) - 1) * safeLimit;
  const [rows, total] = await Promise.all([
    collection()
      .find(filter, { projection: SUMMARY_PROJECTION })
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(safeLimit)
      .toArray(),
    collection().countDocuments(filter),
  ]);
  return { items: rows.map(sanitize), total };
};

const setStatus = async (id, status, adminId) => {
  const oid = toObjectId(id);
  if (!oid || !STATUSES.includes(status)) return null;
  const res = await collection().findOneAndUpdate(
    { _id: oid },
    {
      $set: {
        status,
        ...(toObjectId(adminId) ? { assignedTo: toObjectId(adminId) } : {}),
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
  const doc = res?.value ?? res;
  return doc ? sanitize(doc) : null;
};

const countOpen = () => collection().countDocuments({ status: { $in: ['open', 'pending'] } });

module.exports = {
  STATUSES,
  CATEGORIES,
  sanitize,
  ensureIndexes,
  create,
  findByIdForUser,
  findByIdAdmin,
  listByUser,
  addMessage,
  listAllAdmin,
  setStatus,
  countOpen,
};
