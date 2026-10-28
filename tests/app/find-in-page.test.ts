import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  findable,
  findBarBounds,
  findChannels,
  matchLabel,
} from "../../shared/find-in-page";
import {
  FindInPage,
  type FindBarView,
  type FindWindow,
} from "../../electron/app/find-in-page";
import { extraPageLocation } from "../../electron/extra-pages";
import { appMenuTemplate } from "../../electron/app/app-menu-template";

class FakePage extends EventEmitter {
  destroyed = false;
  focused = 0;
  searches: { text: string; options: unknown; id: number }[] = [];
  stops: string[] = [];
  next = 1;
  /** Matches each search reports; undefined: the page never answers. */
  matches: number | undefined = 4;
  isDestroyed() {
    return this.destroyed;
  }
  findInPage(text: string, options?: unknown) {
    const id = this.next++;
    this.searches.push({ text, options, id });
    const total = this.matches;
    if (total !== undefined)
      queueMicrotask(() => {
        // An early update, then the final one.
        this.emit("found-in-page", {}, { requestId: id, finalUpdate: false });
        this.emit(
          "found-in-page",
          {},
          {
            requestId: id,
            activeMatchOrdinal: total ? 1 : 0,
            matches: total,
            finalUpdate: true,
          },
        );
      });
    return id;
  }
  stopFindInPage(action: string) {
    this.stops.push(action);
  }
  focus() {
    this.focused++;
  }
}

class FakeWindow extends EventEmitter {
  destroyed = false;
  width = 1200;
  webContents = new FakePage();
  children: unknown[] = [];
  contentView = {
    addChildView: (view: unknown) => {
      this.children = [...this.children.filter((v) => v !== view), view];
    },
    removeChildView: (view: unknown) => {
      this.children = this.children.filter((v) => v !== view);
    },
  };
  isDestroyed() {
    return this.destroyed;
  }
  getContentBounds() {
    return { x: 0, y: 0, width: this.width, height: 800 };
  }
}

class FakeView implements FindBarView {
  bounds?: { x: number; y: number; width: number; height: number };
  visible = false;
  sent: [string, ...unknown[]][] = [];
  closed = false;
  focused = 0;
  webContents = {
    isDestroyed: () => this.closed,
    send: (channel: string, ...args: unknown[]) =>
      void this.sent.push([channel, ...args]),
    focus: () => void this.focused++,
    close: () => void (this.closed = true),
  };
  setBounds(bounds: { x: number; y: number; width: number; height: number }) {
    this.bounds = bounds;
  }
  setVisible(visible: boolean) {
    this.visible = visible;
  }
}

function setup() {
  const views: FakeView[] = [];
  const find = new FindInPage({
    createView: () => {
      const view = new FakeView();
      views.push(view);
      return view;
    },
  });
  const win = new FakeWindow();
  return { find, win, views, asWindow: win as unknown as FindWindow };
}

test("a query needs three characters, or one CJK character", () => {
  assert.equal(findable("ab"), false);
  assert.equal(findable("abc"), true);
  assert.equal(findable("中"), true);
  assert.equal(findable("あ"), true);
  assert.equal(findable("한"), true);
  assert.equal(matchLabel("ab", { active: 1, total: 2 }), "");
  assert.equal(matchLabel("abc", null), "");
  assert.equal(matchLabel("abc", { active: 3, total: 12 }), "3/12");
});

test("the bar sits 12px in from the top-right corner, below the title row", () => {
  assert.deepEqual(findBarBounds(1200), {
    x: 1200 - 320 - 12 - 16,
    y: 58 + 12 - 8,
    width: 352,
    height: 80,
  });
  // Other windows sit under a 40px row; the compact density is 40 tall.
  assert.deepEqual(findBarBounds(1200, 40, "compact").y, 40 + 12 - 8);
  assert.deepEqual(findBarBounds(1200, 40, "compact").height, 72);
  // A window narrower than the bar keeps it on screen.
  assert.equal(findBarBounds(200).x, 0);
});

