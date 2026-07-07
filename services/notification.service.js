const Notification = require('../models/Notification');

// Thin service over the Notification model. Kept separate so other services
// (print orders, bookings, etc.) depend on an intent-revealing API rather than
// the raw model, and so a realtime transport can be layered in here later.

const notify = async (userId, { type, title, body, data } = {}) => {
  if (!userId) return null;
  try {
    return await Notification.insert({ userId, type, title, body, data });
  } catch (err) {
    console.error('notify failed:', err.message);
    return null;
  }
};

const notifyMany = async (userIds, payload = {}) => {
  const ids = [...new Set((userIds || []).map((id) => String(id)).filter(Boolean))];
  if (!ids.length) return [];
  try {
    return await Notification.insertMany(
      ids.map((userId) => ({ userId, ...payload })),
    );
  } catch (err) {
    console.error('notifyMany failed:', err.message);
    return [];
  }
};

const list = async (userId) => {
  const [notifications, unread] = await Promise.all([
    Notification.listForUser(userId),
    Notification.unreadCount(userId),
  ]);
  return { notifications, unreadCount: unread };
};

const unreadCount = (userId) => Notification.unreadCount(userId);

const markRead = (userId, id) => Notification.markRead(userId, id);

const markAllRead = (userId) => Notification.markAllRead(userId);

const ensureIndexes = () => Notification.ensureIndexes();

module.exports = {
  notify,
  notifyMany,
  list,
  unreadCount,
  markRead,
  markAllRead,
  ensureIndexes,
};
