import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isUtf8 } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import { FileTooLargeError, generatedFileBinaryTypes } from "../artifacts/generated-files";
import { nativeDocumentPreviewMaxBytes } from "../official-ui/document-preview";
import { changesHookConfiguration } from "../projects/project-files";
import { checkHostPath, RemoteFileReadError } from "../ssh/remote-workspace";
import { contextSources, remoteEnvironmentInput, requireWslWorkspaceTrust, workspaceFsFor } from "../workspace/workspace-fs";

const maxBytes = 10 * 1024 * 1024;
const maxCoworkBytes = 8_000_000;
const text = z
  .string()
  .max(4096)
  .refine((s) => !s.includes("\0"));
const request = z
  .object({
    operation: z.enum([
      "list",
      "index",
      "mention",
      "read",
      "resolve",
      "write",
      "create",
      "document",
      "downloadDocument",
      "image",
      "media",
      "panelMedia",
      "streamImage",
      "streamMedia",
      "readCowork",
      "resolveCowork",
    ]),
    sessionId: z.string().min(1).max(200).optional(),
    cwd: text.optional(),
    environment: remoteEnvironmentInput.optional(),
    path: text,
    contents: z.string().max(maxBytes).optional(),
    expectedHash: z.string().optional(),
    options: z.object({
      includeHash: z.boolean().optional(),
      tailBytes: z.number().int().nonnegative().optional(),
      previewContent: z.boolean().optional(),
      filesPaneRead: z.boolean().optional(),
      automatic: z.boolean().optional(),
    }).optional(),
  })
  .strict();
const imageStreamMinimum = 1024 * 1024;
const imageMaximum = 10 * 1024 * 1024;
const panelMaximum = 25 * 1024 * 1024;
const mediaMaximum = 50 * 1024 * 1024;
const images: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};
const media: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/mp4",
  ".m4v": "video/mp4",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".opus": "audio/ogg",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
};
const documents: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pdf": "application/pdf",
};
const dataPreviews: Partial<Record<FileRequest["operation"], { types: Record<string, string>; maxBytes: number }>> = {
  image: { types: { ...images, ".svg": "image/svg+xml" }, maxBytes: imageMaximum },
  media: { types: media, maxBytes: mediaMaximum },
  panelMedia: { types: media, maxBytes: panelMaximum },
  document: { types: documents, maxBytes: nativeDocumentPreviewMaxBytes },
  downloadDocument: { types: documents, maxBytes: nativeDocumentPreviewMaxBytes },
};
function dataUrl(mime: string, data: Buffer) {
  return `data:${mime};base64,${data.toString("base64")}`;
}
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
type FileRequest = z.infer<typeof request>;
type RemoteEnvironment = z.infer<typeof remoteEnvironmentInput>;

function previewFileRead(operation: FileRequest["operation"], filePath: string) {
  const preview = dataPreviews[operation];
  return preview && { mime: preview.types[path.extname(filePath).toLowerCase()], limit: preview.maxBytes };
}

