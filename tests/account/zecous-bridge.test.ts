import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bridgeMode,
  claudexExe,
  claudexInstallDir,
  claudexInstallerArgs,
  cleanupCommand,
  squirrelCleanupCommand,
  zecousStartMenuFolder,
  parseBridgeArgs,
  parseBridgeConfig,
  removableZecousFolder,
  squirrelUpdateExe,
  zecousShortcuts,
} from "../../tools/zecous-bridge/src/logic";
import { fileSha256 } from "../../electron/updates/download";

const bridgePackage = JSON.parse(
  fs.readFileSync(
    new URL("../../tools/zecous-bridge/package.json", import.meta.url),
    "utf8",
  ),
);

test("the bridge is ZecousAI 1.0.31", () => {
  assert.equal(bridgePackage.productName, "ZecousAI");
  assert.equal(bridgePackage.version, "1.0.31");
});

test("the old NSIS updater's command line is understood; /D may hold spaces", () => {
  assert.deepEqual(
    parseBridgeArgs([
      "/S",
      "/NORESTART",
      "/currentuser",
      "/D=C:\\Users\\A B\\AppData\\Local\\Programs\\ZecousAI",
    ]),
    {
      silent: true,
      installDir: "C:\\Users\\A B\\AppData\\Local\\Programs\\ZecousAI",
    },
  );
  // Node splits an unquoted /D= at spaces; the pieces run to the end.
  assert.equal(
    parseBridgeArgs(["/S", "/D=C:\\Program", "Files\\ZecousAI"]).installDir,
    "C:\\Program Files\\ZecousAI",
  );
  assert.equal(parseBridgeArgs(["/D=relative\\dir"]).installDir, undefined);
  assert.deepEqual(parseBridgeArgs([]), { silent: false });
  assert.equal(
    parseBridgeArgs(["--squirrel-updated", "1.0.31"]).squirrelEvent,
    "updated",
  );
  assert.equal(
    parseBridgeArgs(["--squirrel-firstrun"]).squirrelEvent,
    "firstrun",
  );
});

test("Squirrel installs are told apart by Update.exe one folder up", () => {
  const exe =
    "C:\\Users\\a\\AppData\\Local\\ZecousAI\\app-1.0.31\\ZecousAI.exe";
  assert.equal(
    squirrelUpdateExe(exe),
    "C:\\Users\\a\\AppData\\Local\\ZecousAI\\Update.exe",
  );
  assert.equal(
    bridgeMode(exe, (file) => file.endsWith("ZecousAI\\Update.exe")),
    "squirrel",
  );
  assert.equal(
    bridgeMode(exe, () => false),
    "nsis",
  );
});

