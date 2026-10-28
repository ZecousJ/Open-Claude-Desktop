import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  macAppBundle,
  planUpdate,
  relocationPlan,
  updateKindFor,
  updateMenuItem,
} from "../../shared/app-update";
import { runUpdateMenuAction } from "../../electron/updates/menu-action";
import { appUpdateMethods } from "../../shared/app-update-api";
import { desktopMethods } from "../../shared/desktop-bridge";
import {
  ChecksumMismatch,
  downloadVerified,
  fileSha256,
} from "../../electron/updates/download";
import {
  clearStaged,
  launchDecision,
  pruneUpdates,
  readStaged,
  writeStaged,
  failedVersions,
} from "../../electron/updates/staging";
import { AppUpdater, updateCheckError } from "../../electron/updates/updater";
import { installTarget, startInstall } from "../../electron/updates/apply";
import { relocateBundle } from "../../electron/updates/relocate";
import {
  claudexBundleId,
  macApplyCommand,
  macApplyScript,
  macRelaunchScript,
  windowsApplyCommand,
  windowsApplyScript,
} from "../../electron/updates/scripts";
import { version as packageVersion } from "../../package.json";

const sha = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");

function temporary(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-ota-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const release = (over: Record<string, string | null> = {}) => ({
  latestVersion: "0.0.2",
  downloadUrl:
    "https://downloads.example.com/claudex/downloads/Claudex-0.0.2-arm64-mac.zip",
  sha256: "a".repeat(64),
  ...over,
});

test("versioning restarted at 0.0.1 (docs/releasing.md)", () => {
  assert.match(packageVersion, /^0\.0\.[1-9]\d*$/);
});

test("the update bridge calls are exposed", () => {
  for (const name of appUpdateMethods) assert.ok(desktopMethods.includes(name));
});

test("updates cover macOS zips and the Windows installer only", () => {
  assert.equal(updateKindFor("darwin", "arm64"), "mac-zip");
  assert.equal(updateKindFor("darwin", "x64"), "mac-zip");
  assert.equal(updateKindFor("win32", "x64"), "win-nsis");
  assert.equal(updateKindFor("linux", "x64"), undefined);
});

test("only a newer, https, checksummed build of the right type is planned", () => {
  const mac = planUpdate(release(), "0.0.1", "darwin", "arm64");
  assert.equal(mac.action, "download");
  assert.equal(
    mac.action === "download" && mac.fileName,
    "Claudex-0.0.2-arm64-mac.zip",
  );
  const reason = (
    r: ReturnType<typeof release>,
    current = "0.0.1",
    platform = "darwin",
  ) => {
    const plan = planUpdate(r, current, platform, "arm64");
    return plan.action === "none" ? plan.reason : "download";
  };
  assert.equal(reason(release(), "0.0.2"), "current");
  assert.equal(reason(release(), "0.1.0"), "downgrade");
  assert.equal(reason(release({ latestVersion: null })), "no-release");
  assert.equal(reason(release({ sha256: null })), "no-checksum");
  assert.equal(reason(release({ sha256: "xyz" })), "no-checksum");
  assert.equal(
    reason(release({ downloadUrl: "http://downloads.example.com/a.zip" })),
    "no-download",
  );
  assert.equal(
    reason(
      release({ downloadUrl: "https://user:pw@downloads.example.com/a.zip" }),
    ),
    "no-download",
  );
  assert.equal(reason(release()), "download");
  assert.equal(reason(release(), "0.0.1", "linux"), "unsupported-platform");
  // A Windows build needs the .exe installer.
  assert.equal(reason(release(), "0.0.1", "win32"), "wrong-file-type");
  const win = planUpdate(
    release({ downloadUrl: "https://x.example/Claudex-Setup-0.0.2.exe" }),
    "0.0.1",
    "win32",
    "x64",
  );
  assert.equal(
    win.action === "download" && win.fileName,
    "Claudex-Setup-0.0.2.exe",
  );
});

test("the menu item follows the updater", () => {
  const base = { supported: true, currentVersion: "0.0.1" } as const;
  assert.equal(updateMenuItem(undefined), undefined);
  for (const phase of ["idle", "up-to-date"] as const)
    assert.deepEqual(updateMenuItem({ ...base, phase }), {
      label: "Check for Updates…",
      enabled: true,
    });
  assert.equal(updateMenuItem({ ...base, phase: "idle" }, false), undefined);
  assert.deepEqual(
    updateMenuItem({ ...base, supported: false, phase: "idle" }, true),
    {
      label: "Check for Updates…",
      enabled: true,
    },
  );
  assert.equal(
    updateMenuItem({
      ...base,
      supported: false,
      phase: "ready",
      version: "0.0.2",
    }),
    undefined,
  );
  assert.deepEqual(updateMenuItem({ ...base, phase: "checking" }), {
    label: "Checking for Updates…",
    enabled: false,
  });
  assert.deepEqual(
    updateMenuItem({ ...base, phase: "downloading", progress: 0.426 }),
    { label: "Downloading Update…", enabled: false },
  );
  assert.deepEqual(
    updateMenuItem({ ...base, phase: "ready", version: "0.0.2" }),
    {
      label: "Restart to Update to 0.0.2",
      enabled: true,
    },
  );
  assert.deepEqual(updateMenuItem({ ...base, phase: "error" }), {
    label: "Check for Updates…",
    enabled: true,
    failed: true,
  });
});

test("Restart to Update immediately uses the guarded restart without a notice", async () => {
  const actions: string[] = [];
  const options = {
    restart: () => {
      actions.push("restart");
    },
    check: async () => {
      actions.push("check");
    },
  };
  await runUpdateMenuAction({
    ...options,
    status: {
      phase: "ready",
      supported: true,
      currentVersion: "1.0.0",
      version: "1.1.0",
    },
  });
  assert.deepEqual(actions, ["restart"]);
  for (const phase of [
    "idle",
    "checking",
    "downloading",
    "up-to-date",
    "error",
  ] as const)
    await runUpdateMenuAction({
      ...options,
      status: { phase, supported: true, currentVersion: "1.0.0" },
    });
  assert.deepEqual(actions, [
    "restart",
    "check",
    "check",
    "check",
    "check",
    "check",
  ]);
});

test("manual update failures distinguish network guidance from other errors", () => {
  assert.match(
    updateCheckError(new Error("net::ERR_CONNECTION_REFUSED")),
    /firewall or proxy.*your Claudex service's website/,
  );
  assert.equal(
    updateCheckError(new Error("server returned 500")),
    "Failed to check for updates: server returned 500",
  );
});

test("a misnamed bundle moves beside itself as Claudex.app", () => {
  assert.equal(
    macAppBundle("/Applications/OtherName.app/Contents/MacOS/Claudex"),
    "/Applications/OtherName.app",
  );
  assert.equal(macAppBundle("C:\\Programs\\Claudex\\Claudex.exe"), undefined);
  const plan = (bundle: string, targetVersion?: string | null) =>
    relocationPlan({ bundle, version: "0.0.2", targetVersion });
  assert.deepEqual(plan("/Applications/Claudex.app"), { action: "none" });
  assert.deepEqual(plan("/Applications/OtherName.app"), {
    action: "rename",
    target: "/Applications/Claudex.app",
  });
  assert.deepEqual(
    plan("/Applications/OtherName.app", "0.0.1").action,
    "replace",
  );
  assert.deepEqual(plan("/Applications/OtherName.app", null).action, "replace");
  assert.deepEqual(
    plan("/Applications/OtherName.app", "0.0.2").action,
    "defer",
  );
  assert.deepEqual(
    plan("/Applications/OtherName.app", "0.0.3").action,
    "defer",
  );
  assert.deepEqual(
    plan("/private/var/folders/x/AppTranslocation/1/d/OtherName.app"),
    { action: "none" },
  );
  assert.deepEqual(plan("/Volumes/Claudex/OtherName.app"), { action: "none" });
});

function fakeSpawn(
  calls: { command: string; args: string[] }[],
  /** What a waited-for process (the Windows task launcher) exits with. */
  exitCode = 0,
) {
  return ((command: string, args: string[]) => {
    calls.push({ command, args });
    return {
      unref() {},
      once(event: string, listener: (code?: number) => void) {
        if (event === "spawn") queueMicrotask(() => listener());
        if (event === "exit") queueMicrotask(() => listener(exitCode));
      },
    };
  }) as never;
}

/** The PowerShell an -EncodedCommand carries. */
const encodedScript = (args: string[]) =>
  Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString(
    "utf16le",
  );

function fakeBundle(folder: string, name: string, version: string) {
  const bundle = path.join(folder, name);
  fs.mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(
    path.join(bundle, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${claudexBundleId}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>`,
  );
  fs.writeFileSync(path.join(bundle, "Contents", "MacOS", "Claudex"), version);
  return bundle;
}

test("relocation renames, replaces an older Claudex.app or gives way to a newer one", (t) => {
  const run = (targetVersion?: string) => {
    const folder = temporary(t);
    const ours = fakeBundle(folder, "OtherName.app", "0.0.2");
    if (targetVersion) fakeBundle(folder, "Claudex.app", targetVersion);
    const calls: { command: string; args: string[] }[] = [];
    const result = relocateBundle({
      execPath: path.join(ours, "Contents", "MacOS", "Claudex"),
      version: "0.0.2",
      pid: 4242,
      scriptDir: path.join(folder, "updates"),
      spawnImpl: fakeSpawn(calls),
      now: () => 7,
    });
    return { folder, ours, calls, result };
  };
  const renamed = run();
  assert.equal(renamed.result.relaunch, true);
  assert.ok(!fs.existsSync(renamed.ours));
  assert.equal(
    fs.readFileSync(
      path.join(renamed.folder, "Claudex.app/Contents/MacOS/Claudex"),
      "utf8",
    ),
    "0.0.2",
  );
  assert.deepEqual(renamed.calls[0].args.slice(1), [
    "4242",
    path.join(renamed.folder, "Claudex.app"),
    "",
  ]);
  const replaced = run("0.0.1");
  assert.equal(
    fs.readFileSync(
      path.join(replaced.folder, "Claudex.app/Contents/MacOS/Claudex"),
      "utf8",
    ),
    "0.0.2",
  );
  // The older copy waits beside it for the helper to remove it.
  assert.equal(
    replaced.calls[0].args[3],
    path.join(replaced.folder, ".Claudex-previous-7.app"),
  );
  const deferred = run("0.0.3");
  assert.ok(fs.existsSync(deferred.ours), "removed by the helper after exit");
  assert.equal(
    fs.readFileSync(
      path.join(deferred.folder, "Claudex.app/Contents/MacOS/Claudex"),
      "utf8",
    ),
    "0.0.3",
  );
  assert.equal(deferred.calls[0].args[3], deferred.ours);
});

test("relocation keeps running in place when the folder can't be changed", (t) => {
  if (process.getuid?.() === 0) return t.skip("root can write anywhere");
  const folder = temporary(t);
  const ours = fakeBundle(folder, "OtherName.app", "0.0.2");
  const scriptDir = path.join(temporary(t), "updates");
  const calls: { command: string; args: string[] }[] = [];
  fs.chmodSync(folder, 0o555);
  let result;
  try {
    result = relocateBundle({
      execPath: path.join(ours, "Contents", "MacOS", "Claudex"),
      version: "0.0.2",
      pid: 1,
      scriptDir,
      spawnImpl: fakeSpawn(calls),
    });
  } finally {
    fs.chmodSync(folder, 0o755);
  }
  assert.equal(result.relaunch, false);
  assert.ok(result.relaunch === false && result.error);
  assert.equal(calls.length, 0);
  assert.ok(fs.existsSync(ours));
});

/** A server that drops the first response halfway and honours Range after. */
async function flakyServer(t: TestContext, body: Buffer) {
  let requests = 0;
  const ranges: (string | undefined)[] = [];
  const server = http.createServer((request, response) => {
    requests++;
    ranges.push(request.headers.range);
    const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
    if (!range) {
      response.writeHead(200, { "Content-Length": body.length });
      response.write(body.subarray(0, Math.floor(body.length / 2)));
      setTimeout(() => response.socket?.destroy(), 20);
      return;
    }
    const start = Number(range[1]);
    response.writeHead(206, {
      "Content-Length": body.length - start,
      "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}`,
    });
    response.end(body.subarray(start));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/Claudex.zip`,
    ranges,
    count: () => requests,
  };
}

test("a dropped download resumes with Range and is verified", async (t) => {
  const body = Buffer.alloc(256 * 1024, 7);
  body.write("claudex");
  const server = await flakyServer(t, body);
  const file = path.join(temporary(t), "Claudex.zip");
  const progress: number[] = [];
  await downloadVerified({
    url: server.url,
    file,
    sha256: sha(body),
    sleep: async () => {},
    onProgress: (received) => progress.push(received),
  });
  assert.equal(await fileSha256(file), sha(body));
  assert.equal(server.count(), 2);
  assert.equal(server.ranges[0], undefined);
  assert.match(server.ranges[1] ?? "", /^bytes=\d+-$/);
  assert.equal(progress.at(-1), body.length);
  assert.ok(!fs.existsSync(`${file}.part`));
});

test("a download with the wrong checksum is refused and removed", async (t) => {
  const body = Buffer.from("not the published build");
  const server = http.createServer((_request, response) => response.end(body));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  const file = path.join(temporary(t), "Claudex.zip");
  await assert.rejects(
    downloadVerified({
      url: `http://127.0.0.1:${port}/Claudex.zip`,
      file,
      sha256: "b".repeat(64),
      sleep: async () => {},
    }),
    ChecksumMismatch,
  );
  assert.ok(!fs.existsSync(file));
  assert.ok(!fs.existsSync(`${file}.part`));
});

