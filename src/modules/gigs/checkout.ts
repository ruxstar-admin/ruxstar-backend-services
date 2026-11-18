import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { Type } from "typebox";
import { FakeGateway } from "../../adapters/payments.js";
import { ObjectIdString, Strict } from "../../contracts/common.js";
import { requireDatabase } from "../../platform/context.js";
import type { GigOrderDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { escape, htmlPage, NO_STORE, payPage } from "../../platform/pay-page.js";
import { apiOrigin, checkoutToken, checkoutTokenValid, rupees, signingKey, withOrder } from "../pod/orders.js";
import { syncGigPayment } from "./orders.js";
import { PAY_WINDOW_MS } from "./rules.js";

const Params = Strict({ id: ObjectIdString });
const Query = Strict({ exp: Type.Integer(), back: Type.String({ maxLength: 500 }), t: Type.String({ maxLength: 100 }) });
/** Freelance links are signed apart from the other modules', so one can't stand in for another. */
const signed = (id: string) => `gigs.${id}`;

/** The checkout link for an order, good until its 20 minutes are up. */
export function gigCheckoutUrl(app: FastifyInstance, request: { protocol: string; host: string }, order: GigOrderDoc, back: string): string {
  const until = order.holdUntil?.getTime() ?? Date.now() + PAY_WINDOW_MS;
  const exp = Math.floor(until / 1000);
  const query = new URLSearchParams({ exp: String(exp), back, t: checkoutToken(signingKey(app), signed(order._id.toHexString()), back, exp) });
  return `${apiOrigin(app, request)}/pay/gigs/${order._id.toHexString()}?${query.toString()}`;
}

// File links: short-lived and signed. Only views for the order's customer, its freelancer and Ruxstar staff get one.

const LINK_SECONDS = 10 * 60;
const signature = (key: Uint8Array, id: string, exp: number) => createHmac("sha256", key).update(`gig-file.${id}.${exp}`).digest("base64url");

export type GigFileLinks = (id: ObjectId) => string;

export function gigFileLinks(app: FastifyInstance, request: { protocol: string; host: string }): GigFileLinks {
  const key = signingKey(app);
  const origin = apiOrigin(app, request);
  const exp = Math.floor(Date.now() / 1000) + LINK_SECONDS;
  return (id) => `${origin}/gig-files/${id.toHexString()}?${new URLSearchParams({ exp: String(exp), t: signature(key, id.toHexString(), exp) }).toString()}`;
}

function linkValid(key: Uint8Array, id: string, exp: number, token: string): boolean {
  if (!Number.isInteger(exp) || exp * 1000 < Date.now()) return false;
  const expected = Buffer.from(signature(key, id, exp));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const fileName = (name: string) => name.replace(/[^\w.\- ]/g, "_").slice(0, 120) || "file";
/** Only these open in the browser without `download`; anything else, and everything with it, downloads. Never HTML or SVG. */
const INLINE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"]);

/** The page customers pay for freelance orders on, and the file downloads. Outside /v1, like print's: the signed token stands in for sign-in. */
const gigsCheckout: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const key = signingKey(app);

  async function order(id: string, query: { exp: number; back: string; t: string }) {
    if (!checkoutTokenValid(key, signed(id), query.back, query.exp, query.t)) {
      throw new AppError("UNAUTHENTICATED", "This payment link has expired. Open your order again to pay.");
    }
    const doc = await db().gigOrders.findOne({ _id: new ObjectId(id) });
    if (!doc) throw new AppError("NOT_FOUND", "Order not found.");
    return doc;
  }

  app.get(
    "/pay/gigs/:id",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 60, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers({ ...NO_STORE, "Content-Type": "text/html; charset=utf-8" });
      const { id } = request.params;
      let doc: GigOrderDoc;
      try {
        doc = await syncGigPayment(app, db(), await order(id, request.query));
      } catch (err) {
        const message = err instanceof AppError ? err.message : "Something went wrong. Try again.";
        return htmlPage("Payment", `<h1>Can't open this payment</h1><p>${escape(message)}</p><a class="btn" href="${escape(request.query.back)}">Back to Ruxstar</a>`);
      }
      const next = withOrder(request.query.back, id);
      if (doc.status !== "awaiting_payment") return reply.redirect(next, 303);
      const query = new URLSearchParams({ exp: String(request.query.exp), back: request.query.back, t: request.query.t }).toString();
      return payPage(app.payments, {
        heading: doc.title,
        detail: `#${doc.orderNo} · ${doc.package.name} · ${doc.businessName}`,
        amount: rupees(doc.price.total),
        session: doc.payment.sessionId,
        check: `/pay/gigs/${id}/check?${query}`,
        test: `/pay/gigs/${id}/test?${query}`,
        next,
      });
    },
  );

  app.post(
    "/pay/gigs/:id/check",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers(NO_STORE);
      const doc = await syncGigPayment(app, db(), await order(request.params.id, request.query));
      return { status: doc.status, next: withOrder(request.query.back, request.params.id) };
    },
  );

  app.post(
    "/pay/gigs/:id/test",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers(NO_STORE);
      if (!(app.payments instanceof FakeGateway)) throw new AppError("NOT_FOUND");
      const doc = await order(request.params.id, request.query);
      app.payments.markPaid(doc.payment.gatewayOrderId);
      return { status: (await syncGigPayment(app, db(), doc)).status };
    },
  );

  app.get("/pay/gigs/:id/done", { schema: { hide: true, params: Params } }, async (request, reply) => {
    reply.headers({ ...NO_STORE, "Content-Type": "text/html; charset=utf-8" });
    const doc = await db().gigOrders.findOne({ _id: new ObjectId(request.params.id) });
    const now = doc ? await syncGigPayment(app, db(), doc) : null;
    const paid = now && now.status !== "awaiting_payment" && now.status !== "cancelled";
    return htmlPage(
      "Payment",
      paid
        ? `<h1>Payment received</h1><p>Order #${now.orderNo} is with ${escape(now.businessName)}. Go back to Ruxstar to follow it.</p>`
        : `<h1>Payment not finished</h1><p>Go back to Ruxstar and open the order to try again.</p>`,
    );
  });

  app.get(
    "/gig-files/:id",
    {
      schema: { hide: true, params: Params, querystring: Strict({ exp: Type.Integer(), t: Type.String({ maxLength: 100 }), download: Type.Optional(Type.Literal("1")) }) },
      config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!linkValid(key, id, request.query.exp, request.query.t)) throw new AppError("UNAUTHENTICATED", "This link has expired. Open the order again in Ruxstar.");
      const file = await db().gigFiles.findOne({ _id: new ObjectId(id) });
      if (!file) throw new AppError("NOT_FOUND", "This file was deleted.");
      const data = await app.printFiles.read(file.key).catch(() => null);
      if (!data) throw new AppError("NOT_FOUND", "This file was deleted.");
      const inline = !request.query.download && INLINE_TYPES.has(file.contentType);
      return reply
        .headers({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" })
        .header("Content-Type", file.contentType)
        .header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${fileName(file.name)}"`)
        .send(data);
    },
  );
};

export default gigsCheckout;
