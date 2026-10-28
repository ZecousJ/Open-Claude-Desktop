import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  desktopHost,
  hostFor,
  resolveHost,
  shellOnlyCapabilities,
  surface,
  webHost,
  type HostCapability,
  type CloudSessionInfo,
} from "../../shared/host";
import type { Conversation, Snapshot, Turn } from "../../shared/types";
import { paneKeyCommand } from "../../shared/pane-keys";
import {
  commandForKey,
  keyTable,
  shortcutKeys,
  type KeyPress,
} from "../../src/host/keys";
import {
  applyCloudSession,
  ConversationTurns,
  mergeConversationTurn,
  resyncSnapshot,
} from "../../src/host/events";
import { hostClasses, sidebarWidth, windowChrome } from "../../src/host/layout";
import {
  HostContext,
  useHost,
  useHostCapability,
} from "../../src/host/HostContext";

const capabilityNames = Object.keys(
  desktopHost.capabilities,
) as HostCapability[];

test("a build without the surface constant is the desktop", () => {
  assert.equal(surface, "desktop");
  assert.equal(hostFor("desktop"), desktopHost);
  assert.equal(hostFor("web"), webHost);
});

test("desktop local capabilities are available while cloud and negotiated protocol features start off", () => {
  for (const name of capabilityNames)
    assert.equal(
      desktopHost.capabilities[name],
      name !== "cloudCowork" &&
        name !== "cloudCode" &&
        name !== "codeSessionPermissions",
      name,
    );
  assert.equal(desktopHost.kind, "desktop");
});

test("the web starts with nothing that needs this computer", () => {
  assert.equal(webHost.kind, "web");
  for (const name of capabilityNames)
    assert.equal(webHost.capabilities[name], false, name);
  assert.deepEqual(
    Object.keys(webHost.capabilities).sort(),
    [...capabilityNames].sort(),
  );
});

test("a snapshot without a host keeps the surface's default", () => {
  assert.equal(resolveHost("desktop"), desktopHost);
  assert.equal(resolveHost("desktop", undefined), desktopHost);
  assert.equal(resolveHost("web", null), webHost);
  assert.equal(resolveHost("web", { capabilities: {} }), webHost);
  // Reporting the defaults again changes nothing either.
  assert.equal(resolveHost("desktop", desktopHost), desktopHost);
});

test("a snapshot's capabilities go on top of the surface's defaults", () => {
  const host = resolveHost("web", {
    capabilities: { cloudCowork: true, localTerminal: true },
  });
  assert.equal(host.kind, "web");
  assert.equal(host.capabilities.cloudCowork, true);
  assert.equal(host.capabilities.localTerminal, true);
  assert.equal(host.capabilities.cloudCode, false);
  // The shared defaults are not changed.
  assert.equal(webHost.capabilities.cloudCowork, false);
  const desktop = resolveHost("desktop", { capabilities: { ssh: false } });
  assert.equal(desktop.capabilities.ssh, false);
  assert.equal(desktop.capabilities.localFolders, true);
});

test("the build surface wins over the kind a snapshot reports", () => {
  assert.equal(resolveHost("desktop", webHost).kind, "desktop");
  assert.equal(resolveHost("web", desktopHost).kind, "web");
});

test("the web never gets the Electron shell's capabilities", () => {
  const host = resolveHost("web", desktopHost);
  for (const name of shellOnlyCapabilities)
    assert.equal(host.capabilities[name], false, name);
  // Other capabilities may be turned on by the service.
  assert.equal(host.capabilities.localFolders, true);
});

test("capabilities that are not booleans are ignored", () => {
  const host = resolveHost("web", {
    capabilities: { cloudCode: "yes", ssh: 1 } as never,
  });
  assert.equal(host, webHost);
});

const press = (key: string, extra: Partial<KeyPress> = {}): KeyPress => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...extra,
});

