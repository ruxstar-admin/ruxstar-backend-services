const { randomUUID } = require('crypto');
const Business = require('../models/Business');
const Product = require('../models/Product');
const CommerceOrder = require('../models/CommerceOrder');
const User = require('../models/User');
const paymentService = require('./payment.service');
const notificationService = require('./notification.service');
const cashfreePayments = require('../utils/cashfreePayments');
const {
  MAX_CART_LINES,
  MAX_LINE_QTY,
  COMMERCE_ORDER_STATUS,
  VENDOR_STATUS_FLOW,
} = require('../constants/commerce');

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

const buildReturnUrl = (orderId) => {
  const tpl = process.env.CASHFREE_PG_RETURN_URL;
  if (!tpl) return undefined;
  return tpl.replace('{bookingId}', orderId).replace('{orderId}', orderId);
};

const resolveCart = async (businessId, items) => {
  if (!Array.isArray(items) || !items.length) throw bad('add at least one product');
  if (items.length > MAX_CART_LINES) throw bad(`max ${MAX_CART_LINES} products per order`);

  const products = await Product.listByBusiness(businessId, { activeOnly: true });
  const byId = new Map(products.map((p) => [p.id, p]));
  const lines = [];
  let amount = 0;

  for (const raw of items) {
    const productId = String(raw.productId || '');
    const quantity = Math.round(Number(raw.quantity));
    if (!productId || !byId.has(productId)) throw bad('one of the products is unavailable');
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > MAX_LINE_QTY) {
      throw bad(`quantity must be between 1 and ${MAX_LINE_QTY}`);
    }
    const product = byId.get(productId);
    if (product.stock < quantity) {
      throw bad(`only ${product.stock} left of "${product.name}"`);
    }
    const lineTotal = product.price * quantity;
    amount += lineTotal;
    lines.push({
      productId: product.id,
      name: product.name,
      price: product.price,
      quantity,
      coverUrl: product.coverUrl || null,
    });
  }

  return { lines, amount };
};

const createOrder = async (customerUserId, body) => {
  const businessId = String(body.businessId || '');
  if (!businessId) throw bad('businessId is required');

  const business = await Business.findLiveById(businessId, { withPhotoData: false });
  if (!business || business.module !== 'commerce') throw bad('shop not found', 404);

  const profile = business.setup?.commerceProfile || {};
  if (profile.acceptingOrders === false) throw bad('this shop is not accepting orders');

  const { lines, amount } = await resolveCart(businessId, body.items);
  const minOrder = Math.round(Number(profile.minOrderValue) || 0);
  if (minOrder > 0 && amount < minOrder) {
    throw bad(`minimum order value is ₹${minOrder}`);
  }

  const user = await User.findById(customerUserId);
  const vendor = await User.findById(business.vendorId);

  const orderId = randomUUID();
  const order = await CommerceOrder.insert({
    _id: orderId,
    customerUserId,
    customerName: user?.name || '',
    customerMobile: user?.mobile || '',
    vendorId: business.vendorId,
    businessId,
    businessName: business.name,
    vendorName: vendor?.vendorProfile?.businessName || vendor?.name || business.name,
    vendorMobile: business.phone || vendor?.mobile || null,
    items: lines,
    notes: String(body.notes ?? '').trim().slice(0, 500),
    amount,
    status: COMMERCE_ORDER_STATUS.PENDING_PAYMENT,
  });

  await notificationService.notify(String(business.vendorId), {
    type: 'commerce_order_new',
    title: 'New commerce order (awaiting payment)',
    body: `${user?.name || 'A customer'} started a ₹${amount} order at ${business.name}.`,
    data: { orderId: order.id, kind: 'commerce' },
  });

  return { order };
};

const listCustomerOrders = async (customerUserId) => ({
  orders: await CommerceOrder.listByCustomer(customerUserId),
});

const getCustomerOrder = async (customerUserId, orderId) => {
  const order = await CommerceOrder.getForCustomer(orderId, customerUserId);
  if (!order) throw bad('order not found', 404);
  return { order };
};

const cancelOrder = async (customerUserId, orderId) => {
  const existing = await CommerceOrder.getForCustomer(orderId, customerUserId);
  if (!existing) throw bad('order not found', 404);
  if (existing.status !== COMMERCE_ORDER_STATUS.PENDING_PAYMENT) {
    throw bad('only unpaid orders can be cancelled');
  }
  const order = await CommerceOrder.cancelForCustomer(orderId, customerUserId);
  return { order, refunded: false };
};

