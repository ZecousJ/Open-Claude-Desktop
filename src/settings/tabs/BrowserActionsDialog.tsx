import { helpUrl } from "../../../shared/help-links";
import { t } from "../../i18n";
import { SettingsModal } from "../controls";
import "./browser-actions-dialog.css";

/** Browser warning. */
export function BrowserActionsDialog({
  onClose,
  onAllow,
}: {
  onClose: () => void;
  onAllow: () => void;
}) {
  return (
    <SettingsModal
      title={t("Allow all browser actions?")}
      className="browser-actions-dialog"
      variant="confirm"
      confirmFocus="cancel"
      showClose={false}
      onClose={onClose}
    >
      <div className="browser-actions-copy">
        <p>
          {t(
            "Claudex will take actions without asking for your permission, including on websites you haven’t approved.",
          )}
        </p>
        <p>
          {t("This setting can put your data at risk.")}{" "}
          <a
            href={helpUrl("browser-safety")}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("Learn more")}
          </a>
        </p>
      </div>
      <div className="button-row">
        <button type="button" className="secondary" onClick={onClose}>
          {t("Cancel")}
        </button>
        <button type="button" className="primary" onClick={onAllow}>
          {t("Allow")}
        </button>
      </div>
    </SettingsModal>
  );
}
