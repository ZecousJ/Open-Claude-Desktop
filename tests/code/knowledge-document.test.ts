import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import JSZip from "jszip";
import { knowledgeDocx } from "../support/knowledge-document-fixtures";
import { convertOfficeDocument } from "../../electron/workspace/office-conversion";
import {
  documentTextData,
  maxDocumentChars,
} from "../../electron/workspace/document-text";
import { extractKnowledgeDocument } from "../../electron/workspace/knowledge-document";

const relationships =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const packageRelationships =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const packageTypes =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const xhtml = "http://www.w3.org/1999/xhtml";

async function archive(entries: Record<string, string>) {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(entries)) zip.file(name, value);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function extract(name: string, data: Buffer, runtime?: string) {
  return extractKnowledgeDocument({
    data,
    name,
    mediaType: "application/octet-stream",
    runtime,
    signal: new AbortController().signal,
  });
}

function workbook() {
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const sheet = (text: string) =>
    `<worksheet xmlns="${ns}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c></row></sheetData></worksheet>`;
  return archive({
    "[Content_Types].xml": `<Types xmlns="${packageTypes}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    "_rels/.rels": `<Relationships xmlns="${packageRelationships}"><Relationship Id="r1" Type="${relationships}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<workbook xmlns="${ns}" xmlns:r="${relationships}"><sheets><sheet name="First" sheetId="1" r:id="rId1"/><sheet name="Second" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="${packageRelationships}"><Relationship Id="rId1" Type="${relationships}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${relationships}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": sheet("华东"),
    "xl/worksheets/sheet2.xml": sheet("华南")
      .replace(/<(\/?)([A-Za-z]+)/g, "<$1x:$2")
      .replace("xmlns=", "xmlns:x="),
  });
}

test("knowledge text keeps the end of a long DOCX; chat attachments keep their limit", async () => {
  const content = "前言 ".repeat(maxDocumentChars / 2) + "最后一段";
  const data = await knowledgeDocx(content);
  assert.equal(await extract("长文.DOCX", data), content);
  const prompt = await documentTextData(data, "长文.DOCX");
  assert.match(prompt, /The rest of the document was cut/);
  assert.doesNotMatch(prompt, /最后一段/);
  await assert.rejects(
    extract("empty.docx", await knowledgeDocx("")),
    /no readable text/,
  );
  await assert.rejects(
    extract("broken.docx", Buffer.from("not an office document")),
    /could not be read/,
  );
});

test("PPTX text follows the presentation's slide order and each slide's own notes", async () => {
  const ns = `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"`;
  const paragraph = (text: string) =>
    `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`;
  const slide = (text: string) =>
    `<p:sld ${ns}><p:cSld><p:spTree><p:sp><p:txBody>${paragraph(text)}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const data = await archive({
    "ppt/presentation.xml": `<p:presentation ${ns} xmlns:r="${relationships}"><p:sldIdLst><p:sldId id="258" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships xmlns="${packageRelationships}"><Relationship Id="rId1" Type="${relationships}/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="${relationships}/slide" Target="slides/slide2.xml"/></Relationships>`,
    "ppt/slides/slide1.xml": slide("End of deck"),
    "ppt/slides/slide2.xml": slide("First in deck"),
    "ppt/slides/_rels/slide2.xml.rels": `<Relationships xmlns="${packageRelationships}"><Relationship Id="rId3" Type="${relationships}/notesSlide" Target="../notesSlides/notesSlide3.xml"/></Relationships>`,
    "ppt/notesSlides/notesSlide3.xml": `<p:notes ${ns}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody>${paragraph("1")}</p:txBody></p:sp><p:sp><p:txBody>${paragraph("2026")}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
  });
  assert.equal(
    await extract("reordered.pptx", data),
    "## Slide 1\nFirst in deck\n\nNotes:\n2026\n\n## Slide 2\nEnd of deck",
  );
});

test("XLSX knowledge text includes every worksheet in workbook order", async () => {
  assert.equal(
    await extract("regions.xlsx", await workbook()),
    "## Sheet: First\n华东\n\n## Sheet: Second\n华南",
  );
});

test("EPUB text follows its spine, including relative chapter links and inline text", async () => {
  const entries = {
    mimetype: "application/epub+zip",
    "META-INF/container.xml": `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    "OPS/book.opf": `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="later" href="a.xhtml" media-type="application/xhtml+xml"/><item id="first" href="chapters/first%20chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="first"/><itemref idref="later"/></spine></package>`,
    "OPS/a.xhtml": `<html xmlns="${xhtml}"><body><p>End of book</p></body></html>`,
    "OPS/chapters/first chapter.xhtml": `<html xmlns="${xhtml}"><head><title>Chapter metadata</title></head><body><h1>序章</h1><p>Tea <em>&amp; coffee</em>&nbsp;today.</p><script>ignore me</script></body></html>`,
  };
  assert.equal(
    await extract("book.epub", await archive(entries)),
    "序章\nTea & coffee today.\n\nEnd of book",
  );
  const { "OPS/a.xhtml": _missing, ...damaged } = entries;
  await assert.rejects(
    extract("damaged.epub", await archive(damaged)),
    /could not be read/,
  );
});

