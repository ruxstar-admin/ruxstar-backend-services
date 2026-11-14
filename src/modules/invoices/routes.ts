import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyReply } from "fastify";
import { ObjectId, type Filter } from "mongodb";
import { Type } from "typebox";
import { Errors, ObjectIdString, Strict } from "../../contracts/common.js";
import { actorOf, diffOf, writeAudit } from "../../platform/audit.js";
import { requireAuth, requireRuxstar } from "../../platform/auth.js";
import { requireDatabase } from "../../platform/context.js";
import { stamp, type Database, type GstModule, type GstRules, type GstSeller, type InvoiceDoc } from "../../platform/db.js";
import { ok, page } from "../../platform/envelope.js";
import { AppError } from "../../platform/errors.js";
import { idempotent } from "../../platform/idempotency.js";
import { findPage } from "../../platform/pagination.js";
import { signingKey } from "../pod/orders.js";
import { requireVendor } from "../vendor/businesses.js";
import { POD_PRODUCTS } from "../vendor/catalog.js";
import { COURSE_CATEGORIES } from "../coaching/rules.js";
import { INDIAN_STATES } from "../vendor/india.js";
import {
  GstModuleOne,
  GstModuleParams,
  GstModulePatch,
  GstSellerOne,
  GstSellerPatch,
  GstSettingsOne,
  InvoiceExportQuery,
  InvoiceList,
  InvoiceOne,
  InvoiceParams,
  MyInvoicesQuery,
  StaffInvoicesQuery,
  VendorInvoicesQuery,
  type GstModuleSettings,
  type GstSellerSettings,
} from "./contracts.js";
import { GST_MODULES, gstRules, gstSeller, moduleKey, SELLER_KEY, stateOfGstin } from "./gst.js";
import { invoicePdf } from "./pdf.js";
import { invoiceLinkValid, invoicePdfLinks, invoiceView } from "./views.js";

const security: Record<string, string[]>[] = [{ bearer: [] }, { cookie: [] }];
const PdfResponse = {
  200: { description: "The PDF", content: { "application/pdf": { schema: Type.String({ format: "binary" }) } } },
  ...Errors,
};
const invalid = (path: string, message: string) => new AppError("VALIDATION_FAILED", message, [{ path, message }]);

