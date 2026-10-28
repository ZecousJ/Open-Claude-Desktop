import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { Conversation, Mode } from "../../shared/types";
import type { AppController } from "../../src/app/AppContext";
import { openPolicy } from "../../shared/client-policy";

(globalThis as { __CLAUDEX_SURFACE__?: string }).__CLAUDEX_SURFACE__ = "web";
const { AccountMenu } = await import("../../src/sidebar/AccountMenu");
const { ConversationRow } = await import("../../src/sidebar/ConversationRow");
const { selection } = await import("../../src/sidebar/multi-select");
const { HistoryPage } =
  await import("../../src/collections/history/HistoryPage");
const { AppContext } = await import("../../src/app/AppContext");
const { PolicyProvider } = await import("../../src/policy/PolicyContext");
const { openLanguageDialog, useLanguageDialog } =
  await import("../../src/i18n/language-dialog");
const { sharedChatRequest } =
  await import("../../src/collections/open-requests");

const noop = () => {};
const row = (id: string, extra: Partial<Conversation> = {}): Conversation => ({
  id,
  title: id,
  mode: "chat",
  pinned: false,
  archived: false,
  providerId: "p",
  model: "m",
  createdAt: 1,
  updatedAt: 1,
  turns: [],
  ...extra,
});

async function withDom(
  check: (fixture: {
    window: Window;
    document: Document;
    event: (type: string, init?: EventInit) => Event;
    render: (node: ReactNode) => Promise<void>;
    click: (
      element: Element,
      extra?: Record<string, unknown>,
    ) => Promise<Event>;
  }) => Promise<void>,
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  (document as unknown as { oninput: null }).oninput = null;
  const globals = {
    window,
    document,
    innerWidth: 1440,
    innerHeight: 900,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    cancelAnimationFrame: clearTimeout,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  Object.assign(window, { innerWidth: 1440, innerHeight: 900 });
  const originalHeight = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    "offsetHeight",
  );
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 200,
  });
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
  const root = createRoot(document.querySelector("main")!);
  try {
    await check({
      window: window as unknown as Window,
      document,
      event: (type, init) => new window.Event(type, init),
      render: async (node) => {
        await act(async () => root.render(node));
      },
      click: async (element, extra = {}) => {
        const event = new window.Event("click", {
          bubbles: true,
          cancelable: true,
        });
        Object.assign(event, { detail: 1, ...extra });
        await act(async () => {
          element.dispatchEvent(event);
        });
        return event;
      },
    });
  } finally {
    await act(async () => root.unmount());
    if (originalHeight)
      Object.defineProperty(
        window.HTMLElement.prototype,
        "offsetHeight",
        originalHeight,
      );
    else Reflect.deleteProperty(window.HTMLElement.prototype, "offsetHeight");
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("#19 actual web links preserve open, modifier selection, range and drag suppression", async () => {
  await withDom(async ({ document, render, click }) => {
    const opened: string[] = [];
    let suppressClick = false;
    const dragControl = {
      click: () => suppressClick,
      pointerDown: noop,
      pointerMove: noop,
      pointerUp: noop,
      pointerCancel: noop,
      lostCapture: noop,
    } as unknown as ComponentProps<typeof ConversationRow>["dragControl"];
    const actions = {
      onOpen: (c: Conversation) => opened.push(c.id),
      onTogglePin: noop,
      onRename: noop,
      onMoveToProject: noop,
      onToggleArchive: noop,
      onDelete: noop,
      onToggleUnread: noop,
      onOpenIn: noop,
    };
    try {
      selection.clear();
      await render(
        createElement(
          "div",
          { "data-drop-section": "pinned" },
          ...["one", "two", "three"].map((id) =>
            createElement(ConversationRow, {
              key: id,
              conversation: row(id, { pinned: true }),
              projects: [],
              selected: false,
              actions,
              onKeyboardPin: noop,
              draggable: true,
              dragControl,
              onNewGroup: noop,
            }),
          ),
        ),
      );
      const link = (id: string) =>
        document.querySelector(`a[href="/chat/${id}"]`)!;
      assert.equal((await click(link("one"))).defaultPrevented, true);
      assert.deepEqual(opened, ["one"]);
      await click(link("one"), { metaKey: true });
      assert.deepEqual([...selection.get().keys], ["one"]);
      await click(link("three"), { shiftKey: true });
      assert.deepEqual([...selection.get().keys], ["one", "two", "three"]);
      assert.deepEqual(opened, ["one"]);
      suppressClick = true;
      await click(link("two"));
      assert.deepEqual(opened, ["one"]);
      assert.equal(selection.get().keys.size, 3);
      suppressClick = false;
      await click(link("two"));
      assert.deepEqual(opened, ["one", "two"]);
      assert.equal(selection.get().keys.size, 0);
    } finally {
      await act(async () => selection.clear());
    }
  });
});

test("#27 web legacy Cowork keeps unified tabs and search, without a shared-records section", async () => {
  await withDom(async ({ window, document, render, click, event }) => {
    const pages: string[] = [];
    const opened: string[] = [];
    Object.assign(window, {
      desktop: {
        hostedShares: async () => [{ status: "active", sourceKey: "archive" }],
        sharedWithMe: async () => [
          {
            token: "shared-token",
            title: "Shared record",
            owner: "Fixture",
            snapshotAt: 1,
          },
        ],
        onEvent: () => noop,
        listConversationGroups: async () => ({ groups: [], members: {} }),
        searchConversations: async () => ({ results: [] }),
      },
    });
    const controller = {
      setPage: (page: string) => pages.push(page),
    } as unknown as AppController;
    let mode: Mode = "cowork";
    const props = {
      conversations: [
        row("chat"),
        row("legacy", { mode: "cowork" }),
        row("archive", { archived: true }),
        row("code", { mode: "code" }),
      ],
      projects: [],
      onNewChat: noop,
      onOpenConversation: (c: Conversation) => opened.push(c.id),
      onRename: noop,
      onArchive: async () => [],
      onDelete: noop,
      onConfirmArchive: noop,
      onUpdateSelection: async () => [],
    };
    const page = () =>
      createElement(
        AppContext.Provider,
        { value: controller },
        createElement(HistoryPage, { ...props, mode }),
      );
    await render(page());
    const tabs = () => [...document.querySelectorAll('[role="tab"]')];
    const tab = (label: string) =>
      tabs().find((element) => element.textContent === label)!;
    const titles = () =>
      [...document.querySelectorAll(".history-title-line")].map(
        (element) => element.textContent,
      );
    assert.deepEqual(
      tabs().map((element) => element.textContent),
      ["Active", "Shared", "Archived"],
    );
    assert.deepEqual(titles(), ["chat", "legacy"]);
    // No "Shared with you" section on the history page; chats shared with the
    // account keep their page.
    assert.equal(
      document.querySelector('[aria-label="Shared with you"]'),
      null,
    );
    await click(tab("Shared"));
    assert.deepEqual(titles(), ["archive"]);
    await click(tab("Archived"));
    assert.deepEqual(titles(), ["archive"]);
    await click(tab("Active"));
    await click(
      document.querySelector('button[aria-label="Search your activity"]')!,
    );
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search your activity"]',
    )!;
    assert.equal(input.placeholder, "Search recents...");
    const escape = event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(escape, { key: "Escape" });
    await act(async () => {
      input.dispatchEvent(escape);
    });
    assert.equal(
      document.querySelector('input[aria-label="Search your activity"]'),
      null,
    );
    mode = "code";
    await render(page());
    assert.deepEqual(
      tabs().map((element) => element.textContent),
      ["Active", "Archived"],
    );
    assert.deepEqual(titles(), ["code"]);
    assert.equal(
      document.querySelector('[aria-label="Shared with you"]'),
      null,
    );
  });
});

