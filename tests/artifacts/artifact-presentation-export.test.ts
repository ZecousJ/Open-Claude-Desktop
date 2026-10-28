import test from "node:test";
import assert from "node:assert/strict";
import { DOMParser, parseHTML } from "linkedom";
import JSZip from "jszip";
import {
  presentationBytes,
  presentationSlides,
  exportPresentation,
} from "../../src/artifacts/presentation-export";
import { canExportPresentation } from "../../src/artifacts/artifact-kind";
import type { Artifact } from "../../src/ui/ArtifactTypes";

const artifact: Artifact = {
  id: "slides",
  name: "Presentation.md",
  language: "markdown",
  content:
    "# First & foremost\n\nHello 世界\n\n---\n\n# Second\n\n- Editable content",
};

test("PowerPoint export creates a complete slide relationship graph with editable Unicode text", async () => {
  assert.equal(canExportPresentation(artifact), true);
  assert.equal(canExportPresentation({ ...artifact, generating: true }), false);
  assert.equal(canExportPresentation({ ...artifact, name: "Notes.md" }), false);
  const slides = presentationSlides(artifact);
  assert.equal(slides.length, 2);
  const zip = await JSZip.loadAsync(await presentationBytes(slides), {
    base64: true,
  });
  const presentation = await zip.file("ppt/presentation.xml")!.async("string");
  assert.equal((presentation.match(/<p:sldId /g) ?? []).length, 2);
  const slide = await zip.file("ppt/slides/slide1.xml")!.async("string");
  assert.match(slide, /First &#38; foremost/);
  assert.match(slide, /Hello 世界/);
  for (const file of Object.values(zip.files).filter((entry) =>
    entry.name.endsWith(".rels"),
  )) {
    const content = await file.async("string");
    const document = new DOMParser().parseFromString(content, "text/xml");
    const directory = file.name.replace(/(?:^|\/)\_rels\/[^/]+$/, "");
    for (const relation of Array.from(
      document.querySelectorAll("Relationship"),
    ) as Element[]) {
      const parts = `${directory}/${relation.getAttribute("Target")}`.split(
        "/",
      );
      const resolved: string[] = [];
      for (const part of parts) {
        if (part === "..") resolved.pop();
        else if (part && part !== ".") resolved.push(part);
      }
      assert.ok(
        zip.file(resolved.join("/")),
        `${file.name}: ${resolved.join("/")}`,
      );
    }
  }
});

test("HTML slides export individually and native PowerPoint files preserve their original bytes", async () => {
  const parser = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");
  const window = Object.getOwnPropertyDescriptor(globalThis, "window");
  const calls: unknown[][] = [];
  Object.defineProperty(globalThis, "DOMParser", {
    configurable: true,
    value: class {
      parseFromString(content: string) {
        return parseHTML(`<html><body>${content}</body></html>`).document;
      }
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      desktop: {
        readGeneratedFile: async (digest: string) => {
          assert.equal(digest, "digest");
          return "original-pptx";
        },
        saveArtifactBytes: async (...args: unknown[]) => {
          calls.push(args);
          return args[0];
        },
      },
    },
  });
  try {
    const html = {
      ...artifact,
      language: "html",
      content:
        '<section class="slide"><h1>One</h1><p>Text</p></section><section data-slide="2"><h1>Two</h1><ul><li>Bullet</li></ul><script>secret()</script></section>',
    };
    assert.equal(canExportPresentation(html), true);
    assert.deepEqual(presentationSlides(html), [
      { title: "One", paragraphs: ["Text"] },
      { title: "Two", paragraphs: ["Bullet"] },
    ]);
    assert.equal(await exportPresentation(html, "Deck"), "Deck.pptx");
    assert.equal(
      await exportPresentation(
        {
          ...artifact,
          blob: true,
          filename: "Original.pptx",
          sourceDigest: "digest",
        },
        "Original.pptx",
      ),
      "Original.pptx",
    );
    assert.deepEqual(calls[1], ["Original.pptx", "original-pptx"]);
  } finally {
    for (const [key, value] of [
      ["DOMParser", parser],
      ["window", window],
    ] as const) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
