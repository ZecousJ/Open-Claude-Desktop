import assert from "node:assert/strict";
import test from "node:test";
import type { AppCommand } from "../../shared/types";
import { initialMenuState, type MenuState } from "../../shared/menu-state";
import { appMenuTemplate } from "../../electron/app/app-menu-template";

type Item = {
  label?: string;
  role?: string;
  type?: string;
  enabled?: boolean;
  checked?: boolean;
  accelerator?: string;
  registerAccelerator?: boolean;
  visible?: boolean;
  acceleratorWorksWhenHidden?: boolean;
  submenu?: Item[];
  click?: () => void;
};

const menu = (
  mac: boolean,
  run: (command: AppCommand) => void = () => {},
  extra: Partial<Parameters<typeof appMenuTemplate>[0]> = {},
) =>
  appMenuTemplate({
    mac,
    appName: "Claudex",
    run,
    checkForUpdates: () => {},
    showMainWindow: () => {},
    updateItem: { label: "Check for Updates…", enabled: true },
    openHelp: () => {},
    troubleshooting: {
      copyInstallationId: () => {},
      generateDiagnosticReport: () => {},
      recordNetLog: () => {},
      hardwareAccelerationDisabled: false,
      setHardwareAccelerationDisabled: () => {},
      resetAppData: () => {},
    },
    ...extra,
  }) as Item[];
const top = (items: Item[], label: string) =>
  items.find((item) => (item.label ?? item.role) === label)?.submenu ?? [];
const names = (items: Item[]) =>
  items.map((item) => item.label ?? item.role ?? item.type);
const item = (items: Item[], label: string) =>
  items.find((value) => value.label === label);
/** A window in a Code session with every pane available. */
const codeState: MenuState = {
  ...initialMenuState,
  mode: "code",
  panes: {
    terminal: { enabled: true, open: false },
    changes: { enabled: true, open: true },
    browser: { enabled: false, open: false },
  },
  canClosePane: true,
  canReopenClosed: true,
  canGoBack: true,
};

test("File closes its context with W and the window with Shift+W on every platform", () => {
  for (const mac of [true, false]) {
    for (const closeTarget of [
      "Chat",
      "Task",
      "Page",
      "Session",
      "Pane",
    ] as const) {
      const commands: AppCommand[] = [];
      const file = top(
        menu(mac, (command) => commands.push(command), {
          state: { ...initialMenuState, closeTarget },
        }),
        "File",
      );
      const close = item(file, `Close ${closeTarget}`)!;
      assert.equal(close.accelerator, "CmdOrCtrl+W");
      assert.equal(close.role, undefined);
      close.click?.();
      assert.deepEqual(commands, ["close-context"]);
      const window = item(file, "Close Window")!;
      assert.equal(window.role, "close");
      assert.equal(window.accelerator, "CmdOrCtrl+Shift+W");
      assert.equal(window.visible, true);
    }
    const closes = top(menu(mac), "File").filter(
      (entry) => entry.role === "close",
    );
    assert.equal(closes[0].accelerator, "CmdOrCtrl+W");
    assert.equal(closes[1].visible, false);
    assert.equal(closes[1].acceleratorWorksWhenHidden, true);
  }
});

test("Find in Files follows the session report and dispatches a live command", () => {
  for (const mac of [true, false]) {
    const commands: AppCommand[] = [];
    const find = top(
      top(
        menu(mac, (command) => commands.push(command), {
          state: { ...codeState, findInFiles: true },
        }),
        "Edit",
      ),
      "Find",
    );
    assert.deepEqual(
      find.slice(0, 3).map((entry) => entry.accelerator),
      ["CmdOrCtrl+F", "CmdOrCtrl+G", "CmdOrCtrl+Shift+G"],
    );
    assert.equal(item(find, "Find in Files…")?.enabled, true);
    assert.equal(item(find, "Find in Files…")?.accelerator, undefined);
    item(find, "Find in Files…")?.click?.();
    assert.deepEqual(commands, ["find-in-files"]);
    const disabled = top(top(menu(mac), "Edit"), "Find");
    assert.equal(item(disabled, "Find in Files…")?.enabled, false);
  }
});