test("#34 web account menu retains real service actions, configured links and Learn more", async () => {
  await withDom(async ({ window, document, render, click }) => {
    const calls: string[] = [];
    Object.assign(window, {
      desktop: {
        clientPolicy: async () => ({
          ...openPolicy,
          links: {
            help: "https://fixture.invalid/help",
            plans: "https://fixture.invalid/plans",
            apps: "https://fixture.invalid/apps",
            learnMore: [
              { label: "About Claudex", url: "https://fixture.invalid/about" },
            ],
          },
        }),
        onEvent: () => noop,
        openExternal: async (url: string) => {
          calls.push(url);
        },
      },
    });
    const controller = {
      setPage: (page: string) => calls.push(page),
      openSettingsTab: (tab: string) => calls.push(tab),
      setShortcutsOpen: (open: boolean) => calls.push(`shortcuts:${open}`),
    } as unknown as AppController;
    function LanguageState() {
      return createElement("output", {
        "data-language-open": String(useLanguageDialog()),
      });
    }
    const props = {
      name: "Fixture",
      email: "fixture@example.invalid",
      plan: "Fixture plan",
      mode: "chat" as const,
      onSettings: () => calls.push("settings"),
      onUsage: () => calls.push("usage"),
      onChangelog: () => calls.push("changelog"),
      onSignOut: async () => {
        calls.push("logout");
      },
      onError: (error: unknown) => {
        throw error;
      },
    };
    const renderMenu = (service = false) =>
      render(
        createElement(
          AppContext.Provider,
          { value: controller },
          createElement(
            PolicyProvider,
            null,
            createElement(AccountMenu, {
              ...props,
              onRecharge: service ? () => calls.push("funds") : undefined,
            }),
            createElement(LanguageState),
          ),
        ),
      );
    const trigger = () => document.querySelector("button.profile")!;
    const menu = () => document.querySelector('.profile-popover[role="menu"]')!;
    const item = (label: string, parent: ParentNode = menu()) =>
      [...parent.querySelectorAll("button")].find(
        (button) =>
          button.querySelector("span:not([data-icon])")?.textContent === label,
      )!;
    const choose = async (label: string) => {
      await click(trigger());
      await click(item(label));
      assert.equal(document.querySelector('[role="menu"]'), null);
    };
    try {
      openLanguageDialog(false);
      await renderMenu();
      await click(trigger());
      assert.ok(trigger().querySelector("[data-no-translate]"));
      assert.ok(menu().querySelector(":scope > .profile-menu-scroll"));
      assert.deepEqual(
        [...menu().querySelectorAll("button > span:not([data-icon])")].map(
          (element) => element.textContent,
        ),
        [
          "Settings",
          "Usage",
          "Language",
          "Get help",
          "View all plans",
          "Get apps and extensions",
          "Learn more",
          "Get API keys",
          "Log out",
        ],
      );
      assert.equal(menu().querySelectorAll("hr").length, 3);
      await click(item("Settings"));
      assert.equal(document.querySelector('[role="menu"]'), null);
      await choose("Usage");
      await choose("Language");
      assert.ok(document.querySelector('[data-language-open="true"]'));
      await choose("Get help");
      await choose("View all plans");
      await choose("Get apps and extensions");
      await choose("Get API keys");
      await choose("Log out");
      assert.deepEqual(calls, [
        "settings",
        "usage",
        "https://fixture.invalid/help",
        "https://fixture.invalid/plans",
        "https://fixture.invalid/apps",
        "api",
        "logout",
      ]);
      await click(trigger());
      await click(item("Learn more"));
      const submenu = document.querySelector(
        '.profile-submenu[aria-label="Learn more"]',
      )!;
      assert.ok(submenu.querySelector(":scope > .profile-menu-scroll"));
      assert.ok(item("About Claudex", submenu));
      await click(item("Your privacy choices", submenu));
      assert.equal(calls.at(-1), "privacy");
      await click(trigger());
      await click(item("Learn more"));
      await click(
        item("Keyboard shortcuts", document.querySelector(".profile-submenu")!),
      );
      assert.equal(calls.at(-1), "shortcuts:true");
      await renderMenu(true);
      await click(trigger());
      assert.equal(item("View all plans"), undefined);
      await click(item("Add funds"));
      assert.equal(calls.at(-1), "funds");
    } finally {
      await act(async () => openLanguageDialog(false));
    }
  });
});

