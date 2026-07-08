const { randomUUID } = require('crypto');
const PrintOrder = require('../models/PrintOrder');
const Business = require('../models/Business');
const User = require('../models/User');
const notificationService = require('./notification.service');
const cashfreePayments = require('../utils/cashfreePayments');
const {
  findPrintCategory,
  PRINT_ORDER_STATUS,
  OPEN_ORDER_TTL_MINUTES,
} = require('../constants/printCatalog');

const MAX_DESIGN_BYTES = 4 * 1024 * 1024;

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

const normCity = (v) => String(v ?? '').trim().toLowerCase();

const parseDesignImage = (imageBase64) => {
  if (!imageBase64) return undefined;
  const match = String(imageBase64).match(/^data:(image\/\w+);base64,(.+)$/);
  const mimeType = match?.[1] || 'image/jpeg';
  const raw = (match?.[2] ?? String(imageBase64)).replace(/^data:image\/\w+;base64,/, '').trim();
  if (!raw) return undefined;
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) throw bad('invalid design image');
  if (buffer.length > MAX_DESIGN_BYTES) throw bad('design image too large (max 4MB)', 413);
  return { mimeType, data: raw };
};

const clampAttributes = (raw) => {
  const src = raw && typeof raw === 'object' ? raw : {};
  const pick = (v) => (typeof v === 'string' ? v.trim().slice(0, 120) : '');
  return {
    printType: pick(src.printType),
    material: pick(src.material),
    color: pick(src.color),
    size: pick(src.size),
  };
};

// ─────────────────────────── Customer: create + broadcast ───────────────────────────

const createOrder = async (customerUserId, body) => {
  const category = findPrintCategory(body.categoryId);
  if (!category) throw bad('choose a valid print category');

  const user = await User.findById(customerUserId);
  if (!user) throw bad('user not found', 404);

  const quantity = Math.round(Number(body.quantity));
  const minQty = category.minQuantity || 1;
  if (!Number.isFinite(quantity) || quantity < minQty) {
    throw bad(`minimum quantity for ${category.label} is ${minQty}`);
  }

  const city = String(body.city ?? '').trim();
  if (!city) throw bad('city is required so we can find nearby vendors');

  const designImage = parseDesignImage(body.designImage);
  const orderId = randomUUID();
  const openExpiresAt = new Date(Date.now() + OPEN_ORDER_TTL_MINUTES * 60 * 1000);

  const order = await PrintOrder.insert({
    _id: orderId,
    customerUserId,
    customerName: user.name || 'Customer',
    customerMobile: user.mobile || '',
    categoryId: category.id,
    categoryLabel: category.label,
    title: String(body.title ?? '').trim().slice(0, 120) || category.label,
    attributes: clampAttributes(body.attributes),
    quantity,
    notes: String(body.notes ?? '').trim().slice(0, 1000),
    city,
    cityKey: normCity(city),
    pincode: String(body.pincode ?? '').replace(/\D/g, '').slice(0, 6),
    ...(designImage ? { designImage } : {}),
    openExpiresAt,
  });

  // Broadcast to eligible vendors (fire-and-forget notifications).
  broadcastOpenOrder(order).catch((err) => console.error('broadcast failed:', err.message));

  return { order };
};

const broadcastOpenOrder = async (order) => {
  const businesses = await Business.listLivePrintForCategory(order.categoryId, normCity(order.city));
  const vendorIds = [...new Set(businesses.map((b) => String(b.vendorId)).filter(Boolean))];
  if (!vendorIds.length) return;
  await notificationService.notifyMany(vendorIds, {
    type: 'pod_order_open',
    title: 'New print order nearby',
    body: `${order.quantity} × ${order.categoryLabel} in ${order.city}. Tap to review & accept.`,
    data: { orderId: order.id, categoryId: order.categoryId, kind: 'pod' },
  });
};

const listCustomerOrders = async (customerUserId) => {
  const orders = await PrintOrder.listByCustomer(customerUserId);
  return { orders };
};

