import test from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import type { Conversation } from "../../shared/types";
import {
  AppContext,
  type AppController,
  type NewChatDraft,
} from "../../src/app/AppContext";
import { defaultFilter, type ListFilter } from "../../src/sidebar/listFilter";
import { historyFilterEntries } from "../../src/sidebar/HistoryFilter";
import {
  effectiveGroupBy,
  emptyGroupsShown,
  groupRows,
} from "../../src/sidebar/grouping";
import { chatGroupState } from "../../src/sidebar/chat-state-groups";
import {
  createScheduledChat,
  scheduledChatPrompt,
} from "../../src/sidebar/create-scheduled-chat";
import {
  cancelComposerSubmitFor,
  cancelStaleComposerSubmit,
  onComposerSubmitRequest,
} from "../../src/composer/submit-request";
import { NavCreatePopup } from "../../src/sidebar/NavCreatePopup";
import { onScheduleRequest } from "../../src/collections/routines/schedule-request";
import { setLocale, t } from "../../src/i18n";
import { webHost, desktopHost } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { routineDom } from "../support/routine-dom";
import type { MenuEntry } from "../../src/ui/Menu";

const labels = (entries: MenuEntry[]) =>
  entries.map((entry) =>
    "label" in entry ? entry.label : "separator" in entry ? "—" : entry.heading,
  );
const item = (entries: MenuEntry[], label: string) => {
  const found = entries.find(
    (entry) => "label" in entry && entry.label === label,
  );
  assert.ok(found && "label" in found, label);
  return found;
};
const row = (id: string, patch: Partial<Conversation> = {}): Conversation => ({
  id,
  title: id,
  mode: "chat",
  providerId: "fixture",
  model: "model",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  turns: [],
  ...patch,
});
const turn = (
  status: "completed" | "inProgress" | "failed",
): Conversation["turns"][number] => ({
  id: status,
  prompt: "Synthetic",
  attachments: [],
  createdAt: 1,
  status,
  items: [],
});

test("current web/native unified recents have the exact observed four roots and five Group by radios, while legacy and Code stay independent", () => {
  for (const mode of ["chat", "cowork"] as const) {
    const entries = historyFilterEntries(mode, defaultFilter, () => {}, {
      unifiedChat: true,
      emptyGroups: true,
      prStatus: true,
    });
    assert.deepEqual(labels(entries), [
      "Status",
      "Last activity",
      "—",
      "Group by",
      "Sort by",
    ]);
    assert.deepEqual(labels(item(entries, "Status").submenu!), [
      "Active",
      "Archived",
      "All",
    ]);
    assert.deepEqual(labels(item(entries, "Last activity").submenu!), [
      "1d",
      "3d",
      "7d",
      "30d",
      "All",
    ]);
    assert.deepEqual(labels(item(entries, "Group by").submenu!), [
      "Date",
      "Unread",
      "State",
      "Custom groups",
      "—",
      "None",
    ]);
    assert.deepEqual(labels(item(entries, "Sort by").submenu!), [
      "Name",
      "Date created",
      "Last activity",
    ]);
  }
  const legacy = historyFilterEntries("chat", defaultFilter, () => {});
  assert.deepEqual(labels(item(legacy, "Group by").submenu!), [
    "Date",
    "Type",
    "Unread",
    "Custom groups",
    "—",
    "None",
  ]);
  const code = historyFilterEntries("code", defaultFilter, () => {}, {
    unifiedChat: true,
  });
  assert.deepEqual(labels(item(code, "Group by").submenu!), [
    "Date",
    "Folder",
    "State",
    "Custom groups",
    "—",
    "None",
  ]);
  assert.equal(item(item(code, "Group by").submenu!, "State").disabled, true);
  assert.equal(effectiveGroupBy("code", "state"), "none");
});

