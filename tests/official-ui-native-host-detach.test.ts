/** Actual NativeHost registration/verification with inert Electron IPC and temp contract. */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import type { ComputerUseActivity } from "../shared/computer-use";
import type { AppEvent } from "../shared/types";
import type { AdapterContext } from "../electron/official-ui/api/context";
import { registerComputerUseLivePreview } from "../electron/official-ui/native/computer-use-live-preview";
import { registerQuickEntry } from "../electron/official-ui/native/quick-entry";
const invokes = new Map<string, Function>(),
  sync = new Map<string, Function>();
const owners = new Map<object, any>();
(globalThis as any).__detachElectron = {
  BrowserWindow: { fromWebContents: (wc: object) => owners.get(wc) },
  ipcMain: {
    handle: (key: string, fn: Function) => invokes.set(key, fn),
    removeHandler: (key: string) => invokes.delete(key),
    on: (key: string, fn: Function) => sync.set(key, fn),
    removeListener: (key: string) => sync.delete(key),
  },
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron")
      return {
        shortCircuit: true,
        url: "data:text/javascript,const e=globalThis.__detachElectron;export const BrowserWindow=e.BrowserWindow;export const ipcMain=e.ipcMain;",
      };
    return next(specifier, context);
  },
});
const { NativeHost } = await import("../electron/official-ui/native/host");
const channel = "prefix_$_claude.web_$_Thing_$_run";
const menuChannel =
  "prefix_$_claude.web_$_BrowserNavigation_$_requestMainMenuPopup";
const osReadyChannel = "prefix_$_claude.web_$_OsOpenHandlers_$_ready";
const preview = (method: string) =>
  `prefix_$_claude.web_$_ComputerUseLivePreview_$_${method}`;
