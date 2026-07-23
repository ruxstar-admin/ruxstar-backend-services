const Payment = require('../models/Payment');
const Withdrawal = require('../models/Withdrawal');
const User = require('../models/User');
const cashfreePayouts = require('../utils/cashfreePayouts');

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

const sum = (rows) => rows.reduce((acc, r) => acc + (r.amount || 0), 0);

const vendorLabel = async (vendorId) => {
  try {
    const v = await User.findById(vendorId);
    return { user: v, name: v?.vendorProfile?.businessName || v?.name || null };
  } catch {
    return { user: null, name: null };
  }
};

// Everything the vendor dashboard needs: what was earned, what can be withdrawn
// next week (matured past the 7-day refund window), what is in-flight, and the
// full withdrawal history.
const getVendorSummary = async (vendorId) => {
  if (!vendorId) throw bad('vendorId is required');
  const [payments, matured, active, withdrawals] = await Promise.all([
    Payment.listByVendor(vendorId),
    Payment.listMaturedPayments({ vendorId }),
    Withdrawal.findActiveByVendor(vendorId),
    Withdrawal.listByVendor(vendorId),
  ]);

  const paid = payments.filter((p) => p.status === 'paid');
  const earned = sum(paid); // lifetime earnings (excludes refunded)
  const withdrawable = sum(matured);
  // Paid but still inside the 7-day refund window (matures into withdrawable later).
  const holding = sum(paid.filter((p) => p.refundable));
  const completed = withdrawals.filter((w) => w.status === Withdrawal.STATUS.COMPLETED);
  const withdrawn = sum(completed);
  const inProcess = active ? active.amount : 0;

  const vendor = await User.findById(vendorId).catch(() => null);
  const method = vendor?.vendorProfile?.payoutMethod || null;

  return {
    totals: {
      earned,
      withdrawable,
      holding, // not yet withdrawable (inside refund window)
      inProcess,
      withdrawn,
    },
    canWithdraw: !active && withdrawable > 0 && Boolean(method),
    hasPayoutMethod: Boolean(method),
    payoutMethod: maskMethod(method),
    activeWithdrawal: active,
    withdrawals,
  };
};

// Never surface the raw account number to the client.
const maskMethod = (method) => {
  if (!method) return null;
  return {
    type: method.type || 'bank',
    accountName: method.accountName || null,
    accountNumberMasked: method.accountNumber ? `••••${String(method.accountNumber).slice(-4)}` : null,
    ifsc: method.ifsc || null,
    vpa: method.vpa || null,
  };
};

// Vendor requests a withdrawal of their FULL matured balance. One active request
// at a time. Reserves the matured payments so they can't be double-withdrawn.
const requestWithdrawal = async (vendorId) => {
  if (!vendorId) throw bad('vendorId is required');

  const existing = await Withdrawal.findActiveByVendor(vendorId);
  if (existing) throw bad('you already have a withdrawal in progress', 409);

  const { user, name } = await vendorLabel(vendorId);
  const method = user?.vendorProfile?.payoutMethod;
  if (!method || (!method.vpa && !(method.accountNumber && method.ifsc))) {
    throw bad('add your bank or UPI payout details before withdrawing', 400);
  }

  const matured = await Payment.listMaturedPayments({ vendorId });
  if (!matured.length) throw bad('you have no matured funds available to withdraw yet');

  const amount = sum(matured);
  const paymentIds = matured.map((p) => p.id);

  const withdrawal = await Withdrawal.create({
    vendorId,
    vendorName: name,
    amount,
    count: matured.length,
    paymentIds,
    payoutMethod: method,
    periodStart: matured[0].paidAt,
    periodEnd: new Date().toISOString(),
  });

  const reserved = await Payment.reserveForWithdrawal({
    paymentIds,
    withdrawalId: withdrawal.id,
    withdrawalRef: withdrawal.withdrawalRef,
  });
  // If a race reserved fewer rows than expected, keep going — the amount reflects
  // what we snapshotted; admin review is the backstop before money moves.
  return { withdrawal, reserved };
};

const listVendorWithdrawals = (vendorId) => Withdrawal.listByVendor(vendorId);
const listAll = (query) => Withdrawal.listAll(query);
const getById = (id) => Withdrawal.findById(id);

// Map Cashfree transfer statuses to our lifecycle.
const SUCCESS_STATES = ['SUCCESS', 'COMPLETED'];
const FAILURE_STATES = ['FAILED', 'REJECTED', 'REVERSED', 'CANCELLED'];

const settleCompleted = async (withdrawal, { cfTransferId, transferStatus } = {}) => {
  await Payment.settleWithdrawal({ withdrawalId: withdrawal.id, payoutRef: withdrawal.withdrawalRef });
  return Withdrawal.transition(withdrawal.id, [Withdrawal.STATUS.PROCESSING, Withdrawal.STATUS.PENDING], {
    status: Withdrawal.STATUS.COMPLETED,
    ...(cfTransferId ? { cfTransferId: String(cfTransferId) } : {}),
    ...(transferStatus ? { transferStatus: String(transferStatus) } : {}),
    completedAt: new Date(),
  });
};

const failWithdrawal = async (withdrawal, reason, { cfTransferId, transferStatus } = {}) => {
  await Payment.releaseWithdrawal(withdrawal.id);
  return Withdrawal.transition(withdrawal.id, [Withdrawal.STATUS.PROCESSING, Withdrawal.STATUS.PENDING], {
    status: Withdrawal.STATUS.FAILED,
    failureReason: reason ? String(reason) : 'transfer failed',
    ...(cfTransferId ? { cfTransferId: String(cfTransferId) } : {}),
    ...(transferStatus ? { transferStatus: String(transferStatus) } : {}),
  });
};

