import { useEffect, useState } from "react";
import type { OfficeConnectedFile } from "../../shared/office-addin-api";
import { useApp } from "../app/AppContext";
import { Modal } from "../ui/Controls";
import { useT } from "../i18n";

export default function OfficeAddinDialog({ onClose }: { onClose(): void }) {
  const app = useApp();
  const t = useT();
  const [files, setFiles] = useState<OfficeConnectedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [handoffId, setHandoffId] = useState<string>();
  useEffect(() => {
    void window.desktop.officeConnectedFiles().then(setFiles).catch(app.report);
    return window.desktop.onEvent((event) => {
      if (event.type === "office-addin-files") setFiles(event.files);
    });
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      app.report(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Microsoft Office" onClose={onClose}>
      <ul className="settings-list">
        {files.map((file) => (
          <li key={file.id}>
            <span>{file.document}</span>
            <button
              className="secondary"
              aria-pressed={file.isSelected}
              disabled={busy}
              onClick={() =>
                void run(() => window.desktop.officeSelectFile(file.id))
              }
            >
              {t("Select")}
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(() => window.desktop.officeFocusFile(file.id))
              }
            >
              {t("Open")}
            </button>
          </li>
        ))}
      </ul>
      <div className="button-row">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void run(() => window.desktop.officeInstallAddin())}
        >
          {t("Get the add-in")}
        </button>
        {app.active && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const conversation = app.active;
                if (!conversation) return;
                const [file] = await window.desktop.chooseAttachments();
                if (!file) return;
                const turns = conversation.turns.slice(-40);
                const messages = turns
                  .flatMap((turn) => [
                    { role: "user", text: turn.prompt.slice(0, 100_000) },
                    ...turn.items
                      .filter(
                        (item) => item.type === "agentMessage" && item.text,
                      )
                      .map((item) => ({
                        role: "assistant",
                        text: item.text!.slice(0, 100_000),
                      })),
                  ])
                  .slice(-100);
                const result = await window.desktop.officeQueuePorterHandoff({
                  sessionId: conversation.id,
                  filePath: file.path,
                  title: conversation.title,
                  messages,
                  strippedToolCalls: turns
                    .flatMap((turn) => turn.items)
                    .filter((item) => item.type !== "agentMessage").length,
                  omittedByRenderer: conversation.turns.length - turns.length,
                });
                setHandoffId(result.handoffId);
              })
            }
          >
            {t("Continue in")}
          </button>
        )}
        {handoffId && (
          <button
            className="secondary"
            onClick={() =>
              void run(async () => {
                await window.desktop.officeCancelPorterHandoff(handoffId);
                setHandoffId(undefined);
              })
            }
          >
            {t("Cancel")}
          </button>
        )}
        <button className="primary" onClick={onClose}>
          {t("Done")}
        </button>
      </div>
    </Modal>
  );
}