test("opening lays the bar over the window and puts the cursor in it", () => {
  const { find, win, views, asWindow } = setup();
  find.open(asWindow);
  const [view] = views;
  assert.deepEqual(win.children, [view]);
  assert.ok(view.visible);
  assert.equal(view.bounds?.x, 1200 - 348);
  assert.equal(view.focused, 1);
  assert.deepEqual(view.sent, [[findChannels.focus]]);
  // Opening again reuses the bar and focuses it again.
  find.open(asWindow);
  assert.equal(views.length, 1);
  assert.equal(view.focused, 2);
  // It follows the window's width.
  win.width = 900;
  win.emit("resize");
  assert.equal(view.bounds?.x, 900 - 348);
});

test("a search answers with the final match count; later ones step", async () => {
  const { find, win, views, asWindow } = setup();
  find.open(asWindow);
  const sender = views[0].webContents;
  // Even a step starts a session when none is running.
  assert.deepEqual(
    await find.find(sender, "claudex", { findNext: false, forward: true }),
    { active: 1, total: 4 },
  );
  assert.deepEqual(
    await find.find(sender, "claudex", { findNext: false, forward: false }),
    { active: 1, total: 4 },
  );
  assert.deepEqual(
    win.webContents.searches.map((s) => s.options),
    [
      { forward: true, findNext: true },
      { forward: false, findNext: false },
    ],
  );
  // Too short to search: the highlights go and nothing is searched.
  assert.deepEqual(await find.find(sender, "ab", { findNext: true }), {
    active: 0,
    total: 0,
  });
  assert.equal(win.webContents.searches.length, 2);
  assert.deepEqual(win.webContents.stops, ["clearSelection"]);
});

test("only the open bar's own page is answered", async () => {
  const { find, win, views, asWindow } = setup();
  const stranger = new FakeView().webContents;
  assert.deepEqual(await find.find(stranger, "claudex", { findNext: true }), {
    active: 0,
    total: 0,
  });
  find.open(asWindow);
  assert.equal(find.windowOf(stranger), undefined);
  assert.equal(find.windowOf(views[0].webContents), asWindow);
  find.closeFrom(stranger);
  assert.ok(find.isOpen(asWindow));
  // A closed bar is not answered either.
  find.close(asWindow);
  assert.equal(find.windowOf(views[0].webContents), undefined);
  assert.equal(win.webContents.searches.length, 0);
});

test("closing clears the highlights and gives the page the keyboard back", () => {
  const { find, win, views, asWindow } = setup();
  find.open(asWindow);
  find.closeFrom(views[0].webContents);
  assert.equal(views[0].visible, false);
  assert.deepEqual(win.webContents.stops, ["clearSelection"]);
  assert.equal(win.webContents.focused, 1);
  assert.deepEqual(views[0].sent.at(-1), [findChannels.clear]);
  assert.equal(find.isOpen(asWindow), false);
});

test("Escape in the page and a navigation close the bar", () => {
  const { find, win, asWindow } = setup();
  find.open(asWindow);
  let prevented = false;
  const escape = {
    type: "keyDown",
    key: "Escape",
    isAutoRepeat: false,
    shift: false,
    control: false,
    alt: false,
    meta: false,
  };
  win.webContents.emit(
    "before-input-event",
    { preventDefault: () => (prevented = true) },
    { ...escape, meta: true },
  );
  assert.ok(find.isOpen(asWindow), "Cmd+Escape is not Escape");
  win.webContents.emit(
    "before-input-event",
    { preventDefault: () => (prevented = true) },
    escape,
  );
  assert.ok(prevented);
  assert.equal(find.isOpen(asWindow), false);
  find.open(asWindow);
  win.webContents.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: true,
  });
  assert.ok(find.isOpen(asWindow), "an in-page navigation keeps it");
  win.webContents.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: false,
  });
  assert.equal(find.isOpen(asWindow), false);
});

