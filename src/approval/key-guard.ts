import { useCallback, useEffect, useRef } from "react";

/**
 * How long after a card appears, or the window regains focus, its keys stay
 * inert.
 */
export const ARM_GRACE_MS = 400;

/** When the things that make a decision key suspect last happened (ms, Date.now()). */
export interface KeyGuardState {
  /** The card started listening: it appeared or became the frontmost one. */
  armedAt: number;
  /** The last keystroke that was not a modifier, a repeat or a decision key. */
  typedAt: number;
  /** The window last regained focus. */
  focusedAt: number;
}

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

/** Whether a key press is the card's ⌘↩ / ⇧⌘↩ (those never count as typing). */
function isDecisionChord(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">,
) {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}

/** Focus is on the page itself, inside the card, or in the conversation's composer. */
function focusBelongsToCard(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el || el.tagName === "BODY" || el.tagName === "HTML") return true;
  return Boolean(el.closest?.(".approval-card, .composer-wrap"));
}

/**
 * Whether a key that would answer the card may do so now, or is swallowed: a
 * held key never acts (a repeat that outlives one card must not answer the
 * next), nothing acts within 400ms of the card appearing or the window
 * regaining focus, and ⌘↩ does not act within 400ms of the last keystroke
 * outside the card or while focus sits in a field outside the card and the
 * composer.
 */
export function guardApprovalKey(
  event: Pick<
    KeyboardEvent,
    "key" | "repeat" | "metaKey" | "ctrlKey" | "target"
  >,
  state: KeyGuardState,
  now: number,
): "act" | "swallow" {
  if (event.repeat) return "swallow";
  if (now - Math.max(state.armedAt, state.focusedAt) < ARM_GRACE_MS)
    return "swallow";
  if (event.key === "Enter") {
    // Typing in the card's own field (an answer, a revision) is deliberate.
    const own = (event.target as HTMLElement | null)?.closest?.(
      ".approval-card",
    );
    if (!own && now - state.typedAt < ARM_GRACE_MS) return "swallow";
    if (!focusBelongsToCard(event.target)) return "swallow";
  }
  return "act";
}

/**
 * The guard's clock for one card: reset whenever `enabled` turns on (the card
 * appeared, or an earlier one was answered and this one came to the front),
 * when the window regains focus, and on every keystroke that is not a
 * modifier or a decision key. `check` is asked by the card's own key handler
 * for a key that would answer it.
 */
export function useKeyGuard(enabled: boolean) {
  const state = useRef<KeyGuardState>({
    armedAt: Date.now(),
    typedAt: -Infinity,
    focusedAt: -Infinity,
  });
  useEffect(() => {
    if (enabled) state.current.armedAt = Date.now();
  }, [enabled]);
  useEffect(() => {
    const onFocus = () => {
      state.current.focusedAt = Date.now();
    };
    const onKey = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        event.isComposing ||
        MODIFIERS.has(event.key) ||
        isDecisionChord(event)
      )
        return;
      state.current.typedAt = Date.now();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);
  return useCallback(
    (event: KeyboardEvent) =>
      guardApprovalKey(event, state.current, Date.now()),
    [],
  );
}
