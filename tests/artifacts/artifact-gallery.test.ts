import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type ComponentProps } from "react";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import {
  gallerySection,
  galleryTime,
  galleryType,
  matchesQuery,
  matchesOwner,
} from "../../src/artifacts/gallery";
import { ArtifactsPage } from "../../src/artifacts/ArtifactsPage";
import type { Artifact } from "../../src/ui/components";
import { HostContext } from "../../src/host/HostContext";
import { webHost } from "../../shared/host";
import { collectArtifacts } from "../../src/artifacts/artifact-collection";
import type { Conversation } from "../../shared/types";

const at = (text: string) => new Date(text).getTime();
const now = at("2026-09-25T15:00:00");

test("the list groups by day for a week, then by month", () => {
  assert.equal(gallerySection(at("2026-09-25T09:00:00"), now), "Today");
  assert.equal(gallerySection(at("2026-09-24T23:00:00"), now), "Yesterday");
  assert.equal(gallerySection(at("2026-09-22T10:00:00"), now), "Sep 22");
  assert.equal(gallerySection(at("2026-09-10T10:00:00"), now), "September");
  assert.equal(gallerySection(at("2025-12-10T10:00:00"), now), "December 2025");
});

test("open times read like the reference's Viewed column", () => {
  assert.equal(galleryTime(now - 20_000, now), "just now");
  assert.equal(galleryTime(now - 12 * 60_000, now), "12m ago");
  assert.equal(galleryTime(at("2026-09-25T11:00:00"), now), "4h ago");
  assert.equal(galleryTime(at("2026-09-24T08:00:00"), now), "yesterday");
  assert.equal(galleryTime(at("2026-09-08T08:00:00"), now), "Sep 8");
  assert.equal(galleryTime(at("2025-09-08T08:00:00"), now), "Sep 8, 2025");
});

test("open times count the time that has passed, not the midnight between", () => {
  // Edited at 23:50, read at 00:10: 20 minutes ago, not yesterday.
  const shortly = at("2026-09-25T00:10:00");
  assert.equal(galleryTime(at("2026-09-24T23:50:00"), shortly), "20m ago");
  assert.equal(galleryTime(at("2026-09-24T09:00:00"), shortly), "15h ago");
  // A day or more is told by the calendar again.
  assert.equal(galleryTime(at("2026-09-24T00:05:00"), now), "yesterday");
  assert.equal(galleryTime(at("2026-09-23T23:50:00"), shortly), "Sep 23");
  assert.equal(galleryTime(at("2026-09-22T12:00:00"), shortly), "Sep 22");
});

test("types follow what the viewer shows and search matches every word", () => {
  const a = (language: string, name = "x"): Artifact => ({
    id: name,
    name,
    language,
    content: "",
  });
  assert.equal(galleryType(a("html")), "web");
  assert.equal(galleryType(a("tsx")), "web");
  assert.equal(galleryType(a("markdown")), "document");
  assert.equal(galleryType(a("mermaid")), "diagram");
  assert.equal(galleryType(a("text", "data.csv")), "data");
  assert.equal(galleryType(a("python")), "code");
  assert.equal(
    matchesQuery("Quarterly report", a("markdown"), "report q"),
    true,
  );
  assert.equal(matchesQuery("Quarterly report", a("markdown"), "html"), false);
  assert.equal(matchesQuery("Card", a("html"), "  "), true);
});

test("the page lists artifacts newest first under the templates (Group by: None)", () => {
  const artifacts: Artifact[] = [
    {
      id: "a",
      name: "Card",
      language: "html",
      content: "<p>card</p>",
      conversationId: "c",
      sourcePath: "/w/card.html",
      updatedAt: Date.now() - 5_000,
    },
    {
      id: "b",
      name: "Notes",
      language: "markdown",
      content: "# notes",
      conversationId: "c",
      sourcePath: "/w/notes.md",
      updatedAt: Date.now() - 3 * 24 * 60 * 60_000,
      pinned: true,
    },
  ];
  const noop = async () => {};
  const html = renderToStaticMarkup(
    createElement(ArtifactsPage, {
      artifacts,
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
  );
  assert.match(html, /<h1>Artifacts<\/h1>/);
  assert.match(html, /Card[^]*Notes/);
  assert.doesNotMatch(html, /aria-label="Today"/);
  assert.match(html, /aria-label="Group by: None"/);
  assert.match(html, /class="artifacts-tool artifacts-new" aria-label="New"/);
  assert.match(html, /Edited just now/);
  // The live header: All / Yours / Shared with you tabs, then search, grid,
  // type filter.
  assert.match(html, /role="tab" aria-selected="true"[^>]*tabindex="0">All</);
  assert.match(html, />Shared with you</);
  assert.match(html, /aria-label="Filter by type: All types"/);
  // The templates create a document, presentation or design here. The heading
  // names the section and the tiles end in the strip's 40px tail.
  assert.match(
    html,
    /<section class="artifacts-make" aria-labelledby="([^"]+)"><h2 id="\1">Make something new<\/h2>/,
  );
  assert.match(html, /<li aria-hidden="true" class="artifacts-make-tail">/);
  assert.doesNotMatch(html, /class="artifacts-make-card" aria-disabled="true"/);
  assert.doesNotMatch(html, /New artifact/);
});

