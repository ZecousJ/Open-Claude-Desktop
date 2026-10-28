import { useState } from "react";
import { Modal } from "../ui/Controls";
import { t, useT } from "../i18n";

export default function EditGoalDialog({
  initial,
  onClose,
  onSave,
}: {
  initial: string;
  onClose: () => void;
  onSave: (goal: string) => void;
}) {
  useT();
  const [goal, setGoal] = useState(initial);
  return (
    <Modal title={t("Edit goal")} onClose={onClose}>
      <div className="modal-form">
        <label>
          <span>{t("Goal")}</span>
          <textarea
            autoFocus
            rows={4}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          />
        </label>
        <div className="button-row">
          <button type="button" className="secondary" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => onSave(goal.trim())}
          >
            {t("Save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
