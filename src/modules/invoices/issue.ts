import { ObjectId, type ClientSession } from "mongodb";
import type {
  BusinessDoc,
  Database,
  EventOrderDoc,
  GstModule,
  GstRules,
  GstSeller,
  InvoiceDoc,
  InvoiceKind,
  InvoiceLineDoc,
  InvoiceParty,
  InvoiceRefDoc,
  PodOrderDoc,
} from "../../platform/db.js";
import { stamp } from "../../platform/db.js";
import { bpsAt, financialYear, gstRules, gstSeller, nextInvoiceNumber, rateFor, STATE_CODES, stateOfGstin, stateOfPlace, taxOf } from "./gst.js";

type Issuer = InvoiceDoc["issuer"];
type SourceType = InvoiceDoc["source"]["type"];

const PREFIX: Record<Issuer, Record<InvoiceKind, string>> = {
  vendor: { tax_invoice: "INV", bill_of_supply: "BOS", credit_note: "CN" },
  ruxstar: { tax_invoice: "RXI", bill_of_supply: "RXB", credit_note: "RXC" },
};

/** A line before tax: `value` is what was charged for it, tax included. */
interface DraftLine {
  description: string;
  code: string;
  codeKind: "hsn" | "sac";
  quantity: number;
  unitPrice: number;
  discount: number;
  value: number;
  rateBps: number;
}

interface Context {
  module: GstModule;
  source: InvoiceDoc["source"];
  business: BusinessDoc | null;
  businessId: ObjectId;
  businessName: string;
  vendorId: ObjectId;
  customerId: ObjectId;
  buyer: InvoiceParty;
  /** Where the goods or service are supplied; null for the seller's own state. */
  supplyState: string | null;
  /** Where Ruxstar's fee is supplied: the buyer's state when known. */
  feeState: string | null;
  lines: (rules: GstRules) => DraftLine[];
  platformFee: number;
  /** A Ruxstar coupon: the customer paid this much less and Ruxstar paid it to the seller. */
  ruxstarDiscount: number;
}

const party = (p: Omit<InvoiceParty, "stateCode">): InvoiceParty => ({ ...p, stateCode: p.state ? (STATE_CODES[p.state] ?? null) : null });

function addressOf(location: BusinessDoc["location"]): string | null {
  if (!location) return null;
  const parts = [location.doorNo, location.building, location.street, location.area, location.city].filter(Boolean);
  return `${parts.join(", ")}${location.pincode ? ` ${location.pincode}` : ""}, ${location.state}`;
}

function vendorParty(business: BusinessDoc | null, name: string): InvoiceParty {
  const gstin = business?.gstin?.number ?? null;
  return party({
    name,
    legalName: business?.gstin?.legalName ?? null,
    gstin,
    address: addressOf(business?.location ?? null),
    state: stateOfGstin(gstin) ?? business?.location?.state ?? null,
  });
}

function ruxstarParty(seller: GstSeller): InvoiceParty {
  const a = seller.address;
  return party({
    name: seller.tradeName,
    legalName: seller.legalName,
    gstin: seller.gstin,
    address: a ? `${a.line}, ${a.city} ${a.pincode}, ${a.state}` : null,
    state: stateOfGstin(seller.gstin) ?? a?.state ?? null,
  });
}

/** In the seller's own state, or when either side's state isn't known: CGST and SGST. Across states: IGST. */
function supplyOf(seller: InvoiceParty, state: string | null) {
  const place = state ?? seller.state;
  const code = place ? (STATE_CODES[place] ?? null) : null;
  return {
    placeOfSupply: place && code ? { state: place, code } : null,
    supply: seller.stateCode && code && seller.stateCode !== code ? ("inter" as const) : ("intra" as const),
  };
}

function taxedLines(drafts: DraftLine[], kind: InvoiceKind, supply: "intra" | "inter"): InvoiceLineDoc[] {
  return drafts.map(({ value, ...line }) => {
    const rateBps = kind === "bill_of_supply" ? 0 : line.rateBps;
    return { ...line, rateBps, ...taxOf(value, rateBps, supply) };
  });
}

function totalsOf(lines: InvoiceLineDoc[], ruxstarDiscount: number): InvoiceDoc["totals"] {
  const sum = (field: "taxable" | "cgst" | "sgst" | "igst" | "total") => lines.reduce((s, l) => s + l[field], 0);
  const total = sum("total");
  return {
    taxable: sum("taxable"),
    cgst: sum("cgst"),
    sgst: sum("sgst"),
    igst: sum("igst"),
    tax: sum("cgst") + sum("sgst") + sum("igst"),
    total,
    ruxstarDiscount,
    payable: total - ruxstarDiscount,
  };
}

