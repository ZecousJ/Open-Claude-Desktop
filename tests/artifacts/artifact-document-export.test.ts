import test from "node:test";
import assert from "node:assert/strict";
import { DOMParser, parseHTML } from "linkedom";
import JSZip from "jszip";
import mammoth from "mammoth";
import {
  documentFilename,
  printDocument,
} from "../../shared/artifact-document";
import {
  documentBytesInput,
  documentCloudInput,
} from "../../shared/artifact-document-input";
import {
  documentContent,
  documentDocx,
  documentMarkdown,
  exportDocument,
} from "../../src/artifacts/document-export";
import { canExportDocument } from "../../src/artifacts/artifact-kind";
import { artifactFeedbackTurn } from "../../src/artifacts/ArtifactFeedbackDialog";
import type { Artifact } from "../../src/ui/ArtifactTypes";
import type { Turn } from "../../shared/types";
import { browserDocumentPdf } from "../../src-web/bridge/document-print";

const artifact: Artifact = {
  id: "message-0",
  name: "Report.md",
  language: "markdown",
  content:
    "# Report\n\n**Hello** 世界\n\n| First | Second |\n| --- | --- |\n| one | two |\n\n- Alpha\n- Beta",
};

function htmlDocument(html: string) {
  return parseHTML(
    `<!doctype html><html><head></head><body>${html}</body></html>`,
  ).document;
}

test("document export availability excludes code, other binaries, omitted and generating files", () => {
  assert.equal(canExportDocument(artifact), true);
  assert.equal(
    canExportDocument({
      ...artifact,
      language: "text",
      blob: true,
      filename: "Report.docx",
    }),
    true,
  );
  for (const patch of [
    { language: "typescript" },
    { language: "html" },
    { language: "csv" },
    { blob: true, filename: "Report.pdf", mime: "application/pdf" },
    { contentOmitted: true },
    { generating: true },
  ])
    assert.equal(canExportDocument({ ...artifact, ...patch }), false);
});

test("document filenames reuse the PDF safe-name rules and print markup refuses scripts and remote resources", () => {
  assert.equal(documentFilename("../../Résumé.docx", "md"), "Résumé.md");
  assert.equal(documentFilename("CON.md", "pdf"), "document.pdf");
  assert.equal(documentFilename("Report.v2", "docx"), "Report.v2.docx");
  const html = printDocument(
    '</title><script>alert("title")</script>',
    "<p>Report</p>",
  );
  assert.match(html, /default-src 'none'/);
  assert.match(html, /img-src data:/);
  assert.doesNotMatch(html, /<script>/);
  assert.throws(() => documentBytesInput.parse("../invalid"));
  assert.throws(() =>
    documentCloudInput.parse({
      server: "gdrive",
      service: "unknown",
      title: "Report",
      markdown: "Hi",
    }),
  );
});

