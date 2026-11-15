import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { Type } from "typebox";
import { FakeGateway } from "../../adapters/payments.js";
import { ObjectIdString, Strict } from "../../contracts/common.js";
import { requireDatabase } from "../../platform/context.js";
import type { TurfBookingDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { escape, htmlPage, NO_STORE, payPage } from "../../platform/pay-page.js";
import { apiOrigin, checkoutToken, checkoutTokenValid, rupees, signingKey, withOrder } from "../pod/orders.js";
import { syncTurfPayment } from "./orders.js";
import { whenText } from "./slots.js";

const Params = Strict({ id: ObjectIdString });
const Query = Strict({ exp: Type.Integer(), back: Type.String({ maxLength: 500 }), t: Type.String({ maxLength: 100 }) });
/** Turf links are signed apart from the other modules', so one can't stand in for another. */
const signed = (id: string) => `turf.${id}`;

/** The checkout link for a booking, good until its slots are given back. */
export function turfCheckoutUrl(app: FastifyInstance, request: { protocol: string; host: string }, booking: TurfBookingDoc, back: string): string {
  const until = booking.holdUntil?.getTime() ?? Date.now() + 15 * 60_000;
  const exp = Math.floor(until / 1000);
  const query = new URLSearchParams({ exp: String(exp), back, t: checkoutToken(signingKey(app), signed(booking._id.toHexString()), back, exp) });
  return `${apiOrigin(app, request)}/pay/turf/${booking._id.toHexString()}?${query.toString()}`;
}

/** The page customers pay for slots on. Outside /v1, like print's: the signed token stands in for sign-in. */
const turfCheckout: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const key = signingKey(app);

  async function booking(id: string, query: { exp: number; back: string; t: string }) {
    if (!checkoutTokenValid(key, signed(id), query.back, query.exp, query.t)) {
      throw new AppError("UNAUTHENTICATED", "This payment link has expired. Open your booking again to pay.");
    }
    const doc = await db().turfBookings.findOne({ _id: new ObjectId(id) });
    if (!doc) throw new AppError("NOT_FOUND", "Booking not found.");
    return doc;
  }

  app.get(
    "/pay/turf/:id",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 60, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers({ ...NO_STORE, "Content-Type": "text/html; charset=utf-8" });
      const { id } = request.params;
      let doc: TurfBookingDoc;
      try {
        doc = await syncTurfPayment(app, db(), await booking(id, request.query));
      } catch (err) {
        const message = err instanceof AppError ? err.message : "Something went wrong. Try again.";
        return htmlPage("Payment", `<h1>Can't open this payment</h1><p>${escape(message)}</p><a class="btn" href="${escape(request.query.back)}">Back to Ruxstar</a>`);
      }
      const next = withOrder(request.query.back, id);
      if (doc.status !== "awaiting_payment" || !doc.payment) return reply.redirect(next, 303);
      const query = new URLSearchParams({ exp: String(request.query.exp), back: request.query.back, t: request.query.t }).toString();
      const first = doc.occurrences[0]!;
      return payPage(app.payments, {
        heading: `${doc.groundName}, ${doc.courtName}`,
        detail: `#${doc.orderNo} · ${whenText(first.startAt, first.endAt)}${doc.weeks > 1 ? ` · every week for ${doc.weeks} weeks` : ""} · ${doc.businessName}`,
        amount: rupees(doc.price.total),
        session: doc.payment.sessionId,
        check: `/pay/turf/${id}/check?${query}`,
        test: `/pay/turf/${id}/test?${query}`,
        next,
      });
    },
  );

  app.post(
    "/pay/turf/:id/check",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers(NO_STORE);
      const doc = await syncTurfPayment(app, db(), await booking(request.params.id, request.query));
      return { status: doc.status, next: withOrder(request.query.back, request.params.id) };
    },
  );

  app.post(
    "/pay/turf/:id/test",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers(NO_STORE);
      if (!(app.payments instanceof FakeGateway)) throw new AppError("NOT_FOUND");
      const doc = await booking(request.params.id, request.query);
      if (!doc.payment) throw new AppError("NOT_FOUND");
      app.payments.markPaid(doc.payment.gatewayOrderId);
      return { status: (await syncTurfPayment(app, db(), doc)).status };
    },
  );

  app.get("/pay/turf/:id/done", { schema: { hide: true, params: Params } }, async (request, reply) => {
    reply.headers({ ...NO_STORE, "Content-Type": "text/html; charset=utf-8" });
    const doc = await db().turfBookings.findOne({ _id: new ObjectId(request.params.id) });
    const now = doc ? await syncTurfPayment(app, db(), doc) : null;
    return htmlPage(
      "Payment",
      now?.status === "confirmed"
        ? `<h1>You're booked</h1><p>${escape(now.groundName)}, ${escape(now.courtName)}. Booking #${now.orderNo}. Go back to Ruxstar for the details.</p>`
        : `<h1>Payment not finished</h1><p>Go back to Ruxstar and open your booking to try again.</p>`,
    );
  });
};

export default turfCheckout;
