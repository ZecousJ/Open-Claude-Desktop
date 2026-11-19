import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { mentionFiles } from "../../electron/engine/composer-files";
import { isOwnedCloudCodeSession } from "../../electron/official-ui/api/code-session-ownership";
import {
  projectFileLimit,
  projectFolderLimit,
} from "../../electron/projects/project-files";
import type { Conversation } from "../../shared/types";
import { inCodeWorkspace } from "./code-workspace";
import { within } from "./sandbox/driver";
import { openVerified } from "./sandbox/snapshot";
import type { WebAppContext } from "./web-app-context";

const filePath = z
  .string()
  .max(4096)
  .refine((value) => !value.includes("\0"));
export const workspaceFileControl = z.discriminatedUnion("subtype", [
  z.strictObject({
    subtype: z.literal("list_directory"),
    path: filePath.max(1024),
  }),
  z.strictObject({
    subtype: z.literal("file_suggestions"),
    query: z.string().max(300),
  }),
  z.strictObject({
    subtype: z.literal("read_file"),
    path: filePath.min(1),
    encoding: z.enum(["utf8", "base64"]).optional(),
    max_bytes: z.number().int().positive().max(10_000_000).optional(),
    anchor: z
      .strictObject({
        kind: z.literal("as_written"),
        within: filePath.array().max(512),
      })
      .optional(),
  }),
]);
type WorkspaceFileControl = z.infer<typeof workspaceFileControl>;

export function officialCodeWorkspaceDirectory(
  ctx: WebAppContext,
  conversation: Conversation,
) {
  const owner = ctx.activeAccount?.id;
  const { cwd, environment } = conversation;
  if (
    !owner ||
    ctx.accountRetiring ||
    !isOwnedCloudCodeSession(conversation, owner) ||
    conversation.archived ||
    conversation.linkedToComputer ||
    conversation.chatDeviceBinding ||
    (conversation.sessionAuthors &&
      conversation.sessionAuthors.viewerAccountUuid !== owner) ||
    !cwd ||
    !path.isAbsolute(cwd)
  )
    return;
  try {
    const workspace =
      environment?.kind === "space"
        ? path.join(ctx.spaceRoot(environment.spaceId), "workspace")
        : ctx.workspace;
    const root = fs.realpathSync(ctx.store.root);
    if (
      within(cwd, ctx.store.root) &&
      inCodeWorkspace(workspace, cwd) &&
      fs.realpathSync(cwd) ===
        path.join(root, path.relative(ctx.store.root, cwd)) &&
      fs.statSync(cwd).isDirectory()
    )
      return cwd;
  } catch {
    return;
  }
}

function targetPath(cwd: string, requested: string) {
  if (
    requested.startsWith("~") ||
    requested.split("/").some((part) => part === ".." || part === ".git")
  )
    return;
  const target = path.resolve(cwd, requested);
  if (within(target, cwd)) return target;
}

function realPath(cwd: string, target: string) {
  const root = fs.realpathSync(cwd);
  const real = fs.realpathSync(target);
  if (
    within(real, root) &&
    !path.relative(root, real).split(path.sep).includes(".git")
  )
    return real;
}

export function readOfficialCodeWorkspaceFiles(
  cwd: string,
  control: WorkspaceFileControl,
) {
  if (control.subtype === "file_suggestions") {
    const suggestions = mentionFiles(cwd, control.query).map(
      ({ path, kind }) => ({
        path: kind === "folder" ? path + "/" : path,
      }),
    );
    return { response: { cwd, suggestions } };
  }
  const { path: requested } = control;
  const target = targetPath(cwd, requested);
  if (control.subtype === "list_directory") {
    if (
      !target ||
      (requested && /[\\]|^\/|\/$|\/\/|(?:^|\/)\.(?:\/|$)/.test(requested))
    )
      return { error: "list denied: invalid_path" };
    const folder = realPath(cwd, target);
    if (!folder) return { error: "list denied: outside_workspace" };
    const entries = fs
      .readdirSync(folder, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.name !== ".git" &&
          entry.name !== ".DS_Store" &&
          (entry.isDirectory() || entry.isFile() || entry.isSymbolicLink()),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      response: {
        entries: entries.slice(0, projectFolderLimit).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isSymlink: entry.isSymbolicLink(),
        })),
        truncated: entries.length > projectFolderLimit,
        absPath: target,
      },
    };
  }
  if (!target || (control.anchor && !control.anchor.within.includes(cwd)))
    return { error: "read denied: outside_workspace" };
  const real = realPath(cwd, target);
  if (!real) return { error: "read denied: outside_workspace" };
  const fd = openVerified(real, real);
  if (fd === undefined) return { error: "read denied: unavailable" };
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile())
      return {
        error: stat.isDirectory() ? "EISDIR" : "read denied: unavailable",
      };
    const encoding = control.encoding ?? "utf8";
    const maximum = encoding === "base64" ? 10_000_000 : projectFileLimit;
    const length = Math.min(stat.size, control.max_bytes ?? maximum, maximum);
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = fs.readSync(fd, bytes, read, length - read, read);
      if (!count) break;
      read += count;
    }
    return {
      response: {
        contents: bytes.subarray(0, read).toString(encoding),
        encoding,
        fileSize: stat.size,
        truncated: read < stat.size,
        absPath: target,
        ...(control.anchor && { anchor: control.anchor.kind }),
      },
    };
  } finally {
    fs.closeSync(fd);
  }
}
