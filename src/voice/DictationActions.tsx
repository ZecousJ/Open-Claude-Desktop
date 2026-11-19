import { useTooltip } from "../ui/Tooltip";
import { t } from "../i18n";
import "./dictation-actions.css";

const checkPath =
  "m3.33 9.93q-.19-.17-.19-.43q0-.26.19-.43q.17-.17.42-.17q.25 0 .42.17l3.83 3.84l8.07-8.08q.17-.19.43-.19q.26 0 .43.19q.17.17.17.42q0 .25-.17.42l-8.5 8.5q-.17.19-.43.19q-.26 0-.43-.19z";
const cancelPath =
  "m14.07 5.07q.17-.17.43-.17q.26 0 .43.17q.17.17.17.43q0 .26-.17.43l-9 9q-.17.17-.43.17q-.26 0-.43-.17q-.17-.17-.17-.43q0-.26.17-.43zm.86 9q.17.17.17.43q0 .26-.17.43q-.17.17-.43.17q-.26 0-.43-.17l-9-9q-.17-.17-.17-.43q0-.26.17-.43q.17-.17.43-.17q.26 0 .43.17z";

/**
 * Recording actions (live claude.ai bundle, 2026-10-14, shared-8-D8y0BqdN).
 */
export function DictationActions({
  connecting,
  onCancel,
  onDone,
}: {
  connecting: boolean;
  onCancel: () => void;
  onDone: () => void;
}) {
  const cancel = useTooltip("Cancel", { placement: "above" });
  const done = useTooltip("Done", { placement: "above", disabled: connecting });
  return (
    <span
      className="dictation-actions"
      role="group"
      aria-label={t("Dictation")}
    >
      <button
        {...cancel.props}
        type="button"
        className="dictation-action"
        aria-label={t("Cancel dictation")}
        onClick={onCancel}
      >
        <svg
          width={20}
          height={20}
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d={cancelPath} />
        </svg>
      </button>
      {cancel.tooltip}
      <button
        {...done.props}
        type="button"
        className="dictation-action dictation-done"
        aria-label={t("Finish dictation")}
        disabled={connecting}
        onClick={onDone}
      >
        <svg
          width={20}
          height={20}
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d={checkPath} />
        </svg>
      </button>
      {done.tooltip}
    </span>
  );
}