test("the shared Terminal accelerator and Enter/Exit Full Screen match the original", () => {
  for (const mac of [true, false]) {
    for (const fullScreen of [true, false]) {
      const view = top(
        menu(mac, undefined, { state: codeState, fullScreen }),
        "View",
      );
      assert.equal(
        item(view, mac ? "Show Terminal" : "Terminal")?.accelerator,
        "Command+J",
      );
      const full = item(
        view,
        fullScreen ? "Exit Full Screen" : "Enter Full Screen",
      )!;
      assert.equal(full.role, "togglefullscreen");
      assert.equal(full.accelerator, "Control+Command+F");
    }
  }
});

test("the app-named menu is present on Windows and owns settings, updates and quit", () => {
  assert.deepEqual(names(top(menu(false), "Claudex")), [
    "about",
    "separator",
    "Settings…",
    "Check for Updates…",
    "separator",
    "Quit Claudex",
  ]);
  let opened = 0;
  let checked = 0;
  const commands: AppCommand[] = [];
  const app = top(
    menu(false, (command) => commands.push(command), {
      about: () => {
        opened++;
      },
      checkForUpdates: () => {
        checked++;
      },
    }),
    "Claudex",
  );
  item(app, "About Claudex")?.click?.();
  item(app, "Check for Updates…")?.click?.();
  item(app, "Settings…")?.click?.();
  assert.equal(opened, 1);
  assert.equal(checked, 1);
  assert.deepEqual(commands, ["settings"]);
  assert.equal(item(app, "Quit Claudex")?.accelerator, "CmdOrCtrl+Q");
  assert.ok(
    !app.some((entry) =>
      ["services", "hide", "hideOthers", "unhide"].includes(entry.role ?? ""),
    ),
  );
});

test("File follows the current template: New, Code actions, Close and Reopen", () => {
  assert.deepEqual(names(top(menu(false), "File")), [
    "New Chat",
    "separator",
    "Open File…",
    "Open Folder…",
    "separator",
    "Close Window",
    "Close Window",
    "Reopen Closed Session",
  ]);
  // In a Code session the first item is New Session, with its window variant.
  assert.deepEqual(
    names(top(menu(false, undefined, { state: codeState }), "File")).slice(
      0,
      2,
    ),
    ["New Session", "New Session in New Window"],
  );
});

test("Troubleshooting offers Developer Mode only when policy allows it", () => {
  const help = top(
    menu(false, undefined, { enableDeveloperMode: () => {} }),
    "help",
  );
  const troubleshooting = top(help, "Troubleshooting");
  assert.equal(
    item(troubleshooting, "Enable Developer Mode…")?.label,
    "Enable Developer Mode…",
  );
  const disabled = top(menu(false), "help");
  assert.equal(
    item(top(disabled, "Troubleshooting"), "Enable Developer Mode…"),
    undefined,
  );
});

test("the opted-in Developer menu exposes working DevTools actions", () => {
  let opened = 0;
  const items = menu(true, undefined, {
    developerTools: {
      label: "Developer",
      openLabel: "Show Dev Tools",
      openAllLabel: "Show All Dev Tools",
      open: () => {
        opened++;
      },
      openAll: () => {
        opened += 10;
      },
    },
  });
  const developer = top(items, "Developer");
  item(developer, "Show Dev Tools")?.click?.();
  item(developer, "Show All Dev Tools")?.click?.();
  assert.equal(opened, 11);
  assert.equal(
    item(developer, "Show Dev Tools")?.accelerator,
    "CommandOrControl+Alt+I",
  );
  assert.equal(top(menu(true), "Developer").length, 0);
});

