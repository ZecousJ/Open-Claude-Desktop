import { flushSync } from "react-dom";
import { prefersReducedMotion } from "../ui/usePresence";

/** The view transition type the attachment rules in composer-core.css key on. */
export const attachmentTransitionType = "composer-attachments";
/** The fallback exit, as long as the view transition's: 130ms. */
const leaveMs = 130;

type TransitionStart = (options: { update: () => void; types: string[] }) => {
  finished: Promise<unknown>;
};

/**
 * Removes one composer attachment with the original's motion (desktop
 * bundle 2.31226.1): the tile shrinks to half and fades in 130ms while the
 * ones after it slide into its place in 180ms. A view transition carries it
 * where the browser has typed view transitions; elsewhere the tile fades out
 * on its own first and the others then close up at once. Under reduced
 * motion it goes at once.
 */
export function removeAttachment(
  list: HTMLElement | null,
  id: string,
  remove: () => void,
) {
  const tiles = list
    ? Array.from(list.querySelectorAll<HTMLElement>("[data-attachment]"))
    : [];
  const tile = tiles.find((item) => item.dataset.attachment === id);
  if (!list || !tile || prefersReducedMotion()) return remove();
  const start = (
    list.ownerDocument as Document & { startViewTransition?: unknown }
  ).startViewTransition;
  if (typeof start === "function") {
    // Each tile is its own group for this transition only; the names stay on
    // the same elements, which React keeps, so the rest find their new place.
    tiles.forEach((item, index) => {
      item.style.viewTransitionName = `composer-attachment-${index}`;
    });
    const clear = () =>
      tiles.forEach((item) => (item.style.viewTransitionName = ""));
    try {
      const transition = (start as TransitionStart).call(list.ownerDocument, {
        update: () => flushSync(remove),
        types: [attachmentTransitionType],
      });
      void transition.finished.catch(() => {}).finally(clear);
      return;
    } catch {
      // No options form (types): the fallback below.
      clear();
    }
  }
  if (tile.dataset.leaving !== undefined) return;
  tile.dataset.leaving = "";
  setTimeout(remove, leaveMs);
}
