import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement, type ReactElement } from "react";
import { parseHTML } from "linkedom";
import postcss from "postcss";
import { parse as selectors, type Selector } from "css-what";
import type { Conversation } from "../../shared/types";

(globalThis as { __CLAUDEX_SURFACE__?: string }).__CLAUDEX_SURFACE__ = "web";
const { ConversationTitle } =
  await import("../../src/conversation/ConversationTitle");
const { Menu } = await import("../../src/ui/Menu");
const noop = () => {};
const conversation: Conversation = {
  id: "r4-title-shortcuts",
  title: "Number 123",
  mode: "chat",
  providerId: "fixture",
  model: "actual-model",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns: [],
};

async function environment(
  run: (fixture: {
    document: Document;
    render(element: ReactElement): Promise<void>;
    click(element: HTMLElement): Promise<void>;
    key(element: HTMLElement, key: string): Promise<boolean>;
  }) => Promise<void>,
) {
  const { window, document } = parseHTML(
    '<html data-surface="web"><body><div class="app web"><main></main></div></body></html>',
  );
  Object.assign(window, { innerWidth: 1440, innerHeight: 900 });
  let focused: HTMLElement | undefined;
  const priorFocus = window.HTMLElement.prototype.focus;
  const priorRect = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains("menu")
      ? {
          x: 250,
          y: 44,
          left: 250,
          right: 420,
          top: 44,
          bottom: 222,
          width: 170,
          height: 178,
          toJSON() {},
        }
      : {
          x: 392,
          y: 10,
          left: 392,
          right: 420,
          top: 10,
          bottom: 38,
          width: 28,
          height: 28,
          toJSON() {},
        };
  };
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => (focused?.isConnected ? focused : document.body),
  });
  const frames: FrameRequestCallback[] = [];
  const globals = {
    window,
    document,
    navigator: { userAgent: "Linkedom", language: "en-US" },
    innerWidth: 1440,
    innerHeight: 900,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
    getComputedStyle: () => ({ overflow: "visible", overflowX: "visible" }),
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
  const flush = () =>
    act(async () => {
      for (const frame of frames.splice(0)) frame(0);
    });
  try {
    await run({
      document,
      render: async (element) => {
        await act(async () => root.render(element));
        await flush();
      },
      click: async (element) => {
        await act(async () => {
          element.focus();
          element.click();
        });
        await flush();
      },
      key: async (element, key) => {
        const event = new window.Event("keydown", {
          bubbles: true,
          cancelable: true,
        });
        Object.assign(event, { key });
        await act(async () => {
          element.dispatchEvent(event);
        });
        await flush();
        return !event.defaultPrevented;
      },
    });
  } finally {
    await act(async () => root.unmount());
    window.HTMLElement.prototype.focus = priorFocus;
    window.HTMLElement.prototype.getBoundingClientRect = priorRect;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
const title = (key: string, calls: string[], running = false) =>
  createElement(ConversationTitle, {
    key,
    conversation,
    projects: [],
    running,
    actions: {
      onPin: () => calls.push("pin"),
      onRename: (name) => calls.push(`rename:${name}`),
      onRenameDialog: () => calls.push("rename-dialog"),
      onDelete: () => calls.push("delete"),
      onShare: () => calls.push("share"),
      onMoveToProject: noop,
      onCreateProject: noop,
      onOpenProjects: noop,
      onArchive: noop,
    },
  });
test("web title mouse and keyboard activation expose only P/R/D and run the existing actions", async () => {
  await environment(async ({ document, render, click, key }) => {
    const calls: string[] = [];
    for (const opening of ["mouse", "keyboard"] as const)
      for (const [hint, action] of [
        ["P", "pin"],
        ["R", "rename-dialog"],
        ["D", "delete"],
      ]) {
        await render(title(`${opening}-${hint}`, calls));
        const trigger = document.querySelector<HTMLButtonElement>(
          ".thread-menu-trigger",
        )!;
        if (opening === "keyboard") {
          trigger.focus();
          assert.equal(await key(trigger, "Enter"), true);
          // Linkedom does not implement a button's native Enter activation;
          // dispatch its uncancelled default click, as the browser does.
        }
        await click(trigger);
        const menu = document.querySelector<HTMLElement>(
          ".conversation-title-menu",
        )!;
        assert.deepEqual(
          [...menu.querySelectorAll("kbd")].map((node) => node.textContent),
          ["P", "R", "D"],
        );
        assert.equal(menu.style.width, "170px");
        const share = [
          ...menu.querySelectorAll<HTMLButtonElement>("button"),
        ].find((row) => row.textContent?.includes("Share session"))!;
        assert.ok(share);
        assert.equal(
          share.querySelector("kbd"),
          null,
          "current Share has no invented U hint",
        );
        await key(menu, hint);
        assert.equal(calls.at(-1), action);
        assert.equal(document.querySelector(".conversation-title-menu"), null);
      }
    await render(title("no-u", calls));
    await click(document.querySelector<HTMLElement>(".thread-menu-trigger")!);
    const noUMenu = document.querySelector<HTMLElement>(
      ".conversation-title-menu",
    )!;
    const beforeU = calls.length;
    await key(noUMenu, "U");
    assert.equal(
      calls.length,
      beforeU,
      "U must not invent an unread or Share action",
    );
    await key(noUMenu, "Escape");
    await render(title("disabled-delete", calls, true));
    await click(document.querySelector<HTMLElement>(".thread-menu-trigger")!);
    const menu = document.querySelector<HTMLElement>(
      ".conversation-title-menu",
    )!;
    const before = calls.length;
    await key(menu, "D");
    assert.equal(
      calls.length,
      before,
      "the existing running-session delete guard remains effective",
    );
    assert.ok(document.querySelector(".conversation-title-menu"));
    await key(menu, "Escape");
  });
});

const read = (path: string) =>
  readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
const privateCSS = read("conversation/conversation-title.css");
const otherCSS = [
  read("ui/menu.css"),
  read("live-web/pages.css"),
  read("styles/95-web.css"),
];
function rank(tokens: Selector[]): number {
  return tokens.reduce((total, token) => {
    if (token.type === "attribute")
      return total + (token.name === "id" ? 10000 : 100);
    if (token.type === "tag" || token.type === "pseudo-element")
      return total + 1;
    if (token.type !== "pseudo" || token.name === "where") return total;
    if (["is", "not", "has"].includes(token.name) && Array.isArray(token.data))
      return total + Math.max(0, ...token.data.map(rank));
    return total + 100;
  }, 0);
}
const parsedCSS = new Map<string, postcss.Root>();
function style(
  element: Element,
  sources: string[],
  target: string,
  coarse = false,
) {
  let winner: { rank: number; value: string } | undefined;
  for (const source of sources) {
    const root = parsedCSS.get(source) ?? postcss.parse(source);
    parsedCSS.set(source, root);
    root.walkRules((rule) => {
      for (
        let parent:
          | postcss.AtRule
          | postcss.Rule
          | postcss.Root
          | postcss.Document
          | undefined = rule.parent;
        parent;
        parent = parent.parent
      ) {
        if (parent.type !== "atrule") continue;
        if (parent.name === "container" || /keyframes/.test(parent.name))
          return;
        if (parent.name !== "media") continue;
        if (/max-width/.test(parent.params)) return;
        if (/pointer:\s*coarse|hover:\s*none/.test(parent.params) && !coarse)
          return;
        if (/pointer:\s*fine|hover:\s*hover/.test(parent.params) && coarse)
          return;
      }
      for (const selector of postcss.list.comma(rule.selector)) {
        let matches = false;
        try {
          matches =
            !selector.includes("::") &&
            element.matches(
              selector.replace(
                /:(hover|focus-visible|focus-within|focus|active)(?![\w-])/g,
                ":not(*)",
              ),
            );
        } catch {}
        if (!matches) continue;
        const priority = Math.max(...selectors(selector).map(rank));
        rule.walkDecls(target, (decl) => {
          const next = priority + (decl.important ? 1000000 : 0);
          if (!winner || winner.rank <= next)
            winner = { rank: next, value: decl.value };
        });
      }
    });
  }
  return winner?.value;
}
test("the actual title hints win the important CSS hide at 13/17; coarse/native and other menus remain hidden", async () => {
  await environment(async ({ document, render, click }) => {
    await render(title("css", []));
    await click(document.querySelector<HTMLElement>(".thread-menu-trigger")!);
    const hints = [
      ...document.querySelectorAll(".conversation-title-menu > button > kbd"),
    ];
    assert.equal(hints.length, 3);
    for (const sources of [
      [privateCSS, ...otherCSS],
      [...otherCSS, privateCSS],
    ])
      for (const hint of hints) {
        assert.equal(style(hint, sources, "display"), "block");
        assert.equal(style(hint, sources, "font-size"), "13px");
        assert.equal(style(hint, sources, "line-height"), "17px");
        assert.equal(style(hint, sources, "display", true), "none");
        assert.equal(
          style(hint, otherCSS, "display"),
          "none",
          "negative control: old important suppression returns without the private rule",
        );
      }
    document.querySelector(".app")!.classList.add("mobile-conversation");
    for (const hint of hints)
      assert.equal(style(hint, [...otherCSS, privateCSS], "display"), "none");
  });
});
test("showRootHints opts in only root hint DOM; default menus, combinations and submenus keep their web default", async () => {
  await environment(async ({ document, render, click }) => {
    const menu = (showRootHints?: boolean) =>
      createElement(Menu, {
        key: `${showRootHints}`,
        label: "Other menu",
        position: { left: 20, top: 40 },
        width: 170,
        showRootHints,
        onClose: noop,
        entries: [
          { label: "First", hint: "F", onSelect: noop },
          { label: "Upload", shortcut: ["mod", "U"], onSelect: noop },
          {
            label: "Branch",
            submenu: [{ label: "Sub action", hint: "S", onSelect: noop }],
          },
        ],
      });
    await render(menu());
    assert.equal(
      document.querySelectorAll("kbd").length,
      0,
      "unobserved menu roots remain DOM-suppressed by default",
    );
    await render(menu(true));
    assert.deepEqual(
      [...document.querySelectorAll("kbd")].map((node) => node.textContent),
      ["F"],
    );
    assert.equal(
      style(
        document.querySelector("kbd")!,
        [...otherCSS, privateCSS],
        "display",
      ),
      "none",
      "the title CSS does not reveal another popup",
    );
    const branch = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((row) => row.textContent === "Branch")!;
    await click(branch);
    assert.ok(document.querySelector("[data-submenu]"));
    assert.equal(
      document.querySelectorAll("[data-submenu] kbd").length,
      0,
      "the new opt-in is not inherited by a submenu",
    );
  });
});
