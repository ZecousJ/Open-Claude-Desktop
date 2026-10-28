import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, useState, type ReactNode } from "react";
import { JSDOM } from "jsdom";
import type { Conversation, Mode } from "../../shared/types";
import type { AppController } from "../../src/app/AppContext";
import { AppContext } from "../../src/app/AppContext";
import RowMenu from "../../src/sidebar/RowMenu";
import { SearchOverlay } from "../../src/app/CollectionOverlays";
import { SearchPalette } from "../../src/collections/search/SearchPalette";
import type { PaletteAction } from "../../src/collections/search/search-model";
import { rankPaletteActions } from "../../src/collections/search/action-ranking";
import { currentToasts, dismissAllToasts } from "../../src/ui/toast-store";
import { controllerPaletteActions } from "../../src/collections/search/palette-actions";

const noop = () => {};
const conversation = (extra: Partial<Conversation> = {}): Conversation => ({
  id: "saved-chat",
  title: "Saved chat",
  mode: "chat",
  archived: false,
  pinned: false,
  providerId: "p",
  model: "m",
  createdAt: 1,
  updatedAt: 1,
  turns: [],
  ...extra,
});

async function environment() {
  const dom = new JSDOM(
    '<html data-motion="reduced"><body><main></main></body></html>',
    { url: "http://localhost" },
  );
  const { window } = dom;
  const globals = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    navigator: window.navigator,
    localStorage: window.localStorage,
    innerWidth: 1440,
    innerHeight: 900,
    getComputedStyle: window.getComputedStyle.bind(window),
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    cancelAnimationFrame: clearTimeout,
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
  window.HTMLElement.prototype.scrollIntoView = noop;
  window.desktop = {
    listConversationGroups: async () => ({ groups: [], members: {} }),
    listSchedules: async () => [],
    searchConversations: async () => ({ results: [] }),
  } as never;
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(window.document.querySelector("main")!);
  return {
    window,
    document: window.document,
    render: (node: ReactNode) => act(async () => root.render(node)),
    click: (node: Element) =>
      act(async () => {
        node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      }),
    key: (node: Element, key: string, extra: KeyboardEventInit = {}) =>
      act(async () => {
        node.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
            ...extra,
          }),
        );
      }),
    type: (node: HTMLInputElement, value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(node, value);
        node.dispatchEvent(new window.Event("input", { bubbles: true }));
      }),
    async restore() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

for (const mode of ["cowork", "code"] as const) {
  test(`shell26 ${mode}: actual row menu archives and restores the selected saved record`, async () => {
    const env = await environment();
    const changes: Conversation[] = [];
    function Harness() {
      const [row, setRow] = useState(conversation({ mode }));
      return createElement(RowMenu, {
        conversation: row,
        projects: [],
        position: { top: 30, left: 30 },
        anchor: { current: null },
        onRename: noop,
        onNewGroup: noop,
        onClose: noop,
        actions: {
          onOpen: noop,
          onTogglePin: noop,
          onToggleUnread: noop,
          onRename: noop,
          onMoveToProject: noop,
          onDelete: noop,
          onOpenIn: noop,
          onToggleArchive: (current) => {
            changes.push(current);
            setRow({ ...current, archived: !current.archived });
          },
        },
      });
    }
    try {
      await env.render(createElement(Harness));
      const item = (label: string) =>
        [...env.document.querySelectorAll('[role="menuitem"]')].find((node) => {
          // Icon-font glyphs are private-use characters, not the label.
          const text = node.textContent?.replace(/[\ue000-\uf8ff]/g, "").trim();
          return text === label || text === `${label}A`;
        })!;
      assert.ok(item("Archive"));
      await env.click(item("Archive"));
      assert.equal(changes[0].id, "saved-chat");
      assert.equal(changes[0].archived, false);
      assert.ok(item("Unarchive"));
      await env.click(item("Unarchive"));
      assert.equal(changes[1].archived, true);
      assert.ok(item("Archive"));
    } finally {
      await env.restore();
    }
  });
}

