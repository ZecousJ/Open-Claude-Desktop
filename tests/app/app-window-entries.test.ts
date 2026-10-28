/**
 * R2-D: the ways into and out of separate conversation windows — Window ▸
 * Show Main Window, notifications that open their conversation where it is
 * shown, and the sidebar's Open in new window. Electron is replaced by a
 * fake module and stylesheets by empty modules.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import type { Conversation, Settings } from "../../shared/types";
import type { WindowHandoff } from "../../shared/windows-api";

/** Notifications the fake Electron module showed, with their click handlers. */
const shown: { title: string; body?: string; click?: () => void }[] = [];
(globalThis as any).__fakeElectron = {
  app: {
    name: "Claudex",
    getPath: () => tmpdir(),
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    off: () => {},
    dock: { bounce: () => {}, setMenu: () => {} },
  },
  // Help ▸ Troubleshooting (electron/troubleshooting.ts) imports these.
  clipboard: { writeText: () => {} },
  net: { isOnline: () => true },
  netLog: { currentlyLogging: false },
  // electron/updates/launch.ts imports the native updater.
  autoUpdater: { on: () => {}, setFeedURL: () => {} },
  session: { defaultSession: {} },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  globalShortcut: { register: () => true, unregister: () => {} },
  Menu: {
    buildFromTemplate: (items: unknown[]) => items,
    setApplicationMenu: () => {},
  },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
  // The app menu asks for the focused page (Developer ▸ Inspect Element).
  webContents: {
    getFocusedWebContents: () => null,
    getAllWebContents: () => [],
  },
  Notification: class {
    static isSupported = () => true;
    record: { title: string; body?: string; click?: () => void };
    constructor(options: { title: string; body?: string }) {
      this.record = { title: options.title, body: options.body };
    }
    on(name: string, cb: () => void) {
      if (name === "click") this.record.click = cb;
    }
    show() {
      shown.push(this.record);
    }
  },
  powerMonitor: {
    on: () => {},
    off: () => {},
    isOnBatteryPower: () => false,
    getSystemIdleTime: () => 0,
    getSystemIdleState: () => "active",
  },
  powerSaveBlocker: { start: () => 1, stop: () => {} },
  shell: { openExternal: async () => {} },
  Tray: class {},
  BrowserWindow: class {
    static getFocusedWindow() {
      return null;
    }
    static getAllWindows() {
      return [];
    }
  },
};
const electronNames = Object.keys((globalThis as any).__fakeElectron);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron")
      return {
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "const e = globalThis.__fakeElectron;" +
              electronNames
                .map((name) => `export const ${name} = e.${name};`)
                .join("") +
              "export default e;",
          ),
        shortCircuit: true,
      };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith(".css"))
      return { format: "module", source: "", shortCircuit: true };
    return next(url, context);
  },
});
(globalThis as any).window ??= { desktop: {} };

const { appMenuTemplate } =
  await import("../../electron/app/app-menu-template");
const { appWindowTargets } = await import("../../electron/app/app-menu");
const { DesktopIntegration } =
  await import("../../electron/app/desktop-integration");
const { defaultSettings } = await import("../../electron/store/store");
const { openInWindow, openFromSidebar } =
  await import("../../src/app/AppSidebar");

type Item = {
  label?: string;
  role?: string;
  type?: string;
  submenu?: Item[];
  click?: () => void;
};
const windowMenu = (mac: boolean, showMainWindow = () => {}) => {
  const menu = appMenuTemplate({
    mac,
    appName: "Claudex",
    run: () => {},
    checkForUpdates: () => {},
    showMainWindow,
  }) as Item[];
  const window = menu.find((item) => item.role === "window");
  assert.ok(window?.submenu, "the menu bar has a Window menu");
  return window.submenu;
};
const names = (items: Item[]) =>
  items.map((item) => item.label ?? item.role ?? item.type);

