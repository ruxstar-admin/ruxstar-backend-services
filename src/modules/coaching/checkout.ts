import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { Type } from "typebox";
import { FakeGateway } from "../../adapters/payments.js";
import { ObjectIdString, Strict } from "../../contracts/common.js";
import { requireDatabase } from "../../platform/context.js";
import type { CoachingOrderDoc } from "../../platform/db.js";
import { AppError } from "../../platform/errors.js";
import { escape, htmlPage, NO_STORE, payPage } from "../../platform/pay-page.js";
import { apiOrigin, checkoutToken, checkoutTokenValid, rupees, signingKey, withOrder } from "../pod/orders.js";
import { certificatePdf } from "./certificate.js";
import { syncCoachingPayment } from "./orders.js";

const Params = Strict({ id: ObjectIdString });
const Query = Strict({ exp: Type.Integer(), back: Type.String({ maxLength: 500 }), t: Type.String({ maxLength: 100 }) });
/** Coaching links are signed apart from print and ticket orders', so one can't stand in for another. */
const signed = (id: string) => `coaching.${id}`;

/** The checkout link for a place, good until it is given back. */
export function coachingCheckoutUrl(app: FastifyInstance, request: { protocol: string; host: string }, order: CoachingOrderDoc, back: string): string {
  const until = order.holdUntil?.getTime() ?? Date.now() + 20 * 60_000;
  const exp = Math.floor(until / 1000);
  const query = new URLSearchParams({ exp: String(exp), back, t: checkoutToken(signingKey(app), signed(order._id.toHexString()), back, exp) });
  return `${apiOrigin(app, request)}/pay/coaching/${order._id.toHexString()}?${query.toString()}`;
}

// File links: short-lived and signed, like invoices', for certificates and course files.

const LINK_SECONDS = 10 * 60;
type FileKind = "certificate" | "material";
const signature = (key: Uint8Array, kind: FileKind, id: string, exp: number) =>
  createHmac("sha256", key).update(`coaching-${kind}.${id}.${exp}`).digest("base64url");

export function coachingFileLinks(app: FastifyInstance, request: { protocol: string; host: string }) {
  const key = signingKey(app);
  const origin = apiOrigin(app, request);
  const exp = Math.floor(Date.now() / 1000) + LINK_SECONDS;
  return (kind: FileKind, id: string) =>
    `${origin}/coaching-files/${kind}/${id}?${new URLSearchParams({ exp: String(exp), t: signature(key, kind, id, exp) }).toString()}`;
}

