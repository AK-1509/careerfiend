import PDFDocument from "pdfkit";
import { AlignmentType, Document, LevelFormat, Packer, Paragraph, TabStopType, TextRun } from "docx";
import JSZip from "jszip";
import type { Line } from "./resume";

/**
 * Rendering for résumé and cover-letter lines. PDF (pdfkit, standard
 * Helvetica) is the page-count authority; the DOCX mirrors it with Arial at
 * the same sizes and margins.
 */

const LETTER = { width: 612, height: 792 };
const MARGIN = 36; // 0.5 in

const STYLE: Record<Line["style"], { font: string; size: number; before: number; after: number }> = {
  name: { font: "Helvetica-Bold", size: 16, before: 0, after: 1 },
  headline: { font: "Helvetica-Oblique", size: 9.5, before: 0, after: 1 },
  contact: { font: "Helvetica", size: 8.5, before: 0, after: 4 },
  section: { font: "Helvetica-Bold", size: 10, before: 5, after: 2 },
  entryTitle: { font: "Helvetica-Bold", size: 9.5, before: 3, after: 0 },
  entryMeta: { font: "Helvetica-Oblique", size: 9, before: 0, after: 1 },
  bullet: { font: "Helvetica", size: 9, before: 0, after: 1 },
  list: { font: "Helvetica", size: 9, before: 0, after: 1 },
};

export interface PdfResult {
  buffer: Buffer;
  pages: number;
}

/** Characters pdfkit's standard fonts can encode (WinAnsi). */
export function unsupportedChars(text: string): string[] {
  const extra = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
  return [
    ...new Set(
      [...text].filter((c) => {
        const code = c.charCodeAt(0);
        return !(code === 10 || (code >= 32 && code <= 126) || (code >= 160 && code <= 255) || extra.has(c));
      }),
    ),
  ];
}

export function renderResumePdf(lines: Line[]): Promise<PdfResult> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [LETTER.width, LETTER.height], margin: MARGIN, bufferPages: true, info: { Title: "Résumé", Producer: "CareerFiend" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("error", reject);
    doc.on("end", () => resolve({ buffer: Buffer.concat(chunks), pages }));
    const width = LETTER.width - 2 * MARGIN;
    for (const line of lines) {
      const st = STYLE[line.style];
      doc.moveDown(st.before / 12);
      doc.font(st.font).fontSize(st.size);
      const left = line.spans.map((s) => s.text).join("");
      if (line.style === "section") {
        doc.text(left.toUpperCase(), MARGIN, doc.y, { width });
        const y = doc.y + 0.5;
        doc
          .moveTo(MARGIN, y)
          .lineTo(MARGIN + width, y)
          .lineWidth(0.5)
          .strokeColor("#555555")
          .stroke();
        doc.moveDown(0.15);
      } else if (line.right?.length) {
        const right = line.right.map((s) => s.text).join("");
        const y = doc.y;
        doc.font("Helvetica").fontSize(9);
        const rw = doc.widthOfString(right);
        doc.text(right, MARGIN + width - rw, y, { width: rw, lineBreak: false });
        doc.font(st.font).fontSize(st.size);
        doc.text(left, MARGIN, y, { width: width - rw - 8 });
      } else if (line.style === "bullet") {
        doc.text(`•  ${left}`, MARGIN + 6, doc.y, { width: width - 6, indent: 0, align: "left" });
      } else {
        doc.text(left, MARGIN, doc.y, { width });
      }
      doc.moveDown(st.after / 12);
    }
    const pages = doc.bufferedPageRange().count;
    doc.end();
  });
}

const DOCX_FONT = "Arial";
const pt = (n: number) => Math.round(n * 2); // docx sizes are half-points

export async function renderResumeDocx(lines: Line[]): Promise<Buffer> {
  const children: Paragraph[] = [];
  for (const line of lines) {
    const st = STYLE[line.style];
    const bold = st.font.includes("Bold");
    const italics = st.font.includes("Oblique");
    const left = line.spans.map((s) => s.text).join("");
    const spacing = { before: Math.round(st.before * 20), after: Math.round(st.after * 20) };
    if (line.style === "bullet") {
      children.push(
        new Paragraph({
          numbering: { reference: "cf-bullets", level: 0 },
          spacing,
          children: [new TextRun({ text: left, font: DOCX_FONT, size: pt(st.size) })],
        }),
      );
    } else if (line.right?.length) {
      children.push(
        new Paragraph({
          spacing,
          tabStops: [{ type: TabStopType.RIGHT, position: 11520 - 2 * 720 }],
          children: [
            new TextRun({ text: left, bold, italics, font: DOCX_FONT, size: pt(st.size) }),
            new TextRun({ text: `\t${line.right.map((s) => s.text).join("")}`, font: DOCX_FONT, size: pt(9) }),
          ],
        }),
      );
    } else {
      children.push(
        new Paragraph({
          spacing,
          border: line.style === "section" ? { bottom: { style: "single", size: 4, color: "555555", space: 1 } } : undefined,
          children: [new TextRun({ text: line.style === "section" ? left.toUpperCase() : left, bold, italics, font: DOCX_FONT, size: pt(st.size) })],
        }),
      );
    }
  }
  const doc = new Document({
    creator: "CareerFiend",
    numbering: {
      config: [
        {
          reference: "cf-bullets",
          levels: [
            { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 240, hanging: 160 } } } },
          ],
        },
      ],
    },
    sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 720, bottom: 720, left: 720, right: 720 } } }, children }],
  });
  return Packer.toBuffer(doc);
}

/* ------------------------------------------------------------ cover letter */

export function renderLetterPdf(paragraphs: string[], header: string[]): Promise<PdfResult> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [LETTER.width, LETTER.height],
      margin: 72,
      bufferPages: true,
      info: { Title: "Cover letter", Producer: "CareerFiend" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("error", reject);
    doc.on("end", () => resolve({ buffer: Buffer.concat(chunks), pages }));
    doc.font("Helvetica").fontSize(10.5);
    for (const h of header) doc.text(h);
    doc.moveDown(1);
    for (const p of paragraphs) {
      doc.text(p, { align: "left", lineGap: 2 });
      doc.moveDown(0.8);
    }
    const pages = doc.bufferedPageRange().count;
    doc.end();
  });
}

export async function renderLetterDocx(paragraphs: string[], header: string[]): Promise<Buffer> {
  const run = (text: string) => new TextRun({ text, font: DOCX_FONT, size: pt(10.5) });
  const doc = new Document({
    creator: "CareerFiend",
    sections: [
      {
        properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
        children: [
          ...header.map((h) => new Paragraph({ children: [run(h)] })),
          new Paragraph({ children: [] }),
          ...paragraphs.map((p) => new Paragraph({ spacing: { after: 200 }, children: [run(p)] })),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

/* ----------------------------------------------------------- verification */

/** Extract text from a DOCX (proves it opens and holds the expected text). */
export async function docxText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) throw new Error("DOCX has no word/document.xml");
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Extract text and page count from a PDF (proves it opens). */
export async function pdfText(buffer: Buffer): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { text: text as string, pages: totalPages };
}
