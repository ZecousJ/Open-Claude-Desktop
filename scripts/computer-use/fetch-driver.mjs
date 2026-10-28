// Downloads the pinned computer use driver, verifies it and installs it into
// build/computer-use, which electron-builder packages as resources/computer-use.
//
// Usage: node scripts/computer-use/fetch-driver.mjs [darwin|win32] [arm64|x64]
//          [--download-only] [--force] [--driver <name>]
//          [--config <drivers.json>] [--out <dir>] [--cache <dir>]
//
// Nothing is downloaded at run time by the app; this script runs only when a
// package is built. Every byte that ends up in build/computer-use is checked
// against a SHA-256 written in drivers.json.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "..", "..");
const MANIFEST = "manifest.json";
const KEEP = new Set([".gitkeep"]);

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    platform: process.platform,
    arch: process.arch,
    downloadOnly: false,
    force: false,
    driver: undefined,
    config: path.join(here, "drivers.json"),
    out: path.join(project, "build", "computer-use"),
    cache: path.join(project, "build", "downloads", "computer-use"),
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith("--")) fail(`${arg} needs a value`);
      return next;
    };
    if (arg === "--download-only") options.downloadOnly = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--driver") options.driver = value();
    else if (arg === "--config") options.config = path.resolve(value());
    else if (arg === "--out") options.out = path.resolve(value());
    else if (arg === "--cache") options.cache = path.resolve(value());
    else if (arg.startsWith("--")) fail(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 2)
    fail(
      "Usage: node scripts/computer-use/fetch-driver.mjs [darwin|win32] [arm64|x64] [--download-only] [--force]",
    );
  if (positional[0]) options.platform = positional[0];
  if (positional[1]) options.arch = positional[1];
  return options;
}

const isHex64 = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

// Paths in drivers.json are relative, forward-slash and may not climb out.
function safeRelative(value, what) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.split("/").includes("..")
  )
    fail(`Invalid ${what} path in drivers.json: ${JSON.stringify(value)}`);
  return value;
}

function loadDriver(configPath, name) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const driverName = name ?? config.default;
  const driver = config.drivers?.[driverName];
  if (!driver) fail(`Unknown computer use driver: ${driverName}`);
  const { tarball } = driver;
  if (!tarball?.url || !isHex64(tarball.sha256))
    fail(`Driver ${driverName} has no pinned tarball SHA-256`);
  const url = new URL(tarball.url);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    fail(`Driver ${driverName} must be downloaded over HTTPS`);
  if (!isHex64(driver.licenseFile?.sha256))
    fail(`Driver ${driverName} has no pinned license file`);
  safeRelative(driver.licenseFile.path, "license");
  for (const [layoutName, layout] of Object.entries(driver.layouts ?? {})) {
    safeRelative(layout.source, "source");
    if (layout.install !== ".") safeRelative(layout.install, "install");
    safeRelative(layout.executable, "executable");
    if (!layout.files?.[layout.executable])
      fail(`Layout ${layoutName} does not pin its executable`);
    for (const [file, hash] of Object.entries(layout.files)) {
      safeRelative(file, "file");
      if (!isHex64(hash)) fail(`Layout ${layoutName} has a bad hash: ${file}`);
    }
    for (const [file, entry] of Object.entries(layout.exclude ?? {})) {
      safeRelative(file, "excluded file");
      if (!isHex64(entry?.sha256))
        fail(`Layout ${layoutName} has a bad hash: ${file}`);
    }
    if (!["none", "adhoc"].includes(layout.resign))
      fail(`Layout ${layoutName} has an unknown resign mode`);
  }
  return { name: driverName, driver };
}

