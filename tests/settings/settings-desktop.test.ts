/**
 * Desktop and developer Settings pages: the switches' effect in the main
 * process (tray, login item, keep awake, Quick access), MCP configuration hot
 * reload and server states, skill uploads, storage, and the pages themselves.
 * Electron is replaced by a fake module and page stylesheets by empty modules,
 * so the real code runs under node:test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation, Settings } from "../../shared/types";
import { preference } from "../../shared/settings-extras";
import { readSource } from "../support/read-source";

/** What the fake Electron module records. */
const fake = {
  trays: [] as {
    destroyed: boolean;
    menu?: unknown[];
    handlers: Record<string, () => void>;
  }[],
  blockers: new Set<number>(),
  nextBlocker: 1,
  onBattery: false,
  shortcuts: new Map<string, () => void>(),
  /** Accelerators another app holds. */
  taken: new Set<string>(),
  openAtLogin: false,
  cacheCleared: 0,
  /** The answer the system's question gets (1: Clear and restart). */
  answer: 0,
  questions: [] as { message: string; buttons: string[] }[],
  relaunched: 0,
  quit: 0,
  opened: [] as string[],
};
(globalThis as any).__fakeElectron = {
  app: {
    name: "Claudex",
    on: () => {},
    off: () => {},
    dock: { bounce: () => {}, setMenu: () => {} },
    getLoginItemSettings: () => ({ openAtLogin: fake.openAtLogin }),
    setLoginItemSettings: (value: { openAtLogin: boolean }) => {
      fake.openAtLogin = value.openAtLogin;
    },
    relaunch: () => {
      fake.relaunched++;
    },
    quit: () => {
      fake.quit++;
    },
  },
  globalShortcut: {
    register: (accelerator: string, callback: () => void) => {
      if (fake.taken.has(accelerator)) return false;
      fake.shortcuts.set(accelerator, callback);
      return true;
    },
    unregister: (accelerator: string) => fake.shortcuts.delete(accelerator),
  },
  Menu: { buildFromTemplate: (items: unknown[]) => items },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
  Notification: class {
    static isSupported = () => false;
  },
  powerMonitor: {
    on: () => {},
    off: () => {},
    getSystemIdleTime: () => 0,
    getSystemIdleState: () => "active",
    isOnBatteryPower: () => fake.onBattery,
  },
  powerSaveBlocker: {
    start: () => {
      const id = fake.nextBlocker++;
      fake.blockers.add(id);
      return id;
    },
    stop: (id: number) => fake.blockers.delete(id),
  },
  Tray: class {
    record = { destroyed: false, handlers: {} } as {
      destroyed: boolean;
      menu?: unknown[];
      handlers: Record<string, () => void>;
    };
    constructor() {
      fake.trays.push(this.record);
    }
    setToolTip() {}
    on(name: string, callback: () => void) {
      this.record.handlers[name] = callback;
    }
    setContextMenu(menu: unknown[]) {
      this.record.menu = menu;
    }
    popUpContextMenu(menu: unknown[]) {
      this.record.menu = menu;
    }
    destroy() {
      this.record.destroyed = true;
    }
  },
  session: {
    defaultSession: {
      getCacheSize: async () => (fake.cacheCleared ? 0 : 2048),
      clearCache: async () => {
        fake.cacheCleared++;
      },
      clearCodeCaches: async () => {},
      clearStorageData: async () => {},
      clearHostResolverCache: async () => {},
      clearAuthCache: async () => {},
    },
  },
  shell: {
    openPath: async (target: string) => {
      fake.opened.push(target);
      return "";
    },
    showItemInFolder: () => {},
  },
  dialog: {
    showOpenDialog: async () => ({ filePaths: [] }),
    showMessageBox: async (
      first: unknown,
      second?: { message: string; buttons: string[] },
    ) => {
      const options = (second ?? first) as {
        message: string;
        buttons: string[];
      };
      fake.questions.push(options);
      return { response: fake.answer };
    },
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

const { DesktopIntegration } =
  await import("../../electron/app/desktop-integration");
const { trayMenuTemplate, dockMenuTemplate } =
  await import("../../electron/app/desktop-menus");
const { mainWindowTitle } = await import("../../electron/app/window-title");
const { wantsKeepAwake } =
  await import("../../electron/engine/attention-rules");
const { desktopPreferenceFields, shortcutChoices } =
  await import("../../electron/store/settings-preferences");
const { McpConfigFile, mcpServerStates, parseMcpConfig, mcpConfigText } =
  await import("../../electron/connectors/mcp-config-file");
const { checkSkillFolder } = await import("../../electron/skills/skill-folder");
const { storageUsage, diskUsage } =
  await import("../../electron/workspace/storage-usage");
const { registerSettingsDesktopHandlers } =
  await import("../../electron/ipc/settings-desktop");
const { defaultSettings } = await import("../../electron/store/store");
const { openPolicy, lockedPolicy } = await import("../../shared/client-policy");
const labels = await import("../../src/settings/tabs/desktop-labels");
const { ClaudeCodeTab } = await import("../../src/settings/tabs/ClaudeCode");
const { settingsSearchIndex } = await import("../../src/settings/search/pages");

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "claudex-wp3-"));
const running = (mode: Conversation["mode"]): Conversation =>
  ({
    id: `c-${mode}`,
    title: "Task",
    mode,
    turns: [{ id: "t", status: "inProgress", items: [], prompt: "" }],
  }) as unknown as Conversation;

