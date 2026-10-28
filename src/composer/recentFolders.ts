import type { Conversation, EnvironmentRef } from "../../shared/types";

/**
 * The folder Claudex makes for a Code session started without one
 * (`<workspace>/sessions/<uuid>`, electron/engine/engine-send.ts): the
 * session's own, never a folder the person picked, so never offered again.
 */
export const isSessionFolder = (path: string) =>
  /[\\/]sessions[\\/][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[\\/]?$/i.test(
    path,
  );

/** The SSH host a conversation runs on; undefined for this computer. */
const hostOf = (environment?: EnvironmentRef) =>
  environment?.kind === "ssh" ? environment.hostId : undefined;

/**
 * Working folders of Code conversations in one environment (this computer
 * unless an SSH host is named), most recently active first. A folder on a
 * host never shows among this computer's folders, or on another host.
 */
export function recentFolders(
  conversations: Conversation[],
  limit = 8,
  environment?: EnvironmentRef,
) {
  const host = hostOf(environment);
  const folders: string[] = [];
  for (const c of [...conversations].sort((a, b) => b.updatedAt - a.updatedAt))
    if (
      c.mode === "code" &&
      c.cwd &&
      !isSessionFolder(c.cwd) &&
      hostOf(c.environment) === host &&
      !folders.includes(c.cwd)
    )
      folders.push(c.cwd);
  return folders.slice(0, limit);
}

/**
 * Folders Cowork and Code tasks worked in on this computer, most recently
 * active first, for the Cowork project or folder menu.
 */
export function recentWorkFolders(
  conversations: Conversation[],
  limit = 8,
  includeChat = false,
) {
  const folders: string[] = [];
  for (const c of [...conversations].sort((a, b) => b.updatedAt - a.updatedAt))
    if (
      (c.mode === "code" ||
        c.mode === "cowork" ||
        (includeChat && c.mode === "chat")) &&
      c.cwd &&
      !isSessionFolder(c.cwd) &&
      !c.incognito &&
      (!includeChat ||
        (!c.archived &&
          !c.linkedToComputer &&
          (!c.environment || c.environment.kind === "local"))) &&
      !hostOf(c.environment) &&
      !folders.includes(c.cwd)
    )
      folders.push(c.cwd);
  return folders.slice(0, limit);
}

/** The last path segment, as the folder chip and menu show it. */
export const folderName = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