test("the desktop keeps its shortcuts on the platform's own key", () => {
  const table = keyTable("desktop", "darwin");
  const expected: Array<[string, string]> = [
    ["k", "search"],
    ["n", "new-chat"],
    [",", "settings"],
    ["b", "toggle-sidebar"],
    ["/", "shortcuts"],
    ["[", "back"],
    ["]", "forward"],
  ];
  for (const [key, command] of expected) {
    assert.equal(commandForKey(press(key, { metaKey: true }), table), command);
    // On macOS Control is the text field's (Control-K deletes to the line
    // end); Control-B is Background tasks, which a text field keeps.
    assert.equal(
      commandForKey(press(key, { ctrlKey: true }), table),
      key === "b" ? "toggle-background" : undefined,
    );
    assert.equal(
      commandForKey(press(key.toUpperCase(), { metaKey: true }), table),
      command,
    );
    assert.equal(
      commandForKey(press(key, { metaKey: true, altKey: true }), table),
      undefined,
    );
    assert.equal(commandForKey(press(key), table), undefined);
  }
  // Windows and Linux use Control and leave Command alone.
  const windows = keyTable("desktop", "win32");
  for (const [key, command] of expected) {
    assert.equal(
      commandForKey(press(key, { ctrlKey: true }), windows),
      command,
    );
    assert.equal(
      commandForKey(press(key, { metaKey: true }), windows),
      undefined,
    );
  }
  // Shift makes another shortcut, or none.
  for (const key of ["n", ",", "/"])
    assert.equal(
      commandForKey(press(key, { metaKey: true, shiftKey: true }), table),
      undefined,
      key,
    );
  // ⇧⌘[ and ⇧⌘] are Go ▸ Previous and Next Session; Shift types { and }, so
  // they are read from the physical key.
  for (const [key, code, command] of [
    ["{", "BracketLeft", "previous-session"],
    ["}", "BracketRight", "next-session"],
  ] as const) {
    assert.equal(
      commandForKey(press(key, { metaKey: true, shiftKey: true, code }), table),
      command,
    );
    assert.equal(
      commandForKey(
        press(key, { ctrlKey: true, shiftKey: true, code }),
        windows,
      ),
      command,
    );
    assert.equal(
      commandForKey(press(key, { ctrlKey: true, shiftKey: true, code }), table),
      undefined,
    );
  }
  assert.equal(
    commandForKey(press("I", { metaKey: true, shiftKey: true }), table),
    "incognito",
  );
  assert.equal(
    commandForKey(press("i", { ctrlKey: true, shiftKey: true }), windows),
    "incognito",
  );
  assert.equal(commandForKey(press("i", { metaKey: true }), table), undefined);
  // ⇧⌘O is File > Open Folder… on the desktop, not a new chat.
  assert.equal(
    commandForKey(press("o", { metaKey: true, shiftKey: true }), table),
    "open-folder",
  );
  assert.equal(
    commandForKey(press("o", { metaKey: true }), table),
    "open-file",
  );
  // ⇧⌘K is Go ▸ Search… on macOS: the palette on its Search view.
  assert.equal(
    commandForKey(press("K", { metaKey: true, shiftKey: true }), table),
    "search-palette",
  );
  // Before the platform is known either key works, as it always did.
  const unknown = keyTable("desktop");
  assert.equal(commandForKey(press("k", { ctrlKey: true }), unknown), "search");
  assert.equal(commandForKey(press("k", { metaKey: true }), unknown), "search");
});