function integration(settings: () => Settings | undefined, now?: () => number) {
  let conversations: Conversation[] = [];
  const commands: string[] = [];
  const desktop = new DesktopIntegration({
    window: () => undefined,
    settings,
    conversations: () => conversations,
    command: (command) => commands.push(command),
    trayIcon: import.meta.filename,
    now,
  });
  desktop.start();
  return {
    desktop,
    commands,
    set conversations(value: Conversation[]) {
      conversations = value;
    },
  };
}

test("the menu bar icon follows the setting and stays when signed out", () => {
  assert.equal(preference(defaultSettings, "menuBar"), true);
  let settings: Settings | undefined = { ...defaultSettings };
  delete settings.menuBar;
  assert.equal(preference(settings, "menuBar"), true);
  const { desktop } = integration(() => settings);
  desktop.apply();
  assert.equal(fake.trays.length, 1);
  assert.equal(fake.trays[0].destroyed, false);
  // A right click opens the original's menu: Show App, then Quit.
  fake.trays[0].handlers["right-click"]?.();
  assert.deepEqual(
    (fake.trays[0].menu as { label?: string }[])
      .map((item) => item.label)
      .filter(Boolean),
    ["Show App", "Quit Claudex"],
  );
  settings = { ...settings, menuBar: false };
  desktop.apply();
  assert.equal(fake.trays[0].destroyed, true);
  settings = { ...defaultSettings, menuBar: true };
  desktop.apply();
  assert.equal(fake.trays.length, 2);
  // Signed out the icon stays: the tray belongs to the app, on the default.
  settings = undefined;
  desktop.apply();
  assert.equal(fake.trays[1].destroyed, false);
  assert.equal(fake.trays.length, 2);
});

test("the tray menu lists the plan and usage under Show App, and Quit", () => {
  const labels = (status?: { plan?: string; usagePercent?: number }) =>
    trayMenuTemplate({
      appName: "Claudex",
      status,
      show: () => {},
      quit: () => {},
    }).map((item) => item.label ?? item.type);
  assert.deepEqual(labels(), ["Show App", "separator", "Quit Claudex"]);
  assert.deepEqual(labels({ plan: "Pro", usagePercent: 41.6 }), [
    "Show App",
    "separator",
    "Pro plan",
    "Usage: 42%",
    "separator",
    "Quit Claudex",
  ]);
  const items = trayMenuTemplate({
    appName: "Claudex",
    status: { plan: "Pro" },
    show: () => {},
    quit: () => {},
  });
  assert.equal(items[2].enabled, false);
});

test("the tray says Usage unavailable after the plan when the usage couldn't be read", () => {
  const labels = trayMenuTemplate({
    appName: "Claudex",
    status: { plan: "Pro", usageUnavailable: true },
    show: () => {},
    quit: () => {},
  }).map((item) => item.label ?? item.type);
  assert.deepEqual(labels.slice(2, 4), ["Pro plan", "Usage unavailable"]);
});

test("the Dock menu offers new sessions in recent folders, the last session and those waiting", () => {
  const session = (id: string, cwd: string, updatedAt: number, title = "") =>
    ({
      id,
      title,
      mode: "code",
      cwd,
      archived: false,
      updatedAt,
    }) as Conversation;
  const runs: unknown[] = [];
  const items = dockMenuTemplate({
    conversations: [
      session("a", "/work/api", 3, "Fix login"),
      session("b", "/work/web", 2),
      session("c", "/work/api", 1, "Old"),
      session("d", "/gone", 4, "Deleted folder"),
    ],
    waiting: new Set(["b"]),
    folderExists: (folder) => folder !== "/gone",
    run: (command, extra) => runs.push([command, extra]),
  });
  const labels = items.map((item) => item.label ?? item.type);
  assert.deepEqual(labels, [
    "New Chat",
    "New Code Session",
    "Continue “Deleted folder”",
    "separator",
    "Needs Your Input",
    "web",
  ]);
  const folders = items[1].submenu as { label?: string; click?: () => void }[];
  assert.deepEqual(
    folders.map((item) => item.label ?? "separator"),
    ["api", "web", "separator", "Other…"],
  );
  folders[0].click?.();
  (items[5] as { click?: () => void }).click?.();
  assert.deepEqual(runs, [
    ["new-code-session-in", { folder: "/work/api" }],
    ["open-conversation", { conversationId: "b" }],
  ]);
  assert.equal(items[4].enabled, false);
  const empty = dockMenuTemplate({
    conversations: [],
    waiting: new Set(),
    folderExists: () => true,
    run: () => {},
  });
  assert.deepEqual(
    empty.map((item) => item.label),
    ["New Chat", "New Code Session"],
  );
});

