import { useState, type ReactNode } from "react";
import { Modal } from "../ui/Controls";

export interface Confirmation {
  title: string;
  /** A preformatted, translated title containing user text. */
  titleIsUserData?: boolean;
  body: string;
  action: () => Promise<void>;
  /** The confirming button's label; "Delete" by default. */
  confirm?: string;
  /** Red confirming button, as for deletions (the default). */
  danger?: boolean;
  confirmFocus?: "confirm" | "cancel";
}

/**
 * Confirmation dialog (R-1289 Delete project, R-1590): title, explanation,
 * then Cancel and the confirming button on the right. While the action
 * runs both buttons are disabled and Escape and the backdrop do nothing
 * (live claude.ai bundle, 2026-10-16, shared-frame-6654oR3- E9).
 */
export function ConfirmationDialog({
  confirmation,
  onClose,
  onError,
  children,
  confirmDisabled = false,
}: {
  confirmation: Confirmation;
  onClose: () => void;
  onError: (error: unknown) => void;
  children?: ReactNode;
  confirmDisabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const danger = confirmation.danger ?? true;
  return (
    <Modal
      title={confirmation.title}
      titleIsUserData={confirmation.titleIsUserData}
      onClose={onClose}
      variant="confirm"
      confirmFocus={confirmation.confirmFocus}
      pending={busy}
    >
      <p className="confirm-body">{confirmation.body}</p>
      {children}
      <div className="button-row">
        <button className="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          className={`primary ${danger ? "danger-button" : ""}`}
          disabled={busy || confirmDisabled}
          onClick={() => {
            setBusy(true);
            void confirmation
              .action()
              .then(onClose)
              .catch((error) => {
                setBusy(false);
                onError(error);
              });
          }}
        >
          {confirmation.confirm ?? "Delete"}
        </button>
      </div>
    </Modal>
  );
}
