/**
 * Windows app packs: a release's resources/ folder less Codex, applied over an
 * install on the same Electron whose Codex files are the ones the pack was
 * built next to. `keepDigest` is how both sides name those files: the SHA-256
 * of each one's path (relative, forward slashes, sorted) and its own SHA-256,
 * one per line. No Electron imports: the release script uses it too.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The folder under resources/ an app pack leaves in place. */
export const appPackKeptFolder = "codex";

function files(root: string, dir = ""): string[] {
  return fs
    .readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return files(root, relative);
      return entry.isFile() ? [relative] : [];
    });
}

async function sha256(file: string) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** The kept folder's digest, or undefined when it can't be read. */
export async function keepDigest(resources: string) {
  const root = path.join(resources, appPackKeptFolder);
  try {
    const lines: string[] = [];
    for (const file of files(root).sort())
      lines.push(`${file}\n${await sha256(path.join(root, file))}\n`);
    if (!lines.length) return undefined;
    return crypto.createHash("sha256").update(lines.join("")).digest("hex");
  } catch {
    return undefined;
  }
}