const initiatePayment = async (customerUserId, orderId) => {
  if (!cashfreePayments.isConfigured()) throw bad('payments are not configured', 503);

  const order = await CommerceOrder.getForCustomer(orderId, customerUserId);
  if (!order) throw bad('order not found', 404);
  if (
    ![COMMERCE_ORDER_STATUS.PENDING_PAYMENT].includes(order.status) &&
    order.paymentStatus === 'paid'
  ) {
    throw bad('this order is already paid');
  }
  if (order.status === COMMERCE_ORDER_STATUS.CANCELLED) throw bad('this order was cancelled');
  if (order.status !== COMMERCE_ORDER_STATUS.PENDING_PAYMENT && !order.paymentSessionId) {
    throw bad('this order is not ready for payment');
  }

  const amount = Number(order.amount);
  if (!Number.isFinite(amount) || amount < 1) throw bad('invalid order amount');

  const user = await User.findById(customerUserId);
  const phoneDigits = String(user?.mobile ?? '').replace(/\D/g, '').slice(-10);
  if (phoneDigits.length !== 10) {
    throw bad('add a valid 10-digit mobile number to your profile before paying');
  }

  if (order.status === COMMERCE_ORDER_STATUS.PENDING_PAYMENT && order.paymentSessionId) {
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
      note: `Commerce · ${order.businessName}`,
    });
  } catch (err) {
    console.error('cashfree createOrder failed (commerce):', err.detail || err.message);
    throw Object.assign(new Error(err.detail || err.message || 'Could not start payment'), {
      status: err.status === 401 || err.status === 403 ? 502 : err.status || 502,
    });
  }

  const paymentSessionId = cfOrder.payment_session_id;
  const cashfreeOrderId = cfOrder.cf_order_id || cfOrder.order_id || orderId;
  await CommerceOrder.attachPaymentSession(orderId, { paymentSessionId, cashfreeOrderId });

  return {
    order: await CommerceOrder.getForCustomer(orderId, customerUserId),
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
  const id = String(raw._id ?? raw.id);
  // Re-check stock and decrement before confirming payment.
  const fresh = await CommerceOrder.findById(id);
  if (!fresh) return null;
  if (fresh.paymentStatus === 'paid') return fresh;

  const ok = await Product.decrementStock(fresh.items);
  if (!ok) {
    console.error('commerce settlePaid: insufficient stock for', id);
    return null;
  }

  const paid = await CommerceOrder.markPaid(id, { cashfreeOrderId, paymentRef });
  if (!paid) {
    await Product.restoreStock(fresh.items);
    return null;
  }

  const payment = await paymentService.recordPayment({
    source: 'commerce',
    sourceId: paid.id,
    vendorId: paid.vendorId,
    customerUserId: paid.customerUserId,
    amount: paid.amount,
    currency: paid.currency || 'INR',
    cashfreeOrderId,
    gatewayPaymentId: paymentRef,
  });
  if (payment?.refId) await CommerceOrder.setPaymentRefId(paid.id, payment.refId);

  if (paid.vendorId) {
    await notificationService.notify(paid.vendorId, {
      type: 'commerce_order_paid',
      title: 'Commerce order paid',
      body: `Payment received for ₹${paid.amount} at ${paid.businessName}.`,
      data: { orderId: paid.id, kind: 'commerce' },
    });
  }
  return paid;
};

const handlePaymentWebhook = async (payload) => {
  const data = payload?.data || {};
  const orderId = data.order?.order_id;
  if (!orderId) return { ok: true, ignored: true };

  const existing = await CommerceOrder.findById(orderId);
  if (!existing) return { ok: true, ignored: true };

  const paymentStatus = String(data.payment?.payment_status || data.order?.order_status || '')
    .toUpperCase();
  if (paymentStatus === 'SUCCESS' || paymentStatus === 'PAID') {
    await settlePaid(existing, {
      cashfreeOrderId: data.order?.cf_order_id || data.order?.order_id,
      paymentRef: data.payment?.cf_payment_id || data.payment?.payment_id,
    });
  }
  return { ok: true };
};

const listVendorOrders = async (vendorId) => ({
  orders: await CommerceOrder.listByVendor(vendorId),
});

const getVendorOrder = async (vendorId, orderId) => {
  const order = await CommerceOrder.getForVendor(orderId, vendorId);
  if (!order) throw bad('order not found', 404);
  return { order };
};

const updateVendorStatus = async (vendorId, orderId, nextStatus) => {
  const order = await CommerceOrder.getForVendor(orderId, vendorId);
  if (!order) throw bad('order not found', 404);
  const allowed = VENDOR_STATUS_FLOW[order.status] || [];
  if (!allowed.includes(nextStatus)) {
    throw bad(`cannot move from ${order.status} to ${nextStatus}`);
  }
  const updated = await CommerceOrder.updateStatus(orderId, vendorId, nextStatus);
  if (updated?.customerUserId) {
    const titles = {
      [COMMERCE_ORDER_STATUS.PREPARING]: 'Your order is being prepared',
      [COMMERCE_ORDER_STATUS.READY]: 'Your order is ready for pickup',
      [COMMERCE_ORDER_STATUS.COMPLETED]: 'Order completed',
    };
    await notificationService.notify(updated.customerUserId, {
      type: `commerce_${nextStatus}`,
      title: titles[nextStatus] || 'Order update',
      body: `${updated.businessName} · ₹${updated.amount}`,
      data: { orderId: updated.id, kind: 'commerce' },
    });
  }
  return { order: updated };
};

const setAcceptingOrders = async (businessId, vendorId, accepting) => {
  const business = await Business.findByIdForVendor(businessId, vendorId, {
    withPhotoData: false,
  });
  if (!business || business.module !== 'commerce') throw bad('shop not found', 404);
  const setup = business.setup || {};
  const commerceProfile = {
    ...(setup.commerceProfile || {}),
    acceptingOrders: accepting !== false,
  };
  const updated = await Business.updateForVendor(businessId, vendorId, {
    setup: { ...setup, commerceProfile },
  });
  return { business: updated };
};

const ensureIndexes = () =>
  Promise.all([Product.ensureIndexes(), CommerceOrder.ensureIndexes()]);

module.exports = {
  createOrder,
  listCustomerOrders,
  getCustomerOrder,
  cancelOrder,
  initiatePayment,
  settlePaid,
  handlePaymentWebhook,
  listVendorOrders,
  getVendorOrder,
  updateVendorStatus,
  setAcceptingOrders,
  ensureIndexes,
  COMMERCE_ORDER_STATUS,
};
