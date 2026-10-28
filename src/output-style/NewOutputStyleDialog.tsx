import { useState } from "react";
import { Modal } from "../ui/Controls";
import { t, useT } from "../i18n";

export default function NewOutputStyleDialog({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (name: string, prompt: string) => void;
}) {
  useT();
  const [prompt, setPrompt] = useState(() =>
    t("Short answers first, then detail. No filler words."),
  );
  const [name, setName] = useState("");
  const description = prompt.trim();
  const styleName = name.trim() || t("Custom style");
  return (
    <Modal title={t("New output style")} onClose={onClose}>
      <div className="modal-form">
        <label>
          <span>{t("What should the style be like?")}</span>
          <textarea
            autoFocus
            rows={4}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <label>
          <span>{t("Name (optional)")}</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="button-row">
          <button type="button" className="secondary" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!description}
            onClick={() => onSave(styleName, description)}
          >
            {t("Create style")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
