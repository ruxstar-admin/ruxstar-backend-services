const supportService = require('../services/support.service');

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

const requesterName = (req, role) =>
  role === 'vendor'
    ? req.currentUser?.vendorProfile?.businessName || req.currentUser?.name || null
    : req.currentUser?.name || null;

// Customer/vendor handlers share logic; only the raiser role differs.
const userHandlers = (role) => ({
  list: handle(async (req, res) => {
    res.json(await supportService.listMyTickets(req.user.id));
  }),
  create: handle(async (req, res) => {
    const { subject, category, message, relatedType, relatedId } = req.body || {};
    const result = await supportService.createTicket({
      userId: req.user.id,
      role,
      name: requesterName(req, role),
      subject,
      category,
      message,
      relatedType,
      relatedId,
    });
    res.status(201).json(result);
  }),
  get: handle(async (req, res) => {
    res.json(await supportService.getMyTicket(req.user.id, req.params.id));
  }),
  reply: handle(async (req, res) => {
    const { body } = req.body || {};
    res.json(await supportService.replyAsUser({
      userId: req.user.id,
      name: requesterName(req, role),
      ticketId: req.params.id,
      body,
    }));
  }),
});

exports.customer = userHandlers('customer');
exports.vendor = userHandlers('vendor');

// ── Admin ──

exports.adminList = handle(async (req, res) => {
  const { status, role, search, page, limit } = req.query;
  const { items, total } = await supportService.listTickets({ status, role, search, page, limit });
  res.json({ tickets: items, total, page: Number(page) || 1, limit: Number(limit) || 20 });
});

exports.adminGet = handle(async (req, res) => {
  res.json(await supportService.getTicketAdmin(req.params.id));
});

exports.adminReply = handle(async (req, res) => {
  const { body } = req.body || {};
  res.json(await supportService.replyAsAdmin({
    adminId: req.user.id,
    adminName: req.currentUser?.name,
    ticketId: req.params.id,
    body,
  }));
});

exports.adminSetStatus = handle(async (req, res) => {
  const { status } = req.body || {};
  res.json(await supportService.setStatus({ adminId: req.user.id, ticketId: req.params.id, status }));
});
