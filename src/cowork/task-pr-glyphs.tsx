import { GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";
import type { SessionPullRequestState } from "../../shared/types";

/** The task's pull request tile glyphs (Lucide). */
const icons = { GitPullRequest, GitMerge, GitPullRequestClosed } as const;

export function TaskPullRequestGlyph({
  state,
}: {
  state: SessionPullRequestState;
}) {
  const name =
    state === "queued" || state === "merged"
      ? "GitMerge"
      : state === "closed"
        ? "GitPullRequestClosed"
        : "GitPullRequest";
  const Icon = icons[name];
  return (
    <Icon size={20} strokeWidth={1.75} aria-hidden="true" data-icon={name} />
  );
}