test("shell26 saved Chat keeps Archive gated and an archived Chat can restore its stored record", async () => {
  const env = await environment();
  const changes: Conversation[] = [];
  function Harness({ archived }: { archived: boolean }) {
    const [row, setRow] = useState(conversation({ archived }));
    return createElement(RowMenu, {
      conversation: row,
      projects: [],
      position: { top: 30, left: 30 },
      anchor: { current: null },
      onRename: noop,
      onNewGroup: noop,
      onClose: noop,
      actions: {
        onOpen: noop,
        onTogglePin: noop,
        onToggleUnread: noop,
        onRename: noop,
        onMoveToProject: noop,
        onDelete: noop,
        onOpenIn: noop,
        onToggleArchive: (current) => {
          changes.push(current);
          setRow({ ...current, archived: !current.archived });
        },
      },
    });
  }
  const archiveItems = () =>
    [...env.document.querySelectorAll('[role="menuitem"]')].filter((node) =>
      /Archive|Unarchive/.test(node.textContent ?? ""),
    );
  try {
    await env.render(
      createElement(Harness, { key: "active", archived: false }),
    );
    assert.equal(archiveItems().length, 0);
    await env.render(
      createElement(Harness, { key: "archived", archived: true }),
    );
    assert.equal(archiveItems().length, 1);
    assert.match(archiveItems()[0].textContent ?? "", /Unarchive/);
    await env.click(archiveItems()[0]);
    assert.equal(changes[0].id, "saved-chat");
    assert.equal(changes[0].archived, true);
    assert.equal(archiveItems().length, 0);
  } finally {
    await env.restore();
  }
});

test("shell26 incognito Chat never offers Archive or Unarchive", async () => {
  const env = await environment();
  try {
    await env.render(
      createElement(RowMenu, {
        conversation: conversation({ incognito: true }),
        projects: [],
        position: { top: 30, left: 30 },
        anchor: { current: null },
        onRename: noop,
        onNewGroup: noop,
        onClose: noop,
        actions: {
          onOpen: noop,
          onTogglePin: noop,
          onToggleUnread: noop,
          onRename: noop,
          onMoveToProject: noop,
          onDelete: noop,
          onOpenIn: noop,
          onToggleArchive: () => assert.fail("temporary chat archived"),
        },
      }),
    );
    assert.equal(
      [...env.document.querySelectorAll('[role="menuitem"]')].some((node) =>
        /Archive|Unarchive/.test(node.textContent ?? ""),
      ),
      false,
    );
  } finally {
    await env.restore();
  }
});

