import { useEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useDialogOverlay } from "../ui/dialog-stack";
import { helpUrl } from "../../shared/help-links";

/**
 * Confirmation before Code runs with full access in a folder. Cancel starts
 * focused; Escape cancels; Tab stays inside the dialog.
 */
export function BypassDialog({
  folder,
  onCancel,
  onConfirm,
}: {
  folder: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const overlay = useDialogOverlay();
  useEffect(() => cancel.current?.focus(), []);
  const keyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Tab") {
      const stops = [
        ...(box.current?.querySelectorAll<HTMLElement>("a, button") ?? []),
      ];
      const at = stops.indexOf(document.activeElement as HTMLElement);
      const next =
        (at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length;
      event.preventDefault();
      stops[next]?.focus();
    }
  };
  return createPortal(
    <div {...overlay} className="bypass-backdrop" onKeyDown={keyDown}>
      <div
        ref={box}
        className="bypass-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="bypass-title"
        aria-describedby="bypass-body"
      >
        <h2 id="bypass-title">Bypass all permissions?</h2>
        <p id="bypass-body">
          Claudex will read, edit, and execute files without asking — including
          potentially destructive commands. Only use this in isolated or
          disposable environments.
        </p>
        <code>{folder}</code>
        <small>
          You won’t be asked again for this workspace. Read our{" "}
          <a
            // Claudex's own security page.
            href={helpUrl("code-security")}
            onClick={(event) => {
              event.preventDefault();
              void window.desktop?.openExternal(helpUrl("code-security"));
            }}
          >
            security guide
          </a>{" "}
          for details.
        </small>
        <footer>
          <button ref={cancel} onClick={onCancel}>
            Cancel
          </button>
          <button className="bypass-confirm" onClick={onConfirm}>
            Bypass permissions
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
