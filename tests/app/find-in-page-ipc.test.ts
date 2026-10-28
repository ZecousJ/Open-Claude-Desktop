/**
 * Find in page's IPC as the app wires it (electron/find-in-page-main.ts):
 * the bar's view is sandboxed with its own preload, and its channels answer
 * only the open bar's own top frame, with checked arguments. Electron is
 * replaced by a fake module.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";

const handlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => unknown
>();
const views: FakeContentsView[] = [];

class FakeContents extends EventEmitter {
  mainFrame = { name: "main" };
  loaded = "";
  closed = false;
  sent: unknown[][] = [];
  openHandler?: () => unknown;
  setWindowOpenHandler(handler: () => unknown) {
    this.openHandler = handler;
  }
  async loadURL(url: string) {
    this.loaded = url;
  }
  async loadFile(file: string) {
    this.loaded = file;
  }
  send(...args: unknown[]) {
    this.sent.push(args);
  }
  focus() {}
  isDestroyed() {
    return this.closed;
  }
  close() {
    this.closed = true;
  }
}
class FakeContentsView {
  webContents = new FakeContents();
  background = "";
  visible = true;
  constructor(public options: { webPreferences: Record<string, unknown> }) {
    views.push(this);
  }
  setBackgroundColor(color: string) {
    this.background = color;
  }
  setVisible(visible: boolean) {
    this.visible = visible;
  }
  setBounds() {}
}
(globalThis as any).__fakeElectron = {
  WebContentsView: FakeContentsView,
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
      handlers.set(channel, fn),
  },
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron")
      return {
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "const e = globalThis.__fakeElectron; export default e;",
          ),
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});

const { startFindInPage } =
  await import("../../electron/app/find-in-page-main");
const { findChannels } = await import("../../shared/find-in-page");

class FakePage extends EventEmitter {
  isDestroyed = () => false;
  findInPage(_text: string) {
    queueMicrotask(() =>
      this.emit(
        "found-in-page",
        {},
        { requestId: 7, activeMatchOrdinal: 2, matches: 3, finalUpdate: true },
      ),
    );
    return 7;
  }
  stopFindInPage() {}
  focus() {}
}
const win = Object.assign(new EventEmitter(), {
  webContents: new FakePage(),
  contentView: { addChildView() {}, removeChildView() {} },
  isDestroyed: () => false,
  getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
});

test("find in page answers only its open bar, from the bar's top frame", async () => {
  delete process.env.CLAUDEX_DEV_URL;
  const actions = startFindInPage({
    appWindows: {
      all: () => [win as never],
      focused: () => undefined,
      main: () => win as never,
    },
    dirname: "/app/dist-electron",
  });
  const find = handlers.get(findChannels.find)!;
  // No bar yet: nothing answers.
  const stranger = new FakeContents();
  assert.throws(
    () =>
      find({ sender: stranger, senderFrame: stranger.mainFrame }, "claudex", {
        findNext: true,
      }),
    /Untrusted IPC sender/,
  );
  actions.open();
  const [view] = views;
  // The bar's page: sandboxed, isolated, its own preload, transparent.
  assert.deepEqual(view.options.webPreferences, {
    preload: "/app/dist-electron/find-preload.cjs",
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  });
  assert.equal(view.background, "#00000000");
  assert.equal(view.webContents.loaded, "/app/dist/find.html");
  assert.deepEqual(view.webContents.openHandler?.(), { action: "deny" });
  const bar = view.webContents;
  assert.deepEqual(
    await find({ sender: bar, senderFrame: bar.mainFrame }, "claudex", {
      findNext: true,
    }),
    { active: 2, total: 3 },
  );
  // A frame inside the bar's page is not the bar.
  assert.throws(
    () =>
      find({ sender: bar, senderFrame: { name: "child" } }, "claudex", {
        findNext: true,
      }),
    /Untrusted IPC sender/,
  );
  // Arguments are checked.
  assert.throws(() =>
    find({ sender: bar, senderFrame: bar.mainFrame }, 42, { findNext: true }),
  );
  assert.throws(() =>
    find({ sender: bar, senderFrame: bar.mainFrame }, "claudex", {
      findNext: true,
      extra: 1,
    }),
  );
  assert.throws(() =>
    find({ sender: bar, senderFrame: bar.mainFrame }, "x".repeat(1001), {
      findNext: true,
    }),
  );
  // Close from the bar hides it; then it is not answered any more.
  handlers.get(findChannels.close)!({
    sender: bar,
    senderFrame: bar.mainFrame,
  });
  assert.equal(view.visible, false);
  assert.throws(
    () =>
      find({ sender: bar, senderFrame: bar.mainFrame }, "claudex", {
        findNext: true,
      }),
    /Untrusted IPC sender/,
  );
});
