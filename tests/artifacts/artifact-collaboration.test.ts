import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactPanel } from "../../src/artifacts/FileViewer";
import {
  ArtifactCard,
  ArtifactSelection,
  sameArtifact,
} from "../../src/artifacts/ArtifactCard";
import {
  ArtifactChrome,
  commentStorageKey,
  readComments,
} from "../../src/artifacts/ArtifactChrome";
import { savedMessage } from "../../src/artifacts/artifact-actions";
import type { Artifact } from "../../src/ui/components";
const artifact: Artifact = {
  id: "a",
  name: "Card",
  language: "html",
  content: "<button>Test</button>",
  sourcePath: "/synthetic/card.html",
  conversationId: "one",
};
test("a card being written shows only its file name, and a failed one opens nothing", () => {
  const card = (props: { artifact: Artifact; failure?: string }) =>
    renderToStaticMarkup(
      createElement(ArtifactCard, { ...props, onArtifact() {} }),
    );
  const writing = card({
    artifact: {
      ...artifact,
      name: "Interface card",
      filename: "synthetic-interface-card.html",
      generating: true,
    },
  });
  assert.match(writing, /<strong>synthetic-interface-card<\/strong>/);
  assert.match(writing, /<small>Artifact<\/small>/);
  assert.doesNotMatch(writing, /Share |Only you/);
  assert.match(writing, /Open synthetic-interface-card/);
  const failed = card({
    artifact: { ...artifact, filename: "card.html" },
    failure: "File changes stopped",
  });
  assert.match(failed, /data-state="failed"/);
  assert.match(failed, /File changes stopped/);
  assert.doesNotMatch(failed, /<button/);
  const ready = card({ artifact });
  // Share opens Publish: without a service that takes artifact links
  // (none in a node test) the card offers no Share.
  assert.doesNotMatch(ready, /Share Card/);
  assert.match(ready, /Only you/);
});
test("file and collaboration entries have distinct controls and accessible surfaces", () => {
  const render = (surface: "artifact" | "file") =>
    renderToStaticMarkup(
      createElement(ArtifactPanel, {
        artifact: { ...artifact, surface },
        width: surface === "artifact" ? 68 : 50,
        onClose() {},
        onError() {},
      }),
    );
  assert.match(render("file"), /File view mode/);
  assert.doesNotMatch(render("file"), /More comment options/);
  assert.match(render("artifact"), /Artifact panel: Card/);
  assert.match(render("artifact"), /aria-valuenow="68"/);
  assert.match(render("artifact"), /More comment options/);
  assert.doesNotMatch(render("artifact"), /File view mode/);
  assert.match(render("artifact"), /sandbox="allow-scripts"/);
});
test("the expanded header leaves by Chat only, the split header by Close", () => {
  const render = (expanded: boolean) =>
    renderToStaticMarkup(
      createElement(ArtifactChrome, {
        artifact: { ...artifact, surface: "artifact" },
        expanded,
        onExpand() {},
        onClose() {},
        onRefresh() {},
        onError() {},
      }),
    );
  assert.match(render(true), /artifact-chat-button[^]*Show chat/);
  assert.doesNotMatch(render(true), /aria-label="Close"/);
  assert.doesNotMatch(render(true), /aria-label="Expand"/);
  assert.match(render(false), /aria-label="Close"/);
  assert.match(render(false), /aria-label="Expand"/);
  assert.equal(
    savedMessage("/Users/me/Downloads/card.html"),
    "Saved card.html",
  );
  assert.equal(savedMessage("C:\\Users\\me\\card.html"), "Saved card.html");
});
test("old and new cards reflect shared open state only within their conversation", () => {
  const current = {
    ...artifact,
    id: "updated",
    surface: "artifact" as const,
    content: "updated",
  };
  const html = renderToStaticMarkup(
    createElement(
      ArtifactSelection.Provider,
      { value: current },
      createElement(ArtifactCard, { artifact, onArtifact() {} }),
    ),
  );
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /Hide Card/);
  assert.equal(
    sameArtifact(artifact, { ...current, conversationId: "two" }),
    false,
  );
  assert.notEqual(
    commentStorageKey(artifact, "account-a"),
    commentStorageKey({ ...artifact, conversationId: "two" }, "account-a"),
  );
  assert.equal(
    commentStorageKey(artifact, "account-a"),
    commentStorageKey(current, "account-a"),
  );
});
test("persisted comment data rejects malformed coordinates and invalid records", () => {
  const valid = {
    id: "c",
    text: "synthetic",
    x: 0.5,
    y: 0.25,
    createdAt: 1,
    resolved: false,
  };
  assert.deepEqual(
    readComments(
      JSON.stringify([valid, { ...valid, x: 2 }, { ...valid, text: 5 }, null]),
    ),
    [valid],
  );
  assert.deepEqual(readComments("broken"), []);
  assert.deepEqual(readComments("{}"), []);
});

test("artifact names use stable source identity across revisions and reject malformed stored metadata", async () => {
  const { artifactIdentity } =
    await import("../../src/artifacts/artifact-metadata");
  const { readArtifactMetadata } =
    await import("../../src/artifacts/artifact-storage");
  const key = artifactIdentity(artifact);
  assert.equal(
    key,
    artifactIdentity({
      ...artifact,
      id: "new-file-event",
      sourceDigest: "new",
      content: "updated",
    }),
  );
  assert.notEqual(
    key,
    artifactIdentity({ ...artifact, conversationId: "other" }),
  );
  assert.deepEqual(
    readArtifactMetadata(
      JSON.stringify({
        [key]: { name: "Renamed", updatedAt: 12 },
        bad: { name: " ", updatedAt: 1 },
        long: { name: "a".repeat(201), updatedAt: 2 },
      }),
    ),
    { [key]: { name: "Renamed", updatedAt: 12 } },
  );
  assert.deepEqual(readArtifactMetadata("null"), {});
  assert.deepEqual(readArtifactMetadata("broken"), {});
});

test("artifact update age follows later content or rename while preserving its display name", async () => {
  const { applyArtifactMetadata } =
    await import("../../src/artifacts/artifact-metadata");
  const source = { ...artifact, updatedAt: 100 };
  assert.equal(applyArtifactMetadata(source).updatedAt, 100);
  assert.equal(
    applyArtifactMetadata(source, { name: "Renamed", updatedAt: 200 })
      .updatedAt,
    200,
  );
  const updated = applyArtifactMetadata(
    { ...source, updatedAt: 300 },
    { name: "Renamed", updatedAt: 200 },
  );
  assert.equal(updated.updatedAt, 300);
  assert.equal(updated.artifact.name, "Renamed");
  assert.equal(applyArtifactMetadata(artifact).updatedAt, undefined);
  assert.equal(
    applyArtifactMetadata({ ...artifact, updatedAt: NaN }).updatedAt,
    undefined,
  );
});
