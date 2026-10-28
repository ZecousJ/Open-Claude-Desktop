import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, lazy, Suspense, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { Conversation } from "../../shared/types";
import type { RowMenuHandlers } from "../../src/sidebar/RowMenu";

(globalThis as { __CLAUDEX_SURFACE__?: string }).__CLAUDEX_SURFACE__ = "web";
const { ConversationTitle, titleMenuEntries } =
  await import("../../src/conversation/ConversationTitle");
const { rowMenuEntries } = await import("../../src/sidebar/row-menu-entries");
const { ChatSharePopover } =
  await import("../../src/conversation/ChatSharePopover");

const conversation: Conversation = {
  id: "title-web",
  title: "Number 123",
  mode: "chat",
  providerId: "fixture",
  model: "Opus 5.5",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns: [],
};
const noop = () => {};

test("web Chat and Cowork export from the row; a web Code session, a cloud one, has no Export", () => {
  const exported: string[] = [];
  for (const [mode, expected] of [
    ["chat", []],
    ["cowork", []],
    ["code", []],
  ] as const) {
    const entries = titleMenuEntries({ ...conversation, mode }, [], false, {
      onPin: noop,
      onRename: noop,
      onMoveToProject: noop,
      onCreateProject: noop,
      onOpenProjects: noop,
      onArchive: noop,
      onDelete: noop,
      onExport: () => {
        exported.push(mode);
      },
    });
    const exports = entries.filter(
      (entry) => "label" in entry && entry.label.startsWith("Export"),
    );
    assert.deepEqual(
      exports.map((entry) => ("label" in entry ? entry.label : "")),
      [...expected],
      mode,
    );
    for (const entry of exports) if ("onSelect" in entry) entry.onSelect?.();
  }
  assert.deepEqual(exported, []);
});

test("web Chat rows retain export, a web Code row has none, and the desktop keeps only Code's", () => {
  let exported = 0;
  const on: RowMenuHandlers = {
    openInSplit: noop,
    openInWindow: noop,
    openIn: noop,
    togglePin: noop,
    toggleUnread: noop,
    rename: noop,
    share: noop,
    copyLink: noop,
    moveToProject: noop,
    toggleArchive: noop,
    remove: noop,
    exportConversation: () => exported++,
  };
  const base = {
    projects: [],
    platform: "linux",
    can: {
      splitView: false,
      newWindow: false,
      folder: false,
      terminal: false,
      share: false,
      copyLink: false,
      export: true,
    },
    moveToGroup: { label: "Move to group", submenu: [] },
    on,
  };
  const exportEntry = (entries: ReturnType<typeof rowMenuEntries>) =>
    entries.find((entry) => "label" in entry && entry.label === "Export");
  for (const mode of ["chat", "cowork", "code"] as const) {
    const value = { ...conversation, mode };
    const item = exportEntry(
      rowMenuEntries({ ...base, conversation: value, surface: "web" }),
    );
    if (mode === "code") assert.equal(item, undefined);
    else {
      assert.ok(item && "onSelect" in item);
      item.onSelect!();
    }
    const desktop = exportEntry(
      rowMenuEntries({ ...base, conversation: value, surface: "desktop" }),
    );
    assert.equal(Boolean(desktop), mode === "code", mode);
    assert.equal(
      exportEntry(
        rowMenuEntries({
          ...base,
          conversation: { ...value, incognito: true },
          surface: "web",
        }),
      ),
      undefined,
    );
    assert.equal(
      exportEntry(
        rowMenuEntries({
          ...base,
          can: { ...base.can, export: false },
          conversation: value,
          surface: "web",
        }),
      ),
      undefined,
    );
  }
  assert.equal(exported, 2);
});

