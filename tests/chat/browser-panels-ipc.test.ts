/**
 * The Browser panel's bridge calls and main-process host (R8-A), with
 * stand-ins for Electron's views, windows and debugger: which conversations
 * may use it, argument checks, tabs, showing and parking pages, covering
 * menus, the guard's refusals, dialogs, Select element, dev server calls
 * and the Open in browser policy check.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Conversation } from "../../shared/types";
import type { BrowserSavedPage, BrowserState } from "../../shared/browser";
import { panelsMethods } from "../../shared/panels-api";
import { openPolicy } from "../../shared/client-policy";
import type { AppContext } from "../../electron/app/app-context";
import {
  registerPanelHandlers,
  screenshotName,
  type BrowserPanelDeps,
} from "../../electron/ipc/panels";
import {
  BrowserHost,
  type HostView,
  type HostWindow,
  type ParkingWindow,
} from "../../electron/browser/browser-host";
import { defaultPageSize } from "../../electron/browser/browser-host-support";
import type { BrowserService, DevServersPort } from "../../electron/browser";

const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeDebugger extends EventEmitter {
  attached = false;
  sent: { method: string; params?: any }[] = [];
  answers: Record<string, (params: any) => any> = {};
  attach() {
    this.attached = true;
  }
  isAttached() {
    return this.attached;
  }
  detach() {
    this.attached = false;
  }
  async sendCommand(method: string, params?: any) {
    this.sent.push({ method, params });
    const answer = this.answers[method];
    return answer ? answer(params) : {};
  }
  /** A CDP event from the page. */
  event(method: string, params: any) {
    this.emit("message", {}, method, params);
  }
}

class FakeContents extends EventEmitter {
  loaded: string[] = [];
  destroyed = false;
  history: string[] = [];
  index = -1;
  title = "";
  loading = false;
  reloads = 0;
  stops = 0;
  openHandler?: (d: { url: string; disposition: string }) => { action: "deny" };
  debugger = new FakeDebugger();
  navigationHistory = {
    canGoBack: () => this.index > 0,
    canGoForward: () => this.index < this.history.length - 1,
    goBack: () => this.go(this.index - 1),
    goForward: () => this.go(this.index + 1),
  };
  private go(index: number) {
    this.index = index;
    this.arrive(this.history[index]);
  }
  private arrive(url: string) {
    this.emit("did-start-loading");
    this.loading = true;
    this.emit("did-navigate", {}, url, 200);
    if (url.includes("slow")) return;
    this.loading = false;
    this.title = `Title of ${new URL(url).pathname}`;
    this.emit("page-title-updated", {}, this.title);
    this.emit("did-stop-loading");
  }
  async loadURL(url: string) {
    this.loaded.push(url);
    if (url.includes("refused")) {
      this.emit("did-start-loading");
      this.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", url, true);
      this.emit("did-stop-loading");
      return;
    }
    this.history = [...this.history.slice(0, this.index + 1), url];
    this.index = this.history.length - 1;
    this.arrive(url);
  }
  getURL() {
    return this.history[this.index] ?? "";
  }
  getTitle() {
    return this.title;
  }
  isLoading() {
    return this.loading;
  }
  isDestroyed() {
    return this.destroyed;
  }
  reload() {
    this.reloads++;
  }
  stop() {
    this.stops++;
  }
  close() {
    this.destroyed = true;
  }
  async capturePage() {
    return {
      isEmpty: () => false,
      toJPEG: () => Buffer.from("jpeg-bytes"),
      toPNG: () => Buffer.from("png-bytes"),
    };
  }
  getUserAgent() {
    return "Mozilla/5.0 Chrome/140";
  }
  setWindowOpenHandler(handler: any) {
    this.openHandler = handler;
  }
}

class FakeView implements HostView {
  webContents = new FakeContents() as unknown as HostView["webContents"] &
    FakeContents;
  bounds?: { x: number; y: number; width: number; height: number };
  constructor(public partition: string) {}
  setBounds(bounds: { x: number; y: number; width: number; height: number }) {
    this.bounds = bounds;
  }
}

class FakeContentView {
  children: HostView[] = [];
  addChildView(view: HostView) {
    this.children.push(view);
  }
  removeChildView(view: HostView) {
    this.children = this.children.filter((child) => child !== view);
  }
}

class FakeWindow extends EventEmitter implements HostWindow {
  contentView = new FakeContentView();
  zoom = 1;
  minimized = false;
  visible = true;
  destroyed = false;
  webContents = { getZoomFactor: () => this.zoom };
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return this.minimized;
  }
  isVisible() {
    return this.visible;
  }
}

class FakeParking implements ParkingWindow {
  contentView = new FakeContentView();
  size = { width: 0, height: 0 };
  isDestroyed() {
    return false;
  }
  setContentSize(width: number, height: number) {
    this.size = { width, height };
  }
}

function conversation(id: string, mode: Conversation["mode"]): Conversation {
  return {
    id,
    title: id,
    mode,
    cwd: "/work/app",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    turns: [],
  };
}