test("the updater downloads, stages and reports ready; never a downgrade", async (t) => {
  const userData = temporary(t);
  const content = Buffer.from("zip bytes");
  const statuses: string[] = [];
  let latest = "0.0.2";
  const updater = new AppUpdater({
    userData,
    currentVersion: "0.0.1",
    platform: "darwin",
    arch: "arm64",
    packaged: true,
    fetchRelease: async () =>
      release({ latestVersion: latest, sha256: sha(content) }),
    download: async ({ file, onProgress }) => {
      onProgress?.(content.length, content.length);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    },
    onStatus: (status) => statuses.push(status.phase),
  });
  const first = await updater.check();
  assert.equal(first.status.phase, "ready");
  assert.equal(first.status.version, "0.0.2");
  assert.deepEqual(statuses.slice(0, 2), ["checking", "downloading"]);
  const staged = readStaged(updater.dir);
  assert.equal(staged?.version, "0.0.2");
  assert.equal(staged?.attempts, 0);
  // The service went back to this build's version: the staged build is dropped.
  latest = "0.0.1";
  const second = await updater.check();
  assert.equal(second.status.phase, "up-to-date");
  assert.equal(readStaged(updater.dir), undefined);
  // An older version is never installed.
  latest = "0.0.0";
  assert.equal((await updater.check()).status.phase, "up-to-date");
});

