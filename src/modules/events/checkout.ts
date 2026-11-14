import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { Type } from "typebox";
import { FakeGateway } from "../../adapters/payments.js";
import { ObjectIdString, Strict } from "../../contracts/common.js";
import { requireDatabase } from "../../platform/context.js";
import type { EventOrderDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { escape, htmlPage, NO_STORE, payPage } from "../../platform/pay-page.js";
import { apiOrigin, checkoutToken, checkoutTokenValid, rupees, signingKey, withOrder } from "../pod/orders.js";
import { syncEventPayment } from "./orders.js";

const Params = Strict({ id: ObjectIdString });
const Query = Strict({ exp: Type.Integer(), back: Type.String({ maxLength: 500 }), t: Type.String({ maxLength: 100 }) });
/** Ticket links are signed apart from print orders', so one can't stand in for the other. */
const signed = (id: string) => `event.${id}`;

/** The checkout link for a booking, good until its seats are given back. */
export function eventCheckoutUrl(app: FastifyInstance, request: { protocol: string; host: string }, order: EventOrderDoc, back: string): string {
  const until = order.holdUntil?.getTime() ?? Date.now() + 20 * 60_000;
  const exp = Math.floor(until / 1000);
  const query = new URLSearchParams({ exp: String(exp), back, t: checkoutToken(signingKey(app), signed(order._id.toHexString()), back, exp) });
  return `${apiOrigin(app, request)}/pay/events/${order._id.toHexString()}?${query.toString()}`;
}

/** The page customers pay for tickets on. Outside /v1, like print's: the link's signed token stands in for sign-in. */
const eventCheckout: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const key = signingKey(app);

  async function booking(id: string, query: { exp: number; back: string; t: string }) {
    if (!checkoutTokenValid(key, signed(id), query.back, query.exp, query.t)) {
      throw new AppError("UNAUTHENTICATED", "This payment link has expired. Open your tickets again to pay.");
    }
    const order = await db().eventOrders.findOne({ _id: new ObjectId(id) });
    if (!order) throw new AppError("NOT_FOUND", "Booking not found.");
    return order;
  }

  app.get(
    "/pay/events/:id",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 60, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers({ ...NO_STORE, "Content-Type": "text/html; charset=utf-8" });
      const { id } = request.params;
      let order: EventOrderDoc;
      try {
        order = await syncEventPayment(app, db(), await booking(id, request.query));
      } catch (err) {
        const message = err instanceof AppError ? err.message : "Something went wrong. Try again.";
        return htmlPage("Payment", `<h1>Can't open this payment</h1><p>${escape(message)}</p><a class="btn" href="${escape(request.query.back)}">Back to Ruxstar</a>`);
      }
      const next = withOrder(request.query.back, id);
      if (order.status !== "awaiting_payment" || !order.payment) return reply.redirect(next, 303);
      const query = new URLSearchParams({ exp: String(request.query.exp), back: request.query.back, t: request.query.t }).toString();
      const people = order.lines.reduce((sum, l) => sum + l.quantity, 0);
      return payPage(app.payments, {
        heading: order.eventTitle,
        detail: `Booking #${order.orderNo} · ${order.team ? `Team ${order.team.name}` : `${people} ${people === 1 ? "ticket" : "tickets"}`} · ${order.businessName}`,
        amount: rupees(order.price.total),
        session: order.payment.sessionId,
        check: `/pay/events/${id}/check?${query}`,
        test: `/pay/events/${id}/test?${query}`,
        next,
      });
    },
  );

  app.post(
    "/pay/events/:id/check",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers(NO_STORE);
      const order = await syncEventPayment(app, db(), await booking(request.params.id, request.query));
      return { status: order.status, next: withOrder(request.query.back, request.params.id) };
    },
  );

  app.post(
    "/pay/events/:id/test",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers(NO_STORE);
      if (!(app.payments instanceof FakeGateway)) throw new AppError("NOT_FOUND");
      const order = await booking(request.params.id, request.query);
      if (!order.payment) throw new AppError("NOT_FOUND");
      app.payments.markPaid(order.payment.gatewayOrderId);
      return { status: (await syncEventPayment(app, db(), order)).status };
    },
  );

  app.get("/pay/events/:id/done", { schema: { hide: true, params: Params } }, async (request, reply) => {
    reply.headers({ ...NO_STORE, "Content-Type": "text/html; charset=utf-8" });
    const order = await db().eventOrders.findOne({ _id: new ObjectId(request.params.id) });
    const now = order ? await syncEventPayment(app, db(), order) : null;
    return htmlPage(
      "Payment",
      now?.status === "confirmed"
        ? `<h1>You're in</h1><p>Booking #${now.orderNo} for ${escape(now.eventTitle)} is confirmed. Go back to Ruxstar for your tickets.</p>`
        : `<h1>Payment not finished</h1><p>Go back to Ruxstar and open your tickets to try again.</p>`,
    );
  });
};

export default eventCheckout;