function setup(
  options: {
    blocked?: string[];
    externalLinks?: boolean;
    browserEnabled?: boolean;
    savedPage?: BrowserSavedPage;
    savePage?: (id: string, page: BrowserSavedPage | undefined) => void;
    partition?: (id: string, url?: string) => string;
  } = {},
) {
  const views: FakeView[] = [];
  const pushes: BrowserState[] = [];
  const parking = new FakeParking();
  const window = new FakeWindow();
  let blocked = options.blocked ?? [];
  let devServers: DevServersPort | undefined;
  const host = new BrowserHost({
    platform: {
      platform: "darwin",
      createView(partition) {
        const view = new FakeView(partition);
        views.push(view);
        return view;
      },
      parking: () => parking,
    },
    partition: options.partition ?? ((id) => `persist:test-${id}`),
    savedPage: () => options.savedPage,
    savePage: options.savePage,
    blockedDomains: () => blocked,
    toolsAvailable: () => true,
    devServers: (id) =>
      devServers
        ? { available: true, servers: devServers.list(id) }
        : { available: false, servers: [] },
    push: (state) => pushes.push(state),
    stallMs: 30,
  });
  const service: BrowserService = {
    host,
    toolsAvailable: () => true,
    policy: () => (options.browserEnabled === false ? { enabled: false } : {}),
    blockedDomains: () => blocked,
    keepCookies: () => "until-quit",
    openUrl: () => ({ ok: false, message: "unused" }),
    attachDevServers(port) {
      devServers = port;
      return () => (devServers = undefined);
    },
    devServers: () => devServers,
    clearBrowsingData: async () => {},
    clearPreviewData: async () => {},
    defaultBrowserName: () => "Google Chrome",
  };
  const saved: { name: string; png: string }[] = [];
  const opened: string[] = [];
  let chosenFile: string | undefined;
  const deps: BrowserPanelDeps = {
    service: () => service,
    async saveImage(_window, png, name) {
      saved.push({ name, png: png.toString() });
      return true;
    },
    chooseHtmlFile: async () => chosenFile,
    async saveFile(_window, bytes, name) {
      saved.push({ name, png: bytes.toString() });
      return true;
    },
    async openExternal(url) {
      opened.push(url);
    },
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  const policy = {
    ...openPolicy,
    ...(options.externalLinks === false ? { externalLinks: false } : {}),
  };
  const ctx = {
    store: {
      settings: {},
      flush() {},
      conversations: [
        conversation("code-1", "code"),
        conversation("code-2", "code"),
        conversation("chat-1", "chat"),
        conversation("cowork-1", "cowork"),
      ],
    },
    callerWindow: () => window,
    settingsChanged() {},
    policy: () => policy,
  } as unknown as AppContext;
  registerPanelHandlers(
    (name, fn) => handlers.set(name, fn),
    ctx,
    async () => deps,
  );
  const call = (name: string, ...args: unknown[]) => {
    const fn = handlers.get(name);
    if (!fn) throw new Error(`no handler ${name}`);
    return Promise.resolve(fn(...args));
  };
  return {
    call,
    host,
    views,
    pushes,
    parking,
    window,
    handlers,
    saved,
    opened,
    service,
    setBlocked: (value: string[]) => (blocked = value),
    chooseFile: (file: string | undefined) => (chosenFile = file),
  };
}

test("clearing preview data uses its own bridge operation, not ordinary browsing data", async () => {
  const { call, service, host } = setup();
  const cleared: string[] = [];
  service.clearPreviewData = async () => {
    cleared.push("preview");
  };
  service.clearBrowsingData = async () => {
    cleared.push("browser");
  };
  await call("browserClearPreviewData");
  assert.deepEqual(cleared, ["preview"]);
  await call("browserClearData");
  assert.deepEqual(cleared, ["preview", "browser"]);
  let clearedSession: string | undefined;
  service.clearBrowsingData = async (id) => {
    clearedSession = id;
  };
  await call("browserClearData", "code-1");
  assert.equal(clearedSession, "code-1");
  host.dispose();
});

test("Cowork offers the consent-gated importer only when browser use is enabled", async () => {
  const { call, service, host } = setup();
  const accessed: string[] = [];
  service.chromeImport = async () =>
    ({
      profiles: async () => [{ id: "chrome-default" }],
      touchId: () => true,
      sites: async (id: string, profile: string) => {
        accessed.push(`${id}:${profile}`);
        return { ok: false, error: "keychain_denied" };
      },
      import: async (id: string) => {
        accessed.push(id);
        return { ok: false, error: "expired" };
      },
    }) as unknown as Awaited<
      ReturnType<NonNullable<BrowserService["chromeImport"]>>
    >;
  assert.deepEqual(await call("getCoworkChromeImportAvailability"), {
    available: true,
    touchId: true,
  });
  assert.equal(
    accessed.length,
    0,
    "availability never reads or imports private data",
  );
  assert.equal(
    (await call("browserState", "cowork-1")).conversationId,
    "cowork-1",
  );
  assert.deepEqual(
    await call("listChromeImportSites", "cowork-1", "chrome-default"),
    { ok: false, error: "keychain_denied" },
  );
  assert.deepEqual(
    await call(
      "importChromeLogins",
      "cowork-1",
      "00000000-0000-4000-8000-000000000000",
      ["example.com"],
      false,
    ),
    { ok: false, error: "expired" },
  );
  assert.deepEqual(accessed, ["cowork-1:chrome-default", "cowork-1"]);
  service.policy = () => ({ externalSites: false });
  assert.deepEqual(await call("getCoworkChromeImportAvailability"), {
    available: false,
    reason: "gate_off",
  });
  service.policy = () => ({});
  service.toolsAvailable = () => false;
  assert.deepEqual(await call("getCoworkChromeImportAvailability"), {
    available: false,
    reason: "gate_off",
  });
  service.toolsAvailable = () => true;
  service.chromeImport = undefined;
  assert.deepEqual(await call("getCoworkChromeImportAvailability"), {
    available: false,
    reason: "no_chrome",
  });
  host.dispose();
});

test("Cowork clears the shared browser data through its own operation and respects policy", async () => {
  const { call, service, host } = setup();
  const cleared: string[] = [];
  service.clearCoworkBrowserData = async () => {
    cleared.push("cowork");
    return true;
  };
  service.clearBrowsingData = async () => {
    cleared.push("all");
  };
  service.clearPreviewData = async () => {
    cleared.push("preview");
  };
  assert.equal(await call("clearCoworkBrowserData"), true);
  assert.deepEqual(cleared, ["cowork"]);
  service.clearCoworkBrowserData = async () => {
    throw new Error("disk failure");
  };
  assert.equal(await call("clearCoworkBrowserData"), false);
  service.policy = () => ({ enabled: false });
  assert.equal(await call("clearCoworkBrowserData"), false);
  assert.deepEqual(cleared, ["cowork"]);
  host.dispose();
});

test("custom viewports propagate through IPC, CDP and restored browser state", async () => {
  const fixture = setup();
  await fixture.call("browserNavigate", "code-1", "https://example.com");
  await wait();
  await fixture.call("browserSetViewport", "code-1", {
    width: 900,
    height: 700,
  });
  assert.deepEqual(fixture.host.state("code-1").viewport, {
    width: 900,
    height: 700,
  });
  assert.ok(
    fixture.views[0].webContents.debugger.sent.some(
      (command) =>
        command.method === "Emulation.setDeviceMetricsOverride" &&
        command.params.width === 900 &&
        command.params.height === 700 &&
        command.params.mobile === false,
    ),
  );
  for (const viewport of [
    { width: 0, height: 700 },
    { width: 900, height: 10001 },
    { width: 2.5, height: 700 },
  ])
    await assert.rejects(
      fixture.call("browserSetViewport", "code-1", viewport),
    );
  fixture.host.dispose();
});

test("Export saves only the HTML file chosen by the user and rejects replaced sources", async (context) => {
  const folder = await mkdtemp(
    path.join(os.tmpdir(), "claudex-browser-export-"),
  );
  const fixture = setup();
  context.after(async () => {
    fixture.host.dispose();
    await rm(folder, { recursive: true, force: true });
  });
  const file = path.join(folder, "page.html");
  await writeFile(file, "<!doctype html><h1>Chosen file</h1>");
  fixture.chooseFile(file);
  await fixture.call("browserOpenHtmlFile", "code-1");
  assert.equal(fixture.host.state("code-1").tabs[0].canExportFile, true);
  assert.equal(await fixture.call("browserExportFile", "code-1"), true);
  assert.deepEqual(fixture.saved, [
    { name: "page.html", png: "<!doctype html><h1>Chosen file</h1>" },
  ]);
  await rm(file);
  await writeFile(file, "replacement");
  await assert.rejects(fixture.call("browserExportFile", "code-1"));
  await fixture.call("browserNavigate", "code-1", "https://example.com");
  assert.equal(fixture.host.state("code-1").tabs[0].canExportFile, false);
  await assert.rejects(fixture.call("browserExportFile", "code-1"));
});

test("restored previews show the saved frame without opening a live page, and dismiss to the start page", async () => {
  const savedPage = {
    url: "http://localhost:5173/account",
    title: "App",
    jpegBase64: "anBlZw==",
    serverName: "web",
  };
  const writes: (BrowserSavedPage | undefined)[] = [];
  const { call, views, host } = setup({
    savedPage,
    savePage: (_id, page) => writes.push(page),
  });
  const state = await call("browserOpen", "code-1");
  assert.deepEqual(state.tabs[0].restored, {
    jpegBase64: savedPage.jpegBase64,
    serverName: "web",
  });
  assert.equal(views.length, 0);
  await call("browserShowStartPage", "code-1");
  assert.equal(host.state("code-1").tabs[0].url, "");
  assert.equal(host.state("code-1").tabs[0].restored, undefined);
  assert.deepEqual(writes, [undefined]);
  host.dispose();
});

test("restored pages can restart in their original tab, and successful pages save their last frame", async () => {
  const writes: BrowserSavedPage[] = [];
  const { host, views } = setup({
    savedPage: {
      url: "https://example.com/old",
      title: "Old",
      jpegBase64: "anBlZw==",
    },
    savePage: (_id, page) => {
      if (page) writes.push(page);
    },
  });
  const tab = host.state("code-1").tabs[0];
  host.navigate("code-1", "https://example.com/new", tab.id);
  await wait();
  assert.equal(host.state("code-1").tabs.length, 1);
  assert.equal(host.state("code-1").tabs[0].restored, undefined);
  assert.equal(views.length, 1);
  assert.equal(writes.at(-1)?.url, "https://example.com/new");
  assert.equal(
    writes.at(-1)?.jpegBase64,
    Buffer.from("jpeg-bytes").toString("base64"),
  );
  host.dispose();
});

test("server navigation changes cookie jars and a departing window cannot hide a popped-out preview", () => {
  const { host, views, window } = setup({
    partition: (_id, url) =>
      url?.includes("localhost") ? "server-jar" : "browser-jar",
  });
  host.navigate("code-1", "https://example.com/");
  host.navigate("code-1", "http://localhost:5173/");
  assert.deepEqual(
    views.map((view) => view.partition),
    ["browser-jar", "server-jar"],
  );
  assert.equal(views[0].webContents.destroyed, true);
  const popped = new FakeWindow();
  host.show("code-1", popped, { x: 0, y: 0, width: 800, height: 600 });
  host.hide("code-1", window);
  assert.ok(popped.contentView.children.includes(views[1]));
  host.dispose();
});

test("every Browser bridge call has a handler here", () => {
  const { handlers } = setup();
  for (const method of panelsMethods.filter(
    (name) => name.startsWith("browser") || name.startsWith("devServers"),
  ))
    assert.ok(handlers.has(method), method);
});

test("preview origins persist through IPC with canonical duplicates, revocation and policy enforcement", async () => {
  const { call, service, host } = setup();
  assert.deepEqual(await call("getPreviewAllowedOrigins"), []);
  assert.equal(
    await call("addPreviewAllowedOrigin", "https://www.Example.com./path"),
    "ok",
  );
  assert.deepEqual(await call("getPreviewAllowedOrigins"), [
    { origin: "https://example.com", builtin: false },
  ]);
  assert.equal(await call("addPreviewAllowedOrigin", "example.com"), "exists");
  assert.equal(
    await call("addPreviewAllowedOrigin", "http://localhost:3000"),
    "loopback",
  );
  assert.equal(
    await call("addPreviewAllowedOrigin", "http://169.254.169.254"),
    "blocked",
  );
  service.policy = () => ({ blockedDomains: ["blocked.example"] });
  assert.equal(
    await call("addPreviewAllowedOrigin", "https://blocked.example"),
    "org-blocked",
  );
  assert.equal(
    await call("removePreviewAllowedOrigin", "https://www.example.com"),
    true,
  );
  assert.equal(
    await call("removePreviewAllowedOrigin", "https://example.com"),
    false,
  );
  await call("addPreviewAllowedOrigin", "https://allowed.example");
  assert.equal(await call("clearPreviewAllowedOrigins"), true);
  assert.deepEqual(await call("getPreviewAllowedOrigins"), []);
  host.dispose();
});

test("the browser is only for Code conversations that exist, and arguments are checked", async () => {
  const { call } = setup();
  await assert.rejects(call("browserState", "chat-1"), /only in Code sessions/);
  await assert.rejects(call("browserState", "missing"), /doesn't exist/);
  await assert.rejects(call("browserState", ""), /too_small|at least/i);
  await assert.rejects(
    call("browserSetBounds", "code-1", { x: 0, y: 0, width: -5, height: 10 }),
  );
  await assert.rejects(
    call("browserSetBounds", "code-1", {
      x: 0,
      y: 0,
      width: 5,
      height: 10,
      z: 1,
    }),
  );
  await assert.rejects(
    call("browserSetBounds", "code-1", {
      x: Infinity,
      y: 0,
      width: 5,
      height: 10,
    }),
  );
  await assert.rejects(call("browserSelectTab", "code-1", "../tab"));
  await assert.rejects(call("browserSetViewport", "code-1", "watch"));
  await assert.rejects(call("browserOcclude", "code-1", "yes"));
  await assert.rejects(call("browserNavigate", "code-1", 42));
  const state = await call("browserState", "code-1");
  assert.equal(state.conversationId, "code-1");
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].title, "New tab");
  assert.equal(state.tabs[0].url, "");
  assert.equal(state.viewport, "desktop");
  assert.equal(state.devServersAvailable, false);
  assert.equal(state.toolsAvailable, true);
});

