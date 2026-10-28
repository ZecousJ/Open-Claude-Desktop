/**
 * Batch 11 Code keys: ⇧⌘X sketch mode on the Browser's page, the Changes keys
 * (⇧⌘Y, ⌘P, F7 / ⌥F5), and ⌘R / F5 reloading the Browser's page with View ▸
 * Reload, plus their rows in the shortcuts list.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { paneKeyCommand, pageReloadKey } from "../../shared/pane-keys";
import { commandForKey, keyTable } from "../../src/host/keys";
import {
  pngSize,
  sketchAttachmentName,
  sketchKeyCommand,
} from "../../src/browser/browser-sketch-model";
import {
  changesKeyCommand,
  goToFileLimit,
  goToFileMatches,
  stepChange,
} from "../../src/changes/changes-keys";
import { appMenuTemplate } from "../../electron/app/app-menu-template";
import { codeShortcutSections } from "../../src/dialogs/KeyboardShortcutsDialog";
import { AddressBar } from "../../src/browser/AddressBar";

const key = (
  name: string,
  extra: Partial<{
    code: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  }> = {},
) => ({
  key: name,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...extra,
});

test("⇧⌘X is the Browser's sketch key in the window and from its page", () => {
  const mac = keyTable("desktop", "darwin");
  const win = keyTable("desktop", "win32");
  assert.equal(
    commandForKey(key("X", { metaKey: true, shiftKey: true }), mac),
    "browser-sketch",
  );
  assert.equal(
    commandForKey(key("X", { ctrlKey: true, shiftKey: true }), win),
    "browser-sketch",
  );
  assert.equal(
    paneKeyCommand({ key: "x", meta: true, shift: true }, true),
    "browser-sketch",
  );
  // The web leaves it to the browser.
  assert.equal(
    commandForKey(
      key("X", { metaKey: true, shiftKey: true }),
      keyTable("web", "darwin"),
    ),
    undefined,
  );
});

test("sketch mode's own keys follow the original's table", () => {
  assert.equal(sketchKeyCommand(key("z", { metaKey: true }), "darwin"), "undo");
  assert.equal(
    sketchKeyCommand(key("Z", { metaKey: true, shiftKey: true }), "darwin"),
    "redo",
  );
  assert.equal(sketchKeyCommand(key("z", { ctrlKey: true }), "win32"), "undo");
  assert.equal(sketchKeyCommand(key("y", { ctrlKey: true }), "win32"), "redo");
  // Ctrl+Y redoes outside macOS only; Control+Z is not ⌘Z on a Mac.
  assert.equal(
    sketchKeyCommand(key("y", { metaKey: true }), "darwin"),
    undefined,
  );
  assert.equal(
    sketchKeyCommand(key("z", { ctrlKey: true }), "darwin"),
    undefined,
  );
  assert.equal(sketchKeyCommand(key("Backspace"), "darwin"), "delete");
  assert.equal(sketchKeyCommand(key("Delete"), "win32"), "delete");
  assert.equal(sketchKeyCommand(key("Escape"), "darwin"), "deselect");
  assert.equal(
    sketchKeyCommand({ ...key("Escape"), isComposing: true }, "darwin"),
    undefined,
  );
  assert.equal(sketchAttachmentName(true), "preview-annotation.png");
  assert.equal(sketchAttachmentName(false), "preview-screenshot.png");
});

test("the page's still has its size read from the PNG header", () => {
  const header = new Uint8Array(24);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(header.buffer);
  view.setUint32(16, 2048);
  view.setUint32(20, 1536);
  assert.deepEqual(pngSize(header), { width: 2048, height: 1536 });
  assert.equal(pngSize(new Uint8Array(24)), undefined);
  assert.equal(pngSize(new Uint8Array(4)), undefined);
});

test("in sketch mode Select element reads Annotate and ends the sketch", () => {
  const props = {
    tab: {
      id: "t",
      url: "https://example.com/",
      title: "Example",
      loading: false,
      canGoBack: false,
      canGoForward: false,
    },
    picking: false,
    canPick: true,
    onNavigate: async () => true,
    onBack: () => {},
    onForward: () => {},
    onReload: () => {},
    onStop: () => {},
    onPick: () => {},
  };
  const resting = renderToStaticMarkup(
    createElement(AddressBar, props as never),
  );
  assert.match(resting, /aria-label="Select element"/);
  const sketching = renderToStaticMarkup(
    createElement(AddressBar, {
      ...props,
      sketching: true,
      onEndSketch: () => {},
    } as never),
  );
  assert.match(sketching, /aria-label="Annotate"/);
  assert.match(sketching, /aria-pressed="true"/);
});

test("the Changes keys: file list, go to file, next and previous change", () => {
  const mac = { mac: true, app: true };
  const web = { mac: true, app: false };
  const win = { mac: false, app: true };
  const linux = { mac: false, app: true, linux: true };
  assert.equal(
    changesKeyCommand(
      key("y", { code: "KeyY", metaKey: true, shiftKey: true }),
      mac,
    ),
    "file-list",
  );
  // The web's key is Control+Shift+Y, even on a Mac.
  assert.equal(
    changesKeyCommand(
      key("y", { code: "KeyY", metaKey: true, shiftKey: true }),
      web,
    ),
    undefined,
  );
  assert.equal(
    changesKeyCommand(
      key("Y", { code: "KeyY", ctrlKey: true, shiftKey: true }),
      web,
    ),
    "file-list",
  );
  assert.equal(
    changesKeyCommand(
      key("y", { code: "KeyY", ctrlKey: true, shiftKey: true }),
      win,
    ),
    "file-list",
  );
  assert.equal(
    changesKeyCommand(key("p", { code: "KeyP", metaKey: true }), mac),
    "go-to-file",
  );
  assert.equal(
    changesKeyCommand(key("p", { code: "KeyP", ctrlKey: true }), win),
    "go-to-file",
  );
  assert.equal(
    changesKeyCommand(
      key("p", { code: "KeyP", metaKey: true, shiftKey: true }),
      mac,
    ),
    undefined,
  );
  assert.equal(changesKeyCommand(key("F7"), mac), "next-change");
  assert.equal(
    changesKeyCommand(key("F7", { shiftKey: true }), mac),
    "previous-change",
  );
  assert.equal(
    changesKeyCommand(key("F5", { altKey: true }), win),
    "next-change",
  );
  assert.equal(
    changesKeyCommand(key("F5", { altKey: true, shiftKey: true }), mac),
    "previous-change",
  );
  // Linux keeps ⌥F5; F5 alone is never a change key.
  assert.equal(
    changesKeyCommand(key("F5", { altKey: true }), linux),
    undefined,
  );
  assert.equal(changesKeyCommand(key("F5"), mac), undefined);
});

test("Go to file matches the typed text, then its letters in order", () => {
  const files = [
    { path: "src/app/main.ts" },
    { path: "src/changes/ChangesPanel.tsx" },
    { path: "README.md" },
  ];
  assert.equal(goToFileMatches(files, "").length, 3);
  assert.deepEqual(
    goToFileMatches(files, "panel").map((file) => file.path),
    ["src/changes/ChangesPanel.tsx"],
  );
  assert.deepEqual(
    goToFileMatches(files, "SAM").map((file) => file.path),
    ["src/app/main.ts"],
  );
  assert.deepEqual(
    goToFileMatches(files, "main").map((file) => file.path),
    ["src/app/main.ts"],
  );
  assert.deepEqual(
    goToFileMatches(files, "cp").map((file) => file.path),
    ["src/app/main.ts", "src/changes/ChangesPanel.tsx"],
  );
  assert.deepEqual(goToFileMatches(files, "zzz"), []);
  assert.equal(goToFileLimit, 100);
});

test("next and previous change step from the last one, else from the view", () => {
  const tops = [0, 120, 400, 900];
  // From the view's top.
  assert.equal(stepChange(tops, 1, { viewTop: 0 }), 1);
  assert.equal(stepChange(tops, 1, { viewTop: 130 }), 2);
  assert.equal(stepChange(tops, -1, { viewTop: 130 }), 1);
  assert.equal(stepChange(tops, -1, { viewTop: 0 }), undefined);
  assert.equal(stepChange(tops, 1, { viewTop: 950 }), undefined);
  // From the change the last step landed on.
  assert.equal(stepChange(tops, 1, { last: 2, viewTop: 0 }), 3);
  assert.equal(stepChange(tops, -1, { last: 2, viewTop: 0 }), 1);
  assert.equal(stepChange(tops, 1, { last: 3, viewTop: 0 }), undefined);
  assert.equal(stepChange([], 1, { viewTop: 0 }), undefined);
});

test("View ▸ Reload goes through the app when it can reload the Browser's page", () => {
  type Item = {
    label?: string;
    role?: string;
    accelerator?: string;
    submenu?: Item[];
    click?: (item: unknown, window?: unknown) => void;
  };
  const view = (items: Item[]) =>
    items.find((item) => item.label === "View")?.submenu ?? [];
  const base = {
    mac: true,
    appName: "Claudex",
    run: () => {},
    checkForUpdates: () => {},
    showMainWindow: () => {},
  };
  const plain = view(appMenuTemplate(base) as Item[]);
  assert.ok(plain.some((item) => item.role === "reload"));
  const reloads: unknown[] = [];
  const window = {};
  const custom = view(
    appMenuTemplate({
      ...base,
      reload: (target) => reloads.push(target),
    }) as Item[],
  );
  const reload = custom.find((item) => item.label === "Reload");
  assert.equal(reload?.accelerator, "CmdOrCtrl+R");
  assert.ok(!custom.some((item) => item.role === "reload"));
  reload?.click?.({}, window);
  assert.deepEqual(reloads, [window]);
});

test("F5 reloads the Browser's page outside macOS, alone", () => {
  assert.equal(pageReloadKey({ key: "F5" }), true);
  assert.equal(pageReloadKey({ key: "F5", control: true }), false);
  assert.equal(pageReloadKey({ key: "F5", alt: true }), false);
  assert.equal(pageReloadKey({ key: "r", control: true }), false);
});

test("the shortcuts list has the Changes, Annotate and Reload page rows", () => {
  const rows = (platform: string) =>
    Object.fromEntries(
      codeShortcutSections(platform, "desktop")
        .flatMap((section) => section.shortcuts)
        .map((s) => [s.action, s.keys.map((k) => k.join("+")).join(" | ")]),
    );
  const mac = rows("darwin");
  assert.equal(mac["Toggle file list in changes or files"], "mod+shift+Y");
  assert.equal(mac["Next change in changes"], "alt+F5 | F7");
  assert.equal(mac["Previous change in changes"], "shift+alt+F5 | shift+F7");
  assert.equal(mac["Go to file in changes or files"], "mod+P");
  assert.equal(mac["Annotate page in Browser"], "mod+shift+X");
  assert.equal(mac["Reload page in Browser"], "mod+R");
  const windows = rows("win32");
  assert.equal(windows["Reload page in Browser"], "F5 | ctrl+R");
  const linux = rows("linux");
  assert.equal(linux["Next change in changes"], "F7");
  assert.equal(linux["Previous change in changes"], "shift+F7");
  // The order: the Changes rows follow Toggle changes; Annotate follows
  // Select element; Reload page follows the address bar.
  const order = codeShortcutSections("darwin", "desktop")
    .find((section) => section.title === "Panes")!
    .shortcuts.map((s) => s.action);
  assert.equal(
    order.indexOf("Toggle file list in changes or files"),
    order.indexOf("Toggle changes") + 1,
  );
  assert.equal(
    order.indexOf("Annotate page in Browser"),
    order.indexOf("Select element in Browser") + 1,
  );
  assert.equal(
    order.indexOf("Reload page in Browser"),
    order.indexOf("Focus address bar in Browser") + 1,
  );
  // The web lists none of them.
  const web = codeShortcutSections("darwin", "web")
    .flatMap((section) => section.shortcuts)
    .map((s) => s.action);
  assert.ok(!web.includes("Annotate page in Browser"));
});
