import { Check, X } from "lucide-react";
import { useTooltip } from "../ui/Tooltip";
import { t } from "../i18n";
import "./dictation-actions.css";

/** Recording actions. */
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
        <X size={20} strokeWidth={1.75} aria-hidden="true" />
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
        <Check size={20} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {done.tooltip}
    </span>
  );
}