test("the administrator's Browser switch turns the panel off", async () => {
  const { call, views } = setup({ browserEnabled: false });
  await assert.rejects(call("browserOpen", "code-1"), /turned off the browser/);
  await assert.rejects(
    call("browserNavigate", "code-1", "example.com"),
    /turned off the browser/,
  );
  await assert.rejects(
    call("devServersDetect", "code-1"),
    /turned off the browser/,
  );
  assert.equal(views.length, 0);
});

test("opening the panel again drops a cover left from before", async () => {
  const { call, window } = setup();
  await call("browserOpen", "code-1");
  await call("browserSetBounds", "code-1", {
    x: 10,
    y: 20,
    width: 400,
    height: 300,
  });
  await call("browserNavigate", "code-1", "example.com");
  await call("browserOcclude", "code-1", true);
  assert.equal(window.contentView.children.length, 0);
  await call("browserOpen", "code-1");
  assert.equal(window.contentView.children.length, 1);
});

test("typing an address opens it; words and blocked sites come back as messages", async () => {
  const t = setup({ blocked: ["blocked.com"] });
  assert.deepEqual(await t.call("browserNavigate", "code-1", "how do I"), {
    ok: false,
    message: "Enter a URL, like example.com.",
  });
  assert.deepEqual(
    await t.call("browserNavigate", "code-1", "www.blocked.com"),
    {
      ok: false,
      message: "Your administrator doesn't allow this site.",
    },
  );
  assert.equal(t.views.length, 0, "no page for a refused address");
  const result = await t.call("browserNavigate", "code-1", "localhost:5173");
  assert.deepEqual(result, { ok: true, url: "http://localhost:5173/" });
  assert.equal(t.views.length, 1);
  assert.equal(t.views[0].partition, "persist:test-code-1");
  assert.deepEqual(t.views[0].webContents.loaded, ["http://localhost:5173/"]);
  await wait();
  const state = t.pushes.at(-1)!;
  assert.equal(state.tabs[0].url, "http://localhost:5173/");
  assert.equal(state.tabs[0].title, "Title of /");
  assert.equal(state.tabs[0].loading, false);
  assert.ok(state.version > 0);
  // The debugger is attached for dialogs and logs.
  assert.equal(t.views[0].webContents.debugger.attached, true);
});

