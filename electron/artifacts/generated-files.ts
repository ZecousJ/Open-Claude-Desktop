import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { GeneratedFile, Item } from "../../shared/types";
import { GeneratedBlobs, maxBlobBytes } from "./generated-blobs";

const languages: Record<string, string> = {
  ".html": "html",
  ".htm": "html",
  ".svg": "svg",
  ".md": "markdown",
  ".markdown": "markdown",
  ".mmd": "mermaid",
  ".mermaid": "mermaid",
  ".txt": "text",
  ".json": "json",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".css": "css",
  ".py": "python",
  ".sh": "bash",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".csv": "text",
  ".tsv": "text",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".sql": "sql",
};
/** Binary outputs kept as profile snapshots; the renderer decides which it can preview. */
const binaryTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
  ".zip": "application/zip",
};
const maxFileBytes = 2 * 1024 * 1024;
/**
 * What one file change may keep. Text is stored inside the conversation,
 * so it has its own, smaller allowance; binary snapshots share the largest
 * size one snapshot may have, so a file the snapshot store accepts is
 * never refused for being in a file change.
 */
export const itemBudgets = { text: 8 * 1024 * 1024, binary: maxBlobBytes };
/**
 * A file past the snapshot limits. `bytes` is its size where the reader
 * knows it (a remote host's refusal does not say).
 */
export class FileTooLargeError extends Error {
  constructor(readonly bytes?: number) {
    super("The generated file is too large to preview.");
  }
}

/** Records on `file` that its contents were left out for size. */
function markTooLarge(file: GeneratedFile, bytes: number | undefined) {
  file.state = "ready";
  file.tooLarge = true;
  if (bytes !== undefined) file.bytes = bytes;
  delete file.error;
}

