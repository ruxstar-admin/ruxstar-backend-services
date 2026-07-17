const Payment = require('../models/Payment');

// Record a successful payment into the unified ledger. Safe to call multiple
// times for the same order (idempotent on source + sourceId). Never throws into
// the settle path — a ledger hiccup must not fail an otherwise-paid booking.
const recordPayment = async (details) => {
  try {
    return await Payment.record(details);
  } catch (err) {
    console.error('payment ledger write failed:', err.message);
    return null;
  }
};

const listVendorPayments = async (vendorId) => ({
  payments: await Payment.listByVendor(vendorId),
});

const listCustomerPayments = async (customerUserId) => ({
  payments: await Payment.listByCustomer(customerUserId),
});

const ensureIndexes = () => Payment.ensureIndexes();

module.exports = {
  ensureIndexes,
  recordPayment,
  listVendorPayments,
  listCustomerPayments,
};