async function sendPdf(reply: FastifyReply, doc: InvoiceDoc, download = false) {
  const data = await invoicePdf(doc);
  const name = `${doc.number.replace(/\//g, "-")}.pdf`;
  return reply
    .headers({ "Content-Type": "application/pdf", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" })
    .header("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${name}"`)
    .send(data);
}

async function findOne(db: Database, filter: Filter<InvoiceDoc>): Promise<InvoiceDoc> {
  const doc = await db.invoices.findOne(filter);
  if (!doc) throw new AppError("NOT_FOUND", "Invoice not found.");
  return doc;
}

/** A customer's GST invoices and credit notes, at every business. Mounted under /v1/account. */
export const customerInvoices: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const mine = (userId: ObjectId, id: string) => findOne(db(), { _id: new ObjectId(id), customerId: userId });

  app.get(
    "/invoices",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["account"],
        summary: "Your GST invoices and credit notes, newest first",
        description: "Every paid order has one from the business (or Ruxstar), plus Ruxstar's for its platform fee when there was one. Refunds add credit notes.",
        querystring: MyInvoicesQuery,
        response: { 200: InvoiceList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { orderId, cursor, limit } = request.query;
      const filter: Filter<InvoiceDoc> = { customerId: request.auth!.userId, ...(orderId ? { "source.id": new ObjectId(orderId) } : {}) };
      const { items, nextCursor } = await findPage(db().invoices, { filter, sortField: "issuedAt", cursor, limit });
      const links = invoicePdfLinks(app, request);
      return page(request, items.map((d) => invoiceView(d, links, "customer")), nextCursor);
    },
  );

  app.get(
    "/invoices/:id",
    {
      preHandler: requireAuth,
      schema: { tags: ["account"], summary: "One of your invoices or credit notes", params: InvoiceParams, response: { 200: InvoiceOne, ...Errors }, security },
    },
    async (request) => ok(request, invoiceView(await mine(request.auth!.userId, request.params.id), invoicePdfLinks(app, request), "customer")),
  );

  app.get(
    "/invoices/:id/pdf",
    {
      preHandler: requireAuth,
      schema: { tags: ["account"], summary: "One of your invoices or credit notes as a PDF", params: InvoiceParams, response: PdfResponse, security },
    },
    async (request, reply) => sendPdf(reply, await mine(request.auth!.userId, request.params.id)),
  );
};

const csvCell = (value: string | number | null) => {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  // A leading = + - or @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const rupeesCell = (paise: number) => (paise / 100).toFixed(2);
const EXPORT_LIMIT = 5_000;
const DAY_MS = 24 * 60 * 60_000;

/** GST documents for a vendor's sales. Mounted under /v1/vendor. */
export const vendorInvoices: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const theirs = (vendorId: ObjectId, id: string) => findOne(db(), { _id: new ObjectId(id), vendorId, role: "supply" });

  app.get(
    "/invoices",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "GST invoices, bills of supply and credit notes for your sales, newest first",
        description: "Ruxstar issues them in your business's name when an order is paid, and a credit note for every refund. Ruxstar's platform fee invoices aren't included.",
        querystring: VendorInvoicesQuery,
        response: { 200: InvoiceList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { business, kind, cursor, limit } = request.query;
      const filter: Filter<InvoiceDoc> = {
        vendorId: request.auth!.userId,
        role: "supply",
        ...(business ? { businessId: new ObjectId(business) } : {}),
        ...(kind ? { kind } : {}),
      };
      const { items, nextCursor } = await findPage(db().invoices, { filter, sortField: "issuedAt", cursor, limit });
      const links = invoicePdfLinks(app, request);
      return page(request, items.map((d) => invoiceView(d, links, "vendor")), nextCursor);
    },
  );

  app.get(
    "/invoices/export",
    {
      preHandler: requireVendor,
      schema: {
        tags: ["vendor"],
        summary: "Your GST documents for a period as a spreadsheet (CSV)",
        description: "One row per line, for your GST returns. Up to a year and 5,000 documents at a time; amounts in rupees.",
        querystring: InvoiceExportQuery,
        response: { 200: { description: "CSV", content: { "text/csv": { schema: Type.String() } } }, ...Errors },
        security,
      },
    },
    async (request, reply) => {
      const { from, to, business } = request.query;
      const start = new Date(`${from}T00:00:00+05:30`);
      const end = new Date(new Date(`${to}T00:00:00+05:30`).getTime() + DAY_MS);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw invalid("querystring/from", "Use dates like 2026-04-01.");
      if (end <= start) throw invalid("querystring/to", "The end date is before the start date.");
      if (end.getTime() - start.getTime() > 366 * DAY_MS) throw invalid("querystring/to", "Pick up to a year at a time.");
      const docs = await db()
        .invoices.find({
          vendorId: request.auth!.userId,
          role: "supply",
          ...(business ? { businessId: new ObjectId(business) } : {}),
          issuedAt: { $gte: start, $lt: end },
        })
        .sort({ issuedAt: 1, _id: 1 })
        .limit(EXPORT_LIMIT + 1)
        .toArray();
      if (docs.length > EXPORT_LIMIT) throw invalid("querystring/to", "That's more than 5,000 documents. Pick a shorter period.");
      const header = [
        "Number", "Date", "Type", "Against", "Business", "Order", "Customer", "Place of supply", "Supply", "HSN/SAC",
        "Description", "Quantity", "GST %", "Taxable", "CGST", "SGST", "IGST", "Total", "TCS",
      ];
      const rows = docs.flatMap((d) =>
        d.lines.map((l, i) => [
          d.number,
          d.issuedAt.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
          d.kind,
          d.against?.number ?? null,
          d.businessName,
          d.source.orderNo,
          d.buyer.name,
          d.placeOfSupply?.state ?? null,
          d.supply,
          l.code,
          l.description,
          l.quantity,
          l.rateBps / 100,
          rupeesCell(l.taxable),
          rupeesCell(l.cgst),
          rupeesCell(l.sgst),
          rupeesCell(l.igst),
          rupeesCell(l.total),
          i === 0 && d.tcs ? rupeesCell(d.tcs.amount) : null,
        ]),
      );
      const csv = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
      return reply
        .headers({ "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "private, no-store" })
        .header("Content-Disposition", `attachment; filename="ruxstar-gst-${from}-to-${to}.csv"`)
        .send(`\ufeff${csv}\r\n`);
    },
  );

  app.get(
    "/invoices/:id",
    {
      preHandler: requireVendor,
      schema: { tags: ["vendor"], summary: "One GST document for your sales", params: InvoiceParams, response: { 200: InvoiceOne, ...Errors }, security },
    },
    async (request) => ok(request, invoiceView(await theirs(request.auth!.userId, request.params.id), invoicePdfLinks(app, request), "vendor")),
  );

  app.get(
    "/invoices/:id/pdf",
    {
      preHandler: requireVendor,
      schema: { tags: ["vendor"], summary: "One GST document for your sales as a PDF", params: InvoiceParams, response: PdfResponse, security },
    },
    async (request, reply) => sendPdf(reply, await theirs(request.auth!.userId, request.params.id)),
  );
};

/** Keys an item rate can use in each module. Modules not listed take any. */
const ITEM_KEYS: Partial<Record<GstModule, readonly string[]>> = {
  pod: POD_PRODUCTS,
  events: ["show", "sports", "meetup"],
  coaching: COURSE_CATEGORIES,
  stays: ["pg", "hostel"],
};

const moduleView = (module: GstModule, { updatedAt, ...rules }: GstRules & { updatedAt: Date | null }): GstModuleSettings => ({
  module,
  ...rules,
  updatedAt: updatedAt?.toISOString() ?? null,
});
const sellerView = ({ updatedAt, ...seller }: GstSeller & { updatedAt: Date | null }): GstSellerSettings => ({ ...seller, updatedAt: updatedAt?.toISOString() ?? null });

/** Saves only what the admin changed, so the defaults keep applying to the rest. */
async function saveSetting(db: Database, key: string, changes: object, userId: ObjectId, audit: Parameters<typeof writeAudit>[1]) {
  const now = new Date();
  await db.transaction(async (session) => {
    const stored = await db.platformSettings.findOne({ key }, { session });
    await db.platformSettings.updateOne(
      { key },
      {
        $set: { value: { ...(stored?.value as object | undefined), ...changes }, updatedBy: userId, updatedAt: now },
        $setOnInsert: { _id: new ObjectId(), key, createdAt: now, schemaVersion: stamp(now).schemaVersion },
      },
      { upsert: true, session },
    );
    await writeAudit(db, audit, session);
  });
}

/** Every GST document, and the GST settings, in the console. Mounted under /v1/ruxstar. */
export const consoleInvoices: FastifyPluginAsyncTypebox = async (app) => {
  const db = () => requireDatabase(app.db);
  const one = (id: string) => findOne(db(), { _id: new ObjectId(id) });

  app.get(
    "/invoices",
    {
      preHandler: requireRuxstar("orders.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "Every GST invoice, bill of supply and credit note, newest first",
        querystring: StaffInvoicesQuery,
        response: { 200: InvoiceList, ...Errors },
        security,
      },
    },
    async (request) => {
      const { kind, number, orderNo, business, cursor, limit } = request.query;
      const filter: Filter<InvoiceDoc> = {
        ...(kind ? { kind } : {}),
        ...(number ? { number: number.trim().toUpperCase() } : {}),
        ...(orderNo ? { "source.orderNo": orderNo } : {}),
        ...(business ? { businessId: new ObjectId(business) } : {}),
      };
      const { items, nextCursor } = await findPage(db().invoices, { filter, sortField: "issuedAt", cursor, limit });
      const links = invoicePdfLinks(app, request);
      return page(request, items.map((d) => invoiceView(d, links, "staff")), nextCursor);
    },
  );

  app.get(
    "/invoices/:id",
    {
      preHandler: requireRuxstar("orders.view"),
      schema: { tags: ["ruxstar"], summary: "One GST document", params: InvoiceParams, response: { 200: InvoiceOne, ...Errors }, security },
    },
    async (request) => ok(request, invoiceView(await one(request.params.id), invoicePdfLinks(app, request), "staff")),
  );

  app.get(
    "/invoices/:id/pdf",
    {
      preHandler: requireRuxstar("orders.view"),
      schema: { tags: ["ruxstar"], summary: "One GST document as a PDF", params: InvoiceParams, response: PdfResponse, security },
    },
    async (request, reply) => sendPdf(reply, await one(request.params.id)),
  );

  app.get(
    "/gst",
    {
      preHandler: requireRuxstar("modules.view"),
      schema: {
        tags: ["ruxstar"],
        summary: "GST settings: Ruxstar's own details and each module's rules",
        description: "Changes apply to documents issued from then on; documents already issued never change.",
        response: { 200: GstSettingsOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const modules = await Promise.all(GST_MODULES.map(async (m) => moduleView(m, await gstRules(database, m))));
      return ok(request, { seller: sellerView(await gstSeller(database)), modules });
    },
  );

  app.patch(
    "/gst/modules/:module",
    {
      preHandler: [requireRuxstar("modules.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Change one module's GST rules",
        description: "Send only what changes. `items` replaces the whole list. Applies to orders paid from now on.",
        params: GstModuleParams,
        body: GstModulePatch,
        response: { 200: GstModuleOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const { module } = request.params;
      const changes = request.body;
      if (changes.pricesIncludeTax === false) {
        throw invalid("body/pricesIncludeTax", "Adding GST on top of prices at checkout isn't available yet, so prices always include GST.");
      }
      if (changes.items) {
        const keys = changes.items.map((i) => i.key);
        const dupe = keys.find((k, i) => keys.indexOf(k) !== i);
        if (dupe) throw invalid("body/items", `${dupe} is listed twice.`);
        const allowed = ITEM_KEYS[module];
        const unknown = allowed && keys.find((k) => !allowed.includes(k));
        if (unknown) throw invalid("body/items", `${unknown} isn't a product or kind in this module.`);
      }
      const { updatedAt: _, ...before } = await gstRules(database, module);
      const diff = diffOf(before, changes);
      if (Object.keys(diff).length) {
        await saveSetting(database, moduleKey(module), changes, request.auth!.userId, {
          actor: actorOf(request),
          scope: { module },
          action: "gst.module_update",
          target: { type: "platform_setting", id: moduleKey(module) },
          diff,
          ip: request.ip,
        });
      }
      return ok(request, moduleView(module, await gstRules(database, module)));
    },
  );

  app.patch(
    "/gst/seller",
    {
      preHandler: [requireRuxstar("modules.manage"), idempotent],
      schema: {
        tags: ["ruxstar"],
        summary: "Change Ruxstar's own GST details",
        description: "Send only what changes; null clears the GSTIN or address. Without a GSTIN, Ruxstar's documents are bills of supply.",
        body: GstSellerPatch,
        response: { 200: GstSellerOne, ...Errors },
        security,
      },
    },
    async (request) => {
      const database = db();
      const changes = { ...request.body, ...(request.body.gstin ? { gstin: request.body.gstin.toUpperCase() } : {}) };
      const { updatedAt: _, ...before } = await gstSeller(database);
      const address = changes.address === undefined ? before.address : changes.address;
      const gstin = changes.gstin === undefined ? before.gstin : changes.gstin;
      if (address) {
        const state = INDIAN_STATES.find((s) => s.toLowerCase() === address.state.trim().toLowerCase());
        if (!state) throw invalid("body/address/state", "Pick a state from the list.");
        if (changes.address) changes.address = { ...changes.address, state };
        const registered = stateOfGstin(gstin);
        if (registered && registered !== state) throw invalid("body/address/state", `The GSTIN is registered in ${registered}, but the address is in ${state}.`);
      }
      const diff = diffOf(before, changes);
      if (Object.keys(diff).length) {
        await saveSetting(database, SELLER_KEY, changes, request.auth!.userId, {
          actor: actorOf(request),
          scope: { module: "ledger" },
          action: "gst.seller_update",
          target: { type: "platform_setting", id: SELLER_KEY },
          diff,
          ip: request.ip,
        });
      }
      return ok(request, sellerView(await gstSeller(database)));
    },
  );
};

/** A document's PDF from a signed link in an invoice view. Outside /v1: a browser opening a link sends no X-Client header. */
export const invoiceFiles: FastifyPluginAsyncTypebox = async (app) => {
  const key = signingKey(app);
  app.get(
    "/invoice-files/:id",
    {
      schema: {
        hide: true,
        params: Strict({ id: ObjectIdString }),
        querystring: Strict({ exp: Type.Integer(), t: Type.String({ maxLength: 100 }), download: Type.Optional(Type.Literal("1")) }),
      },
      config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!invoiceLinkValid(key, id, request.query.exp, request.query.t)) throw new AppError("UNAUTHENTICATED", "This link has expired. Open the invoice again.");
      return sendPdf(reply, await findOne(requireDatabase(app.db), { _id: new ObjectId(id) }), Boolean(request.query.download));
    },
  );
};
