import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/*
 * Where keyboard focus goes when the front request in the composer dock is
 * answered.
 *
 * - Focus moves on only when the card was answered from the keyboard: focus sat
 *   inside it and the last key press came after the last pointer press in it. A
 *   mouse decision leaves focus alone.
 * - The next request, if any, takes focus on the card itself (not one of its
 *   buttons), with the keyboard ring; Enter there moves on to its primary
 *   button. Enter within 400ms of a card going, or held, is swallowed so one
 *   press never answers two cards.
 * - With no request left, focus goes back to the composer, and ⌘↩ (Ctrl+↩)
 *   within 400ms of that is swallowed so the press that answered the card does
 *   not also send the draft.
 *
 * The original also hands focus between a card in the transcript and its docked
 * copy (`data-approval-docks`, `data-approval-awaits-dock`); Claudex shows a
 * request only in the dock, so that half has nothing to act on.
 */

/** Keys the original's hand-off ignores as "typing". */
const MODIFIERS = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Meta",
  "Shift",
]);

/** How long after a card goes, or after focus went back to the composer, Enter / ⌘↩ are swallowed. */
export const HANDOFF_GRACE_MS = 400;

/** Marks a card root that was handed focus; cleared once focus leaves it. */
export const HANDED_FOCUS_ATTR = "data-handed-focus";

export interface HandoffState {
  /** Focus is (or last was) inside the front card. */
  inside: boolean;
  /** The last key press that was not a modifier or a repeat (performance.now()). */
  keyAt: number;
  /** The last real pointer press inside the dock. */
  pressedAt: number;
  /** The last time a front card went. */
  wentAt: number;
  /** The last time focus was handed back to the composer. */
  composerAt: number;
}

export const initialHandoff = (): HandoffState => ({
  inside: false,
  keyAt: -Infinity,
  pressedAt: -Infinity,
  wentAt: -Infinity,
  composerAt: -Infinity,
});

/** Whether a card that just went was answered from the keyboard, so focus moves on. */
export function handsFocus(state: HandoffState) {
  return state.inside && state.pressedAt <= state.keyAt;
}

/** A pointer event the browser made up for a key press (a button's Enter or Space). */
export function syntheticPointer(
  event: Pick<PointerEvent, "pointerType" | "width" | "height">,
) {
  return event.pointerType !== "touch" && !event.width && !event.height;
}

export type HandoffKey =
  /** Swallow it: preventDefault and stop it reaching the composer or the card. */
  | "swallow"
  /** Move focus from the handed card root to its primary button. */
  | "primary"
  | undefined;

/**
 * What a key does around a hand-off: ⌘↩ right after focus went back to the
 * composer, and Enter on a card root that was handed focus.
 */
export function handoffKey(
  event: Pick<
    KeyboardEvent,
    "key" | "repeat" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
  onHandedCard: boolean,
  state: HandoffState,
  now: number,
): HandoffKey {
  if (event.key !== "Enter") return;
  const mod = event.metaKey || event.ctrlKey;
  if (mod && now - state.composerAt < HANDOFF_GRACE_MS) return "swallow";
  if (!onHandedCard) return;
  if (now - state.wentAt < HANDOFF_GRACE_MS) return "swallow";
  // ⌘↩ and friends stay the card's own shortcuts.
  if (mod) return;
  return event.repeat || event.altKey || event.shiftKey ? "swallow" : "primary";
}

/** Focuses a card root with the keyboard ring until focus moves elsewhere. */
function focusCard(card: HTMLElement) {
  const doc = card.ownerDocument;
  const release = (event?: FocusEvent) => {
    if (event?.target === card) return;
    card.removeAttribute("tabindex");
    card.removeAttribute(HANDED_FOCUS_ATTR);
    doc.removeEventListener("focusin", release, true);
  };
  card.setAttribute("tabindex", "-1");
  card.setAttribute(HANDED_FOCUS_ATTR, "");
  doc.addEventListener("focusin", release, true);
  // focusVisible: the ring shows although no key moved focus (Chromium).
  card.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
  if (doc.activeElement !== card) release();
}

/**
 * Wires the hand-off for the dock's request stack. `frontId` is the request
 * shown as the card; when it changes within one conversation because the
 * front request was answered, focus moves on as described above.
 */
export function useApprovalFocusHandoff({
  stackRef,
  conversationId,
  frontId,
  pendingIds,
  onFocusComposer,
}: {
  stackRef: RefObject<HTMLElement | null>;
  conversationId: string;
  frontId: string | number | undefined;
  pendingIds: readonly (string | number)[];
  onFocusComposer: () => void;
}) {
  const state = useRef<HandoffState>(initialHandoff());
  const previous = useRef<{
    conversationId: string;
    frontId?: string | number;
  }>({
    conversationId,
    frontId,
  });
  const focusComposer = useRef(onFocusComposer);
  focusComposer.current = onFocusComposer;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const now = performance.now();
      if (!event.repeat && !MODIFIERS.has(event.key)) state.current.keyAt = now;
      const target = event.target as HTMLElement | null;
      const onHandedCard = Boolean(
        target?.hasAttribute?.(HANDED_FOCUS_ATTR) &&
        stackRef.current?.contains(target),
      );
      const action = handoffKey(event, onHandedCard, state.current, now);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === "primary")
        target
          ?.querySelector<HTMLButtonElement>(
            "button[data-primary]:not(:disabled):not([aria-disabled='true'])",
          )
          ?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [stackRef]);

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { conversationId, frontId };
    if (
      before.conversationId !== conversationId ||
      before.frontId === undefined ||
      before.frontId === frontId ||
      pendingIds.includes(before.frontId)
    )
      return;
    // The front request was answered.
    const now = performance.now();
    const active = document.activeElement;
    const handing =
      handsFocus(state.current) &&
      document.hasFocus() &&
      // The answered card took its focus with it; focus anywhere else stays.
      (!active ||
        active === document.body ||
        Boolean(stackRef.current?.contains(active)));
    state.current.wentAt = now;
    state.current.inside = false;
    if (!handing) return;
    const card =
      frontId !== undefined
        ? stackRef.current?.querySelector<HTMLElement>(".approval-card")
        : undefined;
    if (card) return void focusCard(card);
    (document.activeElement as HTMLElement | null)?.blur?.();
    focusComposer.current();
    state.current.composerAt = now;
  });

  /** Spread on the stack element: tracks focus and pointer presses inside it. */
  return {
    onFocus: () => {
      state.current.inside = true;
    },
    onBlur: (event: { relatedTarget: EventTarget | null }) => {
      // Focus dropped to nothing (a pressed button turning disabled, the
      // window losing focus) still counts as inside the card.
      const next = event.relatedTarget as Node | null;
      if (next && !stackRef.current?.contains(next))
        state.current.inside = false;
    },
    onPointerDown: (event: {
      nativeEvent: Pick<PointerEvent, "pointerType" | "width" | "height">;
    }) => {
      if (!syntheticPointer(event.nativeEvent))
        state.current.pressedAt = performance.now();
    },
  };
}
