/** Original sidebar producer/consumer + real host helper/menu template; synthetic windows only. */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {
  observeOfficialAppMenu,
  registerOfficialAppMenu,
  officialSidebarMenuState,
  toggleOfficialWindowSidebar,
  onOfficialMenuState,
} from "../electron/official-ui/native/app-menu";
import { appMenuTemplate } from "../electron/app/app-menu-template";
import { initialMenuState } from "../shared/menu-state";
function fixture() {
  let active = true,
    dead = false,
    toggles = 0;
  const wc = Object.assign(new EventEmitter(), {
    mainFrame: { url: "http://127.0.0.1:12345/chat/inert" },
    isDestroyed: () => dead,
  });
  const win: any = { webContents: wc, isDestroyed: () => dead };
  let event: (source: string) => void = () => {};
  const off = observeOfficialAppMenu(
    win,
    {
      origin: "http://127.0.0.1:12345",
      current: () => active,
      log() {},
      openSettings() {},
      toggleSidebar() {
        toggles++;
        event("menu");
      },
    },
    "linux",
  );
  const handlers = new Map<string, Function>();
  const host: any = {
    caller: win,
    on: (name: string, fn: Function) => handlers.set(name, fn),
  };
  registerOfficialAppMenu(host, () => ({ popup() {} }));
  return {
    win,
    wc,
    host,
    off,
    report: handlers.get("WindowControl.reportSidebarMenuState")!,
    retire: () => (active = false),
    destroy: () => (dead = true),
    get toggles() {
      return toggles;
    },
    setEvent: (fn: (source: string) => void) => (event = fn),
  };
}
function menu(win: any) {
  const template: any = appMenuTemplate({
    mac: false,
    appName: "Inert",
    run() {},
    checkForUpdates() {},
    showMainWindow() {},
    openHelp() {},
    state: { ...initialMenuState, ...officialSidebarMenuState(win) },
  } as any);
  return template
    .find((x: any) => x.label === "View")
    .submenu.find((x: any) => x.label === "Sidebar");
}
function originalFunctions() {
  const file =
      ".restore/archive-extracted/claude-frontend-4.4212.0/dist/assets/v1/shared-22-Ciy9U3_0.js",
    source = fs.readFileSync(file, "utf8"),
    ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return ["pZ", "BH", "RJ", "pm"]
    .map((name) => {
      const node = ast.statements.find(
        (n) => ts.isFunctionDeclaration(n) && n.name?.text === name,
      );
      assert.ok(node);
      return node.getText(ast);
    })
    .join("\n");
}
test("original report changes actual menu checkbox and original MenuEvents consumer toggles exactly once", () => {
  const f = fixture();
  try {
    const actions: string[] = [],
      cleanups: Function[] = [];
    const context: any = vm.createContext({
      M9: {
        reportSidebarMenuState: (state: any) => {
          f.report(state);
          return Promise.resolve();
        },
      },
      Q3: () => false,
      Nd: () => false,
      iG: (source: string) => () => actions.push(source),
      J9: () => [],
      J2: () => true,
      K3: () => {},
      J0: () => true,
      K0: (_m: any, _i: any, a: any) => a,
      Gw: (effect: Function) => {
        const dispose = effect();
        if (typeof dispose === "function") cleanups.push(dispose);
      },
      Np: {
        onToggleSidebar: (fn: (source: string) => void) => {
          f.setEvent(fn);
          return () => f.setEvent(() => {});
        },
      },
      wn: () => true,
      tU: "#inert-dialog",
      _w: { Menu: "menu" },
    });
    vm.runInContext(originalFunctions(), context);
    assert.equal(menu(f.win).enabled, false);
    context.BH(false);
    assert.equal(menu(f.win).checked, false);
    assert.equal(menu(f.win).enabled, true);
    assert.equal(toggleOfficialWindowSidebar(f.win), true);
    assert.deepEqual(actions, ["menu"]);
    assert.equal(f.toggles, 1);
    context.pZ(true, true);
    assert.equal(menu(f.win).checked, true);
    for (const dispose of cleanups) dispose();
    assert.equal(menu(f.win).enabled, false);
  } finally {
    f.off();
  }
});
test("strict report, disabled state and duplicate report do not invent updates or toggle", () => {
  const f = fixture();
  let changed = 0;
  const off = onOfficialMenuState(() => changed++);
  try {
    for (const raw of [
      undefined,
      null,
      [],
      {},
      { enabled: true },
      { enabled: true, open: 0 },
      { enabled: true, open: false, windowId: 1 },
    ])
      assert.throws(() => f.report(raw));
    assert.throws(() => f.report({ enabled: true, open: false }, "extra"));
    assert.equal(changed, 0);
    f.report({ enabled: false, open: false });
    f.report({ enabled: false, open: false });
    assert.equal(changed, 1);
    assert.equal(toggleOfficialWindowSidebar(f.win), true);
    assert.equal(f.toggles, 0);
    assert.equal(menu(f.win).enabled, false);
  } finally {
    off();
    f.off();
  }
});
test("reload clears old report until current document reports; windows remain isolated and stale official never falls back", () => {
  const f = fixture(),
    other = fixture();
  try {
    f.report({ enabled: true, open: true });
    other.report({ enabled: true, open: false });
    assert.equal(menu(f.win).checked, true);
    assert.equal(menu(other.win).checked, false);
    f.wc.emit(
      "did-start-navigation",
      {},
      "http://127.0.0.1:12345/chat/inert",
      false,
      true,
    );
    assert.equal(menu(f.win).enabled, false);
    assert.equal(toggleOfficialWindowSidebar(f.win), true);
    assert.equal(f.toggles, 0);
    // A valid original effect may report before dom-ready; no extra protocol gate.
    f.report({ enabled: true, open: false });
    assert.equal(menu(f.win).checked, false);
    f.retire();
    assert.throws(() => f.report({ enabled: true, open: true }));
    assert.equal(toggleOfficialWindowSidebar(f.win), true);
    assert.equal(f.toggles, 0);
    assert.equal(menu(other.win).enabled, true);
    assert.equal(officialSidebarMenuState({} as any), undefined);
    assert.equal(toggleOfficialWindowSidebar({} as any), false);
  } finally {
    f.off();
    other.off();
  }
  assert.equal(f.wc.listenerCount("did-start-navigation"), 0);
  assert.equal(f.wc.listenerCount("dom-ready"), 0);
  assert.equal(toggleOfficialWindowSidebar(f.win), true);
});
test("foreign, destroyed and caller-less reports are refused; stale disposer cannot clear newer binding", () => {
  for (const mode of ["foreign", "destroy", "missing"]) {
    const f = fixture();
    try {
      if (mode === "foreign") f.wc.mainFrame.url = "https://other.invalid/";
      if (mode === "destroy") f.destroy();
      if (mode === "missing") f.host.caller = undefined;
      assert.throws(() => f.report({ enabled: true, open: true }));
      assert.equal(f.toggles, 0);
    } finally {
      f.off();
    }
  }
  const f = fixture();
  const next = observeOfficialAppMenu(
    f.win,
    {
      origin: "http://127.0.0.1:12345",
      current: () => true,
      log() {},
      openSettings() {},
    },
    "linux",
  );
  f.report({ enabled: true, open: false });
  f.off();
  assert.equal(menu(f.win).enabled, true);
  assert.equal(f.wc.listenerCount("did-start-navigation"), 1);
  next();
  assert.equal(menu(f.win).enabled, false);
});

