import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../desktop-api";
import type { Conversation } from "../../shared/types";
import type { CodeGitStatus } from "../../shared/panels-api";
import { sessionPullRequest } from "../../shared/pull-request";
import { usePullRequest } from "./pr-status-store";

/** How often an unfinished pull request is asked about while the window shows. */
const pollMs = 60_000;

/**
 * What the Code session's branch row knows: the folder's branch
 * (`codeGitStatus`), the pull request the session made (its address, from
 * Claude's `<pr-created>` reply) and that request's state on GitHub (the
 * shared store the sidebar reads too). Each is read again when a turn
 * settles, when the window is focused again, and (the request) once a
 * minute while it can still change.
 */
export function useBranchRow(conversation: Conversation | undefined) {
  const id = conversation?.id;
  const enabled = Boolean(
    conversation && conversation.mode === "code" && !conversation.incognito,
  );
  const latest = conversation?.turns.at(-1);
  // A new read starts when a turn starts or settles, not as its output streams.
  const stamp = `${latest?.id}:${latest?.status}`;
  const [status, setStatus] = useState<CodeGitStatus>();
  const ref = useMemo(
    () => (conversation ? sessionPullRequest(conversation) : undefined),
    [conversation?.turns],
  );
  // Only the newest read may fill the row.
  const gitRequest = useRef(0);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  const { pr, problem } = usePullRequest(enabled ? ref : undefined, {
    maxAge: 0,
    pollMs,
    tick: `${stamp}:${tick}`,
  });

  useEffect(() => {
    setStatus(undefined);
  }, [id]);

  useEffect(() => {
    if (!enabled || !id) return;
    const request = ++gitRequest.current;
    // A window whose bridge lacks the call reads as no branch, not a crash.
    Promise.resolve()
      .then(() => api.codeGitStatus(id))
      .then(
        (next) => {
          if (request === gitRequest.current) setStatus(next);
        },
        () => {
          if (request === gitRequest.current) setStatus(undefined);
        },
      );
  }, [enabled, id, stamp, tick]);

  // Coming back to the window reads both again.
  useEffect(() => {
    if (!enabled) return;
    const again = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [enabled, refresh]);

  return {
    enabled,
    status,
    ref,
    pr: ref?.host === "github.com" ? pr : undefined,
    problem: ref?.host === "github.com" ? problem : undefined,
    refresh,
  };
}
