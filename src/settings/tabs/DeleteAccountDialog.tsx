import { useRef, useState } from "react";
import { actionVerificationHandled } from "../../auth/action-verification-store";
import { api } from "../../desktop-api";
import { t, useT } from "../../i18n";
import { showToast } from "../../ui/toast-store";
import { SettingsModal } from "../controls";
import "./delete-account.css";

export const deleteAccountWarning =
  "Deleting your account is permanent. You will have no way of recovering your account or conversation data.";
export const deleteAccountQuestion =
  "Are you sure you want to delete your account?";
export const deleteAccountFailure =
  "An error occurred while deleting your account. Please try again or contact support.";

/** Two confirmations, initially focused on Cancel. */
export function DeleteAccountDialog({
  onClose,
  onDeleted,
}: {
  onClose: () => void;
  onDeleted: () => void | Promise<void>;
}) {
  useT();
  const [step, setStep] = useState<1 | 2>(1);
  const openedAt = useRef(0);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await api.deleteAccount();
      showToast(t("Account deleted"));
      await onDeleted();
    } catch (error) {
      if (!actionVerificationHandled(error)) showToast(t(deleteAccountFailure));
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <SettingsModal
      key={step}
      title="Delete account"
      className="delete-account-dialog"
      variant="confirm"
      confirmFocus="cancel"
      showClose={false}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="confirm-body">
        {step === 1 ? deleteAccountWarning : deleteAccountQuestion}
      </p>
      <div className="button-row">
        <button className="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          className={`primary${step === 2 ? " danger-button" : ""}`}
          disabled={busy}
          onClick={(event) => {
            if (step === 1) {
              openedAt.current = performance.now();
              setStep(2);
            } else if (
              event.detail <= 1 &&
              performance.now() - openedAt.current >= 500
            ) {
              onClose();
              void submit();
            }
          }}
        >
          {step === 1 ? "I understand" : "Delete"}
        </button>
      </div>
    </SettingsModal>
  );
}