test("web title menu aligns to its caret, clamps at both edges, and calls the real share action", async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    innerWidth: globalThis.innerWidth,
    innerHeight: globalThis.innerHeight,
  };
  const { window, document } = parseHTML(
    '<html><body><div id="root"></div></body></html>',
  );
  Object.assign(globalThis, {
    window,
    document,
    innerHeight: 900,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    for (const [viewportWidth, caretLeft, expectedLeft] of [
      [1440, 392, 250],
      [390, 80, 8],
      [390, 365, 212],
    ]) {
      Object.assign(window, { innerWidth: viewportWidth });
      Object.assign(globalThis, { innerWidth: viewportWidth });
      let shared = 0;
      await act(async () =>
        root.render(
          createElement(ConversationTitle, {
            key: `${viewportWidth}-${caretLeft}`,
            conversation,
            projects: [],
            running: false,
            actions: {
              onPin: noop,
              onRename: noop,
              onMoveToProject: noop,
              onCreateProject: noop,
              onOpenProjects: noop,
              onArchive: noop,
              onDelete: noop,
              onShare: () => shared++,
              onExport: noop,
            },
          }),
        ),
      );
      const trigger = document.querySelector<HTMLButtonElement>(
        ".thread-menu-trigger",
      )!;
      trigger.getBoundingClientRect = () =>
        ({ left: caretLeft, right: caretLeft + 28, bottom: 38 }) as DOMRect;
      await act(async () => {
        trigger.dispatchEvent(new window.Event("click", { bubbles: true }));
      });
      const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
      assert.equal(menu.style.width, "170px");
      assert.ok(menu.classList.contains("conversation-title-menu"));
      assert.equal(menu.style.left, `${expectedLeft}px`);
      assert.equal(menu.style.top, "44px");
      assert.doesNotMatch(menu.textContent!, /Export/);
      const share = [
        ...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
      ].find((entry) => entry.textContent?.includes("Share session"))!;
      assert.ok(share.querySelector('[data-icon="Share"]'));
      await act(async () => {
        share.dispatchEvent(new window.Event("click", { bubbles: true }));
      });
      assert.equal(shared, 1);
      assert.equal(document.querySelector('[role="menu"]'), null);
    }
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});

for (const warm of [false, true]) {
  for (const closing of ["Close", "Escape"] as const) {
    test(`title-menu Share returns focus to its caret after ${closing}, ${warm ? "warm" : "cold"} popover`, async () => {
      const previous = {
        window: globalThis.window,
        document: globalThis.document,
        innerWidth: globalThis.innerWidth,
        innerHeight: globalThis.innerHeight,
      };
      const { window, document } = parseHTML(
        "<html><body><main></main></body></html>",
      );
      let focused: HTMLElement | undefined;
      const previousFocus = window.HTMLElement.prototype.focus;
      // Linkedom does not implement browser focus bookkeeping. Retain the
      // real connected node, and return BODY after that node is removed.
      Object.defineProperty(document, "activeElement", {
        configurable: true,
        get: () => (focused?.isConnected ? focused : document.body),
      });
      window.HTMLElement.prototype.focus = function () {
        focused = this;
      };
      Object.assign(window, {
        innerWidth: 1440,
        innerHeight: 900,
        desktop: { accountProfile: async () => undefined },
      });
      Object.assign(globalThis, {
        window,
        document,
        innerWidth: 1440,
        innerHeight: 900,
        IS_REACT_ACT_ENVIRONMENT: true,
      });
      let resolveChunk!: (module: { default: typeof ChatSharePopover }) => void;
      const chunk = new Promise<{ default: typeof ChatSharePopover }>(
        (resolve) => {
          resolveChunk = resolve;
        },
      );
      // Gate the actual popover component like its real lazy chunk. Warming
      // it through Header Share reproduces the same-commit menu-unmount race.
      const Popover = lazy(() => chunk);
      function Harness() {
        const [sharing, setSharing] = useState(false);
        return createElement(
          "div",
          null,
          createElement(
            "button",
            {
              className: "header-share-trigger",
              onClick: () => setSharing(true),
            },
            "Share",
          ),
          createElement(ConversationTitle, {
            conversation,
            projects: [],
            running: false,
            actions: {
              onPin: noop,
              onRename: noop,
              onMoveToProject: noop,
              onCreateProject: noop,
              onOpenProjects: noop,
              onArchive: noop,
              onDelete: noop,
              onShare: () => setSharing(true),
            },
          }),
          sharing &&
            createElement(
              Suspense,
              { fallback: null },
              createElement(Popover, {
                status: {
                  conversations: true,
                  artifacts: true,
                  maxSnapshotBytes: 1000,
                  maxArtifactBytes: 1000,
                },
                state: {
                  share: null,
                  busy: false,
                  confirmStop: false,
                  copied: false,
                  repository: false,
                },
                onClose: () => setSharing(false),
                onAccess: noop,
                onInvite: async () => false,
                onUninvite: noop,
                onCopy: noop,
                onUpdate: noop,
                onUsagePolicy: noop,
              }),
            ),
        );
      }
      const root = createRoot(document.querySelector("main")!);
      const click = (element: HTMLElement) =>
        act(async () => {
          element.focus();
          element.dispatchEvent(new window.Event("click", { bubbles: true }));
        });
      const load = () =>
        act(async () => {
          resolveChunk({ default: ChatSharePopover });
          await chunk;
        });
      try {
        await act(async () => root.render(createElement(Harness)));
        const headerShare = document.querySelector<HTMLElement>(
          ".header-share-trigger",
        )!;
        const caret = document.querySelector<HTMLElement>(
          ".thread-menu-trigger",
        )!;
        if (warm) {
          await click(headerShare);
          await load();
          await click(
            document.querySelector<HTMLElement>(
              '.chat-share button[aria-label="Close"]',
            )!,
          );
          assert.ok(
            document.activeElement === headerShare,
            "Header Share should regain focus after prewarming",
          );
        }
        await click(caret);
        const share = [
          ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
        ].find((item) => item.textContent?.includes("Share session"))!;
        await click(share);
        if (!warm) await load();
        assert.ok(document.querySelector('.chat-share[role="dialog"]'));
        assert.equal(document.querySelector('[role="menu"]'), null);
        if (closing === "Close") {
          await click(
            document.querySelector<HTMLElement>(
              '.chat-share button[aria-label="Close"]',
            )!,
          );
        } else {
          document
            .querySelector<HTMLInputElement>(".chat-share input")!
            .focus();
          await act(async () => {
            const escape = new window.Event("keydown", { bubbles: true });
            Object.assign(escape, { key: "Escape" });
            document.dispatchEvent(escape);
          });
        }
        assert.equal(
          document.querySelector('.chat-share[role="dialog"]'),
          null,
        );
        assert.ok(
          document.activeElement === caret,
          `Expected caret focus, got ${document.activeElement?.tagName}`,
        );
      } finally {
        await act(async () => root.unmount());
        window.HTMLElement.prototype.focus = previousFocus;
        Object.assign(globalThis, previous);
      }
    });
  }
}

