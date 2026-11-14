import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import type { CoachingCertificateDoc } from "../../platform/db.js";

const plain = (text: string) => text.replace(/[–—]/g, "-").replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
const LANDSCAPE_A4: [number, number] = [841.89, 595.28];

/** A one-page certificate of completion. */
export async function certificatePdf(doc: CoachingCertificateDoc): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(plain(`Certificate - ${doc.courseTitle}`));
  pdf.setProducer("Ruxstar");
  const page = pdf.addPage(LANDSCAPE_A4);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const [width, height] = LANDSCAPE_A4;
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.4, 0.4, 0.45);

  page.drawRectangle({ x: 24, y: 24, width: width - 48, height: height - 48, borderColor: rgb(0.85, 0.55, 0.1), borderWidth: 3 });
  const centred = (text: string, y: number, size: number, f = font, color = ink) => {
    let shown = plain(text);
    while (shown.length > 3 && f.widthOfTextAtSize(shown, size) > width - 120) shown = `${shown.slice(0, -4)}...`;
    page.drawText(shown, { x: (width - f.widthOfTextAtSize(shown, size)) / 2, y, size, font: f, color });
  };
  const issued = doc.issuedAt.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

  centred("CERTIFICATE OF COMPLETION", height - 120, 28, bold);
  centred("This is to certify that", height - 180, 14, font, muted);
  centred(doc.studentName, height - 230, 34, bold);
  centred(`completed ${doc.courseTitle}`, height - 280, 18);
  centred(`${doc.batchName}, with ${doc.businessName}`, height - 308, 14, font, muted);
  centred(`Attended ${doc.attended} of ${doc.classes} classes`, height - 350, 12, font, muted);
  page.drawText(plain(`Issued ${issued}`), { x: 70, y: 70, size: 11, font, color: muted });
  const code = `Certificate code ${doc.code}`;
  page.drawText(code, { x: width - 70 - font.widthOfTextAtSize(code, 11), y: 70, size: 11, font, color: muted });
  centred("Issued through Ruxstar", 46, 9, font, muted);
  return Buffer.from(await pdf.save());
}
