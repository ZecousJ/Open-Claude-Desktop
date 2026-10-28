import { useEffect, useRef, useState } from "react";
import type {
  PendingKnowledgeFile,
  ProjectKnowledgePendingAPI,
} from "../../../shared/project-knowledge-pending";
import type { ProjectKnowledge } from "../../../shared/collections-api";
import { knowledgeEncodings } from "../../../shared/project-knowledge-encoding";
import { Modal } from "../../ui/Controls";
import { formatText, t, useLocale } from "../../i18n";
import "./knowledge-encoding.css";

/**
 * Lazy source-backed encoding choice. Preview is inert reference text. Closing
 * leaves the durable pending file.
 */
export function KnowledgeEncodingDialog({
  projectId,
  file,
  api,
  owns,
  onClose,
  onDone,
}: {
  projectId: string;
  file: PendingKnowledgeFile;
  api: ProjectKnowledgePendingAPI;
  owns(): boolean;
  onClose(): void;
  onDone(result: ProjectKnowledge): void;
}) {
  useLocale();
  const [encoding, setEncoding] = useState("utf-8"),
    [preview, setPreview] = useState<string>(),
    [error, setError] = useState<string>(),
    [attempt, setAttempt] = useState(0),
    [busy, setBusy] = useState(false);
  const latest = useRef(owns);
  latest.current = owns;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const current = () => alive.current && latest.current();
  useEffect(() => {
    let live = true;
    setPreview(undefined);
    setError(undefined);
    Promise.resolve()
      .then(() => {
        if (live && current())
          return api.previewProjectKnowledgeEncoding(
            projectId,
            file.id,
            encoding,
          );
      })
      .then(
        (result) => {
          if (live && current() && result) setPreview(result.text);
        },
        (reason: unknown) => {
          if (live && current())
            setError(reason instanceof Error ? reason.message : String(reason));
        },
      );
    return () => {
      live = false;
    };
  }, [api, projectId, file.id, encoding, attempt]);
  const confirm = async () => {
    if (!current() || busy || preview === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.confirmProjectKnowledgeEncoding(
        projectId,
        file.id,
        encoding,
      );
      if (current()) onDone(result);
    } catch (reason) {
      if (current())
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (current()) setBusy(false);
    }
  };
  return (
    <Modal
      title="Choose how to read this file"
      className="prj-knowledge-encoding"
      onClose={() => {
        if (!busy) onClose();
      }}
      showClose={false}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <p>
          {formatText(
            "The text encoding for {fileName} could not be determined. Choose an encoding and verify with the preview.",
            { fileName: file.name },
          )}
        </p>
        <select
          aria-label={t("Select file encoding")}
          value={encoding}
          disabled={busy}
          onChange={(event) => setEncoding(event.target.value)}
        >
          {knowledgeEncodings.map(([value, label]) => (
            <option key={value} value={value}>
              {t(label)}
            </option>
          ))}
        </select>
        {preview === undefined && !error && (
          <p role="status">{t("Loading file…")}</p>
        )}
        {preview !== undefined && (
          <pre aria-label={t("File preview")} data-no-translate>
            {preview}
          </pre>
        )}
        {error && (
          <div role="alert">
            <p>{t(error)}</p>
            {preview === undefined && (
              <button
                type="button"
                className="secondary"
                onClick={() => setAttempt((value) => value + 1)}
              >
                {t("Retry")}
              </button>
            )}
          </div>
        )}
        <div className="button-row">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            {t("Cancel")}
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || preview === undefined}
          >
            {t("Confirm")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
