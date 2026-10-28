import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h, useState } from "react";
import type { Conversation, Mode, Project } from "../../shared/types";
import type { AppController } from "../../src/app/AppContext";
import type { RowActions } from "../../src/sidebar/ConversationRow";
import type { SidePanel } from "../../src/conversation/ToolSidePanel";

// Exercise the actual web title variant in this test worker. Native title
// density is independently covered by native-conversation-title.test.ts.
(globalThis as { __CLAUDEX_SURFACE__?: string }).__CLAUDEX_SURFACE__ = "web";
const [
  routes,
  { applyRoute, historyStep },
  requests,
  { default: RowMenu },
  { ConversationTitle },
  { AppContext },
  { HostContext },
  { webHost, desktopHost },
  { ConversationPanelButtons },
  { ToolSidePanel },
  { defaultSettings },
  { routineDom },
] = await Promise.all([
  import("../../src/web/routes"),
  import("../../src/web/web-route-apply"),
  import("../../src/collections/open-requests"),
  import("../../src/sidebar/RowMenu"),
  import("../../src/conversation/ConversationTitle"),
  import("../../src/app/AppContext"),
  import("../../src/host/HostContext"),
  import("../../shared/host"),
  import("../../src/conversation/ConversationPanelButtons"),
  import("../../src/conversation/ToolSidePanel"),
  import("../../electron/store/store"),
  import("../support/routine-dom"),
]);
const { rowMenuEntries } = await import("../../src/sidebar/row-menu-entries");

const row = (mode: Mode, patch: Partial<Conversation> = {}): Conversation => ({
  id: `batch21-${mode}`,
  title: `Stored ${mode}`,
  mode,
  providerId: "test",
  model: "test-model",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns: [],
  ...patch,
});
const project: Project = {
  id: "project α",
  name: "Project",
  description: "",
  instructions: "",
  createdAt: 1,
};
const noop = () => {};
function controller(conversations: Conversation[] = []) {
  const calls: unknown[][] = [];
  const app = {
    accountId: "batch21-owner",
    controllerScope: {},
    page: "chat",
    mode: "chat",
    activeId: undefined,
    active: undefined,
    settingsOpen: false,
    search: null,
    panel: null,
    snapshot: { conversations, projects: [project], settings: defaultSettings },
    setPage(page: string) {
      calls.push(["page", page]);
      app.page = page;
    },
    setMode(mode: Mode) {
      calls.push(["mode", mode]);
      app.mode = mode;
    },
    setSearch(value: string | null) {
      calls.push(["search", value]);
      app.search = value;
    },
    setSettingsOpen(value: boolean) {
      app.settingsOpen = value;
    },
    openSettingsTab(tab: string) {
      calls.push(["settings", tab]);
      app.settingsOpen = true;
    },
    openConversation(c: Conversation) {
      calls.push(["open", c.id, c.mode]);
      app.active = c;
      app.activeId = c.id;
      app.mode = c.mode;
      app.page = "chat";
    },
    newChat(mode: Mode) {
      calls.push(["new", mode]);
      app.mode = mode;
    },
    report(error: Error) {
      calls.push(["error", error.message]);
    },
  } as unknown as AppController;
  return { app, calls };
}

test("existing project and Scheduled aliases resolve to the captured canonical routes without losing identity", () => {
  for (const [path, canonical] of [
    ["/projects", "/projects"],
    ["/projects", "/projects"],
    ["/project/project%20%CE%B1", "/project/project%20%CE%B1"],
    ["/project/project%20%CE%B1", "/project/project%20%CE%B1"],
    ["/scheduled", "/scheduled-task"],
    ["/scheduled-task/task-id", "/scheduled-task/task-id"],
  ]) {
    const parsed = routes.parseWebRoute(path);
    assert.equal(routes.formatWebRoute(parsed), canonical, path);
    assert.deepEqual(routes.parseWebRoute(canonical), parsed);
    assert.equal(routes.initialWebMode(parsed), "chat");
  }
  assert.equal(
    routes.urlForState({
      page: "projects",
      mode: "cowork",
      projectId: project.id,
    }),
    "/project/project%20%CE%B1",
  );
});

test("real route application canonicalizes both project spellings and preserves the requested project", () => {
  try {
    for (const path of [
      "/project/project%20%CE%B1",
      "/project/project%20%CE%B1",
    ]) {
      const { app, calls } = controller();
      assert.equal(
        applyRoute(app, routes.parseWebRoute(path), {
          codeAvailable: true,
          initial: true,
        }),
        "/project/project%20%CE%B1",
      );
      assert.equal(requests.projectRequest(), project.id);
      assert.deepEqual(calls, [["page", "projects"]]);
    }
    const { app } = controller();
    app.page = "projects";
    const background = routes.parseWebRoute("/project/project%20%CE%B1");
    const settings = routes.formatWebRoute({
      kind: "settings",
      tab: "privacy",
      background,
    });
    assert.equal(
      settings,
      "/project/project%20%CE%B1#settings/data-privacy-controls",
    );
  } finally {
    requests.clearProjectRequest();
  }
});

