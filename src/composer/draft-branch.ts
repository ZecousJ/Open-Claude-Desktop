import { useSyncExternalStore } from "react";

/**
 * The branch a new worktree session starts from (the folder menu's Branch
 * while Worktree is on), for the folder it was picked in. Without Worktree
 * picking a branch checks it out instead, so nothing is kept here.
 */
let picked: { folder: string; branch: string } | undefined;
const listeners = new Set<() => void>();

export function setDraftBranch(folder: string, branch: string | undefined) {
  picked = branch ? { folder, branch } : undefined;
  for (const listener of listeners) listener();
}

/** The picked start branch for `folder`, if any. */
export function draftBranchFor(folder: string | undefined) {
  return folder && picked?.folder === folder ? picked.branch : undefined;
}

export function useDraftBranch(folder: string | undefined) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => draftBranchFor(folder),
  );
}