test("the page is laid over the panel only while it is open and uncovered; otherwise it is parked", async () => {
  const t = setup();
  await t.call("browserOpen", "code-1");
  await t.call("browserNavigate", "code-1", "https://example.com/");
  const view = t.views[0];
  // No bounds yet: parked at the default size.
  assert.deepEqual(t.window.contentView.children, []);
  assert.deepEqual(t.parking.contentView.children, [view]);
  assert.deepEqual(view.bounds, { x: 0, y: 0, ...defaultPageSize });
  t.window.zoom = 1.25;
  await t.call("browserSetBounds", "code-1", {
    x: 600,
    y: 80,
    width: 537,
    height: 900,
  });
  assert.deepEqual(t.window.contentView.children, [view]);
  assert.deepEqual(t.parking.contentView.children, []);
  assert.deepEqual(view.bounds, { x: 750, y: 100, width: 671, height: 1125 });
  // A menu covers it: a snapshot stands in and the page leaves the window.
  const covered = await t.call("browserOcclude", "code-1", true);
  assert.equal(
    covered.snapshot,
    `data:image/jpeg;base64,${Buffer.from("jpeg-bytes").toString("base64")}`,
  );
  assert.deepEqual(t.window.contentView.children, []);
  assert.deepEqual(await t.call("browserOcclude", "code-1", false), {});
  assert.deepEqual(t.window.contentView.children, [view]);
  // Minimized: parked so Claude can keep taking screenshots.
  t.window.minimized = true;
  t.window.emit("minimize");
  assert.deepEqual(t.window.contentView.children, []);
  assert.deepEqual(t.parking.contentView.children, [view]);
  t.window.minimized = false;
  t.window.emit("restore");
  assert.deepEqual(t.window.contentView.children, [view]);
  // Mobile: the phone's width, centred.
  await t.call("browserSetViewport", "code-1", "mobile");
  assert.deepEqual(view.bounds, {
    x: 750 + Math.round((671 - 375) / 2),
    y: 100,
    width: 375,
    height: 1125,
  });
  assert.equal(
    view.webContents.reloads,
    1,
    "the page reloads to see the phone's user agent",
  );
  assert.ok(
    view.webContents.debugger.sent.some(
      (c) =>
        c.method === "Emulation.setDeviceMetricsOverride" &&
        c.params.mobile === true,
    ),
  );
  await t.call("browserSetViewport", "code-1", "desktop");
  // Another conversation's panel in the same window takes its place.
  await t.call("browserNavigate", "code-2", "https://example.org/");
  await t.call("browserSetBounds", "code-2", {
    x: 600,
    y: 80,
    width: 537,
    height: 900,
  });
  assert.deepEqual(t.window.contentView.children, [t.views[1]]);
  assert.ok(t.parking.contentView.children.includes(view as never));
  // Closing the panel parks the page; its tabs stay.
  await t.call("browserHide", "code-2");
  assert.deepEqual(t.window.contentView.children, []);
  assert.equal(
    (await t.call("browserState", "code-2")).tabs[0].url,
    "https://example.org/",
  );
  // The window closes: nothing refers to it any more.
  await t.call("browserSetBounds", "code-1", {
    x: 0,
    y: 0,
    width: 400,
    height: 400,
  });
  t.window.destroyed = true;
  t.window.emit("closed");
  assert.ok(t.parking.contentView.children.includes(view as never));
});