test("File on macOS lists Code actions, Close Window and Reopen", () => {
  assert.deepEqual(
    names(top(menu(true, undefined, { state: codeState }), "File")),
    [
      "New Session",
      "New Side Chat",
      "separator",
      "Open File…",
      "Open Folder…",
      "separator",
      "Close Window",
      "Close Window",
      "Reopen Closed Session",
    ],
  );
});

test("Open actions follow the official Code surface rollout predicates", () => {
  const codeSurface = {
    enabled: true,
    openFileFromAnySurface: false,
    openFolder: false,
  };
  assert.equal(
    item(top(menu(false, undefined, { codeSurface }), "File"), "Open File…"),
    undefined,
  );
  assert.equal(
    item(top(menu(false, undefined, { codeSurface }), "File"), "Open Folder…"),
    undefined,
  );
  assert.equal(
    item(
      top(menu(false, undefined, { codeSurface, state: codeState }), "File"),
      "Open File…",
    )?.accelerator,
    "CmdOrCtrl+O",
  );
  assert.equal(
    item(
      top(
        menu(false, undefined, {
          codeSurface: {
            ...codeSurface,
            enabled: false,
            openFileFromAnySurface: true,
          },
        }),
        "File",
      ),
      "Open File…",
    ),
    undefined,
  );
  const file = top(menu(false, undefined, { state: codeState }), "File");
  assert.equal(item(file, "Open File…")?.accelerator, "CmdOrCtrl+O");
  assert.equal(item(file, "Open Folder…")?.accelerator, "CmdOrCtrl+Shift+O");
});

test("the first File item names the mode: Chat, Task or Session", () => {
  for (const [mode, label] of [
    ["chat", "New Chat"],
    ["cowork", "New Chat"],
    ["code", "New Session"],
  ] as const)
    assert.equal(
      top(
        menu(true, undefined, { state: { ...initialMenuState, mode } }),
        "File",
      )[0].label,
      label,
    );
});

test("Open Folder… and Open File… ask the window to open them", () => {
  const run: AppCommand[] = [];
  const file = top(
    menu(false, (command) => run.push(command), { state: codeState }),
    "File",
  );
  item(file, "Open Folder…")?.click?.();
  item(file, "Open File…")?.click?.();
  assert.deepEqual(run, ["open-folder", "open-file"]);
  // Open File… retains the official Cmd-only accelerator.
  assert.equal(item(file, "Open File…")?.accelerator, "CmdOrCtrl+O");
  assert.notEqual(item(file, "Open File…")?.enabled, false);
});

test("Reopen Closed Session is greyed until the window has one to reopen", () => {
  const run: AppCommand[] = [];
  const reopen = (state?: MenuState) =>
    item(
      top(
        menu(false, (command) => run.push(command), { state }),
        "File",
      ),
      "Reopen Closed Session",
    );
  assert.equal(reopen()?.enabled, false);
  assert.equal(reopen()?.accelerator, "CmdOrCtrl+Shift+T");
  assert.equal(reopen(codeState)?.enabled, true);
  reopen(codeState)?.click?.();
  assert.deepEqual(run, ["reopen-closed-session"]);
});

test("entries Claudex cannot act on are greyed and carry no shortcut", () => {
  for (const mac of [false, true]) {
    const items = menu(mac).flatMap((value) => [
      value,
      ...(value.submenu ?? []),
      ...(value.submenu ?? []).flatMap((child) => child.submenu ?? []),
    ]);
    const greyed = items.filter(
      (value) =>
        value.enabled === false &&
        value.label &&
        // The find items, Go entries and what waits for the window's state
        // keep the original's shortcut label.
        !/^(Find|Previous |Next |Reopen Closed|Back|Forward|Close Pane|Terminal|Changes|Browser|Side Chat|Show |Hide |New Session on|New Session Below|Focus (Next|Previous) Split|Close Split)/.test(
          value.label,
        ),
    );
    assert.ok(greyed.length >= 5, "the Move items and the rest are drawn");
    for (const value of greyed) assert.equal(value.accelerator, undefined);
  }
  const view = names(top(menu(false), "View"));
  assert.deepEqual(view.slice(0, 4), [
    "Command Palette…",
    "Sidebar",
    "separator",
    "Terminal",
  ]);
});