test("Window lists Show Main Window above Bring All to Front on every platform", () => {
  let shows = 0;
  const mac = windowMenu(true, () => shows++);
  assert.deepEqual(names(mac), [
    "minimize",
    "zoom",
    "separator",
    "Show Main Window",
    "separator",
    "front",
  ]);
  mac.find((item) => item.label === "Show Main Window")?.click?.();
  assert.equal(shows, 1);
  // The 2.37337.1 template uses the same Window menu on every platform.
  assert.deepEqual(names(windowMenu(false)), names(mac));
});

/** A fake BrowserWindow that records what brought it forward. */
function fakeWindow() {
  const calls: string[] = [];
  return {
    calls,
    isMinimized: () => true,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  };
}

test("the main window comes forward and opens a named conversation", () => {
  const main = fakeWindow();
  const sent: unknown[] = [];
  const focused: string[] = [];
  const targets = appWindowTargets({
    appWindows: {
      main: () => main,
      send: (_win: unknown, event: unknown) => sent.push(event),
    },
    services: {
      chatWindows: {
        focusConversation: (id: string) => {
          focused.push(id);
          return id === "popped";
        },
      },
    },
  } as any);
  assert.equal(targets.showMain(), true);
  assert.deepEqual(main.calls, ["restore", "show", "focus"]);
  assert.deepEqual(sent, [], "Show Main Window opens nothing");
  assert.equal(targets.showMain("c1"), true);
  assert.deepEqual(sent, [
    { type: "command", command: "open-conversation", conversationId: "c1" },
  ]);
  assert.equal(targets.focusConversation("popped"), true);
  assert.equal(targets.focusConversation("c1"), false);
  assert.deepEqual(focused, ["popped", "c1"]);

  const closed = appWindowTargets({
    appWindows: { main: () => undefined, send: () => {} },
    services: {},
  } as any);
  assert.equal(closed.showMain("c1"), false);
  assert.equal(
    closed.focusConversation("c1"),
    false,
    "no conversation windows before the first one opens",
  );
});

const conversation = (
  id: string,
  mode: Conversation["mode"],
  status: string,
): Conversation =>
  ({
    id,
    title: `Title ${id}`,
    mode,
    turns: [{ id: "t", status, items: [], prompt: "" }],
  }) as unknown as Conversation;

test("a notification opens its conversation where it is shown", () => {
  shown.length = 0;
  const settings: Settings = {
    ...defaultSettings,
    notifyResponses: true,
    notifyCode: true,
    notifySchedules: true,
  };
  let conversations: Conversation[] = [];
  const desktop = new DesktopIntegration({
    window: () => undefined,
    settings: () => settings,
    conversations: () => conversations,
    command: () => {},
    trayIcon: import.meta.filename,
  });
  const actions: string[] = [];
  desktop.start();
  desktop.connectWindows({
    focusConversation: (id) => {
      actions.push(`focus ${id}`);
      return id === "popped";
    },
    showMain: (id) => {
      actions.push(`main ${id ?? "-"}`);
      return true;
    },
  });
  for (const id of ["popped", "c1"]) {
    conversations = [conversation(id, "chat", "inProgress")];
    desktop.observeConversation(conversation(id, "chat", "inProgress"));
    desktop.observeConversation(conversation(id, "chat", "completed"));
  }
  conversations = [conversation("code1", "code", "inProgress")];
  desktop.observeApproval({
    id: 1,
    conversationId: "code1",
    method: "item/commandExecution/requestApproval",
    params: {},
  });
  // A Code permission is titled with its folder, else the product.
  assert.deepEqual(
    shown.map((n) => n.title),
    ["Title popped", "Title c1", "Claudex Code"],
  );
  for (const notification of shown) notification.click?.();
  assert.deepEqual(actions, [
    "focus popped",
    "focus c1",
    "main c1",
    "focus code1",
    "main code1",
  ]);
  desktop.stop();
});

const attachment = { id: "a1", name: "a.txt", path: "/a", kind: "text" };
function opener(page = "chat", activeId = "c1") {
  const events: string[] = [];
  return {
    events,
    app: {
      page,
      activeId,
      text: "draft",
      attachments: [attachment],
      providerId: "p",
      model: "m",
      newChat: (mode?: string) => events.push(`new ${mode}`),
      openConversation: (c: Conversation) => events.push(`open ${c.id}`),
    } as any,
  };
}

