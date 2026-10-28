/**
 * Whether the desktop Code home starts its next session in the cloud
 * (docs/cloud-sync.md P4): Local ▾ › Cloud › Default switches the chips to
 * the repository picker, and the session runs on the user's runner with the
 * chosen GitHub repository, synced with the web. Leaving the cloud forgets
 * the chosen repository, so a local session never takes it.
 */
import { useSyncExternalStore } from "react";
import { setCodeRepository } from "./code-repository";

export const cloudCodeUnavailable =
  "Code in a cloud environment isn't available on the web yet";

let cloud = false;
const listeners = new Set<() => void>();

export function setCodeCloud(next: boolean) {
  if (next === cloud) return;
  cloud = next;
  if (!next) setCodeRepository(undefined);
  listeners.forEach((listener) => listener());
}

export const codeCloud = () => cloud;

export function useCodeCloud() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => cloud,
  );
}
