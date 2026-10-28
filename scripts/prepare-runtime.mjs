import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
for (const arg of args.filter((arg) => arg.startsWith("--")))
  if (arg !== "--download-only") throw new Error(`Unknown option: ${arg}`);
if (positional.length > 2)
  throw new Error(
    "Usage: node scripts/prepare-runtime.mjs [darwin|win32|linux] [arm64|x64] [--download-only]",
  );
const platform = positional[0] || process.platform;
const arch = positional[1] || process.arch;
const downloadOnly = args.includes("--download-only");
const version = "0.144.1";
const packageVersion = `${version}-${platform}-${arch}`;
const target = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
}[`${platform}-${arch}`];
if (!target) throw new Error(`Unsupported package target: ${platform}-${arch}`);
const filename = platform === "win32" ? "codex.exe" : "codex";
const usable = (base) => {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8"))
        .version === packageVersion &&
      fs.existsSync(path.join(base, "vendor", target, "bin", filename))
    );
  } catch {
    return false;
  }
};
function run(command, commandArgs) {
  // Passing argv directly also handles Windows paths containing spaces; do not launch npm through cmd.exe.
  const result = spawnSync(command, commandArgs, {
    cwd: project,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      result.error?.message ||
        result.stderr ||
        `${command} failed (${result.status})`,
    );
  return result.stdout;
}
function npmPack(cache) {
  const commandArgs = [
    "pack",
    `@openai/codex@${packageVersion}`,
    "--pack-destination",
    cache,
    "--json",
    "--ignore-scripts",
  ];
  if (process.platform !== "win32") return run("npm", commandArgs);
  const candidates = [
    process.env.npm_execpath,
    path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ].filter(Boolean);
  const cli = candidates.find(
    (candidate) => fs.existsSync(candidate) && /npm-cli\.js$/i.test(candidate),
  );
  if (!cli)
    throw new Error(
      "Cannot locate npm-cli.js. Run this script via npm run package:win so npm_execpath is available.",
    );
  return run(process.execPath, [cli, ...commandArgs]);
}
let base;
try {
  const installed = path.dirname(
    require.resolve(`@openai/codex-${platform}-${arch}/package.json`),
  );
  if (usable(installed)) base = installed;
} catch {}
if (!base) {
  const cache = path.join(project, "build", "downloads", `${platform}-${arch}`);
  fs.mkdirSync(cache, { recursive: true });
  const extracted = path.join(cache, "package");
  if (!usable(extracted)) {
    const result = JSON.parse(npmPack(cache));
    const archive = path.join(cache, path.basename(result[0].filename));
    // Extract into a fresh directory to avoid files left by a previous runtime version.
    const staging = fs.mkdtempSync(path.join(cache, "extract-"));
    try {
      run("tar", ["-xzf", archive, "-C", staging]);
      const candidate = path.join(staging, "package");
      if (!usable(candidate))
        throw new Error(
          `Invalid Codex package: expected ${packageVersion} with vendor/${target}/bin/${filename}`,
        );
      fs.rmSync(extracted, { recursive: true, force: true });
      fs.renameSync(candidate, extracted);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  base = extracted;
}
const vendor = path.join(base, "vendor", target);
if (platform === "win32")
  for (const helper of [
    "codex-windows-sandbox-setup.exe",
    "codex-command-runner.exe",
  ]) {
    if (!fs.existsSync(path.join(vendor, "codex-resources", helper)))
      throw new Error(
        `Windows Codex package is missing sandbox helper: ${helper}`,
      );
  }
if (downloadOnly) {
  console.log(`Verified Codex ${version} for ${target}: ${vendor}`);
  console.log("Download-only: build/runtime was not modified.");
} else {
  const destination = path.join(project, "build", "runtime");
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(vendor, destination, { recursive: true });
  console.log(`Bundled Codex ${version} for ${target}`);
}
