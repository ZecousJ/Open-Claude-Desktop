import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  publishTitle,
  type PublishContentState,
} from "../../src/artifacts/PublishArtifactModal";
import { PublishArtifactContent } from "../../src/artifacts/PublishArtifactContent";
import {
  canPublishFile,
  publishableText,
} from "../../src/artifacts/FileViewerHeader";
import type { HostedShare, SharingStatus } from "../../shared/sharing-api";

const publicUrl = `https://share.example.test/s/${"a".repeat(43)}`;
const link: HostedShare = {
  id: "7",
  kind: "artifact",
  sourceKey: "card",
  title: "Card",
  url: publicUrl,
  createdAt: 1,
  snapshotAt: 1,
  status: "active",
};

const render = (state: Partial<PublishContentState> = {}) =>
  renderToStaticMarkup(
    createElement(PublishArtifactContent, {
      share: null,
      liveLinks: 0,
      busy: false,
      copied: false,
      title: "Card",
      onPublish() {},
      onCopy() {},
      onOpenLink() {},
      onUnpublish() {},
      onUsagePolicy() {},
      ...state,
    }),
  );

// The Publish modal.
test("before publishing: what it means, the title, the usage note, Publish & copy link", () => {
  const html = render({ usagePolicyUrl: "https://service.example.test/usage" });
  assert.match(
    html,
    /Publishing this Artifact will make it accessible to anyone on the internet and potentially visible in search engine results\. Your chat will remain private\./,
  );
  assert.match(html, /<div data-no-translate="true">Card<\/div>/);
  assert.match(
    html,
    /The <a href="https:\/\/service\.example\.test\/usage">Usage Policy<\/a> prohibits use of Claudex/,
  );
  assert.match(
    html,
    /<button type="button" class="primary">Publish &amp; copy link<\/button>/,
  );
  assert.doesNotMatch(html, /Unpublish|Copy link|[Ee]mbed/);
  // Without a policy page only the request stays; an untitled artifact has a name.
  const plain = render({ title: "" });
  assert.doesNotMatch(plain, /Usage Policy/);
  assert.match(plain, /Don’t share personal information/);
  assert.match(plain, /Claudex Artifact/);
  assert.match(render({ busy: true }), /aria-busy="true"[^>]*>Publishing…</);
  assert.equal(publishTitle(false, "artifact"), "Publish artifact");
});

test("published: the version's public link, Copy link, the version count and Unpublish", () => {
  const html = render({ share: link, liveLinks: 1 });
  assert.match(html, /Published \(Public\)/);
  assert.match(
    html,
    /Anyone on the web with the link can view the Artifact only\. Your chat will remain private\./,
  );
  assert.ok(html.includes(`>${publicUrl}</a>`));
  assert.match(
    html,
    /class="publish-artifact-copy">.*Copy public link<\/button>/,
  );
  assert.match(render({ share: link, copied: true }), /Link copied/);
  assert.doesNotMatch(html, /versions of this artifact/);
  assert.match(
    render({ share: link, liveLinks: 3 }),
    /3 versions of this artifact have public links\./,
  );
  assert.match(html, /class="secondary">Unpublish<\/button>/);
  assert.match(
    html,
    /Unpublishing removes the public link for every version of this artifact\. Anyone with a link loses access, and the links can’t be restored\./,
  );
  assert.doesNotMatch(html, /Publish &amp; copy link/);
  assert.equal(publishTitle(true, "artifact"), "Artifact published");
  // The file panel keeps its title.
  assert.equal(publishTitle(true, "file"), "Publish artifact");
});

test("a page the administrator took down says so and can only be unpublished", () => {
  const html = render({
    share: { ...link, status: "disabled", disabledReason: "Spam" },
  });
  assert.match(html, /Removed by the administrator/);
  assert.match(
    html,
    /Your administrator removed this page\. Its link no longer opens\./,
  );
  assert.match(html, /Reason: Spam/);
  assert.doesNotMatch(html, /Copy link|publish-artifact-link/);
  assert.match(html, />Unpublish<\/button>/);
});

test("a link stopped elsewhere while the dialog is open shows the banner", () => {
  assert.match(
    render({ notice: "Artifact no longer published" }),
    /<div class="publish-artifact-notice" role="status">Artifact no longer published<\/div>/,
  );
});

const status: SharingStatus = {
  conversations: true,
  artifacts: true,
  maxSnapshotBytes: 8 * 1024 * 1024,
  maxArtifactBytes: 1024,
};
const file = (over: Record<string, unknown> = {}) => ({
  id: "f",
  name: "report.md",
  language: "markdown",
  content: "# Report",
  surface: "file" as const,
  sourcePath: "/workspace/report.md",
  ...over,
});