test("a staged update that was tried before is offered as a retry", async (t) => {
  const userData = temporary(t);
  const content = Buffer.from("zip bytes");
  const updater = new AppUpdater({
    userData,
    currentVersion: "0.0.1",
    platform: "darwin",
    arch: "arm64",
    packaged: true,
    fetchRelease: async () =>
      release({ latestVersion: "0.0.2", sha256: sha(content) }),
    download: async ({ file }) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    },
  });
  const ready = (await updater.check()).status;
  assert.equal(ready.phase, "ready");
  assert.equal(ready.retry, undefined);
  // The install ran (counting an attempt) and the staged update is still there.
  const staged = readStaged(updater.dir)!;
  writeStaged(updater.dir, { ...staged, attempts: 1 });
  assert.equal(updater.status().retry, true);
});

test("the updater refuses a release without a checksum, including local accounts, but skips dev builds", async (t) => {
  const userData = temporary(t);
  const options = {
    userData,
    currentVersion: "0.0.1",
    platform: "darwin",
    arch: "arm64",
    packaged: true,
    fetchRelease: async () => release({ sha256: null }),
    download: async () => assert.fail("nothing is downloaded"),
  };
  const refused = await new AppUpdater(options).check();
  assert.equal(refused.status.phase, "error");
  assert.match(refused.status.error ?? "", /checksum/);
  const local = new AppUpdater(options);
  assert.equal(local.menuVisible(), true);
  assert.equal(local.supported(), true);
  assert.equal((await local.check()).status.phase, "error");
  const dev = new AppUpdater({ ...options, packaged: false });
  assert.equal(dev.menuVisible(), false);
  assert.equal(dev.supported(), false);
});

