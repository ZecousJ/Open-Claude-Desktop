import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import postcss from "postcss";
import type { Conversation, DesktopAPI } from "../../shared/types";
import type { HostedShare, SharingStatus } from "../../shared/sharing-api";
import { defaultSettings } from "../../electron/store/store";
import { desktopHost } from "../../shared/host";
import { openPolicy } from "../../shared/client-policy";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { HostContext } from "../../src/host/HostContext";
import {
  ConversationHeaderHost,
  conversationTitleCopyLink,
} from "../../src/app/ConversationHeaderHost";

const chat: Conversation = {
  id: "synthetic-native-title",
  title: "Synthetic title",
  mode: "chat",
  providerId: "synthetic",
  model: "Sonnet",
  pinned: true,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns: [
    {
      id: "reference-turn",
      prompt: "Neutral reference",
      status: "completed",
      createdAt: 1,
      attachments: [],
      items: [
        {
          id: "reference-reply",
          type: "agentMessage",
          text: "Reference response",
        },
      ],
    },
  ],
};
const share = (patch: Partial<HostedShare> = {}): HostedShare => ({
  id: "synthetic-share",
  kind: "conversation",
  sourceKey: chat.id,
  title: chat.title,
  url: "https://share.example.test/s/existing-reference",
  status: "active",
  createdAt: 1,
  snapshotAt: 1,
  ...patch,
});
const enabled: SharingStatus = {
  conversations: true,
  artifacts: true,
  maxSnapshotBytes: 100000,
  maxArtifactBytes: 100000,
};