test("Find Next steps an open bar and opens a closed one", () => {
  const { find, views, asWindow } = setup();
  find.step(asWindow, true);
  assert.ok(find.isOpen(asWindow));
  find.step(asWindow, false);
  assert.deepEqual(views[0].sent.at(-1), [findChannels.step, false]);
});

test("a closed window takes its bar with it", () => {
  const { find, win, views, asWindow } = setup();
  find.open(asWindow);
  win.emit("closed");
  assert.ok(views[0].closed);
  assert.equal(win.webContents.listenerCount("before-input-event"), 0);
  assert.equal(find.isOpen(asWindow), false);
});

test("a page that never answers counts as no matches", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { find, win, views, asWindow } = setup();
  win.webContents.matches = undefined;
  find.open(asWindow);
  const answer = find.find(views[0].webContents, "claudex", {
    findNext: true,
  });
  t.mock.timers.tick(5000);
  assert.deepEqual(await answer, { active: 0, total: 0 });
  assert.equal(win.webContents.listenerCount("found-in-page"), 0);
});

test("the extra pages load from the dev server or the build", () => {
  assert.deepEqual(
    extraPageLocation(
      "find.html",
      "/app/dist-electron",
      "http://127.0.0.1:5173",
    ),
    { url: "http://127.0.0.1:5173/find.html" },
  );
  assert.deepEqual(extraPageLocation("find.html", "/app/dist-electron", ""), {
    file: "/app/dist/find.html",
  });
});

type Item = {
  label?: string;
  role?: string;
  type?: string;
  enabled?: boolean;
  accelerator?: string;
  registerAccelerator?: boolean;
  submenu?: Item[];
  click?: (item: unknown, window?: unknown) => void;
};

function menuWithFind(mac: boolean, calls: unknown[]) {
  return appMenuTemplate({
    mac,
    appName: "Claudex",
    run: () => {},
    checkForUpdates: () => {},
    showMainWindow: () => {},
    find: {
      open: (window) => void calls.push(["open", window]),
      step: (window, forward) => void calls.push(["step", window, forward]),
    },
  }) as Item[];
}
const findItems = (menu: Item[]) => {
  const edit = menu.find((item) => item.label === "Edit")?.submenu ?? [];
  return edit.find((item) => item.label === "Find")?.submenu ?? [];
};

test("Edit ▸ Find… works with the original's shortcuts on both systems", () => {
  for (const mac of [true, false]) {
    const calls: unknown[] = [];
    const items = findItems(menuWithFind(mac, calls));
    assert.deepEqual(
      items.map((item) => [item.label ?? item.type, item.accelerator]),
      [
        ["Find…", "CmdOrCtrl+F"],
        ["Find Next", "CmdOrCtrl+G"],
        ["Find Previous", "CmdOrCtrl+Shift+G"],
        ["separator", undefined],
        ["Find in Files…", undefined],
      ],
    );
    for (const item of items.slice(0, 3)) {
      assert.notEqual(item.enabled, false);
      // The page has no find keys of its own: the menu registers them.
      assert.notEqual(item.registerAccelerator, false);
    }
    assert.equal(items[4].enabled, false);
    const win = { id: 1 };
    items[0].click?.({}, win);
    items[1].click?.({}, win);
    items[2].click?.({}, win);
    assert.deepEqual(calls, [
      ["open", win],
      ["step", win, true],
      ["step", win, false],
    ]);
  }
});

test("without find in page the find items stay greyed", () => {
  const menu = appMenuTemplate({
    mac: false,
    appName: "Claudex",
    run: () => {},
    checkForUpdates: () => {},
    showMainWindow: () => {},
  }) as Item[];
  const items = findItems(menu).slice(0, 3);
  for (const item of items) {
    assert.equal(item.enabled, false);
    assert.equal(item.registerAccelerator, false);
  }
});
