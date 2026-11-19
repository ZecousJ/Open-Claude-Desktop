import test from "node:test";
import assert from "node:assert/strict";
import { registerLaunch } from "../electron/official-ui/native/launch";
import { EventEmitter } from "node:events";
test("preview capture returns PNG bytes in the format consumed by the original overlay", async () => {
  const handlers = new Map<string, any>();
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  let available = true;
  const state: any = { tabs: [{ id: "tab", url: "http://localhost:5173" }], activeTabId: "tab", devServers: [] };
  registerLaunch({
    ctx: {
      account: () => ({ id: "a" }),
      localLoadConversation: async () => ({ id: "code", mode: "code", cwd: "/work" }),
      onEvent: () => () => {},
      localCall: async (name: string) => name === "browserState" ? structuredClone(state)
        : name === "officialCaptureBrowserPreview" ? (available ? png.toString("base64") : null) : undefined,
    },
    on: (name: string, fn: any) => handlers.set(name, fn),
    store: () => ({ get: () => [], set() {} }),
    emit() {},
  } as never);
  await handlers.get("Launch.startBrowserPreview")("/work", "local_code");
  for (const name of ["Launch.capturePreviewScreenshot", "Launch.capturePreviewScreenshotIfChanged"]) {
    const value = await handlers.get(name)("preview-local_code");
    assert.equal(value, png.toString("base64"));
    assert.deepEqual(Buffer.from(value, "base64"), png);
    assert.ok(!value.startsWith("data:"));
  }
  available = false;
  assert.equal(await handlers.get("Launch.capturePreviewScreenshot")("preview-local_code"), null);
});
test("first preview creates one real blank tab even when focus and start race", async () => {
  const handlers = new Map<string, any>(),
    c = { id: "empty", mode: "code", cwd: "/work" };
  let created = 0;
  const state: any = { tabs: [], devServers: [] };
  registerLaunch({
    ctx: {
      account: () => ({ id: "a" }),
      localLoadConversation: async () => c,
      onEvent: () => () => {},
      localCall: async (name: string) => {
        if (name === "browserState") return structuredClone(state);
        if (name === "browserNewTab") {
          created++;
          await new Promise((r) => setTimeout(r, 10));
          state.tabs = [
            {
              id: "blank",
              url: "about:blank",
              title: "New tab",
              loading: false,
            },
          ];
          state.activeTabId = "blank";
          return "blank";
        }
      },
    },
    on: (n: string, f: any) => handlers.set(n, f),
    store: () => ({ get: () => [], set() {} }),
    emit() {},
  } as never);
  await Promise.all([
    handlers.get("LocalSessions.setFocusedSession")("local_empty"),
    handlers.get("Launch.startBrowserPreview")("/work", "local_empty"),
  ]);
  assert.equal(created, 1);
  assert.equal(
    (await handlers.get("Launch.getPreviewTabs")("preview-local_empty"))
      .activeTabId,
    "blank",
  );
  await handlers.get("LocalSessions.setFocusedSession")("local_empty");
  assert.equal(created, 1);
});

test("official server launch publishes only real services and rejects another session folder", async () => {
  const handlers = new Map<string, any>(),
    calls: any[] = [],
    c = { id: "code", mode: "code", cwd: "/authorized" };
  let saved: any[] = [],
    status = "stopped";
  const state = () => ({
    conversationId: "code",
    tabs: [],
    devServers: [
      {
        name: "web",
        status,
        source: "launch.json",
        port: 4567,
        url: "http://localhost:4567",
        startedAt: 1000,
      },
    ],
    viewport: "desktop",
  });
  registerLaunch({
    ctx: {
      account: () => ({ id: "a" }),
      localListConversations: async () => [c],
      localLoadConversation: async (id: string) =>
        id === c.id ? c : undefined,
      onEvent: () => () => {},
      localCall: async (name: string, ...args: any[]) => {
        calls.push([name, ...args]);
        if (name === "browserState") return state();
        if (name === "devServersStart") {
          status = "running";
          return state().devServers[0];
        }
        if (name === "devServersStop") {
          status = "stopped";
          return;
        }
        if (name === "officialFocusOrOpenBrowserTab") return "tab";
        if (name === "officialDevServerLogs")
          return [
            {
              line: "ready",
              stream: "stdout",
              timestamp: "2026-11-02T00:00:00Z",
            },
          ];
      },
    },
    on: (name: string, fn: any) => handlers.set(name, fn),
    store: () => ({ get: () => saved, set: (v: any[]) => (saved = v) }),
    emit() {},
  } as never);
  const call = (name: string, ...args: any[]) =>
    handlers.get("Launch." + name)(...args);
  const bad = await call("startFromConfig", "/other", "web", "local_code");
  assert.ok(bad.error);
  assert.equal(calls.length, 0);
  const started = await call(
    "startFromConfig",
    "/authorized",
    "web",
    "local_code",
  );
  assert.equal(started.serverId, "dev-code:web");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].port, 4567);
  assert.equal(saved[0].status, "running");
  assert.equal((await call("getLogs", started.serverId))[0].line, "ready");
  await call("stopServer", started.serverId);
  assert.deepEqual(saved, []);
  await assert.rejects(call("getLogs", "dev-unknown:web"), /not found/);
});