test("the account menu focuses its first item when opened from the keyboard, and arrows, Home, End and Escape work", async () => {
  await withDom(async ({ window: page, document, render, click }) => {
    const window = page as unknown as typeof globalThis;
    const prototype = window.HTMLElement.prototype;
    const focus = Object.getOwnPropertyDescriptor(prototype, "focus");
    let focused: Element | null = null;
    Object.defineProperty(prototype, "focus", {
      configurable: true,
      value(this: Element) {
        focused = this;
      },
    });
    Object.defineProperty(document, "activeElement", {
      configurable: true,
      get: () => focused ?? document.body,
    });
    const press = async (target: Element, key: string) => {
      const event = new window.Event("keydown", {
        bubbles: true,
        cancelable: true,
      });
      Object.assign(event, { key });
      await act(async () => {
        target.dispatchEvent(event);
      });
    };
    try {
      await render(
        createElement(AccountMenu, {
          name: "Fixture",
          email: "fixture@example.invalid",
          mode: "chat" as const,
          onSettings: noop,
          onChangelog: noop,
          onError: (error: unknown) => {
            throw error;
          },
        }),
      );
      const trigger = document.querySelector("button.profile")!;
      // A click with no pointer detail is the keyboard's Enter.
      await click(trigger, { detail: 0 });
      const menu = document.querySelector('.profile-popover[role="menu"]')!;
      const items = [...menu.querySelectorAll('[role="menuitem"]')];
      assert.ok(items.length > 2);
      assert.ok(focused === items[0]);
      await press(items[0], "ArrowDown");
      assert.ok(focused === items[1]);
      await press(items[1], "End");
      assert.ok(focused === items.at(-1));
      await press(items.at(-1)!, "ArrowDown");
      assert.ok(focused === items[0], "the arrows loop at the ends");
      await press(items[0], "ArrowUp");
      assert.ok(focused === items.at(-1));
      await press(items.at(-1)!, "Home");
      assert.ok(focused === items[0]);
      await press(items[0], "Escape");
      assert.equal(document.querySelector('[role="menu"]'), null);
      assert.ok(focused === trigger, "focus goes back to the profile button");
    } finally {
      if (focus) Object.defineProperty(prototype, "focus", focus);
      else Reflect.deleteProperty(prototype, "focus");
      Reflect.deleteProperty(document, "activeElement");
    }
  });
});
