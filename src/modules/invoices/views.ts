import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { InvoiceDoc, InvoiceRefDoc } from "../../platform/db.js";
import { apiOrigin, signingKey } from "../pod/orders.js";
import type { Invoice, InvoiceRef } from "./contracts.js";

export const invoiceRefs = (refs: InvoiceRefDoc[] | undefined): InvoiceRef[] =>
  (refs ?? []).map((r) => ({
    id: r.id.toHexString(),
    kind: r.kind,
    number: r.number,
    issuer: r.issuer,
    role: r.role,
    total: r.total,
    refundId: r.refundId,
    issuedAt: r.issuedAt.toISOString(),
  }));

// PDF links: short-lived and signed, so a browser or the app can open one without the API's headers.

const LINK_SECONDS = 10 * 60;
const signature = (key: Uint8Array, id: string, exp: number) => createHmac("sha256", key).update(`invoice.${id}.${exp}`).digest("base64url");

export function invoicePdfLinks(app: FastifyInstance, request: { protocol: string; host: string }) {
  const key = signingKey(app);
  const origin = apiOrigin(app, request);
  const exp = Math.floor(Date.now() / 1000) + LINK_SECONDS;
  return (id: string) => `${origin}/invoice-files/${id}?${new URLSearchParams({ exp: String(exp), t: signature(key, id, exp) }).toString()}`;
}

export function invoiceLinkValid(key: Uint8Array, id: string, exp: number, token: string): boolean {
  if (!Number.isInteger(exp) || exp * 1000 < Date.now()) return false;
  const expected = Buffer.from(signature(key, id, exp));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Customers don't see the tax Ruxstar collects from the business. */
export function invoiceView(doc: InvoiceDoc, pdfUrl: (id: string) => string, audience: "customer" | "vendor" | "staff"): Invoice {
  const id = doc._id.toHexString();
  return {
    id,
    kind: doc.kind,
    number: doc.number,
    fy: doc.fy,
    issuer: doc.issuer,
    role: doc.role,
    module: doc.module,
    order: { type: doc.source.type, id: doc.source.id.toHexString(), orderNo: doc.source.orderNo },
    business: { id: doc.businessId.toHexString(), name: doc.businessName },
    seller: doc.seller,
    buyer: doc.buyer,
    operator: doc.operator,
    placeOfSupply: doc.placeOfSupply,
    supply: doc.supply,
    operatorPays: doc.operatorPays,
    lines: doc.lines,
    totals: doc.totals,
    tcs: audience === "customer" ? null : doc.tcs,
    against: doc.against ? { id: doc.against.id.toHexString(), number: doc.against.number, issuedAt: doc.against.issuedAt.toISOString() } : null,
    refund: doc.refund,
    credited: doc.credited,
    notes: doc.notes,
    issuedAt: doc.issuedAt.toISOString(),
    pdfUrl: pdfUrl(id),
  };
}
