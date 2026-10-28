import { useEffect, useRef, type ReactNode } from "react";
import { X } from "./glyphs";
import { useDialogOverlay } from "./dialog-stack";

const focusable =
  'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]';

/**
 * Scrolling dialog with a title bar, as used by the original's Keyboard
 * shortcuts and What's new: a 54px header on a lighter band, a hairline, then
 * the scrolling body.
 */
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const overlay = useDialogOverlay();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Focus the dialog itself so no control shows a focus ring on open.
    box.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const nodes = [
        ...(box.current?.querySelectorAll<HTMLElement>(focusable) ?? []),
      ];
      if (!nodes.length) return;
      if (event.shiftKey && document.activeElement === nodes[0]) {
        event.preventDefault();
        nodes.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
        event.preventDefault();
        nodes[0].focus();
      }
    };
    addEventListener("keydown", key);
    return () => {
      removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      {...overlay}
      className="sheet-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header>
          <h2>{title}</h2>
          <button aria-label="Close" onClick={onClose}>
            <X size={20} strokeWidth={1.5} />
          </button>
        </header>
        <div className="sheet-body u-scroll-fade-y">{children}</div>
      </div>
    </div>
  );
}