test("the main window is titled after the open conversation", () => {
  assert.equal(mainWindowTitle("Claudex"), "Claudex");
  assert.equal(mainWindowTitle(""), "Claudex");
  assert.equal(mainWindowTitle("Fix login - Claudex"), "Fix login — Claudex");
  assert.equal(
    mainWindowTitle("Refactor - Claudex Code"),
    "Refactor — Claudex",
  );
  assert.equal(mainWindowTitle(`${"x".repeat(100)} - Claudex`).length, 80 + 10);
});

test("a tray click brings up Quick Entry and only shows the main window without it", () => {
  let quick = 0;
  const settings: Settings = { ...defaultSettings, menuBar: true };
  const desktop = new DesktopIntegration({
    window: () => undefined,
    settings: () => settings,
    conversations: () => [],
    command: () => {},
    trayIcon: import.meta.filename,
    quickEntry: () => quick++,
  });
  desktop.start();
  desktop.apply();
  const tray = fake.trays.at(-1)!;
  tray.handlers.click?.();
  assert.equal(quick, 1);
  assert.equal(desktop.hasTray(), true);
});

test("Keep computer awake while Claudex works holds sleep off only while a Code turn runs", () => {
  fake.blockers.clear();
  const settings: Settings = {
    ...defaultSettings,
    keepAwakeWhileCoding: true,
  };
  let clock = 0;
  const host = integration(
    () => settings,
    () => clock,
  );
  host.conversations = [running("chat")];
  host.desktop.observeConversation(running("chat"));
  assert.equal(fake.blockers.size, 0, "a Chat turn does not keep it awake");
  host.conversations = [running("code")];
  host.desktop.observeConversation(running("code"));
  assert.equal(fake.blockers.size, 1);
  const done = { ...running("code"), turns: [] } as unknown as Conversation;
  host.conversations = [done];
  host.desktop.observeConversation(done);
  // Held for the original's 30 second grace after the last turn ends.
  assert.equal(fake.blockers.size, 1, "held for the grace");
  clock = 30_000;
  host.desktop.observeConversation(done);
  assert.equal(fake.blockers.size, 0, "released after the grace");
  // On battery only with its own switch.
  assert.equal(
    wantsKeepAwake({
      keepAwake: false,
      keepAwakeWhileCoding: true,
      keepAwakeOnBattery: false,
      onBattery: true,
      codeRunning: true,
    }),
    false,
  );
  assert.equal(
    wantsKeepAwake({
      keepAwake: false,
      keepAwakeWhileCoding: true,
      keepAwakeOnBattery: true,
      onBattery: true,
      codeRunning: true,
    }),
    true,
  );
  // System → Keep computer awake holds it while Claudex is open.
  assert.equal(
    wantsKeepAwake({
      keepAwake: true,
      keepAwakeWhileCoding: false,
      keepAwakeOnBattery: false,
      onBattery: true,
      codeRunning: false,
    }),
    true,
  );
});

test("Quick Entry answers Alt+Space off macOS until another shortcut is saved, signed in or not", () => {
  const platform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    fake.shortcuts.clear();
    let settings: Settings | undefined;
    const host = integration(() => settings);
    // Started with nobody signed in: the shortcut and the tray already stand.
    assert.deepEqual([...fake.shortcuts.keys()], ["Alt+Space"]);
    assert.equal(host.desktop.hasTray(), true);
    settings = { ...defaultSettings };
    delete settings.quickAccessShortcut;
    host.desktop.apply();
    assert.deepEqual([...fake.shortcuts.keys()], ["Alt+Space"]);
    // Clearing it in Settings turns it off.
    settings = { ...settings, quickAccessShortcut: "" };
    host.desktop.apply();
    assert.equal(fake.shortcuts.size, 0);
    // macOS opens Quick Entry by the Option double tap: no accelerator.
    Object.defineProperty(process, "platform", { value: "darwin" });
    settings = { ...defaultSettings };
    delete settings.quickAccessShortcut;
    host.desktop.apply();
    assert.equal(fake.shortcuts.size, 0);
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
    fake.shortcuts.clear();
  }
});

test("the Quick access shortcut registers, moves, and refuses one another app holds", () => {
  fake.shortcuts.clear();
  let settings: Settings = {
    ...defaultSettings,
    quickAccessShortcut: "Option+Space",
  };
  const host = integration(() => settings);
  host.desktop.apply();
  assert.deepEqual([...fake.shortcuts.keys()], ["Option+Space"]);
  fake.shortcuts.get("Option+Space")!();
  assert.deepEqual(host.commands, ["new-chat"]);
  fake.taken.add("Command+Shift+Space");
  settings = { ...settings, quickAccessShortcut: "Command+Shift+Space" };
  assert.throws(() => host.desktop.apply(), /used by another app/);
  assert.deepEqual(
    [...fake.shortcuts.keys()],
    ["Option+Space"],
    "a refused change keeps the last working shortcut",
  );
  settings = { ...settings, quickAccessShortcut: "" };
  host.desktop.apply();
  assert.equal(fake.shortcuts.size, 0);
  // The offered accelerators and any recorded shortcut with a modifier pass the
  // settings schema; a bare key does not.
  const fields = desktopPreferenceFields("darwin");
  assert.equal(fields.quickAccessShortcut.safeParse("").success, true);
  assert.equal(
    fields.quickAccessShortcut.safeParse("Option+Space").success,
    true,
  );
  assert.equal(
    fields.quickAccessShortcut.safeParse("Control+Alt+Space").success,
    true,
  );
  assert.equal(fields.quickAccessShortcut.safeParse("D").success, false);
  assert.equal(
    desktopPreferenceFields("win32").quickAccessShortcut.safeParse(
      "Control+Alt+Space",
    ).success,
    true,
  );
  assert.deepEqual(labels.shortcutOptions(shortcutChoices("win32")), [
    { value: "", label: "No shortcut" },
    { value: "Control+Alt+Space", label: "Control+Alt+Space" },
    { value: "Control+Shift+Space", label: "Control+Shift+Space" },
  ]);
});