test("the Code pane keys are the original's", () => {
  const mac = keyTable("desktop", "darwin");
  const windows = keyTable("desktop", "win32");
  const meta = (key: string, shiftKey = false, code?: string) =>
    commandForKey(press(key, { metaKey: true, shiftKey, code }), mac);
  const ctrl = (key: string, shiftKey = false, code?: string) =>
    commandForKey(press(key, { ctrlKey: true, shiftKey, code }), windows);
  // Terminal: ⌘J on macOS, Ctrl+` on both.
  assert.equal(meta("j"), "toggle-terminal");
  assert.equal(
    commandForKey(press("`", { ctrlKey: true, code: "Backquote" }), mac),
    "toggle-terminal",
  );
  assert.equal(ctrl("`", false, "Backquote"), "toggle-terminal");
  assert.equal(ctrl("j"), undefined);
  // Changes ⇧⌘D, Browser ⇧⌘B, Close Pane ⌘\.
  assert.equal(meta("D", true), "toggle-changes");
  assert.equal(ctrl("d", true), "toggle-changes");
  assert.equal(meta("B", true), "toggle-browser");
  // ⇧⌘P is the app's second Browser key.
  assert.equal(meta("P", true), "toggle-browser");
  assert.equal(ctrl("p", true), "toggle-browser");
  // Side Chat: ⌘; (Ctrl+; elsewhere).
  assert.equal(meta(";"), "toggle-side-chat");
  assert.equal(ctrl(";"), "toggle-side-chat");
  assert.equal(meta("\\", false, "Backslash"), "close-pane");
  assert.equal(ctrl("|", false, "Backslash"), "close-pane");
  // The Browser's tabs.
  assert.equal(meta("t"), "new-browser-tab");
  assert.equal(meta("T", true), "reopen-closed-session");
  assert.equal(meta("l"), "browser-focus-address");
  assert.equal(meta("3"), "browser-tab-3");
  assert.equal(
    commandForKey(press("Tab", { ctrlKey: true }), mac),
    "browser-next-tab",
  );
  assert.equal(
    commandForKey(press("Tab", { ctrlKey: true, shiftKey: true }), windows),
    "browser-previous-tab",
  );
  assert.equal(commandForKey(press("Tab", { metaKey: true }), mac), undefined);
  // The web keeps the browser's keys: none of these.
  const web = keyTable("web", "darwin");
  for (const key of ["j", "t", "l", "3"])
    assert.equal(
      commandForKey(press(key, { metaKey: true }), web),
      undefined,
      key,
    );
});

test("the browser pages' key table is the window's", () => {
  assert.equal(
    paneKeyCommand(
      { key: "t", meta: true, control: false, shift: false },
      true,
    ),
    "new-browser-tab",
  );
  assert.equal(
    paneKeyCommand({ key: "t", control: true, shift: false }, false),
    "new-browser-tab",
  );
  assert.equal(
    paneKeyCommand({ key: "j", control: true, meta: false }, false),
    undefined,
  );
  assert.equal(
    paneKeyCommand({ key: "`", code: "Backquote", control: true }, true),
    "toggle-terminal",
  );
  // Option held: not a pane key. A plain letter: just typing.
  assert.equal(
    paneKeyCommand({ key: "t", meta: true, alt: true }, true),
    undefined,
  );
  assert.equal(paneKeyCommand({ key: "t" }, true), undefined);
});

test("the web leaves the browser its shortcuts and uses ⇧⌘O for a new chat", () => {
  const mac = keyTable("web", "darwin");
  const meta = (key: string, shiftKey = false) =>
    commandForKey(press(key, { metaKey: true, shiftKey }), mac);
  assert.equal(meta("k"), "search");
  // ⇧⌘K opens the palette on Search.
  assert.equal(meta("K", true), "search-palette");
  assert.equal(meta("b"), "toggle-sidebar");
  assert.equal(meta("/"), "shortcuts");
  assert.equal(meta("O", true), "new-chat");
  assert.equal(meta("i", true), "incognito");
  for (const key of ["n", ",", "[", "]", "t", "w", "l", "r"])
    assert.equal(meta(key), undefined, key);
  assert.equal(meta("n", true), undefined);
  // On macOS, Control is the text field's (Control-K deletes to the line end).
  assert.equal(commandForKey(press("k", { ctrlKey: true }), mac), undefined);
  const windows = keyTable("web", "win32");
  const ctrl = (key: string, shiftKey = false) =>
    commandForKey(press(key, { ctrlKey: true, shiftKey }), windows);
  assert.equal(ctrl("k"), "search");
  assert.equal(ctrl("o", true), "new-chat");
  // Ctrl+Shift+I opens the browser's developer tools.
  assert.equal(ctrl("i", true), undefined);
  assert.equal(
    commandForKey(press("k", { metaKey: true }), windows),
    undefined,
  );
  // A browser reporting its own platform name.
  assert.equal(keyTable("web", "MacIntel").mod, "meta");
});

test("web shortcuts wait while an input method composes", () => {
  const web = keyTable("web", "darwin");
  assert.equal(
    commandForKey(press("k", { metaKey: true, isComposing: true }), web),
    undefined,
  );
  // The desktop behaves as it always has.
  assert.equal(
    commandForKey(
      press("k", { metaKey: true, isComposing: true }),
      keyTable("desktop"),
    ),
    "search",
  );
});