function sha256File(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function sriFile(file, algorithm) {
  return crypto
    .createHash(algorithm)
    .update(fs.readFileSync(file))
    .digest("base64");
}

// npm "integrity" is Subresource Integrity: "<algorithm>-<base64 digest>".
function checkIntegrity(file, integrity) {
  if (!integrity) return;
  const [algorithm, expected] = [
    integrity.slice(0, integrity.indexOf("-")),
    integrity.slice(integrity.indexOf("-") + 1),
  ];
  if (!["sha512", "sha384", "sha256"].includes(algorithm))
    fail(`Unsupported integrity algorithm: ${algorithm}`);
  if (sriFile(file, algorithm) !== expected)
    fail(`Integrity check failed for ${path.basename(file)}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Downloads with retries. A partial file is resumed with an HTTP range request
// when the server supports it; otherwise it starts over.
async function download(url, destination, expectedSize) {
  const partial = `${destination}.part`;
  const attempts = Number(process.env.CLAUDEX_CU_DOWNLOAD_ATTEMPTS) || 6;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const have = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
      if (expectedSize && have === expectedSize) break;
      if (expectedSize && have > expectedSize) fs.rmSync(partial);
      const offset = fs.existsSync(partial) ? have : 0;
      const controller = new AbortController();
      let idle = setTimeout(() => controller.abort(), 60_000);
      const response = await fetch(url, {
        headers: offset ? { range: `bytes=${offset}-` } : {},
        signal: controller.signal,
        redirect: "follow",
      });
      if (response.status !== 200 && response.status !== 206)
        fail(`HTTP ${response.status}`);
      const append = offset > 0 && response.status === 206;
      const stream = fs.createWriteStream(partial, {
        flags: append ? "a" : "w",
      });
      try {
        for await (const chunk of response.body) {
          clearTimeout(idle);
          idle = setTimeout(() => controller.abort(), 60_000);
          if (!stream.write(chunk))
            await new Promise((resolve) => stream.once("drain", resolve));
        }
      } finally {
        clearTimeout(idle);
        await new Promise((resolve) => stream.end(resolve));
      }
      if (!expectedSize || fs.statSync(partial).size === expectedSize) break;
      fail(`incomplete download (${fs.statSync(partial).size} bytes)`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 15_000);
      console.warn(
        `Download attempt ${attempt} failed (${error?.message ?? error}); retrying in ${delay} ms`,
      );
      await sleep(delay);
    }
  }
  if (
    !fs.existsSync(partial) ||
    (expectedSize && fs.statSync(partial).size !== expectedSize)
  )
    fail(`Could not download ${url}: ${lastError?.message ?? "unknown error"}`);
  fs.renameSync(partial, destination);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    fail(
      `${command} ${args[0] ?? ""} failed: ${result.error?.message || result.stderr || result.status}`,
    );
  return result.stdout;
}

function listFiles(root) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink())
        fail(`Unexpected symbolic link in driver package: ${relative}`);
      if (entry.isDirectory()) walk(full, relative);
      else files.push(relative);
    }
  };
  walk(root, "");
  return files.sort();
}

// Checks the extracted layout: every pinned and excluded file must exist with
// its pinned hash, and nothing else may be present.
function verifyLayout(sourceRoot, layout) {
  if (!fs.existsSync(sourceRoot))
    fail(`Driver package is missing ${layout.source}`);
  const expected = new Set([
    ...Object.keys(layout.files),
    ...Object.keys(layout.exclude ?? {}),
  ]);
  const present = listFiles(sourceRoot);
  for (const file of present)
    if (!expected.has(file))
      fail(`Driver package has an unexpected file: ${layout.source}/${file}`);
  for (const file of expected)
    if (!present.includes(file))
      fail(`Driver package is missing ${layout.source}/${file}`);
  for (const [file, hash] of Object.entries(layout.files))
    if (sha256File(path.join(sourceRoot, file)) !== hash)
      fail(`SHA-256 mismatch for ${layout.source}/${file}`);
  for (const [file, entry] of Object.entries(layout.exclude ?? {}))
    if (sha256File(path.join(sourceRoot, file)) !== entry.sha256)
      fail(`SHA-256 mismatch for ${layout.source}/${file}`);
}

// The output directory is emptied before an install. To avoid wiping an
// unrelated directory passed with --out, only the default directory, an empty
// one, or one that holds a previous install (manifest.json) is cleared.
function clearOutput(out, defaultOut) {
  fs.mkdirSync(out, { recursive: true });
  const entries = fs.readdirSync(out).filter((entry) => !KEEP.has(entry));
  if (
    entries.length &&
    path.resolve(out) !== path.resolve(defaultOut) &&
    !readManifest(out)?.driver
  )
    fail(
      `Refusing to clear ${out}: it is not empty and holds no computer use driver install`,
    );
  for (const entry of fs.readdirSync(out))
    if (!KEEP.has(entry))
      fs.rmSync(path.join(out, entry), { recursive: true, force: true });
}

function readManifest(out) {
  try {
    return JSON.parse(fs.readFileSync(path.join(out, MANIFEST), "utf8"));
  } catch {
    return null;
  }
}

// Hashes of every installed file except the manifest itself.
function hashInstalled(out) {
  const hashes = {};
  for (const file of listFiles(out))
    if (file !== MANIFEST && !KEEP.has(file))
      hashes[file] = sha256File(path.join(out, file));
  return hashes;
}

// An installed driver is reused only when it matches the pin and target and
// every installed file still has the hash recorded at install time, with no
// file missing or added.
function installedMatches(out, expected) {
  const manifest = readManifest(out);
  if (!manifest || typeof manifest.installedFiles !== "object") return false;
  for (const key of ["driver", "version", "platform", "arch", "tarballSha256"])
    if (manifest[key] !== expected[key]) return false;
  try {
    const actual = hashInstalled(out);
    const recorded = manifest.installedFiles;
    const names = new Set([...Object.keys(actual), ...Object.keys(recorded)]);
    for (const name of names) if (actual[name] !== recorded[name]) return false;
    return (
      actual[manifest.executable] !== undefined &&
      actual[manifest.executable] === manifest.executableSha256
    );
  } catch {
    return false;
  }
}

export async function prepareComputerUseDriver(argv) {
  const options = parseArgs(argv);
  const { name, driver } = loadDriver(options.config, options.driver);
  const target = `${options.platform}-${options.arch}`;
  const layoutName = driver.targets?.[target];
  const layout = layoutName && driver.layouts?.[layoutName];
  if (!layout) fail(`${name} ${driver.version} has no build for ${target}`);

  fs.mkdirSync(options.cache, { recursive: true });
  const archive = path.join(options.cache, `${name}-${driver.version}.tgz`);
  if (fs.existsSync(archive) && sha256File(archive) !== driver.tarball.sha256)
    fs.rmSync(archive);
  if (!fs.existsSync(archive)) {
    console.log(`Downloading ${name} ${driver.version}`);
    await download(driver.tarball.url, archive, driver.tarball.size);
  }
  if (sha256File(archive) !== driver.tarball.sha256) {
    fs.rmSync(archive, { force: true });
    fail(
      `SHA-256 mismatch for ${name} ${driver.version}; the download was removed`,
    );
  }
  checkIntegrity(archive, driver.tarball.integrity);

  const staging = fs.mkdtempSync(path.join(options.cache, "extract-"));
  try {
    run("tar", ["-xzf", archive, "-C", staging]);
    const licensePath = path.join(staging, driver.licenseFile.path);
    if (
      !fs.existsSync(licensePath) ||
      sha256File(licensePath) !== driver.licenseFile.sha256
    )
      fail(`License file of ${name} does not match the pin`);
    const sourceRoot = path.join(staging, layout.source);
    verifyLayout(sourceRoot, layout);

    if (options.downloadOnly) {
      console.log(`Verified ${name} ${driver.version} for ${target}.`);
      console.log("Download-only: build/computer-use was not modified.");
      return { status: "verified" };
    }

    const manifestBase = {
      driver: name,
      version: driver.version,
      platform: options.platform,
      arch: options.arch,
      tarballSha256: driver.tarball.sha256,
    };
    if (!options.force && installedMatches(options.out, manifestBase)) {
      console.log(
        `${name} ${driver.version} for ${target} is already installed.`,
      );
      return { status: "unchanged" };
    }
    if (layout.resign === "adhoc" && process.platform !== "darwin")
      fail(
        `The macOS driver has to be prepared on macOS (it is re-signed with codesign).`,
      );

    clearOutput(options.out, path.join(project, "build", "computer-use"));
    const installRoot =
      layout.install === "."
        ? options.out
        : path.join(options.out, layout.install);
    fs.mkdirSync(installRoot, { recursive: true });
    for (const file of Object.keys(layout.files)) {
      const destination = path.join(installRoot, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(sourceRoot, file), destination);
    }
    const executable = path.join(installRoot, layout.executable);
    fs.chmodSync(executable, 0o755);

    let signature = "upstream";
    if (layout.resign === "adhoc") {
      // Removing a sealed resource invalidates the upstream signature, so the
      // bundle is signed again ad hoc (hardened runtime kept). A Developer ID
      // build signs it again with the Claudex identity when the app is signed.
      run("codesign", [
        "--force",
        "--sign",
        "-",
        "--options",
        "runtime",
        "--timestamp=none",
        installRoot,
      ]);
      run("codesign", ["--verify", "--strict", "--verbose=2", installRoot]);
      signature = "adhoc";
    }

    fs.copyFileSync(licensePath, path.join(options.out, "LICENSE"));
    const noticesSource = path.resolve(
      path.dirname(options.config),
      driver.notices ?? "",
    );
    if (driver.notices && fs.existsSync(noticesSource))
      fs.copyFileSync(noticesSource, path.join(options.out, "NOTICES.md"));
    else if (driver.notices) fail(`Missing notices file: ${driver.notices}`);

    const executableRelative = path.posix.join(
      layout.install === "." ? "" : layout.install,
      layout.executable,
    );
    const manifest = {
      ...manifestBase,
      license: driver.license,
      homepage: driver.homepage,
      commit: driver.commit,
      executable: executableRelative,
      executableSha256: sha256File(executable),
      upstreamExecutableSha256: layout.files[layout.executable],
      signature,
      removed: Object.keys(layout.exclude ?? {}).map((file) =>
        path.posix.join(layout.install === "." ? "" : layout.install, file),
      ),
      args: driver.args ?? [],
      env: driver.env ?? {},
      tools: driver.tools ?? [],
      installedFiles: hashInstalled(options.out),
    };
    fs.writeFileSync(
      path.join(options.out, MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    console.log(
      `Installed ${name} ${driver.version} for ${target} into ${path.relative(project, options.out) || options.out}`,
    );
    return { status: "installed", manifest };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly)
  prepareComputerUseDriver(process.argv.slice(2)).catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
