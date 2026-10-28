import "./composer-menu-sheet.css";
import {
  dismissComposerSheet,
  useComposerMenuPresentation,
} from "./menu-sheet";

/**
 * The dimmed page behind one of the composer's own menus (model, add,
 * microphone, repository) for a coarse pointer or explicit sheet context;
 * hidden for fine-pointer popups. Its styles load with the opened sheet. A tap on it closes the menu.
 * It sits beside the menu, inside the menu's anchor, so the menu's own
 * outside-press check (which spares the anchor) leaves it to this handler.
 */
export function MenuSheetScrim({ onClose }: { onClose: () => void }) {
  const sheet = useComposerMenuPresentation();
  return (
    <div
      className="menu-sheet-scrim composer-menu-scrim"
      data-composer-sheet-scrim={sheet ? "true" : undefined}
      aria-hidden="true"
      onClick={(event) => dismissComposerSheet(event.currentTarget, onClose)}
    />
  );
}
