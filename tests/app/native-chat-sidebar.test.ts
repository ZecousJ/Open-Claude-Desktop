import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { act, createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { NativeChatSearch } from "../../src/sidebar/NativeChatSearch";
import { ShortcutPlatform } from "../../src/ui/Tooltip";
import { Sidebar } from "../../src/sidebar/Sidebar";
import { ConversationRow } from "../../src/sidebar/ConversationRow";
import type { Conversation } from "../../shared/types";

function searchMarkup(platform: string) {
  return parseHTML(
    renderToStaticMarkup(
      createElement(
        ShortcutPlatform.Provider,
        { value: platform },
        createElement(NativeChatSearch, { onSearch() {} }),
      ),
    ),
  ).document;
}

test("native Chat Search is a labelled button with the current platform shortcut", () => {
  for (const [platform, hint, shortcut] of [
    ["darwin", "⌘ K", "Meta+K"],
    ["win32", "Ctrl K", "Control+K"],
    ["linux", "Ctrl K", "Control+K"],
  ]) {
    const document = searchMarkup(platform);
    const button = document.querySelector(".native-chat-search")!;
    assert.equal(button.tagName, "BUTTON");
    assert.equal(button.getAttribute("type"), "button");
    assert.equal(button.getAttribute("aria-keyshortcuts"), shortcut);
    assert.equal(
      button.querySelector(".native-chat-search-label")?.textContent,
      "Search",
    );
    assert.equal(button.querySelector("kbd")?.textContent, hint);
    assert.equal(
      button.querySelector("kbd")?.getAttribute("aria-hidden"),
      "true",
    );
    assert.equal(
      button
        .querySelector(".native-chat-search-leading")
        ?.getAttribute("aria-hidden"),
      "true",
    );
    assert.equal(
      button.querySelector(".app-icon")?.getAttribute("data-icon"),
      "Search",
    );
  }
});

test("native Chat Search invokes the real palette callback once without submitting a form", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const globals = {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  let opened = 0;
  try {
    await act(async () => {
      root.render(
        createElement(NativeChatSearch, { onSearch: () => opened++ }),
      );
    });
    const button = document.querySelector(".native-chat-search")!;
    const down = new window.Event("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      button.dispatchEvent(down);
      button.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    assert.equal(down.defaultPrevented, true);
    assert.equal(opened, 1);
    assert.equal(button.getAttribute("type"), "button");
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("native Chat frame correction never targets browser or native Code", async () => {
  const css = await readFile(
    new URL("../../src/sidebar/native-chat-sidebar.css", import.meta.url),
    "utf8",
  );
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...noComments.matchAll(/(?:^|[{}])\s*([^{}]+)\{/g)]
    .map((match) => match[1].trim())
    .filter((selector) => !selector.startsWith("@"));
  assert.ok(selectors.length > 10);
  for (const selector of selectors)
    assert.match(selector, /\.app(?:\.darwin)?[^{}]*:not\(\.web\)\.mode-chat/);
  assert.match(
    css,
    /grid-template-columns: var\(--sidebar-width\) minmax\(0, 1fr\)/,
  );
  assert.match(
    css,
    /\.sidebar\s*\{[^}]*border-radius: 0;[^}]*box-shadow: none;/s,
  );
  assert.match(
    css,
    /\.sidebar-resize-handle\s*\{[^}]*left: calc\(var\(--sidebar-width\) - 6px\)/s,
  );
  assert.match(
    css,
    /\.native-chat-search\s*\{[^}]*height: 26px;[^}]*font-size: 13px;/s,
  );
});

test("native Chat rail follows the source slots and keeps its live region inside the list", async () => {
  const css = await readFile(
    new URL("../../src/sidebar/native-chat-sidebar.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    // Every desktop platform.
    /\.app:not\(\.web\)\.mode-chat \.sidebar-body\s*\{\s*padding-top: 4px;/,
  );
  assert.match(
    css,
    /\.native-chat-search\s*\{[^}]*width: calc\(100% - 4px\);[^}]*margin-inline: 2px;/s,
  );
  assert.match(
    css,
    /\.native-chat-search-leading\s*\{[^}]*width: 24px;[^}]*margin-inline-start: 2px;/s,
  );
  assert.match(css, /\.recents-search\s*\{\s*display: none;/);
  assert.match(css, /\.sidebar-scroll\s*\{\s*position: relative;/);
  assert.match(
    css,
    /\.sidebar-scroll > \.sr-only\[aria-live\]\s*\{\s*top: 0;\s*inset-inline-start: 0;\s*margin: 0;/,
  );
  assert.doesNotMatch(
    css,
    /(?:^|[;{])\s*(?:inset|top|left|right|bottom):\s*-[\d]/,
  );
});

test("integrated native Sidebar uses one top Search and preserves Code's separate field", () => {
  const noop = () => {};
  const props: ComponentProps<typeof Sidebar> = {
    onToggleSidebar: noop,
    conversations: [],
    approvalIds: new Set(),
    page: "chat",
    mode: "chat",
    onNewChat: noop,
    onPageChange: noop,
    onEditSidebar: noop,
    onSearch: noop,
    onSettings: noop,
    onChangelog: noop,
    projects: [],
    rowActions: {
      onOpen: noop,
      onRename: noop,
      onMoveToProject: noop,
      onToggleArchive: noop,
      onDelete: noop,
      onToggleUnread: noop,
      onOpenIn: noop,
    },
    onReorder: async () => {},
    onError: noop,
    settingsName: "Synthetic user",
  };
  for (const mode of ["chat", "code", "chat"] as const) {
    const document = parseHTML(
      renderToStaticMarkup(createElement(Sidebar, { ...props, mode })),
    ).document;
    assert.equal(
      document.querySelectorAll(".native-chat-search").length,
      mode === "chat" ? 1 : 0,
    );
    assert.equal(
      document.querySelectorAll(".web-sidebar-search").length,
      mode === "code" ? 1 : 0,
    );
    assert.equal(document.querySelectorAll(".account-search").length, 0);
    const first = document.querySelector(".sidebar-body")?.firstElementChild;
    assert.equal(
      first?.className,
      mode === "chat" ? "native-chat-search-wrap" : "web-sidebar-search",
    );
  }
});

test("native Chat sheet is loaded before the renderer can paint", async () => {
  const entry = await readFile(
    new URL("../../src/main.tsx", import.meta.url),
    "utf8",
  );
  const sheet = entry.indexOf(
    'await import("./sidebar/native-chat-sidebar.css")',
  );
  assert.ok(sheet > entry.indexOf('if (surface !== "web")'));
  assert.ok(sheet < entry.indexOf("renderer.root.render("));
});

const rowNoop = () => {};
const rowDrag = {
  click: () => false,
  pointerDown: rowNoop,
  pointerMove: rowNoop,
  pointerUp: rowNoop,
  pointerCancel: rowNoop,
  lostCapture: rowNoop,
} as unknown as ComponentProps<typeof ConversationRow>["dragControl"];
const rowActions = {
  onOpen: rowNoop,
  onTogglePin: rowNoop,
  onRename: rowNoop,
  onMoveToProject: rowNoop,
  onToggleArchive: rowNoop,
  onDelete: rowNoop,
  onToggleUnread: rowNoop,
  onOpenIn: rowNoop,
};
function activityRow(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: "synthetic-native-chat",
    title: "Synthetic activity row",
    mode: "chat",
    providerId: "synthetic",
    model: "Sonnet",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
    ...patch,
  };
}
function activityMarkup(conversation: Conversation, needsApproval = false) {
  return parseHTML(
    renderToStaticMarkup(
      createElement(ConversationRow, {
        conversation,
        projects: [],
        selected: false,
        needsApproval,
        actions: rowActions,
        onKeyboardPin: rowNoop,
        draggable: false,
        dragControl: rowDrag,
        onNewGroup: rowNoop,
      }),
    ),
  ).document;
}
const runningTurn: Conversation["turns"][number] = {
  id: "synthetic-running-turn",
  prompt: "Synthetic reference",
  attachments: [],
  items: [],
  status: "inProgress",
  createdAt: 1,
};

test("native Chat running, unread and waiting activity follows its title without a leading dot", () => {
  const states: [Partial<Conversation>, string, string, boolean][] = [
    [{ turns: [runningTurn] }, "working", "Running", false],
    [{ unread: true }, "unread", "Unread response", false],
    [{}, "attention", "Awaiting input", true],
  ];
  for (const mode of ["chat", "cowork"] as const) {
    for (const [patch, dot, label, approval] of states) {
      const document = activityMarkup(
        activityRow({ ...patch, mode }),
        approval,
      );
      const row = document.querySelector("button.conversation-link")!;
      assert.ok(row.classList.contains("plain-recent"));
      assert.equal(row.firstElementChild?.className, "row-title-slot");
      assert.equal(row.querySelectorAll(".row-status").length, 1);
      const trailing = row.querySelector(".row-status-trailing")!;
      assert.ok(trailing.querySelector(`.thread-dot.${dot}`));
      assert.equal(
        trailing.querySelector(".row-status")?.getAttribute("aria-label"),
        label,
      );
      assert.equal(row.lastElementChild, trailing);
    }
  }
});

test("native pinned Chat keeps its type icon while activity stays after the title", () => {
  for (const patch of [{}, { unread: true }, { turns: [runningTurn] }]) {
    const document = activityMarkup(activityRow({ ...patch, pinned: true }));
    const row = document.querySelector("button.conversation-link")!;
    assert.equal(row.classList.contains("plain-recent"), false);
    assert.equal(row.firstElementChild?.getAttribute("data-icon"), "ChatMode");
    assert.equal(row.children[1].className, "row-title-slot");
    const leading = [...row.children].filter((child) =>
      child.classList.contains("row-status"),
    );
    assert.equal(leading.length, 0);
    assert.equal(
      row.querySelectorAll(".row-status-trailing").length,
      patch.unread || patch.turns ? 1 : 0,
    );
  }
});

test("native Chat's trailing unread control preserves click and keyboard actions without opening the row", async () => {
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
      configurable: true,
      writable: true,
      value,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  let opened = 0;
  let toggled = 0;
  try {
    await act(async () => {
      root.render(
        createElement(ConversationRow, {
          conversation: activityRow({ unread: true }),
          projects: [],
          selected: false,
          actions: {
            ...rowActions,
            onOpen: () => opened++,
            onToggleUnread: () => toggled++,
          },
          onKeyboardPin: rowNoop,
          draggable: false,
          dragControl: rowDrag,
          onNewGroup: rowNoop,
        }),
      );
    });
    const control = document.querySelector(
      '.row-status-trailing .row-status[role="button"]',
    )!;
    const click = new window.Event("click", {
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      control.dispatchEvent(click);
    });
    assert.equal(click.defaultPrevented, true);
    assert.equal(toggled, 1);
    assert.equal(opened, 0);
    const key = new window.Event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(key, "key", { value: "Enter" });
    await act(async () => {
      control.dispatchEvent(key);
    });
    assert.equal(key.defaultPrevented, true);
    assert.equal(toggled, 2);
    assert.equal(opened, 0);
    await act(async () => {
      document
        .querySelector(".row-title-slot")!
        .dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    assert.equal(opened, 1);
    assert.equal(toggled, 2);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("native idle rows stay undecorated and archived status semantics are preserved", () => {
  const idle = activityMarkup(activityRow());
  assert.equal(
    idle.querySelectorAll(".row-status,.thread-dot,.row-status-trailing")
      .length,
    0,
  );
  const archived = activityMarkup(
    activityRow({ archived: true, unread: true, turns: [runningTurn] }),
  );
  assert.equal(
    archived.querySelector(".row-status")?.getAttribute("aria-label"),
    "Archived",
  );
  assert.equal(
    archived.querySelector(".row-status")?.getAttribute("role"),
    "img",
  );
  assert.equal(archived.querySelectorAll(".thread-archived").length, 1);
  assert.equal(archived.querySelectorAll(".thread-dot").length, 0);
});

test("native Code retains its type, trailing activity and accessible status metadata", () => {
  const document = activityMarkup(
    activityRow({ mode: "code", pinned: true, turns: [runningTurn] }),
  );
  const row = document.querySelector("button.conversation-link")!;
  assert.equal(row.firstElementChild?.getAttribute("data-icon"), "Code");
  assert.ok(row.querySelector(".row-status-trailing .thread-dot.working"));
  assert.equal(row.querySelectorAll(".row-status").length, 1);
  assert.equal(
    row.querySelector(".row-status")?.getAttribute("aria-label"),
    "Running",
  );
});

test("web Chat and Code keep real links, pinned kinds and their existing trailing activity", () => {
  const result = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./tests/support/css-stub.mjs",
      "--input-type=module",
      "-e",
      `
      globalThis.__CLAUDEX_SURFACE__ = "web";
      const {createElement} = await import("react");
      const {renderToStaticMarkup} = await import("react-dom/server");
      const {parseHTML} = await import("linkedom");
      const {ConversationRow} = await import("./src/sidebar/ConversationRow.tsx");
      const noop = () => {};
      const rows = ["chat", "code"].map(mode => {
        const conversation = {id:"synthetic-"+mode,title:"Synthetic",mode,providerId:"synthetic",model:"Sonnet",pinned:true,archived:false,createdAt:1,updatedAt:1,turns:[{id:"turn",prompt:"",attachments:[],items:[],status:"inProgress",createdAt:1}]};
        const document = parseHTML(renderToStaticMarkup(createElement(ConversationRow, {
          conversation,projects:[],selected:true,actions:{onOpen:noop,onTogglePin:noop,onRename:noop,onMoveToProject:noop,onToggleArchive:noop,onDelete:noop,onToggleUnread:noop,onOpenIn:noop},onKeyboardPin:noop,draggable:false,dragControl:{click:()=>false,pointerDown:noop,pointerMove:noop,pointerUp:noop,pointerCancel:noop,lostCapture:noop},onNewGroup:noop
        }))).document;
        const row = document.querySelector(".conversation-link");
        return {mode,tag:row.tagName,href:row.getAttribute("href"),current:row.getAttribute("aria-current"),kind:row.firstElementChild.getAttribute("data-icon"),working:!!row.querySelector(".row-status-trailing .thread-dot.working"),statuses:row.querySelectorAll(".row-status").length};
      });
      process.stdout.write(JSON.stringify(rows));
    `,
    ],
    { cwd: new URL("../../", import.meta.url), encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(result), [
    {
      mode: "chat",
      tag: "A",
      href: "/chat/synthetic-chat",
      current: "page",
      kind: "ChatMode",
      working: true,
      statuses: 1,
    },
    {
      mode: "code",
      tag: "A",
      href: "/code/synthetic-code",
      current: "page",
      kind: "Code",
      working: true,
      statuses: 1,
    },
  ]);
});
