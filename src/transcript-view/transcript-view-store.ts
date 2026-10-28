import { createContext, useContext, useSyncExternalStore } from "react";
import { onForgetAccountData } from "../app/forget-account-data";
import {
  isTranscriptView,
  type TranscriptView,
} from "../../shared/transcript-view";

/*
 * Each Code session's own transcript view, kept on this device as the original
 * keeps it. A session without a pick of its own follows Settings → Default
 * transcript view.
 */

const viewsKey = "claudex.transcriptView.v1";
const nudgeKey = "claudex.transcriptViewNudge.v1";
/** At most this many sessions keep a view of their own (the bundle's 100). */
export const transcriptViewSessionLimit = 100;

type Views = Record<string, TranscriptView>;

let views: Views | undefined;
const listeners = new Set<() => void>();

function read(): Views {
  if (views) return views;
  views = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(viewsKey) ?? "{}");
    if (parsed && typeof parsed === "object")
      for (const [id, view] of Object.entries(parsed))
        if (isTranscriptView(view)) views[id] = view;
  } catch {
    /* No storage: every session follows the default. */
  }
  return views;
}

function write(next: Views) {
  views = next;
  try {
    localStorage.setItem(viewsKey, JSON.stringify(next));
  } catch {
    /* Kept for this window only. */
  }
  for (const listener of listeners) listener();
}

/** The view picked for a session, if it has one of its own. */
export function pickedTranscriptView(
  conversationId: string,
): TranscriptView | undefined {
  return read()[conversationId];
}

/** The view a session shows: its own pick, else the default. */
export function transcriptViewFor(
  conversationId: string,
  fallback: TranscriptView,
): TranscriptView {
  return pickedTranscriptView(conversationId) ?? fallback;
}

/**
 * A session's pick from its menu or Ctrl+O. The newest picks are kept; the
 * oldest beyond the limit go back to the default.
 */
export function setTranscriptView(
  conversationId: string,
  view: TranscriptView,
) {
  const { [conversationId]: _old, ...rest } = read();
  const ids = Object.keys(rest);
  const kept = ids.slice(
    Math.max(0, ids.length - (transcriptViewSessionLimit - 1)),
  );
  write({
    ...Object.fromEntries(kept.map((id) => [id, rest[id]])),
    [conversationId]: view,
  });
}

/** Forgets every session's pick (tests; a signed-out window). */
export function resetTranscriptViews() {
  views = undefined;
}
onForgetAccountData(() => {
  resetTranscriptViews();
  for (const listener of listeners) listener();
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The session's view, following its pick and the default as they change. */
export function useTranscriptView(
  conversationId: string,
  fallback: TranscriptView,
): TranscriptView {
  const picked = useSyncExternalStore(
    subscribe,
    () => read()[conversationId],
    () => undefined,
  );
  return picked ?? fallback;
}

/*
 * "Make {mode} your default view?" (the bundle's default-transcript-view
 * nudge): picking the same view, other than the default, in a second
 * session offers to make it the default, once per view. Each view keeps the
 * session it was first picked in, or true once offered.
 */
type NudgeRecord = Partial<Record<TranscriptView, string | true>>;

function readNudges(): NudgeRecord {
  try {
    const parsed = JSON.parse(localStorage.getItem(nudgeKey) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeNudges(record: NudgeRecord) {
  try {
    localStorage.setItem(nudgeKey, JSON.stringify(record));
  } catch {
    /* Without storage the offer is not made. */
  }
}

/**
 * Notes a pick of `view` in a session; true when the nudge is due now (the
 * view was picked in another session before and has not been offered).
 */
export function noteTranscriptViewPick(
  view: TranscriptView,
  conversationId: string,
  defaultView: TranscriptView,
): boolean {
  if (view === defaultView) return false;
  const record = readNudges();
  const seen = record[view];
  if (seen === true || seen === conversationId) return false;
  if (seen === undefined) {
    writeNudges({ ...record, [view]: conversationId });
    return false;
  }
  return true;
}

/** The nudge for this view was shown (or the view became the default). */
export function markTranscriptViewNudged(view: TranscriptView) {
  const record = readNudges();
  if (record[view] !== true) writeNudges({ ...record, [view]: true });
}

/**
 * The view the transcript draws in (Code only; Chat and Cowork stay
 * Normal). Provided by the transcript host, read by the tool rows.
 */
export const TranscriptViewContext = createContext<TranscriptView>("normal");

export const useTranscriptViewContext = () => useContext(TranscriptViewContext);

/**
 * Verbose opens every tool row (the bundle forces its collapsibles open);
 * the other views leave each row as the person left it.
 */
export const verboseOpen = (view: TranscriptView) =>
  view === "verbose" ? true : undefined;