test("quitting with the panel open: a parking window gone first is left alone", async () => {
  const t = setup();
  await t.call("browserOpen", "code-1");
  await t.call("browserNavigate", "code-1", "https://example.com/");
  await t.call("browserSetBounds", "code-1", {
    x: 600,
    y: 80,
    width: 537,
    height: 900,
  });
  assert.deepEqual(t.window.contentView.children, [t.views[0]]);
  // Electron throws on everything a destroyed window has but isDestroyed.
  const gone = () => {
    throw new TypeError("Object has been destroyed");
  };
  t.parking.isDestroyed = () => true;
  t.parking.setContentSize = gone;
  Object.defineProperty(t.parking, "contentView", { get: gone });
  t.window.destroyed = true;
  t.window.emit("closed");
  // A hidden window's later look finds it gone too.
  const other = setup();
  await other.call("browserOpen", "code-1");
  await other.call("browserNavigate", "code-1", "https://example.com/");
  await other.call("browserSetBounds", "code-1", {
    x: 0,
    y: 0,
    width: 400,
    height: 400,
  });
  other.window.visible = false;
  other.window.emit("hide");
  other.window.destroyed = true;
  other.window.isVisible = gone;
  other.window.isMinimized = gone;
  Object.defineProperty(other.window, "contentView", { get: gone });
  await new Promise((resolve) => setTimeout(resolve, 300));
});

test("tabs: new, select, close, close others; the panel keeps one tab", async () => {
  const t = setup();
  const first = (await t.call("browserState", "code-1")).tabs[0].id;
  const second = await t.call("browserNewTab", "code-1", "example.com");
  const third = await t.call("browserNewTab", "code-1");
  let state = t.host.state("code-1");
  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    [first, second, third],
  );
  assert.equal(state.activeTabId, third);
  assert.equal(state.tabs[1].url, "https://example.com/");
  await t.call("browserSelectTab", "code-1", second);
  assert.equal(t.host.state("code-1").activeTabId, second);
  await t.call("browserCloseOtherTabs", "code-1", second);
  state = t.host.state("code-1");
  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    [second],
  );
  await t.call("browserCloseTab", "code-1", second);
  state = t.host.state("code-1");
  assert.equal(state.tabs.length, 1);
  assert.notEqual(state.tabs[0].id, second);
  assert.equal(state.tabs[0].title, "New tab");
  assert.equal(
    t.views[0].webContents.destroyed,
    true,
    "a closed tab's page is closed",
  );
  await assert.rejects(call(t, "browserSelectTab", "code-1", second), /closed/);
  await assert.rejects(
    t.call("browserNewTab", "code-1", "not a url"),
    /Enter a URL/,
  );
  assert.equal(
    t.host.state("code-1").tabs.length,
    1,
    "a refused new tab is not left behind",
  );
});

