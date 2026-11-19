/** Real helper with inert windows; no Electron instance, OS keys or navigation. */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  observeOfficialAppMenu,
  officialMenuAreas,
  officialSessionMenuState,
  officialMenuHistory,
  openOfficialWindowSettings,
  registerOfficialAppMenu,
  runOfficialMenuNavigation,
} from "../electron/official-ui/native/app-menu";
function fixture() {
  let active = true,
    destroyed = false;
  const loads: string[] = [],
    logs: string[] = [],
    history: string[] = [];
  const wc = Object.assign(new EventEmitter(), {
    mainFrame: { url: "http://127.0.0.1:12345/chat/inert?view=1" },
    isDestroyed: () => false,
    navigationHistory: {
      canGoBack: () => true,
      canGoForward: () => false,
      goBack: () => history.push("back"),
      goForward: () => history.push("forward"),
    },
    send: (event: string, args: unknown) => history.push(JSON.stringify([event, args])),
  });
  const win: any = {
    id: 1,
    webContents: wc,
    isDestroyed: () => destroyed,
    openSettings: () => { loads.push("/settings/general"); },
    loadURL: () => { throw Error("must not reload document"); },
  };
  const off = observeOfficialAppMenu(
    win,
    {
      origin: "http://127.0.0.1:12345",
      current: () => active,
      log: (s) => logs.push(s),
      openSettings: () => win.openSettings(),
      selectArea: (id) => history.push(id),
      openCommandPalette: (search) => history.push(search ? "search" : "palette"),
      sessionMenu: (...event) => history.push(event.join(":")),
      splitMenu: (value) => history.push(value),
    },
    "linux",
  );
  const key = (extra: any = {}) => {
    let prevented = 0;
    wc.emit(
      "before-input-event",
      {
        preventDefault() {
          prevented++;
        },
      },
      {
        type: "keyDown",
        key: ",",
        control: true,
        meta: false,
        alt: false,
        shift: false,
        ...extra,
      },
    );
    return prevented;
  };
  return {
    win,
    wc,
    loads,
    logs,
    history,
    off,
    key,
    retire: () => (active = false),
    destroy: () => (destroyed = true),
  };
}

test("the native menu uses only the current official window's history and original New binding", () => {
  const active = fixture();
  const other = fixture();
  try {
    assert.deepEqual(officialMenuHistory(active.win), { canGoBack: true, canGoForward: false });
    assert.equal(runOfficialMenuNavigation(active.win, "back"), true);
    assert.equal(runOfficialMenuNavigation(active.win, "forward"), true);
    assert.equal(runOfficialMenuNavigation(active.win, "new-chat"), true);
    assert.deepEqual(active.history, ["back", "forward", '["cmdK",{"keyPress":false}]']);
    assert.deepEqual(other.history, []);
    active.retire();
    assert.equal(officialMenuHistory(active.win), undefined);
    assert.equal(runOfficialMenuNavigation(active.win, "back"), true);
    assert.equal(active.history.length, 3);
    assert.equal(runOfficialMenuNavigation(null, "new-chat"), false);
  } finally {
    active.off();
    other.off();
  }
});

test("native Go areas and the palette use only the focused original renderer's report", () => {
  const first = fixture();
  const second = fixture();
  const handlers = new Map<string, (value: unknown) => void>();
  const host = {
    caller: first.win,
    on: (name: string, handler: (value: unknown) => void) => handlers.set(name, handler),
  };
  try {
    registerOfficialAppMenu(host as never, () => null);
    const report = handlers.get("WindowControl.reportGoMenuAreas")!;
    const areas = [
      { id: "cowork", label: "Claudex", selected: false, items: "chats" },
      { id: "code", label: "Code", selected: true, items: "sessions" },
    ];
    report(areas);
    assert.deepEqual(officialMenuAreas(first.win), { mode: "code", areas: [{ ...areas[0], id: "chat" }, areas[1]], canCycleSession: true });
    assert.deepEqual(officialMenuAreas(second.win), { mode: "chat", areas: [], canCycleSession: false });
    runOfficialMenuNavigation(first.win, "area-chat");
    runOfficialMenuNavigation(first.win, "search-palette");
    runOfficialMenuNavigation(first.win, "previous-session");
    runOfficialMenuNavigation(second.win, "next-session");
    runOfficialMenuNavigation(first.win, "new-code-window");
    runOfficialMenuNavigation(second.win, "new-code-window");
    assert.deepEqual(first.history, ["cowork", "search", "cycleSession:prev", "newWindow"]);
    assert.deepEqual(second.history, []);
    assert.throws(() => report([areas[0], areas[0]]));
    first.wc.emit("did-start-navigation", {}, "http://127.0.0.1:12345/new", false, true);
    assert.deepEqual(officialMenuAreas(first.win), { mode: "chat", areas: [], canCycleSession: false });
    first.retire();
    runOfficialMenuNavigation(first.win, "new-code-window");
    assert.equal(first.history.length, 4);
    assert.throws(() => report(areas));
  } finally {
    first.off();
    second.off();
  }
});

