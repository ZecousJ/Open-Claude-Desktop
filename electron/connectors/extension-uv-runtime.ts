import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import JSZip from "jszip";

const run = promisify(execFile);
const version = "0.9.7";
const targets: Record<string, { name: string; sha256: string }> = {
  "darwin-arm64": { name: "uv-aarch64-apple-darwin.tar.gz", sha256: "35572b9619fc14d67fc1cd72582c3cfc5c9c66d97f310192e04f26fb3fe96005" },
  "darwin-x64": { name: "uv-x86_64-apple-darwin.tar.gz", sha256: "41946d87e1576c297d6d3cca88b089b6942b8777a5a25e70de1ef8c57b94b9cf" },
  "win32-arm64": { name: "uv-aarch64-pc-windows-msvc.zip", sha256: "4482ad2544544e1966b6d933d38e27368ce0307739d293322c10459f698a1629" },
  "win32-x64": { name: "uv-x86_64-pc-windows-msvc.zip", sha256: "5d250c32d3604e28dbe18dc65c668ff628c53e00dde2c642576e831e4a60da64" },
  "linux-arm64": { name: "uv-aarch64-unknown-linux-gnu.tar.gz", sha256: "8b3d31a154673c6d357727d2083a33525b515589d153fa5b5455e1db9e9e6363" },
  "linux-x64": { name: "uv-x86_64-unknown-linux-gnu.tar.gz", sha256: "b26fcc8dfa1c39b5a5613445af3be3eefda45d9a39359bee271eafe34913583e" },
};
const pending = new Map<string, Promise<string>>();

async function usable(command: string) {
  try {
    const result = await run(command, ["--version"], { timeout: 5000, windowsHide: true });
    return /^uv\s+\d/.test(result.stdout.trim());
  } catch { return false; }
}

type Request = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

async function acquire(root: string, request: Request): Promise<string> {
  if (await usable("uv")) return "uv";
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw Error("UV is unavailable for this platform.");
  const directory = path.join(root, "uv-runtime", `uv-${version}-${process.platform}-${process.arch}`);
  const executable = path.join(directory, process.platform === "win32" ? "uv.exe" : "uv");
  if (await usable(executable)) return executable;
  const response = await request(`https://github.com/astral-sh/uv/releases/download/${version}/${target.name}`, {
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw Error("UV download failed.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 100 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== target.sha256)
    throw Error("UV download could not be verified.");
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "claudex-uv-"));
  try {
    let binary: Buffer;
    if (process.platform === "win32") {
      const zip = await JSZip.loadAsync(bytes);
      const entries = Object.values(zip.files).filter(item => !item.dir && /(?:^|\/)uv\.exe$/i.test(item.name));
      if (entries.length !== 1) throw Error("UV archive is invalid.");
      binary = await entries[0].async("nodebuffer");
    } else {
      const archive = path.join(temporary, "uv.tar.gz");
      fs.writeFileSync(archive, bytes);
      const listing = await run("tar", ["-tzf", archive], { maxBuffer: 1024 * 1024 });
      const entries = listing.stdout.split(/\r?\n/).filter(name => /^[^/]+\/uv$/.test(name));
      if (entries.length !== 1) throw Error("UV archive is invalid.");
      const extracted = await run("tar", ["-xOzf", archive, "--", entries[0]], { encoding: "buffer", maxBuffer: 100 * 1024 * 1024 });
      binary = extracted.stdout;
    }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const staged = path.join(directory, `.uv-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(staged, binary, { mode: 0o700, flag: "wx" });
      fs.renameSync(staged, executable);
    } finally { fs.rmSync(staged, { force: true }); }
    if (!(await usable(executable))) throw Error("UV could not be started.");
    return executable;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export function ensureExtensionUv(root: string, request: Request = fetch): Promise<string> {
  const existing = pending.get(root);
  if (existing) return existing;
  const current = acquire(root, request).finally(() => { if (pending.get(root) === current) pending.delete(root); });
  pending.set(root, current);
  return current;
}