const pageProps: ComponentProps<typeof ArtifactsPage> = {
  artifacts: [],
  onOpenArtifact() {},
  onCreate() {},
  async onComment() {},
  authorName: "You",
  onShareRequestConsumed() {},
  async onDuplicate() {},
  async onPin() {},
  onDelete() {},
  width: 68,
  onResize() {},
  onClose() {},
  onError() {},
  onNotify() {},
};

test("library first-use copy, ObjectShapes and both empty-state variants match the live host", () => {
  const html = renderToStaticMarkup(createElement(ArtifactsPage, pageProps));
  assert.match(html, /What will you build with artifacts\?/);
  assert.match(html, /If you can dream it, you can build it\./);
  assert.match(
    html,
    /Take apps, games, templates, and tools from thought to reality\./,
  );
  assert.match(html, /width="96" height="96" viewBox="0 0 96 96"/);
  assert.match(html, />New artifact</);
  assert.doesNotMatch(html, /class="artifacts-owner-tabs"/);
  const first = renderToStaticMarkup(
    createElement(ArtifactsPage, { ...pageProps, emptyVariant: "first" }),
  );
  assert.match(first, /Create your first artifact/);
  assert.match(first, /Artifacts you build with Claudex appear here\./);
  assert.doesNotMatch(first, /artifacts-empty-illustration/);
});

test("library project and shared ownership come from persisted conversation metadata", () => {
  const conversation = {
    id: "conversation",
    title: "Shared",
    projectId: "project",
    sessionAuthors: { ownerAccountUuid: "owner", viewerAccountUuid: "viewer" },
    turns: [
      {
        items: [
          {
            id: "message",
            type: "agentMessage",
            text: "```markdown\n# Report\n```",
          },
        ],
      },
    ],
  } as Conversation;
  const [artifact] = collectArtifacts([conversation], [], {
    version: 1,
    copies: [],
    pinned: [],
  });
  assert.equal(artifact.projectId, "project");
  assert.equal(artifact.sharedWithYou, true);
  assert.equal(matchesOwner(artifact, "shared"), true);
  assert.equal(matchesOwner(artifact, "yours"), false);
  assert.equal(matchesOwner(artifact, "projects"), true);
  assert.equal(matchesOwner(artifact, "pinned"), false);
  assert.equal(matchesOwner({ ...artifact, pinned: true }, "pinned"), true);
  const [copy] = collectArtifacts([], [], {
    version: 1,
    pinned: [],
    copies: [
      {
        libraryId: "copy",
        originConversationId: "conversation",
        name: "Copy",
        language: "markdown",
        content: "# Copy",
        createdAt: 1,
      },
    ],
  });
  assert.equal(matchesOwner(copy, "yours"), true);
  assert.equal(matchesOwner(copy, "projects"), false);
});