test("update menu visibility follows installation and disabled updates, not sign-in", (t) => {
  const previous = process.env.CLAUDEX_DISABLE_UPDATES;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDEX_DISABLE_UPDATES;
    else process.env.CLAUDEX_DISABLE_UPDATES = previous;
  });
  delete process.env.CLAUDEX_DISABLE_UPDATES;
  const updater = new AppUpdater({
    userData: temporary(t),
    currentVersion: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    packaged: true,
    fetchRelease: async () => release(),
  });
  assert.equal(updater.menuVisible(), true);
  assert.equal(updater.supported(), true);
  process.env.CLAUDEX_DISABLE_UPDATES = "1";
  assert.equal(updater.menuVisible(), false);
  assert.equal(updater.supported(), false);
});

test("a staged update left from the last run installs at launch, twice at most", (t) => {
  const dir = temporary(t);
  const file = path.join(dir, "Claudex-0.0.2-arm64-mac.zip");
  fs.writeFileSync(file, "zip");
  const staged = {
    version: "0.0.2",
    kind: "mac-zip" as const,
    file,
    sha256: sha("zip"),
    stagedAt: 1,
    attempts: 0,
  };
  writeStaged(dir, staged);
  assert.equal(launchDecision(dir, "0.0.1").action, "defer");
  writeStaged(dir, { ...staged, attempts: 2 });
  assert.equal(launchDecision(dir, "0.0.1").action, "none");
  assert.deepEqual(failedVersions(dir), ["0.0.2"]);
  // Already running the staged version: cleaned up.
  fs.writeFileSync(file, "zip");
  writeStaged(dir, staged);
  assert.equal(launchDecision(dir, "0.0.2").action, "none");
  assert.ok(!fs.existsSync(file));
  // A record pointing outside the updates folder is ignored.
  writeStaged(dir, { ...staged, file: "/etc/passwd" });
  assert.equal(readStaged(dir), undefined);
});

