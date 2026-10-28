import test, { before } from "node:test";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";

before(() => preloadMarkdownRenderer());
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import type { Conversation, GeneratedFile, Turn } from "../../shared/types";
import { generatedArtifact } from "../../src/artifacts/generatedArtifact";
import { collectArtifacts } from "../../src/artifacts/artifact-collection";
import {
  ArtifactPanel,
  artifactFilename,
} from "../../src/artifacts/FileViewer";
import type { Artifact } from "../../src/ui/components";
import {
  artifactKind,
  artifactViews,
  kindLabel,
} from "../../src/artifacts/artifact-kind";
import { fixRequest } from "../../src/artifacts/artifact-actions";
import { rewritingFile } from "../../src/artifacts/generating";
import { parseDelimited } from "../../src/artifacts/csv";
import {
  inlineScript,
  mermaidDocument,
  scriptJson,
} from "../../src/artifacts/preview-document";
import { compileReact } from "../../src/artifacts/preview-runtimes";
import { tooLargeReason } from "../../src/artifacts/NativePreviews";

const digest = "a".repeat(64);
function file(extra: Partial<GeneratedFile>): GeneratedFile {
  return {
    id: "item-1:0",
    name: "chart.png",
    path: "/work/chart.png",
    language: "text",
    operation: "create",
    state: "ready",
    capturedAt: 1_000,
    digest,
    ...extra,
  };
}
const render = (artifact: Artifact) =>
  renderToStaticMarkup(
    createElement(ArtifactPanel, {
      artifact,
      onClose() {},
      onError() {},
    }),
  );

test("binary generated files map to snapshot artifacts without content", () => {
  const artifact = generatedArtifact(
    file({ blob: true, mime: "image/png", bytes: 989 }),
  );
  assert.deepEqual(artifact, {
    updatedAt: 1_000,
    id: `generated:item-1:0:${digest}`,
    filename: "chart.png",
    language: "text",
    sourcePath: "/work/chart.png",
    sourceDigest: digest,
    name: "Chart",
    content: "",
    blob: true,
    mime: "image/png",
    bytes: 989,
  });
  // A snapshot without its digest cannot be read back, so nothing opens.
  assert.equal(
    generatedArtifact(file({ blob: true, digest: undefined })),
    undefined,
  );
  assert.equal(
    generatedArtifact(file({ blob: true, state: "unavailable" })),
    undefined,
  );
  // Text files keep their content and HTML title.
  const page = generatedArtifact(
    file({
      name: "card.html",
      path: "/work/card.html",
      language: "html",
      content: "<title> Card </title><p>x</p>",
    }),
  );
  assert.equal(page?.name, "Card");
  assert.equal(page?.blob, undefined);
  assert.equal(page?.content, "<title> Card </title><p>x</p>");
  assert.equal(
    generatedArtifact(file({ language: "html", content: undefined })),
    undefined,
  );
});

test("the Artifacts library lists text files only", () => {
  const conversation = {
    id: "c1",
    title: "Files",
    turns: [
      {
        id: "t1",
        items: [
          {
            id: "i1",
            type: "fileChange",
            generatedFiles: [
              file({ blob: true, mime: "image/png" }),
              file({
                id: "item-1:1",
                name: "notes.md",
                path: "/work/notes.md",
                language: "markdown",
                content: "# Notes",
              }),
            ],
          },
        ],
      },
    ],
  } as unknown as Conversation;
  const listed = collectArtifacts([conversation], [], {
    version: 1,
    copies: [],
    pinned: [],
  });
  assert.deepEqual(
    listed.map((a) => a.filename),
    ["notes.md"],
  );
});