function PaletteHarness({
  app,
  actions,
  start = "default",
  initialQuery = "",
  onNew = noop,
  onClose = noop,
}: {
  app?: Partial<AppController>;
  actions?: readonly PaletteAction[];
  start?: "default" | "actions";
  initialQuery?: string;
  onNew?: (mode: Mode) => void;
  onClose?: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [entrypoint, setEntrypoint] = useState<
    "default" | "search" | "actions"
  >(start);
  return createElement(
    AppContext.Provider,
    { value: (app as AppController) ?? null },
    createElement(SearchPalette, {
      query,
      onQueryChange: setQuery,
      entrypoint,
      onEntrypointChange: setEntrypoint,
      actions,
      sources: { conversations: [], projects: [], artifacts: [] },
      loadRoutines: async () => [],
      onOpen: () => assert.fail("action opened as a record"),
      onNew,
      onCompose: noop,
      onChooseFiles: async () => [],
      onRename: noop,
      onArchive: noop,
      onDelete: noop,
      onClose,
    }),
  );
}

const action = (
  key: string,
  title: string,
  hints: string[] = [],
): PaletteAction => ({
  key,
  title,
  kind: "action",
  group: "general",
  searchHints: hints,
  command: { type: "execute", execute: noop },
});

test("shell31 uses the source Fuse 7.4 ranking: prefixes, description/hint weights, typo threshold and query cap", () => {
  const commands = [
    action("hint", "Unrelated", ["project"]),
    action("contains", "Open project"),
    action("prefix", "Projects"),
    action("exact", "Project"),
  ];
  assert.deepEqual(
    rankPaletteActions(commands, "project").map((row) => row.key),
    ["exact", "prefix", "hint", "contains"],
  );
  assert.deepEqual(
    rankPaletteActions(commands, "projct").map((row) => row.key),
    ["prefix", "exact", "contains", "hint"],
  );
  assert.deepEqual(rankPaletteActions(commands, "x".repeat(51)), []);
  assert.deepEqual(rankPaletteActions(commands, "unmatchable"), []);
  assert.deepEqual(controllerPaletteActions(null), []);
  assert.deepEqual(controllerPaletteActions(undefined), []);
  assert.deepEqual(controllerPaletteActions({} as AppController), []);
});

test("shell31 Actions heading opens real commands despite an organic type filter; keyboard executes ranked action", async () => {
  const env = await environment();
  const calls: unknown[] = [];
  try {
    await env.render(
      createElement(PaletteHarness, {
        app: {
          setPage: (page) => calls.push(["page", page]),
          openSettingsTab: (tab) => calls.push(["settings", tab]),
        },
        onNew: (mode) => calls.push(["new", mode]),
        onClose: () => calls.push(["close"]),
      }),
    );
    const input = () =>
      env.document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    const options = () => [...env.document.querySelectorAll('[role="option"]')];
    await env.click(
      env.document.querySelector('[aria-label="Actions"] h3 button')!,
    );
    assert.ok(
      env.document.querySelector('[role="group"][aria-label="Navigation"]'),
    );
    assert.ok(env.document.querySelector('[role="group"][aria-label="Chat"]'));
    // Actions has no type tabs (the live palette hides them there), so an
    // organic type filter cannot narrow the commands.
    assert.equal(env.document.querySelector(".search-palette-filters"), null);
    assert.ok(options().some((node) => node.textContent?.includes("Recents")));
    await env.type(input(), "project");
    assert.deepEqual(
      options().map(
        (node) => node.querySelector(".search-row-name")?.textContent,
      ),
      ["Projects"],
    );
    assert.equal(
      input().getAttribute("aria-activedescendant"),
      options()[0].id,
    );
    await env.key(input(), "Enter");
    assert.deepEqual(calls, [["page", "projects"], ["close"]]);
    await env.type(input(), "history");
    await env.key(input(), "Enter");
    assert.deepEqual(calls.slice(-2), [["page", "history"], ["close"]]);
    await env.type(input(), "settings");
    await env.click(options()[0]);
    assert.deepEqual(calls.slice(-2), [["settings", "general"], ["close"]]);
    await env.type(input(), "new chat");
    await env.key(input(), "Enter");
    assert.deepEqual(calls.at(-1), ["new", "chat"]);
    await env.type(input(), "new code");
    await env.key(input(), "Enter");
    assert.deepEqual(calls.at(-1), ["new", "code"]);
  } finally {
    await env.restore();
  }
});

test("shell31 arrow keys wrap and execute the selected callback; keep-open commands clear the query", async () => {
  const env = await environment();
  const calls: string[] = [];
  const commands = [
    {
      ...action("first", "First command"),
      command: {
        type: "execute" as const,
        execute: () => {
          calls.push("first");
        },
      },
    },
    {
      ...action("toggle", "Toggle command"),
      keepsPaletteOpen: true,
      command: {
        type: "execute" as const,
        execute: () => {
          calls.push("toggle");
        },
      },
    },
  ];
  try {
    await env.render(
      createElement(PaletteHarness, {
        actions: commands,
        start: "actions",
        onClose: () => calls.push("close"),
      }),
    );
    const input = env.document.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    )!;
    await env.key(input, "ArrowUp");
    assert.equal(
      env.document.querySelector(
        '[aria-selected="true"][role="option"] .search-row-name',
      )?.textContent,
      "Toggle command",
    );
    await env.key(input, "ArrowDown");
    await env.key(input, "ArrowDown");
    await env.key(input, "Enter");
    assert.deepEqual(calls, ["toggle"]);
    await env.type(input, "toggle");
    await env.key(input, "Enter");
    assert.equal(input.value, "");
    assert.deepEqual(calls, ["toggle", "toggle"]);
    await env.key(input, "ArrowUp");
    await env.key(input, "ArrowDown");
    await env.key(input, "Enter");
    assert.deepEqual(calls.slice(-2), ["first", "close"]);
  } finally {
    await env.restore();
  }
});

