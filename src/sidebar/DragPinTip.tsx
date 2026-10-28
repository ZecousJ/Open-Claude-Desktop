import { Hand, X } from "lucide-react";
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
 * The reference design coach mark, as the Pinned heading's drag tip uses it: an
 * accent card to the right of the heading, 10px from it, centred on it, with an
 * arrow pointing back at it. It comes 300ms after it is asked for (introDelay
 * 0.3), fades and grows from 97% over 200ms, does not take focus, and only its
 * × closes it: a click elsewhere, focus leaving or Escape leave it up.
 */
const sideOffset = 10;
const introMs = 300;
const exitMs = 200;

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
          <Hand size={20} strokeWidth={1.5} aria-hidden="true" />
          <p>{text}</p>
        </div>
        <span className="drag-pin-tip-close-slot">
          <button
            type="button"
            className="drag-pin-tip-close"
            aria-label="Dismiss"
            onClick={onClose}
          >
            <X size={12} strokeWidth={2} aria-hidden="true" />
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
