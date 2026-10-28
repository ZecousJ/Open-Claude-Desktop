import { useState } from "react";
import { Modal } from "../../ui/Controls";
import { AppIcon } from "../../ui/app-icon";
import { t } from "../../i18n";

/**
 * A new API token, shown once: "API token", a warning that it will not be shown
 * again, the token with its copy button, and Done. It does not close by Escape
 * or a press outside: Done is the way out.
 */
export function RoutineApiTokenDialog({
  token,
  onClose,
  title = "API token",
  notice = "Copy this token now. It won’t be shown again. Use it to fire this scheduled task via POST.",
}: {
  token: string;
  onClose: () => void;
  /** "Token generated" when the task's page makes a new one. */
  title?: string;
  notice?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal
      title={title}
      className="routine-token-dialog"
      onClose={() => {}}
      showClose={false}
      disablePointerDismissal
    >
      <div className="routine-token-notice" role="note">
        <AppIcon name="Warning" size={16} />
        <p>{t(notice)}</p>
      </div>
      <div className="routine-token-row">
        <code dir="ltr" data-no-translate>
          {token}
        </code>
        <button
          type="button"
          className="routine-token-copy"
          aria-label={copied ? t("Copied") : t("Copy token")}
          title={copied ? t("Copied") : t("Copy token")}
          onClick={() =>
            void window.desktop.copyText(token).then(() => setCopied(true))
          }
        >
          <AppIcon name={copied ? "Check" : "Copy"} size={16} />
        </button>
      </div>
      <div className="button-row">
        <button type="button" className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