test("landing previews retain their caller across async creation and close only that window's draft", async () => {
  const handlers = new Map<string, (...a: any[]) => any>(),
    calls: any[] = [],
    events: any[] = [];
  const windows = [1, 2].map((id) =>
    Object.assign(new EventEmitter(), { id, isDestroyed: () => false }),
  );
  let count = 0,
    account = "a";
  const host: any = {
    caller: windows[0],
    ctx: {
      account: () => ({ id: account }),
      onEvent: () => () => {},
      localCall: async (method: string, ...args: any[]) => {
        calls.push([method, ...args]);
        if (method === "officialDraftBrowserStart") {
          const n = ++count;
          await new Promise((r) => setTimeout(r, 2));
          return { ownerId: "draft-" + n, cwd: "/tmp" };
        }
        if (method === "browserState") return { tabs: [], devServers: [] };
        if (method === "officialFocusBrowserPreview") return true;
      },
    },
    on: (name: string, fn: any) => handlers.set(name, fn),
    store: () => ({ get: () => [], set: () => {} }),
    emitTo: (w: any, ...args: any[]) => events.push([w.id, ...args]),
    emit: () => {
      throw Error("draft event broadcast");
    },
  };
  registerLaunch(host);
  const call = (name: string, ...args: any[]) =>
    handlers.get("Launch." + name)!(...args);
  const first = call("focusPreview", "preview-landing", "1");
  const duplicate = call("getPreviewTabs", "preview-landing");
  host.caller = windows[1];
  await call("getPreviewTabs", "preview-landing");
  assert.equal(await first, true);
  await duplicate;
  assert.equal(count, 2);
  assert.ok(
    calls.some(
      (c) => c[0] === "officialFocusBrowserPreview" && c[1] === "draft-1",
    ),
  );
  await assert.rejects(
    call("getPreviewTabs", "preview-landing-window-1"),
    /Internal preview/,
  );
  await call("stopServer", "preview-landing");
  assert.deepEqual(events.at(-2), [
    2,
    "Launch",
    "previewTabsChanged",
    "preview-landing",
    [],
    "seed",
  ]);
  assert.deepEqual(events.at(-1), [2, "Launch", "previewUrlChanged", "preview-landing", ""]);
  host.caller = windows[0];
  await call("destroyPreview", "preview-landing");
  assert.deepEqual(calls.at(-1), ["officialCloseBrowserPreview", "draft-1"]);
  const stopped = count;
  await call("hidePreview", "preview-landing");
  assert.equal(count, stopped);
  account = "b";
  await call("getPreviewTabs", "preview-landing");
  assert.equal(count, 3);
  windows[0].emit("closed");
  await call("getPreviewTabs", "preview-landing");
  assert.equal(count, 4);
});

