import { app, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  editorUrl,
  type EditorInfo,
  type EditorKind,
} from "../../shared/editors";

export type EditorSshTarget = NonNullable<Parameters<typeof editorUrl>[2]>;
export type EditorFileLaunch = {
  ssh?: EditorSshTarget;
  current?(): boolean;
  verify?(): Promise<boolean>;
};

/**
 * Open in ▸ editors (desktop 2.37337.1, the main process's editor list):
 * an editor counts as installed when the system has an app for its URL
 * scheme; the folder opens through that scheme, over SSH as a VS Code
 * remote. Xcode opens the folder's project file and is offered only where
 * one exists.
 */
const editors: Record<
  EditorKind,
  { protocols: string[]; name: string; platform?: NodeJS.Platform }
> = {
  vscode: { protocols: ["vscode://", "vscode-insiders://"], name: "VS Code" },
  cursor: { protocols: ["cursor://"], name: "Cursor" },
  zed: { protocols: ["zed://"], name: "Zed" },
  windsurf: { protocols: ["windsurf://"], name: "Windsurf" },
  xcode: { protocols: ["xcode://"], name: "Xcode", platform: "darwin" },
};

async function handler(kind: EditorKind) {
  for (const protocol of editors[kind].protocols)
    try {
      const info = await app.getApplicationInfoForProtocol(protocol);
      if (info?.path) return { protocol, info };
    } catch {
      /* Not registered: the next scheme, or none. */
    }
  return null;
}

/** The folder's Xcode workspace, project or package, also under ios/, macos/ or apple/. */
export async function xcodeProjectFile(folder: string) {
  const find = async (dir: string) => {
    const entries = await fs.promises
      .readdir(dir, { withFileTypes: true })
      .catch(() => null);
    if (!entries) return null;
    const pick =
      entries.find((e) => e.isDirectory() && e.name.endsWith(".xcworkspace")) ??
      entries.find((e) => e.isDirectory() && e.name.endsWith(".xcodeproj")) ??
      entries.find((e) => e.isFile() && e.name === "Package.swift");
    return pick ? path.join(dir, pick.name) : null;
  };
  const own = await find(folder);
  if (own) return own;
  for (const sub of ["ios", "macos", "apple"]) {
    const dir = path.join(folder, sub);
    if (!(await fs.promises.lstat(dir).catch(() => null))?.isDirectory())
      continue;
    const found = await find(dir);
    if (found) return found;
  }
  return null;
}

/** The editors this computer has, with their icons (32px data URLs). */
export async function installedEditors(folder?: string): Promise<EditorInfo[]> {
  const list: EditorInfo[] = [];
  for (const kind of Object.keys(editors) as EditorKind[]) {
    const editor = editors[kind];
    if (editor.platform && editor.platform !== process.platform) continue;
    try {
      const found = await handler(kind);
      if (
        kind === "xcode" &&
        found &&
        folder &&
        !(await xcodeProjectFile(folder))
      )
        continue;
      let icon: string | undefined;
      if (found) {
        let image = found.info.icon;
        if (!image || image.isEmpty())
          image = await app.getFileIcon(found.info.path, { size: "normal" });
        if (!image.isEmpty())
          icon = image.resize({ width: 32, height: 32 }).toDataURL();
      }
      list.push({ kind, name: editor.name, installed: Boolean(found), icon });
    } catch {
      list.push({ kind, name: editor.name, installed: false });
    }
  }
  return list;
}

/** Opens the folder in the editor; false when it isn't installed or can't take it. */
export async function openInEditor(
  kind: EditorKind,
  folder: string,
  ssh?: { destination: string; port?: number },
  current?: () => boolean,
): Promise<boolean> {
  const editor = editors[kind];
  if (!editor) return false;
  const found = await handler(kind);
  if (!found) return false;
  if (kind === "xcode") {
    if (ssh) return false;
    const project = await xcodeProjectFile(folder);
    if (
      !project ||
      (await fs.promises.lstat(project)).isSymbolicLink() ||
      current?.() === false
    )
      return false;
    return !(await shell.openPath(project));
  }
  if ((ssh && kind === "zed") || current?.() === false) return false;
  await shell.openExternal(
    editorUrl(found.protocol, folder, ssh, process.platform === "win32"),
  );
  return true;
}

/** Opens a file at an optional position using a registered editor protocol. */
export async function openFileInEditor(
  kind: Exclude<EditorKind, "xcode">,
  file: string,
  line?: number,
  column?: number,
  options: EditorFileLaunch = {},
): Promise<boolean> {
  if (options.ssh && kind === "zed") return false;
  const found = await handler(kind);
  if (!found) return false;
  const position =
    line === undefined
      ? ""
      : `:${line}${column === undefined ? "" : `:${column}`}`;
  const target = file + position;
  const windows = process.platform === "win32";
  if (kind === "zed" && position && !windows) {
    // Zed prefers an existing literal filename over its line and column suffix.
    const sibling = await fs.promises.lstat(target).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    });
    if (sibling) return false;
  }
  const url = options.ssh
    ? editorUrl(found.protocol, file, options.ssh) + position
    : editorUrl(found.protocol, target, undefined, windows);
  if (options.verify && !(await options.verify())) return false;
  if (options.current?.() === false) return false;
  await shell.openExternal(url);
  return true;
}
