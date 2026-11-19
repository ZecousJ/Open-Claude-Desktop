import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const [edition, target = process.platform, arch = process.arch] = process.argv.slice(2);
if (!["local", "full"].includes(edition) || !["darwin", "win32", "linux"].includes(target) || !["arm64", "x64"].includes(arch))
  throw Error("Usage: npm run package:local|package:full -- [darwin|win32|linux] [arm64|x64]");
if (edition === "full" && !process.env.CLAUDEX_SUB2API_URL)
  throw Error("Set CLAUDEX_SUB2API_URL to your self-hosted service before building the full edition.");
const env = { ...process.env, CLAUDEX_EDITION: edition, COPYFILE_DISABLE: "1" };
const project = fileURLToPath(new URL("../", import.meta.url));

function run(file, args) {
  const result = spawnSync(process.execPath, [file, ...args], { cwd: project, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(require.resolve("typescript/bin/tsc"), ["--noEmit"]);
run(fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)), ["build"]);
run("scripts/build.mjs", []);
run("scripts/prepare-runtime.mjs", [target, arch]);
const platform = target === "darwin" ? "--mac" : target === "win32" ? "--win" : "--linux";
const format = target === "darwin" ? "zip" : target === "win32" ? "nsis" : "tar.gz";
const title = edition === "local" ? "Claudex Local" : "Claudex Self-Hosted";
const options = target === "win32" ? [
  "-c.nsis.artifactName=" + title.replaceAll(" ", "-") + "-Setup-${version}-${arch}.exe",
  ...(process.platform === "win32" ? [] : ["-c.win.signAndEditExecutable=false"]),
] : [];
run(require.resolve("electron-builder/cli.js"), [
  platform, format, "--" + arch, "--publish", "never",
  "-c.appId=dev.openclaudex." + edition,
  "-c.productName=" + title,
  "-c.directories.output=release/" + edition,
  "-c.npmRebuild=false",
  ...options,
]);
