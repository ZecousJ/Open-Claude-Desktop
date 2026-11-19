import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { usePresence } from "../ui/usePresence";
import { tooltipMargin } from "../ui/tooltip-position";
import "./drag-pin-tip.css";

/**
 * The live claude.ai bundle's coach mark (2026-10-12), as the Pinned
 * heading's drag tip uses it: an accent card to the right of the heading,
 * 10px from it, centred on it, with an arrow pointing back at it. It comes
 * 300ms after it is asked for (introDelay 0.3), fades and grows from 97%
 * over 200ms, does not take focus, and only its × closes it: a click
 * elsewhere, focus leaving or Escape leave it up.
 */
const sideOffset = 10;
const introMs = 300;
const exitMs = 200;

/** Glyphs of the original's icon font, outlined like src/ui/anthropicons.tsx. */
// Hand, 20px at weight 433.25 (the icon's "md" size).
const hand =
  "M7.1 10.5H5.9V4.74Q5.9 4.25 6.15 3.82Q6.39 3.39 6.82 3.15Q7.25 2.9 7.76 2.9Q8.25 2.9 8.68 3.15Q9.11 3.39 9.35 3.82Q9.6 4.25 9.6 4.74V9.5Q9.6 9.24 9.43 9.07Q9.26 8.9 9 8.9Q8.74 8.9 8.57 9.07Q8.4 9.24 8.4 9.5V3.74Q8.4 3.25 8.65 2.82Q8.89 2.39 9.32 2.15Q9.75 1.9 10.26 1.9Q10.75 1.9 11.18 2.15Q11.61 2.39 11.85 2.82Q12.1 3.25 12.1 3.74V9.5Q12.1 9.24 11.93 9.07Q11.76 8.9 11.5 8.9Q11.24 8.9 11.07 9.07Q10.9 9.24 10.9 9.5V4.74Q10.9 4.25 11.15 3.82Q11.39 3.39 11.82 3.15Q12.25 2.9 12.76 2.9Q13.25 2.9 13.68 3.15Q14.11 3.39 14.35 3.82Q14.6 4.25 14.6 4.74V10.5Q14.6 10.24 14.43 10.07Q14.26 9.9 14 9.9Q13.74 9.9 13.57 10.07Q13.4 10.24 13.4 10.5V7.74Q13.4 7.25 13.65 6.82Q13.89 6.39 14.32 6.15Q14.75 5.9 15.26 5.9Q15.75 5.9 16.18 6.15Q16.61 6.39 16.85 6.82Q17.1 7.25 17.1 7.74V9.5H15.9V7.74Q15.9 7.48 15.71 7.29Q15.52 7.1 15.26 7.1Q14.98 7.1 14.79 7.29Q14.6 7.48 14.6 7.74V10.5Q14.6 10.76 14.43 10.93Q14.26 11.1 14 11.1Q13.74 11.1 13.57 10.93Q13.4 10.76 13.4 10.5V4.74Q13.4 4.48 13.21 4.29Q13.02 4.1 12.76 4.1Q12.48 4.1 12.29 4.29Q12.1 4.48 12.1 4.74V9.5Q12.1 9.76 11.93 9.93Q11.76 10.1 11.5 10.1Q11.24 10.1 11.07 9.93Q10.9 9.76 10.9 9.5V3.74Q10.9 3.48 10.71 3.29Q10.52 3.1 10.26 3.1Q9.98 3.1 9.79 3.29Q9.6 3.48 9.6 3.74V9.5Q9.6 9.76 9.43 9.93Q9.26 10.1 9 10.1Q8.74 10.1 8.57 9.93Q8.4 9.76 8.4 9.5V4.74Q8.4 4.48 8.21 4.29Q8.02 4.1 7.76 4.1Q7.48 4.1 7.29 4.29Q7.1 4.48 7.1 4.74ZM15.9 9H17.1V11Q17.1 12.47 16.54 13.76Q15.99 15.04 15.02 16.02Q14.04 16.99 12.75 17.54Q11.47 18.1 10 18.1Q8.53 18.1 7.24 17.54Q5.96 16.99 4.98 16.02Q4.01 15.04 3.46 13.75Q2.9 12.47 2.9 11V8Q2.9 7.54 3.22 7.22Q3.54 6.9 4 6.9H4.26Q5.03 6.9 5.68 7.29Q6.33 7.67 6.71 8.32Q7.1 8.97 7.1 9.74V10.91Q7.82 10.93 8.43 11.26Q9.04 11.58 9.48 12.12Q9.92 12.67 10.08 13.35Q10.14 13.59 10.01 13.8Q9.88 14.01 9.65 14.08Q9.41 14.14 9.2 14.01Q8.99 13.88 8.92 13.65Q8.75 12.96 8.2 12.53Q7.65 12.1 6.94 12.1H6.5Q6.24 12.1 6.07 11.93Q5.9 11.76 5.9 11.5V9.74Q5.9 9.06 5.42 8.58Q4.94 8.1 4.26 8.1H4L4.1 8V11Q4.1 12.23 4.55 13.3Q5.01 14.36 5.83 15.17Q6.64 15.99 7.7 16.45Q8.77 16.9 10 16.9Q11.23 16.9 12.29 16.45Q13.36 15.99 14.17 15.17Q14.99 14.36 15.45 13.3Q15.9 12.23 15.9 11Z";