test("View toggles the Code panes with the original's shortcuts", () => {
  const run: AppCommand[] = [];
  const windows = top(
    menu(false, (command) => run.push(command), { state: codeState }),
    "View",
  );
  assert.deepEqual(
    ["Terminal", "Changes", "Browser"].map((label) => [
      item(windows, label)?.accelerator,
      item(windows, label)?.enabled,
      item(windows, label)?.checked,
    ]),
    [
      ["Command+J", true, false],
      ["CmdOrCtrl+Shift+D", true, true],
      ["CmdOrCtrl+Shift+B", false, false],
    ],
  );
  item(windows, "Terminal")?.click?.();
  item(windows, "Changes")?.click?.();
  item(windows, "Close Pane")?.click?.();
  assert.deepEqual(run, ["toggle-terminal", "toggle-changes", "close-pane"]);
  assert.equal(item(windows, "Close Pane")?.accelerator, "CmdOrCtrl+\\");
  assert.equal(item(windows, "Close Pane")?.enabled, true);
  // The page handles the keys, so the menu does not register them.
  assert.equal(item(windows, "Terminal")?.registerAccelerator, false);
  // Files stays greyed: Claudex has no Files pane.
  assert.equal(item(windows, "Files")?.enabled, false);

  // macOS says Show or Hide and ⌘J for the terminal.
  const mac = top(menu(true, undefined, { state: codeState }), "View");
  assert.equal(item(mac, "Show Terminal")?.accelerator, "Command+J");
  assert.equal(item(mac, "Hide Changes")?.enabled, true);
  assert.equal(item(mac, "Show Browser")?.enabled, false);
});

test("Side Chat toggles the open conversation's side chat, with New Side Chat in Code's File menu", () => {
  const run: AppCommand[] = [];
  const ready: MenuState = {
    ...codeState,
    sideChat: { enabled: true, open: false },
  };
  const windows = top(
    menu(false, (command) => run.push(command), { state: ready }),
    "View",
  );
  assert.equal(item(windows, "Side Chat")?.enabled, true);
  assert.equal(item(windows, "Side Chat")?.checked, false);
  assert.equal(item(windows, "Side Chat")?.accelerator, "CmdOrCtrl+;");
  assert.equal(item(windows, "Side Chat")?.registerAccelerator, false);
  item(windows, "Side Chat")?.click?.();
  const file = top(
    menu(false, (command) => run.push(command), { state: ready }),
    "File",
  );
  item(file, "New Side Chat")?.click?.();
  assert.deepEqual(run, ["toggle-side-chat", "toggle-side-chat"]);
  // macOS says Show or Hide; an open side chat offers Hide, and New is spent.
  const open: MenuState = { ...ready, sideChat: { enabled: true, open: true } };
  assert.ok(
    item(top(menu(true, undefined, { state: open }), "View"), "Hide Side Chat"),
  );
  assert.equal(
    item(top(menu(false, undefined, { state: open }), "File"), "New Side Chat")
      ?.enabled,
    false,
  );
  // Greyed before there is a reply to ask about, and absent outside Code.
  assert.equal(
    item(top(menu(false, undefined, { state: codeState }), "View"), "Side Chat")
      ?.enabled,
    false,
  );
  assert.equal(item(top(menu(false), "File"), "New Side Chat"), undefined);
});

test("the panes are greyed outside a Code session", () => {
  const view = top(menu(true), "View");
  for (const label of ["Show Terminal", "Show Changes", "Show Browser"])
    assert.equal(item(view, label)?.enabled, false, label);
  assert.equal(item(view, "Close Pane")?.enabled, false);
});

