const SupportTicket = require('../models/SupportTicket');
const Payment = require('../models/Payment');
const notificationService = require('./notification.service');

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// ── User (customer / vendor) ──

const createTicket = async ({ userId, role, name, subject, category, message, relatedType, relatedId }) => {
  if (!subject || !String(subject).trim()) throw bad('a subject is required');
  if (!message || !String(message).trim()) throw bad('please describe your issue');

  // A customer refund ticket must be linked to one of that customer's payments.
  // This prevents spoofing another user's PAY reference and gives support the
  // exact transaction to action without searching or copying identifiers.
  if (role === 'customer' && category === 'refund') {
    if (relatedType !== 'payment' || !relatedId) {
      throw bad('select the order or booking you want refunded');
    }
    const payment = await Payment.findByRefId(relatedId);
    if (!payment || payment.customerUserId !== String(userId)) {
      throw bad('that payment does not belong to your account', 403);
    }
  }

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

// Unified paid-order picker for customer refund tickets. Payment rows already
// span bookings, print orders and events, so the customer sees everything in
// one list without three separate requests.
const listRefundOptions = async (userId) => {
  const payments = await Payment.listByCustomer(userId);
  return {
    payments: payments.map((p) => ({
      id: p.id,
      refId: p.refId,
      source: p.source,
      sourceRef: p.sourceRef,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      paidAt: p.paidAt,
      refundable: p.refundable,
      matured: p.matured,
      paidOut: Boolean(p.payoutId || p.withdrawalId),
    })),
  };
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
  listRefundOptions,
  listMyTickets,
  getMyTicket,
  replyAsUser,
  listTickets,
  getTicketAdmin,
  replyAsAdmin,
  setStatus,
};