test("shell31 pending promise prevents repeated pointer and keyboard execution, then closes once", async () => {
  const env = await environment();
  let resolve!: () => void;
  let executed = 0,
    closed = 0;
  const commands = [
    {
      ...action("async", "Async command"),
      command: {
        type: "execute" as const,
        execute: () => {
          executed++;
          return new Promise<void>((done) => {
            resolve = done;
          });
        },
      },
    },
  ];
  try {
    await env.render(
      createElement(PaletteHarness, {
        actions: commands,
        start: "actions",
        onClose: () => {
          closed++;
        },
      }),
    );
    const input = env.document.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    )!;
    await env.key(input, "Enter");
    const option = env.document.querySelector('[role="option"]')!;
    assert.equal(option.getAttribute("aria-busy"), "true");
    assert.equal(option.getAttribute("aria-disabled"), "true");
    await env.click(option);
    await env.key(input, "Enter");
    assert.equal(executed, 1);
    assert.equal(closed, 0);
    await act(async () => resolve());
    assert.equal(closed, 1);
    assert.equal(option.hasAttribute("aria-busy"), false);
  } finally {
    await env.restore();
  }
});

test("shell31 actual DOM rows preserve ranked source scores and execute the keyboard highlight", async () => {
  const env = await environment();
  const calls: string[] = [];
  const commands = [
    action("hint", "Unrelated", ["project"]),
    action("contains", "Open project"),
    action("prefix", "Projects"),
    action("exact", "Project"),
  ].map((row) => ({
    ...row,
    command: {
      type: "execute" as const,
      execute: () => {
        calls.push(row.key);
      },
    },
  }));
  try {
    await env.render(
      createElement(PaletteHarness, {
        actions: commands,
        start: "actions",
        initialQuery: "project",
      }),
    );
    const input = env.document.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    )!;
    const names = () =>
      [
        ...env.document.querySelectorAll('[role="option"] .search-row-name'),
      ].map((node) => node.textContent);
    assert.deepEqual(names(), [
      "Project",
      "Projects",
      "Unrelated",
      "Open project",
    ]);
    await env.key(input, "Enter", { isComposing: true });
    assert.deepEqual(calls, []);
    await env.key(input, "Enter");
    await env.key(input, "ArrowUp");
    assert.equal(
      env.document.querySelector(
        '[role="option"][aria-selected="true"] .search-row-name',
      )?.textContent,
      "Open project",
    );
    await env.key(input, "Enter");
    assert.deepEqual(calls, ["exact", "contains"]);
    await env.type(input, "projct");
    assert.deepEqual(names(), [
      "Projects",
      "Project",
      "Open project",
      "Unrelated",
    ]);
    await env.key(input, "Enter");
    assert.equal(calls.at(-1), "prefix");
  } finally {
    await env.restore();
  }
});

