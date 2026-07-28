const { randomUUID } = require('crypto');
const PrintOrder = require('../models/PrintOrder');
const Business = require('../models/Business');
const User = require('../models/User');
const notificationService = require('./notification.service');
const paymentService = require('./payment.service');
const cashfreePayments = require('../utils/cashfreePayments');
const { findPrintCategory, PRINT_ORDER_STATUS } = require('../constants/printCatalog');
const { BUSINESS_STATUS } = require('../constants/businessStatus');
const { computePrice } = require('../utils/printPricing');
const { businessCity } = require('../utils/businessAddress');

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
  const out = {
    printType: pick(src.printType),
    material: pick(src.material),
    color: pick(src.color),
    size: pick(src.size),
  };
  const extras = {};
  const rawExtras = src.extras && typeof src.extras === 'object' ? src.extras : {};
  for (const [key, value] of Object.entries(rawExtras)) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) continue;
    const trimmed = pick(value);
    if (trimmed) extras[key] = trimmed;
  }
  if (Object.keys(extras).length) out.extras = extras;
  return out;
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Trust-but-verify the customer's selection before recomputing the price.
const sanitizeSelection = (category, raw) => {
  const src = raw && typeof raw === 'object' ? raw : {};
  if (category.pricingModel === 'per_page') {
    const sections = Array.isArray(src.sections)
      ? src.sections
          .map((s) => ({
            pages: Math.max(0, Math.round(num(s?.pages))),
            color: s?.color === 'color' ? 'color' : 'bw',
          }))
          .filter((s) => s.pages > 0)
      : [];
    return {
      copies: Math.max(1, Math.round(num(src.copies))),
      sections,
      doubleSided: src.doubleSided === true,
      ...(typeof src.binding === 'string' && src.binding ? { binding: src.binding } : {}),
      ...(typeof src.paperSize === 'string' && src.paperSize ? { paperSize: src.paperSize } : {}),
    };
  }
  const options = {};
  if (src.options && typeof src.options === 'object') {
    for (const [k, v] of Object.entries(src.options)) {
      if (typeof v === 'string' && v) options[k] = v.slice(0, 120);
    }
  }
  return { quantity: Math.max(1, Math.round(num(src.quantity))), options };
};

// ─────────────────────────── Customer: create direct order ───────────────────────────

const createOrder = async (customerUserId, body) => {
  const category = findPrintCategory(body.categoryId);
  if (!category) throw bad('choose a valid print category');

  const user = await User.findById(customerUserId);
  if (!user) throw bad('user not found', 404);

  const businessId = String(body.businessId ?? '').trim();
  if (!businessId) throw bad('choose a print shop');

  const business = await Business.findLiveById(businessId);
  if (!business || business.module !== 'print') throw bad('print shop not found', 404);

  const profile = business.setup?.printProfile || {};
  if (!(profile.serviceCategories || []).map(String).includes(category.id)) {
    throw bad('this shop does not offer that product');
  }
  if (profile.acceptingOrders === false) {
    throw bad('this shop is not accepting orders right now', 409);
  }

  const pricing = (profile.pricing || {})[category.id];
  if (!hasUsablePrice(category, pricing)) throw bad('this shop has not priced that product');

  const selection = sanitizeSelection(category, body.selection);
  const isPerPage = category.pricingModel === 'per_page';
  const quantity = isPerPage ? selection.copies : selection.quantity;
  const minQty = Number(pricing.minQuantity) || category.minQuantity || 1;
  if (quantity < minQty) {
    throw bad(`minimum ${isPerPage ? 'copies' : 'quantity'} is ${minQty}`);
  }
  if (isPerPage && selection.sections.reduce((s, x) => s + x.pages, 0) <= 0) {
    throw bad('add the number of pages to print');
  }

  const priced = computePrice(category, pricing, selection);
  const amount = Math.round(num(priced.total));
  if (amount < 1) throw bad('could not price this configuration');

  const city = String(body.city ?? '').trim();
  if (!city) throw bad('city is required');

  const designImage = parseDesignImage(body.designImage);
  const attributes = clampAttributes(body.attributes);

  const vendorId = business.vendorId ? String(business.vendorId) : '';
  const vendorUser = vendorId ? await User.findById(vendorId) : null;

  const orderId = randomUUID();
  const order = await PrintOrder.insert({
    _id: orderId,
    customerUserId,
    customerName: user.name || 'Customer',
    customerMobile: user.mobile || '',
    categoryId: category.id,
    categoryLabel: category.label,
    title: category.label,
    attributes,
    selection,
    quantity,
    notes: String(body.notes ?? '').trim().slice(0, 1000),
    city,
    cityKey: normCity(city),
    pincode: String(body.pincode ?? '').replace(/\D/g, '').slice(0, 6),
    ...(designImage ? { designImage } : {}),
    status: PRINT_ORDER_STATUS.ACCEPTED,
    assignedVendorId: vendorId || undefined,
    assignedBusinessId: businessId,
    vendorName: vendorUser?.name || '',
    businessName: business.name || '',
    vendorMobile: vendorUser?.mobile || '',
    quoteAmount: amount,
    acceptedAt: new Date(),
  });

  if (vendorId) {
    notificationService
      .notify(vendorId, {
        type: 'pod_order_new',
        title: 'New print order 🎉',
        body: `${quantity} × ${category.label} · ₹${amount}. Awaiting customer payment.`,
        data: { orderId: order.id, kind: 'pod' },
      })
      .catch((err) => console.error('notify failed:', err.message));
  }

  return { order };
};

// ─────────────────────────── Customer: available shops (direct pricing) ───────────────────────────