const runtime =
  process.env.CLAUDEX_RUNNER_DOCUMENT_RUNTIME ||
  (process.platform === "linux"
    ? "/usr/lib/libreoffice"
    : path.resolve(
        "build",
        process.platform === "win32"
          ? "document-runtime-win"
          : "document-runtime",
      ));
const office = path.join(
  runtime,
  process.platform === "darwin"
    ? "LibreOffice.app/Contents/MacOS/soffice"
    : process.platform === "win32"
      ? "program/soffice.exe"
      : "program/soffice",
);

test(
  "the installed Office runtime reads DOC, RTF, ODT and all sheets of XLS",
  { skip: !existsSync(office) },
  async (t) => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "knowledge-office-fixtures-"),
    );
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const runOffice = promisify(execFile);
    const rtf = Buffer.from(
      String.raw`{\rtf1\ansi RTF introduction\par Last \u27573?}`,
    );
    const xlsx = await workbook();
    await fs.writeFile(path.join(dir, "source.rtf"), rtf);
    await fs.writeFile(path.join(dir, "regions.xlsx"), xlsx);
    for (const [output, source] of [
      ["doc:MS Word 97", "source.rtf"],
      ["odt", "source.rtf"],
      ["xls:MS Excel 97", "regions.xlsx"],
    ]) {
      await runOffice(
        office,
        [
          "-env:UserInstallation=" +
            pathToFileURL(path.join(dir, "profile")).href,
          "--headless",
          "--convert-to",
          output,
          "--outdir",
          dir,
          path.join(dir, source),
        ],
        { timeout: 30_000 },
      );
    }
    for (const ext of ["doc", "rtf", "odt"]) {
      assert.equal(
        await extract(
          `source.${ext}`,
          await fs.readFile(path.join(dir, `source.${ext}`)),
          runtime,
        ),
        "RTF introduction\n\nLast 段",
      );
    }
    assert.equal(
      await extract(
        "regions.xls",
        await fs.readFile(path.join(dir, "regions.xls")),
        runtime,
      ),
      "## Sheet: First\n华东\n\n## Sheet: Second\n华南",
    );
    const pdf = await convertOfficeDocument({
      runtime,
      data: await knowledgeDocx("The preview keeps its text."),
      extension: "docx",
      output: "pdf",
      signal: new AbortController().signal,
    });
    assert.equal(
      await extract("preview.pdf", pdf),
      "## Page 1\nThe preview keeps its text.",
    );
    for (const ext of ["doc", "rtf", "odt", "xls"]) {
      await assert.rejects(
        extract(
          `damaged.${ext}`,
          Buffer.from("Not an Office document."),
          runtime,
        ),
        /could not be read/,
      );
    }
  },
);
