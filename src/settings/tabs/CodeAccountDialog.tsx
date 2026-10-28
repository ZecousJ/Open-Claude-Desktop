import { useEffect, useState } from "react";
import { api } from "../../desktop-api";
import { Spinner } from "../../ui/Spinner";
import { Button, Row, SettingsModal, Toggle } from "../controls";

/** Confirmation and account toggles. */
export default function CodeAccountDialog({
  kind,
  onClose,
  onError,
}: {
  kind: "delete" | "sharing";
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<{
    requireRepositoryAccess: boolean;
    showName: boolean;
  }>();
  const [failed, setFailed] = useState(false);
  const load = () => {
    setFailed(false);
    void api
      .codeSharingSettings()
      .then(setSettings)
      .catch((error) => {
        setFailed(true);
        onError(error);
      });
  };
  useEffect(() => {
    if (kind === "sharing") load();
  }, [kind]);
  const save = async (
    key: "requireRepositoryAccess" | "showName",
    value: boolean,
  ) => {
    if (busy || !settings) return;
    const previous = settings;
    setBusy(true);
    setSettings({ ...settings, [key]: value });
    try {
      setSettings(await api.codeSharingSettings({ [key]: value }));
    } catch (error) {
      setSettings(previous);
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.deleteStoredCodeSessions();
      onClose();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsModal
      title={
        kind === "delete"
          ? "Delete sessions stored by your Claudex service?"
          : "Sharing settings"
      }
      variant={kind === "delete" ? "confirm" : "default"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {kind === "delete" ? (
        <>
          <p>
            Your Claudex service’s copies of your Claudex Code sessions will be
            permanently deleted. Sessions on your computer aren’t affected. This
            can’t be undone.
          </p>
          <div className="modal-actions">
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button danger disabled={busy} onClick={() => void remove()}>
              Delete stored sessions
            </Button>
          </div>
        </>
      ) : settings ? (
        <>
          <Row
            label="Require repository access"
            description="Only users with repository access can view your shared sessions."
          >
            <Toggle
              label="Require repository access"
              checked={settings.requireRepositoryAccess}
              disabled={busy}
              onChange={(value) => void save("requireRepositoryAccess", value)}
            />
          </Row>
          <Row
            label="Show your name"
            description="Your name appears on sessions you share."
          >
            <Toggle
              label="Show your name"
              checked={settings.showName}
              disabled={busy}
              onChange={(value) => void save("showName", value)}
            />
          </Row>
        </>
      ) : failed ? (
        <Button onClick={load}>Try again</Button>
      ) : (
        <Spinner />
      )}
    </SettingsModal>
  );
}