function handlers(options: {
  root: string;
  servers?: Record<string, unknown>;
  policy?: typeof openPolicy;
  mcpConfig?: InstanceType<typeof McpConfigFile>;
  context?: Record<string, unknown>;
}) {
  const table = new Map<string, (...args: any[]) => any>();
  const ctx = {
    activeAccount: { id: "settings-desktop-fixture" },
    store: {
      root: options.root,
      settings: { ...defaultSettings, mcpServers: options.servers ?? {} },
      conversations: [],
    },
    dataRoot: options.root,
    callerWindow: () => undefined,
    engine: {
      rpc: undefined,
      state: { state: "stopped" },
      mcpStartup: new Map(),
    },
    mcpConfig: options.mcpConfig,
    policy: () => options.policy ?? openPolicy,
    noActive: () => {},
    ...options.context,
  };
  registerSettingsDesktopHandlers(
    (name, fn) => table.set(name, fn),
    ctx as any,
  );
  return table;
}

test("desktop notification IPC routes actions only to the originating live window", () => {
  let destroyed = false;
  const sender = {};
  const window = { isDestroyed: () => destroyed, webContents: sender };
  const sent: unknown[][] = [];
  const counts: unknown[][] = [];
  let action: ((event: unknown) => void) | undefined;
  const shown: unknown[] = [];
  const table = handlers({
    root: "/tmp/claudex-notification-ipc",
    context: {
      callerWindow: () => window,
      appWindows: { send: (...args: unknown[]) => sent.push(args) },
      integration: {
        supportsNotificationActions: () => true,
        showNotification: (input: unknown, callback: typeof action) => {
          shown.push(input);
          action = callback;
        },
        setProjectPromptsWaiting: (...args: unknown[]) => counts.push(args),
      },
    },
  });
  assert.equal(table.get("supportsNotificationActions")!(), true);
  table.get("showDesktopNotification")!({
    title: "Project",
    body: "Request",
    tag: "input",
    token: "request_1",
    actions: [
      { id: "approve", title: "Allow" },
      { id: "reject", title: "Deny" },
    ],
  });
  assert.equal(shown.length, 1);
  const event = {
    type: "notification-action",
    tag: "input",
    token: "request_1",
    actionId: "reject",
    sinceShownMs: 10,
  };
  action!(event);
  assert.deepEqual(sent, [[window, event]]);
  destroyed = true;
  action!(event);
  assert.equal(sent.length, 1);
  table.get("setProjectPromptsWaiting")!(3);
  assert.deepEqual(counts, [[sender, 3]]);
});

