import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { Type } from "typebox";
import { FakeGateway } from "../../adapters/payments.js";
import { ObjectIdString, Strict } from "../../contracts/common.js";
import { requireDatabase } from "../../platform/context.js";
import type { ShopOrderDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { escape, htmlPage, NO_STORE, payPage } from "../../platform/pay-page.js";
import { apiOrigin, checkoutToken, checkoutTokenValid, rupees, signingKey, withOrder } from "../pod/orders.js";
import { itemsText, syncShopPayment } from "./orders.js";

const Params = Strict({ id: ObjectIdString });
const Query = Strict({ exp: Type.Integer(), back: Type.String({ maxLength: 500 }), t: Type.String({ maxLength: 100 }) });
/** Local shop links are signed apart from the other modules', so one can't stand in for another. */
const signed = (id: string) => `shop.${id}`;

/** The checkout link for an order, good until its checkout time is up. */
export function shopCheckoutUrl(app: FastifyInstance, request: { protocol: string; host: string }, o: ShopOrderDoc, back: string): string {
  const until = o.holdUntil?.getTime() ?? Date.now() + 15 * 60_000;
  const exp = Math.floor(until / 1000);
  const query = new URLSearchParams({ exp: String(exp), back, t: checkoutToken(signingKey(app), signed(o._id.toHexString()), back, exp) });
  return `${apiOrigin(app, request)}/pay/shop/${o._id.toHexString()}?${query.toString()}`;
}

/** The page customers pay a local shop order on. Outside /v1, like print's: the signed token stands in for sign-in. */
const shopCheckout: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const key = signingKey(app);

  async function order(id: string, query: { exp: number; back: string; t: string }) {
    if (!checkoutTokenValid(key, signed(id), query.back, query.exp, query.t)) {
      throw new AppError("UNAUTHENTICATED", "This payment link has expired. Open your order again to pay.");
    }
    const doc = await db().shopOrders.findOne({ _id: new ObjectId(id) });
    if (!doc) throw new AppError("NOT_FOUND", "Order not found.");
    return doc;
  }

  app.get(
    "/pay/shop/:id",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 60, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers({ ...NO_STORE, "Content-Type": "text/html; charset=utf-8" });
      const { id } = request.params;
      let doc: ShopOrderDoc;
      try {
        doc = await syncShopPayment(app, db(), await order(id, request.query));
      } catch (err) {
        const message = err instanceof AppError ? err.message : "Something went wrong. Try again.";
        return htmlPage("Payment", `<h1>Can't open this payment</h1><p>${escape(message)}</p><a class="btn" href="${escape(request.query.back)}">Back to Ruxstar</a>`);
      }
      const next = withOrder(request.query.back, id);
      if (doc.status !== "awaiting_payment") return reply.redirect(next, 303);
      const query = new URLSearchParams({ exp: String(request.query.exp), back: request.query.back, t: request.query.t }).toString();
      return payPage(app.payments, {
        heading: doc.businessName,
        detail: `#${doc.orderNo} · ${itemsText(doc)} · ${doc.method === "pickup" ? "Pickup" : "Delivery"}`,
        amount: rupees(doc.price.total),
        session: doc.payment.sessionId,
        check: `/pay/shop/${id}/check?${query}`,
        test: `/pay/shop/${id}/test?${query}`,
        next,
      });
    },
  );

  app.post(
    "/pay/shop/:id/check",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers(NO_STORE);
      const doc = await syncShopPayment(app, db(), await order(request.params.id, request.query));
      return { status: doc.status, next: withOrder(request.query.back, request.params.id) };
    },
  );

  app.post(
    "/pay/shop/:id/test",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers(NO_STORE);
      if (!(app.payments instanceof FakeGateway)) throw new AppError("NOT_FOUND");
      const doc = await order(request.params.id, request.query);
      app.payments.markPaid(doc.payment.gatewayOrderId);
      return { status: (await syncShopPayment(app, db(), doc)).status };
    },
  );

  app.get("/pay/shop/:id/done", { schema: { hide: true, params: Params } }, async (request, reply) => {
    reply.headers({ ...NO_STORE, "Content-Type": "text/html; charset=utf-8" });
    const doc = await db().shopOrders.findOne({ _id: new ObjectId(request.params.id) });
    const now = doc ? await syncShopPayment(app, db(), doc) : null;
    return htmlPage(
      "Payment",
      now && now.status !== "awaiting_payment" && now.status !== "cancelled"
        ? `<h1>Order placed</h1><p>${escape(now.businessName)}, order #${now.orderNo}. Go back to Ruxstar to follow it.</p>`
        : now?.status === "cancelled" && now.payment.paidAt
          ? `<h1>Order cancelled</h1><p>${escape(now.cancellation?.reason ?? "The order was cancelled.")}</p>`
          : `<h1>Payment not finished</h1><p>Go back to Ruxstar and open your order to try again.</p>`,
    );
  });
};

export default shopCheckout;
