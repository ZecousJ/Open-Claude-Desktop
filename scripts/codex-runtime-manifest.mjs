/**
 * Writes shared/codex-runtime-manifest.json from package-lock.json (R9-S2):
 * for every platform build of the bundled Codex engine, where npm serves
 * its package and the package's sha512. Claudex installs the same engine
 * on SSH hosts and checks every copy against these sums on this computer,
 * so a mirror or a host can change where the package comes from but never
 * what runs.
 *
 *   node scripts/codex-runtime-manifest.mjs            write the manifest
 *   node scripts/codex-runtime-manifest.mjs --check    exit 1 when it is stale
 *   --lock <file> --out <file>                         other paths (tests)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** npm's platform suffix → the Rust target the package's vendor folder uses. */
const TARGETS = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

class ManifestError extends Error {}

export function buildManifest(lock) {
  const packages = lock?.packages ?? {};
  const main = packages["node_modules/@openai/codex"];
  if (!main?.version)
    throw new ManifestError("package-lock.json has no @openai/codex.");
  const version = main.version;
  const platforms = {};
  for (const [suffix, triple] of Object.entries(TARGETS)) {
    const name = `@openai/codex-${suffix}`;
    const entry = packages[`node_modules/${name}`];
    if (!entry) throw new ManifestError(`package-lock.json has no ${name}.`);
    if (entry.version !== `${version}-${suffix}`)
      throw new ManifestError(`${name} is ${entry.version}, not ${version}.`);
    if (
      !/^https:\/\/registry\.npmjs\.org\/@openai\/codex\/-\/codex-[\w.-]+\.tgz$/.test(
        entry.resolved ?? "",
      )
    )
      throw new ManifestError(`${name} does not come from registry.npmjs.org.`);
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity ?? ""))
      throw new ManifestError(`${name} has no sha512 integrity.`);
    const [os, arch] = suffix.split("-");
    platforms[triple] = {
      os,
      arch,
      npmPackage: `@openai/codex@${entry.version}`,
      url: entry.resolved,
      integrity: entry.integrity,
    };
  }
  return { version, platforms };
}

export function serialize(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function main() {
  const args = process.argv.slice(2);
  let lockFile = path.join(project, "package-lock.json");
  let outFile = path.join(project, "shared", "codex-runtime-manifest.json");
  let check = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--check") check = true;
    else if (arg === "--lock" && args[i + 1])
      lockFile = path.resolve(args[++i]);
    else if (arg === "--out" && args[i + 1]) outFile = path.resolve(args[++i]);
    else throw new ManifestError(`unknown option ${arg}`);
  }
  const text = serialize(
    buildManifest(JSON.parse(fs.readFileSync(lockFile, "utf8"))),
  );
  if (check) {
    let current = "";
    try {
      current = fs.readFileSync(outFile, "utf8");
    } catch {
      // A missing manifest is a stale one.
    }
    if (current !== text)
      throw new ManifestError(
        `${outFile} is out of date; run node scripts/codex-runtime-manifest.mjs`,
      );
    return;
  }
  fs.writeFileSync(outFile, text);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(`codex-runtime-manifest: ${error.message}`);
    process.exit(1);
  }
}