test("Claudex installs per user, silently, in its default folder", () => {
  const dir = claudexInstallDir(
    { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
    "C:\\Users\\a",
  );
  assert.equal(dir, "C:\\Users\\a\\AppData\\Local\\Programs\\Claudex");
  assert.equal(
    claudexExe(dir),
    "C:\\Users\\a\\AppData\\Local\\Programs\\Claudex\\Claudex.exe",
  );
  assert.deepEqual(claudexInstallerArgs(), ["/S", "/currentuser"]);
});

test("only a real ZecousAI folder is removed", () => {
  const options = {
    exists: (file: string) => file.endsWith("ZecousAI.exe"),
    home: "C:\\Users\\a",
    claudexDir: "C:\\Users\\a\\AppData\\Local\\Programs\\Claudex",
  };
  assert.equal(
    removableZecousFolder(
      "C:\\Users\\a\\AppData\\Local\\Programs\\ZecousAI\\",
      options,
    ),
    "C:\\Users\\a\\AppData\\Local\\Programs\\ZecousAI",
  );
  for (const refused of [
    "C:\\",
    "C:",
    "C:\\Users\\a",
    "C:\\Windows",
    "C:\\Program Files",
    options.claudexDir,
    undefined,
  ])
    assert.equal(
      removableZecousFolder(refused, options),
      undefined,
      String(refused),
    );
  assert.equal(
    removableZecousFolder("D:\\Apps\\Other", {
      ...options,
      exists: () => false,
    }),
    undefined,
  );
});

test("shortcuts and cleanup command", () => {
  const shortcuts = zecousShortcuts(
    { APPDATA: "C:\\Users\\a\\AppData\\Roaming", USERPROFILE: "C:\\Users\\a" },
    "C:\\Users\\a",
  );
  assert.ok(shortcuts.includes("C:\\Users\\a\\Desktop\\ZecousAI.lnk"));
  assert.ok(
    shortcuts.includes(
      "C:\\Users\\a\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\ZecousAI.lnk",
    ),
  );
  const command = cleanupCommand({
    folders: ["C:\\P\\ZecousAI"],
    files: ["C:\\D\\ZecousAI.lnk"],
  });
  assert.equal(
    command,
    'ping -n 4 127.0.0.1 >nul & del /f /q "C:\\D\\ZecousAI.lnk" & rmdir /s /q "C:\\P\\ZecousAI"',
  );
  assert.throws(() =>
    cleanupCommand({ folders: ['C:\\x" & calc'], files: [] }),
  );
  assert.throws(() => cleanupCommand({ folders: ["C:\\%PATH%"], files: [] }));
});

test("the baked-in configuration requires https and a checksum", () => {
  const good = {
    installerUrl:
      "https://all.zecous.cn/zecous/downloads/Claudex-Setup-0.0.2.exe",
    installerSha256: "A".repeat(64),
    claudexVersion: "0.0.2",
    serviceUrl: "https://claudex.zecous.cn/",
  };
  assert.deepEqual(parseBridgeConfig(good), {
    installerUrl: good.installerUrl,
    installerSha256: "a".repeat(64),
    claudexVersion: "0.0.2",
    serviceUrl: "https://claudex.zecous.cn",
  });
  assert.throws(
    () => parseBridgeConfig({ ...good, installerSha256: "" }),
    /checksum/,
  );
  assert.throws(
    () => parseBridgeConfig({ ...good, installerUrl: "http://x/y.exe" }),
    /https/,
  );
  assert.throws(
    () => parseBridgeConfig({ ...good, serviceUrl: "http://x" }),
    /https/,
  );
  const embedded = parseBridgeConfig({
    ...good,
    installerUrl: undefined,
    embeddedInstaller: "Claudex-Setup-0.0.2.exe",
  });
  assert.equal(embedded.embeddedInstaller, "Claudex-Setup-0.0.2.exe");
  assert.throws(() =>
    parseBridgeConfig({
      ...good,
      installerUrl: undefined,
      embeddedInstaller: "..\\evil.exe",
    }),
  );
});

test("the installer checksum is a plain SHA-256 of the file", async () => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bridge-")),
    "a.exe",
  );
  fs.writeFileSync(file, "installer");
  assert.equal(
    await fileSha256(file),
    createHash("sha256").update("installer").digest("hex"),
  );
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("Squirrel cleanup removes only a ZecousAI root, its shortcuts and Start menu folder", () => {
  const root = "C:\\Users\\u\\AppData\\Local\\Programs\\ZecousAI";
  const menu =
    "C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\ZecousAI";
  const command = squirrelCleanupCommand(
    root,
    ["C:\\Users\\u\\Desktop\\ZecousAI.lnk"],
    menu,
  );
  assert.match(command, /^ping -n 16 /);
  assert.ok(command.includes(`rmdir /s /q "${root}"`));
  assert.ok(command.includes(`rmdir /s /q "${menu}"`));
  // The company folder Squirrel's update adds, only when empty.
  assert.ok(
    command.includes(
      ' & rmdir "C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Zecous"',
    ),
  );
  // A second pass for the version folder Squirrel was still holding.
  assert.ok(
    command.endsWith(`& ping -n 11 127.0.0.1 >nul & rmdir /s /q "${root}"`),
  );
  assert.ok(
    command.includes('del /f /q "C:\\Users\\u\\Desktop\\ZecousAI.lnk"'),
  );
  assert.throws(() => squirrelCleanupCommand("C:\\Users\\u", [], menu));
  assert.equal(
    zecousStartMenuFolder(
      { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
      "C:\\Users\\u",
    ),
    menu,
  );
});