test("canonicalization keeps Settings destinations and rejects malformed project segments", () => {
  const parsed = routes.parseWebRoute(
    "/project/project%20%CE%B1",
    "?connector=demo",
    "#settings/connectors",
  );
  const formatted = routes.formatWebRoute(parsed)!;
  assert.equal(
    formatted,
    "/project/project%20%CE%B1?connector=demo#settings/connectors",
  );
  const url = new URL(formatted, "https://example.invalid");
  assert.deepEqual(
    routes.parseWebRoute(url.pathname, url.search, url.hash),
    parsed,
  );
  for (const id of ["%2Fescape", "%5Cescape", "%00", "%zz"])
    for (const prefix of ["/project/", "/project/"])
      assert.deepEqual(routes.parseWebRoute(prefix + id), {
        kind: "not-found",
      });
  assert.equal(
    historyStep({
      previous: { url: "/project/a", settingsOpen: false },
      next: { url: "/projects", settingsOpen: false },
      address: "/project/a",
      openedSettings: false,
      draftKnown: null,
    }),
    "none",
    "a mounted collection must not overwrite its concrete project route",
  );
});

for (const mode of ["chat", "cowork", "code"] as const) {
  test(`restoring a stored ${mode} record routes by its real kind without rewriting it`, () => {
    const conversation = row(mode, {
      cwd: mode === "cowork" ? "/existing/folder" : undefined,
    });
    const original = structuredClone(conversation);
    const { app, calls } = controller([conversation]);
    const address = applyRoute(
      app,
      { kind: "chat", id: conversation.id },
      { codeAvailable: true, initial: true },
    );
    assert.equal(
      address,
      `${mode === "code" ? "/code" : "/chat"}/${conversation.id}`,
    );
    assert.equal(app.active, conversation);
    assert.equal(app.mode, mode);
    assert.deepEqual(calls, [["open", conversation.id, mode]]);
    assert.deepEqual(conversation, original);
    assert.equal(
      routes.urlForState({
        page: "chat",
        mode: "chat",
        conversationId: conversation.id,
        conversationMode: mode,
      }),
      address,
    );
  });
}

test("restoring Settings over an existing Cowork record preserves its execution kind and folder", () => {
  const conversation = row("cowork", { cwd: "/existing/folder" });
  const { app, calls } = controller([conversation]);
  app.active = conversation;
  app.activeId = conversation.id;
  app.mode = conversation.mode;
  const parsed = routes.parseWebRoute(
    `/chat/${conversation.id}`,
    "",
    "#settings/data-privacy-controls",
  );
  assert.equal(
    applyRoute(app, parsed, { codeAvailable: true, initial: true }),
    `/chat/${conversation.id}#settings/data-privacy-controls`,
  );
  assert.deepEqual(calls, [["settings", "privacy"]]);
  assert.equal(app.active.cwd, "/existing/folder");
  assert.equal(app.active.mode, "cowork");
});