function linkValid(key: Uint8Array, kind: FileKind, id: string, exp: number, token: string): boolean {
  if (!Number.isInteger(exp) || exp * 1000 < Date.now()) return false;
  const expected = Buffer.from(signature(key, kind, id, exp));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const fileName = (name: string) => name.replace(/[^\w.\- ]/g, "_").slice(0, 80) || "file";

/** The page customers pay for classes on, and the file links. Outside /v1, like print's: the signed token stands in for sign-in. */
const coachingCheckout: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const key = signingKey(app);

  async function place(id: string, query: { exp: number; back: string; t: string }) {
    if (!checkoutTokenValid(key, signed(id), query.back, query.exp, query.t)) {
      throw new AppError("UNAUTHENTICATED", "This payment link has expired. Open your classes again to pay.");
    }
    const order = await db().coachingOrders.findOne({ _id: new ObjectId(id) });
    if (!order) throw new AppError("NOT_FOUND", "Enrolment not found.");
    return order;
  }

  app.get(
    "/pay/coaching/:id",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 60, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers({ ...NO_STORE, "Content-Type": "text/html; charset=utf-8" });
      const { id } = request.params;
      let order: CoachingOrderDoc;
      try {
        order = await syncCoachingPayment(app, db(), await place(id, request.query));
      } catch (err) {
        const message = err instanceof AppError ? err.message : "Something went wrong. Try again.";
        return htmlPage("Payment", `<h1>Can't open this payment</h1><p>${escape(message)}</p><a class="btn" href="${escape(request.query.back)}">Back to Ruxstar</a>`);
      }
      const next = withOrder(request.query.back, id);
      if (order.status !== "awaiting_payment" || !order.payment) return reply.redirect(next, 303);
      const query = new URLSearchParams({ exp: String(request.query.exp), back: request.query.back, t: request.query.t }).toString();
      return payPage(app.payments, {
        heading: order.courseTitle,
        detail: `#${order.orderNo} · ${order.kind === "demo" ? "Demo class" : order.batchName} · ${order.student.name} · ${order.businessName}`,
        amount: rupees(order.price.total),
        session: order.payment.sessionId,
        check: `/pay/coaching/${id}/check?${query}`,
        test: `/pay/coaching/${id}/test?${query}`,
        next,
      });
    },
  );

  app.post(
    "/pay/coaching/:id/check",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers(NO_STORE);
      const order = await syncCoachingPayment(app, db(), await place(request.params.id, request.query));
      return { status: order.status, next: withOrder(request.query.back, request.params.id) };
    },
  );

  app.post(
    "/pay/coaching/:id/test",
    { schema: { hide: true, params: Params, querystring: Query }, config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.headers(NO_STORE);
      if (!(app.payments instanceof FakeGateway)) throw new AppError("NOT_FOUND");
      const order = await place(request.params.id, request.query);
      if (!order.payment) throw new AppError("NOT_FOUND");
      app.payments.markPaid(order.payment.gatewayOrderId);
      return { status: (await syncCoachingPayment(app, db(), order)).status };
    },
  );

  app.get("/pay/coaching/:id/done", { schema: { hide: true, params: Params } }, async (request, reply) => {
    reply.headers({ ...NO_STORE, "Content-Type": "text/html; charset=utf-8" });
    const order = await db().coachingOrders.findOne({ _id: new ObjectId(request.params.id) });
    const now = order ? await syncCoachingPayment(app, db(), order) : null;
    return htmlPage(
      "Payment",
      now?.status === "confirmed"
        ? `<h1>You're in</h1><p>${escape(now.student.name)} is enrolled in ${escape(now.courseTitle)}. Go back to Ruxstar for the class times.</p>`
        : `<h1>Payment not finished</h1><p>Go back to Ruxstar and open your classes to try again.</p>`,
    );
  });

  app.get(
    "/coaching-files/:kind/:id",
    {
      schema: {
        hide: true,
        params: Strict({ kind: Type.Union([Type.Literal("certificate"), Type.Literal("material")]), id: ObjectIdString }),
        querystring: Strict({ exp: Type.Integer(), t: Type.String({ maxLength: 100 }), download: Type.Optional(Type.Literal("1")) }),
      },
      config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const { kind, id } = request.params;
      if (!linkValid(key, kind, id, request.query.exp, request.query.t)) throw new AppError("UNAUTHENTICATED", "This link has expired. Open it again in Ruxstar.");
      const disposition = request.query.download ? "attachment" : "inline";
      reply.headers({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
      if (kind === "certificate") {
        const doc = await db().coachingCertificates.findOne({ _id: new ObjectId(id) });
        if (!doc) throw new AppError("NOT_FOUND", "Certificate not found.");
        return reply
          .header("Content-Type", "application/pdf")
          .header("Content-Disposition", `${disposition}; filename="certificate-${doc.code}.pdf"`)
          .send(await certificatePdf(doc));
      }
      const material = await db().coachingMaterials.findOne({ _id: new ObjectId(id) });
      if (!material?.file) throw new AppError("NOT_FOUND", "File not found.");
      const data = await app.printFiles.read(material.file.key).catch(() => null);
      if (!data) throw new AppError("NOT_FOUND", "File not found.");
      return reply
        .header("Content-Type", material.file.contentType)
        .header("Content-Disposition", `${disposition}; filename="${fileName(material.file.name)}"`)
        .send(data);
    },
  );
};

export default coachingCheckout;