test("shell31 real SearchOverlay ranks New session first and Enter starts Chat while closing the palette", async () => {
  const env = await environment();
  const calls: Mode[] = [];
  function Harness() {
    const [search, setSearch] = useState<string | null>("new session");
    const app = {
      search,
      setSearch,
      searchEntrypoint: "default",
      mode: "chat",
      listed: [],
      snapshot: {
        conversations: [],
        projects: [],
        approvals: [],
        settings: {},
        artifactShares: [],
        artifactLibrary: { version: 1, copies: [], pinned: [] },
      },
      newChat: (mode: Mode) => {
        calls.push(mode);
      },
    } as unknown as AppController;
    return createElement(
      AppContext.Provider,
      { value: app },
      createElement(SearchOverlay),
    );
  }
  try {
    await env.render(createElement(Harness));
    for (
      let attempt = 0;
      attempt < 20 && !env.document.querySelector('[role="option"]');
      attempt++
    )
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    const options = [...env.document.querySelectorAll('[role="option"]')];
    assert.deepEqual(
      options.map(
        (node) => node.querySelector(".search-row-name")?.textContent,
      ),
      ["New session", "New Code session"],
    );
    assert.equal(options[0].getAttribute("aria-selected"), "true");
    const input = env.document.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    )!;
    await env.key(input, "Enter");
    assert.deepEqual(calls, ["chat"]);
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
  } finally {
    await env.restore();
  }
});

function deferredAction() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

for (const change of [
  "account",
  "controller scope",
  "controller ref",
  "bridge",
] as const) {
  for (const settlement of ["resolve", "reject"] as const) {
    test(`shell31 delayed ${settlement} after ${change} switch cannot close or release the new owner's action`, async () => {
      const env = await environment();
      const previous = deferredAction(),
        next = deferredAction();
      const closed: string[] = [],
        executions: string[] = [];
      const controller = { current: undefined as AppController | undefined };
      const before = {
        accountId: "account-a",
        controllerScope: {},
        currentController: controller,
      } as AppController;
      controller.current = before;
      const commands = (
        owner: string,
        pending: ReturnType<typeof deferredAction>,
      ) => [
        {
          ...action("same-command", "Async command"),
          command: {
            type: "execute" as const,
            execute: () => {
              executions.push(owner);
              return pending.promise;
            },
          },
        },
      ];
      const render = (
        app: AppController,
        owner: string,
        pending: ReturnType<typeof deferredAction>,
      ) =>
        env.render(
          createElement(PaletteHarness, {
            app,
            actions: commands(owner, pending),
            start: "actions",
            onClose: () => {
              closed.push(owner);
            },
          }),
        );
      try {
        dismissAllToasts();
        await render(before, "old", previous);
        const input = env.document.querySelector<HTMLInputElement>(
          'input[role="combobox"]',
        )!;
        await env.key(input, "Enter");
        assert.equal(
          env.document
            .querySelector('[role="option"]')
            ?.getAttribute("aria-busy"),
          "true",
        );
        const after = {
          ...before,
          ...(change === "account" ? { accountId: "account-b" } : {}),
          ...(change === "controller scope" ? { controllerScope: {} } : {}),
          ...(change === "controller ref"
            ? {
                currentController: {
                  current: undefined as AppController | undefined,
                },
              }
            : {}),
        };
        after.currentController!.current = after;
        if (change === "bridge") env.window.desktop = { ...env.window.desktop };
        await render(after, "new", next);
        assert.equal(
          env.document.querySelector('input[role="combobox"]'),
          input,
          "palette remains mounted across the owner switch",
        );
        assert.equal(
          env.document
            .querySelector('[role="option"]')
            ?.hasAttribute("aria-busy"),
          false,
        );
        await env.key(input, "Enter");
        const nextOption = env.document.querySelector('[role="option"]')!;
        assert.equal(nextOption.getAttribute("aria-busy"), "true");
        assert.deepEqual(executions, ["old", "new"]);
        await act(async () => {
          if (settlement === "resolve") previous.resolve();
          else previous.reject(new Error("retired account action failed"));
        });
        assert.deepEqual(closed, []);
        assert.equal(nextOption.getAttribute("aria-busy"), "true");
        assert.equal(
          currentToasts().length,
          0,
          "old failure must not toast the new account",
        );
        await env.key(input, "Enter");
        await env.click(nextOption);
        assert.deepEqual(
          executions,
          ["old", "new"],
          "old finalizer must not unlock the new request",
        );
        await act(async () => next.resolve());
        assert.deepEqual(closed, ["new"]);
        assert.equal(nextOption.hasAttribute("aria-busy"), false);
      } finally {
        previous.resolve();
        next.resolve();
        dismissAllToasts();
        await env.restore();
      }
    });
  }
}