test("Code pane controls and session close follow the official renderer's availability", () => {
  const f = fixture();
  const handlers = new Map<string, (value: unknown) => void>();
  const host = {
    caller: f.win,
    on: (name: string, handler: (value: unknown) => void) => handlers.set(name, handler),
  };
  try {
    registerOfficialAppMenu(host as never, () => null);
    const report = (name: string, value: unknown) => handlers.get(name)!(value);
    const off = { enabled: false, open: false };
    const on = { enabled: true, open: false };
    report("WindowControl.reportGoMenuAreas", [{ id: "code", label: "Code", selected: true, items: "sessions" }]);
    report("WindowControl.reportCloseMenuTarget", "chat");
    report("LocalSessions.setSessionPaneMenuState", {
      terminal: on, diff: on, preview: off, sideChat: { enabled: true, open: true }, closePane: on, newSideChat: on,
    });
    report("WindowControl.reportReopenClosedSessionMenuState", { available: true, enabled: false });
    assert.equal(officialSessionMenuState(f.win)?.closeTarget, "Session");
    assert.equal(officialSessionMenuState(f.win)?.canShowReopenClosed, true);
    assert.equal(officialSessionMenuState(f.win)?.canReopenClosed, false);
    runOfficialMenuNavigation(f.win, "toggle-terminal");
    runOfficialMenuNavigation(f.win, "toggle-browser");
    runOfficialMenuNavigation(f.win, "new-side-chat");
    runOfficialMenuNavigation(f.win, "close-context");
    runOfficialMenuNavigation(f.win, "reopen-closed-session");
    report("WindowControl.reportReopenClosedSessionMenuState", { available: true, enabled: true });
    runOfficialMenuNavigation(f.win, "reopen-closed-session");
    assert.deepEqual(f.history, ["toggleSessionPane:terminal", "newSideChat", "closeWindow", "reopenClosedSession"]);
    f.retire();
    assert.equal(officialSessionMenuState(f.win)?.closeTarget, undefined);
    runOfficialMenuNavigation(f.win, "toggle-terminal");
    assert.equal(f.history.length, 4);
  } finally {
    f.off();
  }
});
test("existing Ctrl comma reaches original settings route, without intercepting official Ctrl Shift comma or other keys", () => {
  const f = fixture();
  assert.equal(f.key(), 1);
  assert.deepEqual(f.loads, [
    "/settings/general",
  ]);
  for (const extra of [
    { shift: true },
    { alt: true },
    { meta: true },
    { control: false },
    { key: "r" },
    { type: "keyUp" },
    { isAutoRepeat: true },
  ])
    assert.equal(f.key(extra), 0);
  assert.equal(f.loads.length, 1);
  f.off();
  assert.equal(f.key(), 0);
  assert.equal(openOfficialWindowSettings(f.win), true);
});
test("retired, foreign-origin and destroyed windows cannot navigate, classic remains unclaimed", () => {
  assert.equal(openOfficialWindowSettings({} as any), false);
  for (const change of [
    (f: any) => f.retire(),
    (f: any) => (f.wc.mainFrame.url = "https://fixture.invalid/"),
    (f: any) => f.destroy(),
  ]) {
    const f = fixture();
    change(f);
    assert.equal(f.key(), 0);
    assert.equal(openOfficialWindowSettings(f.win), true);
    assert.equal(f.loads.length, 0);
    f.off();
  }
});
test("original hamburger operation opens only existing application menu for its verified caller", () => {
  const f = fixture(),
    handlers = new Map<string, Function>(),
    popups: any[] = [];
  const host: any = {
    caller: f.win,
    on: (op: string, fn: Function) => handlers.set(op, fn),
  };
  registerOfficialAppMenu(host, () => ({
    popup: (options) => popups.push(options),
  }));
  const popup = handlers.get("BrowserNavigation.requestMainMenuPopup")!;
  popup();
  assert.deepEqual(popups, [{ window: f.win }]);
  assert.throws(() => popup("renderer-window-id"));
  f.retire();
  assert.throws(() => popup());
  assert.equal(popups.length, 1);
  f.off();
});
test("navigation failure uses fixed diagnostic, no raw URL/service error", async () => {
  const f = fixture();
  f.win.openSettings = () => {
    throw Error("SECRET_QUERY");
  };
  assert.equal(openOfficialWindowSettings(f.win), true);
  await Promise.resolve();
  assert.equal(f.logs.length, 1);
  assert.doesNotMatch(f.logs[0], /SECRET_QUERY/);
  f.off();
});

test("re-observation replaces only its own listener and Mac uses exact Command comma", () => {
  const f = fixture();
  const off = observeOfficialAppMenu(
    f.win,
    { origin: "http://127.0.0.1:12345", current: () => true, log: () => {}, openSettings: () => f.win.openSettings() },
    "darwin",
  );
  assert.equal(f.wc.listenerCount("before-input-event"), 1);
  f.off();
  assert.equal(f.wc.listenerCount("before-input-event"), 1);
  assert.equal(f.key(), 0);
  assert.equal(f.key({ control: false, meta: true }), 1);
  assert.equal(f.key({ control: true, meta: true }), 0);
  assert.equal(f.key({ control: false, meta: true, shift: true }), 0);
  assert.equal(f.loads.length, 1);
  off();
  assert.equal(f.wc.listenerCount("before-input-event"), 0);
});

