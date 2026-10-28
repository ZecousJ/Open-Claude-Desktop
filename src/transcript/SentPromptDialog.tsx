import { createPortal } from "react-dom";
import { Modal } from "../ui/Controls";
import { t } from "../i18n";

// Verbatim originals. Opened from a message inside the transcript's scroller,
// it is drawn on the page itself, as the menus are: inside, the scroller
// clipped it and centred it on itself rather than on the window.
export function SentPromptDialog({
  prompts,
  onClose,
}: {
  prompts: string[];
  onClose: () => void;
}) {
  const dialog = (
    <Modal
      title={t("Sent prompt")}
      onClose={onClose}
      wide
      className="sent-prompt-dialog"
    >
      <p className="sent-prompt-description">
        {t("The exact text Claudex received for this message, shown verbatim.")}
      </p>
      <div className="sent-prompt-blocks">
        {prompts.map((prompt, index) => (
          <pre key={`${index}-${prompt.slice(0, 16)}`}>{prompt}</pre>
        ))}
      </div>
    </Modal>
  );
  return typeof document === "undefined"
    ? dialog
    : createPortal(dialog, document.body);
}