test("original preload carries exact sidebar report and menu event channels with cleanup", () => {
  const file =
      ".restore/archive-extracted/claude-frontend-4.4212.0/reference/desktop-main/mainView.js",
    source = fs.readFileSync(file, "utf8"),
    ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const methods = new Map<string, string>();
  function visit(node: ts.Node) {
    if (
      ts.isMethodDeclaration(node) &&
      ["reportSidebarMenuState", "onToggleSidebar"].includes(
        node.name.getText(ast),
      )
    )
      methods.set(node.name.getText(ast), node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(methods.size, 2);
  const ipc = new EventEmitter(),
    prefix = "synthetic-prefix-",
    calls: any[] = [];
  const preload: any = vm.runInNewContext(
    "({" + [...methods.values()].join(",") + "})",
    {
      Y: prefix,
      t: {
        ipcRenderer: {
          invoke: (...args: any[]) => {
            calls.push(args);
            return Promise.resolve();
          },
          on: ipc.on.bind(ipc),
          removeListener: ipc.removeListener.bind(ipc),
        },
      },
    },
  );
  preload.reportSidebarMenuState({ enabled: true, open: false });
  assert.deepEqual(calls, [
    [
      prefix + "WindowControl_$_reportSidebarMenuState",
      { enabled: true, open: false },
    ],
  ]);
  const events: string[] = [];
  const dispose = preload.onToggleSidebar((s: string) => events.push(s));
  ipc.emit(prefix + "MenuEvents_$_toggleSidebar", {}, "menu");
  assert.deepEqual(events, ["menu"]);
  dispose();
  ipc.emit(prefix + "MenuEvents_$_toggleSidebar", {}, "menu");
  assert.equal(events.length, 1);
  const host = fs.readFileSync("electron/official-ui/native/host.ts", "utf8");
  assert.match(
    host,
    /this\.namespaces\.set\("MenuEvents", new Set\(\["claude\.web"\]\)\)/,
  );
  assert.match(
    host,
    /this\.emitTo\(window, "MenuEvents", "toggleSidebar", "menu"\)/,
  );
});
