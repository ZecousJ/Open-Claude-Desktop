/**
 * The Files pane's reads (live claude.ai bundle, 2026-10-15: the Code
 * "Files" pane): one folder's entries at a time and one file's text, both
 * strictly inside the session's folder. A path that leaves it (`..`, an
 * absolute path, a link pointing outside) is refused.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createContext, Script } from "node:vm";
import { mentionSkippedFolders } from "../engine/composer-files";
import type { ProjectWriteResult } from "../../shared/project-files";
import { projectSearchMaxResults } from "../../shared/project-files";
import type {
  ProjectEntry,
  ProjectFile,
  ProjectSearchOptions,
  ProjectSearchResult,
} from "../../shared/project-files";

/** The most entries one folder lists, and the biggest file shown. */
export const projectFolderLimit = 2000;
export const projectFileLimit = 2 * 1024 * 1024;
const revisionOf = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
const skippedSearchFolders = new Set(mentionSkippedFolders);
const isGitMetadata = (root: string, file: string) =>
  path.relative(fs.realpathSync(root), file).split(path.sep).includes(".git");
const hookKeys = [
  "lint-staged",
  "husky",
  "commitlint",
  "pre-commit",
  "precommit",
  "gitHooks",
  "nano-staged",
];
function packageObject(content: string) {
  try {
    const value = JSON.parse(content.replace(/^\uFEFF/, ""));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
/** Same guarded package keys as native reference LocalSessions.writeSessionFile. */
export function changesHookConfiguration(before: string, after: string) {
  const next = packageObject(after);
  if (!next) return false;
  const previous = packageObject(before) ?? {};
  return hookKeys.some(
    (key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]),
  );
}

/** The real path of `relative` under `root`, or an error when it leaves it. */
export function resolveInside(root: string, relative: string) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))
    throw new Error("That path is outside the session's folder.");
  const realRoot = fs.realpathSync(root);
  const target = fs.realpathSync(path.join(realRoot, relative));
  if (!containedBy(realRoot, target))
    throw new Error("That path is outside the session's folder.");
  return target;
}

function containedBy(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** A folder's entries, folders first, then by name (as Finder sorts). */
export function listProjectFolder(
  root: string,
  relative: string,
): { entries: ProjectEntry[]; truncated: boolean } {
  const folder = resolveInside(root, relative);
  const dirents = fs.readdirSync(folder, { withFileTypes: true });
  const entries: ProjectEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name === ".git" || dirent.name === ".DS_Store") continue;
    let kind: ProjectEntry["kind"] = dirent.isDirectory() ? "folder" : "file";
    if (dirent.isSymbolicLink()) {
      try {
        kind = fs.statSync(resolveInside(root, path.join(relative, dirent.name))).isDirectory()
          ? "folder"
          : "file";
      } catch {
        kind = "file";
      }
    }
    entries.push({
      name: dirent.name,
      path: relative ? `${relative}/${dirent.name}` : dirent.name,
      kind,
      ...(dirent.isSymbolicLink() ? { symlink: true } : {}),
    });
  }
  entries.sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1) ||
      a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
  );
  return {
    entries: entries.slice(0, projectFolderLimit),
    truncated: entries.length > projectFolderLimit,
  };
}