test("installing re-verifies the file and passes paths as arguments, not code", async (t) => {
  const dir = temporary(t);
  const file = path.join(dir, "Claudex Setup 0.0.2.exe");
  fs.writeFileSync(file, "installer");
  const staged = {
    version: "0.0.2",
    kind: "win-nsis" as const,
    file,
    sha256: sha("installer"),
    stagedAt: 1,
    attempts: 0,
  };
  writeStaged(dir, staged);
  const calls: { command: string; args: string[] }[] = [];
  await startInstall({
    dir,
    staged,
    relaunch: true,
    pid: 99,
    execPath: "C:\\Users\\a b\\AppData\\Local\\Programs\\Claudex\\Claudex.exe",
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    spawnImpl: fakeSpawn(calls),
  });
  assert.equal(
    calls[0].command,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  // The helper runs as a scheduled task, outside Claudex's job (it was
  // ended with Claudex before it could install), with its paths quoted.
  assert.equal(calls.length, 1);
  const script = encodedScript(calls[0].args);
  assert.match(script, /Register-ScheduledTask -TaskName 'Claudex Update 99'/);
  assert.match(script, /Start-ScheduledTask -TaskName 'Claudex Update 99'/);
  assert.match(
    script,
    /-InstallDir "C:\\Users\\a b\\AppData\\Local\\Programs\\Claudex"/,
  );
  assert.match(script, /-Relaunch 1 /);
  assert.match(script, /-ExeName Claudex\.exe -TaskName "Claudex Update 99"/);
  assert.equal(readStaged(dir)?.attempts, 1);
  // A file changed after verification is not installed.
  fs.writeFileSync(file, "tampered");
  await assert.rejects(
    startInstall({
      dir,
      staged,
      relaunch: false,
      pid: 99,
      execPath: "C:\\Claudex\\Claudex.exe",
      platform: "win32",
      spawnImpl: fakeSpawn(calls),
    }),
    /changed on disk/,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    installTarget("/Applications/Claudex.app/Contents/MacOS/Claudex", "darwin"),
    "/Applications/Claudex.app",
  );
});

test("without the Task Scheduler the Windows helper starts directly", async (t) => {
  const dir = temporary(t);
  const file = path.join(dir, "Claudex-Setup-0.0.2.exe");
  fs.writeFileSync(file, "installer");
  const staged = {
    version: "0.0.2",
    kind: "win-nsis" as const,
    file,
    sha256: sha("installer"),
    stagedAt: 1,
    attempts: 0,
  };
  writeStaged(dir, staged);
  const calls: { command: string; args: string[] }[] = [];
  await startInstall({
    dir,
    staged,
    relaunch: true,
    pid: 7,
    execPath: "C:\\Claudex\\Claudex.exe",
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    spawnImpl: fakeSpawn(calls, 1),
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes("-EncodedCommand"));
  const args = calls[1].args;
  assert.ok(args.includes("-File"));
  assert.equal(args[args.indexOf("-InstallDir") + 1], "C:\\Claudex");
  assert.equal(args[args.indexOf("-Relaunch") + 1], "1");
});

test("an install that cannot start still counts as an attempt, so the retry shows at the next start", async (t) => {
  const dir = temporary(t);
  const file = path.join(dir, "Claudex-0.0.2.zip");
  fs.writeFileSync(file, "archive");
  const staged = {
    version: "0.0.2",
    kind: "mac-zip" as const,
    file,
    sha256: sha("archive"),
    stagedAt: 1,
    attempts: 0,
  };
  writeStaged(dir, staged);
  const calls: { command: string; args: string[] }[] = [];
  // The folder holding the bundle does not exist, so it can't be written.
  await assert.rejects(
    startInstall({
      dir,
      staged,
      relaunch: true,
      pid: 99,
      execPath: path.join(dir, "missing/Claudex.app/Contents/MacOS/Claudex"),
      platform: "darwin",
      spawnImpl: fakeSpawn(calls),
    }),
    /ENOENT|EACCES/,
  );
  assert.equal(calls.length, 0);
  assert.equal(readStaged(dir)?.attempts, 1);
});

test("the helper scripts are fixed text and the Windows one installs silently for this user", () => {
  assert.match(windowsApplyScript, /\/S \/currentuser \/D=\$InstallDir/);
  for (const script of [macApplyScript, windowsApplyScript, macRelaunchScript])
    assert.ok(!script.includes("${"), "no template splicing");
  const mac = macApplyCommand("/tmp/x.sh", {
    pid: 1,
    file: "/u/a.zip",
    target: "/Applications/Claudex.app",
    relaunch: false,
    resultFile: "/u/r.json",
    version: "0.0.2",
    stagedRecord: "/u/staged.json",
  });
  assert.deepEqual(mac.args.slice(1), [
    "1",
    "/u/a.zip",
    "/Applications/Claudex.app",
    "0",
    "/u/r.json",
    "0.0.2",
    claudexBundleId,
    "/u/staged.json",
    "0",
  ]);
  const win = windowsApplyCommand("C:\\u\\s.ps1", {
    ...{
      pid: 1,
      file: "a",
      target: "b",
      relaunch: false,
      resultFile: "r",
      version: "v",
      stagedRecord: "s",
    },
  });
  assert.ok(win.args.includes("-File"));
});

test(
  "the macOS helper replaces the bundle, and rolls back on a wrong app",
  { skip: process.platform !== "darwin" },
  (t) => {
    const root = temporary(t);
    const apps = path.join(root, "Applications");
    fs.mkdirSync(apps);
    const current = fakeBundle(apps, "Claudex.app", "0.0.1");
    const build = path.join(root, "build");
    fs.mkdirSync(build);
    fakeBundle(build, "Claudex.app", "0.0.2");
    const zip = path.join(root, "Claudex-0.0.2.zip");
    execFileSync("/usr/bin/ditto", [
      "-c",
      "-k",
      "--keepParent",
      path.join(build, "Claudex.app"),
      zip,
    ]);
    const script = path.join(root, "install.sh");
    fs.writeFileSync(script, macApplyScript, { mode: 0o700 });
    const result = path.join(root, "result.json");
    const staged = path.join(root, "staged.json");
    fs.writeFileSync(staged, "{}");
    const gone = spawnSync("/usr/bin/true").pid!;
    const run = (version: string) =>
      spawnSync(
        "/bin/bash",
        macApplyCommand(script, {
          pid: gone,
          file: zip,
          target: current,
          relaunch: false,
          resultFile: result,
          version,
          stagedRecord: staged,
        }).args,
        { encoding: "utf8" },
      );
    // The zip holds 0.0.2, not 0.0.3: refused, the installed app untouched.
    assert.equal(run("0.0.3").status, 1);
    assert.equal(JSON.parse(fs.readFileSync(result, "utf8")).ok, false);
    assert.equal(
      fs.readFileSync(path.join(current, "Contents/MacOS/Claudex"), "utf8"),
      "0.0.1",
    );
    assert.equal(run("0.0.2").status, 0);
    assert.equal(JSON.parse(fs.readFileSync(result, "utf8")).ok, true);
    assert.equal(
      fs.readFileSync(path.join(current, "Contents/MacOS/Claudex"), "utf8"),
      "0.0.2",
    );
    assert.ok(!fs.existsSync(zip) && !fs.existsSync(staged));
    assert.deepEqual(
      fs.readdirSync(apps).filter((name) => name.startsWith(".claudex-update")),
      [],
    );
  },
);

test("the window leaves the update to Claudex while it checks, fetches or has staged it", async () => {
  const { selfUpdating, recheckFor } =
    await import("../../src/updates/useAppUpdate");
  const update = {
    state: "available" as const,
    currentVersion: "0.0.3",
    latestVersion: "0.0.4",
  };
  const status = (phase: string, version?: string, supported = true) =>
    ({ phase, supported, currentVersion: "0.0.3", version }) as never;
  assert.equal(selfUpdating(status("checking"), update), true);
  assert.equal(selfUpdating(status("idle"), update), true);
  assert.equal(selfUpdating(status("downloading", "0.0.4"), update), true);
  assert.equal(selfUpdating(status("ready", "0.0.4"), update), true);
  // A release its last check came before (or that failed, or found an older
  // one) is looked for again first; the download page is the way out only
  // when that check cannot update either.
  assert.equal(selfUpdating(status("up-to-date"), update), true);
  assert.equal(selfUpdating(status("error"), update), true);
  assert.equal(selfUpdating(status("ready", "0.0.3"), update), true);
  recheckFor("0.0.4");
  assert.equal(selfUpdating(status("error"), update), false);
  assert.equal(selfUpdating(status("up-to-date"), update), false);
  assert.equal(
    selfUpdating(status("checking", undefined, false), update),
    false,
  );
  assert.equal(selfUpdating(status("ready", "0.0.3"), update), false);
  assert.equal(selfUpdating(status("ready", "0.0.4"), update), true);
});

test("Check for Updates… marks its checking and downloading as manual; the background check does not", async (t) => {
  const userData = temporary(t);
  const content = Buffer.from("zip bytes");
  const seen: { phase: string; manual?: boolean }[] = [];
  const updater = new AppUpdater({
    userData,
    currentVersion: "0.0.1",
    platform: "darwin",
    arch: "arm64",
    packaged: true,
    fetchRelease: async () =>
      release({ latestVersion: "0.0.2", sha256: sha(content) }),
    download: async ({ file }) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    },
    onStatus: ({ phase, manual }) => seen.push({ phase, manual }),
  });
  await updater.check({ manual: true });
  assert.deepEqual(
    seen.filter((s) => s.phase !== "ready").map((s) => s.manual),
    seen.filter((s) => s.phase !== "ready").map(() => true),
  );
  assert.equal(updater.status().manual, undefined);
  seen.length = 0;
  fs.rmSync(updater.dir, { recursive: true, force: true });
  await updater.check();
  assert.ok(seen.every((s) => !s.manual));
});

// A Linux package's staged record reads back like a Mac or Windows one:
// Relaunch to update used to find no update on Linux and fail with "No
// update is ready to install."
test("a staged Linux package reads back", (t) => {
  const dir = path.join(temporary(t), "updates");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "claudex_0.0.2_amd64.deb");
  fs.writeFileSync(file, "deb");
  for (const kind of ["linux-deb", "linux-rpm", "linux-tar"] as const) {
    writeStaged(dir, {
      version: "0.0.2",
      kind,
      file,
      sha256: "a".repeat(64),
      stagedAt: 1,
      attempts: 0,
    });
    assert.equal(readStaged(dir)?.kind, kind);
  }
});