test("a web Code session's title starts Rename and a separate caret opens its menu", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const document = parseHTML(
    `<div>${renderToStaticMarkup(
      createElement(ConversationTitle, {
        conversation: { ...conversation, mode: "code" },
        projects: [],
        running: false,
        actions: {
          onPin: noop,
          onRename: noop,
          onMoveToProject: noop,
          onCreateProject: noop,
          onOpenProjects: noop,
          onArchive: noop,
          onDelete: noop,
        },
      }),
    )}</div>`,
  ).document;
  assert.equal(document.querySelector(".thread-title"), null);
  const split = document.querySelector(".thread-title-split")!;
  assert.equal(split.getAttribute("data-mode"), "code");
  assert.equal(
    split.querySelector(".thread-rename-trigger")!.getAttribute("aria-label"),
    "Number 123, rename session",
  );
  const menu = split.querySelector(".thread-menu-trigger")!;
  assert.equal(menu.getAttribute("aria-label"), "More options for Number 123");
  assert.ok(menu.querySelector('[data-icon="CaretDown"]'));
});

test("a web Code session's title menu is the cloud one: Open in ▸ Desktop app, Rename, Copy link, Transcript view, Edit cloud environment, Archive, Delete", () => {
  const entries = titleMenuEntries(
    { ...conversation, mode: "code" },
    [],
    false,
    {
      onPin: noop,
      onRename: noop,
      onMoveToProject: noop,
      onCreateProject: noop,
      onOpenProjects: noop,
      onArchive: noop,
      onDelete: noop,
      onFork: noop,
      onExport: noop,
      onCopyLink: noop,
      onOpenInDesktop: noop,
      onEditEnvironment: noop,
      transcriptView: {
        view: "normal",
        defaultView: "normal",
        onSelect: noop,
        onMakeDefault: noop,
      },
    },
  );
  const outline = entries.map((entry) =>
    "separator" in entry ? "—" : "label" in entry ? entry.label : "?",
  );
  assert.deepEqual(outline, [
    "Open in",
    "—",
    "Rename",
    "—",
    "Copy link",
    "—",
    "Transcript view",
    "Edit cloud environment",
    "—",
    "Archive",
    "Delete",
  ]);
  const openIn = entries[0];
  assert.ok("submenu" in openIn);
  assert.deepEqual(
    openIn.submenu!.map((entry) => ("label" in entry ? entry.label : "—")),
    ["Desktop app"],
  );
});
