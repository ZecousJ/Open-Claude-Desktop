#!/usr/bin/env node
/**
 * Builds ZecousAI 1.0.31, the bridge that moves ZecousAI users to Claudex
 * (docs/ota.md). Run on a Windows x64 machine with Node 24:
 *
 *   cd tools\zecous-bridge
 *   set CLAUDEX_INSTALLER_URL=https://all.zecous.cn/zecous/downloads/Claudex-Setup-0.0.2.exe
 *   set CLAUDEX_INSTALLER_SHA256=<64 hex>
 *   set CLAUDEX_VERSION=0.0.2
 *   node build.mjs
 *
 * or embed the installer instead of downloading it at run time:
 *
 *   node build.mjs --embed ..\..\release\Claudex-Setup-0.0.2.exe --claudex-version 0.0.2
 *
 * Options: --url, --sha256, --claudex-version, --embed <file>,
 * --service <https url> (default: shared/claudex-service.ts),
 * --skip-install (dependencies already installed), --dry-run (print the
 * plan and write dist/bridge-config.json only; works on any platform).
 *
 * Output (out/):
 *   squirrel/RELEASES, squirrel/ZecousAI-1.0.31-full.nupkg   Squirrel feed for
 *     ZecousAI's Squirrel installs (package id ZecousAI, exe ZecousAI.exe);
 *   ZecousAI-Setup-1.0.31.exe   one-file exe for old NSIS installs: ZecousAI's
 *     updater runs it as `/S /NORESTART /currentuser /D=<folder>`; it ignores
 *     /D for installing and only uses it to remove the old folder.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const bridgeVersion = JSON.parse(
  fs.readFileSync(path.join(here, "package.json"), "utf8"),
).version;

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const flag = (name) => argv.includes(`--${name}`);
const dryRun = flag("dry-run");

function defaultServiceUrl() {
  const text = fs.readFileSync(
    path.join(repo, "shared", "claudex-service.ts"),
    "utf8",
  );
  const match = /defaultClaudexServiceUrl\s*=\s*"([^"]+)"/.exec(text);
  if (!match)
    throw new Error("shared/claudex-service.ts has no default service URL.");
  return match[1];
}

const sha256File = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const embed = option("embed");
const config = {
  claudexVersion: option("claudex-version") ?? process.env.CLAUDEX_VERSION,
  serviceUrl:
    option("service") ?? process.env.CLAUDEX_SERVICE_URL ?? defaultServiceUrl(),
  ...(embed
    ? {
        embeddedInstaller: path.basename(embed),
        installerSha256: sha256File(embed),
      }
    : {
        installerUrl: option("url") ?? process.env.CLAUDEX_INSTALLER_URL,
        installerSha256: (
          option("sha256") ??
          process.env.CLAUDEX_INSTALLER_SHA256 ??
          ""
        ).toLowerCase(),
      }),
};
if (!/^\d+\.\d+\.\d+/.test(config.claudexVersion ?? ""))
  throw new Error("Set --claudex-version or CLAUDEX_VERSION.");
if (!/^[0-9a-f]{64}$/.test(config.installerSha256))
  throw new Error("Set --sha256 or CLAUDEX_INSTALLER_SHA256 (64 hex).");
if (!embed && !/^https:\/\//.test(config.installerUrl ?? ""))
  throw new Error("Set --url or CLAUDEX_INSTALLER_URL (https).");
if (!/^https:\/\//.test(config.serviceUrl))
  throw new Error("The service URL must be https.");

const dist = path.join(here, "dist");
const out = path.join(here, "out");
fs.mkdirSync(dist, { recursive: true });
// Claudex's icon for the exe, the Squirrel setup and the "Updating to
// Claudex…" window (it was Electron's default, owner 2026-10-07).
const icon = path.join(dist, "icon.ico");
fs.copyFileSync(path.join(here, "..", "..", "build", "icon.ico"), icon);
fs.writeFileSync(
  path.join(dist, "bridge-config.json"),
  JSON.stringify(config, null, 2),
);
console.log(
  `ZecousAI ${bridgeVersion} bridge → Claudex ${config.claudexVersion}`,
);
console.log(JSON.stringify(config, null, 2));
if (dryRun) process.exit(0);
if (process.platform !== "win32")
  throw new Error(
    "Build the bridge on Windows (Squirrel and NSIS tools are Windows-only).",
  );

/** npm install with retries: the network drops downloads now and then. */
function npmInstall() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = spawnSync(npm, ["install", "--no-audit", "--no-fund"], {
      cwd: here,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.status === 0) return;
    console.warn(
      `npm install failed (attempt ${attempt}); retrying in ${attempt * 10}s`,
    );
    execFileSync(process.execPath, [
      "-e",
      `setTimeout(()=>{}, ${attempt * 10_000})`,
    ]);
  }
  throw new Error("npm install kept failing.");
}
if (!flag("skip-install")) npmInstall();

const { build } = await import("esbuild");
await build({
  entryPoints: [path.join(here, "src", "main.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: path.join(dist, "main.cjs"),
  external: ["electron"],
});

fs.rmSync(out, { recursive: true, force: true });
const { packager } = await import("@electron/packager");
const [appDir] = await packager({
  dir: here,
  out: path.join(out, "packaged"),
  name: "ZecousAI",
  executableName: "ZecousAI",
  icon,
  appVersion: bridgeVersion,
  platform: "win32",
  arch: "x64",
  asar: true,
  overwrite: true,
  ignore: [/^\/(src|out|build\.mjs|README\.md)(\/|$)/, /^\/node_modules(\/|$)/],
  ...(embed ? { extraResource: [path.resolve(embed)] } : {}),
  win32metadata: {
    CompanyName: "Zecous",
    ProductName: "ZecousAI",
    FileDescription: "ZecousAI",
  },
});

// Squirrel feed: same package id and exe name as ZecousAI's own releases.
const { createWindowsInstaller } = await import("electron-winstaller");
await createWindowsInstaller({
  appDirectory: appDir,
  outputDirectory: path.join(out, "squirrel"),
  name: "ZecousAI",
  exe: "ZecousAI.exe",
  version: bridgeVersion,
  authors: "Zecous",
  description: "ZecousAI",
  noMsi: true,
  noDelta: true,
  setupIcon: icon,
});

// One-file exe for old NSIS installs (electron-builder's portable target
// passes the command line through and returns the app's exit code).
const builder = await import("electron-builder");
await builder.build({
  targets: builder.Platform.WINDOWS.createTarget("portable", builder.Arch.x64),
  prepackaged: appDir,
  config: {
    appId: "ai.zecous.desktop",
    productName: "ZecousAI",
    directories: { output: out },
    win: { signAndEditExecutable: false, icon },
    portable: { artifactName: `ZecousAI-Setup-${bridgeVersion}.exe` },
  },
  publish: "never",
});

for (const file of [
  path.join(out, "squirrel", "RELEASES"),
  path.join(out, "squirrel", `ZecousAI-${bridgeVersion}-full.nupkg`),
  path.join(out, `ZecousAI-Setup-${bridgeVersion}.exe`),
])
  console.log(
    `${fs.existsSync(file) ? sha256File(file) : "MISSING"}  ${path.relative(here, file)}`,
  );
