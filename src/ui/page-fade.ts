import { useLayoutEffect, useRef, type RefObject } from "react";

/*
 * A page fading in when the workspace switches pages: claude.ai's own
 * cvc-fade-in-flat (opacity 0 → 1) at its base duration and ease-out. Opacity
 * only: a transform would move the page's fixed and sticky children while it
 * ran.
 */
export const PAGE_FADE_MS = 200;
export const PAGE_FADE_EASING = "cubic-bezier(.165, .84, .44, 1)";
/** How new a conversation is when a new chat's first send opens it. */
const FRESH_MS = 15_000;

export function reducedMotion(): boolean {
  return (
    document.documentElement.dataset.motion === "reduced" ||
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/** Fades the element in (opacity only, 200ms ease-out) unless motion is reduced. */
export function fadeIn(element: Element | null | undefined) {
  if (!element || typeof element.animate !== "function" || reducedMotion())
    return;
  element.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: PAGE_FADE_MS,
    easing: PAGE_FADE_EASING,
  });
}

/**
 * Fades the workspace's page in when the page or the conversation changes.
 * A new chat whose first message makes it a conversation (none → a
 * conversation just made) stays put: the home turns into it in place.
 */
export function usePageFade(
  container: RefObject<HTMLElement | null>,
  page: string,
  conversation: string | null,
  createdAt: number | undefined,
  enabled = true,
) {
  const last = useRef({ page, conversation });
  useLayoutEffect(() => {
    const before = last.current;
    last.current = { page, conversation };
    if (!enabled) return;
    const justMade =
      before.conversation === null &&
      createdAt !== undefined &&
      Date.now() - createdAt < FRESH_MS;
    const moved =
      before.page !== page ||
      (before.conversation !== conversation && !justMade);
    const box = container.current;
    if (!moved || !box) return;
    if (box.firstElementChild) return fadeIn(box.firstElementChild);
    // A page still loading (its chunk) fades in when it arrives.
    const watch = new MutationObserver(() => {
      if (!box.firstElementChild) return;
      watch.disconnect();
      fadeIn(box.firstElementChild);
    });
    watch.observe(box, { childList: true });
    const stop = window.setTimeout(() => watch.disconnect(), 3000);
    return () => {
      watch.disconnect();
      window.clearTimeout(stop);
    };
  }, [page, conversation, enabled]);
}