function call(t: ReturnType<typeof setup>, name: string, ...args: unknown[]) {
  return t.call(name, ...args);
}

test("back, forward, reload, stop, load errors, stalls and crashes", async () => {
  const t = setup();
  await t.call("browserNavigate", "code-1", "https://example.com/a");
  await t.call("browserNavigate", "code-1", "https://example.com/b");
  const contents = t.views[0].webContents;
  let tab = t.host.state("code-1").tabs[0];
  assert.equal(tab.canGoBack, true);
  await t.call("browserBack", "code-1");
  tab = t.host.state("code-1").tabs[0];
  assert.equal(tab.url, "https://example.com/a");
  assert.equal(tab.canGoForward, true);
  await t.call("browserForward", "code-1");
  assert.equal(t.host.state("code-1").tabs[0].url, "https://example.com/b");
  await t.call("browserReload", "code-1");
  await t.call("browserStop", "code-1");
  assert.equal(contents.reloads, 1);
  assert.equal(contents.stops, 1);
  // A refused connection: an error the panel shows, and the page leaves the window.
  await t.call("browserSetBounds", "code-1", {
    x: 0,
    y: 0,
    width: 400,
    height: 300,
  });
  assert.equal(t.window.contentView.children.length, 1);
  await t.call("browserNavigate", "code-1", "http://localhost:9/refused");
  tab = t.host.state("code-1").tabs[0];
  assert.deepEqual(tab.error, {
    code: -102,
    description: "ERR_CONNECTION_REFUSED",
    url: "http://localhost:9/refused",
  });
  assert.equal(t.window.contentView.children.length, 0);
  // Try again loads the address again.
  await t.call("browserReload", "code-1");
  assert.equal(contents.loaded.at(-1), "http://localhost:9/refused");
  // Arrived but still loading after the stall time.
  await t.call("browserNavigate", "code-1", "https://example.com/slow");
  await wait(80);
  assert.equal(t.host.state("code-1").tabs[0].stalled, true);
  contents.loading = false;
  contents.emit("did-stop-loading");
  assert.equal(t.host.state("code-1").tabs[0].stalled, false);
  // A crashed page: shown as crashed; Reload makes a new page.
  contents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(t.host.state("code-1").tabs[0].crashed, true);
  await t.call("browserReload", "code-1");
  assert.equal(t.views.length, 2);
  assert.equal(t.host.state("code-1").tabs[0].crashed, false);
});

test("the guard: blocked navigations show an error, new windows become tabs, webviews never attach", async () => {
  const t = setup({ blocked: ["blocked.com"] });
  await t.call("browserNavigate", "code-1", "https://example.com/");
  const contents = t.views[0].webContents;
  let prevented = false;
  contents.emit("will-navigate", {
    url: "https://blocked.com/x",
    isMainFrame: true,
    preventDefault: () => (prevented = true),
  });
  assert.equal(prevented, true);
  assert.equal(
    t.host.state("code-1").tabs[0].error?.description,
    "BLOCKED_BY_ADMINISTRATOR",
  );
  prevented = false;
  contents.emit("will-navigate", {
    url: "javascript:alert(1)",
    isMainFrame: true,
    preventDefault: () => (prevented = true),
  });
  assert.equal(prevented, true);
  prevented = false;
  contents.emit("will-frame-navigate", {
    url: "file:///etc/passwd",
    isMainFrame: false,
    preventDefault: () => (prevented = true),
  });
  assert.equal(prevented, true);
  prevented = false;
  contents.emit("will-attach-webview", {
    preventDefault: () => (prevented = true),
  });
  assert.equal(prevented, true);
  assert.deepEqual(
    contents.openHandler!({
      url: "https://example.com/popup",
      disposition: "foreground-tab",
    }),
    { action: "deny" },
  );
  const state = t.host.state("code-1");
  assert.equal(state.tabs.length, 2);
  assert.equal(state.tabs[1].url, "https://example.com/popup");
  assert.equal(state.activeTabId, state.tabs[1].id);
  contents.openHandler!({
    url: "https://example.com/bg",
    disposition: "background-tab",
  });
  assert.equal(t.host.state("code-1").activeTabId, state.tabs[1].id);
  contents.openHandler!({ url: "mailto:a@b.c", disposition: "new-window" });
  assert.equal(t.host.state("code-1").tabs.length, 3);
});

test("downloads are refused with a notice on the tab", async () => {
  const t = setup();
  await t.call("browserNavigate", "code-1", "https://example.com/");
  t.host.noteDownloadRefused(t.views[0].webContents, "report.pdf");
  assert.deepEqual(t.host.state("code-1").tabs[0].notice, {
    kind: "download-blocked",
    filename: "report.pdf",
  });
  await t.call("browserNavigate", "code-1", "https://example.com/next");
  assert.equal(t.host.state("code-1").tabs[0].notice, undefined);
});

