import { useEffect, useSyncExternalStore } from "react";
import { api } from "../desktop-api";
import type { GitHubProblem, GitHubPullRequest } from "../../shared/github-api";
import type { PullRequestRef } from "../../shared/pull-request";
import { pullRequestIsLive } from "../../shared/pull-request-status";

/**
 * What the window knows about the pull requests its Code sessions made: the
 * branch row and the sidebar's PR status read the same entry, so they never
 * disagree, and a request is asked about once however many places show it.
 * GitHub is asked through `githubPullRequest` (the machine's `gh` on the
 * desktop, the service on the web), at most three at a time.
 */
export interface PullRequestEntry {
  pr?: GitHubPullRequest;
  /** Why the last read failed; the last state shown may be out of date. */
  problem?: GitHubProblem;
  /** When the last read finished (0: never). */
  readAt: number;
}

const entries = new Map<string, PullRequestEntry>();
const listeners = new Set<() => void>();
const reading = new Map<string, Promise<void>>();
const queue: (() => void)[] = [];
let active = 0;
const maxActive = 3;

/** A request settled (merged or closed) while the window watched it. */
type SettledListener = (key: string, pr: GitHubPullRequest) => void;
const settledListeners = new Set<SettledListener>();

export const pullRequestKey = (
  ref: Pick<PullRequestRef, "repository" | "number">,
) => `${ref.repository.toLowerCase()}#${ref.number}`;

const empty: PullRequestEntry = { readAt: 0 };
/** Moves on with every change, for hooks that watch several entries. */
let version = 0;

function emit() {
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function pullRequestEntry(key: string): PullRequestEntry {
  return entries.get(key) ?? empty;
}

/** Puts a read (or a change's result) in, telling anyone watching. */
export function setPullRequestEntry(key: string, next: PullRequestEntry) {
  const before = entries.get(key)?.pr;
  entries.set(key, next);
  const after = next.pr;
  if (before && after && pullRequestIsLive(before) && !pullRequestIsLive(after))
    for (const listener of settledListeners) listener(key, after);
  emit();
}

/** Calls back when a watched request is merged or closed. */
export function onPullRequestSettled(listener: SettledListener) {
  settledListeners.add(listener);
  return () => {
    settledListeners.delete(listener);
  };
}

function slot(run: () => Promise<void>) {
  return new Promise<void>((resolve) => {
    const start = () => {
      active++;
      run().finally(() => {
        active--;
        resolve();
        queue.shift()?.();
      });
    };
    if (active < maxActive) start();
    else queue.push(start);
  });
}

/**
 * Asks GitHub about a request unless a read is already on its way. Only
 * github.com addresses are asked about. A read that fails keeps the last
 * state, with the problem beside it.
 */
export function readPullRequest(ref: PullRequestRef): Promise<void> {
  if (ref.host !== "github.com") return Promise.resolve();
  const key = pullRequestKey(ref);
  const pending = reading.get(key);
  if (pending) return pending;
  const read = slot(async () => {
    try {
      const result = await api.githubPullRequest({
        repository: ref.repository,
        number: ref.number,
      });
      const last = entries.get(key);
      setPullRequestEntry(key, {
        pr: result.pullRequest ?? last?.pr,
        ...(result.problem ? { problem: result.problem } : {}),
        readAt: Date.now(),
      });
    } catch {
      const last = entries.get(key);
      setPullRequestEntry(key, {
        ...(last?.pr ? { pr: last.pr } : {}),
        problem: "unavailable",
        readAt: Date.now(),
      });
    }
  }).finally(() => reading.delete(key));
  reading.set(key, read);
  return read;
}

/**
 * A request's entry, read when it is older than `maxAge` and again every
 * `pollMs` while it can still change and the window shows. `tick` asks
 * again at once when it changes (a turn settled, the window came back).
 */
export function usePullRequest(
  ref: PullRequestRef | undefined,
  options: { maxAge: number; pollMs?: number; tick?: unknown },
): PullRequestEntry {
  const key = ref ? pullRequestKey(ref) : "";
  const entry = useSyncExternalStore(
    subscribe,
    () => (key ? pullRequestEntry(key) : empty),
    () => empty,
  );
  const { maxAge, pollMs, tick } = options;
  const live = pullRequestIsLive(entry.pr);
  useEffect(() => {
    if (!ref || ref.host !== "github.com") return;
    if (Date.now() - pullRequestEntry(key).readAt >= maxAge)
      void readPullRequest(ref);
    if (!pollMs || !live) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void readPullRequest(ref);
    }, pollMs);
    return () => window.clearInterval(timer);
    // `ref` is named by its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, maxAge, pollMs, live, tick]);
  return entry;
}

/**
 * Several requests' entries (the session's earlier pull requests), each read
 * once when older than `maxAge`; no polling.
 */
export function usePullRequests(
  refs: readonly PullRequestRef[],
  maxAge: number,
): PullRequestEntry[] {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  const keys = refs.map(pullRequestKey).join(" ");
  useEffect(() => {
    for (const ref of refs)
      if (
        ref.host === "github.com" &&
        Date.now() - pullRequestEntry(pullRequestKey(ref)).readAt >= maxAge
      )
        void readPullRequest(ref);
    // `refs` is named by its keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, maxAge]);
  return refs.map((ref) => pullRequestEntry(pullRequestKey(ref)));
}

/** Test seam: forgets everything. */
export function resetPullRequestStore() {
  entries.clear();
  reading.clear();
  queue.length = 0;
  active = 0;
  emit();
}
