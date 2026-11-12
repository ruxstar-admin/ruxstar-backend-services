import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { CashfreeSettings, Config } from "../config.js";
import { AppError } from "../platform/errors.js";

export type GatewayStatus = "active" | "paid" | "expired" | "terminated";

export interface GatewayOrder {
  /** Ours, also used as Cashfree's `order_id`. Letters, digits, - and _ only. */
  orderId: string;
  /** Paise. */
  amount: number;
  customer: { id: string; phone: string; name: string | null };
  note: string;
  returnUrl: string | null;
  notifyUrl: string | null;
}

/** Customer payments. Amounts are paise everywhere except on the wire to Cashfree. */
export interface PaymentGateway {
  /** `cashfree-sandbox` and `cashfree-production` load Cashfree's checkout; `fake` shows a test button. */
  readonly checkout: "fake" | "cashfree-sandbox" | "cashfree-production";
  createOrder(order: GatewayOrder): Promise<{ sessionId: string; gatewayOrderId: string }>;
  status(orderId: string): Promise<{ status: GatewayStatus; paymentId: string | null }>;
  /** Stops an unpaid order taking a payment. Fails if it was paid meanwhile. */
  terminate(orderId: string): Promise<void>;
  /** Full refunds only for now. `refundId` makes a retry safe. */
  refund(orderId: string, refundId: string, amount: number, note: string): Promise<{ status: "pending" | "done" }>;
  /** Whether a webhook really came from the gateway. */
  verifyWebhook(rawBody: string, timestamp: string | undefined, signature: string | undefined): boolean;
}

const TIMEOUT_MS = 15_000;
type Json = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const rupees = (paise: number) => Math.round(paise) / 100;
const CASHFREE_STATUS: Record<string, GatewayStatus> = {
  ACTIVE: "active",
  PAID: "paid",
  EXPIRED: "expired",
  TERMINATED: "terminated",
  TERMINATION_REQUESTED: "terminated",
};

/** Cashfree Payment Gateway, API version 2023-08-01. */
class CashfreeGateway implements PaymentGateway {
  readonly checkout;
  private readonly base: string;

  constructor(
    private readonly settings: CashfreeSettings,
    private readonly log: FastifyBaseLogger,
  ) {
    this.base = settings.env === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
    this.checkout = settings.env === "production" ? ("cashfree-production" as const) : ("cashfree-sandbox" as const);
  }