test("the sidebar item says Show or Hide on macOS and checks on Windows", () => {
  const closed = { ...initialMenuState, sidebarOpen: false };
  assert.equal(
    item(top(menu(true, undefined, { state: closed }), "View"), "Show Sidebar")
      ?.accelerator,
    "CmdOrCtrl+B",
  );
  assert.ok(
    item(top(menu(true), "View"), "Hide Sidebar"),
    "open sidebar offers Hide",
  );
  const windows = item(top(menu(false), "View"), "Sidebar");
  assert.equal(windows?.checked, true);
});

test("Actual Size follows the zoom, and the zoom items drive it", () => {
  const steps: number[] = [];
  let level = 0;
  const zoom = {
    level: () => level,
    step: (delta: number) => steps.push(delta),
    reset: () => steps.push(0),
  };
  const view = () => top(menu(true, undefined, { zoom }), "View");
  assert.equal(item(view(), "Actual Size")?.enabled, false);
  level = 1;
  assert.equal(item(view(), "Actual Size")?.enabled, true);
  item(view(), "Zoom In")?.click?.();
  item(view(), "Zoom Out")?.click?.();
  item(view(), "Actual Size")?.click?.();
  assert.deepEqual(steps, [0.5, -0.5, 0]);
  assert.equal(item(view(), "Zoom In")?.accelerator, "CmdOrCtrl+Plus");
});

test("Go is on both platforms, with Back and Forward following the history", () => {
  for (const mac of [true, false]) {
    const go = top(menu(mac), "Go");
    assert.deepEqual(names(go), [
      "Back",
      "Forward",
      "separator",
      "Previous Chat",
      "Next Chat",
      "separator",
      "Search…",
    ]);
    assert.equal(item(go, "Back")?.enabled, false);
    assert.equal(item(go, "Previous Chat")?.enabled, false);
  }
  const run: AppCommand[] = [];
  const go = top(
    menu(true, (command) => run.push(command), { state: codeState }),
    "Go",
  );
  assert.equal(item(go, "Back")?.enabled, true);
  assert.equal(item(go, "Forward")?.enabled, false);
  item(go, "Back")?.click?.();
  item(go, "Search…")?.click?.();
  // Go ▸ Search… opens the palette on Search (View ▸ Command Palette toggles it).
  assert.deepEqual(run, ["back", "search-palette"]);
  assert.deepEqual(
    names(top(menu(false, undefined, { state: codeState }), "Go")).slice(3, 5),
    ["Previous Session", "Next Session"],
  );
  assert.equal(
    item(top(menu(false), "Go"), "Search…")?.accelerator,
    "Command+Shift+K",
  );
  // Two or more areas reported: they head the menu as checkboxes.
  const areas: AppCommand[] = [];
  const withAreas = top(
    menu(false, (command) => areas.push(command), {
      state: {
        ...initialMenuState,
        areas: [
          { id: "chat", label: "Chat", selected: true },
          { id: "code", label: "Code", selected: false },
        ],
      },
    }),
    "Go",
  );
  assert.deepEqual(names(withAreas).slice(0, 4), [
    "Chat",
    "Code",
    "separator",
    "Back",
  ]);
  assert.equal(item(withAreas, "Chat")?.checked, true);
  assert.equal(item(withAreas, "Code")?.type, "checkbox");
  item(withAreas, "Code")?.click?.();
  assert.deepEqual(areas, ["area-code"]);
  assert.equal(
    item(top(menu(true), "Go"), "Search…")?.accelerator,
    "Command+Shift+K",
  );
});

test("Window puts a separator between Show Main Window and Bring All to Front", () => {
  assert.deepEqual(names(top(menu(true), "window")), [
    "minimize",
    "zoom",
    "separator",
    "Show Main Window",
    "separator",
    "front",
  ]);
});