test("each kind gets the views it can really show", () => {
  const kinds = {
    image: { language: "text", name: "a.png", blob: true, mime: "image/png" },
    pdf: {
      language: "text",
      name: "a.pdf",
      blob: true,
      mime: "application/pdf",
    },
    docx: { language: "text", name: "a.docx", blob: true, mime: "x" },
    xlsx: { language: "text", name: "a.xlsx", blob: true, mime: "x" },
    pptx: { language: "text", name: "a.pptx", blob: true, mime: "x" },
    file: { language: "text", name: "a.zip", blob: true, mime: "x" },
    html: { language: "html", name: "a.html" },
    react: { language: "tsx", name: "a.tsx" },
    mermaid: { language: "mermaid", name: "a.mmd" },
    markdown: { language: "markdown", name: "a.md" },
    csv: { language: "text", name: "data.csv" },
    code: { language: "python", name: "a.py" },
  } as const;
  for (const [kind, source] of Object.entries(kinds))
    assert.equal(artifactKind(source), kind, source.name);
  assert.deepEqual(artifactViews("image"), { preview: true, source: false });
  assert.deepEqual(artifactViews("file"), { preview: true, source: false });
  assert.deepEqual(artifactViews("xlsx"), { preview: true, source: false });
  assert.deepEqual(artifactViews("pptx"), { preview: true, source: false });
  assert.deepEqual(artifactViews("react"), { preview: true, source: true });
  assert.deepEqual(artifactViews("csv"), { preview: true, source: true });
  assert.deepEqual(artifactViews("code"), { preview: false, source: true });
  assert.equal(kindLabel({ language: "tsx", name: "Preview 1" }), "React");
  assert.equal(
    kindLabel({ language: "text", name: "x", filename: "a.pdf" }),
    "PDF",
  );
});

test("the panel picks the preview for the artifact's kind", () => {
  const markdown = render({
    id: "m",
    name: "notes.md",
    filename: "notes.md",
    language: "markdown",
    content: "# Heading\n\nBody",
  });
  assert.match(markdown, /artifact-markdown-preview/);
  assert.match(markdown, /<h1[^>]*>Heading<\/h1>/);
  assert.match(markdown, /File view mode/);
  // A Markdown artifact's own preview offers no Open buttons for its code blocks.
  assert.doesNotMatch(markdown, /code-open/);

  const table = render({
    id: "c",
    name: "data.csv",
    filename: "data.csv",
    language: "text",
    content: 'region,revenue\n"EMEA, North",160\n',
  });
  assert.match(table, /<th>region<\/th><th>revenue<\/th>/);
  assert.match(table, /<td>EMEA, North<\/td>/);

  const image = render({
    id: "i",
    name: "chart.png",
    filename: "chart.png",
    language: "text",
    content: "",
    blob: true,
    mime: "image/png",
    sourceDigest: digest,
  });
  assert.match(image, /artifact-image-preview/);
  assert.match(image, />Download</);
  assert.doesNotMatch(image, /File view mode|aria-label="Copy"|<iframe/);

  const sheet = render({
    id: "s",
    name: "summary.xlsx",
    filename: "summary.xlsx",
    language: "text",
    content: "",
    blob: true,
    mime: "application/vnd.ms-excel",
    bytes: 2048,
    sourceDigest: digest,
  });
  // Spreadsheets and slides preview in the sandboxed frame once read.
  assert.match(
    sheet,
    /<iframe title="User-generated artifact content" sandbox="allow-scripts"/,
  );
  assert.match(sheet, /role="status" class="artifact-frame-loading"/);
  assert.doesNotMatch(sheet, /aria-label="Loading preview"/);

  const archive = render({
    id: "z",
    name: "bundle.zip",
    filename: "bundle.zip",
    language: "text",
    content: "",
    blob: true,
    mime: "application/zip",
    bytes: 2048,
    sourceDigest: digest,
  });
  assert.match(archive, /file-preview-none/);
  assert.match(archive, />No preview</);
  assert.match(archive, /This file type can’t be previewed\./);
  assert.match(archive, /file-preview-none-download[^>]*>.*Download file</);

  // A file past the snapshot limits opens a card that says how large it is,
  // with no Download (there is nothing kept to download).
  const large = generatedArtifact(
    file({
      name: "dump.csv",
      path: "/work/dump.csv",
      digest: undefined,
      tooLarge: true,
      bytes: 3 * 1048576 + 52429,
    }),
  )!;
  assert.equal(large.contentOmitted, true);
  assert.equal(artifactKind(large), "file");
  assert.deepEqual(artifactViews(artifactKind(large)), {
    preview: true,
    source: false,
  });
  const largeCard = render(large);
  assert.match(largeCard, />No preview</);
  assert.match(largeCard, /3\.1 MB — too large to preview/);
  assert.doesNotMatch(largeCard, /Download file/);
  assert.equal(tooLargeReason(undefined), "File is too large to preview");

  for (const artifact of [
    { language: "tsx", name: "Preview 1", content: "export default 1" },
    { language: "mermaid", name: "Preview 2", content: "flowchart LR" },
    {
      language: "text",
      name: "a.pdf",
      filename: "a.pdf",
      content: "",
      blob: true,
      mime: "application/pdf",
      sourceDigest: digest,
    },
  ]) {
    const html = render({ id: artifact.name, ...artifact });
    assert.match(html, /<iframe[^>]*sandbox="allow-scripts"/, artifact.name);
    assert.doesNotMatch(html, /allow-same-origin/);
  }

  const code = render({
    id: "p",
    name: "total.py",
    filename: "total.py",
    language: "python",
    content: "print(1)\n",
  });
  assert.match(code, /file-source/);
  assert.doesNotMatch(code, /File view mode|<iframe/);
});