test("a page's confirm waits in the panel until answered; alerts never block", async () => {
  const t = setup();
  await t.call("browserNavigate", "code-1", "https://example.com/");
  const dbg = t.views[0].webContents.debugger;
  dbg.event("Page.javascriptDialogOpening", {
    type: "alert",
    message: "hi",
    url: "https://example.com/",
  });
  await wait(10);
  assert.ok(
    dbg.sent.some(
      (c) =>
        c.method === "Page.handleJavaScriptDialog" && c.params.accept === true,
    ),
  );
  assert.equal(t.host.state("code-1").tabs[0].dialog, undefined);
  dbg.event("Page.javascriptDialogOpening", {
    type: "prompt",
    message: "Name?",
    url: "https://example.com/",
    defaultPrompt: "x",
  });
  const tab = t.host.state("code-1").tabs[0];
  assert.deepEqual(tab.dialog, {
    type: "prompt",
    message: "Name?",
    origin: "https://example.com",
    defaultValue: "x",
  });
  await t.call("browserAnswerDialog", "code-1", tab.id, true, "Ada");
  assert.deepEqual(dbg.sent.at(-1), {
    method: "Page.handleJavaScriptDialog",
    params: { accept: true, promptText: "Ada" },
  });
  assert.equal(t.host.state("code-1").tabs[0].dialog, undefined);
  await assert.rejects(
    t.call("browserAnswerDialog", "code-1", tab.id, false),
    /isn't asking/,
  );
});

test("Select element returns the element the person clicked, or null when cancelled", async () => {
  const t = setup();
  await assert.rejects(t.call("browserPickElement", "code-1"), /Open a page/);
  await t.call("browserNavigate", "code-1", "https://example.com/");
  const dbg = t.views[0].webContents.debugger;
  dbg.answers["Overlay.setInspectMode"] = (params) => {
    if (params.mode === "searchForNode")
      setTimeout(
        () => dbg.event("Overlay.inspectNodeRequested", { backendNodeId: 77 }),
        5,
      );
    return {};
  };
  dbg.answers["DOM.resolveNode"] = () => ({ object: { objectId: "obj-77" } });
  dbg.answers["Runtime.callFunctionOn"] = () => ({
    result: {
      value: {
        selector: "main > button",
        tag: "button",
        text: "Sign in",
        outerHTML: "<button>Sign in</button>",
        styles: { color: "rgb(0, 0, 0)" },
        box: { x: 10, y: 20, width: 0, height: 0 },
      },
    },
  });
  const picked = await t.call("browserPickElement", "code-1");
  assert.deepEqual(picked, {
    selector: "main > button",
    tag: "button",
    text: "Sign in",
    outerHTML: "<button>Sign in</button>",
    styles: { color: "rgb(0, 0, 0)" },
    box: { x: 10, y: 20, width: 0, height: 0 },
    url: "https://example.com/",
  });
  assert.equal(t.host.state("code-1").picking, false);
  assert.deepEqual(
    dbg.sent
      .filter((c) => c.method === "Overlay.setInspectMode")
      .map((c) => c.params.mode),
    ["searchForNode", "none"],
  );
  dbg.answers["Overlay.setInspectMode"] = () => ({});
  const pending = t.call("browserPickElement", "code-1");
  await wait(10);
  assert.equal(t.host.state("code-1").picking, true);
  await t.call("browserCancelPick", "code-1");
  assert.equal(await pending, null);
  assert.equal(t.host.state("code-1").picking, false);
});

test("screenshots, Open HTML file… and Open in browser", async () => {
  const t = setup();
  await assert.rejects(
    t.call("browserSaveScreenshot", "code-1"),
    /Open a page/,
  );
  assert.equal(await t.call("browserCapture", "code-1"), null);
  await assert.rejects(
    t.call("browserOpenExternally", "code-1"),
    /Open a page first/,
  );
  await t.call("browserNavigate", "code-1", "localhost:5173/app");
  assert.deepEqual(await t.call("browserCapture", "code-1"), {
    pngBase64: Buffer.from("png-bytes").toString("base64"),
  });
  assert.equal(await t.call("browserSaveScreenshot", "code-1"), true);
  assert.deepEqual(t.saved, [
    { name: "localhost 5173 screenshot.png", png: "png-bytes" },
  ]);
  await t.call("browserOpenExternally", "code-1");
  assert.deepEqual(t.opened, ["http://localhost:5173/app"]);
  t.chooseFile(undefined);
  assert.equal(await t.call("browserOpenHtmlFile", "code-1"), false);
  t.chooseFile("/Users/me/site/notes.txt");
  await assert.rejects(t.call("browserOpenHtmlFile", "code-1"), /HTML file/);
  t.chooseFile("/Users/me/site/index.html");
  assert.equal(await t.call("browserOpenHtmlFile", "code-1"), true);
  assert.equal(
    t.host.state("code-1").tabs[0].url,
    "file:///Users/me/site/index.html",
  );
  // Files beside it may now be typed; others still may not.
  assert.equal(
    (await t.call("browserNavigate", "code-1", "file:///Users/me/site/b.html"))
      .ok,
    true,
  );
  assert.equal(
    (await t.call("browserNavigate", "code-1", "file:///Users/me/other.html"))
      .ok,
    false,
  );
  await assert.rejects(
    t.call("browserOpenExternally", "code-1"),
    /Only web pages/,
  );
  assert.equal(await t.call("browserDefaultBrowserName"), "Google Chrome");
  assert.equal(screenshotName("not a url"), "Page screenshot.png");
});