test("the interface pack is offered on a full check, on a check with an update staged, and on the native feed's", () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "../../electron/updates/launch.ts"),
    "utf8",
  );
  const uses = source.match(/offerInterface\(release\.ui\)/g) ?? [];
  assert.equal(uses.length, 3);
  assert.match(
    source,
    /peekRelease: async \(\) => \{[^}]*?offerInterface\(release\.ui\)/s,
  );
  assert.match(
    source,
    /peekVersion: async \(\) => \{[^]*?claudexRelease\(linuxPackage, device\)[^]*?offerInterface\(release\.ui\)/,
  );
});

test(
  "an update file that can't be removed is left for the next start, never failing it",
  { skip: process.platform === "win32" },
  (t) => {
    const dir = temporary(t);
    const file = path.join(dir, "Claudex-Setup-0.0.33.exe");
    fs.writeFileSync(file, "installer");
    writeStaged(dir, {
      version: "0.0.33",
      kind: "win-nsis",
      file,
      sha256: sha("installer"),
      stagedAt: 1,
      attempts: 1,
    });
    // A folder whose files can't be removed (on Windows: the installer
    // still running holds its file).
    fs.chmodSync(dir, 0o500);
    try {
      assert.doesNotThrow(() => pruneUpdates(dir));
      assert.doesNotThrow(() => clearStaged(dir));
      assert.ok(fs.existsSync(file));
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  },
);

test("Windows takes the app pack when it runs the same Electron with the same Codex files", () => {
  const sum = "a".repeat(64);
  const keep = "b".repeat(64);
  const release = {
    latestVersion: "0.0.3",
    downloadUrl: "https://x.example/Claudex-Setup-0.0.3.exe",
    sha256: sum,
    appPack: {
      url: "https://x.example/Claudex-0.0.3-x64-app.zip",
      sha256: "c".repeat(64),
      runtime: "44.4.3",
      keep,
    },
  };
  const pack = planUpdate(release, "0.0.2", "win32", "x64", undefined, {
    runtime: "44.4.3",
    keep,
  });
  assert.equal(pack.action === "download" && pack.kind, "win-app");
  assert.equal(
    pack.action === "download" && pack.fileName,
    "Claudex-0.0.3-x64-app.zip",
  );
  // Another Electron, other Codex files, or nothing read: the installer.
  for (const installed of [
    { runtime: "45.0.0", keep },
    { runtime: "44.4.3", keep: "d".repeat(64) },
    { runtime: "44.4.3" },
    undefined,
  ]) {
    const plan = planUpdate(
      release,
      "0.0.2",
      "win32",
      "x64",
      undefined,
      installed,
    );
    assert.equal(plan.action === "download" && plan.kind, "win-nsis");
  }
  // macOS never takes it.
  const mac = planUpdate(
    {
      ...release,
      downloadUrl: "https://x.example/Claudex-0.0.3-arm64-mac.zip",
    },
    "0.0.2",
    "darwin",
    "arm64",
    undefined,
    { runtime: "44.4.3", keep },
  );
  assert.equal(mac.action === "download" && mac.kind, "mac-zip");
});

test("an app pack installs through the scheduled task with the pack script", async (t) => {
  const dir = temporary(t);
  const file = path.join(dir, "Claudex-0.0.3-x64-app.zip");
  fs.writeFileSync(file, "pack");
  const staged = {
    version: "0.0.3",
    kind: "win-app" as const,
    file,
    sha256: sha("pack"),
    stagedAt: 1,
    attempts: 0,
  };
  writeStaged(dir, staged);
  assert.equal(readStaged(dir)?.kind, "win-app");
  const calls: { command: string; args: string[] }[] = [];
  await startInstall({
    dir,
    staged,
    relaunch: true,
    pid: 77,
    execPath: "C:\\Claudex\\Claudex.exe",
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    spawnImpl: fakeSpawn(calls),
  });
  assert.equal(calls.length, 1);
  assert.match(
    encodedScript(calls[0].args),
    /Register-ScheduledTask -TaskName 'Claudex Update 77'/,
  );
  const script = fs.readFileSync(path.join(dir, "install-update.ps1"), "utf8");
  assert.match(script, /Expand-Archive -LiteralPath \$Installer/);
  assert.match(script, /\$kept = 'codex'/);
  assert.doesNotMatch(script, /Start-Process -FilePath \$Installer/);
});