test("an existing editable frame being rewritten keeps its known collaboration title", (t) => {
  const html = render({
    id: "g",
    name: "Synthetic interface card",
    filename: "card.html",
    language: "html",
    content: "<p>old</p>",
    surface: "artifact",
    generating: true,
  });
  const dom = new JSDOM(html),
    document = dom.window.document;
  t.after(() => dom.window.close());
  assert.ok(document.querySelector(".artifact-collaboration-header"));
  assert.equal(document.querySelector("[data-artifact-pending-title]"), null);
  assert.ok(
    document.querySelector(
      'button[aria-label="Artifact options, Synthetic interface card"]',
    ),
  );
  assert.equal(
    document.querySelector<HTMLButtonElement>('button[aria-label="Comment"]')
      ?.disabled,
    false,
  );
  assert.equal(
    document.querySelector<HTMLButtonElement>(
      'button[aria-label="More comment options"]',
    )?.disabled,
    false,
  );
  assert.ok(document.querySelector('button[aria-label="Expand"]'));
  assert.ok(document.querySelector('button[aria-label="Close"]'));
  assert.ok(document.querySelector('[role="status"][aria-label="Generating"]'));
  assert.equal(document.querySelector("iframe"), null);
});

test("rewritingFile follows running file changes of the live turn only", () => {
  const turn = (status: Turn["status"], itemStatus: string, path: string) =>
    ({
      id: "t",
      prompt: "",
      attachments: [],
      createdAt: 0,
      status,
      items: [
        {
          id: "i",
          type: "fileChange",
          status: itemStatus,
          changes: [{ path, kind: { type: "update" }, diff: "" }],
        },
      ],
    }) as Turn;
  const source = "/work/site/card.html";
  // Relative change paths are relative to the conversation's folder.
  assert.equal(
    rewritingFile([turn("inProgress", "inProgress", "card.html")], source),
    true,
  );
  assert.equal(
    rewritingFile([turn("inProgress", "inProgress", "ard.html")], source),
    false,
  );
  assert.equal(
    rewritingFile([turn("inProgress", "inProgress", "site/card.html")], source),
    true,
  );
  assert.equal(
    rewritingFile(
      [turn("inProgress", "inProgress", "./site/card.html")],
      source,
    ),
    true,
  );
  assert.equal(
    rewritingFile([turn("inProgress", "inProgress", source)], source),
    true,
  );
  assert.equal(
    rewritingFile(
      [turn("inProgress", "inProgress", "/other/card.html")],
      source,
    ),
    false,
  );
  assert.equal(
    rewritingFile([turn("inProgress", "inProgress", "other.html")], source),
    false,
  );
  assert.equal(
    rewritingFile([turn("inProgress", "completed", "site/card.html")], source),
    false,
  );
  assert.equal(
    rewritingFile([turn("completed", "inProgress", "site/card.html")], source),
    false,
  );
  assert.equal(
    rewritingFile(
      [turn("inProgress", "inProgress", "C:\\work\\site\\card.html")],
      "C:\\work\\site\\card.html",
    ),
    true,
  );
});

