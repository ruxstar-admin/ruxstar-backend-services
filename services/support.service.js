const SupportTicket = require('../models/SupportTicket');
const notificationService = require('./notification.service');

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// ── User (customer / vendor) ──

const createTicket = async ({ userId, role, name, subject, category, message, relatedType, relatedId }) => {
  if (!subject || !String(subject).trim()) throw bad('a subject is required');
  if (!message || !String(message).trim()) throw bad('please describe your issue');
  const ticket = await SupportTicket.create({
    raisedByUserId: userId,
    raisedByRole: role,
    raisedByName: name,
    subject,
    category,
    relatedType,
    relatedId,
    message,
  });
  return { ticket };
};

const listMyTickets = async (userId) => {
  const tickets = await SupportTicket.listByUser(userId);
  return { tickets };
};

const getMyTicket = async (userId, ticketId) => {
  const ticket = await SupportTicket.findByIdForUser(ticketId, userId);
  if (!ticket) throw bad('ticket not found', 404);
  return { ticket };
};

const replyAsUser = async ({ userId, name, ticketId, body }) => {
  const ticket = await SupportTicket.addMessage(
    ticketId,
    { userId, role: 'user', name, body },
    { scopeUserId: userId },
  );
  if (!ticket) throw bad('ticket not found or empty reply', 404);
  return { ticket };
};

// ── Admin ──

const listTickets = (query) => SupportTicket.listAllAdmin(query);

const getTicketAdmin = async (ticketId) => {
  const ticket = await SupportTicket.findByIdAdmin(ticketId);
  if (!ticket) throw bad('ticket not found', 404);
  return { ticket };
};

const replyAsAdmin = async ({ adminId, adminName, ticketId, body }) => {
  const ticket = await SupportTicket.addMessage(ticketId, {
    userId: adminId,
    role: 'admin',
    name: adminName || 'Support',
    body,
  });
  if (!ticket) throw bad('ticket not found or empty reply', 404);
  if (ticket.raisedByUserId) {
    void notificationService.notify(ticket.raisedByUserId, {
      type: 'support_reply',
      title: 'Support replied',
      body: `Support responded to your ticket ${ticket.ticketRef}.`,
      data: { ticketId: ticket.id, kind: 'support' },
    });
  }
  return { ticket };
};

const setStatus = async ({ adminId, ticketId, status }) => {
  const ticket = await SupportTicket.setStatus(ticketId, status, adminId);
  if (!ticket) throw bad('ticket not found or invalid status', 404);
  if ((status === 'resolved' || status === 'closed') && ticket.raisedByUserId) {
    void notificationService.notify(ticket.raisedByUserId, {
      type: 'support_status',
      title: `Ticket ${status}`,
      body: `Your support ticket ${ticket.ticketRef} was marked ${status}.`,
      data: { ticketId: ticket.id, kind: 'support' },
    });
  }
  return { ticket };
};

const ensureIndexes = () => SupportTicket.ensureIndexes();

module.exports = {
  ensureIndexes,
  createTicket,
  listMyTickets,
  getMyTicket,
  replyAsUser,
  listTickets,
  getTicketAdmin,
  replyAsAdmin,
  setStatus,
};
