/**
 * The sleep band's judgement. The main process says when the computer slept
 * (`slept` events); a window judges the sessions it shows.
 */
import type { Conversation, Turn } from "../../shared/types";

export interface Slept {
  suspendedAt: number;
  wakeAt: number;
}

let latest: Slept | undefined;
const listeners = new Set<() => void>();
/** The computer's latest sleep (from the main process's `slept` event). */
export function recordSleep(slept: Slept) {
  latest = slept;
  for (const listener of listeners) listener();
}
export const lastSleep = () => latest;
export function onSleep(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** What a turn has shown so far: a change means progress. */
export function turnProgress(turn: Turn) {
  const last = turn.items.at(-1) as { text?: string } | undefined;
  return `${turn.status}:${turn.items.length}:${last?.text?.length ?? 0}`;
}

/** Sleeps whose band was dismissed or answered, per session. */
const settled = new Set<string>();
const key = (conversationId: string, slept: Slept) =>
  `${conversationId}:${slept.suspendedAt}`;
export function settleSleep(conversationId: string, slept: Slept) {
  settled.add(key(conversationId, slept));
}

/**
 * What became of the session after waking: its last turn was running when the
 * computer slept; it picked up once it shows progress over what it showed when
 * the window learned of the sleep (`before`) or finished; it could not when it
 * ended in an error or showed nothing new for `resumeWindowMs` after waking.
 * Null when the sleep did not catch the session working, or its band was
 * settled.
 */
export type Resume = "expected" | "resumed" | "needed";
export const resumeWindowMs = 75_000;
export function sleepResume(
  conversation: Conversation,
  slept: Slept | undefined,
  before: string | undefined,
  now: number,
): Resume | null {
  if (!slept || settled.has(key(conversation.id, slept))) return null;
  if (conversation.mode !== "code") return null;
  if (
    conversation.environment?.kind === "space" ||
    conversation.environment?.kind === "ssh"
  )
    return null;
  const turn = conversation.turns.at(-1);
  if (!turn || turn.createdAt > slept.suspendedAt) return null;
  // An interrupted turn (the engine's teardown ends it so) shows the
  // "Session was interrupted" card, so the band cannot say it picked up.
  if (turn.status === "failed" || turn.status === "interrupted")
    return conversation.updatedAt >= slept.wakeAt ? "needed" : null;
  if (turn.status !== "inProgress")
    return conversation.updatedAt >= slept.wakeAt ? "resumed" : null;
  if (before !== undefined && before !== turnProgress(turn)) return "resumed";
  return now - slept.wakeAt >= resumeWindowMs ? "needed" : "expected";
}

/** What Claudex is told by Continue. */
export const continuePrompt =
  "My computer went to sleep while you were working. Please continue from where you left off.";

/** Legacy interrupted band, before the keep-awake rework. */
export function sleepTitle(keepAwakeRework: boolean, cloud: boolean) {
  return keepAwakeRework
    ? "Your computer went to sleep while Claudex was working."
    : cloud
      ? "Your computer went to sleep and paused this session."
      : "Claudex was interrupted when your computer went to sleep.";
}

export function awakeDuration(heldMs: number, locale: string) {
  const minutes = Math.max(1, Math.round(heldMs / 60_000));
  const number = (value: number, unit: string) =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit,
      unitDisplay: "short",
    }).format(value);
  return [
    minutes >= 60 ? number(Math.floor(minutes / 60), "hour") : "",
    minutes % 60 ? number(minutes % 60, "minute") : "",
  ]
    .filter(Boolean)
    .join(" ");
}
