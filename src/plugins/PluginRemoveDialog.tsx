import { useLayoutEffect, useRef, useState } from "react";
import { Modal } from "../ui/Controls";
import { useT } from "../i18n";
import { pluginErrorText } from "./plugin-model";
import { isPluginOperationRetired } from "./usePlugins";
import "./plugin-detail-actions.css";

/** c24c8737b:3144–3178 confirms Remove before G.uninstall. This backend
 * only uninstalls a marketplace entry; it never deletes a shared publication,
 * so c3bb81cd1:78–85's reversible copy is the truthful branch. */
export function PluginRemoveDialog({
  id,
  remove,
  isCurrent,
  onClose,
}: {
  id: string;
  remove(id: string): Promise<void>;
  isCurrent(): boolean;
  onClose(): void;
}) {
  const t = useT();
  const mounted = useRef(false);
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () => mounted.current && isCurrent();
  const close = () => {
    if (current() && !lock.current) onClose();
  };
  const submit = async () => {
    if (!current() || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await remove(id);
      if (current()) onClose();
    } catch (reason) {
      if (current() && !isPluginOperationRetired(reason))
        setError(pluginErrorText(reason));
    } finally {
      if (current()) {
        lock.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <Modal
      title={t("Remove plugin?")}
      variant="confirm"
      onClose={close}
      confirmFocus="cancel"
    >
      <p className="confirm-body">
        {t(
          "This plugin’s commands and skills will no longer be available. You can add it back later.",
        )}
      </p>
      {error && (
        <p className="plugin-remove-failure" role="alert">
          {error}
        </p>
      )}
      <div className="button-row" aria-busy={busy || undefined}>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={close}
        >
          {t("Cancel")}
        </button>
        <button
          type="button"
          className="primary danger-button"
          disabled={busy}
          onClick={() => void submit()}
        >
          {t(busy ? "Removing…" : "Remove")}
        </button>
      </div>
    </Modal>
  );
}
