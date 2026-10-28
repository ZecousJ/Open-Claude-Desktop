import { Modal } from "../../ui/Controls";
import { Spinner } from "../../ui/Spinner";
import { formatText, t, useLocale } from "../../i18n";
import type { RoutineMigrationRequest } from "../../../shared/routine-migration";

/** The existing confirmation Modal supplies focus containment/restoration,
 * Escape and nested-dialog ownership; busy moves cannot be dismissed. */
export default function RoutineMigrationConfirm({
  direction,
  taskName,
  busy,
  disabled,
  error,
  retry,
  onConfirm,
  onClose,
}: {
  direction: RoutineMigrationRequest["direction"];
  taskName: string;
  busy: boolean;
  disabled: boolean;
  error?: string;
  retry?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useLocale();
  const back = direction === "to-local";
  return (
    <Modal
      title={t(back ? "Move back to this computer?" : "Move to cloud?")}
      variant="confirm"
      confirmFocus="cancel"
      disablePointerDismissal={busy}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div aria-busy={busy || undefined} className="routine-migration-confirm">
        <p className="confirm-body">
          {formatText(
            back
              ? "“{taskName}” will run on this computer again."
              : "“{taskName}” will run in the cloud. The local copy will be paused.",
            { taskName },
          )}
        </p>
        {back && (
          <p className="confirm-body">
            {t(
              "The cloud version will be deleted, along with its run history and any changes made to it except the instructions.",
            )}
          </p>
        )}
        {error && (
          <p role="alert" className="task-error">
            {error}
          </p>
        )}
        <div className="button-row">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            {t(back ? "Keep in cloud" : "Cancel")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || disabled}
            onClick={onConfirm}
          >
            {busy ? (
              <>
                <Spinner size={12} inheritColor />
                {t("Moving…")}
              </>
            ) : (
              t(retry ? "Retry move" : back ? "Move back" : "Move to cloud")
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}