test("non-Code State groups follow actual chat/task signals: ordinary replies stay Idle and no empty task becomes Completed", () => {
  const approvals = new Set(["approval"]);
  const cases = [
    [row("plain-complete", { turns: [turn("completed")] }), "idle"],
    [
      row("plain-code-state", {
        turns: [turn("completed")],
        sessionState: "done",
      }),
      "idle",
    ],
    [row("plain-failed", { turns: [turn("failed")] }), "idle"],
    [row("unread", { unread: true }), "ready"],
    [row("running", { unread: true, turns: [turn("inProgress")] }), "working"],
    [row("approval", { turns: [turn("inProgress")] }), "blocked"],
    [row("empty-agent", { mode: "cowork" }), "idle"],
    [row("empty-unread-agent", { mode: "cowork", unread: true }), "idle"],
    [
      row("agent-complete", { mode: "cowork", turns: [turn("completed")] }),
      "done",
    ],
    [
      row("agent-unread", {
        mode: "cowork",
        unread: true,
        turns: [turn("completed")],
      }),
      "ready",
    ],
    [
      row("agent-failed", { mode: "cowork", turns: [turn("failed")] }),
      "blocked",
    ],
    [
      row("archived-plain", {
        archived: true,
        unread: true,
        turns: [turn("completed")],
      }),
      "idle",
    ],
    [
      row("archived-task", {
        mode: "cowork",
        archived: true,
        turns: [turn("completed")],
      }),
      "done",
    ],
  ] as const;
  for (const [record, expected] of cases)
    assert.equal(chatGroupState(record, approvals), expected, record.id);
  const groups = groupRows(
    cases.map(([record]) => record),
    "state",
    undefined,
    undefined,
    undefined,
    approvals,
  );
  assert.deepEqual(
    groups.map((group) => group.label),
    ["Needs input", "Working", "Ready", "Completed", "Idle"],
  );
  assert.ok(
    groups.at(-1)!.rows.some((record) => record.id === "plain-complete"),
  );
});

test("unified custom-group toggle changes the actual empty rows and reset, without adding PR or changing legacy behavior", () => {
  let value: ListFilter = { ...defaultFilter, groupBy: "custom" };
  const entries = () =>
    historyFilterEntries(
      "chat",
      value,
      (next) => {
        value = next;
      },
      { unifiedChat: true, emptyGroups: true, prStatus: true },
    );
  assert.deepEqual(labels(entries()).slice(-4), [
    "—",
    "Show empty groups",
    "—",
    "Reset to defaults",
  ]);
  assert.equal(labels(entries()).includes("Show PR status"), false);
  const custom = {
    groups: [
      { id: "empty-group-shell58", name: "Synthetic empty", createdAt: 1 },
    ],
    members: {},
  };
  const shown = () =>
    groupRows(
      [],
      "custom",
      undefined,
      custom,
      emptyGroupsShown("chat", Boolean(value.showEmptyGroups), new Set(), true),
    );
  assert.deepEqual(shown(), []);
  const toggle = item(entries(), "Show empty groups");
  assert.equal(toggle.keepOpen, true);
  assert.equal(toggle.checked, false);
  toggle.onSelect!();
  assert.equal(value.showEmptyGroups, true);
  assert.equal(shown()[0].label, "Synthetic empty");
  item(entries(), "Reset to defaults").onSelect!();
  assert.equal(value.groupBy, "none");
  assert.equal(value.showEmptyGroups, false);
  assert.equal(
    emptyGroupsShown("chat", false, new Set())("legacy-empty"),
    true,
  );
});