test("packaged extension IPC confirms installation and registers private files", async () => {
  const { createZip } = await import("../../electron/workspace/zip");
  const root = temp();
  const current: Record<string, unknown> = {};
  const table = handlers({
    root,
    mcpConfig: {
      update: (servers: Record<string, unknown>) =>
        Object.assign(current, servers),
    } as any,
  });
  const data = new Uint8Array(
    createZip([
      {
        name: "manifest.json",
        data: Buffer.from(
          JSON.stringify({
            name: "packaged",
            server: {
              mcp_config: { command: "node", args: ["${__dirname}/server.js"] },
            },
          }),
        ),
      },
      { name: "server.js", data: Buffer.from("export {};") },
    ]),
  );
  const questions = fake.questions.length;
  const answer = fake.answer;
  try {
    fake.answer = 1;
    assert.equal(
      await table.get("installExtension")!({ name: "example.MCPB", data }),
      null,
    );
    assert.deepEqual(current, {});
    fake.answer = 0;
    assert.equal(
      await table.get("installExtension")!({ name: "example.dxt", data }),
      "packaged",
    );
    assert.ok(
      (current.packaged as { args: string[] }).args[0].startsWith(
        path.join(root, "desktop-extensions"),
      ),
    );
    await assert.rejects(
      () =>
        table.get("installExtension")!({
          name: "bad.mcpb",
          data: new Uint8Array([1]),
        }),
      /无法打开扩展文件/,
    );
  } finally {
    fake.answer = answer;
    fake.questions.splice(questions);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extension folder buttons create and open their account-scoped folders", async () => {
  const root = temp();
  const table = handlers({ root });
  const opened = fake.opened.length;
  try {
    for (const [method, folder] of [
      ["openExtensionsFolder", "desktop-extensions"],
      ["openExtensionSettingsFolder", "desktop-extension-settings"],
    ]) {
      await table.get(method)!();
      assert.ok(fs.statSync(path.join(root, folder)).isDirectory());
      assert.equal(fake.opened.at(-1), path.join(root, folder));
    }
  } finally {
    fake.opened.splice(opened);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Run on startup sets the login item; Clear cache and restart asks first", async () => {
  const root = temp();
  fs.writeFileSync(path.join(root, "conversations.json"), "x".repeat(100));
  fs.mkdirSync(path.join(root, "workspace"));
  fs.writeFileSync(path.join(root, "workspace", "a.txt"), "y".repeat(50));
  fs.mkdirSync(path.join(root, "Cache"));
  fs.writeFileSync(path.join(root, "Cache", "data_0"), "z".repeat(30));
  const table = handlers({ root });
  const state = await table.get("setRunOnStartup")!(true);
  if (process.platform === "linux") return;
  assert.equal(fake.openAtLogin, true);
  assert.equal(state.runOnStartup, true);
  await assert.rejects(async () => table.get("setRunOnStartup")!("yes"));
  const usage = await table.get("storageUsage")!();
  assert.equal(usage.folder, root);
  assert.equal(usage.cowork.workspaceBytes, 50);
  assert.equal(usage.app.webCacheBytes, 30);
  assert.equal(usage.incomplete, false);
  const question = {
    message: "Clear cached web content and restart Claudex?",
    detail: "You stay signed in.",
    cancel: "Cancel",
    confirm: "Clear and restart",
  };
  await assert.rejects(async () =>
    table.get("clearCacheAndRestart")!({ ...question, extra: 1 }),
  );
  // Cancel: nothing is cleared and nothing restarts.
  fake.answer = 0;
  assert.equal(await table.get("clearCacheAndRestart")!(question), false);
  assert.equal(fake.cacheCleared, 0);
  assert.equal(fake.relaunched, 0);
  assert.deepEqual(fake.questions.at(-1)!.buttons, [
    "Cancel",
    "Clear and restart",
  ]);
  fake.answer = 1;
  assert.equal(await table.get("clearCacheAndRestart")!(question), true);
  assert.equal(fake.cacheCleared, 1);
  assert.equal(fake.relaunched, 1);
  assert.equal(fake.quit, 1);
});

test("storage counts files once and never follows links out of the folder", async () => {
  const root = temp();
  const outside = temp();
  fs.writeFileSync(path.join(outside, "big.bin"), Buffer.alloc(4096));
  fs.mkdirSync(path.join(root, "workspace"));
  fs.symlinkSync(outside, path.join(root, "workspace", "link"));
  assert.equal(await diskUsage(path.join(root, "workspace")), 0);
  fs.writeFileSync(path.join(root, "settings.json"), "{}");
  const usage = await storageUsage({
    root,
    dataRoot: temp(),
    conversations: [],
  });
  assert.equal(usage.cowork.workspaceBytes, 0);
  assert.equal(usage.cowork.otherBytes, 2);
});

test("the MCP configuration file applies when saved and reports a bad edit", async () => {
  const root = temp();
  let servers: Record<string, unknown> = { docs: { command: "docs-mcp" } };
  const applied: Record<string, unknown>[] = [];
  const file = new McpConfigFile(
    root,
    () => servers,
    (next) => {
      applied.push(next);
      servers = next;
    },
  );
  file.ensure();
  assert.equal(fs.readFileSync(file.path, "utf8"), mcpConfigText(servers));
  // Saving the same servers changes nothing.
  file.reload();
  assert.equal(applied.length, 0);
  fs.writeFileSync(file.path, "{ not json");
  file.reload();
  assert.match(file.error!, /not valid JSON/);
  assert.equal(applied.length, 0);
  // The Developer page shows the error (mcpServers handler).
  const table = handlers({ root, servers, mcpConfig: file });
  assert.match((await table.get("mcpServers")!()).configError, /not valid/);
  // The watcher picks a save up after its short delay. A directory watch
  // can take a moment to start on macOS, and events before that are lost,
  // so the save is repeated until one arrives (as saving again would).
  const saved = mcpConfigText({
    docs: { command: "docs-mcp" },
    git: { command: "git" },
  });
  for (let i = 0; i < 200 && !applied.length; i++) {
    if (i % 20 === 0) fs.writeFileSync(file.path, saved);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  file.close();
  assert.equal(file.error, undefined);
  assert.deepEqual(Object.keys(applied.at(-1)!), ["docs", "git"]);
  assert.throws(
    () => parseMcpConfig(JSON.stringify({ mcpServers: { "a b": {} } })),
    /not a valid server name/,
  );
  assert.throws(
    () => parseMcpConfig(JSON.stringify({ mcpServers: { a: {} } })),
    /needs a "command" or a "url"/,
  );
});

test("Edit config is refused while the administrator turns off MCP editing", async () => {
  const root = temp();
  const file = new McpConfigFile(
    root,
    () => ({}),
    () => {},
  );
  const locked = handlers({ root, mcpConfig: file, policy: lockedPolicy });
  await assert.rejects(
    async () => locked.get("openMcpConfig")!(),
    /turned off adding MCP servers|reaches your service/,
  );
  assert.equal(fake.opened.length, 0);
  const open = handlers({ root, mcpConfig: file });
  await open.get("openMcpConfig")!();
  assert.deepEqual(fake.opened, [file.path]);
  file.close();
  await assert.rejects(
    async () => handlers({ root }).get("openMcpConfig")!(),
    /Sign in/,
  );
});

test("server states: switched off, runtime stopped, failed, running", () => {
  const configured = {
    off: { command: "off-mcp", enabled: false },
    docs: { command: "docs-mcp", args: ["--stdio"] },
    web: { url: "https://mcp.example.test/sse" },
    broken: { command: "missing" },
  };
  const stopped = mcpServerStates(configured, false, new Map(), []);
  assert.deepEqual(
    stopped.map((server) => server.state),
    ["disabled", "stopped", "stopped", "stopped"],
  );
  const live = mcpServerStates(
    configured,
    true,
    new Map([["broken", { status: "failed", error: "program not found" }]]),
    [{ name: "docs", tools: { a: {}, b: {} } }],
  );
  assert.deepEqual(
    live.map((server) => [server.name, server.state, server.tools]),
    [
      ["off", "disabled", 0],
      ["docs", "ready", 2],
      ["web", "starting", 0],
      ["broken", "failed", 0],
    ],
  );
  assert.equal(live[1].command, "docs-mcp --stdio");
  assert.equal(live[2].url, "https://mcp.example.test/sse");
  assert.equal(live[3].error, "program not found");
  assert.equal(labels.mcpStateLabels.failed, "Failed");
});

test("skill uploads refuse links, oversized folders and bad names", () => {
  const skill = (name = "report-helper") => {
    const dir = temp();
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: Helps\n---\n\nDo it.\n`,
    );
    return dir;
  };
  assert.equal(checkSkillFolder(skill()), "report-helper");
  assert.throws(() => checkSkillFolder(temp()), /needs a SKILL.md/);
  assert.throws(() => checkSkillFolder(skill("Bad Name")), /lowercase/);
  const linked = skill();
  fs.symlinkSync("/etc", path.join(linked, "etc"));
  assert.throws(() => checkSkillFolder(linked), /can't contain links/);
  const many = skill();
  for (let i = 0; i < 501; i++)
    fs.writeFileSync(path.join(many, `f${i}.txt`), "");
  assert.throws(() => checkSkillFolder(many), /up to 500 files and 20 MB/);
  const big = skill();
  fs.writeFileSync(path.join(big, "big.bin"), Buffer.alloc(21 * 1024 * 1024));
  assert.throws(() => checkSkillFolder(big), /up to 500 files and 20 MB/);
});

test("skills are listed once, grouped by source, and filtered by the search", () => {
  const own = {
    name: "weekly-report",
    description: "Status report",
    path: "/a/weekly-report/SKILL.md",
    scope: "user" as const,
  };
  const system = {
    name: "skill-creator",
    description: "Create skills",
    path: "/b/skill-creator/SKILL.md",
    scope: "system" as const,
  };
  const groups = labels.groupSkills([
    { skills: [system, own] },
    { skills: [own] },
  ]);
  assert.deepEqual(
    groups.map((group) => [group.title, group.skills.map((s) => s.name)]),
    [
      ["Yours", ["weekly-report"]],
      ["Built in", ["skill-creator"]],
    ],
  );
  assert.deepEqual(
    labels
      .groupSkills([{ skills: [system, own] }], "STATUS")
      .map((group) => group.scope),
    ["user"],
  );
  assert.equal(labels.skillNamePattern.test("weekly-report"), true);
  assert.equal(labels.skillNamePattern.test("1-report"), false);
});

test("Allow bypass permissions mode is always shown and is the user's own switch", () => {
  const render = (settings: Settings) =>
    renderToStaticMarkup(
      createElement(ClaudeCodeTab, {
        settings,
        save: () => {},
        platform: "darwin",
        engine: { state: "ready" },
        onError: () => {},
        goTo: () => {},
      } as any),
    );
  const on = render(defaultSettings);
  assert.match(
    on,
    /aria-label="Allow bypass permissions mode" aria-checked="true"/,
  );
  // Both keep-awake switches are on by default, as the original's.
  assert.match(
    on,
    /aria-label="Keep awake on battery power" aria-checked="true" class/,
  );
  // Battery shows only while its parent switch is on, as the original.
  assert.doesNotMatch(
    render({ ...defaultSettings, keepAwakeWhileCoding: false }),
    /Keep awake on battery power/,
  );
  const off = render({ ...defaultSettings, allowBypassPermissions: false });
  assert.match(
    off,
    /aria-label="Allow bypass permissions mode" aria-checked="false"/,
  );
  // Turning it off moves a Bypass default back to workspace write.
  assert.deepEqual(
    labels.bypassPatch({ codeSandbox: "danger-full-access" }, false),
    { allowBypassPermissions: false, codeSandbox: "workspace-write" },
  );
  assert.deepEqual(labels.bypassPatch({ codeSandbox: "read-only" }, false), {
    allowBypassPermissions: false,
  });
  assert.deepEqual(
    labels.bypassPatch({ codeSandbox: "danger-full-access" }, true),
    { allowBypassPermissions: true },
  );
});

test("notification levels show once a level is in force, as the original's gated rows", () => {
  const render = (settings: Settings) =>
    renderToStaticMarkup(
      createElement(ClaudeCodeTab, {
        settings,
        save: () => {},
        platform: "darwin",
        engine: { state: "ready" },
        onError: () => {},
        goTo: () => {},
      } as any),
    );
  // By default the rows stay hidden (banners for every kind).
  assert.doesNotMatch(render(defaultSettings), /Permission requests/);
  // An old "off" switch carries over: the rows show it, and Draw attention
  // has nothing left to bounce for.
  const migrated = render({ ...defaultSettings, notifyCode: false } as any);
  assert.match(migrated, /Permission requests/);
  assert.match(migrated, /Task complete/);
  assert.match(migrated, /Notification sound/);
  assert.match(
    migrated,
    /aria-label="Draw attention on notifications" aria-checked="false" disabled=""/,
  );
});

test("every WP3 search label is a row or section its page shows", () => {
  const pages: Record<string, string> = {
    capabilities: "Capabilities",
    memory: "Memory",
    design: "DesignSystems",
    code: "ClaudeCode",
    cowork: "Cowork",
    chrome: "Chrome",
    system: "System",
    extensions: "Extensions",
    developer: "Developer",
    skills: "Skills",
    connectors: "Connectors",
    plugins: "Plugins",
  };
  for (const [tab, file] of Object.entries(pages)) {
    // Plugins' rows are drawn by the shared plugins body.
    const source = [
      `../../src/settings/tabs/${file}.tsx`,
      ...(tab === "plugins"
        ? [
            "../../src/plugins/PluginsBody.tsx",
            "../../src/plugins/PluginRows.tsx",
            "../../src/plugins/PluginDetailDialog.tsx",
          ]
        : []),
      // System and retained Cowork reuse the supported browser preference rows.
      ...(["cowork", "system"].includes(tab)
        ? ["../../src/settings/tabs/BrowserLinkPreferences.tsx"]
        : []),
      // Claude Code's Trusted folders row is its own component.
      ...(tab === "code"
        ? [
            "../../src/settings/tabs/TrustedWorkspaces.tsx",
            "../../src/settings/tabs/CodeAccountSections.tsx",
          ]
        : []),
    ]
      .map((name) => readSource(path.join(import.meta.dirname, name)))
      .join("\n");
    const shown = (settingsSearchIndex as Record<string, string[]>)[tab];
    assert.ok(shown?.length, `${tab} has search labels`);
    for (const label of shown)
      assert.ok(source.includes(label), `${file}.tsx shows "${label}"`);
  }
});

test("Trusted Cowork folders follow the main process and hide on the web", async () => {
  const { watchTrustedFolders } =
    await import("../../src/settings/tabs/CoworkTrustedFolders");
  let listeners: ((event: any) => void)[] = [];
  let trusted = ["/Users/a/Reports"];
  let fail: Error | undefined;
  let calls = 0;
  const bridge = {
    trustedCoworkFolders: async () => {
      calls++;
      if (fail) throw fail;
      return [...trusted];
    },
    onEvent: (callback: (event: any) => void) => {
      listeners.push(callback);
      return () => {
        listeners = listeners.filter((item) => item !== callback);
      };
    },
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const emit = (type: string) => {
    for (const listener of listeners) listener({ type });
  };
  const seen: string[][] = [];
  const errors: unknown[] = [];
  const off = watchTrustedFolders(
    bridge as any,
    (list) => seen.push(list),
    (error) => errors.push(error),
  );
  await flush();
  assert.deepEqual(seen, [["/Users/a/Reports"]]);
  // "Always allow" in the access dialog pushes cowork-folders.
  trusted = ["/Users/a/Reports", "/Users/a/Notes"];
  emit("cowork-folders");
  await flush();
  assert.deepEqual(seen.at(-1), ["/Users/a/Reports", "/Users/a/Notes"]);
  // Other events do not reload.
  emit("settings");
  await flush();
  assert.equal(calls, 2);
  // A real failure is reported; after unsubscribing nothing more arrives.
  fail = new Error("disk full");
  emit("cowork-folders");
  await flush();
  assert.equal((errors[0] as Error).message, "disk full");
  // Replies that arrive out of order: only the newest request counts.
  fail = undefined;
  const pending: ((list: string[]) => void)[] = [];
  bridge.trustedCoworkFolders = () =>
    new Promise<string[]>((resolve) => pending.push(resolve));
  const before = seen.length;
  emit("cowork-folders");
  emit("cowork-folders");
  pending[1](["/Users/a/Notes"]);
  await flush();
  pending[0](["/Users/a/Reports", "/Users/a/Notes"]);
  await flush();
  assert.deepEqual(seen.slice(before), [["/Users/a/Notes"]]);
  off();
  assert.equal(listeners.length, 0);

  // The web bridge has no local folders: no error, no list, so no row.
  const webErrors: unknown[] = [];
  const webSeen: string[][] = [];
  const offWeb = watchTrustedFolders(
    {
      trustedCoworkFolders: async () => {
        throw new Error("Not available on the web.");
      },
      onEvent: () => () => {},
    } as any,
    (list) => webSeen.push(list),
    (error) => webErrors.push(error),
  );
  await flush();
  offWeb();
  assert.deepEqual(webErrors, []);
  assert.deepEqual(webSeen, []);
});

test("Trusted Cowork folders list shows each full path on one line with a remove button", async () => {
  const { TrustedFoldersList, trustedFolderName } =
    await import("../../src/settings/tabs/CoworkTrustedFolders");
  const empty = renderToStaticMarkup(
    createElement(TrustedFoldersList, {
      folders: [],
      busy: false,
      onRemove: () => {},
    }),
  );
  assert.match(empty, /No trusted folders yet\./);
  assert.doesNotMatch(empty, /Always allow/);
  const list = renderToStaticMarkup(
    createElement(TrustedFoldersList, {
      folders: ["/Users/a/Reports", "C:\\Users\\a\\Notes\\"],
      busy: true,
      onRemove: () => {},
    }),
  );
  assert.match(
    list,
    /<span title="\/Users\/a\/Reports">\/Users\/a\/Reports<\/span>/,
  );
  assert.match(list, /aria-label="Remove" title="Remove Notes" disabled=""/);
  assert.equal(trustedFolderName("/"), "/");
  // The row waits for the list: the first render has no Manage button.
  const { CoworkTab } = await import("../../src/settings/tabs/Cowork");
  const page = renderToStaticMarkup(
    createElement(CoworkTab, {
      settings: defaultSettings,
      save: () => {},
      platform: "darwin",
      onError: () => {},
    } as any),
  );
  assert.match(page, /Global instructions/);
  assert.match(page, /Instructions here apply to all Cowork sessions/);
  assert.doesNotMatch(
    page,
    /Trusted Cowork folders|Require trusted devices|Cowork local devices|Trusted devices/,
  );
  const { searchLabels: coworkLabels } =
    await import("../../src/settings/tabs/Cowork");
  const { searchLabels: accountLabels } =
    await import("../../src/settings/tabs/Account");
  for (const label of [
    "Require trusted devices",
    "Local devices",
    "Trusted devices",
  ]) {
    assert.equal(coworkLabels.includes(label), false);
    assert.equal(accountLabels.includes(label), true);
  }
});

test("Developer lists servers beside the chosen server's details", async () => {
  const { ServerPanel } = await import("../../src/settings/tabs/Developer");
  const servers = [
    {
      name: "docs",
      state: "ready" as const,
      tools: 2,
      command: "docs-mcp --stdio",
    },
    {
      name: "broken",
      state: "failed" as const,
      tools: 0,
      error: "program not found",
    },
  ];
  const configs = {
    docs: {
      command: "docs-mcp",
      args: ["--stdio", "--fast"],
      env: { KEY: "1" },
    },
    broken: { command: "nope" },
  };
  const render = (canDelete: boolean) =>
    renderToStaticMarkup(
      createElement(ServerPanel, {
        servers,
        configs,
        canDelete,
        isBlocked: () => false,
        onRemove: async () => {},
        onError: () => {},
      }),
    );
  const html = render(true);
  // The first server is chosen: command and arguments apart, state, delete.
  assert.match(html, /<h2>docs<\/h2>/);
  assert.match(html, /<h3>Command<\/h3><p>docs-mcp<\/p>/);
  assert.match(html, /<h3>Arguments<\/h3><p>--stdio --fast<\/p>/);
  assert.match(html, /aria-label="Delete"/);
  assert.match(html, /Advanced options/);
  // Environment variables stay folded until opened.
  assert.doesNotMatch(html, /Environment variables/);
  // Only the failed server carries the warning in the list.
  assert.equal(html.match(/data-icon="Warning"/g)?.length, 1);
  assert.doesNotMatch(render(false), /aria-label="Delete"/);
});

test("Connectors tell a search with no match from having no connectors, and sort by status", async () => {
  const { connectorConnected } =
    await import("../../src/settings/tabs/Connectors");
  const { NothingMatches } =
    await import("../../src/settings/tabs/ConnectorDirectory");
  const ready = { name: "a", state: "ready" as const, tools: 1 };
  assert.equal(connectorConnected(ready), true);
  // Running but waiting for sign-in is not connected yet.
  assert.equal(
    connectorConnected({ ...ready, authStatus: "notLoggedIn" }),
    false,
  );
  assert.equal(connectorConnected({ ...ready, state: "failed" }), false);
  const html = renderToStaticMarkup(
    createElement(NothingMatches, {
      message: "No connectors match your search",
      hint: "Try a different term, or browse the Directory to find new connectors.",
    }),
  );
  assert.match(html, /<p>No connectors match your search<\/p>/);
  assert.match(html, /directory-nothing-hint">Try a different term/);
  assert.doesNotMatch(html, /Reset filters/);
  // The directory's own wording stays the default.
  assert.match(
    renderToStaticMarkup(createElement(NothingMatches, {})),
    /No connectors match your filters/,
  );
});