test("shell31 keep-open command rejection cannot toast after its controller owner changes", async () => {
  const env = await environment();
  const pending = deferredAction();
  const scope = {},
    controller = { current: undefined as AppController | undefined };
  const before = {
    accountId: "before",
    controllerScope: scope,
    currentController: controller,
  } as AppController;
  controller.current = before;
  const commands = [
    {
      ...action("keep", "Keep command"),
      keepsPaletteOpen: true,
      command: { type: "execute" as const, execute: () => pending.promise },
    },
  ];
  try {
    dismissAllToasts();
    await env.render(
      createElement(PaletteHarness, {
        app: before,
        actions: commands,
        start: "actions",
      }),
    );
    await env.key(
      env.document.querySelector('input[role="combobox"]')!,
      "Enter",
    );
    const after = { ...before, accountId: "after" };
    controller.current = after;
    await env.render(
      createElement(PaletteHarness, {
        app: after,
        actions: commands,
        start: "actions",
      }),
    );
    await act(async () =>
      pending.reject(new Error("retired keep-open action failed")),
    );
    assert.equal(currentToasts().length, 0);
  } finally {
    pending.resolve();
    dismissAllToasts();
    await env.restore();
  }
});

for (const change of ["controller", "bridge"] as const)
  test(`shell31 live ${change} retires promises even before the palette rerenders`, async () => {
    const env = await environment();
    const pending = deferredAction();
    const controller = { current: undefined as AppController | undefined };
    const before = {
      accountId: "before",
      controllerScope: {},
      currentController: controller,
    } as AppController;
    controller.current = before;
    let closed = 0;
    try {
      dismissAllToasts();
      await env.render(
        createElement(PaletteHarness, {
          app: before,
          start: "actions",
          onClose: () => {
            closed++;
          },
          actions: [
            {
              ...action("async", "Async command"),
              command: { type: "execute", execute: () => pending.promise },
            },
          ],
        }),
      );
      await env.key(
        env.document.querySelector('input[role="combobox"]')!,
        "Enter",
      );
      if (change === "controller")
        controller.current = {
          ...before,
          accountId: "after",
          controllerScope: {},
        };
      else env.window.desktop = { ...env.window.desktop };
      await act(async () =>
        pending.reject(new Error("old owner failed before rerender")),
      );
      assert.equal(closed, 0);
      assert.equal(currentToasts().length, 0);
    } finally {
      pending.resolve();
      dismissAllToasts();
      await env.restore();
    }
  });

test("shell31 ordinary controller rerenders keep their own pending command locked and close it once", async () => {
  const env = await environment();
  const pending = deferredAction();
  const controller = { current: undefined as AppController | undefined };
  const before = {
    accountId: "same",
    controllerScope: {},
    currentController: controller,
  } as AppController;
  controller.current = before;
  let executed = 0,
    closed = 0;
  const commands = [
    {
      ...action("async", "Async command"),
      command: {
        type: "execute" as const,
        execute: () => {
          executed++;
          return pending.promise;
        },
      },
    },
  ];
  const render = (app: AppController) =>
    env.render(
      createElement(PaletteHarness, {
        app,
        actions: commands,
        start: "actions",
        onClose: () => {
          closed++;
        },
      }),
    );
  try {
    await render(before);
    const input = env.document.querySelector('input[role="combobox"]')!;
    await env.key(input, "Enter");
    const after = { ...before };
    controller.current = after;
    await render(after);
    assert.equal(
      env.document.querySelector('[role="option"]')?.getAttribute("aria-busy"),
      "true",
    );
    await env.key(input, "Enter");
    assert.equal(executed, 1);
    await act(async () => pending.resolve());
    assert.equal(closed, 1);
  } finally {
    pending.resolve();
    await env.restore();
  }
});

