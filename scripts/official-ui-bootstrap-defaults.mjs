import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const archiveSha256 = "1908f011fab0000852b4504f8ce3e98e3a7575097459a15f923023fa237d8099";
const sourceSha256 = "5de22ca9eafbd3ad50265e0f30d6964ac5cde111215749bf5cc389839963b8d0";
export const bootstrapOutputSha256 = "e75a70118f968641ce61094d4be6763bf4ff58de55bbddb9476b38704cc4ba61";
const sourceEntry = "claude-frontend-4.4212.0/recovery/claudex-bootstrap-defaults.json";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function ordinaryFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Bootstrap source must be a regular file.");
}

/** The only accepted bootstrap is the sanitized file in the pinned handoff. */
export function verifiedBootstrapDefaults(source, archive) {
  ordinaryFile(archive);
  if (sha(fs.readFileSync(archive)) !== archiveSha256) throw Error("Pinned official source archive checksum mismatch.");
  const rows = JSON.parse(execFileSync("tar", ["-xOf", archive, "./source-files.json"], { maxBuffer: 8 * 1024 * 1024 }).toString("utf8"));
  const matching = rows.filter((row) => row.path === sourceEntry);
  if (matching.length !== 1 || matching[0].sha256 !== sourceSha256 || matching[0].bytes !== 1639477)
    throw Error("Pinned bootstrap manifest mismatch.");
  const root = fs.realpathSync(source);
  const recovery = path.join(root, "recovery");
  const directory = fs.lstatSync(recovery);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error("Bootstrap recovery directory must not be a symlink.");
  const file = path.join(recovery, "claudex-bootstrap-defaults.json");
  ordinaryFile(file);
  if (!fs.realpathSync(file).startsWith(root + path.sep)) throw Error("Bootstrap source escapes its project.");
  const bytes = fs.readFileSync(file);
  if (bytes.length !== matching[0].bytes || sha(bytes) !== sourceSha256) throw Error("Pinned bootstrap source checksum mismatch.");
  const output = Buffer.from(JSON.stringify(JSON.parse(bytes.toString("utf8"))) + "\n");
  if (sha(output) !== bootstrapOutputSha256) throw Error("Pinned bootstrap output checksum mismatch.");
  return output;
}

export function verifyPackagedBootstrap(root) {
  const directory = path.join(root, "data");
  const rootStat = fs.lstatSync(root), dataStat = fs.lstatSync(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !dataStat.isDirectory() || dataStat.isSymbolicLink())
    throw Error("Packaged bootstrap directory must not be a symlink.");
  const file = path.join(directory, "bootstrap-defaults.json");
  ordinaryFile(file);
  if (sha(fs.readFileSync(file)) !== bootstrapOutputSha256) throw Error("Packaged bootstrap checksum mismatch.");
}
