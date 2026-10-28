import { useState } from "react";
import { sharedArtifactToken } from "../../shared/shared-artifact-import";
import { t } from "../i18n";
import { Modal } from "../ui/Controls";

/** Link-import copy and small popup. Tokens identify Claudex hosted shares. */
export function ImportSharedArtifactDialog({
  onClose,
  onImport,
  onError,
}: {
  onClose(): void;
  onImport(token: string): Promise<void>;
  onError(error: unknown): void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const token = sharedArtifactToken(value);
  const submit = async () => {
    if (busy || !token) return;
    setBusy(true);
    try {
      await onImport(token);
      onClose();
    } catch {
      onError(new Error(t("Failed to import shared artifact.")));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("Import shared artifact")}
      variant="confirm"
      showClose={false}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p>
        {t("Paste a shared artifact link to add a copy to your artifacts.")}
      </p>
      <input
        dir="ltr"
        autoFocus
        value={value}
        aria-label={t("Import shared artifact")}
        placeholder="https://…/s/…"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submit();
        }}
      />
      <footer>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={onClose}
        >
          {t("Cancel")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !token}
          onClick={() => void submit()}
        >
          {t("Import")}
        </button>
      </footer>
    </Modal>
  );
}