function inside(root: string, filename: string) {
  const relative = path.relative(root, filename);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
function languageFor(name: string) {
  return languages[path.extname(name).toLowerCase()];
}

/**
 * Keeps the bytes read for `file`: a known binary type as a profile blob,
 * anything else inline as UTF-8 text (never binary). Returns their length.
 */
function keepSnapshot(
  file: GeneratedFile,
  data: Buffer,
  mime: string | undefined,
  blobs: GeneratedBlobs | undefined,
): number {
  const digest = createHash("sha256").update(data).digest("hex");
  if (mime) {
    blobs!.put(digest, data);
    file.mime = mime;
    file.blob = true;
  } else {
    const content = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(data);
    if (content.includes("\0"))
      throw new Error("Binary content cannot be previewed as text.");
    file.content = content;
  }
  file.state = "ready";
  file.digest = digest;
  file.bytes = data.length;
  return data.length;
}

/**
 * Reads one workspace file into `file` without following links out of `cwd`.
 * Text types are kept inline; with `blobs`, known binary types are copied
 * into the profile. Returns the bytes read so callers can keep a budget.
 */
export function snapshotFile(
  file: GeneratedFile,
  cwd: string,
  filename: string,
  budget: number,
  blobs?: GeneratedBlobs,
): number {
  const extension = path.extname(file.name).toLowerCase();
  const mime = blobs ? binaryTypes[extension] : undefined;
  let descriptor: number | undefined;
  try {
    if (!languages[extension] && !mime)
      throw new Error("Preview is not available for this file type.");
    const root = fs.realpathSync(cwd);
    const requested = path.resolve(cwd, filename);
    if (!inside(path.resolve(cwd), requested))
      throw new Error("This file is outside the conversation workspace.");
    const resolved = fs.realpathSync(requested);
    if (!inside(root, resolved))
      throw new Error("This file resolves outside the conversation workspace.");
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW ?? 0) |
        (fs.constants.O_NONBLOCK ?? 0),
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("Only regular files can be previewed.");
    if (stat.size > (mime ? maxBlobBytes : maxFileBytes) || stat.size > budget)
      throw new FileTooLargeError(stat.size);
    const currentPath = fs.realpathSync(requested);
    const current = fs.statSync(currentPath);
    if (
      !inside(root, currentPath) ||
      current.dev !== stat.dev ||
      current.ino !== stat.ino
    )
      throw new Error("The file changed while preparing its preview.");
    // A fixed-size read also bounds growth while the agent has the file open.
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = fs.readSync(
        descriptor,
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (!n) break;
      length += n;
    }
    if (
      length !== stat.size ||
      fs.fstatSync(descriptor).mtimeMs !== stat.mtimeMs
    )
      throw new Error("The file changed while preparing its preview.");
    return keepSnapshot(file, bytes.subarray(0, length), mime, blobs);
  } catch (error) {
    if (error instanceof FileTooLargeError) markTooLarge(file, error.bytes);
    else
      file.error =
        error instanceof Error
          ? error.message
          : "The generated file could not be read.";
    return 0;
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

/**
 * A file the person picked with the system file dialog (File ▸ Open File…),
 * read like a generated one: text inline, known binary types as a profile
 * snapshot, anything else carries an `error` the viewer reports.
 */
export function snapshotChosenFile(
  filename: string,
  blobs?: GeneratedBlobs,
): GeneratedFile {
  const name = path.basename(filename);
  const file: GeneratedFile = {
    capturedAt: Date.now(),
    id: createHash("sha256").update(filename).digest("hex").slice(0, 16),
    name,
    path: filename,
    language: languageFor(name) ?? "text",
    operation: "update",
    state: "unavailable",
  };
  const allowance = allowanceOf(name, blobs);
  snapshotFile(
    file,
    path.dirname(filename),
    name,
    itemBudgets[allowance],
    blobs,
  );
  return file;
}

/** One file of a file change, as the card lists it, before it is read. */
interface PlannedFile {
  file: GeneratedFile;
  /** The path as the change named it (relative to the folder, or absolute). */
  filename: string;
  /** False when deleted or past the first 20 files: nothing is read. */
  read: boolean;
}

/**
 * The files a completed file change lists, in order. `paths` is this
 * computer's path module, or `path.posix` for a folder on an SSH host (R9).
 */
function plannedFiles(
  item: Item,
  cwd: string,
  paths: typeof path.posix,
): PlannedFile[] {
  if (item.type !== "fileChange" || item.status !== "completed") return [];
  const capturedAt = Date.now();
  return (item.changes ?? []).map((change, index) => {
    const kind =
      typeof change.kind === "string" ? change.kind : change.kind?.type;
    const filename =
      kind === "update" && change.kind?.move_path
        ? change.kind.move_path
        : change.path;
    const name = paths.basename(filename);
    const file: GeneratedFile = {
      capturedAt,
      id: `${item.id}:${index}`,
      name,
      path: paths.resolve(cwd, filename),
      language: languageFor(name) ?? "text",
      operation:
        kind === "add" ? "create" : kind === "delete" ? "delete" : "update",
      state: kind === "delete" ? "deleted" : "unavailable",
    };
    if (kind === "update" && change.kind?.move_path)
      file.previousPath = paths.resolve(cwd, change.path);
    if (kind === "delete") return { file, filename, read: false };
    if (index >= 20) {
      file.error = "This tool changed too many files to preview all of them.";
      return { file, filename, read: false };
    }
    return { file, filename, read: true };
  });
}

/** Which allowance of `itemBudgets` a file's snapshot counts against. */
function allowanceOf(name: string, blobs: GeneratedBlobs | undefined) {
  return blobs && binaryTypes[path.extname(name).toLowerCase()]
    ? ("binary" as const)
    : ("text" as const);
}

/** Capture only successful, declared file changes. Historical cards never reread a mutable path. */
export function captureGeneratedFiles(
  item: Item,
  cwd: string,
  blobs?: GeneratedBlobs,
): GeneratedFile[] {
  const budget = { ...itemBudgets };
  return plannedFiles(item, cwd, path as typeof path.posix).map(
    ({ file, filename, read }) => {
      if (!read) return file;
      const allowance = allowanceOf(file.name, blobs);
      budget[allowance] -= snapshotFile(
        file,
        cwd,
        filename,
        budget[allowance],
        blobs,
      );
      return file;
    },
  );
}

/**
 * Reads a file of a folder on another computer (an SSH host, R9). `file`
 * is absolute and lexically inside `cwd`; the reader refuses one that
 * resolves outside `cwd`, a link, and anything larger than `maxBytes`,
 * with a message the card shows (see `RemoteWorkspace.readFileInside`).
 */
export type WorkspaceFileReader = (
  cwd: string,
  file: string,
  maxBytes: number,
) => Promise<Buffer>;

/**
 * `captureGeneratedFiles` for a conversation whose folder is on an SSH host
 * (R9): the same files, types, size limits and budgets, read through
 * `read`, with POSIX paths.
 */
export async function captureGeneratedFilesWith(
  item: Item,
  cwd: string,
  read: WorkspaceFileReader,
  blobs?: GeneratedBlobs,
): Promise<GeneratedFile[]> {
  const posix = path.posix;
  const budget = { ...itemBudgets };
  const planned = plannedFiles(item, cwd, posix);
  for (const { file, filename, read: wanted } of planned) {
    if (!wanted) continue;
    const allowance = allowanceOf(file.name, blobs);
    const extension = posix.extname(file.name).toLowerCase();
    const mime = blobs ? binaryTypes[extension] : undefined;
    try {
      if (!languages[extension] && !mime)
        throw new Error("Preview is not available for this file type.");
      const requested = posix.resolve(cwd, filename);
      const relative = posix.relative(posix.resolve(cwd), requested);
      if (
        relative === ".." ||
        relative.startsWith("../") ||
        posix.isAbsolute(relative)
      )
        throw new Error("This file is outside the conversation workspace.");
      const limit = Math.min(
        mime ? maxBlobBytes : maxFileBytes,
        budget[allowance],
      );
      if (limit <= 0) throw new FileTooLargeError();
      const data = await read(cwd, requested, limit);
      budget[allowance] -= keepSnapshot(file, data, mime, blobs);
    } catch (error) {
      if (error instanceof FileTooLargeError) markTooLarge(file, error.bytes);
      else
        file.error =
          error instanceof Error
            ? error.message
            : "The generated file could not be read.";
    }
  }
  return planned.map(({ file }) => file);
}

/** What a Chat or Cowork turn hands over: documents, data, images, pages. */
const outputTypes = new Set([
  ...Object.keys(binaryTypes),
  ".md",
  ".markdown",
  ".html",
  ".htm",
  ".svg",
  ".csv",
  ".tsv",
  ".txt",
  ".json",
  ".mmd",
  ".mermaid",
]);
/**
 * What a Code turn hands over as cards: documents only. Source, pages and data
 * a Code turn writes are its changes (the Changes panel).
 */
export const codeOutputTypes = new Set([
  ".docx",
  ".xlsx",
  ".pptx",
  ".doc",
  ".xls",
  ".ppt",
  ".pdf",
]);
const skippedFolders = new Set([
  "node_modules",
  "__pycache__",
  "venv",
  ".venv",
  "dist",
  "build",
]);

/**
 * Files a turn wrote without a file change: made by a command (a script that
 * saves a spreadsheet, a converter). Walks `cwd` a few levels down for
 * deliverable types changed since `since`, skipping hidden and tool folders
 * and the paths `known` already covers, and snapshots them like file changes.
 */
export function captureOutputFiles(
  cwd: string,
  since: number,
  known: ReadonlySet<string>,
  blobs?: GeneratedBlobs,
  id = "outputs",
  types: ReadonlySet<string> = outputTypes,
): GeneratedFile[] {
  const found: { filename: string; mtime: number }[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++visited > 5000 || found.length >= 40) return;
      if (entry.name.startsWith(".")) continue;
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4 && !skippedFolders.has(entry.name))
          walk(filename, depth + 1);
      } else if (
        entry.isFile() &&
        types.has(path.extname(entry.name).toLowerCase()) &&
        !known.has(path.resolve(filename))
      ) {
        try {
          const mtime = fs.statSync(filename).mtimeMs;
          if (mtime >= since) found.push({ filename, mtime });
        } catch {
          // Gone again: nothing to hand over.
        }
      }
    }
  };
  walk(cwd, 0);
  found.sort((a, b) => a.mtime - b.mtime);
  const budget = { ...itemBudgets };
  const capturedAt = Date.now();
  return found.slice(0, 20).map(({ filename }, index) => {
    const name = path.basename(filename);
    const file: GeneratedFile = {
      capturedAt,
      id: `${id}:${index}`,
      name,
      path: path.resolve(filename),
      language: languageFor(name) ?? "text",
      operation: "create",
      state: "unavailable",
    };
    const allowance = allowanceOf(name, blobs);
    budget[allowance] -= snapshotFile(
      file,
      cwd,
      path.relative(cwd, filename),
      budget[allowance],
      blobs,
    );
    return file;
  });
}
