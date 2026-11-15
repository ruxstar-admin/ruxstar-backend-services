import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { ObjectId } from "mongodb";
import { Type } from "typebox";
import { FakeGateway } from "../../adapters/payments.js";
import { ObjectIdString, Strict } from "../../contracts/common.js";
import { requireDatabase } from "../../platform/context.js";
import type { PodOrderDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { escape, htmlPage as page, NO_STORE as noStore, payPage } from "../../platform/pay-page.js";
import { syncCoachingPayment } from "../coaching/orders.js";
import { syncTurfPayment } from "../turf/orders.js";
import { syncStayPayment } from "../stays/orders.js";
import { syncEventPayment } from "../events/orders.js";
import { checkoutTokenValid, fileLinkValid, photoLinkValid, rupees, signingKey, syncPayment, withOrder } from "./orders.js";

const Params = Strict({ id: ObjectIdString });
const Query = Strict({ exp: Type.Integer(), back: Type.String({ maxLength: 500 }), t: Type.String({ maxLength: 100 }) });

/**
 * The page customers pay on, from the app's browser or the website, and Cashfree's webhook. Outside /v1:
 * a browser opens the page itself, so there is no X-Client header, and the link's signed token stands in for sign-in.
 */
const checkout: FastifyPluginAsyncTypebox = async (app) => {
  // The webhook's signature covers the exact bytes, so JSON stays a string here.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 64 * 1024 }, (_request, body, done) => done(null, body));

  const db = () => requireDatabase(app.db);
  const key = signingKey(app);

  async function signed(id: string, query: { exp: number; back: string; t: string }): Promise<PodOrderDoc> {
    if (!checkoutTokenValid(key, id, query.back, query.exp, query.t)) {
      throw new AppError("UNAUTHENTICATED", "This payment link has expired. Open the order again to pay.");
    }
    const order = await db().podOrders.findOne({ _id: new ObjectId(id) });
    if (!order) throw new AppError("NOT_FOUND", "Order not found.");
    return order;
  }

  app.get(
    "/pay/:id",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 60, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers({ ...noStore, "Content-Type": "text/html; charset=utf-8" });
      const { id } = request.params;
      let order: PodOrderDoc;
      try {
        order = await syncPayment(app, db(), await signed(id, request.query));
      } catch (err) {
        const message = err instanceof AppError ? err.message : "Something went wrong. Try again.";
        return page("Payment", `<h1>Can't open this payment</h1><p>${escape(message)}</p><a class="btn" href="${escape(request.query.back)}">Back to Ruxstar</a>`);
      }
      const next = withOrder(request.query.back, id);
      if (order.status !== "awaiting_payment") return reply.redirect(next, 303);

      const query = new URLSearchParams({ exp: String(request.query.exp), back: request.query.back, t: request.query.t }).toString();
      return payPage(app.payments, {
        heading: `Pay ${order.shopName}`,
        detail: `Order #${order.orderNo} · ${order.productLabel} × ${order.quantity}`,
        amount: rupees(order.price.total),
        session: order.payment.sessionId,
        check: `/pay/${id}/check?${query}`,
        test: `/pay/${id}/test?${query}`,
        next,
      });
    },
  );

  app.post(
    "/pay/:id/check",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers(noStore);
      const order = await syncPayment(app, db(), await signed(request.params.id, request.query));
      return { status: order.status, next: withOrder(request.query.back, request.params.id) };
    },
  );

  app.post(
    "/pay/:id/test",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers(noStore);
      if (!(app.payments instanceof FakeGateway)) throw new AppError("NOT_FOUND");
      const order = await signed(request.params.id, request.query);
      app.payments.markPaid(order.payment.gatewayOrderId);
      return { status: (await syncPayment(app, db(), order)).status };
    },
  );

  // An order's file, from a signed link the customer or the shop asked for. No link to the bucket ever leaves the API.
  app.get(
    "/print-files/:id/:fileId",
    {
      schema: {
        hide: true,
        params: Strict({ id: ObjectIdString, fileId: ObjectIdString }),
        querystring: Strict({ exp: Type.Integer(), t: Type.String({ maxLength: 100 }), download: Type.Optional(Type.Literal("1")) }),
      },
      config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const { id, fileId } = request.params;
      const disposition = request.query.download ? "attachment" : "inline";
      if (!fileLinkValid(key, id, fileId, request.query.exp, request.query.t)) {
        throw new AppError("UNAUTHENTICATED", "This link has expired. Open the order again.");
      }
      const order = await db().podOrders.findOne({ _id: new ObjectId(id) }, { projection: { files: 1 } });
      const file = order?.files.find((f) => f.id.toHexString() === fileId);
      if (!file) throw new AppError("NOT_FOUND", "File not found.");
      const data = await app.printFiles.read(file.key);
      const name = file.name.replace(/["\\]/g, "");
      return reply
        .headers({ ...noStore, "Content-Type": file.contentType, "X-Content-Type-Options": "nosniff" })
        .header("Content-Disposition", `${disposition}; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`)
        .send(data);
    },
  );

  // A problem report's photo, from a signed link in an order view for the customer, the shop or Ruxstar staff.
  app.get(
    "/problem-photos/:id/:photoId",
    {
      schema: {
        hide: true,
        params: Strict({ id: ObjectIdString, photoId: ObjectIdString }),
        querystring: Strict({ exp: Type.Integer(), t: Type.String({ maxLength: 100 }) }),
      },
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const { id, photoId } = request.params;
      if (!photoLinkValid(key, id, photoId, request.query.exp, request.query.t)) {
        throw new AppError("UNAUTHENTICATED", "This link has expired. Open the order again.");
      }
      const order = await db().podOrders.findOne({ _id: new ObjectId(id) }, { projection: { problem: 1 } });
      const photo = order?.problem?.photos.find((p) => p.id.toHexString() === photoId);
      if (!photo) throw new AppError("NOT_FOUND", "Photo not found.");
      const data = await app.printFiles.read(photo.key);
      return reply.headers({ ...noStore, "Content-Type": "image/jpeg", "X-Content-Type-Options": "nosniff" }).send(data);
    },
  );

  // Cashfree's return_url, when its checkout leaves the page instead of closing a popup.
  app.get("/pay/:id/done", { schema: { hide: true, params: Params } }, async (request, reply) => {
    reply.headers({ ...noStore, "Content-Type": "text/html; charset=utf-8" });
    const order = await db().podOrders.findOne({ _id: new ObjectId(request.params.id) });
    const now = order ? await syncPayment(app, db(), order) : null;
    const paid = now && now.status !== "awaiting_payment" && now.status !== "cancelled";
    return page(
      "Payment",
      paid
        ? `<h1>Payment received</h1><p>Order #${now.orderNo} is with ${escape(now.shopName)}. Go back to Ruxstar to follow it.</p>`
        : `<h1>Payment not finished</h1><p>Go back to Ruxstar and open the order to try again.</p>`,
    );
  });

  app.post("/webhooks/cashfree", { schema: { hide: true }, config: { rateLimit: { max: 300, timeWindow: 60_000 } } }, async (request, reply) => {
    const raw = typeof request.body === "string" ? request.body : "";
    const header = (name: string) => (typeof request.headers[name] === "string" ? (request.headers[name] as string) : undefined);
    if (!app.payments.verifyWebhook(raw, header("x-webhook-timestamp"), header("x-webhook-signature"))) {
      request.log.warn("Cashfree webhook with a bad signature");
      return reply.code(401).send({ ok: false });
    }
    let gatewayOrderId: string | null = null;
    try {
      const event = JSON.parse(raw) as { data?: { order?: { order_id?: unknown } } };
      gatewayOrderId = typeof event.data?.order?.order_id === "string" ? event.data.order.order_id : null;
    } catch {
      // Answered 200 below: Cashfree retries anything else, and an unreadable event won't read better later.
    }
    const order = gatewayOrderId ? await db().podOrders.findOne({ "payment.gatewayOrderId": gatewayOrderId }) : null;
    // The event only says something changed; the gateway is asked what. Pending refunds are asked about too.
    if (order) await syncPayment(app, db(), order);
    else if (gatewayOrderId) {
      const tickets = await db().eventOrders.findOne({ "payment.gatewayOrderId": gatewayOrderId });
      if (tickets) await syncEventPayment(app, db(), tickets);
      const place = tickets ? null : await db().coachingOrders.findOne({ "payment.gatewayOrderId": gatewayOrderId });
      if (place) await syncCoachingPayment(app, db(), place);
      const slots = tickets || place ? null : await db().turfBookings.findOne({ "payment.gatewayOrderId": gatewayOrderId });
      if (slots) await syncTurfPayment(app, db(), slots);
      const stay = tickets || place || slots ? null : await db().staysReservations.findOne({ "payment.gatewayOrderId": gatewayOrderId });
      if (stay) await syncStayPayment(app, db(), stay);
    }
    return { ok: true };
  });
};

export default checkout;