async function environment(bridge: Parameters<typeof routineDom>[0] = {}) {
  const env = await routineDom(
    {
      listConversationGroups: async () => ({ groups: [], members: {} }),
      ...bridge,
    },
    { jsdom: true },
  );
  const globals = { innerWidth: 1440, innerHeight: 900 };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.assign(env.window, globals);
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  return {
    ...env,
    async clean() {
      await env.clean();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

for (const mode of ["chat", "cowork"] as const) {
  test(`the real archived ${mode} row can unarchive its exact record without changing stored kind`, async () => {
    let current = row(mode, { archived: true });
    const calls: unknown[][] = [];
    const env = await environment({
      updateConversation: async (id, patch) => {
        calls.push([id, patch]);
        current = { ...current, ...patch } as Conversation;
        return current;
      },
    });
    const actions: RowActions = {
      onOpen: noop,
      onTogglePin: noop,
      onRename: noop,
      onMoveToProject: noop,
      onToggleArchive: (c) => {
        void env.window.desktop.updateConversation(c.id, {
          archived: !c.archived,
        });
      },
      onDelete: noop,
      onToggleUnread: noop,
      onOpenIn: noop,
    };
    try {
      await env.render(
        h(
          HostContext.Provider,
          { value: webHost },
          h(RowMenu, {
            conversation: current,
            projects: [],
            actions,
            position: { top: 10, left: 10 },
            anchor: { current: null },
            onRename: noop,
            onNewGroup: noop,
            onClose: noop,
          }),
        ),
      );
      const unarchive = [
        ...env.document.querySelectorAll('[role="menuitem"]'),
      ].find((button) => button.textContent?.includes("Unarchive"));
      assert.ok(unarchive);
      await env.event(unarchive, "click");
      assert.deepEqual(calls, [[current.id, { archived: false }]]);
      assert.equal(current.archived, false);
      assert.equal(current.mode, mode);
    } finally {
      await env.clean();
    }
  });
}

test("archive remains conditional for fresh Chat, and incognito never gains an Unarchive action", async () => {
  for (const conversation of [
    row("chat"),
    row("chat", { archived: true, incognito: true }),
  ]) {
    const env = await environment();
    try {
      await env.render(
        h(RowMenu, {
          conversation,
          projects: [],
          position: { top: 10, left: 10 },
          anchor: { current: null },
          actions: {
            onOpen: noop,
            onTogglePin: noop,
            onRename: noop,
            onMoveToProject: noop,
            onToggleArchive: noop,
            onDelete: noop,
            onToggleUnread: noop,
            onOpenIn: noop,
          },
          onRename: noop,
          onNewGroup: noop,
          onClose: noop,
        }),
      );
      const labels = [
        ...env.document.querySelectorAll('[role="menuitem"]'),
      ].map((button) => button.textContent);
      assert.equal(
        labels.some((label) => /Archive|Unarchive/.test(label ?? "")),
        false,
      );
    } finally {
      await env.clean();
    }
  }
});

for (const mode of ["chat", "cowork"] as const) {
  test(`reuse: the current ${mode} web title keeps separate Rename and its supported menu actions`, async () => {
    const env = await environment();
    const calls: string[] = [];
    const conversation = row(mode);
    try {
      await env.render(
        h(ConversationTitle, {
          conversation,
          projects: [],
          running: false,
          actions: {
            onPin: () => calls.push("pin"),
            onRename: noop,
            onRenameDialog: () => calls.push("rename"),
            onMoveToProject: noop,
            onCreateProject: noop,
            onOpenProjects: noop,
            onArchive: noop,
            onDelete: noop,
            onShare: () => calls.push("share"),
          },
        }),
      );
      assert.ok(env.document.querySelector(".thread-title-split"));
      await env.click(".thread-rename-trigger");
      assert.deepEqual(calls, ["rename"]);
      await env.click(".thread-menu-trigger");
      const items = [...env.document.querySelectorAll('[role="menuitem"]')];
      assert.deepEqual(
        items.map((item) => item.querySelector(":scope > span")?.textContent),
        ["Pin", "Rename", "Add to project", "Share session", "Delete"],
      );
      await env.event(
        items.find((item) => item.textContent?.includes("Share session"))!,
        "click",
      );
      assert.deepEqual(calls, ["rename", "share"]);
      assert.equal(conversation.mode, mode);
    } finally {
      await env.clean();
    }
  });
}

for (const mode of ["chat", "cowork"] as const) {
  test(`reuse: stored ${mode} toggles and closes the real lazy unified Activity route`, async () => {
    const env = await environment();
    const conversation = row(mode);
    function Harness() {
      const [panel, setPanel] = useState<SidePanel | null>(null);
      return h(
        HostContext.Provider,
        { value: desktopHost },
        h(
          "div",
          { className: "workspace" },
          h(ConversationPanelButtons, {
            conversation,
            mode,
            panel,
            onTogglePanel: (next) =>
              setPanel((old) => (old === next ? null : next)),
          }),
          h(
            "div",
            { className: "chat-layout" },
            panel &&
              h(ToolSidePanel, {
                panel,
                conversation,
                accountId: "batch21",
                onClose: () => setPanel(null),
                onArtifact: noop,
                onStopAgent: async () => {},
                onRefreshWorkflow: async () => {},
                onStopTerminal: async () => true,
                onStopCommand: async () => {},
                onClearFinished: async () => {},
                onReadAgent: async () => ({
                  model: "m",
                  context: "",
                  status: "completed" as const,
                  items: [],
                  toolUses: 0,
                }),
                onShowBackground: noop,
                dismissedFinished: [],
                engineReady: true,
                onError(error) {
                  throw error;
                },
              }),
          ),
        ),
      );
    }
    try {
      await env.render(h(Harness));
      const toggle = () =>
        env.document.querySelector('[aria-label="Activity panel"]')!;
      assert.equal(toggle().getAttribute("aria-pressed"), "false");
      await env.event(toggle(), "click");
      for (
        let attempt = 0;
        attempt < 40 &&
        !env.document.querySelector(
          'aside[aria-label="Session activity panel"]',
        );
        attempt++
      )
        await act(async () => new Promise((resolve) => setImmediate(resolve)));
      assert.equal(toggle().getAttribute("aria-pressed"), "true");
      const panel = env.document.querySelector(
        'aside[aria-label="Session activity panel"]',
      );
      assert.ok(panel);
      assert.match(panel.textContent!, /Nothing here yet/);
      assert.match(
        panel.textContent!,
        /Files Claudex makes and tools it uses will show up here/,
      );
      await env.click('[aria-label="Close activity panel"]');
      assert.equal(toggle().getAttribute("aria-pressed"), "false");
      assert.equal(
        env.document.querySelector(
          'aside[aria-label="Session activity panel"]',
        ),
        null,
      );
      assert.equal(conversation.mode, mode);
    } finally {
      await env.clean();
    }
  });
}
