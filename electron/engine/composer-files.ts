import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Attachment } from "../../shared/types";
import type { MentionFile } from "../../shared/composer-api";
import { countLines } from "../../shared/attachment-detail";
import { attachmentKind, type ClientPolicy } from "../../shared/client-policy";
import { attachmentRefusal } from "../../shared/client-policy-rules";

/**
 * Files behind the composer: pasted or dropped attachments kept in the
 * account's folder, image thumbnails, and the `@` file list.
 */

/** Folders `@` never walks into: dependencies, build output, VCS data. */
const skippedFolders = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "out",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "DerivedData",
  "Pods",
]);
const maxEntries = 20_000;
const maxDepth = 12;
const maxResults = 50;

/**
 * Whether a typed `@` query can only name a path inside the folder: no
 * absolute paths, no drive letters, no `..` segments.
 */
export function mentionQueryAllowed(query: string) {
  if (query.length > 300) return false;
  if (/^[\\/]/.test(query) || /^[a-z]:/i.test(query) || query.startsWith("~"))
    return false;
  return !query.split(/[\\/]+/).includes("..");
}

/**
 * Every file and folder under `root`, relative. Symbolic links are listed
 * only when they resolve inside `root`, and never followed into folders.
 */
export function listFolder(root: string): MentionFile[] {
  const real = fs.realpathSync(root);
  const inside = (target: string) =>
    target === real || target.startsWith(real + path.sep);
  const found: MentionFile[] = [];
  const queue: [string, number][] = [["", 0]];
  while (queue.length && found.length < maxEntries) {
    const [relative, depth] = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      // A folder swapped for a link after it was listed (the agent writes
      // this folder while it is read) is not walked into.
      const folder = path.join(real, relative);
      if (relative && !inside(fs.realpathSync(folder))) continue;
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= maxEntries) break;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        try {
          const target = fs.realpathSync(path.join(real, child));
          if (!inside(target)) continue;
          found.push({
            path: child,
            kind: fs.statSync(target).isDirectory() ? "folder" : "file",
          });
        } catch {}
        continue;
      }
      if (entry.isDirectory()) {
        if (skippedFolders.has(entry.name)) continue;
        found.push({ path: child, kind: "folder" });
        if (depth + 1 < maxDepth) queue.push([child, depth + 1]);
      } else if (entry.isFile()) found.push({ path: child, kind: "file" });
    }
  }
  return found;
}

/**
 * Ranks paths for a query: a name that starts with it, then a name that
 * contains it, then a path that contains it, then the query's characters
 * in order; shorter paths first within a rank.
 */
export function rankMentions(files: MentionFile[], query: string) {
  const search = query.toLowerCase().replace(/\\/g, "/");
  const rank = (file: MentionFile) => {
    if (!search) return file.path.includes("/") ? 1 : 0;
    const lower = file.path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    if (name.startsWith(search)) return 0;
    if (name.includes(search)) return 1;
    if (lower.includes(search)) return 2;
    let index = 0;
    for (const character of lower) if (character === search[index]) index++;
    return index === search.length ? 3 : Infinity;
  };
  return files
    .map((file) => ({ file, score: rank(file) }))
    .filter((value) => Number.isFinite(value.score))
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.file.path.length - b.file.path.length ||
        a.file.path.localeCompare(b.file.path),
    )
    .slice(0, maxResults)
    .map((value) => value.file);
}

const listings = new Map<string, { at: number; files: MentionFile[] }>();
/** Drops expired listings (up to 20,000 paths each) instead of keeping one per root. */
function dropExpired(now: number) {
  for (const [key, value] of listings)
    if (now - value.at > 5_000) listings.delete(key);
}
/** The folder's listing, reused for a few seconds while the person types. */
export function mentionFiles(root: string, query: string, now = Date.now()) {
  if (!mentionQueryAllowed(query)) return [];
  let cached = listings.get(root);
  if (!cached || now - cached.at > 5_000) {
    dropExpired(now);
    cached = { at: now, files: listFolder(root) };
    listings.set(root, cached);
  }
  return rankMentions(cached.files, query);
}

/**
 * `mentionFiles` for a folder on an SSH host (R9): `list` reads the host's
 * listing (RemoteWorkspace.listFolder), kept for a few seconds under `key`
 * (host and folder) like a local one, and ranked the same way.
 */
export async function mentionFilesWith(
  key: string,
  query: string,
  list: () => Promise<MentionFile[]>,
  now = Date.now(),
) {
  if (!mentionQueryAllowed(query)) return [];
  let cached = listings.get(key);
  if (!cached || now - cached.at > 5_000) {
    const files = await list();
    dropExpired(now);
    cached = { at: now, files };
    listings.set(key, cached);
  }
  return rankMentions(cached.files, query);
}

/** The folder names `@` never walks into (for the host's `find`, R9). */
export const mentionSkippedFolders: readonly string[] = [...skippedFolders];
/** At most this many paths and this many levels, on a host as here. */
export const mentionLimits = { entries: maxEntries, depth: maxDepth };

/**
 * Reads a host's listing: NUL-terminated records, "d" or "f" then a path
 * that starts with "./" (the `find` in RemoteWorkspace.listFolder). A path
 * with a `..` segment or a record cut off at the output limit is dropped.
 */
export function parseFolderListing(output: string): MentionFile[] {
  const records = output.split("\0");
  // The last record has no terminator: empty, or cut off by the size limit.
  records.pop();
  const found: MentionFile[] = [];
  for (const record of records) {
    if (found.length >= maxEntries) break;
    const kind =
      record[0] === "d" ? "folder" : record[0] === "f" ? "file" : undefined;
    if (!kind || !record.startsWith("./", 1)) continue;
    const relative = record.slice(3);
    if (!relative || relative.split("/").some((part) => !part || part === ".."))
      continue;
    found.push({ path: relative, kind });
  }
  return found;
}

/** A file name safe to keep on disk, with the type's extension. */
export function attachmentFileName(name: string) {
  const base = path
    .basename(name.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .trim()
    .slice(0, 120);
  return base && base !== "." && base !== ".." ? base : "Attachment";
}

/**
 * Keeps pasted or dropped bytes as an attachment under `folder`, refused by
 * the same type and size rules as the file picker.
 */
export function storeAttachment(
  folder: string,
  name: string,
  data: Uint8Array,
  policy: ClientPolicy,
  pasted = false,
): Attachment {
  if (!policy.attachments.types.length)
    throw new Error("Your administrator has turned off attachments.");
  const fileName = attachmentFileName(name);
  const refusal = attachmentRefusal(fileName, data.byteLength, policy);
  if (refusal) throw new Error(refusal);
  const id = randomUUID();
  const directory = path.join(folder, id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, fileName);
  fs.writeFileSync(file, data, { mode: 0o600 });
  const kind = attachmentKind(path.extname(fileName).slice(1));
  return {
    id,
    name: fileName,
    path: file,
    size: data.byteLength,
    kind,
    ...(kind === "text" ? { lines: countLines(data) } : {}),
    ...(pasted ? { pasted: true } : {}),
  };
}

const imageTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
/** The thumbnail's data URL; images up to 12 MB, nothing else. */
export function imagePreview(attachment: Attachment) {
  const type = imageTypes[path.extname(attachment.path).slice(1).toLowerCase()];
  if (attachment.kind !== "image" || !type) return null;
  const size = fs.statSync(attachment.path).size;
  if (size > 12 * 1024 * 1024) return null;
  return `data:${type};base64,${fs.readFileSync(attachment.path).toString("base64")}`;
}