function controllerFixture() {
  const controllerScope = {};
  const current = { current: undefined as AppController | undefined };
  const calls: unknown[][] = [];
  let commit: ((created?: NewChatDraft) => void) | undefined;
  const app = {
    accountId: "schedule-owner-A",
    controllerScope,
    currentController: current,
    page: "chat",
    mode: "chat",
    activeId: "old-session",
    active: row("old-session"),
    draftSession: "old-draft",
    text: "Existing user's text",
    skillTokens: [{ raw: "$private" }],
    attachments: [{ id: "private-file" }],
    incognitoShown: false,
    sending: false,
    running: false,
    newChat(
      mode: string,
      _project: unknown,
      incognito: boolean,
      afterStart?: (created?: NewChatDraft) => void,
    ) {
      calls.push(["new", mode, incognito]);
      commit = afterStart;
    },
    setText(text: string) {
      calls.push(["text", text]);
      current.current = { ...current.current!, text };
    },
    setSkillTokens(skillTokens: []) {
      calls.push(["tokens", skillTokens]);
      current.current = { ...current.current!, skillTokens };
    },
    setAttachments(attachments: []) {
      calls.push(["files", attachments]);
      current.current = { ...current.current!, attachments };
    },
  } as unknown as AppController;
  current.current = app;
  return {
    app,
    current,
    calls,
    commit(id = "actual-new-draft", mode: NewChatDraft["mode"] = "chat") {
      current.current = {
        ...current.current!,
        page: "chat",
        active: undefined,
        activeId: undefined,
        draftSession: id,
        mode,
      };
      commit?.({ draftSession: id, mode });
    },
    missingReceipt() {
      commit?.();
    },
  };
}
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("English Create with Claudex waits for the real new draft receipt and its exact lazy Composer listener, never the previous session", async () => {
  const env = await routineDom({
    routineCapabilities: async () => ({
      remote: false,
      email: false,
      slack: false,
      setupWithChat: true,
      sources: ["chat", "code"],
    }),
  });
  const f = controllerFixture();
  const sent: unknown[] = [];
  const old = onComposerSubmitRequest("old-session:chat", () =>
    sent.push("old session"),
  );
  let ready: (() => void) | undefined;
  try {
    await createScheduledChat(f.app, scheduledChatPrompt);
    assert.deepEqual(f.calls, [["new", "chat", false]]);
    assert.equal(f.current.current?.text, "Existing user's text");
    f.commit();
    await tick();
    assert.equal(sent.length, 0);
    assert.equal(f.current.current?.text, scheduledChatPrompt);
    assert.deepEqual(f.current.current?.attachments, []);
    assert.deepEqual(f.current.current?.skillTokens, []);
    ready = onComposerSubmitRequest("actual-new-draft:chat", () =>
      sent.push({
        text: f.current.current!.text,
        id: f.current.current!.activeId,
      }),
    );
    await tick();
    assert.deepEqual(sent, [{ text: scheduledChatPrompt, id: undefined }]);
    ready();
    let duplicates = 0;
    ready = onComposerSubmitRequest(
      "actual-new-draft:chat",
      () => duplicates++,
    );
    await tick();
    assert.equal(sent.length, 1);
    assert.equal(duplicates, 0);
  } finally {
    old();
    ready?.();
    cancelComposerSubmitFor(f.app.controllerScope!);
    await env.clean();
  }
});

test("the actual Chinese translation is a draft; an older host without a draft receipt never writes into its old session", async () => {
  const env = await routineDom({
    routineCapabilities: async () => ({
      remote: false,
      email: false,
      slack: false,
      setupWithChat: true,
      sources: ["chat", "code"],
    }),
  });
  const f = controllerFixture();
  let sends = 0;
  let ready: (() => void) | undefined;
  try {
    await setLocale("zh-CN");
    const translated = t(scheduledChatPrompt);
    assert.notEqual(translated, scheduledChatPrompt);
    await createScheduledChat(f.app, translated);
    f.commit();
    ready = onComposerSubmitRequest("actual-new-draft:chat", () => sends++);
    await tick();
    assert.equal(sends, 0);
    assert.equal(f.current.current?.text, translated);
    const legacy = controllerFixture();
    await createScheduledChat(legacy.app, scheduledChatPrompt);
    legacy.missingReceipt();
    assert.equal(legacy.current.current?.text, "Existing user's text");
    assert.deepEqual(legacy.calls, [["new", "chat", false]]);
  } finally {
    ready?.();
    cancelComposerSubmitFor(f.app.controllerScope!);
    await setLocale("en-US");
    await env.clean();
  }
});

for (const change of [
  "account",
  "controller",
  "bridge",
  "navigation",
  "draft",
  "text",
  "resources",
] as const)
  test(`a delayed task-chat submit cannot survive ${change} and cannot resume after returning`, async () => {
    const env = await routineDom({
      routineCapabilities: async () => ({
        remote: false,
        email: false,
        slack: false,
        setupWithChat: true,
        sources: ["chat", "code"],
      }),
    });
    const f = controllerFixture();
    let sends = 0;
    let ready: (() => void) | undefined;
    try {
      await createScheduledChat(f.app, scheduledChatPrompt);
      f.commit();
      const intended = f.current.current!;
      if (change === "bridge") env.window.desktop = { ...env.window.desktop };
      else
        f.current.current = {
          ...intended,
          ...(change === "account"
            ? { accountId: "schedule-owner-B" }
            : change === "controller"
              ? { controllerScope: {} }
              : change === "navigation"
                ? { page: "history" }
                : change === "draft"
                  ? { draftSession: "other-draft" }
                  : change === "text"
                    ? { text: "User changed this text" }
                    : { attachments: [{ id: "new-resource" }] }),
        } as AppController;
      cancelStaleComposerSubmit();
      f.current.current = intended;
      ready = onComposerSubmitRequest("actual-new-draft:chat", () => sends++);
      await tick();
      assert.equal(sends, 0);
    } finally {
      ready?.();
      cancelComposerSubmitFor(f.app.controllerScope!);
      await env.clean();
    }
  });