const mixedPaletteRows = () => [
  conversation({
    id: "c-changes",
    title: "Greet function and double utility",
    mode: "code",
    updatedAt: 20,
    turns: [
      {
        id: "changes-turn",
        prompt: "Update the utility",
        attachments: [],
        status: "completed",
        createdAt: 1,
        items: [
          {
            id: "changes-reply",
            type: "agentMessage",
            text: "utils.js (new): exports double(n).",
          },
        ],
      },
    ],
  }),
  conversation({ id: "stored-note", title: "Stored notes", updatedAt: 30 }),
  conversation({ id: "trip-chat", title: "Trip planning", updatedAt: 10 }),
];

function MixedOverlayHarness({
  rows = mixedPaletteRows(),
  onNew,
  onOpen,
}: {
  rows?: Conversation[];
  onNew: (mode: Mode) => void;
  onOpen: (row: Conversation) => void;
}) {
  const [search, setSearch] = useState<string | null>("");
  const [controllerScope] = useState({});
  const app = {
    search,
    setSearch,
    searchEntrypoint: "default",
    mode: "chat",
    page: "projects",
    projectId: "p-trip",
    accountId: "mixed-palette",
    controllerScope,
    listed: rows,
    snapshot: {
      conversations: rows,
      projects: [],
      approvals: [],
      settings: {},
      artifactShares: [],
      artifactLibrary: { version: 1, copies: [], pinned: [] },
    },
    newChat: onNew,
    openConversation: onOpen,
  } as unknown as AppController;
  return createElement(
    AppContext.Provider,
    { value: app },
    createElement(SearchOverlay),
  );
}

for (const phase of ["pending", "settled"] as const) {
  test(`shell31 real SearchOverlay input ranks new-session commands ahead of loaded organic matches while deeper search is ${phase}`, async () => {
    const env = await environment();
    const started: Mode[] = [],
      opened: string[] = [];
    let resolve!: (value: {
      results: {
        conversationId: string;
        title: string;
        mode: "chat";
        archived: boolean;
        updatedAt: number;
        snippet: string;
      }[];
    }) => void;
    env.window.desktop.searchConversations = () =>
      new Promise((done) => {
        resolve = done;
      });
    const optionNames = () =>
      [
        ...env.document.querySelectorAll('[role="option"] .search-row-name'),
      ].map((node) => node.textContent);
    try {
      await env.render(
        createElement(MixedOverlayHarness, {
          onNew: (mode) => {
            started.push(mode);
          },
          onOpen: (row) => {
            opened.push(row.id);
          },
        }),
      );
      for (
        let attempt = 0;
        attempt < 20 && !env.document.querySelector('[role="option"]');
        attempt++
      )
        await act(async () => {
          await new Promise((done) => setTimeout(done, 5));
        });
      const input = env.document.querySelector<HTMLInputElement>(
        'input[role="combobox"]',
      )!;
      await env.key(input, "ArrowDown");
      await env.key(input, "ArrowDown");
      assert.notEqual(
        input.getAttribute("aria-activedescendant"),
        "search-row-0",
      );
      await env.type(input, "new session");
      assert.equal(input.value, "new session");
      assert.deepEqual(optionNames().slice(0, 2), [
        "New session",
        "New Code session",
      ]);
      assert.ok(
        optionNames().includes("Greet function and double utility"),
        "real loaded reply provides the competing partial organic hit",
      );
      const selected = () =>
        env.document.querySelector('[role="option"][aria-selected="true"]')!;
      assert.equal(
        selected().querySelector(".search-row-name")?.textContent,
        "New session",
      );
      assert.equal(input.getAttribute("aria-activedescendant"), selected().id);
      await act(async () => {
        await new Promise((done) => setTimeout(done, 330));
      });
      assert.ok(resolve);
      if (phase === "settled") {
        await act(async () =>
          resolve({
            results: [
              {
                conversationId: "stored-note",
                title: "Stored notes",
                mode: "chat",
                archived: false,
                updatedAt: 30,
                snippet: "Notes from the new session",
              },
            ],
          }),
        );
        assert.ok(
          optionNames().includes("Stored notes"),
          "deeper content results join the real list",
        );
        assert.deepEqual(optionNames().slice(0, 2), [
          "New session",
          "New Code session",
        ]);
        assert.equal(
          selected().querySelector(".search-row-name")?.textContent,
          "New session",
        );
        assert.equal(
          input.getAttribute("aria-activedescendant"),
          selected().id,
        );
      }
      await env.key(input, "Enter");
      assert.deepEqual(started, ["chat"]);
      assert.deepEqual(opened, [], "Enter must not open an old Code result");
      assert.equal(env.document.querySelector('[role="dialog"]'), null);
      if (phase === "pending") await act(async () => resolve({ results: [] }));
    } finally {
      await env.restore();
    }
  });
}

