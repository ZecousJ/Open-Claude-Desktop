import { t } from "../i18n";
import { SubmitPill } from "../composer/SubmitPill";
import { AppIcon } from "../ui/app-icon";
import "../composer/composer-core.css";

// Mini composer actions.
export function MiniComposerControls({
  running = false,
  hasContent,
  disabled,
  waiting = false,
  stopping = false,
  start = false,
  busy = false,
  onSend,
  onStop = () => {},
}: {
  running?: boolean;
  hasContent: boolean;
  disabled: boolean;
  waiting?: boolean;
  stopping?: boolean;
  /** A task not started yet: the brand ArrowUp "Start task" button, not Send. */
  start?: boolean;
  /** The task is starting. */
  busy?: boolean;
  onSend: () => void;
  onStop?: () => void;
}) {
  // The draft's button.
  if (start)
    return (
      <button
        type="button"
        className="send-button"
        aria-label={t("Start task")}
        aria-busy={busy || undefined}
        disabled={disabled || !hasContent}
        onClick={onSend}
      >
        {waiting || busy ? (
          <span
            {...(waiting
              ? { role: "status", "aria-label": t("Waiting for uploads") }
              : { "aria-hidden": true })}
            className="mini-composer-spinner waiting"
          />
        ) : (
          <AppIcon name="ArrowUp" />
        )}
      </button>
    );
  return (
    <SubmitPill
      running={running}
      hasContent={hasContent}
      stop={
        <button
          type="button"
          className="send-button composer-ghost-stop"
          aria-label={t("Stop response")}
          aria-busy={stopping || undefined}
          onClick={onStop}
        >
          <AppIcon name="Stop" />
        </button>
      }
      send={
        <button
          type="button"
          className="send-button"
          aria-label={t("Send message")}
          disabled={disabled || !hasContent}
          onClick={onSend}
        >
          {waiting ? (
            <span
              role="status"
              aria-label={t("Waiting for uploads")}
              className="mini-composer-spinner waiting"
            />
          ) : (
            <AppIcon name="ComposerSend" />
          )}
        </button>
      }
    />
  );
}
