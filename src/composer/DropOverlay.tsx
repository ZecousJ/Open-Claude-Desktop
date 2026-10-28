import { createPortal } from "react-dom";
import { Pictogram } from "../ui/Pictogram";
import { usePresence } from "../ui/usePresence";
import type { FileDropScope, FileDropState } from "./useFileDrop";
import "./drop-overlay.css";

/** The panel exits over 200ms. */
const cardExitMs = 200;

/**
 * A card shows a dashed accent frame off-target and a solid ring with an inner
 * glow on-target. A page covers the window with its surface at 90% and the
 * document pictogram over "Drop files here" (shared-9 t5, the composer's
 * enableScreenDrop). With attachments off nothing is shown: the drop zone is
 * not armed.
 */
export function DropOverlay({
  scope,
  state,
  label,
}: {
  scope: FileDropScope;
  state: FileDropState;
  label: string;
}) {
  const active = state !== "idle";
  const card = usePresence(active && scope === "card", cardExitMs);
  if (scope === "page")
    return active
      ? createPortal(
          <div className="composer-drop-page" aria-hidden="true">
            <div className="composer-drop-page-fill">
              <div className="composer-drop-page-content">
                <Pictogram name="ObjectDocumentAdd" size={96} />
                <span>{label}</span>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;
  if (!card.mounted) return null;
  return (
    <div
      className="composer-drop-card"
      aria-hidden="true"
      data-state={card.state}
      data-target={state === "on-target" || undefined}
    >
      <div className="composer-drop-dashed" />
      <div className="composer-drop-ring" />
      <div className="composer-drop-glow" />
    </div>
  );
}
