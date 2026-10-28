import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AppIcon } from "../../ui/app-icon";
import { t, useT } from "../../i18n";

/** One page of a sheet: its title and body. */
export interface SheetPage {
  key: string;
  title: string;
  body: () => ReactNode;
}

/** The event a native shell sends for the system Back (closes one page). */
export const CLOSE_SHEET_EVENT = "claudex-close-sheet";
/** Dragging the sheet down this far closes it. */
const DISMISS_DRAG = 160;
/** How long the sheet takes to leave. */
const EXIT_MS = 150;

/**
 * A stack of sheet page keys: `open` starts it, `push` goes a page deeper,
 * `back` returns a page (closing on the first), `close` closes it. The owner
 * turns each key into its page on every render, so pages follow live data.
 */
export function useSheetStack() {
  const [pages, setPages] = useState<string[]>([]);
  return {
    pages,
    open: useCallback((key: string) => setPages([key]), []),
    push: useCallback(
      (key: string) => setPages((stack) => [...stack, key]),
      [],
    ),
    back: useCallback(() => setPages((stack) => stack.slice(0, -1)), []),
    close: useCallback(() => setPages([]), []),
  };
}

/**
 * The official modal bottom sheet: raised fill, 44 dp top corners, the 36 × 5
 * dp grabber, a 16 dp header with the page title and, below the first page,
 * Back. The 32 % black scrim, a tap on it, a drag down past 160 dp, Escape or
 * the shell's Back event close it (Back a page at a time). It is drawn over the
 * transcript only; the native composer stays below.
 */
export function OfficialSheet({
  pages,
  onBack,
  onClose,
}: {
  pages: SheetPage[];
  onBack: () => void;
  onClose: () => void;
}) {
  useT();
  const page = pages.at(-1);
  // Keep the last page while the sheet leaves.
  const [shown, setShown] = useState(page);
  const [leaving, setLeaving] = useState(false);
  const [drag, setDrag] = useState(0);
  const start = useRef<number | undefined>(undefined);
  if (page && (page !== shown || leaving)) {
    setShown(page);
    setLeaving(false);
  } else if (!page && shown && !leaving) setLeaving(true);
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => {
      setShown(undefined);
      setLeaving(false);
      setDrag(0);
    }, EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  const open = Boolean(page);
  useEffect(() => {
    if (!open) return;
    const back = (event: Event) => {
      event.preventDefault();
      onBack();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onBack();
    };
    document.addEventListener(CLOSE_SHEET_EVENT, back);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener(CLOSE_SHEET_EVENT, back);
      document.removeEventListener("keydown", key);
    };
  }, [open, onBack]);
  if (!shown) return null;
  const host =
    document.querySelector(".app.mobile-conversation") ?? document.body;
  const depth = pages.length;
  return createPortal(
    <div
      className="official-sheet-layer"
      data-leaving={leaving || undefined}
      data-open-sheet={open || undefined}
    >
      <div
        className="official-sheet-scrim"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        className="official-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={shown.title}
        style={drag ? { transform: `translateY(${drag}px)` } : undefined}
        data-dragging={start.current !== undefined || undefined}
      >
        <div
          className="official-sheet-grabber"
          aria-label={t("Drag handle")}
          onPointerDown={(event) => {
            start.current = event.clientY;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (start.current === undefined) return;
            setDrag(Math.max(0, event.clientY - start.current));
          }}
          onPointerUp={() => {
            const moved = drag;
            start.current = undefined;
            if (moved > DISMISS_DRAG) onClose();
            else setDrag(0);
          }}
          onPointerCancel={() => {
            start.current = undefined;
            setDrag(0);
          }}
        >
          <span />
        </div>
        <div className="official-sheet-header">
          {depth > 1 ? (
            <button
              type="button"
              className="official-icon-button official-sheet-back"
              aria-label={t("Back")}
              onClick={onBack}
            >
              <AppIcon name="CaretRight" />
            </button>
          ) : (
            <span className="official-sheet-header-spacer" />
          )}
          <h2 className="official-sheet-title">{shown.title}</h2>
          <span className="official-sheet-header-spacer" />
        </div>
        <div className="official-sheet-body" key={shown.key}>
          {shown.body()}
        </div>
      </div>
    </div>,
    host,
  );
}
