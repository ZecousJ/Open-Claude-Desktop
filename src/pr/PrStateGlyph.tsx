import {
  CircleCheck,
  CircleX,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  ListOrdered,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { PullRequestDisplayState } from "../../shared/pull-request-status";

/**
 * Each pull request state's glyph (Lucide), drawn bold at the branch row's
 * 16px and the sidebar row's 14px.
 */
const stateGlyph: Record<
  Exclude<PullRequestDisplayState, "none">,
  LucideIcon
> = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  approved: CircleCheck,
  changesRequested: CircleX,
  conflicting: TriangleAlert,
  queued: ListOrdered,
  merged: GitMerge,
  closed: GitPullRequestClosed,
};

export function PrStateGlyph({
  state,
  size = 16,
}: {
  state: Exclude<PullRequestDisplayState, "none">;
  size?: 14 | 16;
}) {
  const Icon = stateGlyph[state];
  return (
    <Icon
      className="pr-state-glyph"
      data-state={state}
      size={size}
      strokeWidth={2}
      aria-hidden="true"
    />
  );
}

/** The CI popover's 12px check glyphs: passed and failed. */
export function CheckGlyph({ result }: { result: "passed" | "failed" }) {
  const Icon = result === "passed" ? CircleCheck : CircleX;
  return (
    <Icon
      className="pr-check-glyph"
      data-result={result}
      size={12}
      strokeWidth={2}
      aria-hidden="true"
    />
  );
}
