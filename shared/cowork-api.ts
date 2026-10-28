/**
 * Cowork folder access (R11): Cowork asks before it uses a folder, remembers
 * "Always allow" as trusted folders (Settings → Cowork), and lets a running
 * conversation add folders.
 *
 * The handlers live in `electron/ipc/cowork.ts` and the grants in
 * `electron/cowork-folders.ts` (R11-A). The main process decides: every
 * Cowork send, edit, retry and routine run is checked there, and only a
 * folder the person chose with a picker (or already uses) can be granted.
 * A send refused for this reason fails with `coworkFolderPermissionMessage`;
 * the window then asks with the access dialog and sends again (R11-B).
 */
import { bridgeMethods } from "./bridge-methods";
import type {
  TaskFolderBrowserAPI,
  TaskFolderSnapshot,
} from "./folder-browser";

export type CoworkFolderState =
  "default" | "trusted" | "granted" | "ask" | "refused";

export interface CoworkFolderAccess {
  state: CoworkFolderState;
  /** The normalized absolute path. */
  folder: string;
  name: string;
  /** Why access is refused (state "refused"). */
  reason?: string;
  /** The folder is the home folder (the dialog warns). */
  home?: boolean;
}

export interface CoworkAPI extends TaskFolderBrowserAPI {
  listCoworkDevices(): Promise<import("./remote-devices").DeviceInfo[]>;
  /** With `projectId`, a folder allowed for that project's tasks passes. */
  coworkFolderAccess(
    folder: string,
    conversationId?: string,
    projectId?: string,
  ): Promise<CoworkFolderAccess>;
  /**
   * Records the person's "Allow": for a task, a routine, or a project (its
   * Folder section: each new Cowork task in the project gets the folder).
   */
  grantCoworkFolder(
    folder: string,
    scope: "session" | "always",
    target?: {
      conversationId?: string;
      routineId?: string;
      projectId?: string;
    },
  ): Promise<CoworkFolderAccess>;
  /** A Cowork conversation's working folder and the folders added to it. */
  coworkFolders(conversationId: string): Promise<TaskFolderSnapshot>;
  trustedCoworkFolders(): Promise<string[]>;
  /** Opens a folder picker in the main process; the chosen folder becomes trusted. */
  addTrustedCoworkFolder(): Promise<string[]>;
  removeTrustedCoworkFolder(folder: string): Promise<string[]>;
  /** Shows one of the conversation's folders in Finder / File Explorer. */
  revealCoworkFolder(conversationId: string, folder: string): Promise<void>;
  listCoworkFolder(
    conversationId: string,
    folderIndex: number,
    relative: string,
  ): Promise<{
    entries: import("./project-files").ProjectEntry[];
    truncated: boolean;
  }>;
  readCoworkFile(
    conversationId: string,
    folderIndex: number,
    relative: string,
  ): Promise<CoworkFile>;
  readCoworkInstructions(conversationId: string): Promise<string>;
  writeCoworkInstructions(
    conversationId: string,
    content: string,
  ): Promise<void>;
  revealCoworkFile(
    conversationId: string,
    folderIndex: number,
    relative: string,
  ): Promise<void>;
  readCoworkResource(conversationId: string, file: string): Promise<CoworkFile>;
  revealCoworkResource(conversationId: string, file: string): Promise<void>;
}

export type CoworkFile = import("./project-files").ProjectFile & {
  snapshot?: import("./types").GeneratedFile;
};

export const coworkMethods = bridgeMethods<CoworkAPI>({
  listCoworkDevices: true,
  coworkFolderAccess: true,
  grantCoworkFolder: true,
  coworkFolders: true,
  listTaskFolderDirectory: true,
  trustedCoworkFolders: true,
  addTrustedCoworkFolder: true,
  removeTrustedCoworkFolder: true,
  revealCoworkFolder: true,
  listCoworkFolder: true,
  readCoworkFile: true,
  readCoworkInstructions: true,
  writeCoworkInstructions: true,
  revealCoworkFile: true,
  readCoworkResource: true,
  revealCoworkResource: true,
});

/** Trusted folders or a conversation's granted folders changed. */
export interface CoworkFoldersEvent {
  type: "cowork-folders";
  conversationId?: string;
}

/**
 * The error a Cowork send (or edit, retry) fails with when its folder was
 * never allowed: the window asks for the folder, then sends again.
 */
export const coworkFolderPermissionMessage =
  "Allow Cowork to use this folder first.";
