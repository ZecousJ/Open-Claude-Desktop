import { createPortal } from "react-dom";
import { currentLocale, formatText } from "../i18n";
import { Modal } from "../ui/Controls";
import type { PendingClose } from "./terminal-close";

/**
 * The words of the question: the title, the sentence naming the tab (or
 * counting the other tabs) and the red confirming button. `name` is the tab's
 * label as shown, already in the window's language.
 */
export function terminalCloseText(pending: PendingClose, name: string) {
  if (pending.kind === "close")
    return {
      title: "Close terminal?",
      body: formatText(
        "A command is still running in {name}. Closing the terminal stops it.",
        { name },
      ),
      confirm: "Close terminal",
    };
  return {
    title: "Close other terminals?",
    body:
      pending.busyCount === 1
        ? "A command is still running in one of the other terminals. Closing them stops it."
        : formatText(
            "Commands are still running in {count} of the other terminals. Closing them stops those commands.",
            { count: pending.busyCount.toLocaleString(currentLocale()) },
          ),
    confirm: "Close other terminals",
  };
}

/**
 * Close terminal? / Close other terminals?: the short confirmation, Cancel
 * then the red confirming button, which starts focused as the original's.
 */
export function TerminalCloseDialog({
  pending,
  name,
  onCancel,
  onConfirm,
}: {
  pending: PendingClose;
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const text = terminalCloseText(pending, name);
  return createPortal(
    <Modal title={text.title} onClose={onCancel} variant="confirm">
      <p className="confirm-body">{text.body}</p>
      <div className="button-row">
        <button className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary danger-button" onClick={onConfirm}>
          {text.confirm}
        </button>
      </div>
    </Modal>,
    document.body,
  );
}