function formatFileRead(input: FileRequest, resolved: string, data: Buffer, fileSize: number, digest?: string, isTail = false) {
  const preview = previewFileRead(input.operation, resolved);
  if (preview) {
    if (!preview.mime) return { status: "unsupported" };
    return { status: "ok", dataUrl: dataUrl(preview.mime, data), fileSize };
  }
  let start = 0;
  if (isTail) {
    while (start < data.length && (data[start] & 0xc0) === 0x80) start++;
  }
  return {
    status: "ok",
    file: {
      absPath: resolved,
      contents: data.toString("utf8", start),
      ...(digest === undefined ? {} : { hash: digest }),
      fileSize,
      ...(isTail ? { isTail } : {}),
      inSessionFolders: true,
    },
  };
}
const inside = (root: string, file: string, paths = path) => {
  const relative = paths.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${paths.sep}`) &&
      relative !== ".." &&
      !paths.isAbsolute(relative))
  );
};
const workspaceControlDirectories = new Set([
  ".git", ".hg", ".claude", ".husky", ".githooks", "githooks", ".lefthook", ".lefthook-local",
]);
const workspaceControlFile =
  /^(?:\.mcp\.json|\.claude\.json|\.pre-commit-config\.ya?ml|\.?lefthook(?:-local)?\.(?:ya?ml|toml|json)|\.lintstagedrc(?:\..+)?|lint-staged\.config\..+|package\.ya?ml|\.huskyrc(?:\..+)?|husky\.config\..+|\.commitlintrc(?:\..+)?|commitlint\.config\..+|\.?nano-staged\.(?:json|[cm]?js)|nano-staged\.config\.[cm]?js)$/;

function resolveMissingFile(workspace: string, target: string): string | undefined {
  for (
    let parent = path.dirname(target);
    inside(workspace, parent);
    parent = path.dirname(parent)
  ) {
    try {
      const entry = fs.lstatSync(parent, { throwIfNoEntry: false });
      if (entry) {
        const resolved = fs.realpathSync(parent);
        const directory = entry.isSymbolicLink() ? fs.statSync(resolved).isDirectory() : entry.isDirectory();
        if (!directory) return;
        return path.resolve(resolved, path.relative(parent, target));
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw error;
    }
    if (parent === workspace) return;
  }
}

function canCreateTextFile(root: string, target: string, inputPath: string): boolean {
  if (!inside(root, target) || /[\\/]$/.test(inputPath)) return false;
  const relative = path.relative(root, target);
  const parts = relative.split(path.sep);
  const names = parts.map((part) => part.toLowerCase());
  if (!relative || names[0] === "scratchpad" || workspaceControlFile.test(names.at(-1) ?? ""))
    return false;
  const location = target.split(path.sep).map((part) => part.toLowerCase());
  if (location.some((name, index) =>
    workspaceControlDirectories.has(name) &&
      !(name === ".claude" && location[index + 1] === "worktrees" && index + 2 < location.length)))
    return false;
  return process.platform !== "win32" || names.every((name) =>
    !/:|[. ]$/.test(name) &&
    !/^(?:con|prn|aux|nul|(?:com|lpt)[1-9¹²³])(?:\.|$)/iu.test(name));
}

async function readRemoteFile(
  ctx: AppContext, environment: RemoteEnvironment, input: FileRequest, cwd: string,
  target: string, workspaces: string[],
) {
  const store = ctx.store, activation = ctx.accountActivationIdentity;
  const current = () => {
    if (ctx.accountRetiring || ctx.store !== store || ctx.accountActivationIdentity !== activation)
      throw Error("The account changed during this request.");
  };
  if (environment.kind === "wsl") {
    await requireWslWorkspaceTrust(ctx.engines, cwd, environment);
    current();
  }
  const workspace = workspaceFsFor(contextSources(ctx), environment);
  if (input.operation === "mention") {
    const result = await workspace.mentionFiles(cwd, z.string().max(300).parse(input.path));
    current();
    return result;
  }
  if (input.operation === "index") {
    const entries = await workspace.listFolder(cwd);
    current();
    return entries;
  }
  if (input.path === "~" || input.path.startsWith("~/")) {
    target = path.posix.resolve(await workspace.homeDirectory(), input.path.slice(2));
    current();
  }
  const candidates = workspaces.filter(folder => inside(folder, target, path.posix));
  if (!candidates.length) return { status: "outsideSessionFolders" };
  if (input.operation === "resolve") return { status: "ok", path: target };
  if (input.operation === "streamImage" || input.operation === "streamMedia" ||
      input.operation === "media" || input.operation === "panelMedia")
    return { status: "unsupported" };
  const preview = previewFileRead(input.operation, target);
  const limit = preview?.limit ?? maxBytes;
  if (preview && !preview.mime) return { status: "unsupported" };
  for (const root of candidates) {
    try {
      if (input.operation === "list") {
        const directory = await workspace.listDirectoryInside(root, target);
        current();
        return {
          status: "ok",
          resolvedPath: target,
          entries: directory.entries.map(entry => ({
            name: entry.name, path: path.posix.join(target, entry.name), isDirectory: entry.kind === "folder",
          })),
        };
      }
      const bytes = await workspace.readFileInside(root, target, limit, { followLinks: true });
      current();
      return formatFileRead(input, target, bytes, bytes.length);
    } catch (error) {
      current();
      if (error instanceof FileTooLargeError) return { status: "tooLarge", maxBytes: limit };
      if (!(error instanceof RemoteFileReadError)) throw error;
      if (error.code === 3) continue;
      if (error.code === 4) return { status: "notFound" };
      if (error.code === 5) return { status: "outsideSessionFolders" };
      return { status: "readError" };
    }
  }
  return { status: "notFound" };
}

/** All paths are re-authorized in the existing account-owned IPC boundary. */
export function registerOfficialFileHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  handle("officialSessionFile", (raw: unknown) => {
    const input = request.parse(raw);
    const owner = ctx.activeAccount?.id;
    if (ctx.accountRetiring) throw Error("The account changed during this request.");
    const c = input.sessionId
      ? ctx.store.conversation(input.sessionId)
      : undefined;
    const cowork =
      input.operation === "readCowork" || input.operation === "resolveCowork";
    if (cowork) {
      if (
        !owner ||
        ctx.accountRetiring ||
        c?.mode !== "cowork" ||
        c.cloudHosted ||
        c.cloudEnvironmentId ||
        (c.environment?.kind ?? "local") !== "local" ||
        c.linkedToComputer ||
        c.chatDeviceBinding ||
        (c.sessionAuthors &&
          (c.sessionAuthors.ownerAccountUuid !== owner ||
            c.sessionAuthors.viewerAccountUuid !== owner))
      )
        throw Error(
          "LocalFileAccessError: [INVALID_SESSION] Cowork session is unavailable.",
        );
    } else if (
      input.sessionId &&
      (!owner || !c || c.mode !== "code" ||
        c.cloudHosted ||
        c.cloudEnvironmentId ||
        c.environment?.kind === "space" ||
        (c.sessionAuthors && (c.sessionAuthors.ownerAccountUuid !== owner ||
          c.sessionAuthors.viewerAccountUuid !== owner)))
    )
      throw Error("This Code session is unavailable.");
    const environment = c ? c.environment : input.environment;
    const remote = environment?.kind === "wsl" || environment?.kind === "ssh" ? environment : undefined;
    const cwd = c?.cwd ?? (!input.sessionId ? input.cwd : undefined);
    if (!cwd) throw Error("Choose a local working folder first.");
    if (remote) checkHostPath(cwd);
    else if (!path.isAbsolute(cwd)) throw Error("Choose an absolute working folder.");
    ctx.allowedFolder(cwd, remote);
    const mutation = input.operation === "create" || input.operation === "write";
    const paths = remote ? path.posix : path;
    const worktree = !cowork && c?.worktree?.state !== "deleted" ? c?.worktree?.path : undefined;
    const pane = !cowork && c?.worktree?.state === "deleted" ? c.worktree.origin : cwd;
    const primary = worktree ?? pane;
    const filePath = cowork || remote ? input.path :
      input.path === "~" ? os.homedir() :
        /^~[\\/]/.test(input.path) ? path.join(os.homedir(), input.path.slice(2)) : input.path;
    const base = input.operation === "write" || (remote && input.operation !== "list") ? primary : pane;
    let target = paths.resolve(base, filePath || ".");
    if (!remote && !mutation && input.operation !== "list" && worktree && pane !== primary &&
        !path.isAbsolute(filePath) && inside(pane, target) && !fs.existsSync(target)) {
      const fromWorktree = path.resolve(primary, filePath);
      if (inside(primary, fromWorktree) && fs.existsSync(fromWorktree)) target = fromWorktree;
    }
    const denied = () =>
      mutation
        ? { status: "denied", deniedReason: "outsideSessionFolders" }
        : { status: "outsideSessionFolders" };
    if (mutation && (remote || !c || c.worktree?.state === "deleted")) return { status: "denied" };
    const deletedFolders = new Set(c?.additionalWorktrees?.filter(tree => tree.state === "deleted")
      .flatMap(tree => tree.folders.map(folder => folder.cwd)));
    const roots = mutation || cowork ? [primary] : [
      pane, primary, c?.worktree?.origin,
      ...(c?.additionalFolders ?? []).filter(folder => !deletedFolders.has(folder)),
      ...(!cowork ? c?.additionalWorktrees?.flatMap(tree =>
        tree.state === "deleted" ? tree.folders.map(folder => folder.origin) : [tree.path]) ?? [] : []),
    ];
    const workspaces = [...new Set(roots.flatMap(folder => folder && paths.isAbsolute(folder)
      ? [paths.resolve(folder)] : []))];
    if (remote)
      return readRemoteFile(ctx, remote, input, pane, target, workspaces);
    const candidates = workspaces.filter(folder => inside(folder, target));
    if (!candidates.length) return denied();
    const workspace = candidates.find(folder => fs.existsSync(folder));
    if (!workspace) return { status: "notFound" };
    const root = fs.realpathSync(workspace);
    let realPrimary: string | undefined;
    if (c && !cowork && c.worktree?.state !== "deleted" && inside(primary, target)) {
      if (workspace === primary) realPrimary = root;
      else if (fs.existsSync(primary)) realPrimary = fs.realpathSync(primary);
    }
    const canEditPath = (resolved: string) => realPrimary !== undefined &&
      canCreateTextFile(primary, target, input.path) && canCreateTextFile(realPrimary, resolved, input.path);
    if (input.operation === "create" && !canCreateTextFile(workspace, target, input.path))
      return { status: "denied" };
    let resolved: string;
    try {
      resolved = fs.realpathSync(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const prospective = resolveMissingFile(workspace, target);
      if (prospective && !inside(root, prospective)) return denied();
      if (input.operation === "write")
        return {
          status: "denied",
          deniedReason: fs.existsSync(path.dirname(target))
            ? "File no longer exists." : "Parent folder does not exist.",
        };
      const creatable = prospective !== undefined && canEditPath(prospective);
      if (input.operation === "read" && (input.options?.includeHash === false || input.options?.tailBytes !== undefined))
        return { status: "notFound" };
      if (input.operation !== "create")
        return { status: "notFound", creatable };
      if (!creatable) return { status: "denied" };
      try {
        fs.mkdirSync(path.dirname(prospective), { recursive: true, mode: 0o755 });
        fs.closeSync(fs.openSync(prospective, "wx", 0o644));
        return { status: "ok" };
      } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code === "EEXIST")
          return { status: "conflict" };
        return null;
      }
    }
    if (!inside(root, resolved)) return denied();
    if (input.operation === "create")
      return { status: canEditPath(resolved) ? "conflict" : "denied" };
    if (input.operation === "resolve") return { status: "ok", path: resolved };
    if (input.operation === "list") {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      if (entries.length > 10_000)
        throw Error("This folder contains too many entries to list.");
      return {
        status: "ok",
        entries: entries.map((entry) => {
          const file = path.join(resolved, entry.name);
          let isDirectory = entry.isDirectory();
          if (entry.isSymbolicLink()) {
            try {
              const real = fs.realpathSync(file);
              isDirectory =
                inside(root, real) && fs.statSync(real).isDirectory();
            } catch {}
          }
          const info = fs.lstatSync(file);
          return {
            name: entry.name,
            path: path.join(target, entry.name),
            isDirectory,
            mtimeMs: info.mtimeMs,
            size: info.size,
          };
        }),
      };
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return { status: "readError" };
    if (input.operation === "resolveCowork")
      return { status: "ok", path: resolved };
    const extension = path.extname(resolved).toLowerCase();
    if (input.operation === "streamImage" || input.operation === "streamMedia") {
      const image = input.operation === "streamImage";
      const mimeType = (image ? images : media)[extension];
      if (!mimeType || (image && (stat.size < imageStreamMinimum || stat.size > imageMaximum)))
        return { status: "unsupported" };
      return { status: "ok", path: resolved, mimeType, mtimeMs: stat.mtimeMs };
    }
    const preview = previewFileRead(input.operation, resolved);
    const limit = preview?.limit ?? (input.operation === "readCowork" ? maxCoworkBytes : maxBytes);
    if (preview && !preview.mime) return { status: "unsupported" };
    const tail = input.operation === "read" && realPrimary && inside(realPrimary, resolved)
      ? input.options?.tailBytes : undefined;
    if (tail !== undefined && tail > 0 && stat.size > tail) {
      const bytes = Buffer.alloc(Math.min(tail, maxBytes));
      let fd: number | undefined;
      try {
        fd = fs.openSync(resolved, "r");
        const read = fs.readSync(fd, bytes, 0, bytes.length, stat.size - bytes.length);
        return formatFileRead(input, target, bytes.subarray(0, read), stat.size, undefined, true);
      } catch {
        return { status: "readError" };
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
    if (stat.size > limit) return { status: "tooLarge", maxBytes: limit };
    const data = fs.readFileSync(resolved);
    if (data.length > limit) return { status: "tooLarge", maxBytes: limit };
    if (input.operation === "readCowork") {
      const mimeType =
        generatedFileBinaryTypes[path.extname(resolved).toLowerCase()];
      const file =
        !mimeType && isUtf8(data) && !data.includes(0)
          ? { content: data.toString("utf8") }
          : {
              content: data.toString("base64"),
              encoding: "base64" as const,
              mimeType: mimeType ?? "application/octet-stream",
            };
      return { status: "ok", file };
    }
    if (preview) return formatFileRead(input, resolved, data, data.length);
    const writable = canEditPath(resolved) && (stat.mode & 0o222) !== 0 && isUtf8(data) && !data.includes(0);
    const digest = writable && (input.operation === "write" || input.options?.includeHash !== false) ? hash(data) : undefined;
    if (input.operation === "write") {
      if (!writable) return { status: "denied" };
      if (input.contents === undefined)
        throw Error("File contents are required.");
      if (path.basename(resolved).toLowerCase() === "package.json" &&
          changesHookConfiguration(data.toString("utf8"), input.contents))
        return { status: "denied", deniedReason: "hook_manager_package_key" };
      if (input.expectedHash !== undefined && input.expectedHash !== digest)
        return { status: "conflict", currentHash: digest };
      const bytes = Buffer.from(input.contents);
      if (bytes.length > maxBytes)
        throw Error("File contents exceed the limit.");
      const temporary = path.join(
        path.dirname(resolved),
        `.claudex-${randomUUID()}.tmp`,
      );
      try {
        fs.writeFileSync(temporary, bytes, { flag: "wx", mode: stat.mode });
        fs.renameSync(temporary, resolved);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      return { status: "ok", hash: hash(bytes) };
    }
    return formatFileRead(input, target, data, stat.size, digest);
  });
}