test("Try fixing fences the error and points at the file or quotes the source", () => {
  const withFile = fixRequest(
    {
      id: "a",
      name: "Widget",
      language: "html",
      content: "<p>",
      sourcePath: "/work/widget.html",
    },
    "Error: ```breaks``` fences",
  );
  assert.match(withFile, /\n````\nError: ```breaks``` fences\n````\n/);
  assert.match(withFile, /File: \/work\/widget\.html/);
  assert.doesNotMatch(withFile, /<p>/);
  const quoted = fixRequest(
    { id: "b", name: "Preview 1", language: "tsx", content: "const a = 1;" },
    "TypeError: x",
  );
  assert.match(quoted, /Artifact source:\n```tsx\nconst a = 1;\n```/);
});

test("downloads keep the file's own name or add the language's extension", () => {
  assert.equal(
    artifactFilename({
      id: "a",
      name: "Card",
      filename: "card.html",
      language: "html",
      content: "",
    }),
    "card.html",
  );
  assert.equal(
    artifactFilename({ id: "b", name: "Code", language: "text", content: "" }),
    "Code.txt",
  );
  assert.equal(
    artifactFilename({ id: "c", name: "Code", language: "tsx", content: "" }),
    "Code.tsx",
  );
});

test("tables show the header and the first 1,000 data rows", () => {
  const rows = (n: number) =>
    ["a,b", ...Array.from({ length: n }, (_, i) => `${i},x`)].join("\n");
  const exact = parseDelimited(rows(1000), undefined, 1001);
  assert.equal(exact.rows.length, 1001);
  assert.equal(exact.truncated, false);
  const over = parseDelimited(rows(1001), undefined, 1001);
  assert.equal(over.rows.length, 1001);
  assert.equal(over.truncated, true);
  assert.deepEqual(parseDelimited('x\ty\n"a\tb"\t"c""d"').rows, [
    ["x", "y"],
    ["a\tb", 'c"d'],
  ]);
});

test("preview documents keep inline scripts closed and clean up failed diagrams", () => {
  assert.equal(
    inlineScript('a("</script><!--")'),
    '<script>a("<\\/script><\\!--")</script>',
  );
  assert.equal(scriptJson("</script>"), '"\\u003c/script>"');
  const doc = mermaidDocument(
    { source: "/*runtime*/" },
    "graph TD\n</script>",
    true,
  );
  assert.doesNotMatch(doc, /<\/script>\n/);
  assert.match(doc, /#dclaudex-diagram,#claudex-diagram/);
  assert.match(doc, /theme:"dark"/);
});

test("React artifacts compile to a module factory; syntax errors are reported", async () => {
  const ok = await compileReact(
    'import { useState } from "react";\nexport default function A() { const [n] = useState(0); return <b>{n}</b>; }',
  );
  assert.ok("code" in ok);
  assert.match(ok.code, /React\.createElement\(['"]b['"]/);
  assert.match(ok.code, /require\(['"]react['"]\)/);
  const failed = await compileReact("export default () => <div>");
  assert.ok("error" in failed);
});