  private async call(path: string, init?: RequestInit): Promise<Json>;
  private async call(path: string, init: RequestInit, missing: "null"): Promise<Json | null>;
  private async call(path: string, init: RequestInit = {}, missing?: "null"): Promise<Json | null> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        ...init,
        headers: {
          "x-client-id": this.settings.clientId,
          "x-client-secret": this.settings.clientSecret,
          "x-api-version": this.settings.apiVersion,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      this.log.error({ err: (err as Error).message, path }, "Cashfree payments request failed");
      throw new AppError("PAYMENTS_UNAVAILABLE");
    }
    const body = (await res.json().catch(() => ({}))) as Json;
    if (res.ok) return body;
    if (res.status === 404 && missing) return null;
    const level = res.status === 401 || res.status === 403 ? "error" : "warn";
    this.log[level]({ status: res.status, code: str(body.code), reply: str(body.message), path }, "Cashfree refused the payments request");
    throw new AppError("PAYMENTS_UNAVAILABLE");
  }

  async createOrder(order: GatewayOrder) {
    const body = await this.call("/orders", {
      method: "POST",
      body: JSON.stringify({
        order_id: order.orderId,
        order_amount: rupees(order.amount),
        order_currency: "INR",
        customer_details: {
          customer_id: order.customer.id,
          customer_phone: order.customer.phone,
          ...(order.customer.name ? { customer_name: order.customer.name } : {}),
        },
        order_meta: {
          ...(order.returnUrl ? { return_url: order.returnUrl } : {}),
          ...(order.notifyUrl ? { notify_url: order.notifyUrl } : {}),
        },
        order_note: order.note.slice(0, 200),
      }),
    });
    const sessionId = str(body.payment_session_id);
    if (!sessionId) throw new AppError("PAYMENTS_UNAVAILABLE");
    return { sessionId, gatewayOrderId: String(body.cf_order_id ?? order.orderId) };
  }

  async status(orderId: string) {
    const body = await this.call(`/orders/${encodeURIComponent(orderId)}`);
    const status: GatewayStatus = CASHFREE_STATUS[String(body.order_status)] ?? "active";
    if (status !== "paid") return { status, paymentId: null };
    const payments = await this.call(`/orders/${encodeURIComponent(orderId)}/payments`).catch(() => null);
    const list = Array.isArray(payments) ? (payments as Json[]) : [];
    const success = list.find((p) => p.payment_status === "SUCCESS");
    return { status, paymentId: success?.cf_payment_id != null ? String(success.cf_payment_id) : null };
  }

  async terminate(orderId: string) {
    await this.call(`/orders/${encodeURIComponent(orderId)}`, { method: "PATCH", body: JSON.stringify({ order_status: "TERMINATED" }) });
  }

  /** Reads the refund first, so asking again only checks on it. */
  async refund(orderId: string, refundId: string, amount: number, note: string) {
    const path = `/orders/${encodeURIComponent(orderId)}/refunds`;
    const body =
      (await this.call(`${path}/${encodeURIComponent(refundId)}`, {}, "null")) ??
      (await this.call(path, {
        method: "POST",
        body: JSON.stringify({ refund_amount: rupees(amount), refund_id: refundId, refund_note: note.slice(0, 100) }),
      }));
    return { status: body.refund_status === "SUCCESS" ? ("done" as const) : ("pending" as const) };
  }

  /** Cashfree signs `timestamp + raw body` with the secret key, HMAC-SHA256, base64. */
  verifyWebhook(rawBody: string, timestamp: string | undefined, signature: string | undefined) {
    if (!timestamp || !signature) return false;
    const expected = createHmac("sha256", this.settings.clientSecret).update(timestamp + rawBody).digest();
    const given = Buffer.from(signature, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}

/** For tests and laptops without keys: orders are paid when `markPaid` is called (the checkout page's test button). */
export class FakeGateway implements PaymentGateway {
  readonly checkout = "fake" as const;
  readonly orders = new Map<string, { amount: number; status: GatewayStatus }>();
  readonly refunds = new Map<string, { orderId: string; amount: number }>();

  async createOrder(order: GatewayOrder) {
    if (!this.orders.has(order.orderId)) this.orders.set(order.orderId, { amount: order.amount, status: "active" });
    return { sessionId: `fake_session_${order.orderId}`, gatewayOrderId: order.orderId };
  }

  async status(orderId: string) {
    const status = this.orders.get(orderId)?.status ?? "active";
    return { status, paymentId: status === "paid" ? `fake_payment_${orderId}` : null };
  }

  async terminate(orderId: string) {
    const order = this.orders.get(orderId);
    if (order?.status === "paid") throw new AppError("ORDER_STATE");
    if (order) order.status = "terminated";
  }

  async refund(orderId: string, refundId: string, amount: number) {
    this.refunds.set(refundId, { orderId, amount });
    return { status: "done" as const };
  }

  markPaid(orderId: string) {
    const order = this.orders.get(orderId);
    if (order) order.status = "paid";
  }

  verifyWebhook() {
    return false;
  }
}

class UnavailableGateway implements PaymentGateway {
  readonly checkout = "cashfree-production" as const;
  async createOrder(): Promise<never> {
    throw new AppError("PAYMENTS_UNAVAILABLE");
  }
  async status(): Promise<never> {
    throw new AppError("PAYMENTS_UNAVAILABLE");
  }
  async terminate(): Promise<never> {
    throw new AppError("PAYMENTS_UNAVAILABLE");
  }
  async refund(): Promise<never> {
    throw new AppError("PAYMENTS_UNAVAILABLE");
  }
  verifyWebhook() {
    return false;
  }
}

export function createPaymentGateway(config: Config, log: FastifyBaseLogger): PaymentGateway {
  if (config.payments.provider === "fake") return new FakeGateway();
  if (config.payments.cashfree) return new CashfreeGateway(config.payments.cashfree, log);
  log.warn("CASHFREE_PG_CLIENT_ID is not set. Customers cannot pay.");
  return new UnavailableGateway();
}
