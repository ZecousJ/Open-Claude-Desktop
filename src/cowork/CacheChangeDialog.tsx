import { cacheChangeBodies, cacheChangeTitles } from "./cache-change-copy";
import type { CacheChangeKind } from "../../shared/cowork-cache";
import { formatText, t } from "../i18n";
import { Modal } from "../ui/Controls";
import "./cache-change.css";

export default function CacheChangeDialog({
  kind,
  targetLabel,
  onClose,
  onConfirm,
}: {
  kind: CacheChangeKind;
  targetLabel: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [before, after = ""] = t(cacheChangeBodies[kind]).split(
    "<bold>{targetLabel}</bold>",
  );
  return (
    <Modal
      title={t(cacheChangeTitles[kind])}
      variant="confirm"
      className="cache-change-dialog"
      onClose={onClose}
    >
      <p className="confirm-body">
        {before}
        <strong>{targetLabel}</strong>
        {after}
      </p>
      <footer>
        <button className="secondary" onClick={onClose}>
          {t("Cancel")}
        </button>
        <button className="primary" onClick={onConfirm}>
          {formatText("Switch to {targetLabel}", { targetLabel })}
        </button>
      </footer>
    </Modal>
  );
}
