import test from "node:test";
import assert from "node:assert/strict";
import {
  appKey,
  neverGranted,
  onDeniedList,
  tierFor,
} from "../../electron/computer-use/app-tiers";
import {
  keyBlocked,
  normalizeKey,
} from "../../electron/computer-use/broker-support";
import { parseAppList } from "../../electron/computer-use/drivers/open-computer-use";

const mac = (id: string) => ({ id, platform: "darwin" as const });
const win = (id: string) => ({ id, platform: "win32" as const });

test("browsers are view-only, terminals and editors click-only, other apps full", () => {
  for (const id of [
    "com.apple.Safari",
    "com.google.Chrome",
    "com.google.Chrome.canary",
    "com.microsoft.edgemac.Dev",
    "org.mozilla.firefox",
    "company.thebrowser.Browser",
    "com.brave.Browser",
  ])
    assert.equal(tierFor(mac(id)), "read", id);
  for (const id of [
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "dev.warp.Warp-Stable",
    "com.microsoft.VSCode",
    "com.todesktop.230313mzl4w4u92",
    "com.jetbrains.intellij",
    "com.apple.dt.Xcode",
  ])
    assert.equal(tierFor(mac(id)), "click", id);
  for (const id of [
    "com.apple.TextEdit",
    "com.apple.Notes",
    "com.apple.finder",
  ])
    assert.equal(tierFor(mac(id)), "full", id);

  assert.equal(tierFor(win("msedge")), "read");
  assert.equal(tierFor(win("chrome.exe")), "read");
  assert.equal(tierFor(win("WindowsTerminal")), "click");
  assert.equal(tierFor(win("pwsh")), "click");
  assert.equal(tierFor(win("Code")), "click");
  assert.equal(tierFor(win("idea64")), "click");
  assert.equal(tierFor(win("notepad")), "full");
});

test("Claudex, password managers and system settings are never granted", () => {
  for (const id of [
    "dev.claudex.desktop",
    "com.1password.1password",
    "com.bitwarden.desktop",
    "org.keepassxc.keepassxc",
    "com.apple.keychainaccess",
    "com.apple.Passwords",
    "com.apple.systempreferences",
  ])
    assert.ok(neverGranted(mac(id)), id);
  for (const id of [
    "Claudex.exe",
    "1Password",
    "KeePassXC",
    "SystemSettings",
    "regedit",
  ])
    assert.ok(neverGranted(win(id)), id);
  assert.ok(!neverGranted(mac("com.apple.TextEdit")));
  assert.ok(!neverGranted(win("notepad")));
});

test("matching uses ids, not window titles, and ignores case and .exe", () => {
  assert.equal(appKey(" Notepad.EXE "), "notepad");
  // A browser tab titled like a terminal is still the browser.
  assert.equal(tierFor(win("chrome")), "read");
  assert.ok(
    onDeniedList({ id: "com.apple.Notes", name: "Notes" }, ["com.apple.notes"]),
  );
  assert.ok(onDeniedList({ id: "notepad", name: "Notepad" }, ["NOTEPAD.exe"]));
  assert.ok(onDeniedList({ id: "com.apple.Notes", name: "Notes" }, ["notes"]));
  assert.ok(
    !onDeniedList({ id: "com.apple.Notes", name: "Notes" }, ["com.apple.note"]),
  );
});

test("system-wide key combinations are blocked in any spelling", () => {
  assert.equal(normalizeKey("cmd+Q"), "super+q");
  assert.equal(normalizeKey("Option+Command+Esc"), "alt+super+escape");
  for (const key of [
    "super+q",
    "command+q",
    "cmd+option+escape",
    "ctrl+cmd+q",
    "cmd+tab",
    "cmd+space",
    "ctrl+alt+delete",
    "win+l",
    "alt+F4",
    "alt+tab",
    "super",
  ])
    assert.ok(keyBlocked(key), key);
  for (const key of [
    "Return",
    "super+s",
    "ctrl+c",
    "shift+Tab",
    "a",
    "super+z",
  ])
    assert.ok(!keyBlocked(key), key);
});

test("the driver's app list is parsed on both platforms", () => {
  assert.deepEqual(
    parseAppList(
      [
        "TextEdit — com.apple.TextEdit [frontmost, running, last-used=2026-09-26, uses=3]",
        "Notes — com.apple.Notes [last-used=2026-09-20, uses=1]",
        "notepad -- notepad [running, pid=4242, window=Untitled - Notepad]",
        "garbage line",
      ].join("\n"),
    ),
    [
      {
        name: "TextEdit",
        id: "com.apple.TextEdit",
        running: true,
        frontmost: true,
      },
      {
        name: "Notes",
        id: "com.apple.Notes",
        running: false,
        frontmost: false,
      },
      {
        name: "notepad",
        id: "notepad",
        pid: 4242,
        running: true,
        frontmost: false,
      },
    ],
  );
});
