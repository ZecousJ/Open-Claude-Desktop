import JSZip from "jszip";
import { presentationBytes } from "../../src/artifacts/presentation-export";

/** Small valid documents for exercising the original file viewers. */
export async function generatedDocumentFixtures(): Promise<
  Record<string, Buffer>
> {
  const doc = new JSZip();
  doc.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  doc.file(
    "_rels/.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  doc.file(
    "word/document.xml",
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>F019 document preview</w:t></w:r></w:p><w:p><w:r><w:t>中文文档内容</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>',
  );
  const stream = "BT /F1 24 Tf 48 700 Td (F019 PDF preview) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((v) => `${String(v).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return {
    "document.docx": await doc.generateAsync({ type: "nodebuffer" }),
    "document.pdf": Buffer.from(pdf),
    "slides.pptx": Buffer.from(
      await presentationBytes([
        {
          title: "F019 PowerPoint preview",
          paragraphs: ["First slide", "中文演示内容"],
        },
        {
          title: "Second slide",
          paragraphs: ["Slide navigation verification"],
        },
      ]),
      "base64",
    ),
    "page.html": Buffer.from(
      '<!doctype html><html><meta charset="utf-8"><title>F019</title><body><h1>F019 HTML preview</h1><p>中文页面</p><button onclick="this.textContent=\'Clicked\'">Try interaction</button></body></html>',
    ),
    "drawing.svg": Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><rect width="320" height="120" fill="#17395c"/><text x="20" y="65" fill="white" font-size="24">F019 SVG preview</text></svg>',
    ),
    "notes.md": Buffer.from(
      "# F019 Markdown preview\n\n中文段落。\n\n- first\n- second\n",
    ),
    "reports/summary.txt": Buffer.from("Report summary"),
    "archive/summary.txt": Buffer.from("Archived summary"),
  };
}