/**
 * Admin approves a withdrawal → ensure a Cashfree beneficiary exists, then
 * initiate a standard transfer. Terminal SUCCESS/FAILED are settled immediately;
 * anything pending stays `processing` until refreshStatus / a webhook resolves it.
 */
const approve = async (id, adminId) => {
  const withdrawal = await Withdrawal.findById(id);
  if (!withdrawal) throw bad('withdrawal not found', 404);
  if (withdrawal.status !== Withdrawal.STATUS.PENDING) {
    throw bad(`withdrawal is already ${withdrawal.status}`, 409);
  }

  if (!cashfreePayouts.isConfigured()) {
    throw bad('Cashfree Payouts is not configured on the server (set CASHFREE_PAYOUT_CLIENT_ID / SECRET)', 503);
  }

  // Full (unmasked) payout method lives on the vendor profile.
  const vendor = await User.findById(withdrawal.vendorId).catch(() => null);
  const method = vendor?.vendorProfile?.payoutMethod;
  if (!method) throw bad('vendor payout method is missing', 400);

  const beneficiaryId = cashfreePayouts.safeBeneId(`vendor_${withdrawal.vendorId}`);

  // Move to processing first so a duplicate approval can't double-transfer.
  const processing = await Withdrawal.transition(id, Withdrawal.STATUS.PENDING, {
    status: Withdrawal.STATUS.PROCESSING,
    decidedByAdminId: adminId,
    decidedAt: new Date(),
  });
  if (!processing) throw bad('withdrawal is no longer pending', 409);

  try {
    // Idempotently ensure the beneficiary exists.
    const existing = await cashfreePayouts.getBeneficiary(beneficiaryId).catch(() => null);
    if (!existing) {
      await cashfreePayouts.createBeneficiary({
        beneficiaryId,
        name: method.accountName || withdrawal.vendorName || 'Vendor',
        accountNumber: method.accountNumber,
        ifsc: method.ifsc,
        vpa: method.vpa,
        phone: vendor?.mobile,
        email: vendor?.email,
      });
    }

    const transfer = await cashfreePayouts.createTransfer({
      transferId: withdrawal.withdrawalRef,
      amount: withdrawal.amount,
      beneficiaryId,
      remarks: `Payout ${withdrawal.withdrawalRef}`,
    });

    const cfStatus = String(transfer?.status || '').toUpperCase();
    const cfTransferId = transfer?.cf_transfer_id;
    if (SUCCESS_STATES.includes(cfStatus)) {
      return { withdrawal: await settleCompleted(processing, { cfTransferId, transferStatus: cfStatus }) };
    }
    if (FAILURE_STATES.includes(cfStatus)) {
      return { withdrawal: await failWithdrawal(processing, `transfer ${cfStatus.toLowerCase()}`, { cfTransferId, transferStatus: cfStatus }) };
    }
    // PENDING / RECEIVED / APPROVAL_PENDING etc. — leave processing, record ids.
    const updated = await Withdrawal.transition(id, Withdrawal.STATUS.PROCESSING, {
      ...(cfTransferId ? { cfTransferId: String(cfTransferId) } : {}),
      transferStatus: cfStatus || 'PENDING',
    });
    return { withdrawal: updated || processing };
  } catch (err) {
    // Transfer initiation failed — release the reservation and mark failed.
    await failWithdrawal(processing, err.detail || err.message);
    throw bad(`payout transfer failed: ${err.detail || err.message}`, err.status || 502);
  }
};

// Re-check a still-processing transfer against Cashfree and settle if terminal.
const refreshStatus = async (id) => {
  const withdrawal = await Withdrawal.findById(id);
  if (!withdrawal) throw bad('withdrawal not found', 404);
  if (withdrawal.status !== Withdrawal.STATUS.PROCESSING) return { withdrawal };
  if (!cashfreePayouts.isConfigured()) return { withdrawal };

  const transfer = await cashfreePayouts.getTransfer(withdrawal.withdrawalRef).catch(() => null);
  const cfStatus = String(transfer?.status || '').toUpperCase();
  if (SUCCESS_STATES.includes(cfStatus)) {
    return { withdrawal: await settleCompleted(withdrawal, { transferStatus: cfStatus }) };
  }
  if (FAILURE_STATES.includes(cfStatus)) {
    return { withdrawal: await failWithdrawal(withdrawal, `transfer ${cfStatus.toLowerCase()}`, { transferStatus: cfStatus }) };
  }
  return { withdrawal };
};

// Admin declines a pending request → release the reserved payments.
const reject = async (id, adminId, reason) => {
  const withdrawal = await Withdrawal.findById(id);
  if (!withdrawal) throw bad('withdrawal not found', 404);
  if (withdrawal.status !== Withdrawal.STATUS.PENDING) {
    throw bad(`withdrawal is already ${withdrawal.status}`, 409);
  }
  await Payment.releaseWithdrawal(id);
  const updated = await Withdrawal.transition(id, Withdrawal.STATUS.PENDING, {
    status: Withdrawal.STATUS.REJECTED,
    failureReason: reason ? String(reason) : 'rejected by admin',
    decidedByAdminId: adminId,
    decidedAt: new Date(),
  });
  return { withdrawal: updated };
};

const ensureIndexes = () => Withdrawal.ensureIndexes();

module.exports = {
  ensureIndexes,
  getVendorSummary,
  requestWithdrawal,
  listVendorWithdrawals,
  listAll,
  getById,
  approve,
  refreshStatus,
  reject,
};