test("Help excludes updates and About on every platform", () => {
  const windows = top(menu(false), "help");
  assert.deepEqual(names(windows), [
    "Claudex Help",
    "Keyboard Shortcuts",
    "separator",
    "Troubleshooting",
    "separator",
    "Get Support",
  ]);
  const mac = top(menu(true), "help");
  assert.deepEqual(names(mac), [
    "Claudex Help",
    "Keyboard Shortcuts",
    "separator",
    "Troubleshooting",
    "separator",
    "Get Support",
  ]);
  assert.equal(item(windows, "Claudex Help")?.accelerator, undefined);
  const troubleshooting = item(mac, "Troubleshooting")?.submenu as
    Item[] | undefined;
  assert.deepEqual(names(troubleshooting ?? []), [
    "Show Logs in Finder",
    "Copy Installation ID",
    "Generate Diagnostic Report",
    "Record Net Log (30s)",
    "separator",
    "Disable Hardware Acceleration",
    "separator",
    "Clear Cache and Restart",
    "Reset App Data…",
  ]);
  assert.equal(
    item(troubleshooting ?? [], "Disable Hardware Acceleration")?.type,
    "checkbox",
  );
});

test("uninstalled or update-disabled builds omit every update menu entry", () => {
  for (const mac of [true, false]) {
    const items = menu(mac, undefined, { updateItem: undefined });
    assert.ok(!JSON.stringify(items).includes("Check for Updates"));
    assert.ok(!JSON.stringify(items).includes("Last Update Attempt Failed"));
    assert.ok(names(top(items, "Claudex")).includes("Settings…"));
  }
});

test("Help and Get Support are never greyed and open the help page", () => {
  for (const mac of [true, false]) {
    const help = top(menu(mac), "help");
    assert.notEqual(item(help, "Claudex Help")?.enabled, false);
    assert.notEqual(item(help, "Get Support")?.enabled, false);
  }
  let opened = 0;
  const help = top(menu(true, undefined, { openHelp: () => opened++ }), "help");
  item(help, "Claudex Help")?.click?.();
  item(help, "Get Support")?.click?.();
  assert.equal(opened, 2);
});

test("a failed update shows a greyed line under Check for Updates…", () => {
  const failed = top(
    menu(true, undefined, {
      updateItem: { label: "Check for Updates…", enabled: true, failed: true },
    }),
    "Claudex",
  );
  const at = names(failed).indexOf("Check for Updates…");
  assert.equal(names(failed)[at + 1], "Last Update Attempt Failed");
  assert.equal(failed[at + 1].enabled, false);
});

test("the update items are in the app's language, the version carried over", async () => {
  const { catalogTranslator } = await import("../../electron/app/native-i18n");
  const translate = catalogTranslator({
    "Check for Updates…": "检查更新…",
    "Restart to Update to {version}": "重启以更新到 {version}",
    "Last Update Attempt Failed": "上次更新尝试失败",
  });
  const app = top(
    menu(true, undefined, {
      translate,
      updateItem: {
        label: "Restart to Update to 1.2.0",
        enabled: true,
        failed: true,
      },
    }),
    "Claudex",
  );
  assert.ok(names(app).includes("重启以更新到 1.2.0"));
  assert.ok(names(app).includes("上次更新尝试失败"));
  const idle = top(menu(true, undefined, { translate }), "Claudex");
  assert.ok(names(idle).includes("检查更新…"));
});

test("macOS About opens the About window when one is given", () => {
  let opened = 0;
  const app = top(menu(true, undefined, { about: () => opened++ }), "Claudex");
  item(app, "About Claudex")?.click?.();
  assert.equal(opened, 1);
});

