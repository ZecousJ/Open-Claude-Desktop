import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { app, BaseWindow, BrowserWindow, WebContentsView } from "electron";
import type { AppContext } from "../../electron/app/app-context";
import { previewLinkRouter } from "../../electron/artifacts/preview-link-routing";
import type { BrowserService } from "../../electron/browser";
import {
  BrowserHost,
  type HostView,
} from "../../electron/browser/browser-host";
import { registerPanelHandlers } from "../../electron/ipc/panels";
import type { NativeHost } from "../../electron/official-ui/native/host";
import { registerLaunch } from "../../electron/official-ui/native/launch";
import { openPolicy } from "../../shared/client-policy";
import type { AppEvent, Conversation } from "../../shared/types";

const root = process.env.CLAUDEX_BROWSER_FIXTURE_DIR;
if (!root || fs.readdirSync(root).length)
  throw Error("Use a new empty fixture directory.");
app.setName("Claudex Browser Test");
app.setPath("userData", path.join(root, "electron-profile"));
app.commandLine.appendSwitch(
  "host-resolver-rules",
  "MAP preview.example 127.0.0.1",
);
app.commandLine.appendSwitch("no-proxy-server");
app.dock?.hide();

async function until(check: () => boolean, expected: string) {
  const deadline = Date.now() + 8_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for " + expected);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function run(cwd: string) {
  let port = 0;
  let slowRequest: http.ServerResponse | undefined;
  const server = http.createServer((request, response) => {
    if (request.url === "/slow") {
      slowRequest = response;
      return;
    }
    response.setHeader("Content-Type", "text/html");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.end(`<meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Fixture ${url.pathname}</title>
      <a href="http://preview.example:${port}/routed?session=private#token">Routed link</a>
      <button id="pick" class="fixture-button" data-testid="pick-button">Pick this</button>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  port = address.port;
  const origin = "http://127.0.0.1:" + port;
  const publicOrigin = "http://preview.example:" + port;
  const window = new BrowserWindow({ show: false, width: 700, height: 600 });
  const secondWindow = new BrowserWindow({
    show: false,
    width: 700,
    height: 600,
  });
  const parking = new BaseWindow({ show: false });
  const windows = [window, secondWindow];
  const c: Conversation = {
    id: "browser-fixture",
    title: "Browser fixture",
    mode: "code",
    cwd,
    providerId: "fixture",
    model: "fixture",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
  };
  const events = new Set<(event: AppEvent) => void>();
  const push = (event: AppEvent) =>
    events.forEach((listener) => listener(event));
  const browser = new BrowserHost({
    platform: {
      createView: (partition) =>
        new WebContentsView({
          webPreferences: { partition, sandbox: true, nodeIntegration: false },
        }) as unknown as HostView,
      parking: () =>
        parking as unknown as ReturnType<
          BrowserHost["deps"]["platform"]["parking"]
        >,
    },
    partition: () => "f104-browser-test",
    blockedDomains: () => [],
    toolsAvailable: () => true,
    previewEvent: (owner, conversationId, previewId, event, ...args) =>
      push({
        type: "official-preview-event",
        windowId: (owner as unknown as BrowserWindow).id,
        conversationId,
        previewId,
        event,
        args,
      }),
    push: (state) => push({ type: "browser", state }),
  });
  const service: BrowserService = {
    host: browser,
    toolsAvailable: () => true,
    policy: () => ({}),
    blockedDomains: () => [],
    keepCookies: () => "until-quit",
    openUrl: () => {
      throw Error("Open pages through Launch.");
    },
    attachDevServers: () => {
      throw Error("Use the loopback fixture server.");
    },
    devServers: () => undefined,
    clearBrowsingData: async () => false,
    clearPreviewData: async () => {},
    defaultBrowserName: () => null,
  };
  const ipc = new Map<string, (...args: unknown[]) => unknown>();
  const launch = new Map<string, (...args: unknown[]) => unknown>();
  const sent: { windowId: number; event: string; args: unknown[] }[] = [];
  const opened: string[] = [];
  const caller = new AsyncLocalStorage<BrowserWindow>();
  const ctx = {
    account: () => ({ id: "fixture" }),
    sessionIdentity: () => 1,
    localLoadConversation: async (id: string) => (id === c.id ? c : undefined),
    localListConversations: async () => [c],
    localCall: (method: string, ...args: unknown[]) => {
      const handler = ipc.get(method);
      assert.ok(handler, method);
      return handler(...args);
    },
    onEvent: (listener: (event: AppEvent) => void) => {
      events.add(listener);
      return () => {
        events.delete(listener);
      };
    },
    push,
    store: { conversations: [c], settings: {} },
    callerWindow: () => caller.getStore(),
    withCallerWindow: (owner: BrowserWindow, operation: () => unknown) =>
      caller.run(owner, operation),
    onAccountDeactivating: () => () => {},
    policy: () => openPolicy,
    log() {},
  };
  const appContext = ctx as unknown as AppContext;
  const router = previewLinkRouter(appContext);
  ipc.set("setRoutedLinkConfirmReady", (ready) =>
    router.setReady(caller.getStore()!.webContents.id, ready === true),
  );
  ipc.set("resolveRoutedLinkConfirm", (id, allow) =>
    router.resolve(
      caller.getStore()!.webContents.id,
      String(id),
      allow === true,
    ),
  );
  registerPanelHandlers(
    (name, handler) => {
      ipc.set(name, handler);
    },
    appContext,
    async () => ({
      service: () => service,
      saveImage: async () => false,
      chooseHtmlFile: async () => undefined,
      saveFile: async () => false,
      openExternal: async (url) => {
        opened.push(url);
      },
    }),
  );
  const offLaunch = registerLaunch({
    ctx,
    window,
    get caller() {
      return caller.getStore();
    },
    windowForId: (id: number) => windows.find((owner) => owner.id === id),
    on: (name: string, handler: (...args: unknown[]) => unknown) =>
      launch.set(name, handler),
    store: () => ({ get: () => [], set() {} }),
    emit() {},
    emitTo: (
      owner: BrowserWindow,
      _domain: string,
      event: string,
      ...args: unknown[]
    ) => sent.push({ windowId: owner.id, event, args }),
  } as unknown as NativeHost);
  const callFrom = <T>(
    owner: BrowserWindow,
    name: string,
    ...args: unknown[]
  ) => {
    const handler = launch.get("Launch." + name);
    assert.ok(handler, name);
    return caller.run(
      owner,
      () => Promise.resolve(handler(...args)) as Promise<T>,
    );
  };
  const call = <T>(name: string, ...args: unknown[]) =>
    callFrom<T>(window, name, ...args);
  const tab = (id: string) =>
    browser.sessions.get(c.id)?.tabs.find((item) => item.id === id);
  const contents = (id: string) => {
    const page = tab(id)?.view?.webContents;
    assert.ok(page);
    return page as unknown as Electron.WebContents;
  };
  const title = (id: string, expected: string) =>
    until(() => {
      const state = tab(id)?.state;
      assert.equal(state?.error, undefined);
      return state?.title === expected && state.loading === false;
    }, expected);
  const viewport = (id: string) =>
    contents(id).executeJavaScript("[innerWidth, innerHeight]");
  const bounds = { x: 0, y: 0, width: 520, height: 450, radius: 8 };
  try {
    const id = await call<string>("startBrowserPreview", cwd, "local_" + c.id);
    type PreviewTabs = {
      activeTabId: string;
      tabs: { tabId: string; origin: string; emulatedViewport: unknown }[];
    };
    const readTabs = () => call<PreviewTabs>("getPreviewTabs", id);
    const { activeTabId: first } = await readTabs();
    assert.equal(
      await call("navigatePreview", id, origin + "/first", first),
      true,
    );
    await title(first, "Fixture /first");
    const second = await call<string>("openPreviewTab", id, cwd);
    assert.equal(
      await call("navigatePreview", id, origin + "/second?keep=1#keep", second),
      true,
    );
    await title(second, "Fixture /second");

    window.showInactive();
    assert.equal(
      await call("showPreview", id, bounds, "first-pane", String(window.id)),
      true,
    );
    assert.ok(
      window.contentView.children.includes(
        tab(second)!.view as unknown as WebContentsView,
      ),
    );
    assert.equal(await call("showPreview", id, bounds, "stale-pane"), false);
    assert.equal(await call("hidePreview", id, "stale-pane"), false);
    assert.equal(
      await callFrom(secondWindow, "hidePreview", id, "first-pane"),
      false,
    );
    assert.equal(
      await call(
        "showPreview",
        id,
        bounds,
        "first-pane",
        String(secondWindow.id),
      ),
      false,
    );
    assert.ok(
      window.contentView.children.includes(
        tab(second)!.view as unknown as WebContentsView,
      ),
    );
    assert.deepEqual(await viewport(second), [520, 450]);
    assert.equal(await call("setPreviewViewport", id, 390, 844, first), true);
    assert.deepEqual(await viewport(first), [390, 844]);
    assert.deepEqual(await viewport(second), [520, 450]);
    assert.equal(await call("setActivePreviewTab", id, first), true);
    const firstView = tab(first)!.view as unknown as WebContentsView;
    assert.ok(window.contentView.children.includes(firstView));
    assert.deepEqual(firstView.getBounds(), {
      x: 156,
      y: 0,
      width: 208,
      height: 450,
    });
    assert.equal(await call("setActivePreviewTab", id, second), true);
    assert.deepEqual(
      (await readTabs()).tabs.map(({ tabId, origin, emulatedViewport }) => ({
        tabId,
        origin,
        emulatedViewport,
      })),
      [
        {
          tabId: first,
          origin,
          emulatedViewport: { width: 390, height: 844, setBy: "user" },
        },
        { tabId: second, origin, emulatedViewport: null },
      ],
    );
    assert.equal(await call("clearPreviewViewport", id, first), true);
    assert.deepEqual(await viewport(first), [520, 450]);
    await Promise.all([
      call("setPreviewViewport", id, 375, 812, first),
      call("clearPreviewViewport", id, first),
      call("setPreviewViewport", id, 768, 1024, first),
    ]);
    assert.deepEqual(await viewport(first), [768, 1024]);
    assert.deepEqual(await viewport(second), [520, 450]);
    assert.equal(await call("setPreviewColorScheme", id, "dark", first), true);
    assert.equal(
      await contents(first).executeJavaScript(
        "matchMedia('(prefers-color-scheme: dark)').matches",
      ),
      true,
    );
    assert.equal(await call("clearPreviewViewport", id, first), true);

    assert.equal(await call("openPreviewInBrowser", id, second), true);
    assert.deepEqual(opened, [origin + "/second?keep=1#keep"]);
    const publicTab = await call<string>(
      "openExternalLinkInPreview",
      id,
      cwd,
      publicOrigin + "/outside?session=private#token",
    );
    await title(publicTab, "Fixture /outside");
    assert.equal(await call("openPreviewInBrowser", id, publicTab), true);
    assert.deepEqual(opened.at(-1), publicOrigin + "/outside");
    assert.equal(
      await call("openExternalLinkInPreview", id, cwd, origin + "/no-config"),
      null,
    );
    assert.equal(
      await call("openClickedLinkInPreview", {
        previewId: id,
        cwd,
        url: origin + "/clicked",
        clickedIn: "transcript",
      }),
      first,
    );
    await title(first, "Fixture /clicked");
    assert.equal(await call("setActivePreviewTab", id, second), true);

    assert.equal(
      await call("toggleSelectionMode", id, true, second, true),
      true,
    );
    await call("toggleSelectionMode", id, false, second);
    await until(
      () => sent.some((event) => event.event === "selectionModeEnded"),
      "cancelled element selection",
    );
    assert.equal(
      await call("toggleSelectionMode", id, true, second, true),
      true,
    );
    await until(
      () => tab(second)?.driver?.picking === true,
      "native inspector",
    );
    const page = contents(second);
    const point = await page.executeJavaScript(`(() => {
      const rect = document.querySelector('#pick').getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    window.focus();
    page.focus();
    page.sendInputEvent({ type: "mouseMove", ...point });
    page.sendInputEvent({
      type: "mouseDown",
      button: "left",
      clickCount: 1,
      ...point,
    });
    page.sendInputEvent({
      type: "mouseUp",
      button: "left",
      clickCount: 1,
      ...point,
    });
    await until(
      () => sent.some((event) => event.event === "elementSelected"),
      "selected element",
    );
    const selection = sent.find((event) => event.event === "elementSelected")!;
    assert.equal(selection.windowId, window.id);
    const [previewId, context] = selection.args as [
      string,
      {
        tagName: string;
        id: string;
        classes: string[];
        attributes: Record<string, string>;
        innerText: string;
        screenshot: string;
      },
    ];
    assert.equal(previewId, id);
    assert.equal(context.tagName, "button");
    assert.equal(context.id, "pick");
    assert.deepEqual(context.classes, ["fixture-button"]);
    assert.deepEqual(context.attributes, { "data-testid": "pick-button" });
    assert.equal(context.innerText, "Pick this");
    assert.equal(
      Buffer.from(context.screenshot, "base64").subarray(1, 4).toString(),
      "PNG",
    );

    await call("setPreviewLinkRouting", id, true);
    await contents(second).executeJavaScript(
      "document.querySelector('a').click()",
    );
    await until(
      () =>
        sent.some((event) => event.event === "previewExternalLinkRequested"),
      "routed link request",
    );
    const link = sent.find(
      (event) => event.event === "previewExternalLinkRequested",
    );
    assert.deepEqual(link, {
      windowId: window.id,
      event: "previewExternalLinkRequested",
      args: [id, publicOrigin + "/routed?session=private#token"],
    });
    assert.match(contents(second).getURL(), /\/second\?keep=1#keep$/);
    await call("setRoutedLinkConfirmReady", true);
    const route = call("openRoutedLinkExternally", id, link.args[1]);
    await until(
      () => sent.some((event) => event.event === "routedLinkConfirmRequested"),
      "renderer confirmation",
    );
    const confirm = sent.find(
      (event) => event.event === "routedLinkConfirmRequested",
    )!;
    assert.equal(confirm.windowId, window.id);
    assert.deepEqual(confirm.args.slice(1), [id, publicOrigin + "/routed"]);
    await callFrom(
      secondWindow,
      "resolveRoutedLinkConfirm",
      confirm.args[0],
      true,
    );
    assert.equal(opened.length, 2);
    await call("resolveRoutedLinkConfirm", confirm.args[0], true);
    assert.equal(await route, true);
    assert.equal(opened.at(-1), publicOrigin + "/routed");

    await call("navigatePreview", id, origin + "/slow", second);
    await until(() => !!slowRequest, "slow request");
    await call("navigatePreview", id, origin + "/fast", second);
    slowRequest?.end("<title>Late response</title>");
    await title(second, "Fixture /fast");
    assert.equal(await call("getPreviewUrl", id), origin + "/fast");
    assert.equal(await call("goBack", id, second), true);
    await title(second, "Fixture /second");
    assert.equal(await call("goForward", id, second), true);
    await title(second, "Fixture /fast");
    assert.equal(await call("refreshPreview", id, first), true);
    assert.equal(
      await call("navigatePreview", id, "javascript:alert(1)", second),
      false,
    );

    const frame = await call<string>("capturePreviewTabIfChanged", {
      serverId: id,
      tabId: first,
      origin,
      force: true,
    });
    assert.equal(Buffer.from(frame, "base64").subarray(1, 4).toString(), "PNG");
    assert.equal(
      await call("capturePreviewTabIfChanged", {
        serverId: id,
        tabId: first,
        origin: publicOrigin,
      }),
      "",
    );
    assert.equal(await call("reorderPreviewTab", id, publicTab, 0), true);
    assert.equal((await readTabs()).tabs[0].tabId, publicTab);
    assert.equal(await call("closePreviewTab", id, first, true), true);
    assert.equal(await call("goBack", id, first), false);
    const reopened = await call<string>("reopenClosedPreviewTab", id);
    await title(reopened, "Fixture /clicked");
    assert.equal(await call("reopenClosedPreviewTab", id), null);
    assert.equal(await call("closeAllPreviewTabs", id), true);
    assert.deepEqual(
      (await readTabs()).tabs.map((item) => item.tabId),
      [publicTab],
    );
    for (let i = 0; i < 8; i++)
      assert.ok(await call("openPreviewTab", id, cwd));
    assert.equal(await call("openPreviewTab", id, cwd), null);
    assert.equal((await readTabs()).tabs.length, 9);
    assert.equal(await call("closeAllPreviewTabs", id), true);
    assert.equal(await call("hidePreview", id, "first-pane"), true);
    assert.equal(
      await callFrom(secondWindow, "showPreview", id, bounds, "new-pane"),
      true,
    );
    assert.equal(await call("hidePreview", id, "first-pane"), false);
    const finalPage = contents(publicTab);
    assert.equal(await call("closePreviewTab", id, publicTab, false), false);
    assert.equal(
      await callFrom(secondWindow, "closePreviewTab", id, publicTab, false),
      true,
    );
    await until(() => finalPage.isDestroyed(), "final preview destroyed");
    assert.deepEqual(await readTabs(), { tabs: [], activeTabId: "seed" });
    assert.equal(await call("startBrowserPreview", cwd, "local_" + c.id), id);
    const reopenedPane = await readTabs();
    assert.equal(reopenedPane.tabs.length, 1);
    assert.notEqual(reopenedPane.activeTabId, publicTab);
    assert.equal(await call("getPreviewUrl", id), null);
  } finally {
    offLaunch();
    router.dispose();
    browser.dispose();
    for (const owner of windows) owner.destroy();
    parking.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

app
  .whenReady()
  .then(() => run(root))
  .then(
    () => {
      console.log(
        "Browser tabs, viewport, routing, capture, navigation and pane ownership passed.",
      );
      app.exit(0);
    },
    (error) => {
      console.error(error);
      app.exit(1);
    },
  );