test("shortcut keys for display come from the same table", () => {
  assert.deepEqual(shortcutKeys("new-chat", keyTable("desktop")), ["mod", "N"]);
  assert.deepEqual(shortcutKeys("new-chat", keyTable("web", "darwin")), [
    "mod",
    "shift",
    "O",
  ]);
  // ⇧⌘, as claude.ai (⌘, is the browser's own settings).
  assert.deepEqual(shortcutKeys("settings", keyTable("web", "darwin")), [
    "mod",
    "shift",
    ",",
  ]);
  assert.equal(shortcutKeys("incognito", keyTable("web", "linux")), undefined);
  assert.deepEqual(shortcutKeys("shortcuts", keyTable("web", "linux")), [
    "mod",
    "/",
  ]);
});

const turn = (id: string, extra: Partial<Turn> = {}): Turn => ({
  id,
  prompt: id,
  attachments: [],
  items: [],
  status: "completed",
  createdAt: 1,
  ...extra,
});

const conversation = (id: string, turns: Turn[]): Conversation =>
  ({
    id,
    title: id,
    mode: "chat",
    providerId: "p",
    model: "m",
    pinned: false,
    turns,
    createdAt: 1,
    updatedAt: 1,
  }) as unknown as Conversation;

test("a turn event replaces its turn or adds it after the last", () => {
  const before = conversation("c", [turn("t1"), turn("t2")]);
  const replaced = mergeConversationTurn(before, {
    type: "conversation-turn",
    conversationId: "c",
    turn: turn("t2", { status: "inProgress" }),
    conversation: { title: "Renamed" },
  });
  assert.deepEqual(
    replaced?.turns.map((t) => [t.id, t.status]),
    [
      ["t1", "completed"],
      ["t2", "inProgress"],
    ],
  );
  assert.equal(replaced?.title, "Renamed");
  assert.equal(before.turns[1].status, "completed");
  const added = mergeConversationTurn(before, {
    type: "conversation-turn",
    conversationId: "c",
    turn: turn("t3"),
  });
  assert.deepEqual(
    added?.turns.map((t) => t.id),
    ["t1", "t2", "t3"],
  );
  // The fields cannot move the conversation or drop its turns.
  const guarded = mergeConversationTurn(before, {
    type: "conversation-turn",
    conversationId: "c",
    turn: turn("t1"),
    conversation: { id: "other", turns: [] } as never,
  });
  assert.equal(guarded?.id, "c");
  assert.equal(guarded?.turns.length, 2);
});

test("a turn event for a conversation the window lacks waits for a full event", () => {
  assert.equal(
    mergeConversationTurn(undefined, {
      type: "conversation-turn",
      conversationId: "c",
      turn: turn("t1"),
    }),
    undefined,
  );
  assert.equal(
    mergeConversationTurn(conversation("d", []), {
      type: "conversation-turn",
      conversationId: "c",
      turn: turn("t1"),
    }),
    undefined,
  );
});

test("turn events faster than renders build on each other", () => {
  const turns = new ConversationTurns();
  const rendered = conversation("c", [turn("t1")]);
  const event = (t: Turn) =>
    ({ type: "conversation-turn", conversationId: "c", turn: t }) as const;
  const first = turns.apply(rendered, event(turn("t2")));
  // No render yet: the window still shows `rendered`.
  const second = turns.apply(rendered, event(turn("t3")));
  assert.deepEqual(
    second?.turns.map((t) => t.id),
    ["t1", "t2", "t3"],
  );
  // The window rendered its own change since (a rename): build on that.
  const renamed = { ...first!, title: "Renamed" };
  const third = turns.apply(renamed, event(turn("t2", { status: "failed" })));
  assert.equal(third?.title, "Renamed");
  assert.deepEqual(
    third?.turns.map((t) => [t.id, t.status]),
    [
      ["t1", "completed"],
      ["t2", "failed"],
    ],
  );
  // After a full conversation, merges start from what the window shows.
  turns.forget("c");
  const fresh = turns.apply(rendered, event(turn("t9")));
  assert.deepEqual(
    fresh?.turns.map((t) => t.id),
    ["t1", "t9"],
  );
  assert.equal(turns.apply(undefined, event(turn("t1"))), undefined);
});

