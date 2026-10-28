import { useEffect, useState, useSyncExternalStore } from "react";
import {
  coworkFolderPermissionMessage,
  type CoworkFolderAccess,
} from "../../shared/cowork-api";

/**
 * Asking before Cowork uses a folder. The main process decides
 * (`electron/ipc/cowork.ts`); this module asks it, and when it answers "ask"
 * shows the access dialog through the one mounted `FolderAccessHost` and waits
 * for the person's choice. Folders the app already allows (its own workspace,
 * trusted folders, folders this task was given) pass without a dialog. Cancel
 * keeps whatever was chosen before.
 */

export type FolderAccessResult = "granted" | "cancelled";

export interface FolderAccessTarget {
  /** The Cowork task the folder is for (its working folder or an added one). */
  conversationId?: string;
  /** The routine the folder is for. */
  routineId?: string;
  /** The project the folder is for (its Folder section). */
  projectId?: string;
}

export type FolderAccessChoice = "cancel" | "allow" | "always";

/** The request the dialog shows. */
export interface FolderAccessRequest {
  /** The path the person chose, as the picker returned it. */
  path: string;
  access: CoworkFolderAccess;
  target: FolderAccessTarget;
  /** Records the person's choice in the main process and ends the request. */
  answer(choice: FolderAccessChoice): Promise<void>;
}

interface Bridge {
  coworkFolderAccess(
    folder: string,
    conversationId?: string,
    projectId?: string,
  ): Promise<CoworkFolderAccess>;
  grantCoworkFolder(
    folder: string,
    scope: "session" | "always",
    target?: FolderAccessTarget,
  ): Promise<CoworkFolderAccess>;
}

let current: FolderAccessRequest | undefined;
/** Mounted hosts, oldest first; only the first one shows the dialog. */
let hosts: object[] = [];
const listeners = new Set<() => void>();
const publish = (next: FolderAccessRequest | undefined) => {
  current = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const bridge = (): Bridge | undefined =>
  (globalThis as { window?: { desktop?: Bridge } }).window?.desktop;

/**
 * Makes sure Cowork may use `path`, asking the person when it needs to.
 * Resolves "granted" once the main process allows the folder, "cancelled"
 * when the person declines or the folder can't be used (the reason is
 * passed to `notify`). Rejects when the main process fails.
 */
export async function requestFolderAccess(
  path: string,
  options: FolderAccessTarget & {
    notify?: (message: string) => void;
    api?: Bridge;
    signal?: AbortSignal;
  } = {},
): Promise<FolderAccessResult> {
  const { notify, api = bridge(), signal, ...target } = options;
  if (signal?.aborted) return "cancelled";
  if (!api) throw new Error("Cowork folder access isn't available.");
  const access = target.projectId
    ? await api.coworkFolderAccess(path, undefined, target.projectId)
    : await api.coworkFolderAccess(path, target.conversationId);
  if (signal?.aborted) return "cancelled";
  if (access.state === "refused") {
    notify?.(access.reason ?? "Some folders couldn’t be added.");
    return "cancelled";
  }
  // Allowed already (for the project, or just now): the project records it
  // without asking again, so its later tasks get it too.
  if (access.state === "granted" && target.projectId) {
    await api.grantCoworkFolder(path, "session", target);
    return "granted";
  }
  if (
    access.state === "default" ||
    access.state === "trusted" ||
    // A folder the task already has; a routine still records its own grant.
    (access.state === "granted" && !target.routineId)
  )
    return "granted";
  if (!hosts.length)
    throw new Error("Cowork can't ask for folder access right now.");
  // A newer request replaces one still waiting (it counts as cancelled).
  current?.answer("cancel").catch(() => undefined);
  return new Promise<FolderAccessResult>((resolve) => {
    let settled = false;
    // A grant on its way to the main process can't be taken back: a cancel
    // (a newer request, the host closing) then waits for its outcome.
    let granting = false;
    const settle = (result: FolderAccessResult) => {
      settled = true;
      signal?.removeEventListener("abort", cancel);
      if (current === request) publish(undefined);
      resolve(result);
    };
    const cancel = () => {
      if (!settled) settle("cancelled");
    };
    const request: FolderAccessRequest = {
      path,
      access,
      target,
      answer: async (choice) => {
        if (settled) return;
        if (choice === "cancel") {
          if (!granting) settle("cancelled");
          return;
        }
        if (granting) return;
        granting = true;
        try {
          await api.grantCoworkFolder(
            path,
            choice === "always" ? "always" : "session",
            target,
          );
        } catch (error) {
          granting = false;
          // Errors reach the dialog, which stays open to show them; a
          // request no longer shown ends as cancelled instead.
          if (current !== request || !hosts.length) settle("cancelled");
          throw error;
        }
        granting = false;
        if (!settled) settle("granted");
      },
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      return;
    }
    publish(request);
  });
}

/**
 * The request the dialog should show now, if any; the caller hosts the
 * dialog. With more than one host mounted, only the oldest shows it.
 */
export function useFolderAccessRequest(): FolderAccessRequest | undefined {
  const [host] = useState(() => ({}));
  useEffect(() => {
    hosts = [...hosts, host];
    publish(current);
    return () => {
      hosts = hosts.filter((value) => value !== host);
      if (!hosts.length) current?.answer("cancel").catch(() => undefined);
      else publish(current);
    };
  }, [host]);
  return useSyncExternalStore(
    subscribe,
    () => (hosts[0] === host ? current : undefined),
    () => undefined,
  );
}

/** Whether an error is the main process refusing an unallowed Cowork folder. */
export function isFolderPermissionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes(coworkFolderPermissionMessage);
}

/** The dialog's body lines for a folder on a platform. */
export function folderAccessCopy(
  access: Pick<CoworkFolderAccess, "home">,
  platform: string,
) {
  return {
    body:
      platform === "win32"
        ? "Claudex can read these files and ask before changing them."
        : "Claudex can read, edit, and delete these files, run commands in this folder, and share them with connected tools.",
    note: "Files Claudex reads are sent to your model service.",
    ...(access.home
      ? {
          warning:
            "This is your home folder. Claudex could change any file in it.",
        }
      : {}),
  };
}

/** For tests: forgets hosts and any waiting request. */
export function resetFolderAccessForTests(mountedHosts = 0) {
  hosts = Array.from({ length: mountedHosts }, () => ({}));
  current = undefined;
  listeners.clear();
}

/** For tests: the request waiting now. */
export function pendingFolderAccess() {
  return current;
}
