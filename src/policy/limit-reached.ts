import { useEffect, useReducer, useState } from "react";
import type { WeeklyUsageStatus } from "../../shared/types";

/**
 * The limit-hit dialog: once a limit refuses requests and this account has a
 * way to keep working, a dialog says so once for that limit window. Its key
 * names the window; nothing when there is nothing to offer (the usage notice
 * already says the limit was hit).
 */
export function limitDialogKey(
  status: WeeklyUsageStatus | null | undefined,
  canAddFunds: boolean,
): string | null {
  if (!status || status.state !== "exceeded") return null;
  const addFunds = canAddFunds && status.reason === "balance";
  if (!addFunds && !status.moreUsageUrl) return null;
  return `${status.reason ?? "weekly"}:${status.resetsAt}`;
}

const storageKey = "claudex.limitDialogSeen";

function readSeen() {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

let seen: string | null = readSeen();
// Several composers can be mounted at once: the first to want the dialog
// shows it.
let owner: symbol | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

/** Whether this mount shows the dialog for `key`, and closing it for good. */
export function useLimitDialog(key: string | null) {
  const [id] = useState(() => Symbol("limit-dialog"));
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    listeners.add(rerender);
    return () => {
      listeners.delete(rerender);
      if (owner === id) {
        owner = null;
        notify();
      }
    };
  }, [id]);
  const wanted = !!key && key !== seen;
  useEffect(() => {
    if (wanted && owner === null) {
      owner = id;
      notify();
    }
  });
  return {
    open: wanted && owner === id,
    close: () => {
      seen = key;
      try {
        if (key) localStorage.setItem(storageKey, key);
      } catch {
        // Shown again after a restart, no more.
      }
      owner = null;
      notify();
    },
  };
}

/** Tests only: forget what was shown. */
export function resetLimitDialog() {
  seen = null;
  owner = null;
}
