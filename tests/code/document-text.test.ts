import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { documentText } from "../../electron/workspace/document-text";
import { turnInput } from "../../electron/engine/engine-support";
import { attachmentKind, openPolicy } from "../../shared/client-policy";
import { attachmentRefusal } from "../../shared/client-policy-rules";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-docs-"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

async function write(name: string, files: Record<string, string>) {
  const zip = new JSZip();
  for (const [file, text] of Object.entries(files)) zip.file(file, text);
  const target = path.join(dir, name);
  fs.writeFileSync(target, await zip.generateAsync({ type: "nodebuffer" }));
  return target;
}

const slide = (lines: string[]) =>
  `<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>${lines
    .map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`)
    .join("")}</p:spTree></p:cSld></p:sld>`;

test("a PowerPoint gives its slides in order, with their notes", async () => {
  const file = await write("deck.pptx", {
    "ppt/slides/slide1.xml": slide(["WonderSim", "Agents &amp; tools"]),
    "ppt/slides/slide2.xml": slide(["Roadmap"]),
    "ppt/slides/slide10.xml": slide(["Thanks"]),
    "ppt/notesSlides/notesSlide2.xml": slide(["Say the dates", "2"]),
  });
  const text = await documentText(file);
  assert.match(text, /## Slide 1\nWonderSim\nAgents & tools/);
  assert.match(text, /## Slide 2\nRoadmap\n\nNotes:\nSay the dates/);
  assert.ok(
    text.indexOf("Roadmap") < text.indexOf("Thanks"),
    "slide 10 after 2",
  );
});

test("a Word document gives its paragraphs", async () => {
  const file = await write("letter.docx", {
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Dear team,</w:t></w:r></w:p><w:p><w:r><w:t>The launch moves to May.</w:t></w:r></w:p></w:body></w:document>`,
  });
  assert.equal(
    await documentText(file),
    "Dear team,\n\nThe launch moves to May.",
  );
});

test("an Excel workbook gives each sheet's rows, shared and inline text", async () => {
  const file = await write("numbers.xlsx", {
    "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Q1 &amp; Q2" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst><si><t>Region</t></si><si><t>East</t></si></sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Total</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2"><v>42</v></c></row></sheetData></worksheet>`,
  });
  assert.equal(
    await documentText(file),
    "## Sheet: Q1 & Q2\nRegion\t\tTotal\nEast\t\t42",
  );
});

test("a PDF gives its pages' text", async () => {
  const stream = "BT /F1 18 Tf 72 720 Td (Quarterly report) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const file = path.join(dir, "report.pdf");
  fs.writeFileSync(file, pdf, "latin1");
  assert.match(await documentText(file), /## Page 1\nQuarterly report/);
});

test("a damaged document is refused in plain words", async () => {
  const file = path.join(dir, "broken.pptx");
  fs.writeFileSync(file, "not a zip");
  await assert.rejects(documentText(file), /couldn't be read/);
});

test("documents may be attached and reach the model as their text", async () => {
  assert.equal(attachmentKind("PPTX"), "document");
  assert.equal(attachmentKind("png"), "image");
  assert.equal(attachmentKind("md"), "text");
  assert.equal(
    attachmentRefusal("代理商大会_V2.pptx", 5_000_000, openPolicy),
    undefined,
  );
  assert.match(
    attachmentRefusal("huge.pdf", 40 * 1024 * 1024, openPolicy) ?? "",
    /“huge.pdf” is 40 MB, over the 30 MB limit\. Choose a smaller file\./,
  );
  const file = await write("deck2.pptx", {
    "ppt/slides/slide1.xml": slide(["Hello deck"]),
  });
  const [part] = await turnInput("", [
    { id: "d", name: "deck2.pptx", path: file, kind: "document", size: 10 },
  ]);
  assert.match(
    part.text,
    /<attached_file name="deck2.pptx">\n## Slide 1\nHello deck/,
  );
});