test("shell31 mixed title tiers put commands before organic peers and keep stronger organic prefixes before weaker commands", async () => {
  const env = await environment();
  const rows = [
    ...mixedPaletteRows(),
    conversation({
      id: "prefix",
      title: "New session checklist",
      updatedAt: 40,
    }),
    conversation({
      id: "lexical",
      title: "Previous new session",
      updatedAt: 50,
    }),
  ];
  try {
    await env.render(
      createElement(MixedOverlayHarness, { rows, onNew: noop, onOpen: noop }),
    );
    for (
      let attempt = 0;
      attempt < 20 && !env.document.querySelector('[role="option"]');
      attempt++
    )
      await act(async () => {
        await new Promise((done) => setTimeout(done, 5));
      });
    await env.type(
      env.document.querySelector<HTMLInputElement>('input[role="combobox"]')!,
      "new session",
    );
    assert.deepEqual(
      [
        ...env.document.querySelectorAll('[role="option"] .search-row-name'),
      ].map((node) => node.textContent),
      [
        "New session",
        "New session checklist",
        "New Code session",
        "Previous new session",
        "Greet function and double utility",
      ],
    );
  } finally {
    await env.restore();
  }
});

test("shell31 keyboard selection follows its organic row when a stronger deeper result arrives", async () => {
  const env = await environment();
  const opened: string[] = [];
  let resolve!: (value: {
    results: {
      conversationId: string;
      title: string;
      mode: "chat";
      archived: boolean;
      updatedAt: number;
      snippet: string;
    }[];
  }) => void;
  env.window.desktop.searchConversations = () =>
    new Promise((done) => {
      resolve = done;
    });
  try {
    await env.render(
      createElement(MixedOverlayHarness, {
        onNew: () => assert.fail("keyboard selected a conversation"),
        onOpen: (row) => {
          opened.push(row.id);
        },
      }),
    );
    for (
      let attempt = 0;
      attempt < 20 && !env.document.querySelector('[role="option"]');
      attempt++
    )
      await act(async () => {
        await new Promise((done) => setTimeout(done, 5));
      });
    const input = env.document.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    )!;
    await env.type(input, "new session");
    await env.key(input, "ArrowDown");
    await env.key(input, "ArrowDown");
    const selectedName = () =>
      env.document.querySelector(
        '[role="option"][aria-selected="true"] .search-row-name',
      )?.textContent;
    assert.equal(selectedName(), "Greet function and double utility");
    await act(async () => {
      await new Promise((done) => setTimeout(done, 330));
    });
    await act(async () =>
      resolve({
        results: [
          {
            conversationId: "stored-note",
            title: "Stored notes",
            mode: "chat",
            archived: false,
            updatedAt: 30,
            snippet: "Notes from the new session",
          },
        ],
      }),
    );
    assert.equal(selectedName(), "Greet function and double utility");
    assert.equal(input.getAttribute("aria-activedescendant"), "search-row-3");
    await env.key(input, "Enter");
    assert.deepEqual(opened, ["c-changes"]);
  } finally {
    await env.restore();
  }
});