test("model preview reads filter console origins, clear logs and discard navigated captures", async () => {
  const t = setup();
  await t.call("browserNavigate", "code-1", "http://localhost:5173/app");
  const page = t.host.driver("code-1");
  page.driver.console.push({
    level: "error",
    text: "kept",
    time: 1,
    source: "javascript",
    url: "http://localhost:5173/script.js",
  });
  page.driver.console.push({
    level: "error",
    text: "foreign",
    time: 2,
    url: "https://elsewhere.test/script.js",
  });
  page.driver.console.push({ level: "log", text: "info", time: 3 });
  assert.deepEqual(
    await t.call("browserConsoleLogs", "code-1", {
      onlyErrors: true,
      clear: true,
    }),
    [{ level: "error", text: "kept", timestamp: 1, source: "javascript" }],
  );
  assert.equal(page.driver.console.values().length, 0);
  page.driver.snapshot = async () => "snapshot";
  assert.equal(await t.call("browserSnapshot", "code-1"), "snapshot");
  page.driver.inspectElement = async () => ({
    tagName: "button",
    text: "Save",
    className: "",
    id: "save",
    styles: { color: "red" },
    value: undefined,
    boundingBox: undefined,
    reactComponent: "SaveButton",
    reactProps: { label: "Save" },
  });
  assert.equal(
    (await t.call("browserInspect", "code-1", "#save")).info.tagName,
    "button",
  );
  assert.equal(
    (await t.call("browserInspect", "code-1", "#save")).info.reactComponent,
    "SaveButton",
  );
  page.driver.screenshot = async () => {
    page.driver.revision++;
    return {
      base64: "cG5n",
      mimeType: "image/png",
      width: 1,
      height: 1,
      scale: 1,
    };
  };
  assert.equal(await t.call("browserModelScreenshot", "code-1"), null);
  await assert.rejects(t.call("browserConsoleLogs", "chat-1", {}));
});

test("Open in browser respects the administrator's external link setting", async () => {
  const t = setup({ externalLinks: false });
  await t.call("browserNavigate", "code-1", "https://example.com/");
  await assert.rejects(
    t.call("browserOpenExternally", "code-1"),
    /turned off external links/,
  );
  assert.deepEqual(t.opened, []);
});

test("dev server calls are refused until dev servers are connected, then passed through", async () => {
  const t = setup();
  await assert.rejects(
    t.call("devServersDetect", "code-1"),
    /aren't available/,
  );
  await assert.rejects(
    t.call("devServersStart", "code-1", "web"),
    /aren't available/,
  );
  const calls: string[] = [];
  const port: DevServersPort = {
    list: () => [
      {
        name: "web",
        command: "npm run dev",
        port: 5173,
        status: "stopped",
        source: "launch.json",
      },
    ],
    launchConfig: () => ({}),
    detect: async (id) => (calls.push(`detect ${id}`), []),
    save: async (id, config) => void calls.push(`save ${id} ${config.name}`),
    start: async (id, name) => (
      calls.push(`start ${id} ${name}`),
      {
        name,
        command: "npm run dev",
        status: "starting",
        source: "launch.json",
      }
    ),
    stop: async (id, name) => void calls.push(`stop ${id} ${name}`),
    logs: async (id, name, lines) => (
      calls.push(`logs ${id} ${name} ${lines}`),
      ["ready"]
    ),
    onChange: () => () => {},
    dispose: () => {},
  };
  t.service.attachDevServers(port);
  const state = await t.call("browserState", "code-1");
  assert.equal(state.devServersAvailable, true);
  assert.equal(state.devServers[0].name, "web");
  await t.call("devServersDetect", "code-1");
  await t.call("devServersSave", "code-1", {
    name: "web",
    runtimeExecutable: "npm",
    runtimeArgs: ["run", "dev"],
    port: 5173,
  });
  await assert.rejects(
    t.call("devServersSave", "code-1", {
      name: "web",
      runtimeExecutable: "npm",
      shell: true,
    }),
  );
  await assert.rejects(
    t.call("devServersSave", "code-1", { name: "", runtimeExecutable: "npm" }),
  );
  assert.equal(
    (await t.call("devServersStart", "code-1", "web")).status,
    "starting",
  );
  await t.call("devServersStop", "code-1", "web");
  assert.deepEqual(await t.call("devServersLogs", "code-1", "web", 50), [
    "ready",
  ]);
  await assert.rejects(t.call("devServersLogs", "code-1", "web", 99999));
  await assert.rejects(
    t.call("devServersStart", "chat-1", "web"),
    /only in Code/,
  );
  assert.deepEqual(calls, [
    "detect code-1",
    "save code-1 web",
    "start code-1 web",
    "stop code-1 web",
    "logs code-1 web 50",
  ]);
});

test("closing a conversation's browser closes its pages; after dispose nothing opens", async () => {
  const t = setup();
  await t.call("browserNavigate", "code-1", "https://example.com/");
  await t.call("browserNewTab", "code-1", "https://example.org/");
  t.host.close("code-1");
  assert.ok(t.views.every((view) => view.webContents.destroyed));
  assert.equal(t.host.has("code-1"), false);
  t.host.dispose();
  await assert.rejects(t.call("browserState", "code-1"), /closed/);
});

test("View ▸ Reload finds the Browser page that has the focus while it is shown", async () => {
  const t = setup();
  await t.call("browserOpen", "code-1");
  await t.call("browserNavigate", "code-1", "https://example.com/");
  const contents = t.views[0].webContents as unknown as {
    isFocused?: () => boolean;
  };
  assert.equal(t.host.focusedConversation(), undefined);
  contents.isFocused = () => true;
  assert.equal(t.host.focusedConversation(), "code-1");
  await t.call("browserHide", "code-1");
  assert.equal(t.host.focusedConversation(), undefined);
});
