import assert from "node:assert/strict";
import test from "node:test";
import {
  fileCardKind,
  fileCardName,
} from "../../src/artifacts/GeneratedFileCard";
import { artifactLook, sheetLookOf } from "../../src/artifacts/SheetTile";

test("file cards name the kind as the captures do (R-0941, R-0956)", () => {
  assert.deepEqual(fileCardKind("report.pdf"), { label: "Document · PDF" });
  assert.equal(fileCardKind("sheet.xlsx").label, "Spreadsheet · XLSX");
  assert.equal(fileCardKind("deck.pptx").label, "Presentation · PPTX");
  assert.equal(fileCardKind("capture.md").label, "Document · MD");
  assert.equal(fileCardKind("capture.json").label, "Code · JSON");
  // Python and TypeScript are named by extension alone.
  assert.equal(fileCardKind("capture.py").label, "PY");
  assert.equal(fileCardKind("capture.ts").label, "TS");
  assert.equal(fileCardKind("blank.html").label, "Code · HTML");
  assert.equal(fileCardKind("red_circle.png").label, "Image · PNG");
  assert.equal(fileCardKind("photo.JPG").label, "Image · JPG");
  assert.equal(
    fileCardName("R-1035-pdf-preview-sample.pdf"),
    "R 1035 pdf preview sample",
  );
  assert.equal(fileCardName("first_10_primes.csv"), "First 10 primes");
  assert.equal(
    fileCardName("grok-对-claude-说你真菜.png"),
    "Grok 对 claude 说你真菜",
  );
});

test("each file takes the original's sheet: marks, tint and glyph", () => {
  const look = (name: string) => {
    const { kind, tint, glyph } = sheetLookOf(name);
    return `${kind} ${tint} ${glyph}`;
  };
  assert.equal(look("好玩的excel.xlsx"), "sheet green Spreadsheet");
  assert.equal(look("primes.csv"), "csv green Spreadsheet");
  assert.equal(look("report.pdf"), "pdf gray File");
  assert.equal(look("notes.docx"), "doc blue File");
  assert.equal(look("notes.txt"), "txt gray File");
  assert.equal(look("README.md"), "markdown gray Note");
  assert.equal(look("page.html"), "html magenta Globe");
  assert.equal(look("data.json"), "json yellow Code");
  assert.equal(look("main.py"), "code yellow Code");
  assert.equal(look("deck.pptx"), "slides orange Slides");
  assert.equal(look("logo.svg"), "image violet Image");
  assert.equal(look("photo.JPG"), "image violet Image");
  assert.equal(look("backup.zip"), "archive gray Archive");
  assert.equal(look("rows.parquet"), "sheet green Database");
  assert.equal(look("Makefile"), "doc blue File");
  assert.deepEqual(artifactLook, {
    kind: "html",
    tint: "gray",
    glyph: "Artifacts",
  });
});
