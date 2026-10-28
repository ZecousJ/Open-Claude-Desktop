import {
  openTaskWindow,
  promptLink,
  setSpinOffMinimized,
  spinOffWindows,
  SPIN_OFF_SLOTS,
} from "./spin-off-store";

/** The page's own address, and claude.ai's: where a prompt link may point. */
const linkOrigins = () =>
  [globalThis.location?.origin, "https://claude.ai"].filter(
    (origin): origin is string => Boolean(origin),
  );

/** The address prompts that opened a window, by their words. */
const addressWindows = new Map<string, number>();

/**
 * The address's prompt (`/new?q=…`) on the Cowork home: a quick task window
 * with the words, marked as coming from outside, while there is room; the same
 * words again raise their window. Returns false when there is no room, and the
 * words go into the composer instead.
 */
export function openAddressPrompt(prompt: string): boolean {
  const earlier = addressWindows.get(prompt);
  if (earlier !== undefined) {
    const open = spinOffWindows().find((item) => item.id === earlier);
    if (open) {
      setSpinOffMinimized(open.id, false);
      return true;
    }
    addressWindows.delete(prompt);
  }
  if (spinOffWindows().length >= SPIN_OFF_SLOTS) return false;
  const slot = openTaskWindow("url", { seed: { prompt, unsafe: true } });
  if (slot === null) return false;
  const opened = spinOffWindows().find((item) => item.slot === slot);
  if (opened) addressWindows.set(prompt, opened.id);
  return true;
}

/** A link clicked twice in quick succession raises its window. */
const repeatMs = 5000;
const recent = new Map<string, { at: number; windowId: number }>();

/**
 * A prompt link clicked in an artifact opens a quick task window with its
 * words, marked as coming from outside, instead of leaving the page: on the
 * Cowork page, not incognito, only right after a click, and while there is
 * room. The same link again within five seconds raises its window. Returns
 * whether the link was taken; otherwise it opens as any other link.
 */
export function takePromptLink(
  href: string,
  place: { cowork: boolean; incognito: boolean },
): boolean {
  if (!place.cowork || place.incognito) return false;
  const prompt = promptLink(href, linkOrigins());
  if (prompt === null) return false;
  // Scripts in a page cannot open windows on their own.
  if (!globalThis.navigator?.userActivation?.isActive) return false;
  const now = Date.now();
  for (const [key, value] of recent)
    if (now - value.at >= repeatMs) recent.delete(key);
  const earlier = recent.get(href);
  if (earlier) {
    const draft = spinOffWindows().find(
      (item) => item.id === earlier.windowId && item.sessionId === undefined,
    );
    if (draft) {
      if (draft.minimized) setSpinOffMinimized(draft.id, false);
      return true;
    }
  }
  if (spinOffWindows().length >= SPIN_OFF_SLOTS) return false;
  const slot = openTaskWindow("artifact_link", {
    seed: { prompt, unsafe: true },
  });
  if (slot === null) return false;
  const opened = spinOffWindows().find((item) => item.slot === slot);
  if (opened) recent.set(href, { at: now, windowId: opened.id });
  return true;
}
