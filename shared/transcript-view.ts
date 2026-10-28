/**
 * A Code session's transcript view. Normal folds runs of tool calls into one
 * row and keeps thinking in its "Thought process" step; Thinking lists every
 * step on its own and shows the thinking text in the transcript; Verbose does
 * that too and opens every tool row.
 */
export type TranscriptView = "normal" | "thinking" | "verbose";

/** The views in the menu's and Ctrl+O's order. */
export const transcriptViews: readonly TranscriptView[] = Object.freeze([
  "normal",
  "thinking",
  "verbose",
]);

/** Each view's name, as the menu and the notices say it. */
export const transcriptViewLabels: Record<TranscriptView, string> = {
  normal: "Normal",
  thinking: "Thinking",
  verbose: "Verbose",
};

export function isTranscriptView(value: unknown): value is TranscriptView {
  return (
    typeof value === "string" &&
    (transcriptViews as readonly string[]).includes(value)
  );
}

/**
 * The view a session shows: Thinking needs thinking to show, so without it
 * the session reads as Normal (the bundle's effectiveTranscriptMode).
 */
export function effectiveTranscriptView(
  view: TranscriptView,
  { thinking }: { thinking: boolean },
): TranscriptView {
  return view === "thinking" && !thinking ? "normal" : view;
}

/**
 * Ctrl+O: the next view after the one on screen, round to Normal after
 * Verbose; Thinking is skipped where it would read as Normal.
 */
export function nextTranscriptView(
  view: TranscriptView,
  options: { thinking: boolean },
): TranscriptView {
  const offered = transcriptViews.filter(
    (candidate) => effectiveTranscriptView(candidate, options) === candidate,
  );
  const index = offered.indexOf(effectiveTranscriptView(view, options));
  return offered[(index + 1) % offered.length];
}

/** Whether the view shows the thinking text in the transcript. */
export const showsThinking = (view: TranscriptView) =>
  view === "thinking" || view === "verbose";
