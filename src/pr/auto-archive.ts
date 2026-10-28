import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Conversation, Settings } from "../../shared/types";
import { preference } from "../../shared/settings-extras";
import { sessionPullRequest } from "../../shared/pull-request";
import { onPullRequestSettled, pullRequestKey } from "./pr-status-store";

/**
 * Auto-archive on merge or close: a Code session is archived once the pull
 * request it made is merged or closed. Settings → Claude Code → Auto-archive
 * after PR merge or close is the default; the CI popover's switch sets one
 * session apart. That choice is this window's (kept in local storage), as the
 * original keeps it per session. Only a change the window sees (a request read
 * as open, then as merged or closed) archives, so turning the setting on never
 * archives old sessions at once.
 */
const storageKey = "claudex.prAutoArchive";
const listeners = new Set<() => void>();
let cache: Record<string, boolean> | undefined;

function read(): Record<string, boolean> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    cache =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, boolean>)
        : {};
  } catch {
    cache = {};
  }
  return cache;
}

/** The session's own choice, or undefined to follow the setting. */
export function sessionAutoArchive(id: string): boolean | undefined {
  const value = read()[id];
  return typeof value === "boolean" ? value : undefined;
}

export function setSessionAutoArchive(id: string, value: boolean) {
  cache = { ...read(), [id]: value };
  try {
    localStorage.setItem(storageKey, JSON.stringify(cache));
  } catch {
    // Kept for this window only.
  }
  for (const listener of listeners) listener();
}

export function autoArchiveOn(id: string, settings: Settings | undefined) {
  return (
    sessionAutoArchive(id) ??
    (settings ? preference(settings, "prAutoArchive") : false)
  );
}

/** The session's switch, following later changes. */
export function useAutoArchive(id: string, settings: Settings | undefined) {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => sessionAutoArchive(id),
    () => undefined,
  );
  return autoArchiveOn(id, settings);
}

/**
 * Archives the sessions whose pull request the window saw merge or close,
 * when auto-archive is on for them. Mounted once with the sidebar.
 */
export function usePullRequestAutoArchive(
  conversations: Conversation[],
  settings: Settings | undefined,
  /** `merged`: the pull request merged (else it closed). */
  archive: (c: Conversation, merged: boolean) => void,
) {
  // A choice Claude made for a session (set_pr_monitor) becomes the
  // session's own switch here.
  useEffect(() => {
    for (const c of conversations)
      if (
        typeof c.prAutoArchive === "boolean" &&
        sessionAutoArchive(c.id) !== c.prAutoArchive
      )
        setSessionAutoArchive(c.id, c.prAutoArchive);
  }, [conversations]);
  const latest = useRef({ conversations, settings, archive });
  latest.current = { conversations, settings, archive };
  useEffect(
    () =>
      onPullRequestSettled((key, pr) => {
        const { conversations, settings, archive } = latest.current;
        for (const c of conversations) {
          if (c.mode !== "code" || c.archived || c.incognito) continue;
          const ref = sessionPullRequest(c);
          if (
            ref &&
            pullRequestKey(ref) === key &&
            autoArchiveOn(c.id, settings)
          )
            archive(c, pr.state === "merged");
        }
      }),
    [],
  );
}
