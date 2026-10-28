import { useEffect, useMemo, useState } from "react";
import type { Conversation } from "../../shared/types";
import type { GitHubReviewThread } from "../../shared/github-api";
import { sessionPullRequest } from "../../shared/pull-request";
import { api } from "../desktop-api";

/**
 * The review threads of the session's pull request, for the Changes panel
 * (desktop: read with `gh`). Read again when a turn starts or ends, and
 * after a reply or a resolve.
 */
export function useReviewThreads(conversation: Conversation, enabled: boolean) {
  const ref = useMemo(
    () => sessionPullRequest(conversation),
    [conversation.turns],
  );
  const latest = conversation.turns.at(-1);
  const stamp = `${latest?.id}:${latest?.status}`;
  const [threads, setThreads] = useState<GitHubReviewThread[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled || !ref || ref.host !== "github.com") {
      setThreads([]);
      return;
    }
    let live = true;
    Promise.resolve()
      .then(() =>
        api.githubReviewThreads({
          repository: ref.repository,
          number: ref.number,
        }),
      )
      .then(
        (next) => live && setThreads(next ?? []),
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [enabled, ref?.url, stamp, tick]);
  return { threads, reload: () => setTick((n) => n + 1) };
}

/** The element id of a thread's card, for Previous / Next comment. */
export const threadElementId = (id: string) =>
  `review-thread-${id.replace(/[^A-Za-z0-9_-]/g, "")}`;
