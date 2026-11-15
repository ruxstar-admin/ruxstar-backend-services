import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { Type } from "typebox";
import { FakeGateway } from "../../adapters/payments.js";
import { ObjectIdString, Strict } from "../../contracts/common.js";
import { requireDatabase } from "../../platform/context.js";
import type { StayReservationDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { escape, htmlPage, NO_STORE, payPage } from "../../platform/pay-page.js";
import { apiOrigin, checkoutToken, checkoutTokenValid, rupees, signingKey, withOrder } from "../pod/orders.js";
import { dayText, syncStayPayment } from "./orders.js";

const Params = Strict({ id: ObjectIdString });
const Query = Strict({ exp: Type.Integer(), back: Type.String({ maxLength: 500 }), t: Type.String({ maxLength: 100 }) });
/** Stays links are signed apart from the other modules', so one can't stand in for another. */
const signed = (id: string) => `stays.${id}`;

/** The checkout link for a reservation, good until its beds are given back. */
export function staysCheckoutUrl(app: FastifyInstance, request: { protocol: string; host: string }, r: StayReservationDoc, back: string): string {
  const until = r.holdUntil?.getTime() ?? Date.now() + 15 * 60_000;
  const exp = Math.floor(until / 1000);
  const query = new URLSearchParams({ exp: String(exp), back, t: checkoutToken(signingKey(app), signed(r._id.toHexString()), back, exp) });
  return `${apiOrigin(app, request)}/pay/stays/${r._id.toHexString()}?${query.toString()}`;
}

const stayText = (r: StayReservationDoc) =>
  `Move-in ${dayText(r.moveIn)} · ${r.unit === "night" ? `${r.units} night${r.units === 1 ? "" : "s"}` : `${r.units} month${r.units === 1 ? "" : "s"} paid`}`;

/** The page tenants pay a reservation on. Outside /v1, like print's: the signed token stands in for sign-in. */
const staysCheckout: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const key = signingKey(app);

  async function reservation(id: string, query: { exp: number; back: string; t: string }) {
    if (!checkoutTokenValid(key, signed(id), query.back, query.exp, query.t)) {
      throw new AppError("UNAUTHENTICATED", "This payment link has expired. Open your reservation again to pay.");
    }
    const doc = await db().staysReservations.findOne({ _id: new ObjectId(id) });
    if (!doc) throw new AppError("NOT_FOUND", "Reservation not found.");
    return doc;
  }

  app.get(
    "/pay/stays/:id",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 60, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers({ ...NO_STORE, "Content-Type": "text/html; charset=utf-8" });
      const { id } = request.params;
      let doc: StayReservationDoc;
      try {
        doc = await syncStayPayment(app, db(), await reservation(id, request.query));
      } catch (err) {
        const message = err instanceof AppError ? err.message : "Something went wrong. Try again.";
        return htmlPage("Payment", `<h1>Can't open this payment</h1><p>${escape(message)}</p><a class="btn" href="${escape(request.query.back)}">Back to Ruxstar</a>`);
      }
      const next = withOrder(request.query.back, id);
      if (doc.status !== "awaiting_payment" || !doc.payment) return reply.redirect(next, 303);
      const query = new URLSearchParams({ exp: String(request.query.exp), back: request.query.back, t: request.query.t }).toString();
      return payPage(app.payments, {
        heading: `${doc.propertyName}, ${doc.roomName}`,
        detail: `#${doc.orderNo} · ${stayText(doc)} · ${doc.businessName}`,
        amount: rupees(doc.price.total),
        session: doc.payment.sessionId,
        check: `/pay/stays/${id}/check?${query}`,
        test: `/pay/stays/${id}/test?${query}`,
        next,
      });
    },
  );

  app.post(
    "/pay/stays/:id/check",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers(NO_STORE);
      const doc = await syncStayPayment(app, db(), await reservation(request.params.id, request.query));
      return { status: doc.status, next: withOrder(request.query.back, request.params.id) };
    },
  );

  app.post(
    "/pay/stays/:id/test",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers(NO_STORE);
      if (!(app.payments instanceof FakeGateway)) throw new AppError("NOT_FOUND");
      const doc = await reservation(request.params.id, request.query);
      if (!doc.payment) throw new AppError("NOT_FOUND");
      app.payments.markPaid(doc.payment.gatewayOrderId);
      return { status: (await syncStayPayment(app, db(), doc)).status };
    },
  );

  app.get("/pay/stays/:id/done", { schema: { hide: true, params: Params } }, async (request, reply) => {
    reply.headers({ ...NO_STORE, "Content-Type": "text/html; charset=utf-8" });
    const doc = await db().staysReservations.findOne({ _id: new ObjectId(request.params.id) });
    const now = doc ? await syncStayPayment(app, db(), doc) : null;
    return htmlPage(
      "Payment",
      now?.status === "confirmed"
        ? `<h1>You're reserved</h1><p>${escape(now.propertyName)}, ${escape(now.roomName)}. Reservation #${now.orderNo}. Go back to Ruxstar for the details.</p>`
        : `<h1>Payment not finished</h1><p>Go back to Ruxstar and open your reservation to try again.</p>`,
    );
  });
};

export default staysCheckout;
