import { Spinner } from "../ui/Spinner";
import { Modal } from "../ui/Controls";
import { formatText, t } from "../i18n";

/**
 * Relaunching while a task runs asks first: Cancel, Wait for Claudex (relaunch
 * by itself once everything is idle) and Update anyway. While waiting, only
 * Cancel is left and the text says so, after a small spinner. With one session
 * running its title is a text link that opens it ("Untitled session" without a
 * title).
 */
export function RelaunchBusyDialog({
  count,
  firstTitle,
  waiting,
  onWait,
  onUpdateAnyway,
  onClose,
  onOpenSession,
}: {
  /** How many conversations have a task running. */
  count: number;
  /** The one conversation's title, when exactly one is running. */
  firstTitle?: string;
  waiting: boolean;
  onWait: () => void;
  onUpdateAnyway: () => void;
  /** Cancel, Escape or a click outside: also cancels a pending wait. */
  onClose: () => void;
  /** Opens the one running session from the dialog's text link. */
  onOpenSession?: () => void;
}) {
  const sessionLink = (
    <button
      type="button"
      className="relaunch-session-link"
      onClick={() => {
        onOpenSession?.();
        onClose();
      }}
    >
      {firstTitle || "Untitled session"}
    </button>
  );
  // The translated sentence is cut at the link's place.
  const [before, after = ""] = t(
    "Claudex is working in {sessionLink}. Relaunching now will interrupt that work.",
  ).split("{sessionLink}");
  return (
    <Modal
      title="Claudex is still working"
      onClose={onClose}
      variant="confirm"
      confirmFocus={waiting ? "confirm" : "cancel"}
    >
      <p className="confirm-body">
        {waiting ? (
          <span className="relaunch-waiting">
            <Spinner
              inheritColor
              className="spin"
              size={16}
              aria-hidden="true"
            />
            <span>
              Waiting for Claudex to finish — the app will relaunch
              automatically.
            </span>
          </span>
        ) : count === 1 ? (
          <>
            {before}
            {sessionLink}
            {after}
          </>
        ) : (
          formatText(
            "Claudex is working in {count} sessions. Relaunching now will interrupt that work.",
            { count },
          )
        )}
      </p>
      <div className="button-row">
        <button className="secondary" onClick={onClose}>
          Cancel
        </button>
        {!waiting && (
          <>
            <button className="secondary" onClick={onWait}>
              Wait for Claudex
            </button>
            <button className="primary" onClick={onUpdateAnyway}>
              Update anyway
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
