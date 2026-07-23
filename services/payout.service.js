const Payment = require('../models/Payment');
const Payout = require('../models/Payout');
const User = require('../models/User');

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// Preview the next payout for a vendor: all refundable `paid` payments not yet
// paid out, up to an optional cutoff (defaults to now). These are the funds that
// would be released to the vendor and locked against customer refunds.
const previewPayout = async ({ vendorId, until } = {}) => {
  if (!vendorId) throw bad('vendorId is required');
  const cutoff = until ? new Date(until) : new Date();
  const payments = await Payment.listRefundablePayments({ vendorId, until: cutoff });
  const amount = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  const paymentIds = payments.map((p) => p.id);
  const periodStart = payments.length ? payments[0].paidAt : null;
  const periodEnd = cutoff.toISOString();
  return {
    vendorId: String(vendorId),
    count: payments.length,
    amount,
    paymentIds,
    periodStart,
    periodEnd,
    payments,
  };
};

// Mark a vendor as paid out for the current period. Creates a Payout record and
// stamps its payments so they can no longer be refunded.
const completePayout = async ({ vendorId, until, note, adminId } = {}) => {
  const preview = await previewPayout({ vendorId, until });
  if (preview.count === 0) throw bad('no unpaid transactions to pay out for this vendor');

  let vendorName = null;
  try {
    const vendor = await User.findById(vendorId);
    vendorName = vendor?.vendorProfile?.businessName || vendor?.name || null;
  } catch {
    vendorName = null;
  }

  const payout = await Payout.create({
    vendorId,
    vendorName,
    amount: preview.amount,
    count: preview.count,
    paymentIds: preview.paymentIds,
    periodStart: preview.periodStart,
    periodEnd: preview.periodEnd,
    note,
    createdByAdminId: adminId,
  });

  const locked = await Payment.attachPayout({
    paymentIds: preview.paymentIds,
    payoutId: payout.id,
    payoutRef: payout.payoutRef,
  });

  return { payout, locked };
};

const listPayouts = (query) => Payout.listAll(query);
const listVendorPayouts = (vendorId) => Payout.listByVendor(vendorId);

const ensureIndexes = () => Payout.ensureIndexes();

module.exports = {
  ensureIndexes,
  previewPayout,
  completePayout,
  listPayouts,
  listVendorPayouts,
};