test("old disposer cannot remove re-observation even when the exact binding object is reused", () => {
  const f = fixture();
  const binding = {
    origin: "http://127.0.0.1:12345",
    current: () => true,
    log: () => {},
    openSettings: () => f.win.openSettings(),
  };
  const old = observeOfficialAppMenu(f.win, binding, "linux");
  const fresh = observeOfficialAppMenu(f.win, binding, "linux");
  old();
  assert.equal(f.key(), 1);
  assert.equal(f.loads.length, 1);
  fresh();
  f.off();
});

 test("Settings on Customize emits the original target without reloading or changing its URL", () => {
 const f = fixture();
 f.wc.mainFrame.url = "http://127.0.0.1:12345/customize/skills?filter=mine#settings";
 assert.equal(openOfficialWindowSettings(f.win), true);
 assert.deepEqual(f.loads, ["/settings/general"]);
 f.off();
 });

test("pinned original Navigation consumer opens mounted settings modal, otherwise uses original router; other destinations unchanged", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const ts = await import("typescript");
  const assets = path.resolve("build/official-ui/ui/assets/v1");
  const source = fs.readFileSync(path.join(assets, "shared-23-xVessQLu.js"), "utf8");
  const ast = ts.createSourceFile("consumer.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const callbacks: string[] = [];
  const visit = (node: any) => {
    if (ts.isArrowFunction(node) && node.parameters.length === 1 &&
        node.getText(ast).includes('if (t.startsWith("/settings"))') &&
        node.getText(ast).includes('lu(t.section, t.subpath)')) callbacks.push(node.getText(ast));
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(callbacks.length, 1, "exact pinned original navigation callback");
  const modalSource = fs.readFileSync(path.join(assets, "shared-l-p-m-w-4-BkeeGGW7.js"), "utf8");
  const modal = /function eD\(e, t, n\) \{\s*return hQY\.getState\(\)\.open\(e, t, n\);\s*\}/.exec(modalSource);
  assert.ok(modal, "original modal opener, not a replacement UI");
  let mounted = true;
  const opens: unknown[][] = [], pushes: string[] = [], before: string[] = [];
  const state = {getState: () => ({ mounted, customizeMergedPageOn: false,
    visibleSections: new Set(["general"]), open: (...args: unknown[]) => opens.push(args) })};
  const lu = new Function("hQY", `${modal[0]};return eD;`)(state);
  const callback = new Function("e", "a", "rZ", "Me", "O9", "$P", "$J", "lu", "fc", "Hj", "wQ", "z9", "Qt", "K$", "wX", `return (${callbacks[0]});`)(
    {push: (s: string) => pushes.push(s)}, false, () => {throw Error("logged out");}, () => false,
    (s: string) => s === "/settings/general" ? {section: "general", subpath: undefined} : null,
    state, ({target}: any) => target, lu, () => null,
    {getState: () => ({extraPanesByMode: {code: []}})}, () => -1, () => null, () => false, () => {},
    (s: string) => before.push(s),
  );
  callback("/settings/general");
  assert.deepEqual(opens, [["general", undefined, undefined]]);
  assert.deepEqual(pushes, []);
  mounted = false;
  callback("/settings/general");
  callback("/new");
  assert.deepEqual(pushes, ["/settings/general", "/new"]);
  assert.deepEqual(before, pushes);
});


test("the official split view menu uses the renderer report and stops routing after retirement", () => {
  const a = fixture();
  const b = fixture();
  const handlers = new Map<string, (value: unknown) => void>();
  const host = { caller: a.win, on: (name: string, callback: (value: unknown) => void) => handlers.set(name, callback) };
  registerOfficialAppMenu(host as never, () => null);
  const state = {
    newRight: true, newBelow: false, split: false,
    moveLeft: false, moveRight: false, moveUp: false, moveDown: false,
  };
  try {
    handlers.get("WindowControl.reportSplitViewMenuState")!(state);
    assert.deepEqual(officialSessionMenuState(a.win)?.splitView, state);
    assert.equal(officialSessionMenuState(b.win)?.splitView.newRight, false);
    assert.equal(runOfficialMenuNavigation(a.win, "split-new-right"), true);
    assert.equal(runOfficialMenuNavigation(a.win, "split-new-below"), true);
    assert.equal(runOfficialMenuNavigation(a.win, "split-close"), true);
    assert.deepEqual(a.history, ["new_right"]);
    a.retire();
    assert.equal(runOfficialMenuNavigation(a.win, "split-new-right"), true);
    assert.deepEqual(a.history, ["new_right"]);
  } finally {
    a.off();
    b.off();
  }
});
