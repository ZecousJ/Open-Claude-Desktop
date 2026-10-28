/**
 * The window's side of the application menu and the Code pane keys
 * (src/app/shell-menu.ts), the menu state store (electron/menu-state.ts),
 * the About page and the Open File reader.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initialMenuState } from "../../shared/menu-state";
import {
  ClosedSessions,
  closeMenuTarget,
  browserTabFor,
  browserTabNumber,
  isPinChord,
  menuStateFor,
  paneToClose,
} from "../../src/app/shell-menu";
import {
  menuState,
  onMenuState,
  reportMenuState,
  resetMenuState,
} from "../../electron/app/menu-state";
import {
  aboutActions,
  aboutPage,
  aboutVersionText,
  copiedAboutVersionText,
} from "../../electron/app/about-page";
import { snapshotChosenFile } from "../../electron/artifacts/generated-files";

test("contextual close follows the page or session, not an open Code tool pane", () => {
  assert.equal(closeMenuTarget("chat", true, true, false), "Chat");
  assert.equal(closeMenuTarget("cowork", true, true, false), "Chat");
  assert.equal(closeMenuTarget("code", true, true, true), "Session");
  assert.equal(closeMenuTarget("code", true, false, true), "Pane");
  assert.equal(closeMenuTarget("code", true, false, false), undefined);
  assert.equal(closeMenuTarget("chat", false, true, false), "Page");
  assert.equal(closeMenuTarget("chat", true, false, false), undefined);
});

test("the menu report accepts and retains Files, Find in Files and contextual Close", () => {
  resetMenuState();
  const report = {
    ...initialMenuState,
    closeTarget: "Session" as const,
    findInFiles: true,
    panes: { ...initialMenuState.panes, files: { enabled: true, open: false } },
  };
  assert.equal(reportMenuState(report), true);
  assert.deepEqual(menuState(), report);
  assert.throws(() => reportMenuState({ ...report, closeTarget: "Window" }));
  assert.throws(() => reportMenuState({ ...report, findInFiles: "true" }));
  resetMenuState();
});

test("closed sessions come back most recent first, skipping the ones that are gone", () => {
  const closed = new ClosedSessions();
  closed.push("a");
  closed.push("b");
  closed.push("c");
  closed.push("a");
  const alive = (id: string) => id !== "c";
  assert.deepEqual(closed.reopenable(alive), ["a", "b"]);
  assert.equal(closed.take(alive), "a");
  assert.equal(closed.take(alive), "b");
  // "c" was above "b" and gone: it is forgotten with the rest.
  assert.equal(closed.take(alive), undefined);
  assert.deepEqual(
    closed.reopenable(() => true),
    [],
  );
});

test("the reopen list keeps the latest twenty", () => {
  const closed = new ClosedSessions();
  for (let i = 0; i < 30; i++) closed.push(`c${i}`);
  assert.equal(closed.reopenable(() => true).length, 20);
  assert.equal(
    closed.take(() => true),
    "c29",
  );
});

const base = {
  mode: "code" as const,
  sidebarOpen: true,
  sidebarEnabled: true,
  canGoBack: false,
  canGoForward: false,
  inCodeConversation: true,
  isOpen: (panel: string) => panel === "changes",
  terminalAvailable: true,
  browserAvailable: false,
  artifactOpen: false,
  anyPanelOpen: true,
  canReopenClosed: false,
};

test("the menu state enables a pane only in an open Code conversation where the host has it", () => {
  const state = menuStateFor(base);
  assert.deepEqual(state.panes, {
    terminal: { enabled: true, open: false },
    changes: { enabled: true, open: true },
    browser: { enabled: false, open: false },
  });
  assert.equal(state.canClosePane, true);
  const home = menuStateFor({ ...base, inCodeConversation: false });
  assert.deepEqual(home.panes.changes, { enabled: false, open: false });
  const cloud = menuStateFor({ ...base, terminalAvailable: false });
  assert.equal(cloud.panes.terminal.enabled, false);
});

test("the menu state carries Split View, greyed until the window reports", () => {
  assert.deepEqual(menuStateFor(base).splitView, initialMenuState.splitView);
  assert.equal(
    Object.values(menuStateFor(base).splitView).includes(true),
    false,
  );
  const split = {
    newRight: true,
    newBelow: false,
    split: true,
    moveLeft: false,
    moveRight: true,
    moveUp: false,
    moveDown: false,
  };
  assert.deepEqual(
    menuStateFor({ ...base, splitView: split }).splitView,
    split,
  );
});

test("Close Pane takes the file viewer first, then a lone panel, then the dock's last card", () => {
  assert.equal(
    paneToClose({ artifact: true, single: "plan", dock: ["changes"] }),
    "artifact",
  );
  assert.equal(
    paneToClose({ artifact: false, single: "plan", dock: [] }),
    "plan",
  );
  assert.equal(
    paneToClose({
      artifact: false,
      single: null,
      dock: ["changes", "browser", "terminal"],
    }),
    "terminal",
  );
  assert.equal(
    paneToClose({ artifact: false, single: null, dock: [] }),
    undefined,
  );
});

test("Browser key commands pick tabs", () => {
  const tabs = ["t1", "t2", "t3"];
  assert.equal(browserTabFor("next-tab", tabs, "t3"), "t1");
  assert.equal(browserTabFor("previous-tab", tabs, "t1"), "t3");
  assert.equal(browserTabFor("next-tab", tabs, "t1"), "t2");
  assert.equal(browserTabFor({ tab: 2 }, tabs, "t1"), "t2");
  // ⌘9 is the last tab; a number past the end is nothing.
  assert.equal(browserTabFor({ tab: 9 }, tabs, "t1"), "t3");
  assert.equal(browserTabFor({ tab: 5 }, tabs, "t1"), undefined);
  assert.equal(browserTabFor("next-tab", [], undefined), undefined);
  assert.equal(browserTabNumber("browser-tab-7"), 7);
  assert.equal(browserTabNumber("browser-tab-0"), undefined);
  assert.equal(browserTabNumber("toggle-browser"), undefined);
});

test("Pin / unpin chat is Ctrl+Alt+P or Cmd+Option+P by the physical key", () => {
  const press = (extra: Partial<Parameters<typeof isPinChord>[0]>) => ({
    code: "KeyP",
    altKey: true,
    shiftKey: false,
    ctrlKey: false,
    metaKey: true,
    ...extra,
  });
  assert.equal(isPinChord(press({})), true);
  assert.equal(isPinChord(press({ metaKey: false, ctrlKey: true })), true);
  assert.equal(isPinChord(press({ altKey: false })), false);
  assert.equal(isPinChord(press({ shiftKey: true })), false);
  assert.equal(isPinChord(press({ code: "KeyO" })), false);
  assert.equal(isPinChord(press({ metaKey: false })), false);
});

test("the main window's menu report is checked, stored and announced once per change", () => {
  resetMenuState();
  let heard = 0;
  const off = onMenuState(() => heard++);
  const report = { ...initialMenuState, mode: "code" as const };
  assert.equal(reportMenuState(report), true);
  assert.equal(menuState().mode, "code");
  assert.equal(reportMenuState(report), false);
  assert.equal(heard, 1);
  assert.throws(() => reportMenuState({ ...report, extra: 1 }));
  assert.throws(() => reportMenuState({ ...report, mode: "other" }));
  // The Split View state is part of the report, and nothing else goes in it.
  const { splitView, ...without } = report;
  assert.throws(() => reportMenuState(without));
  assert.throws(() =>
    reportMenuState({ ...report, splitView: { ...splitView, extra: true } }),
  );
  const split = { ...splitView, newRight: true, split: true, moveLeft: true };
  assert.equal(reportMenuState({ ...report, splitView: split }), true);
  assert.deepEqual(menuState().splitView, split);
  resetMenuState();
  assert.equal(menuState().mode, "chat");
  off();
});

test("the About page names the app, its version and the buttons", () => {
  const html = aboutPage({
    name: "Claudex <b>",
    version: "1.2.3",
    buildDate: new Date("2026-10-14T12:34:00Z"),
    icon: "data:image/png;base64,AAAA",
    links: true,
  });
  assert.match(html, /<h2>Claudex &lt;b&gt;&nbsp;<em>for <\/em>Mac<\/h2>/);
  assert.match(html, /Version 1\.2\.3/);
  assert.match(html, /<em>for <\/em>Mac/);
  assert.match(html, /<p class="build-date">/);
  assert.match(html, /<time datetime="2026-10-14T12:34:00.000Z">/);
  assert.match(html, /height: 36px/);
  assert.match(html, /font-size: 14px/);
  assert.match(html, /id="copy-status" class="sr-only"/);
  assert.ok(html.includes(`href="${aboutActions.copy}"`));
  assert.ok(html.includes(`href="${aboutActions.help}"`));
  assert.ok(html.includes(`href="${aboutActions.support}"`));
  assert.match(html, /Help<\/a>/);
  assert.match(html, /Get support<\/a>/);
  assert.match(html, /default-src 'none'/);
  // Without a help page the buttons are drawn greyed and link nowhere.
  const off = aboutPage({ name: "Claudex", version: "1", links: false });
  assert.ok(!off.includes(aboutActions.help));
  assert.match(off, /aria-disabled="true">Help</);
});

test("the About build date uses the selected locale and translated version copy", () => {
  const buildDate = new Date("2026-10-14T12:34:00Z");
  const html = aboutPage({
    name: "Claudex",
    version: "1.2.3",
    buildDate,
    locale: "de-DE",
    translate: (text) =>
      text === "Version {version}" ? "Ausgabe {version}" : text,
    links: true,
  });
  assert.match(html, /Ausgabe 1\.2\.3/);
  assert.ok(
    html.includes(
      buildDate.toLocaleString("de-DE", {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    ),
  );
});

test("About version and copied diagnostics include the app version, commit and an offered latest channel", () => {
  const buildDate = new Date("2026-10-14T12:34:00Z");
  const version = aboutVersionText("1.2.3", "abcdef123456", "latest");
  assert.equal(version, "1.2.3 (abcdef, latest)");
  assert.equal(aboutVersionText("1.2.3", "abcdef123456"), "1.2.3 (abcdef)");
  assert.equal(aboutVersionText("1.2.3", "unknown"), "1.2.3 (Unknown)");
  assert.equal(aboutVersionText("1.2.3"), "1.2.3 (Unknown)");
  assert.equal(
    copiedAboutVersionText("Claudex", version, buildDate),
    "Claudex 1.2.3 (abcdef, latest) 2026-10-14T12:34:00.000Z",
  );
  assert.equal(
    copiedAboutVersionText("Claudex", version),
    `Claudex ${version}`,
  );
  const html = aboutPage({
    name: "Claudex",
    version: "1.2.3",
    commitHash: "abcdef123456",
    channel: "latest",
    buildDate,
    links: true,
  });
  assert.ok(html.includes(`Version ${version}`));
  assert.ok(html.includes(`aria-label="Copy version ${version} to clipboard"`));
});

test("Open File reads a chosen text file and reports one it cannot preview", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-open-file-"));
  const text = path.join(folder, "notes.md");
  fs.writeFileSync(text, "# Hello\n");
  const file = snapshotChosenFile(text);
  assert.equal(file.state, "ready");
  assert.equal(file.name, "notes.md");
  assert.equal(file.language, "markdown");
  assert.equal(file.content, "# Hello\n");
  assert.equal(file.path, text);
  const unknown = path.join(folder, "data.xyz");
  fs.writeFileSync(unknown, "x");
  const refused = snapshotChosenFile(unknown);
  assert.equal(refused.state, "unavailable");
  assert.match(refused.error ?? "", /not available/);
  assert.equal(
    snapshotChosenFile(path.join(folder, "gone.md")).state,
    "unavailable",
  );
});

test("the menu state store takes the Previous and Next report", () => {
  resetMenuState();
  assert.equal(menuState().canCycleSession, false);
  assert.equal(
    reportMenuState({ ...initialMenuState, canCycleSession: true }),
    true,
  );
  assert.equal(menuState().canCycleSession, true);
  // A report without the field is refused, as with the others.
  const { canCycleSession: _, ...partial } = initialMenuState;
  assert.throws(() => reportMenuState(partial));
  resetMenuState();
});