const refOf = (doc: InvoiceDoc): InvoiceRefDoc => ({
  id: doc._id,
  kind: doc.kind,
  number: doc.number,
  issuer: doc.issuer,
  role: doc.role,
  total: doc.totals.total,
  refundId: doc.refund?.id ?? null,
  issuedAt: doc.issuedAt,
});

async function number(db: Database, issuer: Issuer, kind: InvoiceKind, businessId: ObjectId, at: Date, session: ClientSession) {
  const fy = financialYear(at);
  const prefix = PREFIX[issuer][kind];
  const series = `invoice:${issuer === "vendor" ? `business:${businessId.toHexString()}` : "ruxstar"}:${prefix}:${fy}`;
  return { fy, series, number: await nextInvoiceNumber(db, series, prefix, fy, session) };
}

async function remember(db: Database, type: SourceType, id: ObjectId, refs: InvoiceRefDoc[], session: ClientSession) {
  if (!refs.length) return;
  const update = { $push: { invoices: { $each: refs } } };
  if (type === "pod_order") await db.podOrders.updateOne({ _id: id }, update, { session });
  else await db.eventOrders.updateOne({ _id: id }, update, { session });
}

/**
 * Issues an order's GST documents when it is paid: the sale, from the vendor (a tax invoice with a GSTIN, a bill of supply
 * without) or from Ruxstar where the module's rules say so, and Ruxstar's own invoice for its platform fee. Runs inside the
 * payment's transaction, so a paid order always has them and the numbers have no gaps.
 */
async function issue(db: Database, ctx: Context, session: ClientSession): Promise<InvoiceRefDoc[]> {
  const rules = await gstRules(db, ctx.module, session);
  if (!rules.enabled) return [];
  const ruxstar = await gstSeller(db, session);
  const ruxstarSeller = ruxstarParty(ruxstar);
  const now = new Date();
  const docs: InvoiceDoc[] = [];
  const base = {
    module: ctx.module,
    source: ctx.source,
    businessId: ctx.businessId,
    businessName: ctx.businessName,
    vendorId: ctx.vendorId,
    customerId: ctx.customerId,
    buyer: ctx.buyer,
    against: null,
    refund: null,
    credited: 0,
    issuedAt: now,
    ...stamp(now),
  };

  const drafts = ctx.lines(rules).filter((l) => l.value > 0);
  if (drafts.length) {
    const registered = Boolean(ctx.business?.gstin);
    const byRuxstar = rules.seller === "ruxstar" || (!registered && rules.withoutGstin === "ruxstar");
    const issuer: Issuer = byRuxstar ? "ruxstar" : "vendor";
    const seller = byRuxstar ? ruxstarSeller : vendorParty(ctx.business, ctx.businessName);
    // Exempt supplies, such as cheap event tickets, take a bill of supply even from a registered seller.
    const taxed = drafts.some((l) => l.rateBps > 0);
    const kind: InvoiceKind = (byRuxstar ? ruxstar.gstin : registered) && taxed ? "tax_invoice" : "bill_of_supply";
    const { placeOfSupply, supply } = supplyOf(seller, ctx.supplyState);
    const lines = taxedLines(drafts, kind, supply);
    const totals = totalsOf(lines, ctx.ruxstarDiscount);
    const operatorPays = byRuxstar && rules.seller === "vendor";
    const notes = [
      byRuxstar ? `Sold on Ruxstar by ${ctx.businessName}.` : `Sold through Ruxstar${ruxstar.gstin ? ` (GSTIN ${ruxstar.gstin})` : ""}, the e-commerce operator.`,
      ...(operatorPays && kind === "tax_invoice" ? ["GST on this sale is paid by Ruxstar as the e-commerce operator under section 9(5) of the CGST Act."] : []),
      ...(kind === "bill_of_supply" ? ["Bill of supply: no GST is charged on it."] : []),
      ...(ctx.ruxstarDiscount > 0 ? ["The Ruxstar discount was paid to the seller by Ruxstar."] : []),
    ];
    docs.push({
      _id: new ObjectId(),
      key: `${ctx.source.type}:${ctx.source.id.toHexString()}:supply`,
      kind,
      ...(await number(db, issuer, kind, ctx.businessId, now, session)),
      issuer,
      role: "supply",
      seller,
      operator: byRuxstar ? null : { name: ruxstar.legalName, gstin: ruxstar.gstin },
      placeOfSupply,
      supply,
      operatorPays,
      lines,
      totals,
      tcs: issuer === "vendor" && kind === "tax_invoice" && rules.tcsBps > 0 ? { rateBps: rules.tcsBps, amount: Math.round((totals.taxable * rules.tcsBps) / 10_000) } : null,
      notes,
      ...base,
    });
  }

  if (ctx.platformFee > 0) {
    const kind: InvoiceKind = ruxstar.gstin && ruxstar.feeRateBps > 0 ? "tax_invoice" : "bill_of_supply";
    const { placeOfSupply, supply } = supplyOf(ruxstarSeller, ctx.feeState);
    const fee: DraftLine = {
      description: `Ruxstar platform fee, order #${ctx.source.orderNo}`,
      code: ruxstar.feeCode,
      codeKind: "sac",
      quantity: 1,
      unitPrice: ctx.platformFee,
      discount: 0,
      value: ctx.platformFee,
      rateBps: ruxstar.feeRateBps,
    };
    const lines = taxedLines([fee], kind, supply);
    docs.push({
      _id: new ObjectId(),
      key: `${ctx.source.type}:${ctx.source.id.toHexString()}:fee`,
      kind,
      ...(await number(db, "ruxstar", kind, ctx.businessId, now, session)),
      issuer: "ruxstar",
      role: "fee",
      seller: ruxstarSeller,
      operator: null,
      placeOfSupply,
      supply,
      operatorPays: false,
      lines,
      totals: totalsOf(lines, 0),
      tcs: null,
      notes: kind === "bill_of_supply" ? ["Bill of supply: no GST is charged on it."] : [],
      ...base,
    });
  }

  // One at a time: the driver refuses insertMany inside a transaction with a timeout.
  for (const doc of docs) await db.invoices.insertOne(doc, { session });
  const refs = docs.map(refOf);
  await remember(db, ctx.source.type, ctx.source.id, refs, session);
  return refs;
}