const getCustomerOrder = async (customerUserId, orderId) => {
  const order = await PrintOrder.getForCustomer(orderId, customerUserId, { withDesign: true });
  if (!order) throw bad('order not found', 404);

  // Reconcile a stuck pending payment with Cashfree (missed webhook safety net).
  if (order.status === PRINT_ORDER_STATUS.PENDING_PAYMENT && cashfreePayments.isConfigured()) {
    const raw = await PrintOrder.findById(orderId);
    let cf;
    try {
      cf = await cashfreePayments.getOrder(orderId);
    } catch {
      cf = null;
    }
    if (cf?.order_status === 'PAID') {
      await settlePaid(raw, { cashfreeOrderId: cf.cf_order_id, paymentRef: cf.cf_order_id });
    } else if (['EXPIRED', 'TERMINATED', 'CANCELLED'].includes(cf?.order_status)) {
      await PrintOrder.markPaymentFailed(orderId);
    }
    const refreshed = await PrintOrder.getForCustomer(orderId, customerUserId, { withDesign: true });
    return { order: refreshed };
  }
  return { order };
};

const cancelOrder = async (customerUserId, orderId) => {
  const cancelled = await PrintOrder.cancelByCustomer(orderId, customerUserId);
  if (!cancelled) throw bad('order cannot be cancelled at this stage');
  if (cancelled.assignedVendorId) {
    await notificationService.notify(cancelled.assignedVendorId, {
      type: 'pod_order_cancelled',
      title: 'Print order cancelled',
      body: `The customer cancelled the ${cancelled.categoryLabel} order.`,
      data: { orderId: cancelled.id, kind: 'pod' },
    });
  }
  return { order: cancelled };
};

// ─────────────────────────── Vendor: eligibility + accept + status ───────────────────────────

const vendorEligibility = async (vendorId) => {
  const businesses = await Business.listLivePrintByVendor(vendorId);
  const categoryIds = new Set();
  const cities = new Set();
  let serveAll = false;
  for (const biz of businesses) {
    const profile = biz.setup?.printProfile || {};
    (profile.serviceCategories || []).forEach((c) => categoryIds.add(String(c)));
    (profile.cities || []).forEach((c) => cities.add(normCity(c)));
    if (profile.serveAll) serveAll = true;
  }
  return {
    businesses,
    categoryIds: [...categoryIds],
    cities: [...cities],
    serveAll,
  };
};

const listVendorOrders = async (vendorId) => {
  const eligibility = await vendorEligibility(vendorId);
  const [open, assigned] = await Promise.all([
    PrintOrder.listOpenForVendor({
      categoryIds: eligibility.categoryIds,
      cities: eligibility.cities,
      serveAll: eligibility.serveAll,
    }),
    PrintOrder.listAssignedForVendor(vendorId),
  ]);
  return {
    open,
    assigned,
    eligible: {
      categories: eligibility.categoryIds,
      hasPrintBusiness: eligibility.businesses.length > 0,
    },
  };
};

const getVendorOrder = async (vendorId, orderId) => {
  // Orders already assigned to this vendor are always viewable.
  let order = await PrintOrder.findAssignedForVendor(orderId, vendorId, { withDesign: true });

  // Otherwise, allow viewing an order that is still OPEN and matches this
  // vendor's served categories — so tapping a "new order" notification opens
  // the full detail where they can accept + quote.
  if (!order) {
    const open = await PrintOrder.findByIdWithDesign(orderId);
    if (open && open.status === PRINT_ORDER_STATUS.OPEN) {
      const eligibility = await vendorEligibility(vendorId);
      if (eligibility.categoryIds.includes(open.categoryId)) order = open;
    }
  }

  if (!order) throw bad('order not found', 404);
  if (order._raw) delete order._raw;
  return { order };
};

