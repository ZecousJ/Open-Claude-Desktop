/**
 * Separate conversation windows (R2-B): one window per conversation,
 * placement on screen, remembered geometry, handoffs, Return, pinning,
 * visibility events and closing when the conversation is gone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { BrowserWindow, Rectangle } from "electron";
import type { AppEvent } from "../../shared/types";
import {
  ChatWindows,
  type ChatWindowConversation,
  type ChatWindowsHost,
  type CheckedHandoff,
} from "../../electron/app/chat-windows";
import { clampToDisplays } from "../../electron/app/chat-windows-support";
import { readChatWindowState } from "../../electron/app/chat-windows-support";
import { defaultChatWindowSize } from "../../electron/app/chat-windows-support";

class FakeWindow extends EventEmitter {
  destroyed = false;
  minimized = false;
  maximized = false;
  pinned = false;
  focused = 0;
  shown = 0;
  inactive = 0;
  bounds: Rectangle;
  webContents = { id: Math.random() };
  constructor(public options: Record<string, any>) {
    super();
    this.bounds = {
      x: options.x ?? 100,
      y: options.y ?? 100,
      width: options.width,
      height: options.height,
    };
  }
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return this.minimized;
  }
  isMaximized() {
    return this.maximized;
  }
  isFullScreen() {
    return false;
  }
  restore() {
    this.minimized = false;
  }
  show() {
    this.shown++;
  }
  showInactive() {
    this.inactive++;
  }
  focus() {
    this.focused++;
  }
  getBounds() {
    return { ...this.bounds };
  }
  getNormalBounds() {
    return { ...this.bounds };
  }
  getContentSize() {
    return [this.bounds.width, this.bounds.height];
  }
  setAlwaysOnTop(on: boolean) {
    this.pinned = on;
  }
  isAlwaysOnTop() {
    return this.pinned;
  }
  close() {
    if (this.destroyed) return;
    this.emit("close");
    this.destroyed = true;
    this.emit("closed");
  }
  destroy() {
    this.destroyed = true;
    this.emit("closed");
  }
}

function setup(
  options: {
    conversations?: Record<string, ChatWindowConversation>;
    workAreas?: Rectangle[];
    statePath?: string;
    layoutPath?: string;
    projects?: Record<string, { name: string }>;
    load?: (win: FakeWindow) => Promise<void>;
  } = {},
) {
  const conversations = options.conversations ?? {
    "c-1": { title: "First" },
    "c-2": { title: "Second" },
    "c-secret": { title: "Private", incognito: true },
  };
  const created: FakeWindow[] = [];
  const registered: { win: FakeWindow; role: unknown }[] = [];
  const loaded: { win: FakeWindow; query?: Record<string, string> }[] = [];
  const sent: { win: FakeWindow; event: AppEvent }[] = [];
  const pushed: AppEvent[] = [];
  const main = new FakeWindow({ width: 1600, height: 972, x: 0, y: 0 });
  const host: ChatWindowsHost = {
    createWindow: (opts) => {
      const win = new FakeWindow(opts as Record<string, any>);
      created.push(win);
      return win as unknown as BrowserWindow;
    },
    windows: {
      main: () => main as unknown as BrowserWindow,
      focused: () => undefined,
      register: (win, role) =>
        registered.push({ win: win as unknown as FakeWindow, role }),
      load: async (win, query) => {
        loaded.push({ win: win as unknown as FakeWindow, query });
        await options.load?.(win as unknown as FakeWindow);
      },
      send: (win, event) =>
        sent.push({ win: win as unknown as FakeWindow, event }),
      webPreferences: () => ({ preload: "/app/preload.cjs", sandbox: true }),
    },
    push: (event) => pushed.push(event),
    workAreas: () =>
      options.workAreas ?? [{ x: 0, y: 25, width: 1512, height: 920 }],
    statePath: () => options.statePath,
    layoutPath: () => options.layoutPath,
    platform: "darwin",
    dark: () => true,
    conversation: (id) => conversations[id],
    project: (id) => options.projects?.[id],
    sweepMs: 60_000,
  };
  const windows = new ChatWindows(host);
  return {
    windows,
    created,
    registered,
    loaded,
    sent,
    pushed,
    main,
    conversations,
  };
}

test("restores the account's complete conversation and pane pop-out layout after quitting", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-popout-layout-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "layout.json");
  const original = setup({ layoutPath: file });
  await original.windows.openConversation("c-1");
  await original.windows.openConversation("c-1", undefined, "browser");
  await original.windows.openConversation("c-2", undefined, "terminal");
  original.created[1].bounds = { x: 210, y: 180, width: 800, height: 600 };
  original.windows.setPinned(asWindow(original.created[1]), true);
  original.windows.preserveLayout();
  original.windows.closeAll();
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.windows.length, 3);
  assert.doesNotMatch(
    fs.readFileSync(file, "utf8"),
    /First|Second|attachments/,
  );
  const restored = setup({ layoutPath: file });
  await restored.windows.restoreLayout();
  assert.equal(restored.created.length, 3);
  assert.deepEqual(restored.windows.conversationIds(), ["c-1", "c-2"]);
  assert.deepEqual(
    restored.loaded.map((entry) => entry.query?.pane),
    [undefined, "browser", "terminal"],
  );
  assert.equal(restored.created[1].pinned, true);
  assert.deepEqual(restored.created[1].bounds, original.created[1].bounds);
  restored.created[1].close();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).windows.length, 2);
  restored.windows.closeAll();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).windows.length, 0);
});

test("restoration skips deleted and private sessions, clamps bounds, and is account-scoped", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-popout-filter-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "account-a.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      windows: ["missing", "c-secret", "c-1"].map((conversationId) => ({
        conversationId,
        bounds: { x: 90000, y: 90000, width: 900, height: 700 },
        alwaysOnTop: false,
      })),
    }),
  );
  const restored = setup({ layoutPath: file });
  await restored.windows.restoreLayout();
  assert.equal(restored.created.length, 1);
  assert.ok(restored.created[0].bounds.x < 1512);
  restored.windows.closeAll();
  const other = setup({ layoutPath: path.join(root, "account-b.json") });
  await other.windows.restoreLayout();
  assert.equal(other.created.length, 0);
});

const asWindow = (win: FakeWindow) => win as unknown as BrowserWindow;
test("project pop-outs restore bounds and pinning and close when deleted", async (context) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-project-layout-"),
  );
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "session-popouts.json");
  const projects: Record<string, { name: string }> = {
    "p-1": { name: "Project" },
  };
  const original = setup({ layoutPath: file, projects });
  await original.windows.openProject("p-1");
  await original.windows.openProject("p-1");
  assert.equal(original.created.length, 1);
  original.created[0].bounds = { x: 190, y: 170, width: 800, height: 600 };
  original.windows.setPinned(asWindow(original.created[0]), true);
  original.windows.preserveLayout();
  original.windows.closeAll();
  const restored = setup({ layoutPath: file, projects });
  await restored.windows.restoreLayout();
  assert.deepEqual(restored.loaded[0].query, { window: "project", id: "p-1" });
  assert.deepEqual(restored.created[0].bounds, original.created[0].bounds);
  assert.equal(restored.created[0].pinned, true);
  assert.deepEqual(restored.windows.conversationIds(), []);
  assert.deepEqual(restored.windows.layoutState(), {
    popoutSessionIds: [],
    visibleSessionIds: [],
    otherPopoutCount: 1,
  });
  delete projects["p-1"];
  restored.windows.sweep();
  assert.equal(restored.created[0].destroyed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).projects, []);
});
test("tool panes open in independent windows and repeated opens focus the same pane", async () => {
  const fixture = setup();
  await fixture.windows.openConversation("c-1", undefined, "browser");
  await fixture.windows.openConversation("c-1", undefined, "terminal");
  await fixture.windows.openConversation("c-1");
  assert.equal(fixture.created.length, 3);
  assert.equal(fixture.loaded[0].query?.pane, "browser");
  assert.equal(fixture.loaded[1].query?.pane, "terminal");
  await fixture.windows.openConversation("c-1", undefined, "browser");
  assert.equal(fixture.created.length, 3);
  assert.deepEqual(fixture.windows.conversationIds(), ["c-1"]);
  fixture.windows.reportVisibility(asWindow(fixture.created[0]), true);
  fixture.windows.reportVisibility(asWindow(fixture.created[1]), true);
  assert.deepEqual(
    fixture.pushed.filter((event) => event.type === "window-visibility").at(-1),
    {
      type: "window-visibility",
      conversationIds: ["c-1"],
    },
  );
  fixture.windows.closeAll();
  assert.deepEqual(
    fixture.pushed.filter(
      (event) => event.type === "conversation-window-closed",
    ),
    [{ type: "conversation-window-closed", conversationId: "c-1" }],
  );
});

test("layout commands can open a window without stealing focus", async () => {
  const fixture = setup();
  await fixture.windows.openConversation(
    "c-1",
    undefined,
    undefined,
    undefined,
    true,
  );
  assert.equal(fixture.created[0].options.show, false);
  assert.equal(fixture.created[0].inactive, 1);
  await fixture.windows.openConversation(
    "c-1",
    undefined,
    undefined,
    undefined,
    true,
  );
  assert.equal(fixture.created[0].focused, 0);
  fixture.windows.closeAll();
});
const handoff = (text: string): CheckedHandoff => ({
  text,
  attachmentIds: [],
  attachments: [],
});

test("opens one window per conversation with the main window's renderer settings", async () => {
  const t = setup();
  await t.windows.openConversation("c-1");
  assert.equal(t.created.length, 1);
  const [win] = t.created;
  assert.deepEqual(t.registered[0].role, {
    kind: "conversation",
    conversationId: "c-1",
  });
  assert.deepEqual(t.loaded[0].query, { window: "conversation", id: "c-1" });
  assert.equal(win.options.title, "First");
  assert.equal(win.options.width, defaultChatWindowSize.width);
  assert.equal(win.options.height, defaultChatWindowSize.height);
  assert.equal(win.options.minWidth, 480);
  assert.equal(win.options.minHeight, 400);
  assert.equal(win.options.titleBarStyle, "hiddenInset");
  assert.deepEqual(win.options.trafficLightPosition, { x: 17, y: 17 });
  assert.equal(win.options.backgroundColor, "#151515");
  assert.deepEqual(win.options.webPreferences, {
    preload: "/app/preload.cjs",
    sandbox: true,
  });
  // A second open focuses the same window.
  win.minimized = true;
  await t.windows.openConversation("c-1");
  assert.equal(t.created.length, 1);
  assert.equal(win.minimized, false);
  assert.equal(win.focused, 1);
  assert.deepEqual(t.windows.conversationIds(), ["c-1"]);
  assert.equal(t.windows.forConversation("c-1"), asWindow(win));
  assert.equal(t.windows.conversationOf(asWindow(win)), "c-1");
  assert.equal(t.windows.conversationOf(asWindow(t.main)), undefined);
});

test("refuses conversations that are missing or incognito", async () => {
  const t = setup();
  await assert.rejects(t.windows.openConversation("c-9"), /isn't available/);
  await assert.rejects(
    t.windows.openConversation("c-secret"),
    /isn't available/,
  );
  assert.equal(t.created.length, 0);
});

test("a window that fails to load is closed and forgotten", async () => {
  const t = setup({
    load: async () => {
      throw new Error("load failed");
    },
  });
  await assert.rejects(t.windows.openConversation("c-1"), /load failed/);
  assert.equal(t.created[0].destroyed, true);
  assert.deepEqual(t.windows.conversationIds(), []);
});

test("a new window cascades off the newest one and stays on screen", async () => {
  const t = setup();
  await t.windows.openConversation("c-1");
  t.created[0].bounds = { x: 1000, y: 400, width: 900, height: 700 };
  await t.windows.openConversation("c-2");
  const second = t.created[1].options;
  // 1024 + 900 would leave the display: moved back inside it.
  assert.equal(second.x, 1512 - 900);
  assert.equal(second.y, 945 - 700);
});

test("clampToDisplays pulls off-screen windows back and shrinks oversized ones", () => {
  const primary = { x: 0, y: 25, width: 1512, height: 920 };
  const right = { x: 1512, y: 0, width: 1920, height: 1055 };
  // Off every display: onto the primary one.
  assert.deepEqual(
    clampToDisplays({ x: -5000, y: 3000, width: 900, height: 700 }, [
      primary,
      right,
    ]),
    { x: 0, y: 245, width: 900, height: 700 },
  );
  // Mostly on the second display: kept there.
  assert.deepEqual(
    clampToDisplays({ x: 1400, y: 100, width: 900, height: 700 }, [
      primary,
      right,
    ]),
    { x: 1512, y: 100, width: 900, height: 700 },
  );
  // Larger than the display: fits it.
  assert.deepEqual(
    clampToDisplays({ x: 0, y: 0, width: 3000, height: 2000 }, [primary]),
    primary,
  );
  // A sliver on the right display is not enough to count: the primary one.
  assert.deepEqual(
    clampToDisplays({ x: 3400, y: 100, width: 900, height: 700 }, [
      primary,
      right,
    ]),
    { x: 1512 - 900, y: 100, width: 900, height: 700 },
  );
});

test("remembers the last window's geometry only, and ignores a broken file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-windows-"));
  const file = path.join(dir, "chat-windows.json");
  const t = setup({ statePath: file });
  await t.windows.openConversation("c-1");
  t.created[0].bounds = { x: 300, y: 200, width: 1000, height: 800 };
  t.created[0].close();
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(saved, {
    version: 1,
    last: { x: 300, y: 200, width: 1000, height: 800 },
  });
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /c-1|First/);
  // The next window opens where the last one closed.
  await t.windows.openConversation("c-2");
  assert.equal(t.created[1].options.x, 300);
  assert.equal(t.created[1].options.width, 1000);

  fs.writeFileSync(file, "{not json");
  assert.equal(readChatWindowState(file), undefined);
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, last: { x: 0, y: 0, width: 10, height: 10 } }),
  );
  assert.equal(readChatWindowState(file), undefined);
  assert.equal(readChatWindowState(undefined), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a handoff is taken once, by the window it was handed to", async () => {
  const t = setup();
  await t.windows.openConversation("c-1", handoff("draft"));
  const win = asWindow(t.created[0]);
  assert.equal(t.windows.takeHandoff(asWindow(t.main)), null);
  assert.equal(t.windows.takeHandoff(win)?.text, "draft");
  assert.equal(t.windows.takeHandoff(win), null);
  // A later draft does not reach a window that already read its handoff.
  await t.windows.openConversation("c-1", handoff("again"));
  assert.equal(t.windows.takeHandoff(win), null);
  assert.equal(t.windows.takeHandoff(undefined), null);
});

test("Return closes the window and has the main window open the conversation", async () => {
  const t = setup();
  await t.windows.openConversation("c-1");
  const win = t.created[0];
  assert.equal(t.windows.returnToMain(asWindow(win), handoff("back")), true);
  assert.equal(win.destroyed, true);
  assert.equal(t.main.focused, 1);
  assert.deepEqual(t.sent, [
    {
      win: t.main,
      event: {
        type: "command",
        command: "open-conversation",
        conversationId: "c-1",
      },
    },
  ]);
  assert.deepEqual(t.windows.conversationIds(), []);
  // The draft waits for the main window, once.
  assert.equal(t.windows.takeHandoff(asWindow(t.main))?.text, "back");
  assert.equal(t.windows.takeHandoff(asWindow(t.main)), null);
  // The main window has no Return.
  assert.equal(t.windows.returnToMain(asWindow(t.main)), false);
});

test("pinning acts on separate windows only", async () => {
  const t = setup();
  await t.windows.openConversation("c-1");
  const win = asWindow(t.created[0]);
  assert.equal(t.windows.setPinned(win, true), true);
  assert.equal(t.created[0].pinned, true);
  assert.equal(t.windows.setPinned(win, false), false);
  assert.equal(t.windows.setPinned(asWindow(t.main), true), false);
  assert.equal(t.main.pinned, false);
});

test("visibility reaches every window as the set of visible conversations", async () => {
  const t = setup();
  await t.windows.openConversation("c-1");
  await t.windows.openConversation("c-2");
  const [one, two] = t.created;
  t.windows.reportVisibility(asWindow(one), true);
  t.windows.reportVisibility(asWindow(one), true);
  t.windows.reportVisibility(asWindow(two), true);
  one.emit("minimize");
  two.close();
  t.windows.reportVisibility(asWindow(t.main), true);
  assert.deepEqual(
    t.pushed
      .filter((event) => event.type === "window-visibility")
      .map((event) => event.conversationIds),
    [["c-1"], ["c-1", "c-2"], ["c-2"], []],
  );
});

test("a window that closes tells the main window, for Reopen Closed Session", async () => {
  const t = setup();
  await t.windows.openConversation("c-1");
  await t.windows.openConversation("c-2");
  t.created[1].close();
  assert.deepEqual(
    t.pushed.filter((event) => event.type === "conversation-window-closed"),
    [{ type: "conversation-window-closed", conversationId: "c-2" }],
  );
});

test("windows close when their conversation is deleted, and all close together", async () => {
  const t = setup();
  await t.windows.openConversation("c-1");
  await t.windows.openConversation("c-2");
  delete (t.conversations as Record<string, unknown>)["c-1"];
  t.windows.sweep();
  assert.equal(t.created[0].destroyed, true);
  assert.equal(t.created[1].destroyed, false);
  t.windows.closeFor("c-2");
  assert.equal(t.created[1].destroyed, true);
  await t.windows.openConversation("c-2");
  t.windows.closeAll();
  assert.equal(t.created[2].destroyed, true);
  assert.deepEqual(t.windows.conversationIds(), []);
});

test("focusConversation and showMain bring the right window forward", async () => {
  const t = setup();
  assert.equal(t.windows.focusConversation("c-1"), false);
  await t.windows.openConversation("c-1");
  assert.equal(t.windows.focusConversation("c-1"), true);
  assert.equal(t.created[0].focused, 1);
  t.main.minimized = true;
  assert.equal(
    t.windows.showMain({ type: "command", command: "settings" }),
    true,
  );
  assert.equal(t.main.minimized, false);
  assert.deepEqual(t.sent.at(-1)?.event, {
    type: "command",
    command: "settings",
  });
});