export async function invoicePodOrder(db: Database, order: PodOrderDoc, session: ClientSession): Promise<InvoiceRefDoc[]> {
  const business = await db.businesses.findOne({ _id: order.shopId }, { session });
  const { price } = order;
  const discount = price.discount ?? 0;
  const vendorDiscount = price.coupon?.fundedBy === "vendor" ? discount : 0;
  const state = stateOfPlace(order.address.city, order.address.pincode);
  const options = Object.values(order.options);
  return issue(
    db,
    {
      module: "pod",
      source: { type: "pod_order", id: order._id, orderNo: order.orderNo },
      business,
      businessId: order.shopId,
      businessName: business?.name ?? order.shopName,
      vendorId: order.vendorId,
      customerId: order.customerId,
      buyer: party({ name: order.address.name, legalName: null, gstin: null, address: `${order.address.line}, ${order.address.city} ${order.address.pincode}`, state }),
      supplyState: state,
      feeState: state,
      lines: (rules) => {
        const rate = rateFor(rules, order.product);
        const unitPrice = price.unitPrice + price.extrasPerUnit;
        const rateBps = bpsAt(rate, unitPrice);
        const product: DraftLine = {
          description: [order.productLabel, ...options].join(", "),
          code: rate.code,
          codeKind: rate.codeKind,
          quantity: price.units,
          unitPrice,
          discount: vendorDiscount,
          value: price.items - vendorDiscount,
          rateBps,
        };
        // Delivery is part of the same supply, so it takes the product's rate.
        const delivery = price.delivery ?? 0;
        return delivery > 0
          ? [product, { ...product, description: "Delivery", quantity: 1, unitPrice: delivery, discount: 0, value: delivery }]
          : [product];
      },
      platformFee: price.platformFee,
      ruxstarDiscount: price.coupon?.fundedBy === "ruxstar" ? discount : 0,
    },
    session,
  );
}