const acceptOrder = async (vendorId, orderId, body) => {
  const eligibility = await vendorEligibility(vendorId);
  if (!eligibility.businesses.length) {
    throw bad('set up a live print business before accepting orders', 403);
  }

  const raw = await PrintOrder.findById(orderId);
  if (!raw) throw bad('order not found', 404);
  if (raw.status !== PRINT_ORDER_STATUS.OPEN) throw bad('this order was already taken', 409);
  if (!eligibility.categoryIds.includes(raw.categoryId)) {
    throw bad('none of your print businesses serve this category', 403);
  }

  const quoteAmount = Math.round(Number(body.quoteAmount));
  if (!Number.isFinite(quoteAmount) || quoteAmount < 1) {
    throw bad('enter a valid quote amount (₹1 or more)');
  }

  // Pick the eligible business serving this category to attribute the order to.
  const business =
    eligibility.businesses.find((b) =>
      (b.setup?.printProfile?.serviceCategories || []).map(String).includes(raw.categoryId),
    ) || eligibility.businesses[0];

  const user = await User.findById(vendorId);

  const accepted = await PrintOrder.accept(orderId, {
    vendorId,
    businessId: business?.id ?? business?._id,
    vendorName: user?.name || user?.vendorProfile?.businessName || 'Vendor',
    businessName: business?.name || '',
    vendorMobile: user?.mobile || '',
    vendorNote: String(body.vendorNote ?? '').trim().slice(0, 500),
    quoteAmount,
  });
  if (!accepted) throw bad('this order was just taken by another vendor', 409);

  await notificationService.notify(accepted.customerUserId, {
    type: 'pod_order_accepted',
    title: 'A vendor accepted your order',
    body: `${accepted.businessName || accepted.vendorName} quoted ₹${quoteAmount} for your ${accepted.categoryLabel}. Pay to confirm.`,
    data: { orderId: accepted.id, kind: 'pod' },
  });

  return { order: accepted };
};

const VENDOR_STATUS_FLOW = {
  [PRINT_ORDER_STATUS.CONFIRMED]: [PRINT_ORDER_STATUS.IN_PRODUCTION],
  [PRINT_ORDER_STATUS.IN_PRODUCTION]: [PRINT_ORDER_STATUS.READY],
  [PRINT_ORDER_STATUS.READY]: [PRINT_ORDER_STATUS.COMPLETED],
};

const STATUS_MESSAGES = {
  [PRINT_ORDER_STATUS.IN_PRODUCTION]: {
    title: 'Your order is in production',
    body: 'The vendor started working on your print order.',
  },
  [PRINT_ORDER_STATUS.READY]: {
    title: 'Your order is ready',
    body: 'Your print order is ready for pickup/delivery.',
  },
  [PRINT_ORDER_STATUS.COMPLETED]: {
    title: 'Order completed',
    body: 'Your print order is marked complete. Thank you!',
  },
};

const updateOrderStatus = async (vendorId, orderId, nextStatus) => {
  const raw = await PrintOrder.findById(orderId);
  if (!raw || String(raw._raw.assignedVendorId) !== String(vendorId)) {
    throw bad('order not found', 404);
  }
  const allowed = VENDOR_STATUS_FLOW[raw.status] || [];
  if (!allowed.includes(nextStatus)) {
    throw bad(`cannot move order from ${raw.status} to ${nextStatus}`);
  }
  const updated = await PrintOrder.updateStatusForVendor(orderId, vendorId, nextStatus);
  if (!updated) throw bad('could not update order', 409);

  const msg = STATUS_MESSAGES[nextStatus];
  if (msg) {
    await notificationService.notify(updated.customerUserId, {
      type: `pod_${nextStatus}`,
      title: msg.title,
      body: msg.body,
      data: { orderId: updated.id, kind: 'pod' },
    });
  }
  return { order: updated };
};

// ─────────────────────────── Payment (after acceptance) ───────────────────────────

const buildReturnUrl = (orderId) => {
  const tpl = process.env.CASHFREE_PG_RETURN_URL;
  if (!tpl) return undefined;
  return tpl.replace('{bookingId}', orderId).replace('{orderId}', orderId);
};