test("a late new-chat confirmation and old account cleanup cannot write or cancel the next account's request", async () => {
  const env = await routineDom({
    routineCapabilities: async () => ({
      remote: false,
      email: false,
      slack: false,
      setupWithChat: true,
      sources: ["chat", "code"],
    }),
  });
  const a = controllerFixture(),
    b = controllerFixture();
  let sent = 0;
  b.app.controllerScope = {};
  b.app.currentController!.current = b.app;
  let ready: (() => void) | undefined;
  try {
    await createScheduledChat(a.app, scheduledChatPrompt);
    a.current.current = undefined;
    a.commit();
    assert.deepEqual(a.calls, [["new", "chat", false]]);
    await createScheduledChat(b.app, scheduledChatPrompt);
    b.commit("owned-by-B");
    cancelComposerSubmitFor(a.app.controllerScope!);
    ready = onComposerSubmitRequest("owned-by-B:chat", () => sent++);
    await tick();
    assert.equal(sent, 1);
  } finally {
    ready?.();
    cancelComposerSubmitFor(b.app.controllerScope!);
    await env.clean();
  }
});

test("the real New task menu has Source Chat/Settings icons; Manual opens the real blank routine request and AI uses the Chat route", async () => {
  const env = await routineDom({
    routineCapabilities: async () => ({
      remote: false,
      email: false,
      slack: false,
      setupWithChat: true,
      sources: ["chat", "code"],
    }),
  });
  const f = controllerFixture();
  const requests: unknown[] = [];
  const stop = onScheduleRequest((request) => requests.push(request));
  const globals = { innerWidth: 1440, innerHeight: 900 };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const anchor = { current: env.document.createElement("button") };
  const app = {
    ...f.app,
    sidebarView: { phone: false, open: true },
    setPage(page: string) {
      requests.push(["page", page]);
    },
  } as AppController;
  try {
    for (const host of [webHost, desktopHost]) {
      await env.render(
        h(
          HostContext.Provider,
          { value: host },
          h(
            AppContext.Provider,
            { value: app },
            h(NavCreatePopup, {
              kind: "scheduled",
              position: { left: 100, top: 100 },
              anchor,
              onClose() {},
            }),
          ),
        ),
      );
      const buttons = [...env.document.querySelectorAll('[role="menuitem"]')];
      assert.deepEqual(
        buttons.map(
          (button) => button.querySelector(":scope > span")?.textContent,
        ),
        ["Create with Claudex", "Set up manually"],
      );
      assert.deepEqual(
        buttons.map((button) =>
          button
            .querySelector("[data-icon]")
            ?.getAttribute("data-icon"),
        ),
        ["Chat", "Settings"],
      );
      await env.event(buttons[1], "click");
      assert.deepEqual(requests.splice(0), [
        { description: "", blank: true },
        ["page", "scheduled"],
      ]);
      await env.event(buttons[0], "click");
      assert.deepEqual(f.calls.splice(0), [["new", "chat", false]]);
      assert.deepEqual(requests, []);
    }
  } finally {
    stop();
    cancelComposerSubmitFor(f.app.controllerScope!);
    await env.clean();
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("the sidebar New task menu drops Create with Claudex once the scheduler cannot start the chat setup", async () => {
  const env = await routineDom({
    routineCapabilities: async () => ({
      remote: false,
      email: false,
      slack: false,
      setupWithChat: false,
      sources: ["chat", "code"],
    }),
  });
  const f = controllerFixture();
  const globals = { innerWidth: 1440, innerHeight: 900 };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const anchor = { current: env.document.createElement("button") };
  try {
    await env.render(
      h(
        HostContext.Provider,
        { value: desktopHost },
        h(
          AppContext.Provider,
          { value: f.app },
          h(NavCreatePopup, {
            kind: "scheduled",
            position: { left: 100, top: 100 },
            anchor,
            onClose() {},
          }),
        ),
      ),
    );
    await tick();
    await tick();
    const labels = [...env.document.querySelectorAll('[role="menuitem"]')].map(
      (button) => button.querySelector(":scope > span")?.textContent,
    );
    assert.equal(labels.join("|"), "Set up manually");
  } finally {
    await env.clean();
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
