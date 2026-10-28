/**
 * The SSH dialog on screen, if any. The environment menu and Settings open
 * them here; the window-level overlay (ssh.slot.tsx) draws them, so they
 * sit above Settings and outside the composer's layout.
 */
import { useSyncExternalStore } from "react";
import type { SshHost } from "../../shared/ssh-api";
import type { SshLinkTarget } from "../../shared/ssh-links";

export type SshDialog =
  | { kind: "tools" }
  | { kind: "link"; target: SshLinkTarget }
  /** Add a host, or edit one. `select` makes a new host the Code environment. */
  | { kind: "host"; host?: SshHost; select?: boolean }
  /** Choose a working folder on a host. */
  | {
      kind: "folder";
      hostId: string;
      onChoose?: (path: string) => Promise<void>;
    };

let dialog: SshDialog | undefined;
const listeners = new Set<() => void>();

export function openSshDialog(next: SshDialog | undefined) {
  dialog = next;
  listeners.forEach((listener) => listener());
}

export const closeSshDialog = () => openSshDialog(undefined);

export function hasSshDialog() {
  return dialog !== undefined;
}

export function useSshDialog() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => dialog,
    () => dialog,
  );
}