export async function invoiceEventOrder(db: Database, order: EventOrderDoc, session: ClientSession): Promise<InvoiceRefDoc[]> {
  // One at a time: a transaction's reads share its session.
  const business = await db.businesses.findOne({ _id: order.businessId }, { session });
  const event = await db.events.findOne({ _id: order.eventId }, { session, projection: { kind: 1, venue: 1, online: 1 } });
  const customer = await db.users.findOne({ _id: order.customerId }, { session, projection: { name: 1 } });
  const holder = customer?.name ? null : await db.eventTickets.findOne({ orderId: order._id }, { session, projection: { "holder.name": 1 } });
  // Admission to an event is supplied where it happens; an online one where the organiser is.
  const venueState = event?.venue ? (stateOfPlace(event.venue.city) ?? business?.location?.state ?? null) : null;
  return issue(
    db,
    {
      module: "events",
      source: { type: "event_order", id: order._id, orderNo: order.orderNo },
      business,
      businessId: order.businessId,
      businessName: business?.name ?? order.businessName,
      vendorId: order.vendorId,
      customerId: order.customerId,
      buyer: party({ name: customer?.name ?? holder?.holder.name ?? "Customer", legalName: null, gstin: null, address: null, state: null }),
      supplyState: venueState,
      feeState: null,
      lines: (rules) => {
        const rate = rateFor(rules, event?.kind ?? null);
        return order.lines.map((l) => ({
          description: `${order.eventTitle}: ${l.name}${order.team ? " (team entry)" : ""}`,
          code: rate.code,
          codeKind: rate.codeKind,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discount: 0,
          value: l.quantity * l.unitPrice,
          rateBps: bpsAt(rate, l.unitPrice),
        }));
      },
      platformFee: order.price.platformFee,
      ruxstarDiscount: 0,
    },
    session,
  );
}

/** Shares `amount` across lines by their totals; the last line takes what rounding leaves. */
function share(lines: InvoiceLineDoc[], amount: number): number[] {
  const whole = lines.reduce((s, l) => s + l.total, 0);
  let left = amount;
  return lines.map((l, i) => {
    const part = i === lines.length - 1 ? left : Math.min(left, Math.round((amount * l.total) / whole));
    left -= part;
    return part;
  });
}

/**
 * Issues credit notes for a refund, inside its transaction. `amount` null credits what is left of every document on the
 * order (a full refund); a number credits that much of the sale, as partial refunds come out of the vendor's share.
 */
export async function creditOrder(
  db: Database,
  type: SourceType,
  id: ObjectId,
  refund: { id: string; reason: string | null; amount: number | null },
  session: ClientSession,
): Promise<InvoiceRefDoc[]> {
  const invoices = await db.invoices.find({ "source.id": id, kind: { $ne: "credit_note" } }, { session }).sort({ issuedAt: 1, _id: 1 }).toArray();
  const now = new Date();
  const notes: InvoiceDoc[] = [];
  let left = refund.amount ?? Infinity;
  for (const invoice of invoices) {
    if (refund.amount !== null && invoice.role !== "supply") continue;
    const value = Math.min(left, invoice.totals.total - invoice.credited);
    if (value <= 0) continue;
    left -= value;
    const whole = invoice.credited === 0 && value === invoice.totals.total;
    const parts = share(invoice.lines, value);
    const lines = invoice.lines.flatMap((line, i): InvoiceLineDoc[] => {
      const part = whole ? line.total : parts[i]!;
      if (part <= 0) return [];
      const taxed = taxOf(part, line.rateBps, invoice.supply);
      return [whole ? { ...line, ...taxed } : { ...line, quantity: 1, unitPrice: part, discount: 0, ...taxed }];
    });
    const totals = totalsOf(lines, 0);
    notes.push({
      ...invoice,
      _id: new ObjectId(),
      key: `credit:${invoice._id.toHexString()}:${refund.id}`,
      kind: "credit_note",
      ...(await number(db, invoice.issuer, "credit_note", invoice.businessId, now, session)),
      lines,
      totals,
      tcs: invoice.tcs ? { rateBps: invoice.tcs.rateBps, amount: Math.round((totals.taxable * invoice.tcs.rateBps) / 10_000) } : null,
      against: { id: invoice._id, number: invoice.number, issuedAt: invoice.issuedAt },
      refund: { id: refund.id, reason: refund.reason },
      credited: 0,
      notes: [`Credit note for ${invoice.number}: money refunded to the customer.`],
      issuedAt: now,
      ...stamp(now),
    });
    await db.invoices.updateOne({ _id: invoice._id }, { $inc: { credited: value }, $set: { updatedAt: now } }, { session });
  }
  for (const doc of notes) await db.invoices.insertOne(doc, { session });
  const refs = notes.map(refOf);
  await remember(db, type, id, refs, session);
  return refs;
}