test("official launch uses stable session ids, correct tab fields and acknowledged native bounds", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const calls: unknown[][] = [];
  let account = "one";
  let saved: any[] = [];
  const c = { id: "code", mode: "code", cwd: "/authorized" };
  const state = {
    conversationId: c.id,
    tabs: [
      {
        id: "tab-1",
        url: "https://example.test/",
        title: "Page",
        loading: false,
      },
    ],
    activeTabId: "tab-1",
    devServers: [],
    toolsAvailable: true,
    viewport: "desktop",
  };
  registerLaunch({
    ctx: {
      account: () => ({ id: account }),
      localListConversations: async () => [c],
      localLoadConversation: async (id: string) =>
        id === c.id ? c : undefined,
      localCall: async (...args: unknown[]) => {
        calls.push(args);
        return args[0] === "browserState"
          ? state
          : args[0] === "browserNavigate"
            ? { ok: true }
            : args[0] === "officialShowBrowserPreview";
      },
      onEvent: () => () => {},
    },
    on(name: string, fn: any) {
      handlers.set(name, fn);
    },
    store() {
      return {
        get: () => saved,
        set: (v: any[]) => {
          saved = v;
        },
      };
    },
    emit() {},
  } as never);
  await handlers.get("LocalSessions.setFocusedSession")!("local_code");
  assert.deepEqual(
    saved,
    [],
    "A preview with no listening server must not make a disabled Servers row",
  );
  const call = (name: string, ...args: any[]) =>
    handlers.get(`Launch.${name}`)!(...args);
  const tabs = await call("getPreviewTabs", "preview-local_code");
  assert.equal(tabs.tabs[0].tabId, "tab-1");
  assert.equal(tabs.tabs[0].origin, "https://example.test");
  assert.equal(
    await call("showPreview", "preview-local_code", {
      x: 1,
      y: 2,
      width: 300,
      height: 200,
      radius: 8,
    }),
    true,
  );
  assert.deepEqual(calls.at(-1), [
    "officialShowBrowserPreview",
    "code",
    "preview-local_code",
    { x: 1, y: 2, width: 300, height: 200, radius: 8 },
    undefined,
  ]);
  assert.equal(
    await call(
      "navigatePreview",
      "preview-local_code",
      "https://example.test/two",
    ),
    true,
  );
  await assert.rejects(
    call("startBrowserPreview", "/different", "local_code"),
    /working folder/,
  );
  account = "two";
  assert.deepEqual(await call("getPreviewTabs", "preview-local_code"), {
    tabs: [],
    activeTabId: "seed",
  });
  assert.deepEqual(saved, []);
});

test("a model-opened tab reveals the Browser only in the window viewing its Code session", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const reveals: unknown[][] = [];
  const calls: unknown[][] = [];
  const makeWindow = (id: number, sessionId: string) => ({
    id,
    isDestroyed: () => false,
    isFocused: () => true,
    webContents: {
      isDestroyed: () => false,
      mainFrame: { url: "http://fixture.invalid/epitaxy/local_" + sessionId },
    },
  });
  const window = makeWindow(1, "code");
  const other = makeWindow(2, "different");
  const state = {
    version: 1,
    conversationId: "code",
    tabs: [{ id: "opened", url: "https://example.test/", title: "Opened" }],
    activeTabId: "opened",
    devServers: [],
    toolsAvailable: true,
    viewport: "desktop",
  };
  let notify!: (event: { type: "browser-reveal"; conversationId: string }) => void;
  registerLaunch({
    window,
    currentWindows: () => [window, other],
    windowForId: (id: number) => [window, other].find(w => w.id === id),
    ctx: {
      account: () => ({ id: "a" }),
      localLoadConversation: async (id: string) => ({ id, mode: "code", cwd: "/work" }),
      onEvent: (callback: typeof notify) => {
        notify = callback;
        return () => {};
      },
      localCall: async (...args: unknown[]) => {
        calls.push(args);
        assert.equal(args[0], "browserState");
        return state;
      },
      log: () => {},
    },
    on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn),
    store: () => ({ get: () => [], set() {} }),
    emit() {},
    emitTo: (window: { id: number }, group: string, name: string, ...data: unknown[]) => {
      if (name === "previewRevealRequested") reveals.push([window.id, group, ...data]);
    },
  } as never);
  await handlers.get("LocalSessions.setFocusedSession")!("local_code");
  calls.length = 0;
  notify({ type: "browser-reveal", conversationId: "code" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(reveals, [[1, "Launch", "preview-local_code", "local_code", "opened"]]);
  assert.deepEqual(calls, [["browserState", "code"]]);

  await handlers.get("LocalSessions.setFocusedSession")!("local_different");
  reveals.length = 0;
  calls.length = 0;
  notify({ type: "browser-reveal", conversationId: "code" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(reveals, []);
  assert.deepEqual(calls, []);
});
