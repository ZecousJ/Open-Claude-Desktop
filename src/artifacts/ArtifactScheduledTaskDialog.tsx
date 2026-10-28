import { useEffect, useState } from "react";
import { formatText, useT } from "../i18n";
import { Modal } from "../ui/Controls";
import { artifactToolReadiness } from "../../shared/artifact-tool-readiness";

/** Safe-default confirmation. */
export function ArtifactScheduledTaskDialog({
  artifact,
  task,
  onDecision,
}: {
  artifact: string;
  task: string;
  onDecision(allow: boolean, remember: boolean): void;
}) {
  const t = useT();
  const [remember, setRemember] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => artifactToolReadiness(document, setReady), []);
  return (
    <Modal
      title={formatText('Allow "{artifact}" to run a scheduled task?', {
        artifact,
      })}
      variant="confirm"
      confirmFocus="cancel"
      disablePointerDismissal
      onClose={() => onDecision(false, false)}
    >
      <p>
        {formatText(
          'The live artifact "{artifact}" wants to run the scheduled task "{task}".',
          { artifact, task },
        )}
      </p>
      <label>
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
        />
        {t("Don't ask again for this task")}
      </label>
      <footer>
        <button
          type="button"
          className="secondary"
          disabled={!ready}
          onClick={() => onDecision(false, false)}
        >
          {t("Cancel")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!ready}
          onClick={() => onDecision(true, remember)}
        >
          {t("Run")}
        </button>
      </footer>
    </Modal>
  );
}
