import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Conversation, Mode } from "../../shared/types";

/**
 * The jump-to-latest button shows once the end of the transcript is this far
 * below the viewport, which ends at the composer's top edge (source: desktop
 * bundle 2.31226.1: an observer on the content end with a 200px margin, less
 * the bottom overlay's height); less than that does not count as reading.
 */
export const jumpThreshold = 200;
export function showsJumpToLatest(el: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}) {
  return el.scrollHeight - el.scrollTop - el.clientHeight > jumpThreshold;
}

/** How long the glide to a just-sent prompt may take before following jumps again. */
const smoothScrollMs = 600;

/** Keeps the end of the transcript in view while it is followed. */
export function useTranscriptScroll(
  viewport: RefObject<HTMLDivElement | null>,
  follow: RefObject<boolean>,
  conversation: Conversation | undefined,
  mode: Mode,
) {
  const previousScroll = useRef(0);
  /** Until when a smooth scroll to a just-sent prompt is running (ms, performance.now). */
  const smoothUntil = useRef(0);
  const previous = useRef({ conversation: "", turns: 0 });
  const latestState = useRef({ conversation, mode });
  latestState.current = { conversation, mode };
  const [away, setAway] = useState(false);
  const updateAway = () => {
    const el = viewport.current;
    if (el) setAway(showsJumpToLatest(el));
  };

  /**
   * Following, the transcript keeps its end in view: scrolled to the bottom,
   * the latest output sits just above the composer, with no room reserved below
   * it. A sent prompt glides there.
   */
  function align(sent = false) {
    const el = viewport.current;
    const state = latestState.current;
    if (!el || !state.conversation) return;
    if (!follow.current) return;
    const target = Math.max(0, el.scrollHeight - el.clientHeight);
    const reduced =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (sent && state.mode === "chat" && !reduced)
      smoothUntil.current = performance.now() + smoothScrollMs;
    if (!reduced && performance.now() < smoothUntil.current) {
      if (Math.abs(el.scrollTop - target) > 0.5)
        el.scrollTo({ top: target, behavior: "smooth" });
    } else el.scrollTop = target;
    previousScroll.current = el.scrollTop;
  }

  useLayoutEffect(() => {
    const id = conversation?.id ?? "";
    const turns = conversation?.turns.length ?? 0;
    const newTurn =
      id !== previous.current.conversation || turns > previous.current.turns;
    if (newTurn) follow.current = true;
    previous.current = { conversation: id, turns };
    align(
      newTurn &&
        mode === "chat" &&
        conversation?.turns.at(-1)?.status === "inProgress",
    );
    updateAway();
  }, [conversation, mode]);

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    // The viewport resizing or the reply growing (an image loading) keeps a
    // followed end in view.
    const observer = new ResizeObserver(() => {
      align();
      updateAway();
    });
    observer.observe(el);
    const messages = el.querySelector(".messages");
    if (messages && mode === "chat") observer.observe(messages);
    return () => observer.disconnect();
  }, [conversation?.id, mode]);

  return {
    /** The end of the transcript is out of view, so the button shows. */
    away,
    /** Scrolls to the end and resumes following new output. */
    jumpToLatest() {
      const el = viewport.current;
      if (!el) return;
      follow.current = true;
      const reduced =
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
        false;
      el.scrollTo({
        top: el.scrollHeight,
        behavior: reduced ? "auto" : "smooth",
      });
    },
    onWheel(event: { deltaY: number }) {
      if (event.deltaY < 0) follow.current = false;
    },
    onScroll() {
      const el = viewport.current;
      if (!el) return;
      if (mode !== "chat")
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 110;
      else if (el.scrollTop < previousScroll.current - 0.5)
        follow.current = false;
      else if (el.scrollHeight - el.scrollTop - el.clientHeight < 2)
        follow.current = true;
      previousScroll.current = el.scrollTop;
      updateAway();
    },
  };
}