// X, 12px at weight 577.75 (the icon's "xs" size).
const close =
  "M8.37 2.97Q8.5 2.84 8.7 2.84Q8.89 2.84 9.03 2.97Q9.16 3.1 9.16 3.3Q9.16 3.49 9.03 3.63L3.63 9.03Q3.5 9.16 3.3 9.16Q3.11 9.16 2.97 9.03Q2.84 8.9 2.84 8.7Q2.84 8.51 2.97 8.37ZM9.03 8.37Q9.16 8.5 9.16 8.7Q9.16 8.89 9.03 9.03Q8.9 9.16 8.7 9.16Q8.51 9.16 8.37 9.03L2.97 3.63Q2.84 3.5 2.84 3.3Q2.84 3.11 2.97 2.97Q3.1 2.84 3.3 2.84Q3.49 2.84 3.63 2.97Z";

/**
 * Where the card goes for an anchor `box`: to its right, vertically centred
 * on it but kept inside the window, with the arrow's middle on the anchor's
 * middle (clamped to the card's rounded part).
 */
export function dragPinTipPlacement(
  box: { top: number; bottom: number; right: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
) {
  const middle = (box.top + box.bottom) / 2;
  const top = Math.max(
    tooltipMargin,
    Math.min(
      middle - size.height / 2,
      view.height - tooltipMargin - size.height,
    ),
  );
  const left = Math.min(
    box.right + sideOffset,
    view.width - tooltipMargin - size.width,
  );
  // The arrow is 28px across; 16px of padding keeps it off the corners
  // (arrowPadding 16), or it sits in the middle of a card too short for that.
  const half = size.height / 2;
  const arrow = Math.max(
    Math.min(30, half),
    Math.min(middle - top, Math.max(size.height - 30, half)),
  );
  return { left, top, arrow };
}

export function DragPinTip({
  open,
  anchor,
  text,
  onClose,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  text: string;
  /** The × was pressed: the tip is seen. */
  onClose: () => void;
}) {
  // Asked for, the card waits out the intro delay before it shows.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!open) return setReady(false);
    const timer = setTimeout(() => setReady(true), introMs);
    return () => clearTimeout(timer);
  }, [open]);
  const { mounted, state } = usePresence(open && ready, exitMs);
  const card = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{
    left: number;
    top: number;
    arrow: number;
  }>();
  useLayoutEffect(() => {
    if (!mounted) return setPlace(undefined);
    const measure = () => {
      const el = card.current;
      const box = anchor.current?.getBoundingClientRect();
      if (!el || !box) return;
      setPlace(
        dragPinTipPlacement(
          box,
          { width: el.offsetWidth, height: el.offsetHeight },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    measure();
    // The heading moves with the list's scroll and the window's size.
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [mounted, anchor, text]);
  // Placed, it shows on the next frame so the entrance transitions.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!place || state !== "open") return setShown(false);
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [place, state]);
  if (!mounted) return null;
  return createPortal(
    <div
      ref={card}
      className="drag-pin-tip"
      role="dialog"
      aria-label={text}
      aria-live="polite"
      data-open={shown || undefined}
      data-state={state}
      style={
        place
          ? {
              left: place.left,
              top: place.top,
              transformOrigin: `0 ${place.arrow}px`,
            }
          : { visibility: "hidden" }
      }
    >
      <div className="drag-pin-tip-body">
        <div className="drag-pin-tip-content">
          <svg
            width={20}
            height={20}
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d={hand} />
          </svg>
          <p>{text}</p>
        </div>
        <span className="drag-pin-tip-close-slot">
          <button
            type="button"
            className="drag-pin-tip-close"
            aria-label="Dismiss"
            onClick={onClose}
          >
            <svg
              width={12}
              height={12}
              viewBox="0 0 12 12"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d={close} />
            </svg>
          </button>
        </span>
      </div>
      <svg
        className="drag-pin-tip-arrow"
        width={28}
        height={12}
        viewBox="0 0 28 12"
        aria-hidden="true"
        style={place ? { top: place.arrow - 6 } : undefined}
      >
        <path d="M0 0H28V2C24 2 22.7 2.3 21.5 3.4L15.5 8.7Q14 10 12.5 8.7L6.5 3.4C5.3 2.3 4 2 0 2Z" />
      </svg>
    </div>,
    document.body,
  );
}
