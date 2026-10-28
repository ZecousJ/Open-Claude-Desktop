import { useEffect, useState } from "react";
import { SettingsModal } from "../settings/controls";
import { t } from "../i18n";
import { api } from "../desktop-api";
import { ConfirmationDialog } from "../dialogs/ConfirmationDialog";

// Account-file editing.
export function CoworkMemoryFiles({
  onClose,
  onError,
}: {
  onClose(): void;
  onError(error: unknown): void;
}) {
  const [files, setFiles] =
    useState<Awaited<ReturnType<typeof api.listAccountMemories>>>();
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [deleting, setDeleting] = useState<string>();
  useEffect(() => {
    let disposed = false;
    void api
      .listAccountMemories()
      .then((value) => {
        if (!disposed) setFiles(value);
      })
      .catch(onError);
    return () => {
      disposed = true;
    };
  }, [revision, onError]);
  const change = async (work: () => Promise<boolean>) => {
    setBusy(true);
    try {
      if (!(await work()))
        throw new Error(t("Failed to save. You can try again."));
      setEditing(undefined);
      setRevision((value) => value + 1);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsModal
      title={editing ? t("Edit memory") : t("Memory")}
      showClose={!busy}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {editing ? (
        <>
          <textarea
            className="settings-textarea"
            autoFocus
            rows={12}
            style={{ maxHeight: "60vh", resize: "vertical" }}
            maxLength={262144}
            aria-label={t("Edit memory")}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="modal-actions">
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => setEditing(undefined)}
            >
              {t("Cancel")}
            </button>
            <button
              className="primary"
              type="button"
              disabled={busy}
              onClick={() =>
                void change(() => api.writeAccountMemory(editing, draft))
              }
            >
              {t(busy ? "Saving..." : "Save")}
            </button>
          </div>
        </>
      ) : (
        <>
          {files?.length === 0 && <p>{t("Nothing here yet.")}</p>}
          {files?.map((file) => (
            <div key={file.path} className="settings-row">
              <span>{file.path}</span>
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditing(file.path);
                  setDraft(file.content ?? "");
                }}
              >
                {t("Edit")}
              </button>
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => setDeleting(file.path)}
              >
                {t("Delete")}
              </button>
            </div>
          ))}
        </>
      )}
      {deleting && (
        <ConfirmationDialog
          confirmation={{
            title: t("Delete memory?"),
            body: t(
              "This memory will be permanently deleted. Claudex won’t reference it in future sessions.",
            ),
            action: async () => {
              if (!(await api.deleteAccountMemory(deleting)))
                throw new Error(t("Failed to save. You can try again."));
              setRevision((value) => value + 1);
            },
          }}
          onClose={() => setDeleting(undefined)}
          onError={onError}
        />
      )}
    </SettingsModal>
  );
}