const initiatePayment = async (customerUserId, orderId) => {
  if (!cashfreePayments.isConfigured()) throw bad('payments are not configured', 503);

  const order = await PrintOrder.getForCustomer(orderId, customerUserId);
  if (!order) throw bad('order not found', 404);
  if (![PRINT_ORDER_STATUS.ACCEPTED, PRINT_ORDER_STATUS.PENDING_PAYMENT].includes(order.status)) {
    throw bad('this order is not ready for payment');
  }
  const amount = Number(order.quoteAmount);
  if (!Number.isFinite(amount) || amount < 1) throw bad('vendor has not set a valid quote yet');

  const user = await User.findById(customerUserId);
  let cfOrder;
  try {
    cfOrder = await cashfreePayments.createOrder({
      orderId,
      amount,
      customer: {
        id: String(customerUserId),
        phone: user?.mobile,
        name: user?.name,
        email: user?.email,
      },
      returnUrl: buildReturnUrl(orderId),
      notifyUrl: process.env.CASHFREE_PG_NOTIFY_URL || undefined,
      note: `Print order · ${order.categoryLabel}`,
    });
  } catch (err) {
    const clientMsg = err.detail || err.message || 'Could not start payment.';
    throw Object.assign(new Error(clientMsg), { status: err.status === 401 || err.status === 403 ? 502 : err.status || 502 });
  }

  const paymentSessionId = cfOrder.payment_session_id;
  const cashfreeOrderId = cfOrder.cf_order_id || cfOrder.order_id || orderId;
  await PrintOrder.attachPaymentSession(orderId, { paymentSessionId, cashfreeOrderId });

  return {
    order: await PrintOrder.getForCustomer(orderId, customerUserId),
    payment: {
      orderId,
      cashfreeOrderId,
      paymentSessionId,
      amount,
      currency: 'INR',
      mode: process.env.CASHFREE_PG_ENV === 'production' ? 'production' : 'sandbox',
    },
  };
};

const settlePaid = async (raw, { cashfreeOrderId, paymentRef } = {}) => {
  const paid = await PrintOrder.markPaid(raw._id ?? raw.id, { cashfreeOrderId, paymentRef });
  if (paid && paid.assignedVendorId) {
    await notificationService.notify(paid.assignedVendorId, {
      type: 'pod_order_paid',
      title: 'Order paid — start production',
      body: `Payment received for the ${paid.categoryLabel} order (₹${paid.quoteAmount}).`,
      data: { orderId: paid.id, kind: 'pod' },
    });
  }
  return paid;
};

// Cashfree webhook fan-in. Returns { ignored:true } when the order_id isn't a
// print order so the caller can try other handlers.
const handlePaymentWebhook = async (payload) => {
  const data = payload?.data || {};
  const orderId = data.order?.order_id;
  if (!orderId) return { ok: true, ignored: true };

  const order = await PrintOrder.findById(orderId);
  if (!order) return { ok: true, ignored: true };
  if (order.status !== PRINT_ORDER_STATUS.PENDING_PAYMENT) return { ok: true };

  const paymentStatus = data.payment?.payment_status;
  const orderStatus = data.order?.order_status;
  const cashfreeOrderId = data.order?.cf_order_id || order.cashfreeOrderId;
  const paymentRef = data.payment?.cf_payment_id;

  if (paymentStatus === 'SUCCESS' || orderStatus === 'PAID') {
    await settlePaid(order._raw, { cashfreeOrderId, paymentRef });
  } else if (['FAILED', 'USER_DROPPED', 'CANCELLED'].includes(paymentStatus)) {
    await PrintOrder.markPaymentFailed(orderId);
  }
  return { ok: true };
};

const releaseExpiredOpenOrders = async () => {
  const expired = await PrintOrder.expireOpenOrders();
  return { expired };
};

const ensureIndexes = () => PrintOrder.ensureIndexes();

module.exports = {
  ensureIndexes,
  createOrder,
  listCustomerOrders,
  getCustomerOrder,
  cancelOrder,
  listVendorOrders,
  getVendorOrder,
  acceptOrder,
  updateOrderStatus,
  initiatePayment,
  handlePaymentWebhook,
  releaseExpiredOpenOrders,
};