/** A file's text for the viewer; binary or too large files say so instead. */
export function readProjectFile(root: string, relative: string): ProjectFile {
  const file = resolveInside(root, relative);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("That isn't a file.");
  if (stat.size > projectFileLimit)
    return {
      path: relative,
      bytes: stat.size,
      tooLarge: true,
      limitBytes: projectFileLimit,
    };
  const data = fs.readFileSync(file);
  const sample = data.subarray(0, 8000);
  const revision = revisionOf(data);
  if (sample.includes(0))
    return {
      path: relative,
      bytes: stat.size,
      binary: true,
      revision,
      writable: false,
    };
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      data,
    );
  } catch {
    return {
      path: relative,
      bytes: stat.size,
      content: data.toString("utf8"),
      revision,
      writable: false,
      invalidEncoding: true,
    };
  }
  let writable = (stat.mode & 0o222) !== 0 && !isGitMetadata(root, file);
  try {
    fs.accessSync(file, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  return { path: relative, bytes: stat.size, content, revision, writable };
}

/** Conditional, atomic text save. An outside path, external link or stale read
 * cannot overwrite a different file. The original stays intact on write failure. */
export function writeProjectFile(
  root: string,
  relative: string,
  content: string,
  expectedRevision: string,
): ProjectWriteResult {
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content, "utf8") > projectFileLimit
  )
    throw Error("The file is too large to save.");
  if (!/^[a-f0-9]{64}$/.test(expectedRevision))
    throw Error("Read the file before saving changes.");
  let file: string;
  try {
    file = resolveInside(root, relative);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "missing" };
    throw error;
  }
  if (isGitMetadata(root, file))
    return { status: "denied", reason: "git-metadata" };
  const current = readProjectFile(root, relative);
  if (current.revision !== expectedRevision)
    return current.revision
      ? { status: "conflict", currentRevision: current.revision }
      : { status: "denied", reason: "read-only" };
  if (current.invalidEncoding)
    return { status: "denied", reason: "unsupported-encoding" };
  if (!current.writable || current.binary || current.tooLarge)
    return { status: "denied", reason: "read-only" };
  if (
    path.basename(file).toLowerCase() === "package.json" &&
    changesHookConfiguration(current.content ?? "", content)
  )
    return { status: "denied", reason: "hook-config" };
  const stat = fs.statSync(file),
    temporary = path.join(
      path.dirname(file),
      `.claudex-save-${randomUUID()}.tmp`,
    );
  try {
    const fd = fs.openSync(temporary, "wx", stat.mode & 0o777);
    try {
      fs.writeFileSync(fd, content, "utf8");
      fs.fchmodSync(fd, stat.mode & 0o777);
      const created = fs.fstatSync(fd);
      if (created.uid !== stat.uid || created.gid !== stat.gid)
        fs.fchownSync(fd, stat.uid, stat.gid);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Re-check the target immediately before replacement, including link hops.
    if (resolveInside(root, relative) !== file)
      throw Error("The file moved while saving. Reopen it and try again.");
    const latest = revisionOf(fs.readFileSync(file));
    if (latest !== expectedRevision)
      return { status: "conflict", currentRevision: latest };
    fs.renameSync(temporary, file);
    return { status: "saved", file: readProjectFile(root, relative) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "missing" };
    throw error;
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* Renamed or never created. */
    }
  }
}

// Match the complete line within the file limit, and collect only highlights
// in the displayed excerpt. The timeout bounds slow expressions.
const scanProjectRegexp = new Script(`(() => {
  const matches = [];
  for (let line = 0; line < lines.length && matches.length < limit; line++) {
    const text = lines[line];
    const hits = text.matchAll(pattern);
    const first = hits.next().value;
    if (!first) continue;
    const start = Math.max(0, first.index - 200);
    const end = Math.min(text.length, start + 1000);
    const ranges = [];
    for (let hit = first; hit && hit.index < end; hit = hits.next().value) {
      const finish = hit.index + hit[0].length;
      if (finish > hit.index)
        ranges.push({ start: hit.index - start, end: Math.min(end, finish) - start });
      if (finish >= end) break;
    }
    matches.push({
      line: line + 1, column: first.index + 1,
      preview: text.slice(start, end), previewMatches: ranges,
    });
  }
  return matches;
})()`);