test("Open in new window takes the shown conversation's draft and starts a new chat", async () => {
  const opened: [string, WindowHandoff | undefined][] = [];
  const desktop = {
    openConversationWindow: async (id: string, handoff?: WindowHandoff) => {
      opened.push([id, handoff]);
    },
  };
  const shownHere = opener();
  await openInWindow(
    shownHere.app,
    conversation("c1", "code", "completed"),
    desktop,
  );
  assert.deepEqual(opened, [
    [
      "c1",
      { text: "draft", attachmentIds: ["a1"], providerId: "p", model: "m" },
    ],
  ]);
  assert.deepEqual(shownHere.events, ["new code"]);

  opened.length = 0;
  const elsewhere = opener("chat", "other");
  await openInWindow(
    elsewhere.app,
    conversation("c1", "chat", "completed"),
    desktop,
  );
  assert.deepEqual(opened, [["c1", undefined]]);
  assert.deepEqual(elsewhere.events, [], "the main window stays where it is");

  opened.length = 0;
  await openInWindow(
    opener().app,
    { ...conversation("c1", "chat", "completed"), incognito: true },
    desktop,
  );
  assert.deepEqual(opened, [], "incognito chats never get their own window");
});

test("a draft the window cannot take stays in the main window", async () => {
  const opened: (WindowHandoff | undefined)[] = [];
  const desktop = {
    openConversationWindow: async (_id: string, handoff?: WindowHandoff) => {
      opened.push(handoff);
      if (handoff) throw new Error("An attachment is no longer available.");
    },
  };
  const here = opener();
  await openInWindow(
    here.app,
    conversation("c1", "chat", "completed"),
    desktop,
  );
  assert.equal(opened.length, 2);
  assert.equal(opened[1], undefined);
  assert.deepEqual(here.events, [], "the draft and the conversation stay");
});

test("a sidebar click on a conversation with its own window focuses that window", async () => {
  const focused: string[] = [];
  const desktop = {
    conversationWindows: async () => ["popped"],
    openConversationWindow: async (id: string) => {
      focused.push(id);
    },
  };
  const here = opener();
  await openFromSidebar(
    here.app,
    conversation("popped", "chat", "completed"),
    desktop,
  );
  await openFromSidebar(
    here.app,
    conversation("c2", "chat", "completed"),
    desktop,
  );
  assert.deepEqual(focused, ["popped"]);
  assert.deepEqual(here.events, ["open c2"]);
  const failing = {
    conversationWindows: async () => {
      throw new Error("bridge unavailable");
    },
    openConversationWindow: async () => {},
  };
  await openFromSidebar(
    here.app,
    conversation("c3", "chat", "completed"),
    failing,
  );
  // A bridge that throws before returning a promise still opens it here.
  const throwing = {
    conversationWindows: (): Promise<string[]> => {
      throw new TypeError("not a function");
    },
    openConversationWindow: async () => {},
  };
  await openFromSidebar(
    here.app,
    conversation("c4", "chat", "completed"),
    throwing,
  );
  assert.deepEqual(here.events, ["open c2", "open c3", "open c4"]);
});

test("the app menu builds while signed out (no store): startup must not fail", async () => {
  // 0.0.31 read the menu's language from ctx.store.settings while nobody was
  // signed in and quit with "Claudex couldn't start".
  const { connectAppMenu, installAppMenu, rebuildAppMenu } =
    (await import("../../electron/app/app-menu")) as any;
  const signedOut = {
    store: undefined,
    window: undefined,
    policy: () => ({}),
    integration: { connectWindows: () => {}, observeViewing: () => {} },
    appWindows: { main: () => undefined, all: () => [] },
    onWindowFocus: () => () => {},
    onEvent: () => () => {},
  };
  assert.doesNotThrow(() => connectAppMenu(signedOut));
  assert.doesNotThrow(() => installAppMenu(() => {}));
  if (typeof rebuildAppMenu === "function")
    assert.doesNotThrow(() => rebuildAppMenu());
});
