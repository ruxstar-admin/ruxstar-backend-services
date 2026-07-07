const notificationService = require('../services/notification.service');

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.list = handle(async (req, res) => {
  const payload = await notificationService.list(req.user.id);
  res.json(payload);
});

exports.unreadCount = handle(async (req, res) => {
  const unreadCount = await notificationService.unreadCount(req.user.id);
  res.json({ unreadCount });
});

exports.markRead = handle(async (req, res) => {
  const ok = await notificationService.markRead(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ message: 'notification not found' });
  res.json({ ok: true });
});

exports.markAllRead = handle(async (req, res) => {
  const updated = await notificationService.markAllRead(req.user.id);
  res.json({ ok: true, updated });
});