// Lowest advertised price for a shop's pricing block, for "from ₹X" display.
const startingPrice = (category, pricing) => {
  if (category.pricingModel === 'per_page') {
    const rates = [pricing.perPage?.bw, pricing.perPage?.color]
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
    return rates.length ? Math.min(...rates) : 0;
  }
  return Number(pricing.basePrice) || 0;
};

const hasUsablePrice = (category, pricing) => {
  if (!pricing || pricing.enabled === false) return false;
  if (category.pricingModel === 'per_page') {
    return Number(pricing.perPage?.bw) > 0 || Number(pricing.perPage?.color) > 0;
  }
  return Number(pricing.basePrice) > 0;
};

// Live print shops that offer a category (optionally in a city) with a real
// price set. Replaces the quote marketplace: customers pick a shop directly.
const listAvailableShops = async (categoryId, city) => {
  const category = findPrintCategory(categoryId);
  if (!category) throw bad('choose a valid print category');

  const businesses = await Business.listLivePrintForCategory(category.id, normCity(city), {
    includeOffline: true,
  });
  const shops = [];
  for (const biz of businesses) {
    const profile = biz.setup?.printProfile || {};
    const pricing = (profile.pricing || {})[category.id];
    if (!hasUsablePrice(category, pricing)) continue;
    const open =
      biz.status === BUSINESS_STATUS.LIVE &&
      biz.setupComplete === true &&
      profile.acceptingOrders !== false;
    shops.push({
      businessId: String(biz._id ?? biz.id),
      vendorId: String(biz.vendorId ?? ''),
      name: biz.name || 'Print shop',
      thumbnailUrl: biz.thumbnailUrl || '',
      city: businessCity(biz),
      acceptingOrders: open,
      pricingModel: category.pricingModel,
      turnaroundDays: Number(pricing.turnaroundDays) || Number(profile.turnaroundDays) || 0,
      minQuantity: Number(pricing.minQuantity) || category.minQuantity || 1,
      fromPrice: startingPrice(category, pricing),
      pricing,
    });
  }
  // Open shops first, then cheapest starting price.
  shops.sort(
    (a, b) =>
      Number(b.acceptingOrders) - Number(a.acceptingOrders) || a.fromPrice - b.fromPrice,
  );
  return { shops };
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

  // Cancelling no longer auto-refunds — refunds are issued by support after the
  // customer raises a refund ticket (subject to the 7-day window / not-yet-paid-out).
  const refund = { refunded: false, reason: cancelled.paymentStatus === 'paid' ? 'via_support' : 'not_paid' };

  if (cancelled.assignedVendorId) {
    await notificationService.notify(cancelled.assignedVendorId, {
      type: 'pod_order_cancelled',
      title: 'Print order cancelled',
      body: `The customer cancelled the ${cancelled.categoryLabel} order.`,
      data: { orderId: cancelled.id, kind: 'pod' },
    });
  }
  return { order: cancelled, refund };
};

// ─────────────────────────── Vendor: incoming orders + status ───────────────────────────

const listVendorOrders = async (vendorId) => {
  const [assigned, businesses] = await Promise.all([
    PrintOrder.listAssignedForVendor(vendorId),
    Business.listLivePrintByVendor(vendorId),
  ]);
  return {
    open: [],
    assigned,
    eligible: { categories: [], hasPrintBusiness: businesses.length > 0 },
  };
};

const getVendorOrder = async (vendorId, orderId) => {
  const order = await PrintOrder.findAssignedForVendor(orderId, vendorId, { withDesign: true });
  if (!order) throw bad('order not found', 404);
  if (order._raw) delete order._raw;
  return { order };
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
  const phoneDigits = String(user?.mobile ?? '').replace(/\D/g, '').slice(-10);
  if (phoneDigits.length !== 10) {
    throw bad('add a valid 10-digit mobile number to your profile before paying', 400);
  }

  // Resume an in-flight checkout instead of creating a duplicate Cashfree order.
  if (order.status === PRINT_ORDER_STATUS.PENDING_PAYMENT && order.paymentSessionId) {
    return {
      order,
      payment: {
        orderId,
        cashfreeOrderId: order.cashfreeOrderId || orderId,
        paymentSessionId: order.paymentSessionId,
        amount,
        currency: 'INR',
        mode: process.env.CASHFREE_PG_ENV === 'production' ? 'production' : 'sandbox',
      },
    };
  }

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
    console.error(
      'cashfree createOrder failed (print):',
      err.detail || err.message,
      err.data ? JSON.stringify(err.data) : '',
    );
    const clientMsg =
      err.detail ||
      err.message ||
      'Could not start payment. Check Cashfree PG credentials and sandbox/prod mode match.';
    throw Object.assign(new Error(clientMsg), {
      status: err.status === 401 || err.status === 403 ? 502 : err.status || 502,
    });
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
  if (paid) {
    const payment = await paymentService.recordPayment({
      source: 'print',
      sourceId: paid.id,
      vendorId: paid.assignedVendorId,
      customerUserId: paid.customerUserId,
      amount: paid.quoteAmount,
      currency: paid.currency || 'INR',
      cashfreeOrderId,
      gatewayPaymentId: paymentRef,
    });
    if (payment?.refId) await PrintOrder.setPaymentRefId(paid.id, payment.refId);
  }
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

const ensureIndexes = () => PrintOrder.ensureIndexes();

module.exports = {
  ensureIndexes,
  createOrder,
  listAvailableShops,
  listCustomerOrders,
  getCustomerOrder,
  cancelOrder,
  listVendorOrders,
  getVendorOrder,
  updateOrderStatus,
  initiatePayment,
  handlePaymentWebhook,
};