class Window extends EventEmitter {
  id = Math.random();
  webContents = Object.assign(new EventEmitter(), {
    mainFrame: { url: "http://fixture.invalid/new" },
    send(..._args: unknown[]) {},
    isDestroyed: () => false,
  });
  constructor() {
    super();
    owners.set(this.webContents, this);
  }
  isDestroyed() {
    return false;
  }
  isFocused() {
    return false;
  }
}
function fixture(t: TestContext, extraContext?: Partial<AdapterContext>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-detach-"));
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(
    path.join(root, "data/native-ipc-contract.json"),
    JSON.stringify({
      invokes: [
        { channel },
        { channel: menuChannel },
        { channel: osReadyChannel },
        { channel: "prefix_$_claude.web_$_WindowControl_$_reportSidebarMenuState" },
        { channel: "prefix_$_claude.web_$_WindowState_$_get" },
        { channel: preview("setSubscribed") },
        { channel: preview("setFps") },
        { channel: preview("computerUsePreview_$store$_getState") },
      ],
      sync: [{ channel: preview("computerUsePreview_$store$_getStateSync") }],
    }),
  );
  const logs: unknown[][] = [];
  const context = {
    root,
    onEvent: () => () => {},
    account: () => ({ id: "a" }),
    sessionIdentity: () => "activation",
    log(...args: unknown[]) {
      logs.push(args);
    },
    ...extraContext,
  } as AdapterContext;
  const host = new NativeHost("http://fixture.invalid", context);
  t.after(() => {
    host.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  host.start();
  const window = new Window(),
    other = new Window();
  host.attach(window as any);
  host.attach(other as any);
  const event = (win = window) => ({
    sender: win.webContents,
    senderFrame: win.webContents.mainFrame,
  });
  return {
    host,
    context,
    logs,
    window,
    other,
    event,
    invoke: (win = window) => invokes.get(channel)!(event(win)),
  };
}

test("official app preview streams to the subscribed session and retires in-flight frames", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const backend = new EventEmitter();
  let activity: ComputerUseActivity | null = {
    conversationId: "text-edit",
    mode: "fullControl",
    app: { id: "com.apple.TextEdit", name: "TextEdit", platform: "darwin" },
    startedAt: 0,
  };
  const captures: { id: unknown; finish(frame: string | null): void }[] = [];
  const f = fixture(t, {
    computerUseActivity: () => activity,
    localCall: (name, id) => {
      assert.equal(name, "computerUsePreview");
      return new Promise((finish) => captures.push({ id, finish }));
    },
    onEvent: (fn) => {
      backend.on("event", fn);
      return () => backend.off("event", fn);
    },
    onAccountDeactivating: (fn) => {
      backend.on("retire", fn);
      return () => backend.off("retire", fn);
    },
  });
  t.after(registerComputerUseLivePreview(f.host, f.context));
  const call = (window: Window, method: string, ...args: unknown[]) =>
    invokes.get(preview(method))!(f.event(window), ...args);
  const subscribe = (window: Window, id: string, on: boolean, capture = true) =>
    call(window, "setSubscribed", id, on, capture);
  const state = (window: Window) => {
    const event = { ...f.event(window), returnValue: undefined };
    sync.get(preview("computerUsePreview_$store$_getStateSync"))!(event);
    return event.returnValue;
  };
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const ownUpdates = t.mock.method(f.window.webContents, "send");
  const otherUpdates = t.mock.method(f.other.webContents, "send");
  const frames = (mock: typeof ownUpdates) => mock.mock.calls.flatMap(({ arguments: [channel, frame] }) =>
    channel === preview("computerUsePreview_$store$_update") ? [frame] : [],
  );

  await subscribe(f.other, "local_elsewhere", true);
  await subscribe(f.other, "local_text-edit", true, false);
  await subscribe(f.other, "text-edit", true);
  assert.equal(captures.length, 0);
  assert.deepEqual(state(f.window), { result: { active: false } });

  await call(f.window, "setFps", 0.5);
  await subscribe(f.window, "local_text-edit", true);
  await subscribe(f.window, "local_text-edit", true);
  assert.deepEqual(captures.map(({ id }) => id), ["text-edit"]);
  const dataUrl = "data:image/png;base64,example";
  captures[0].finish(dataUrl);
  await settle();
  const live = {
    active: true, sessionId: "local_text-edit", mode: "app",
    targetLabel: "TextEdit", frame: dataUrl, capturedAt: Date.now(),
  };
  assert.deepEqual(frames(ownUpdates), [live]);
  assert.deepEqual(frames(otherUpdates), []);
  assert.deepEqual(state(f.window), { result: live });
  assert.deepEqual(await call(f.other, "computerUsePreview_$store$_getState"), { active: false });

  await subscribe(f.window, "local_text-edit", false);
  assert.deepEqual(state(f.window), { result: live });
  t.mock.timers.tick(1999);
  assert.equal(captures.length, 1);
  t.mock.timers.tick(1);
  assert.equal(captures.length, 2);
  await call(f.window, "setFps", 0);
  captures[1].finish(dataUrl);
  await settle();
  assert.deepEqual(frames(ownUpdates), [live, { active: false }]);
  assert.deepEqual(state(f.window), { result: { active: false } });

  await call(f.window, "setFps", 1);
  assert.equal(captures.length, 3);
  f.window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  captures[2].finish(dataUrl);
  await settle();
  assert.equal(frames(ownUpdates).length, 2);
  t.mock.timers.tick(1000);
  assert.equal(captures.length, 3);

  await subscribe(f.window, "local_text-edit", true);
  captures[3].finish(dataUrl);
  await settle();
  activity = null;
  backend.emit("event", { type: "computer-use", activity } satisfies AppEvent);
  assert.deepEqual(state(f.window), { result: { active: false } });

  activity = {
    conversationId: "text-edit", mode: "background",
    app: { id: "com.apple.TextEdit", name: "TextEdit", platform: "darwin" }, startedAt: Date.now(),
  };
  backend.emit("event", { type: "computer-use", activity } satisfies AppEvent);
  assert.equal(captures.length, 5);
  backend.emit("retire");
  captures[4].finish(dataUrl);
  await settle();
  assert.deepEqual(state(f.window), { result: { active: false } });
  assert.equal(frames(ownUpdates).filter((frame) =>
    typeof frame === "object" && frame && "active" in frame && frame.active,
  ).length, 2);
});
test("detach revokes verified IPC/caller/grants/events for just the candidate and is closed-idempotent", async (t) => {
  const f = fixture(t);
  let calls = 0;
  f.host.on("Thing.run", () => ++calls);
  assert.equal(await f.invoke(), 1);
  assert.equal(f.host.caller, f.window);
  const revoked = t.mock.method(
    f.host.attachmentSelections,
    "revokeWindow",
    () => {},
  );
  f.host.detach(f.window as any);
  assert.equal(f.host.caller, undefined);
  assert.throws(() => f.invoke(), /Untrusted IPC sender/);
  assert.equal(await f.invoke(f.other), 2);
  assert.equal(revoked.mock.callCount(), 1);
  assert.equal(f.window.listenerCount("focus"), 0);
  assert.equal(f.window.webContents.listenerCount("did-start-navigation"), 0);
  f.window.emit("closed");
  f.host.detach(f.window as any);
  assert.throws(() => f.invoke(), /Untrusted IPC sender/);
  assert.equal(f.host.window, f.other);
  assert.throws(
    () =>
      invokes.get(channel)!({
        ...f.event(f.other),
        senderFrame: { url: "http://fixture.invalid/new" },
      }),
    /Untrusted IPC sender/,
  );
});
test("listener cleanup failure cannot restore candidate IPC or affect another attached window", async (t) => {
  const f = fixture(t);
  f.host.on("Thing.run", () => "ok");
  const remove = t.mock.method(f.window, "removeListener", () => {
    throw Error("private cleanup failure");
  });
  assert.throws(
    () => f.host.detach(f.window as any),
    /^Error: Official window native cleanup was not confirmed\.$/,
  );
  assert.throws(() => f.invoke(), /Untrusted IPC sender/);
  assert.equal(await f.invoke(f.other), "ok");
  remove.mock.restore();
});
test("detach suppresses late response without pretending already-dispatched work was cancelled", async (t) => {
  const f = fixture(t);
  let resolve!: (value: string) => void;
  f.host.on("Thing.run", () => new Promise<string>((r) => (resolve = r)));
  const pending = f.invoke();
  f.host.detach(f.window as any);
  resolve("already dispatched");
  await assert.rejects(pending, /account window has retired/);
  assert.throws(() => f.invoke(), /Untrusted IPC sender/);
});

test("partial attachment setup failure removes only candidate verification authority", async (t) => {
  const f = fixture(t);
  f.host.on("Thing.run", () => "ok");
  const candidate = new Window();
  const on = t.mock.method(candidate.webContents, "on", () => {
    throw Error("inert listener failure");
  });
  assert.throws(
    () => f.host.attach(candidate as any),
    /inert listener failure/,
  );
  assert.throws(() => f.invoke(candidate), /Untrusted IPC sender/);
  assert.equal(await f.invoke(f.other), "ok");
  on.mock.restore();
});

test("natural closed cleanup failure logs fixed diagnostic without uncaught event or affecting other IPC", async (t) => {
  const f = fixture(t);
  f.host.on("Thing.run", () => "ok");
  const remove = t.mock.method(f.window.webContents, "removeListener", () => {
    throw Error("private navigation cleanup");
  });
  assert.doesNotThrow(() => f.window.emit("closed"));
  assert.deepEqual(f.logs, [
    ["[official-ui] native window cleanup was not confirmed."],
  ]);
  assert.throws(() => f.invoke(), /Untrusted IPC sender/);
  assert.equal(await f.invoke(f.other), "ok");
  remove.mock.restore();
});
test("another window send failure is a sanitized explicit detach failure after authority revocation", async (t) => {
  const f = fixture(t);
  f.host.on("Thing.run", () => "ok");
  const send = t.mock.method(f.other.webContents, "send", () => {
    throw Error("private send failure");
  });
  assert.throws(
    () => f.host.detach(f.window as any),
    /^Error: Official window native cleanup was not confirmed\.$/,
  );
  assert.throws(() => f.invoke(), /Untrusted IPC sender/);
  assert.equal(await f.invoke(f.other), "ok");
  send.mock.restore();
});

test("whole host dispose continues revoking other windows and global handlers after one cleanup fails", async (t) => {
  const f = fixture(t);
  f.host.on("Thing.run", () => "ok");
  const remove = t.mock.method(f.window.webContents, "removeListener", () => {
    throw Error("inert cleanup failure");
  });
  assert.throws(
    () => f.host.dispose(),
    /^Error: Official native host cleanup was not confirmed\.$/,
  );
  assert.equal(f.host.window, undefined);
  assert.equal(f.host.windowForId(f.other.id), undefined);
  assert.equal(invokes.size, 0);
  assert.equal(sync.size, 0);
  assert.equal(f.host.caller, undefined);
  remove.mock.restore();
});

test("each attached window uses its own exact origin and activation for IPC, lookup and event delivery", async (t) => {
  const f = fixture(t);
  f.host.on("Thing.run", () => "ok");
  let current = true;
  f.host.detach(f.window as any);
  f.window.webContents.mainFrame.url = "http://localhost:35001/new";
  f.host.attach(f.window as any, {
    origin: "http://localhost:35001",
    current: () => current,
  });
  assert.equal(await f.invoke(), "ok");
  f.window.webContents.mainFrame.url = "http://localhost:35002/new";
  assert.throws(() => f.invoke(), /Untrusted/);
  f.window.webContents.mainFrame.url = "http://localhost:35001/new";
  const send = t.mock.method(f.window.webContents, "send", () => {});
  current = false;
  assert.throws(() => f.invoke(), /Untrusted/);
  assert.equal(f.host.windowForId(f.window.id), undefined);
  f.host.emit("WindowState", "appFocusChanged", true);
  assert.equal(send.mock.callCount(), 0);
  assert.equal(await f.invoke(f.other), "ok");
});
test("verified invocation lease survives awaited backend call and prevents a second call after retirement", async (t) => {
  const f = fixture(t);
  let release!: () => void,
    calls: string[] = [];
  f.host.ctx.call = async (method: string) => {
    calls.push(method);
    if (method === "first") await new Promise<void>((r) => (release = r));
    return "value";
  };
  f.host.on("Thing.run", async () => {
    await f.host.ctx.call("first");
    return f.host.ctx.call("second");
  });
  const pending = f.invoke();
  f.host.detach(f.window as any);
  release();
  await assert.rejects(pending, /account window has retired/);
  assert.deepEqual(calls, ["first"]);
});

test("original menu IPC uses actual verified main-frame caller and rejects detached or foreign frames", async (t) => {
  const f = fixture(t);
  const { registerOfficialAppMenu } =
    await import("../electron/official-ui/native/app-menu");
  const opened: unknown[] = [];
  registerOfficialAppMenu(f.host, () => ({
    popup: ({ window }) => {
      opened.push(window);
    },
  }));
  const invoke = invokes.get(menuChannel)!;
  await invoke(f.event());
  assert.deepEqual(opened, [f.window]);
  assert.throws(
    () =>
      invoke({
        ...f.event(),
        senderFrame: { url: "http://fixture.invalid/new" },
      }),
    /Untrusted IPC sender/,
  );
  await assert.rejects(
    async () => invoke(f.event(), "renderer-window-id"),
    /takes no arguments/,
  );
  f.host.detach(f.window as any);
  assert.throws(() => invoke(f.event()), /Untrusted IPC sender/);
  await invoke(f.event(f.other));
  assert.deepEqual(opened, [f.window, f.other]);
});

test("Settings uses original event-only Navigation channel for just the active target", async (t) => {
  const {openOfficialWindowSettings} = await import("../electron/official-ui/native/app-menu");
  const f = fixture(t);
  const target = t.mock.method(f.window.webContents, "send", () => {});
  const other = t.mock.method(f.other.webContents, "send", () => {});
  assert.equal(openOfficialWindowSettings(f.window as any), true);
  assert.deepEqual(target.mock.calls.map(c => c.arguments), [["prefix_$_claude.web_$_Navigation_$_navigate", "/settings/general"]]);
  assert.equal(other.mock.callCount(), 0);
  f.host.detach(f.window as any);
  assert.equal(openOfficialWindowSettings(f.window as any), true);
  assert.equal(target.mock.callCount(), 1);
});


test("desktop links wait for the destination page and navigate only its live window", async (t) => {
  const f = fixture(t);
  const opens = registerQuickEntry(f.host);
  opens.attach(f.window as any);
  opens.attach(f.other as any);
  const target = t.mock.method(f.window.webContents, "send");
  const other = t.mock.method(f.other.webContents, "send");
  const ready = invokes.get(osReadyChannel)!;

  opens.navigate(f.window as any, "/epitaxy?q=compose+only");
  f.window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  await ready(f.event(f.other));
  assert.equal(target.mock.callCount(), 0);
  assert.equal(other.mock.callCount(), 0);

  await ready(f.event());
  await ready(f.event());
  opens.navigate(f.window as any, "/project/p1");
  assert.deepEqual(target.mock.calls.map(call => call.arguments), [
    ["prefix_$_claude.web_$_Navigation_$_navigate", "/epitaxy?q=compose+only"],
    ["prefix_$_claude.web_$_Navigation_$_navigate", "/project/p1"],
  ]);

  f.host.detach(f.window as any);
  opens.navigate(f.window as any, "/new?q=retired");
  assert.equal(target.mock.callCount(), 2);
  assert.equal(other.mock.calls.some(call =>
    call.arguments[0] === "prefix_$_claude.web_$_Navigation_$_navigate",
  ), false);
});

test("Sidebar uses verified caller, isolates windows, and emits one original menu event before detach", async (t) => {
  const f = fixture(t);
  const { registerOfficialAppMenu, officialSidebarMenuState, toggleOfficialWindowSidebar } = await import("../electron/official-ui/native/app-menu");
  registerOfficialAppMenu(f.host, () => null);
  const invoke = invokes.get("prefix_$_claude.web_$_WindowControl_$_reportSidebarMenuState")!;
  const target = t.mock.method(f.window.webContents, "send", () => {});
  const other = t.mock.method(f.other.webContents, "send", () => {});
  await invoke(f.event(), { enabled: true, open: false });
  assert.deepEqual(officialSidebarMenuState(f.window as any), { sidebarEnabled: true, sidebarOpen: false });
  assert.deepEqual(officialSidebarMenuState(f.other as any), { sidebarEnabled: false, sidebarOpen: false });
  assert.throws(() => invoke({ ...f.event(), senderFrame: { url: "http://fixture.invalid/new" } }, { enabled: true, open: true }), /Untrusted IPC sender/);
  toggleOfficialWindowSidebar(f.window as any);
  assert.deepEqual(target.mock.calls.map(c => c.arguments), [["prefix_$_claude.web_$_MenuEvents_$_toggleSidebar", "menu"]]);
  assert.equal(other.mock.callCount(), 0);
  f.host.detach(f.window as any);
  assert.throws(() => invoke(f.event(), { enabled: true, open: true }), /Untrusted IPC sender/);
  toggleOfficialWindowSidebar(f.window as any);
  assert.equal(target.mock.callCount(), 1);
  assert.equal(f.window.webContents.listenerCount("did-start-navigation"), 0);
  await invoke(f.event(f.other), { enabled: true, open: true });
  assert.deepEqual(officialSidebarMenuState(f.other as any), { sidebarEnabled: true, sidebarOpen: true });
});


test("navigation state events are scoped to the live main frame of the changed window", (t) => {
  const f = fixture(t);
  Object.assign(f.window.webContents, {
    navigationHistory: { canGoBack: () => true, canGoForward: () => false },
  });
  const send = t.mock.method(f.window.webContents, "send");
  const otherSend = t.mock.method(f.other.webContents, "send");
  const url = f.window.webContents.mainFrame.url;
  f.window.webContents.emit("did-navigate-in-page", {}, url, false);
  f.window.webContents.emit("did-navigate", {}, "http://foreign.invalid/new");
  assert.equal(send.mock.callCount(), 0);

  f.window.webContents.emit("did-navigate-in-page", {}, url, true);
  f.window.webContents.emit("did-navigate", {}, url);
  assert.deepEqual(send.mock.calls.map(call => call.arguments), Array.from({ length: 2 }, () => [
    "prefix_$_claude.web_$_BrowserNavigation_$_navigationState_$store$_update",
    { canGoBack: true, canGoForward: false },
  ]));
  assert.equal(otherSend.mock.callCount(), 0);

  f.host.detach(f.window as any);
  assert.equal(f.window.webContents.listenerCount("did-navigate"), 0);
  assert.equal(f.window.webContents.listenerCount("did-navigate-in-page"), 0);
});