/** Content search. Ordinary callers keep the 200-line and five-per-file limits. */
export async function searchProjectFiles(
  root: string,
  query: string,
  options: ProjectSearchOptions = {},
): Promise<ProjectSearchResult> {
  const result: ProjectSearchResult = { matches: [], truncated: false };
  const limit = options.maxResults ?? 200;
  // The renderer shows five rows per file and uses the sixth to show "more".
  const perFile = options.filesPane ? 6 : options.strict ? Infinity : 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > projectSearchMaxResults)
    throw Error("Invalid content search result limit.");
  const needle = options.regexp ? query : query.trim();
  if (!needle) return result;
  const insensitive = options.matchCase !== true;
  const normalized = insensitive ? needle.toLowerCase() : needle;
  const realRoot = await fs.promises.realpath(root);
  let pattern: RegExp | undefined;
  if (options.regexp || options.wholeWord) {
    const word = "[\\p{L}\\p{N}_]";
    const literal = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const term = options.regexp ? needle : literal;
    const before = options.wholeWord && (options.regexp || new RegExp(`^${word}`, "u").test(needle))
      ? `(?<!${word}\\p{M}*)` : "";
    const after = options.wholeWord && (options.regexp || new RegExp(`${word}\\p{M}*$`, "u").test(needle))
      ? `(?!${word}|\\p{M})` : "";
    try {
      pattern = new RegExp(`${before}(?:${term})${after}`, insensitive ? "giu" : "gu");
    } catch {
      return { ...result, patternRefused: true };
    }
  }
  const regexpContext = options.regexp
    ? createContext({ lines: [] as string[], pattern, limit: 0 })
    : undefined;
  const strictPath = (relative: string) => {
    const resolved = resolveInside(realRoot, relative);
    if (!containedBy(realRoot, resolved))
      throw Error("The project root changed during search.");
    return resolved;
  };
  const folders = [""];
  let visited = 0;
  while (folders.length) {
    const folder = folders.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(options.strict ? strictPath(folder) : path.join(realRoot, folder), {
        withFileTypes: true,
      });
    } catch (error) {
      if (options.strict) throw Error("A project folder could not be searched.", { cause: error });
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && options.filesPane && skippedSearchFolders.has(entry.name))
        continue;
      if (++visited > 20000) return { ...result, truncated: true };
      const relative = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        folders.push(relative);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const file = options.strict ? strictPath(relative) : resolveInside(realRoot, relative);
        const stat = await fs.promises.stat(file);
        if (stat.size > projectFileLimit) continue;
        let data: Buffer;
        if (options.strict) {
          const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try {
            const before = await handle.stat();
            if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino)
              throw Error("Project file changed during search.");
            if (before.size > projectFileLimit) continue;
            const buffer = Buffer.alloc(projectFileLimit + 1);
            let size = 0;
            while (size < buffer.length) {
              const next = await handle.read(buffer, size, buffer.length - size, size);
              if (!next.bytesRead) break;
              size += next.bytesRead;
            }
            const after = await handle.stat();
            if (size > projectFileLimit || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
              before.ctimeMs !== after.ctimeMs || strictPath(relative) !== file)
              throw Error("Project file changed during search.");
            const named = await fs.promises.lstat(file);
            if (named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino)
              throw Error("Project file changed during search.");
            data = buffer.subarray(0, size);
          } finally { await handle.close(); }
        } else data = await fs.promises.readFile(file);
        if (data.subarray(0, 8000).includes(0)) continue;
        const lines = data.toString("utf8").split(/\r?\n/);
        if (regexpContext) {
          let matches: Omit<ProjectSearchResult["matches"][number], "path">[];
          regexpContext.lines = lines;
          regexpContext.limit = Math.min(perFile, limit - result.matches.length + 1);
          try {
            matches = structuredClone(
              scanProjectRegexp.runInContext(regexpContext, { timeout: 250 }),
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ERR_SCRIPT_EXECUTION_TIMEOUT")
              return { matches: [], truncated: false, patternRefused: true };
            throw error;
          }
          for (const match of matches) {
            if (result.matches.length === limit) return { ...result, truncated: true };
            result.matches.push({ path: relative, ...match });
          }
          continue;
        }
        let count = 0;
        for (const [index, preview] of lines.entries()) {
          if (pattern) pattern.lastIndex = 0;
          const hit = pattern
            ? (pattern.exec(preview)?.index ?? -1)
            : (insensitive ? preview.toLowerCase() : preview).indexOf(normalized);
          if (hit === -1) continue;
          if (result.matches.length === limit)
            return { ...result, truncated: true };
          const start = Math.max(0, hit - 200);
          result.matches.push({
            path: relative,
            line: index + 1,
            ...(options.strict ? { column: hit + 1 } : {}),
            preview: preview.slice(start, start + 1000),
          });
          if (++count === perFile) break;
        }
      } catch (error) {
        if (options.strict) throw Error("A project file could not be searched.", { cause: error });
        continue;
      }
    }
  }
  return result;
}