test("Markdown becomes a readable OOXML document, and exports send real bytes or printable HTML", async () => {
  const savedParser = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const calls: unknown[][] = [];
  Object.defineProperty(globalThis, "DOMParser", {
    configurable: true,
    value: class {
      parseFromString(text: string, mime: string) {
        return mime === "text/html"
          ? htmlDocument(text)
          : new DOMParser().parseFromString(text, "text/xml");
      }
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      desktop: {
        saveArtifact: async (...args: unknown[]) => {
          calls.push(["md", ...args]);
          return null;
        },
        saveArtifactBytes: async (...args: unknown[]) => {
          calls.push(["docx", ...args]);
          return "Report.docx";
        },
        exportDocumentPdf: async (...args: unknown[]) => {
          calls.push(["pdf", ...args]);
          return "Report.pdf";
        },
        saveGeneratedFile: async (...args: unknown[]) => {
          calls.push(["snapshot", ...args]);
          return "Original.docx";
        },
      },
    },
  });
  try {
    const { html, markdown } = await documentContent(artifact);
    assert.equal(markdown, artifact.content);
    assert.match(html, /<h1>Report<\/h1>/);
    assert.match(html, /<strong>Hello<\/strong> 世界/);
    assert.match(html, /<table>/);
    const base64 = await documentDocx(html);
    const bytes = Buffer.from(base64, "base64");
    assert.equal(bytes.subarray(0, 2).toString(), "PK");
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file("word/document.xml")!.async("string");
    assert.match(xml, /<w:b\/>/);
    assert.match(xml, /<w:tbl>/);
    assert.match(xml, /Heading1/);
    const extracted = await mammoth.extractRawText({ buffer: bytes });
    for (const text of ["Report", "Hello 世界", "one", "two", "Alpha", "Beta"])
      assert.ok(extracted.value.includes(text), text);
    assert.equal(await exportDocument(artifact, "md"), null);
    assert.equal(await exportDocument(artifact, "docx"), "Report.docx");
    assert.equal(await exportDocument(artifact, "pdf"), "Report.pdf");
    assert.deepEqual(calls[0], ["md", "Report.md", artifact.content]);
    assert.equal(calls[1][1], "Report.docx");
    assert.equal(calls[2][2], html);
    assert.equal(
      await exportDocument(
        { ...artifact, blob: true, sourceDigest: "digest" },
        "docx",
      ),
      "Original.docx",
    );
    assert.deepEqual(calls[3], ["snapshot", "digest", "Report.docx"]);
    assert.match(
      documentMarkdown(
        htmlDocument(
          "<h2>Title</h2><p><strong>Bold</strong> and <em>italic</em></p><table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>",
        ).body,
      ),
      /## Title\n\n\*\*Bold\*\* and \*italic\*[\s\S]*\| --- \| --- \|/,
    );
  } finally {
    if (savedParser)
      Object.defineProperty(globalThis, "DOMParser", savedParser);
    else Reflect.deleteProperty(globalThis, "DOMParser");
    if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("feedback resolves the artifact's completed origin, not a later unrelated reply", () => {
  const turn = (id: string, itemId: string, extra = {}): Turn =>
    ({
      id,
      status: "completed",
      items: [
        {
          id: itemId,
          type: "agentMessage",
          text: "```markdown\nHello\n```",
          ...extra,
        },
      ],
    }) as Turn;
  const turns = [turn("original", "message"), turn("unrelated", "later")];
  assert.equal(artifactFeedbackTurn(artifact, turns)?.id, "original");
  assert.equal(
    artifactFeedbackTurn({ ...artifact, id: "generated", sourceDigest: "d" }, [
      turn("file", "f", {
        generatedFiles: [{ digest: "d", path: "Report.docx" }],
      }),
    ])?.id,
    "file",
  );
  assert.equal(
    artifactFeedbackTurn(
      { ...artifact, libraryId: "copy", id: "copy", content: "Hello\n" },
      turns,
    )?.id,
    "unrelated",
  );
  assert.equal(
    artifactFeedbackTurn(artifact, [{ ...turns[0], status: "inProgress" }]),
    undefined,
  );
});

test("browser PDF waits for printing, cleans up on cancel or error, and never claims a file was saved", async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
  let removed = 0;
  let fail = false;
  const frames: {
    hidden: boolean;
    srcdoc: string;
    sandbox?: string;
    onload?: () => void;
  }[] = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement() {
        const printer = new EventTarget() as EventTarget & {
          focus: () => void;
          print: () => void;
        };
        printer.focus = () => {};
        printer.print = () => {
          if (fail) throw new Error("print failed");
          setTimeout(() => printer.dispatchEvent(new Event("afterprint")), 0);
        };
        const frame = {
          hidden: false,
          srcdoc: "",
          sandbox: "",
          contentWindow: printer,
          onload: () => {},
          setAttribute(_name: string, value: string) {
            this.sandbox = value;
          },
          remove() {
            removed++;
          },
        };
        frames.push(frame);
        return frame;
      },
      body: {
        append(frame: { onload: () => void }) {
          queueMicrotask(() => frame.onload());
        },
      },
    },
  });
  try {
    assert.equal(await browserDocumentPdf("Report", "<p>Report</p>"), null);
    assert.equal(removed, 1);
    assert.equal(frames[0].hidden, true);
    assert.equal(frames[0].sandbox, "allow-same-origin allow-modals");
    assert.match(frames[0].srcdoc, /default-src 'none'/);
    fail = true;
    await assert.rejects(
      browserDocumentPdf("Report", "<p>Report</p>"),
      /print failed/,
    );
    assert.equal(removed, 2);
  } finally {
    if (saved) Object.defineProperty(globalThis, "document", saved);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
