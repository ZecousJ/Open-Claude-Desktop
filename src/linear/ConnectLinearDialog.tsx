import { useState } from "react";
import { api } from "../desktop-api";
import { SettingsModal } from "../settings/controls";

export default function ConnectLinearDialog({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: () => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <SettingsModal title="Connect Linear" onClose={onClose}>
      <form
        className="desktop-skill-form desktop-connector-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !key.trim()) return;
          setBusy(true);
          setFailed(false);
          void api
            .linearConnect(key)
            .then(
              () => {
                setKey("");
                onConnected();
                onClose();
              },
              () => setFailed(true),
            )
            .finally(() => setBusy(false));
        }}
      >
        <label htmlFor="linear-key">API key</label>
        <input
          id="linear-key"
          className="settings-input"
          type="password"
          autoFocus
          autoComplete="off"
          maxLength={4096}
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <button
          type="button"
          className="link-button"
          onClick={() =>
            void api.openExternal(
              "https://linear.app/settings/account/security",
            )
          }
        >
          Create a Linear API key
        </button>
        {failed && <p role="alert">Something went wrong. You can try again.</p>}
        <div className="button-row">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || !key.trim()}
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </form>
    </SettingsModal>
  );
}