test("Split View follows the window's report, with the original's shortcuts", () => {
  const run: AppCommand[] = [];
  const split = {
    newRight: true,
    newBelow: false,
    split: true,
    moveLeft: true,
    moveRight: false,
    moveUp: false,
    moveDown: true,
  };
  const state: MenuState = { ...codeState, splitView: split };
  // The submenu is one of View's items.
  const submenu = (mac: boolean) =>
    top(
      menu(mac, (command) => run.push(command), { state }),
      "View",
    ).find((value) => value.label === "Split View")?.submenu ?? [];
  const windows = submenu(false);
  assert.deepEqual(names(windows), [
    "New Session on the Right",
    "New Session Below",
    "separator",
    "Focus Next Split View",
    "Focus Previous Split View",
    "separator",
    "Move Split View Left",
    "Move Split View Right",
    "Move Split View Up",
    "Move Split View Down",
    "separator",
    "Close Split View",
  ]);
  assert.deepEqual(
    windows
      .filter((value) => value.label)
      .map((value) => [value.label, value.enabled, value.accelerator]),
    [
      ["New Session on the Right", true, "Ctrl+Alt+\\"],
      ["New Session Below", false, "Ctrl+Alt+-"],
      ["Focus Next Split View", true, "Control+]"],
      ["Focus Previous Split View", true, "Control+["],
      ["Move Split View Left", true, undefined],
      ["Move Split View Right", false, undefined],
      ["Move Split View Up", false, undefined],
      ["Move Split View Down", true, undefined],
      ["Close Split View", true, "Ctrl+Alt+W"],
    ],
  );
  const mac = submenu(true);
  assert.equal(
    item(mac, "New Session on the Right")?.accelerator,
    "Control+Command+\\",
  );
  assert.equal(
    item(mac, "New Session Below")?.accelerator,
    "Control+Command+-",
  );
  assert.equal(item(mac, "Close Split View")?.accelerator, "Control+Command+W");
  // The page handles the keys, so the menu does not register them.
  assert.equal(item(mac, "Focus Next Split View")?.registerAccelerator, false);
  for (const label of [
    "New Session on the Right",
    "Focus Next Split View",
    "Focus Previous Split View",
    "Move Split View Left",
    "Move Split View Down",
    "Close Split View",
  ])
    item(windows, label)?.click?.();
  assert.deepEqual(run, [
    "split-new-right",
    "split-focus-next",
    "split-focus-previous",
    "split-move-left",
    "split-move-down",
    "split-close",
  ]);
  // Before the window reports anything every item is greyed.
  const idle = top(menu(false), "View").find(
    (value) => value.label === "Split View",
  )?.submenu;
  assert.ok(
    idle?.filter((value) => value.label).every((value) => !value.enabled),
  );
});

test("Previous and Next follow the mode, the template's keys and whether the sidebar lists a row", () => {
  for (const mac of [true, false]) {
    // Greyed until the window reports a row to go to.
    const idle = top(menu(mac), "Go");
    assert.equal(item(idle, "Previous Chat")?.enabled, false);
    assert.equal(item(idle, "Next Chat")?.enabled, false);
    for (const [mode, previous, next] of [
      ["chat", "Previous Chat", "Next Chat"],
      ["cowork", "Previous Chat", "Next Chat"],
      ["code", "Previous Session", "Next Session"],
    ] as const) {
      const run: AppCommand[] = [];
      const go = top(
        menu(mac, (command) => run.push(command), {
          state: { ...initialMenuState, mode, canCycleSession: true },
        }),
        "Go",
      );
      assert.equal(item(go, previous)?.enabled, true);
      assert.equal(item(go, next)?.enabled, true);
      // The page keeps the keys, so the menu bar can be hidden.
      assert.equal(item(go, previous)?.registerAccelerator, false);
      assert.equal(item(go, previous)?.accelerator, "Command+Shift+[");
      assert.equal(item(go, next)?.accelerator, "Command+Shift+]");
      item(go, previous)?.click?.();
      item(go, next)?.click?.();
      assert.deepEqual(run, ["previous-session", "next-session"]);
    }
  }
});
