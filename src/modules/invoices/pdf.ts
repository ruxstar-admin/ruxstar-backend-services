import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import type { InvoiceDoc, InvoiceParty } from "../../platform/db.js";

const TITLE: Record<InvoiceDoc["kind"], string> = { tax_invoice: "Tax invoice", bill_of_supply: "Bill of supply", credit_note: "Credit note" };
const A4: [number, number] = [595.28, 841.89];
const MARGIN = 40;
const GREY = rgb(0.4, 0.4, 0.4);

/** The standard PDF fonts only cover Latin-1, so anything else is spelt out or replaced. */
const plain = (text: string) => text.replace(/₹/g, "Rs. ").replace(/[–—]/g, "-").replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
const money = (paise: number) => (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percent = (bps: number) => `${(bps / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
const day = (at: Date) => at.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

/** Breaks text into lines that fit `width`. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of plain(text).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** A GST invoice, bill of supply or credit note as an A4 PDF. */
export async function invoicePdf(doc: InvoiceDoc): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${TITLE[doc.kind]} ${doc.number}`);
  pdf.setProducer("Ruxstar");
  pdf.setCreationDate(doc.issuedAt);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage = pdf.addPage(A4);
  let y = A4[1] - MARGIN;

  const room = (height: number) => {
    if (y - height >= MARGIN) return;
    page = pdf.addPage(A4);
    y = A4[1] - MARGIN;
  };
  const text = (value: string, x: number, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; right?: number } = {}) => {
    const size = opts.size ?? 9;
    const f = opts.bold ? bold : font;
    const shown = plain(value);
    const at = opts.right !== undefined ? opts.right - f.widthOfTextAtSize(shown, size) : x;
    page.drawText(shown, { x: at, y, size, font: f, color: opts.color ?? rgb(0, 0, 0) });
  };
  const rule = () => page.drawLine({ start: { x: MARGIN, y: y + 4 }, end: { x: A4[0] - MARGIN, y: y + 4 }, thickness: 0.5, color: GREY });

  text(TITLE[doc.kind].toUpperCase(), MARGIN, { size: 16, bold: true });
  text(doc.number, 0, { size: 12, bold: true, right: A4[0] - MARGIN });
  y -= 16;
  text(`Date: ${day(doc.issuedAt)}`, 0, { right: A4[0] - MARGIN });
  text(`Order #${doc.source.orderNo}`, MARGIN, { color: GREY });
  y -= 12;
  if (doc.against) {
    text(`Against invoice ${doc.against.number} of ${day(doc.against.issuedAt)}`, MARGIN, { color: GREY });
    y -= 12;
  }
  y -= 8;

  const block = (heading: string, p: InvoiceParty, x: number, width: number) => {
    let at = y;
    const put = (value: string, opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}) => {
      for (const line of wrap(value, opts.bold ? bold : font, 9, width)) {
        page.drawText(line, { x, y: at, size: 9, font: opts.bold ? bold : font, color: opts.color ?? rgb(0, 0, 0) });
        at -= 12;
      }
    };
    put(heading, { color: GREY });
    put(p.name, { bold: true });
    if (p.legalName && p.legalName !== p.name) put(p.legalName);
    if (p.address) put(p.address);
    if (p.state) put(`State: ${p.state}${p.stateCode ? ` (${p.stateCode})` : ""}`);
    if (p.gstin) put(`GSTIN: ${p.gstin}`);
    return at;
  };
  const half = (A4[0] - 2 * MARGIN - 20) / 2;
  const left = block(doc.kind === "credit_note" ? "Issued by" : "Sold by", doc.seller, MARGIN, half);
  const right = block("Bill to", doc.buyer, MARGIN + half + 20, half);
  y = Math.min(left, right) - 6;

  const facts = [
    doc.placeOfSupply ? `Place of supply: ${doc.placeOfSupply.state} (${doc.placeOfSupply.code})` : null,
    doc.kind === "bill_of_supply" ? null : "Tax payable on reverse charge: No",
    doc.operator ? `E-commerce operator: ${doc.operator.name}${doc.operator.gstin ? `, GSTIN ${doc.operator.gstin}` : ""}` : null,
  ].filter((f): f is string => !!f);
  for (const fact of facts) {
    text(fact, MARGIN);
    y -= 12;
  }
  y -= 10;

  const taxed = doc.kind !== "bill_of_supply" && doc.lines.some((l) => l.rateBps > 0);
  const intra = doc.supply === "intra";
  // Right edges of the number columns, after the description.
  const end = A4[0] - MARGIN;
  const cols: [label: string, rightEdge: number][] = taxed
    ? intra
      ? [["HSN/SAC", 300], ["Qty", 330], ["Taxable", 390], ["GST", 420], ["CGST", 465], ["SGST", 510], ["Total", end]]
      : [["HSN/SAC", 300], ["Qty", 335], ["Taxable", 405], ["GST", 440], ["IGST", 490], ["Total", end]]
    : [["HSN/SAC", 340], ["Qty", 390], ["Rate", 460], ["Amount", end]];
  const descWidth = cols[0]![1] - MARGIN - 50;
  const header = () => {
    room(30);
    text("Description", MARGIN, { bold: true, size: 8 });
    for (const [label, edge] of cols) text(label, 0, { bold: true, size: 8, right: edge });
    y -= 6;
    rule();
    y -= 10;
  };
  header();
  for (const line of doc.lines) {
    const desc = wrap(line.description + (line.discount > 0 ? ` (less ${money(line.discount)} discount)` : ""), font, 8, descWidth);
    room(desc.length * 10 + 6);
    const values = taxed
      ? [line.code || "-", String(line.quantity), money(line.taxable), percent(line.rateBps), ...(intra ? [money(line.cgst), money(line.sgst)] : [money(line.igst)]), money(line.total)]
      : [line.code || "-", String(line.quantity), money(line.unitPrice), money(line.total)];
    values.forEach((v, i) => text(v, 0, { size: 8, right: cols[i]![1] }));
    for (const part of desc) {
      text(part, MARGIN, { size: 8 });
      y -= 10;
    }
    y -= 4;
  }
  rule();
  y -= 10;

  const totals: [string, number][] = [
    ...(taxed
      ? ([
          ["Taxable value", doc.totals.taxable],
          ...(intra ? ([["CGST", doc.totals.cgst], ["SGST", doc.totals.sgst]] as [string, number][]) : ([["IGST", doc.totals.igst]] as [string, number][])),
        ] as [string, number][])
      : []),
    [doc.kind === "credit_note" ? "Total credited" : "Total", doc.totals.total],
    ...(doc.totals.ruxstarDiscount > 0 ? ([["Ruxstar discount", -doc.totals.ruxstarDiscount], ["Paid by the customer", doc.totals.payable]] as [string, number][]) : []),
  ];
  room(totals.length * 13 + 10);
  for (const [label, value] of totals) {
    const strong = label.startsWith("Total") || label.startsWith("Paid");
    text(label, 0, { right: 470, bold: strong });
    text(`Rs. ${money(value)}`, 0, { right: end, bold: strong });
    y -= 13;
  }
  y -= 10;

  const footer = `Amounts in Indian rupees${taxed ? ", GST included" : ""}. Computer-generated; no signature needed.`;
  for (const note of [...doc.notes, ...(doc.refund?.reason ? [`Reason: ${doc.refund.reason}`] : []), footer]) {
    for (const line of wrap(note, font, 8, A4[0] - 2 * MARGIN)) {
      room(10);
      text(line, MARGIN, { size: 8, color: GREY });
      y -= 10;
    }
  }
  return Buffer.from(await pdf.save());
}
