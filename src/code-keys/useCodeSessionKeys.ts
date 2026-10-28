import { useEffect, useRef, type RefObject } from "react";
import type { Conversation } from "../../shared/types";
import { splitState } from "../split-view/split-state";
import { prefersReducedMotion } from "../ui/usePresence";
import {
  codeSessionKey,
  promptJumpTarget,
  type PromptPlace,
} from "./code-session-keys";
import { flashJumpTarget } from "./jump-flash";

/** A jump lands its prompt this far below the transcript's top (the bundle's 20px). */
const LANDING_OFFSET = 20;
/** Within this many px of the end the transcript is at the bottom (the bundle's 12px). */
const BOTTOM_SLACK = 12;
/** The prompt a jump landed on steers the next press for this long (the bundle's 1500ms). */
const ANCHOR_MS = 1500;
const modifierKeys = new Set(["Alt", "AltGraph", "Control", "Meta", "Shift"]);

/**
 * Whether an element is in the pane that has the focus: the primary pane
 * when the window is not split, else the pane split view marks focused.
 */
export function inFocusedPane(element: Element | null) {
  const pane = element?.closest("[data-pane-index]");
  if (!pane) return true;
  return Number(pane.getAttribute("data-pane-index")) === splitState().focus;
}

/** A text field, list box or app-like widget other than the composer. */
function typingElsewhere(
  target: EventTarget | null,
  composer: HTMLElement | null,
) {
  if (!(target instanceof Element)) return false;
  if (composer && (target === composer || composer.contains(target)))
    return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="application"]',
    ),
  );
}

/** The transcript's prompts, each with its bubble (rows match turns by index). */
function promptPlaces(scroller: HTMLElement, conversation: Conversation) {
  const rows = scroller.querySelectorAll(":scope > .messages > .turn");
  const places: (PromptPlace & { bubble: Element | null })[] = [];
  conversation.turns.forEach((turn, index) => {
    if (turn.compaction || !turn.prompt.trim()) return;
    const bubble = rows[index]?.querySelector(":scope > .user-message") ?? null;
    places.push({
      id: turn.id,
      index,
      top: bubble ? bubble.getBoundingClientRect().top : null,
      bubble,
    });
  });
  return places;
}

/**
 * A Code session's own keys: Ctrl+O cycles the transcript view, ⌥⌘↑ / ⌥⌘↓
 * (Alt+↑ / Alt+↓ outside macOS) jump to the previous and next prompt, landing
 * it 20px under the top with the jump flash. Only the focused pane answers;
 * nothing happens under a dialog. The jump keys are left to other text fields
 * (the composer keeps them), and a held key acts once.
 */
export function useCodeSessionKeys({
  enabled,
  mac,
  conversation,
  scrollRef,
  composer,
  onCycleView,
}: {
  enabled: boolean;
  mac: boolean;
  conversation: Conversation;
  scrollRef: RefObject<HTMLDivElement | null>;
  composer: RefObject<HTMLElement | null>;
  onCycleView: () => void;
}) {
  const latest = useRef({ mac, conversation, onCycleView });
  latest.current = { mac, conversation, onCycleView };
  const anchor = useRef<{ id: string; at: number } | null>(null);
  useEffect(() => {
    anchor.current = null;
  }, [conversation.id]);

  useEffect(() => {
    if (!enabled) return;
    const clearAnchor = () => {
      anchor.current = null;
    };
    const jump = (direction: "previous" | "next") => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const places = promptPlaces(scroller, latest.current.conversation);
      if (!places.length) return;
      const viewportTop = scroller.getBoundingClientRect().top;
      const held =
        anchor.current && performance.now() - anchor.current.at <= ANCHOR_MS
          ? anchor.current.id
          : null;
      const target = promptJumpTarget(places, direction, {
        viewportTop,
        landingOffset: LANDING_OFFSET,
        atBottom:
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <=
          BOTTOM_SLACK,
        anchor: held,
      });
      const bubble = target && places.find((p) => p.id === target.id)?.bubble;
      if (!target || !bubble) return;
      anchor.current = { id: target.id, at: performance.now() };
      scroller.scrollTo({
        top:
          scroller.scrollTop +
          bubble.getBoundingClientRect().top -
          viewportTop -
          LANDING_OFFSET,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
      flashJumpTarget(bubble);
    };
    const onKey = (event: KeyboardEvent) => {
      const command = codeSessionKey(event, latest.current.mac);
      if (!command) {
        if (!modifierKeys.has(event.key)) clearAnchor();
        return;
      }
      if (
        event.defaultPrevented ||
        event.isComposing ||
        !inFocusedPane(scrollRef.current) ||
        document.querySelector('[role="dialog"]')
      )
        return;
      if (
        command !== "cycle-transcript-view" &&
        typingElsewhere(event.target, composer.current)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (command === "cycle-transcript-view") latest.current.onCycleView();
      else jump(command === "jump-previous-prompt" ? "previous" : "next");
    };
    const scroller = scrollRef.current;
    const passive = { capture: true, passive: true } as const;
    window.addEventListener("keydown", onKey, true);
    scroller?.addEventListener("wheel", clearAnchor, passive);
    scroller?.addEventListener("touchmove", clearAnchor, passive);
    scroller?.addEventListener("pointerdown", clearAnchor, passive);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      scroller?.removeEventListener("wheel", clearAnchor, passive);
      scroller?.removeEventListener("touchmove", clearAnchor, passive);
      scroller?.removeEventListener("pointerdown", clearAnchor, passive);
    };
  }, [enabled, scrollRef, composer]);
}