test("Publish artifact is offered only when the service takes the file", () => {
  assert.equal(canPublishFile(status, file()), true);
  assert.equal(canPublishFile(status, file({ language: "ts" })), true);
  // No hosted sharing, links turned off or blocked.
  assert.equal(canPublishFile(null, file()), false);
  assert.equal(canPublishFile({ ...status, artifacts: false }, file()), false);
  // Binary files have no public page.
  assert.equal(
    publishableText(file({ blob: true, mime: "image/png", content: "" })),
    false,
  );
  assert.equal(
    canPublishFile(status, file({ blob: true, mime: "application/pdf" })),
    false,
  );
  // Over the service's limit (bytes, not characters).
  assert.equal(
    canPublishFile(status, file({ content: "é".repeat(600) })),
    false,
  );
});

// Hosted controls exist only behind the service's sharing status (R1);
// nothing may suggest invitations, reports or a directory of shared work.
test("invitation, private-link and sharing wording stays on the sharing surfaces", () => {
  // The public-link wording belongs to the sharing surfaces only; the
  // original's invitation and private-link controls show greyed in the
  // share popover, and the gallery's owner filter offers Shared with you.
  const publicWording: [RegExp, string[]][] = [
    [/Invite people/, ["PublishArtifactModal.tsx"]],
    [/Copy private link/, []],
    [
      /Shared with you/,
      // Chats shared with the account: their page.
      [
        "ArtifactsPage.tsx",
        "SharedChatPage.tsx",
        "search-filters.ts",
        // Explicit skill provenance is a source taxonomy, not a claim that
        // an artifact or conversation has been shared.
        "customize-list.ts",
      ],
    ],
    [
      /Open in web/,
      [
        "ArtifactChrome.tsx",
        "useArtifactChromeState.tsx",
        "ArtifactTitleMenu.tsx",
      ],
    ],
    // the title menu's row and its dialog, which sends the report to the
    // administrator of the account's Claudex service.
    [
      /Report artifact/,
      [
        "ArtifactChrome.tsx",
        "ArtifactTitleMenu.tsx",
        "ReportArtifactDialog.tsx",
      ],
    ],
    [
      /Publish artifact/,
      [
        "FileViewerHeader.tsx",
        "PublishArtifactModal.tsx",
        "PublishArtifactContent.tsx",
      ],
    ],
    [
      /Anyone with the link/,
      [
        // A published artifact's card names its reach.
        "ArtifactCard.tsx",
        "ConversationShareDialog.tsx",
        "ChatSharePopover.tsx",
        "ConversationHeader.tsx",
        // An artifact already shared by a public link says so on its card and
        // in the Artifacts list.
        "ArtifactCard.tsx",
        "ArtifactsPage.tsx",
        "ArtifactRow.tsx",
        "ArtifactGridCard.tsx",
        // Privacy → Shared chats names each link's reach under its name.
        "Privacy.tsx",
        // Share artifact: a version's link and who can open it.
        "ArtifactShareDialog.tsx",
        // The standalone Share button reads the same hosted audience
        // record as that dialog; it never guesses public/private reach.
        "artifact-access.ts",
      ],
    ],
  ];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      // The language catalogs hold the wording of every surface in each language.
      if (entry.isDirectory()) {
        if (entry.name !== "catalogs") walk(file);
      } else if (/\.tsx?$/.test(entry.name)) files.push(file);
    }
  };
  walk(fileURLToPath(new URL("../../src", import.meta.url)));
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const [pattern, owners] of publicWording)
      if (!owners.includes(path.basename(file)))
        assert.doesNotMatch(source, pattern, `${file} shows ${pattern}`);
  }
  // Open in web acts only for a published version (greyed otherwise).
  const chrome = fs.readFileSync(
    fileURLToPath(
      new URL("../../src/artifacts/ArtifactTitleMenu.tsx", import.meta.url),
    ),
    "utf8",
  );
  assert.match(chrome, /disabled=\{!published\}[\s\S]{0,400}Open in web/);
});

test("any text artifact keeps its sharing record; only HTML and SVG get a local link", () => {
  // electron/ipc/artifacts.ts imports Electron, which node tests cannot load.
  const source = fs.readFileSync(
    fileURLToPath(new URL("../../electron/ipc/artifacts.ts", import.meta.url)),
    "utf8",
  );
  const schema = /const artifactShareSchema = z\.object\(\{[\s\S]*?\}\);/.exec(
    source,
  )?.[0];
  assert.ok(schema);
  // A markdown or code artifact with a public link syncs (content follows,
  // Only you stops it) instead of failing validation.
  assert.doesNotMatch(schema, /z\.enum\(\["html", "svg"\]\)/);
  assert.match(
    source,
    /visibility === "link" && !locallyShareable\.has\(input\.language\)/,
  );
});
