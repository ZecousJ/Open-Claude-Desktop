import type { Conversation } from "../../shared/types";
import {
  pullRequestRowLabel,
  type PullRequestDisplayState,
} from "../../shared/pull-request-status";

/** What a row's dot says, in words. */
export type RowStatus = {
  /** The dot's modifier class; "" is the idle ring. */
  dot: "attention" | "working" | "unread" | "";
  /** The name the dot carries for readers and its tooltip. */
  label: string;
  /** An archived row shows the Archive glyph instead of a dot. */
  archived: boolean;
  /**
   * Chat and Cowork rows (the original's enableMarkUnread): a click on the
   * dot marks the conversation read or unread, and the tooltip says so.
   */
  toggle?: { hint: string };
  /** A Code session shows its pull request's glyph instead of the dot. */
  pr?: Exclude<PullRequestDisplayState, "none">;
};

/** A Code session's pull request, while Show PR status is on. */
export type RowPullRequest = {
  state: PullRequestDisplayState;
  number: number;
};

export function rowStatus(
  c: Pick<Conversation, "mode" | "archived" | "unread" | "turns">,
  state: {
    working: boolean;
    needsApproval: boolean;
    /** The request is the agent's question, not a permission. */
    question: boolean;
  },
  pr?: RowPullRequest,
): RowStatus {
  if (c.archived) return { dot: "", label: "Archived", archived: true };
  const marks = c.mode !== "code";
  if (state.needsApproval)
    return {
      dot: "attention",
      label: state.question ? "Awaiting answer" : "Awaiting input",
      archived: false,
    };
  if (state.working)
    return { dot: "working", label: "Running", archived: false };
  // a Code session with a pull request shows its state; a merged or closed one
  // does so even over an unread reply, an open one gives way to it.
  const prState =
    c.mode === "code" && pr && pr.state !== "none" ? pr : undefined;
  const settled = prState?.state === "merged" || prState?.state === "closed";
  if (prState && (settled || !c.unread))
    return {
      dot: "",
      label: pullRequestRowLabel(prState.state, [prState.number]),
      archived: false,
      pr: prState.state as Exclude<PullRequestDisplayState, "none">,
    };
  if (c.unread)
    return {
      dot: "unread",
      label: "Unread response",
      archived: false,
      ...(marks ? { toggle: { hint: "Click to mark as read" } } : {}),
    };
  // A conversation that has answered at least once is Done, not Idle.
  const done = c.turns.length > 0;
  return {
    dot: "",
    label: marks && done ? "Done" : "Idle",
    archived: false,
    ...(marks && done ? { toggle: { hint: "Click to mark as unread" } } : {}),
  };
}
