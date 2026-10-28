/**
 * Quick Entry (shared/quick-entry.ts): the composer window, its IPC as the
 * app wires it, and the shortcut that brings it up. Electron is replaced by
 * a fake module.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";

type Rect = { x: number; y: number; width: number; height: number };
const handlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => void
>();
const invokeHandlers = new Map<string, (...args: any[]) => unknown>();
const shortcuts = new Map<string, () => void>();
const windows: FakeBrowserWindow[] = [];
const area = { x: 0, y: 25, width: 1440, height: 875 };
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-quick-"));

class FakeContents extends EventEmitter {
  mainFrame = { name: "main" };
  loaded = "";
  sent: unknown[][] = [];
  setWindowOpenHandler() {}
  async loadURL(url: string) {
    this.loaded = url;
  }
  async loadFile(file: string) {
    this.loaded = file;
  }
  send(...args: unknown[]) {
    this.sent.push(args);
  }
}
class FakeBrowserWindow extends EventEmitter {
  webContents = new FakeContents();
  bounds: Rect;
  visible = false;
  destroyed = false;
  focused = 0;
  onTop?: [boolean, string];
  constructor(public options: Record<string, any>) {
    super();
    this.bounds = {
      x: options.x,
      y: options.y,
      width: options.width,
      height: options.height,
    };
    windows.push(this);
  }
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
  show() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  focus() {
    this.focused++;
  }
  destroy() {
    this.destroyed = true;
  }
  getBounds() {
    return { ...this.bounds };
  }
  setBounds(bounds: Partial<Rect>) {
    this.bounds = { ...this.bounds, ...bounds };
  }
  setAlwaysOnTop(on: boolean, level: string) {
    this.onTop = [on, level];
  }
}
(globalThis as any).__fakeElectron = {
  BrowserWindow: FakeBrowserWindow,
  ipcMain: {
    handle: (channel: string, fn: (...args: any[]) => unknown) =>
      invokeHandlers.set(channel, fn),
    on: (channel: string, fn: (...args: unknown[]) => void) =>
      handlers.set(channel, fn),
  },
  screen: {
    getPrimaryDisplay: () => ({ workArea: area }),
    getDisplayNearestPoint: () => ({ workArea: area }),
  },
  app: {
    name: "Claudex",
    on: () => {},
    off: () => {},
    dock: { bounce: () => {}, setMenu: () => {} },
    getPath: () => userData,
  },
  globalShortcut: {
    register: (accelerator: string, fn: () => void) => {
      shortcuts.set(accelerator, fn);
      return true;
    },
    unregister: (accelerator: string) => shortcuts.delete(accelerator),
  },
  Menu: { buildFromTemplate: (items: unknown[]) => items },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
  Notification: class {
    static isSupported = () => false;
  },
  powerMonitor: {
    on: () => {},
    off: () => {},
    isOnBatteryPower: () => false,
    getSystemIdleTime: () => 0,
    getSystemIdleState: () => "active",
  },
  powerSaveBlocker: { start: () => 1, stop: () => {} },
  Tray: class {},
  systemPreferences: { getMediaAccessStatus: () => "granted" },
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
});

const {
  quickEntryChannels,
  quickEntryHeight,
  quickEntryPosition,
  quickPrompt,
} = await import("../../shared/quick-entry");
const { quickWindowFor } = await import("../../electron/app/quick-window-main");
const { DesktopIntegration } =
  await import("../../electron/app/desktop-integration");
const { quickEntryDictationSupported } =
  await import("../../electron/app/quick-access");
const { defaultSettings } = await import("../../electron/store/store");

test("a prompt needs more than two characters once trimmed", () => {
  assert.equal(quickPrompt("  hi  "), undefined);
  assert.equal(quickPrompt(""), undefined);
  assert.equal(quickPrompt("  hey  "), "hey");
});

test("the composer opens centred the first time, then where it was put away", () => {
  // Centred as the original's 606×470 window is, so the one-line card sits
  // in the upper part of the screen.
  assert.deepEqual(quickEntryPosition(area), {
    x: (1440 - 606) / 2,
    y: Math.round(25 + (875 - 470) / 2),
  });
  assert.deepEqual(quickEntryPosition(area, { x: 100, y: 200 }), {
    x: 100,
    y: 200,
  });
  // Kept on the work area.
  assert.deepEqual(quickEntryPosition(area, { x: 5000, y: -40 }, 56), {
    x: 1440 - 606,
    y: 25,
  });
  assert.equal(quickEntryHeight(10, 875), 56);
  assert.equal(quickEntryHeight(120.4, 875), 120);
  assert.equal(quickEntryHeight(2000, 875), 775);
  assert.equal(quickEntryHeight(2000, 400), 300);
  assert.equal(quickEntryHeight(2000, 100), 56);
});

function setup(
  attach?: Parameters<typeof quickWindowFor>[0]["attach"],
  voice?: Parameters<typeof quickWindowFor>[0]["voice"],
) {
  windows.length = 0;
  handlers.clear();
  invokeHandlers.clear();
  delete process.env.CLAUDEX_DEV_URL;
  const main = Object.assign(new EventEmitter(), { id: "main" });
  const delivered: unknown[] = [];
  let shown = 0;
  const quick = quickWindowFor({
    dirname: "/app/dist-electron",
    main: () => main as never,
    showMain: () => {
      shown++;
      return main as never;
    },
    send: (win, event) => void delivered.push([win, event]),
    attach,
    voice,
  });
  return { quick, main, delivered, shown: () => shown };
}
const ready = async (win: FakeBrowserWindow) => {
  win.emit("ready-to-show");
  handlers.get(quickEntryChannels.ready)?.({
    sender: win.webContents,
    senderFrame: win.webContents.mainFrame,
  });
  await new Promise((resolve) => setImmediate(resolve));
};

test("the shortcut brings up a floating, sandboxed composer and puts it away", async () => {
  const { quick } = setup();
  const opening = quick.toggle();
  const [win] = windows;
  await ready(win);
  await opening;
  assert.equal(win.options.frame, false);
  assert.equal(win.options.transparent, true);
  assert.equal(win.options.resizable, false);
  assert.equal(win.options.skipTaskbar, true);
  assert.deepEqual(win.options.webPreferences, {
    preload: "/app/dist-electron/quick-preload.cjs",
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  });
  assert.deepEqual(win.onTop, [true, "pop-up-menu"]);
  assert.equal(win.webContents.loaded, "/app/dist/quick.html");
  assert.ok(win.visible);
  assert.equal(win.focused, 1);
  assert.deepEqual(win.webContents.sent, [
    [quickEntryChannels.shown, area.height],
  ]);
  assert.equal(win.bounds.width, 606);
  // Pressed again while up: put away. Up again where it was left.
  win.setBounds({ x: 300, y: 400 });
  await quick.toggle();
  assert.equal(win.visible, false);
  await quick.toggle();
  assert.equal(windows.length, 1);
  assert.deepEqual([win.bounds.x, win.bounds.y], [300, 400]);
  // Switching away puts it away.
  win.emit("blur");
  assert.equal(win.visible, false);
});

test("the composer opens where it was put away in an earlier run", async () => {
  const first = setup();
  const opening = first.quick.toggle();
  const [win] = windows;
  await ready(win);
  await opening;
  win.setBounds({ x: 320, y: 410 });
  await first.quick.toggle();
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(userData, "quick-entry-position.json"), "utf8"),
    ),
    { x: 320, y: 410 },
  );
  // A new run: a fresh composer opens at the saved place.
  const second = setup();
  const again = second.quick.toggle();
  const [next] = windows;
  await ready(next);
  await again;
  assert.deepEqual([next.bounds.x, next.bounds.y], [320, 410]);
});

test("a growing composer is pushed back from the right edge as well", async () => {
  const { quick } = setup();
  const opening = quick.toggle();
  const [win] = windows;
  await ready(win);
  await opening;
  const own = {
    sender: win.webContents,
    senderFrame: win.webContents.mainFrame,
  };
  win.setBounds({ x: 1400, y: 300 });
  handlers.get(quickEntryChannels.resize)!(own, 104);
  assert.equal(win.bounds.x, 1440 - 30 - 606);
});

test("a submission hides the composer and starts a chat in the main window", async () => {
  const { quick, main, delivered, shown } = setup();
  const opening = quick.toggle();
  const [win] = windows;
  await ready(win);
  await opening;
  const submit = handlers.get(quickEntryChannels.submit)!;
  const own = {
    sender: win.webContents,
    senderFrame: win.webContents.mainFrame,
  };
  submit(own, "  Plan my week  ");
  assert.equal(win.visible, false);
  assert.equal(shown(), 1);
  assert.deepEqual(delivered, [
    [main, { type: "quick-entry", text: "Plan my week" }],
  ]);
  // Too short: put away, nothing sent.
  await quick.toggle();
  submit(own, "hi");
  assert.equal(win.visible, false);
  assert.equal(delivered.length, 1);
});

test("only the composer's own page is heard, with checked arguments", async () => {
  const { quick, delivered } = setup();
  const opening = quick.toggle();
  const [win] = windows;
  await ready(win);
  await opening;
  const submit = handlers.get(quickEntryChannels.submit)!;
  const stranger = new FakeContents();
  submit({ sender: stranger, senderFrame: stranger.mainFrame }, "Plan my week");
  submit(
    { sender: win.webContents, senderFrame: { name: "child" } },
    "Plan my week",
  );
  submit(
    { sender: win.webContents, senderFrame: win.webContents.mainFrame },
    { text: "Plan my week" },
  );
  submit(
    { sender: win.webContents, senderFrame: win.webContents.mainFrame },
    "x".repeat(16385),
  );
  assert.equal(delivered.length, 0);
  assert.ok(win.visible);
  handlers.get(quickEntryChannels.dismiss)!({
    sender: stranger,
    senderFrame: stranger.mainFrame,
  });
  assert.ok(win.visible);
  handlers.get(quickEntryChannels.dismiss)!({
    sender: win.webContents,
    senderFrame: win.webContents.mainFrame,
  });
  assert.equal(win.visible, false);
});

test("the composer takes its content's height and stays on the work area", async () => {
  const { quick } = setup();
  const opening = quick.toggle();
  const [win] = windows;
  await ready(win);
  await opening;
  const resize = handlers.get(quickEntryChannels.resize)!;
  const own = {
    sender: win.webContents,
    senderFrame: win.webContents.mainFrame,
  };
  win.setBounds({ y: 300 });
  resize(own, 104);
  assert.deepEqual([win.bounds.y, win.bounds.height], [300, 104]);
  // Growing past the bottom (30px from the work area's foot) moves it up.
  win.setBounds({ y: 800 });
  resize(own, 200);
  assert.deepEqual(
    [win.bounds.y, win.bounds.height],
    [25 + 875 - 30 - 200, 200],
  );
  resize(own, "tall");
  assert.equal(win.bounds.height, 200);
  resize(own, 2000);
  assert.equal(win.bounds.height, area.height - 100);
});

test("voice shortcut opens Quick Entry, then stops without hiding its transcript", async () => {
  const { quick } = setup();
  const opening = quick.dictation("start");
  const [win] = windows;
  await ready(win);
  await opening;
  assert.deepEqual(win.webContents.sent.at(-1), [
    quickEntryChannels.dictation,
    "start",
  ]);
  await quick.dictation("stop");
  assert.ok(win.visible);
  assert.deepEqual(win.webContents.sent.at(-1), [
    quickEntryChannels.dictation,
    "stop",
  ]);
  quick.hide();
  assert.deepEqual(win.webContents.sent.at(-1), [quickEntryChannels.hidden]);
  await quick.dictation("stop");
  assert.equal(win.visible, false);
});

test(
  "native custom voice shortcuts route to dictation and unregister when switched off",
  {
    skip: !quickEntryDictationSupported(),
  },
  () => {
    shortcuts.clear();
    const actions: string[] = [];
    const settings = {
      ...structuredClone(defaultSettings),
      quickAccessShortcut: "",
      quickEntryShortcut: "off",
      quickEntryDictationShortcut: "Command+Shift+Alt+Space",
    };
    const integration = new DesktopIntegration({
      window: () => undefined,
      settings: () => settings,
      conversations: () => [],
      command: () => assert.fail("must not open a new main-window chat"),
      trayIcon: "/nonexistent.png",
      quickEntry: () =>
        assert.fail("must start dictation, not toggle Quick Entry"),
      quickEntryDictation: (action) => actions.push(action),
    });
    integration.start();
    integration.apply();
    shortcuts.get(settings.quickEntryDictationShortcut)!();
    assert.deepEqual(actions, ["toggle"]);
    settings.quickAccessShortcut = settings.quickEntryDictationShortcut;
    assert.throws(() => integration.apply(), /used by another app/);
    settings.quickAccessShortcut = "";
    settings.quickEntryDictationShortcut = "off";
    integration.apply();
    assert.equal(shortcuts.size, 0);
    integration.stop();
  },
);

test("first-open voice commands wait until the renderer has installed its listeners", async () => {
  const { quick } = setup();
  const opening = quick.dictation("start");
  const [win] = windows;
  win.emit("ready-to-show");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(win.visible, false);
  handlers.get(quickEntryChannels.ready)!({
    sender: win.webContents,
    senderFrame: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(win.visible, false);
  await ready(win);
  await opening;
  assert.equal(win.visible, true);
  assert.deepEqual(win.webContents.sent.at(-1), [
    quickEntryChannels.dictation,
    "start",
  ]);
});

test("releasing Caps Lock during window startup cannot start a stale recording", async () => {
  const { quick } = setup();
  const opening = quick.dictation("start");
  const [win] = windows;
  await quick.dictation("stop");
  await ready(win);
  await opening;
  assert.equal(
    win.webContents.sent.some(
      ([channel]) => channel === quickEntryChannels.dictation,
    ),
    false,
  );
});

test("Quick Entry voice IPC accepts only its own top frame and voice methods", async () => {
  const calls: unknown[][] = [];
  const { quick } = setup(undefined, async (...args) => {
    calls.push(args);
    return true;
  });
  const opening = quick.toggle();
  const [win] = windows;
  await ready(win);
  await opening;
  const voice = invokeHandlers.get(quickEntryChannels.voice)!;
  const own = {
    sender: win.webContents,
    senderFrame: win.webContents.mainFrame,
  };
  assert.equal(await voice(own, "requestMicrophone"), true);
  assert.deepEqual(calls, [["requestMicrophone"]]);
  assert.throws(() => voice(own, "getSettings"));
  assert.throws(() => voice({ ...own, senderFrame: {} }, "startDictation"));
  assert.throws(() =>
    voice({ sender: new FakeContents(), senderFrame: {} }, "startDictation"),
  );
  assert.equal(calls.length, 1);
});

test("the main window closing takes the hidden composer with it", async () => {
  const { quick, main } = setup();
  const opening = quick.toggle();
  const [win] = windows;
  await ready(win);
  await opening;
  main.emit("closed");
  assert.ok(win.destroyed);
});

test("the Quick Entry shortcut setting brings up the composer", () => {
  shortcuts.clear();
  let asked = 0;
  const commands: string[] = [];
  const settings = {
    ...structuredClone(defaultSettings),
    quickAccessShortcut: "Alt+Space",
  };
  const integration = new DesktopIntegration({
    window: () => undefined,
    settings: () => settings,
    conversations: () => [],
    command: (command) => void commands.push(command),
    trayIcon: "/nonexistent.png",
    quickEntry: () => void asked++,
  });
  integration.start();
  integration.apply();
  shortcuts.get("Alt+Space")?.();
  assert.equal(asked, 1);
  assert.deepEqual(commands, []);
  // No shortcut set: nothing is registered.
  settings.quickAccessShortcut = "";
  integration.apply();
  assert.equal(shortcuts.size, 0);
});

test("Quick access and the explicit Quick Entry shortcut register independently", () => {
  shortcuts.clear();
  let opened = 0;
  const settings = {
    ...structuredClone(defaultSettings),
    quickAccessShortcut: "Control+Alt+Space",
    quickEntryShortcut: "Alt+Space",
  };
  const integration = new DesktopIntegration({
    window: () => undefined,
    settings: () => settings,
    conversations: () => [],
    command() {},
    trayIcon: "/nonexistent.png",
    quickEntry: () => {
      opened++;
    },
  });
  integration.start();
  integration.apply();
  assert.deepEqual([...shortcuts.keys()].sort(), [
    "Alt+Space",
    "Control+Alt+Space",
  ]);
  shortcuts.get("Alt+Space")!();
  shortcuts.get("Control+Alt+Space")!();
  assert.equal(opened, 2);
  settings.quickEntryShortcut = "off";
  integration.apply();
  assert.deepEqual([...shortcuts.keys()], ["Control+Alt+Space"]);
  settings.quickEntryShortcut = settings.quickAccessShortcut;
  integration.apply();
  settings.quickAccessShortcut = "";
  integration.apply();
  assert.deepEqual([...shortcuts.keys()], ["Control+Alt+Space"]);
  integration.stop();
  assert.equal(shortcuts.size, 0);
});

test("Quick Entry hands screenshots to the main composer only from its trusted top frame", async () => {
  const attachment = {
    id: "image",
    name: "screen.png",
    path: "/account/attachments/image/screen.png",
    size: 3,
    kind: "image" as const,
  };
  let stored = 0;
  const { quick, main, delivered } = setup((images) => {
    assert.equal(images[0].name, "screen.png");
    stored++;
    return [attachment];
  });
  const opening = quick.toggle();
  const [win] = windows;
  await ready(win);
  await opening;
  const submit = invokeHandlers.get(quickEntryChannels.submitImages)!;
  const images = [{ name: "screen.png", data: new Uint8Array([1, 2, 3]) }];
  assert.throws(() =>
    submit({ sender: win.webContents, senderFrame: {} }, "", images),
  );
  const event = {
    sender: win.webContents,
    senderFrame: win.webContents.mainFrame,
  };
  assert.throws(() =>
    submit(event, "", [{ name: "secret.txt", data: images[0].data }]),
  );
  assert.equal(stored, 0);
  submit(event, "", images);
  assert.equal(stored, 1);
  assert.equal(win.visible, false);
  assert.deepEqual(delivered, [
    [main, { type: "quick-entry", text: "", attachments: [attachment] }],
  ]);
});
