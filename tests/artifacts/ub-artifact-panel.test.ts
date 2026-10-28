import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  artifactCollapseWidth,
  artifactOverlayWidth,
  collapsesSidebar,
  coversConversation,
  restoresSidebar,
} from "../../src/artifacts/narrow-layout";
import {
  ReportArtifactDialog,
  reportReasons,
  reportUnavailable,
} from "../../src/artifacts/ReportArtifactDialog";
import {
  ArtifactGridCard,
  ArtifactsSkeleton,
  copyLinkUnavailable,
  gridCardEntries,
  liveThumbnail,
  shareLink,
} from "../../src/artifacts/ArtifactGridCard";
import { ArtifactMetadataProvider } from "../../src/artifacts/artifact-metadata";
import { ArtifactsPage } from "../../src/artifacts/ArtifactsPage";
import type { Artifact } from "../../src/ui/components";

const noop = async () => {};
const page: Artifact = {
  id: "p",
  name: "Counter card",
  language: "html",
  content: "<h1>Counter</h1>",
  conversationId: "c",
  sourcePath: "/w/card.html",
  updatedAt: Date.now() - 60_000,
};

test("a narrow window collapses the sidebar and restores only what it collapsed", () => {
  assert.ok(artifactCollapseWidth < artifactOverlayWidth);
  assert.equal(collapsesSidebar(640, true), true);
  assert.equal(collapsesSidebar(640, false), false);
  assert.equal(collapsesSidebar(1280, true), false);
  assert.equal(restoresSidebar(true, false), true);
  // The user reopened it while the panel was open: leave it.
  assert.equal(restoresSidebar(true, true), false);
  assert.equal(restoresSidebar(false, false), false);
  assert.equal(coversConversation(969), true);
  assert.equal(coversConversation(1280), false);
});

test("Report artifact without its artifact offers the form and says why it cannot send", () => {
  const html = renderToStaticMarkup(
    createElement(ReportArtifactDialog, { onClose() {} }),
  );
  assert.match(html, /role="dialog"/);
  assert.match(html, /Report Artifact/);
  assert.match(html, /Why are you reporting this\?/);
  assert.match(html, /Select report reason/);
  assert.equal(reportReasons.length, 13);
  for (const reason of reportReasons) assert.ok(html.includes(reason));
  // The name, email and notes come after a reason is chosen.
  assert.doesNotMatch(html, /<textarea/);
  assert.match(html, /<button class="publish-dialog-publish" disabled=""/);
  assert.match(html, />Close<\/button>/);
  assert.ok(html.includes(reportUnavailable.replace("’", "’")));
  assert.match(html, /aria-describedby="report-dialog-unavailable"/);
});

test("the grid card menu follows the reference and explains a missing link", () => {
  const actions = {
    onPin: noop,
    onDuplicate: noop,
    onDelete() {},
    onDownload() {},
    onCopyLink() {},
    onError() {},
    onRename() {},
  };
  const labels = (entries: ReturnType<typeof gridCardEntries>) =>
    entries.map((e) => ("label" in e ? e.label : "—"));
  const conversation = gridCardEntries(page, undefined, actions);
  assert.deepEqual(labels(conversation), [
    "Pin",
    "Rename",
    "Duplicate",
    "Copy link",
    "Download",
  ]);
  const copy = conversation[3];
  assert.ok("label" in copy && copy.disabled);
  assert.ok("label" in copy && copy.title === copyLinkUnavailable);
  const library = gridCardEntries(
    { ...page, libraryId: "l", pinned: true },
    "claudex-share://x",
    actions,
  );
  assert.deepEqual(labels(library), [
    "Unpin",
    "Rename",
    "Duplicate",
    "Copy link",
    "Download",
    "—",
    "Delete",
  ]);
  assert.ok("label" in library[3] && !library[3].disabled);
  assert.equal(
    shareLink({ identity: "i", visibility: "private", showInList: false }),
    undefined,
  );
  assert.equal(
    shareLink({
      identity: "i",
      visibility: "link",
      showInList: true,
      url: "local",
      scope: "public",
      publicUrl: "https://example.test/a",
    }),
    "https://example.test/a",
  );
});

test("pages preview live in a frame with no sandbox permissions", () => {
  assert.equal(liveThumbnail(page), true);
  assert.equal(
    liveThumbnail({ ...page, language: "svg", sourcePath: "/w/a.svg" }),
    true,
  );
  assert.equal(
    liveThumbnail({ ...page, language: "tsx", sourcePath: "/w/a.tsx" }),
    false,
  );
  const html = renderToStaticMarkup(
    createElement(ArtifactGridCard, {
      artifact: page,
      name: page.name,
      type: "web",
      time: page.updatedAt,
      viewed: false,
      now: Date.now(),
      onOpen() {},
      onPin: noop,
      onDuplicate: noop,
      onDelete() {},
      onDownload() {},
      onCopyLink() {},
      onError() {},
    }),
  );
  assert.match(html, /<iframe[^>]*sandbox=""/);
  assert.match(html, /<iframe[^>]*tabindex="-1"/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /aria-label="More options for Counter card"/);
  assert.match(html, /Edited 1m ago/);
  const code = renderToStaticMarkup(
    createElement(ArtifactGridCard, {
      artifact: { ...page, language: "python", content: "print(1)" },
      name: "Script",
      type: "code",
      viewed: false,
      now: Date.now(),
      onOpen() {},
      onPin: noop,
      onDuplicate: noop,
      onDelete() {},
      onDownload() {},
      onCopyLink() {},
      onError() {},
    }),
  );
  assert.doesNotMatch(code, /<iframe/);
  assert.match(code, /artifacts-card-excerpt[^>]*>print\(1\)/);
});

test("the page shows placeholders until the profile's notes are read", () => {
  assert.match(
    renderToStaticMarkup(createElement(ArtifactsSkeleton, { view: "grid" })),
    /aria-label="Loading artifacts"/,
  );
  const html = renderToStaticMarkup(
    createElement(ArtifactMetadataProvider, {
      accountId: "a",
      legacyOwner: false,
      conversationIds: new Set(["c"]),
      children: createElement(ArtifactsPage, {
        artifacts: [page],
        onOpenArtifact() {},
        onCreate() {},
        onComment: noop,
        authorName: "Ada",
        onShareRequestConsumed() {},
        onDuplicate: noop,
        onPin: noop,
        onDelete() {},
        width: 68,
        onResize() {},
        onClose() {},
        onError() {},
        onNotify() {},
      }),
    }),
  );
  assert.match(html, /artifacts-skeleton-list/);
  assert.doesNotMatch(html, /Counter card/);
});