test("library tabs filter real artifacts, gate optional tabs and limit shared search to the newest 60", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const own: Artifact = {
    id: "own",
    name: "Personal",
    content: "# Own",
    language: "markdown",
    pinned: true,
    projectId: "project",
  };
  const shared = Array.from({ length: 61 }, (_, index): Artifact => ({
    id: `shared-${index}`,
    sourcePath: `/shared/${index}.md`,
    name: `Shared ${index}`,
    content: "# Shared",
    language: "markdown",
    sharedWithYou: true,
    updatedAt: index + 1,
  }));
  const props = {
    ...pageProps,
    artifacts: [own, ...shared],
    projects: [{ id: "project", name: "My project" }],
  };
  const click = async (button: Element) =>
    act(async () => {
      button.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
  const tab = (label: string) =>
    [...document.querySelectorAll('.artifacts-owner-tabs [role="tab"]')].find(
      (element) => element.textContent === label,
    )!;
  try {
    await act(async () => root.render(createElement(ArtifactsPage, props)));
    assert.deepEqual(
      [...document.querySelectorAll('.artifacts-owner-tabs [role="tab"]')].map(
        (element) => element.textContent,
      ),
      ["All", "Pinned", "Yours", "Shared with you", "Projects"],
    );
    await click(tab("Pinned"));
    assert.equal(document.querySelectorAll('[role="listitem"]').length, 1);
    await click(tab("Projects"));
    assert.equal(
      document.querySelector(".artifacts-section h2")?.textContent,
      "My project",
    );
    await click(tab("Yours"));
    assert.equal(document.querySelectorAll('[role="listitem"]').length, 1);
    await click(tab("Shared with you"));
    assert.equal(document.querySelectorAll('[role="listitem"]').length, 60);
    assert.equal(
      document.querySelector(".artifacts-search-note")?.textContent,
      "Only the 60 most recent artifacts shared with you are searchable here.",
    );
    assert.ok(
      ![...document.querySelectorAll(".artifacts-row-name")].some(
        (element) => element.textContent === "Shared 0",
      ),
    );
    await click(
      document.querySelector('[aria-label="Search your artifacts"]')!,
    );
    assert.equal(
      document.querySelector("input")?.getAttribute("aria-label"),
      "Search your artifacts",
    );
    const escape = new window.Event("keydown", { bubbles: true });
    Object.defineProperty(escape, "key", { value: "Escape" });
    await act(async () => {
      document.querySelector("input")!.dispatchEvent(escape);
    });
    assert.equal(document.querySelector("input"), null);
    await act(async () =>
      root.render(
        createElement(ArtifactsPage, {
          ...props,
          pinnedTabEnabled: false,
          projectsTabEnabled: false,
          sharedTabEnabled: false,
        }),
      ),
    );
    assert.deepEqual(
      [...document.querySelectorAll('.artifacts-owner-tabs [role="tab"]')].map(
        (element) => element.textContent,
      ),
      ["All"],
    );
    assert.equal(
      document.querySelector('[role="tab"]')?.getAttribute("aria-selected"),
      "true",
    );
    assert.equal(document.querySelector(".artifacts-search-note"), null);
    await act(async () =>
      root.render(
        createElement(ArtifactsPage, {
          ...props,
          artifacts: shared.slice(0, 2),
        }),
      ),
    );
    assert.equal(tab("Pinned"), undefined);
    await click(tab("Shared with you"));
    assert.equal(document.querySelector(".artifacts-search-note"), null);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});

// The signed-in web capture at 1440x900 exposes this precise owner-tab variant.
test("web gallery defaults to the live three tabs and grid without native import or surface tabs", () => {
  const html = renderToStaticMarkup(
    createElement(
      HostContext.Provider,
      { value: webHost },
      createElement(ArtifactsPage, {
        ...pageProps,
        artifacts: [
          {
            id: "one",
            name: "Card",
            content: "<p>Card</p>",
            language: "html",
            pinned: true,
            projectId: "project",
          },
        ],
        async onImportArtifact() {},
      }),
    ),
  );
  const { document } = parseHTML(html);
  assert.deepEqual(
    [...document.querySelectorAll(".artifacts-owner-tabs [role=tab]")].map(
      (el) => el.textContent,
    ),
    ["All", "Yours", "Shared with you"],
  );
  assert.ok(document.querySelector(".artifacts-grid"));
  assert.ok(
    document.querySelector('[role="tabpanel"] ul[aria-label="Artifacts"] > li'),
  );
  assert.ok(document.querySelector(".artifacts-card-name[data-no-translate]"));
  assert.equal(
    document
      .querySelector('[role="img"][aria-label="Private"]')
      ?.getAttribute("aria-hidden"),
    "false",
  );
  assert.ok(document.querySelector('[aria-label="List view"]'));
  assert.ok(document.querySelector('[aria-label="Filter by type: All types"]'));
  assert.equal(document.querySelector(".artifacts-mode-tabs"), null);
  assert.equal(document.querySelector(".artifacts-design-notice"), null);
  assert.doesNotMatch(html, /Import from link/);
});