async function environment(
  run: (fixture: {
    document: Document;
    copies: string[];
    notifications: string[];
    errors: unknown[];
    state: {
      status: SharingStatus | null;
      current: HostedShare | null;
      reads: number;
      creates: number;
    };
    render(): Promise<void>;
    menu(): Promise<string[]>;
    click(label: string): Promise<void>;
  }) => Promise<void>,
  target: Conversation = chat,
) {
  const { window, document } = parseHTML(
    '<html data-surface="desktop"><body><div class="app darwin mode-chat"><main></main></div></body></html>',
  );
  const state = {
    status: enabled as SharingStatus | null,
    current: share() as HostedShare | null,
    reads: 0,
    creates: 0,
  };
  const copies: string[] = [],
    notifications: string[] = [],
    errors: unknown[] = [];
  const listeners = new Set<(...args: unknown[]) => void>();
  window.desktop = {
    onEvent: (listener: (...args: unknown[]) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sharingStatus: async () => state.status,
    conversationShare: async () => {
      state.reads++;
      return state.current;
    },
    copyText: async (url: string) => {
      copies.push(url);
    },
    shareConversation: async () => {
      state.creates++;
      throw new Error("Must not create a share");
    },
  } as unknown as DesktopAPI;
  Object.assign(window, { innerWidth: 1280, innerHeight: 720 });
  let focused: HTMLElement | undefined;
  const priorFocus = window.HTMLElement.prototype.focus;
  const priorRect = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const menu = this.classList.contains("menu");
    return {
      x: menu ? 276 : 400,
      y: menu ? 42 : 10,
      left: menu ? 276 : 400,
      right: 428,
      top: menu ? 42 : 10,
      bottom: menu ? 204 : 38,
      width: menu ? 152 : 28,
      height: menu ? 162 : 28,
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
    innerWidth: 1280,
    innerHeight: 720,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame() {},
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
  const noop = () => {};
  const app = {
    accountId: "synthetic-account",
    controllerScope: {},
    snapshot: {
      settings: defaultSettings,
      conversations: [target],
      projects: [],
      platform: "darwin",
      approvals: [],
    },
    mode: "chat",
    activeId: target.id,
    active: target,
    panel: null,
    running: target.turns.some((turn) => turn.status === "inProgress"),
    remoteAccount: false,
    policy: openPolicy,
    activeTerminals: [],
    toolPanels: { isOpen: () => false, toggle: noop },
    patchConversation: noop,
    confirmDelete: noop,
    moveToProject: async () => {},
    startProject: noop,
    setPage: noop,
    setRename: noop,
    setArtifact: noop,
    setPanel: noop,
    report: (error: unknown) => errors.push(error),
    notify: (message: string) => notifications.push(message),
  } as unknown as AppController;
  const flush = async () => {
    await act(async () => {
      for (const frame of frames.splice(0)) frame(0);
      await Promise.resolve();
    });
  };
  try {
    await run({
      document,
      state,
      copies,
      notifications,
      errors,
      async render() {
        await act(async () => {
          root.render(
            createElement(
              HostContext.Provider,
              { value: desktopHost },
              createElement(
                AppContext.Provider,
                { value: app },
                createElement(ConversationHeaderHost, { active: target }),
              ),
            ),
          );
        });
        await flush();
      },
      async menu() {
        const button = document.querySelector<HTMLButtonElement>(
          ".thread-menu-trigger",
        )!;
        await act(async () => {
          button.focus();
          button.click();
        });
        await flush();
        return [
          ...document.querySelectorAll(
            ".native-conversation-title-menu > button",
          ),
        ].map(
          (button) => button.querySelector(":scope > span")?.textContent ?? "",
        );
      },
      async click(label) {
        const button = [
          ...document.querySelectorAll<HTMLButtonElement>(
            ".native-conversation-title-menu > button",
          ),
        ].find(
          (button) =>
            button.querySelector(":scope > span")?.textContent === label,
        );
        assert.ok(button, `Missing menu row ${label}`);
        await act(async () => {
          button.click();
        });
        await flush();
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

test("native title Host exposes real sharing and revalidates its existing service link", async () => {
  await environment(async (f) => {
    await f.render();
    assert.deepEqual(await f.menu(), [
      "Unpin",
      "Mark as unread",
      "Rename",
      "Add to project",
      "Move to group",
      "Share session",
      "Copy link",
      "Delete",
    ]);
    const menu = f.document.querySelector<HTMLElement>(
      ".native-conversation-title-menu",
    )!;
    assert.equal(menu.style.width, "max-content");
    assert.equal(menu.style.right, "852px");
    assert.equal(menu.style.left, undefined);
    f.state.current = share({
      url: "https://share.example.test/s/refreshed-link",
    });
    await f.click("Copy link");
    assert.equal(f.state.reads, 2);
    assert.deepEqual(f.copies, ["https://share.example.test/s/refreshed-link"]);
    assert.deepEqual(f.notifications, ["Link copied to clipboard."]);
    assert.equal(f.state.creates, 0);
  });
});

test("native title hides unavailable link actions and never substitutes Export or a made-up local URL", async () => {
  for (const status of [null, enabled])
    await environment(async (f) => {
      f.state.status = status;
      f.state.current = null;
      await f.render();
      const labels = await f.menu();
      assert.equal(labels.includes("Share session"), status !== null);
      assert.equal(labels.includes("Copy link"), false);
      assert.equal(
        labels.some((label) => label.startsWith("Export")),
        false,
      );
      assert.equal(f.copies.length, 0);
      assert.equal(f.state.creates, 0);
    });
});

test("native sharing uses actual message presence: an empty chat is unavailable and a persisted streaming prompt remains shareable", async () => {
  await environment(
    async (f) => {
      f.state.current = null;
      await f.render();
      assert.equal((await f.menu()).includes("Share session"), false);
      assert.equal(
        f.document.querySelector<HTMLButtonElement>(
          ".conversation-share-button",
        )?.disabled,
        true,
      );
      assert.equal(f.state.creates, 0);
    },
    { ...chat, turns: [] },
  );
  await environment(
    async (f) => {
      f.state.current = null;
      await f.render();
      assert.equal((await f.menu()).includes("Share session"), true);
      assert.equal(
        f.document.querySelector<HTMLButtonElement>(
          ".conversation-share-button",
        )?.disabled,
        false,
      );
      assert.equal(f.state.creates, 0);
    },
    { ...chat, turns: [{ ...chat.turns[0], status: "inProgress", items: [] }] },
  );
});

test("native title copies nothing after the shown share is revoked or expires", async () => {
  for (const current of [
    null,
    share({ status: "disabled" }),
    share({ expiresAt: Date.now() - 1 }),
  ])
    await environment(async (f) => {
      await f.render();
      assert.ok((await f.menu()).includes("Copy link"));
      f.state.current = current;
      await f.click("Copy link");
      assert.deepEqual(f.copies, []);
      assert.deepEqual(f.notifications, []);
      assert.equal(f.state.creates, 0);
    });
});

test("expired or unusable known links are absent before a native menu opens", async () => {
  for (const current of [
    share({ expiresAt: Date.now() - 1 }),
    share({ url: "javascript:alert(1)" }),
    share({ url: "https://user:pass@example.test/s/x" }),
  ])
    await environment(async (f) => {
      f.state.current = current;
      await f.render();
      assert.equal((await f.menu()).includes("Copy link"), false);
      assert.deepEqual(f.copies, []);
    });
});

test("the Host copy callback uses invited service URLs and stops on owner change", async () => {
  await environment(async (f) => {
    let owner = true;
    f.state.current = share({
      access: "invited",
      inviteUrl: "https://share.example.test/shared/invited-reference",
    });
    const copy = conversationTitleCopyLink(chat.id, f.state.current, {
      invited: true,
      isCurrent: () => owner,
      onCopied: () => f.notifications.push("copied"),
      onError: (error) => f.errors.push(error),
    })!;
    await copy();
    assert.deepEqual(f.copies, [
      "https://share.example.test/shared/invited-reference",
    ]);
    owner = false;
    await copy();
    assert.equal(f.copies.length, 1);
    assert.equal(f.state.reads, 1);
    assert.equal(f.state.creates, 0);
  });
});

test("native title density rules remain isolated from web and Code menu frames", async () => {
  const css = await readFile(
    new URL("../../src/sidebar/native-conversation-title.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /:root:not\(\[data-surface="web"\]\) body \.menu\.native-conversation-title-menu/,
  );
  assert.match(
    css,
    /\.native-conversation-title-menu\s*> button\s*\{[^}]*height: 24px;[^}]*font-size: 13px;[^}]*line-height: 19px;/s,
  );
  assert.doesNotMatch(
    css,
    /\.native-conversation-title-menu[^}]*width: (152|170)px/s,
  );
  const nativeEntry = await readFile(
    new URL("../../src/sidebar/native-chat-sidebar.css", import.meta.url),
    "utf8",
  );
  assert.match(nativeEntry, /^@import "\.\/native-conversation-title\.css";/);
  const sharedSheet = await readFile(
    new URL("../../src/conversation/conversation-title.css", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(sharedSheet, /native-conversation-title-menu/);
});

test("native project submenu caret uses the bare source end slot while shortcuts keep their own wrapper gap", async () => {
  const [shared, native] = await Promise.all([
    readFile(new URL("../../src/ui/menu.css", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../../src/sidebar/native-conversation-title.css",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  const { document } = parseHTML(
    '<html data-surface="desktop"><body><div class="menu native-conversation-title-menu"><button><span>Add to project</span><svg></svg></button><button><span>Rename</span><kbd>R</kbd></button></div></body></html>',
  );
  const arrow = document.querySelector("svg")!;
  const shortcut = document.querySelector("kbd")!;
  const row = arrow.parentElement!;
  const declarations = (element: Element) => {
    const values = new Map<string, string>();
    for (const css of [shared, native])
      postcss.parse(css).walkRules((rule) => {
        // Only the static resting rules are relevant to source slot spacing.
        // Linkedom has no interactive pseudo state or viewport/media engine.
        if (
          rule.parent?.type === "atrule" ||
          /:(?:hover|focus|active|disabled)|::/.test(rule.selector)
        )
          return;
        if (!element.matches(rule.selector)) return;
        rule.walkDecls((decl) => {
          values.set(decl.prop, decl.value);
        });
      });
    return values;
  };
  const arrowStyle = declarations(arrow);
  assert.equal(
    arrowStyle.get("margin"),
    "0",
    "remove the shared physical-right shorthand first",
  );
  assert.equal(
    arrowStyle.get("margin-inline-start"),
    undefined,
    "bare SubmenuTrigger has no ms-md wrapper",
  );
  assert.equal(
    arrowStyle.get("margin-inline-end"),
    "-4px",
    "source -me-1 maps to the end in both directions",
  );
  assert.equal(declarations(row).get("gap"), "6px");
  assert.equal(
    declarations(shortcut).get("margin-inline-start"),
    "8px",
    "Item shortcut has its separate source ms-md wrapper",
  );
  assert.equal(declarations(shortcut).get("font-size"), "12px");
});