test("cloud sessions are kept per conversation and leave when archived", () => {
  const shared: CloudSessionInfo = { state: "queued", queuePosition: 2 };
  const code: CloudSessionInfo = { conversationId: "c", state: "running" };
  let sessions = applyCloudSession(undefined, shared);
  sessions = applyCloudSession(sessions, code);
  sessions = applyCloudSession(sessions, { state: "ready" });
  assert.deepEqual(sessions, [code, { state: "ready" }]);
  sessions = applyCloudSession(sessions, {
    conversationId: "c",
    state: "archived",
  });
  assert.deepEqual(sessions, [{ state: "ready" }]);
});

test("a resync takes the fresh snapshot and keeps the incognito chat on screen", () => {
  const base = {
    artifactLibrary: { version: 1, copies: [], pinned: [] },
    dismissedBackgroundTasks: [],
    artifactShares: [],
    settings: {},
    projects: [],
    engine: { state: "ready" },
    approvals: [],
    platform: "darwin",
    replyFeedback: {},
  } as unknown as Snapshot;
  const open = { ...conversation("secret", []), incognito: true };
  const other = { ...conversation("old", []), incognito: true };
  const current = { ...base, conversations: [conversation("a", []), open] };
  const fresh = {
    ...base,
    engine: { state: "starting" as const },
    conversations: [conversation("b", []), open, other],
  };
  const next = resyncSnapshot(current, fresh);
  assert.deepEqual(
    next.conversations.map((c) => c.id),
    ["b", "secret"],
  );
  assert.equal(next.engine.state, "starting");
  assert.deepEqual(
    resyncSnapshot(undefined, fresh).conversations.map((c) => c.id),
    ["b"],
  );
});

test("a resync keeps conversations that changed while the snapshot was read", () => {
  const base = {
    artifactLibrary: { version: 1, copies: [], pinned: [] },
    dismissedBackgroundTasks: [],
    artifactShares: [],
    settings: {},
    projects: [],
    engine: { state: "ready" },
    approvals: [],
    platform: "darwin",
    replyFeedback: {},
  } as unknown as Snapshot;
  const stale = conversation("a", []);
  const finished = { ...conversation("a", []), title: "Finished" };
  const created = conversation("new", []);
  const fresh = {
    ...base,
    conversations: [stale, conversation("b", [])],
  };
  const next = resyncSnapshot({ ...base, conversations: [stale] }, fresh, [
    finished,
    created,
  ]);
  assert.deepEqual(
    next.conversations.map((c) => c.id),
    ["new", "a", "b"],
  );
  assert.equal(next.conversations[1].title, "Finished");
});

test("the window root and chrome follow the host", () => {
  assert.equal(hostClasses(desktopHost, "darwin"), "darwin host-desktop");
  assert.equal(hostClasses(desktopHost, "win32"), "win32 host-desktop");
  // No platform class on the web: no traffic lights or window buttons.
  assert.equal(hostClasses(webHost, "darwin"), "web host-web");
  assert.deepEqual(windowChrome(desktopHost, "darwin"), {
    dragSurface: true,
    controls: false,
  });
  assert.deepEqual(windowChrome(desktopHost, "win32"), {
    dragSurface: true,
    controls: true,
  });
  assert.deepEqual(windowChrome(webHost, "win32"), {
    dragSurface: false,
    controls: false,
  });
  assert.equal(sidebarWidth(desktopHost, 242), 242);
  assert.equal(sidebarWidth(desktopHost, 242, 300), 300);
  // The web's sidebar resizes too (its collapse line follows the width).
  assert.equal(sidebarWidth(webHost, 242), 242);
  assert.equal(sidebarWidth(webHost, 242, 300), 300);
});

test("useHost gives the build surface's host outside App, and App's inside", () => {
  const Probe = () => {
    const host = useHost();
    const ssh = useHostCapability("ssh");
    return createElement("span", null, `${host.kind}:${ssh}`);
  };
  assert.equal(
    renderToStaticMarkup(createElement(Probe)),
    "<span>desktop:true</span>",
  );
  assert.equal(
    renderToStaticMarkup(
      createElement(
        HostContext.Provider,
        { value: webHost },
        createElement(Probe),
      ),
    ),
    "<span>web:false</span>",
  );
});
