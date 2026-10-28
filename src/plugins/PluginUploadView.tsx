import { AppIcon } from "../ui/app-icon";
import {
  pluginTrustWarning,
  pluginArchiveTypes,
  pluginArchiveRule,
  pluginManifestRule,
} from "../../shared/plugin-upload";
import { UploadPageGroup } from "./PluginUploadDialog";
import { formatText, tc } from "../i18n";
import { Upload, File as FileIcon, X } from "../ui/glyphs";
import { formatFileSize } from "../collections/customize/skill-preview";
import { ConfirmationDialog } from "../dialogs/ConfirmationDialog";
import type { Row } from "./PluginUploadDialog";

/** What pluginUploadView needs from PluginUploadDialog.tsx. */
export interface PluginUploadViewKit {
  FileHeading: "h3" | "strong";
  added: number;
  attention: number;
  busy: boolean;
  failure: string;
  input: React.RefObject<HTMLInputElement | null>;
  onClose: () => void;
  ownsUpload: () => boolean;
  phase: "editing" | "saving" | "done";
  pick: (files: File[]) => void;
  presentation: "dialog" | "page";
  preview:
    | { name: string; description?: string | undefined; manifestName: string }
    | undefined;
  progress: { current: number; total: number };
  ready: Row[];
  replaceNote: string[];
  replacing: Row | undefined;
  retry: Row[];
  rows: Row[];
  run: (batch: Row[], overwrite?: boolean) => Promise<void>;
  setFailure: React.Dispatch<React.SetStateAction<string>>;
  setReplacing: React.Dispatch<React.SetStateAction<Row | undefined>>;
  setRows: React.Dispatch<React.SetStateAction<Row[]>>;
  update: (
    file: File,
    state:
      | "ready"
      | "waiting"
      | "uploading"
      | "added"
      | "taken"
      | "failed"
      | "skipped",
    message?: string | undefined,
  ) => void;
}

export function pluginUploadView(kit: PluginUploadViewKit) {
  const {
    FileHeading,
    added,
    attention,
    busy,
    failure,
    input,
    onClose,
    ownsUpload,
    phase,
    pick,
    presentation,
    preview,
    progress,
    ready,
    replaceNote,
    replacing,
    retry,
    rows,
    run,
    setFailure,
    setReplacing,
    setRows,
    update,
  } = kit;
  const pluginUploadViewView = (
    <>
      <div className="plugin-upload-content">
        <p>
          {rows.length > 1
            ? "Add plugins to your workspace from .zip or .plugin archives."
            : "Add a plugin to your workspace from a .zip or .plugin archive."}
        </p>
        <div className="plugin-upload-warning" role="note">
          <AppIcon name="Warning" size={16} />
          <span>{pluginTrustWarning}</span>
        </div>
        <UploadPageGroup
          page={presentation === "page"}
          className="plugin-upload-page-work"
        >
          <UploadPageGroup
            page={presentation === "page"}
            className="plugin-upload-page-files"
          >
            <div className="plugin-upload-label">
              <FileHeading>
                {rows.length > 1
                  ? formatText("Plugin files · {count}", { count: rows.length })
                  : "Plugin file"}
              </FileHeading>
              {phase === "editing" && rows.length > 0 && (
                <button type="button" onClick={() => input.current?.click()}>
                  Add more
                </button>
              )}
            </div>
            <input
              ref={input}
              type="file"
              hidden
              multiple
              accept={pluginArchiveTypes}
              aria-label="Plugin file"
              onChange={(event) => {
                pick(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            <div
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (phase === "editing")
                  pick(Array.from(event.dataTransfer.files));
              }}
            >
              {!rows.length ? (
                <button
                  type="button"
                  className="plugin-upload-drop"
                  onClick={() => input.current?.click()}
                >
                  <Upload size={presentation === "page" ? 24 : 20} />
                  Drag and drop plugin files here, or browse — you can add
                  several at once
                </button>
              ) : (
                <ul className="plugin-upload-files">
                  {rows.map((row, index) => (
                    <li key={index}>
                      <FileIcon size={16} />
                      <span className="plugin-upload-file-name">
                        {row.file.name}
                      </span>
                      <small>{formatFileSize(row.file.size)}</small>
                      {phase === "editing" ? (
                        <button
                          type="button"
                          aria-label={formatText("Remove {fileName}", {
                            fileName: row.file.name,
                          })}
                          onClick={() =>
                            setRows((current) =>
                              current.filter(
                                (_, position) => position !== index,
                              ),
                            )
                          }
                        >
                          <X size={16} />
                        </button>
                      ) : (
                        <>
                          <span role="status">
                            {row.state === "uploading"
                              ? "Uploading..."
                              : row.state === "waiting"
                                ? "Waiting"
                                : row.state === "added"
                                  ? tc("state", "Added")
                                  : row.state === "skipped"
                                    ? "Skipped"
                                    : row.state === "taken"
                                      ? formatText(
                                          "A plugin named {name} already exists",
                                          { name: row.message ?? "" },
                                        )
                                      : row.message}
                          </span>
                          {row.state === "taken" && (
                            <>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => setReplacing(row)}
                              >
                                Replace
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => update(row.file, "skipped")}
                              >
                                Skip
                              </button>
                            </>
                          )}
                          {row.state === "failed" && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void run([row])}
                            >
                              Try again
                            </button>
                          )}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {failure && (
              <div className="plugin-upload-warning" role="alert">
                {failure}
              </div>
            )}
            <ul className="plugin-upload-rules">
              {presentation === "dialog" && <li>{pluginArchiveRule}</li>}
              <li>{pluginManifestRule}</li>
            </ul>
          </UploadPageGroup>
          {preview && (
            <section className="plugin-upload-preview">
              <strong>Preview</strong>
              <span>{preview.name}</span>
              <p>
                {preview.description ||
                  formatText("No description found in {manifestName}", {
                    manifestName: preview.manifestName,
                  })}
              </p>
            </section>
          )}
          {phase === "done" && (
            <p role="status">
              {added
                ? formatText(
                    added === 1 ? "1 plugin added" : "{count} plugins added",
                    { count: added },
                  )
                : "No plugins were added."}
              {added > 0 && (
                <>
                  {" "}
                  —{" "}
                  <button type="button" onClick={onClose}>
                    {added === 1
                      ? "view it in Plugins"
                      : "view them in Plugins"}
                  </button>
                  .
                </>
              )}
              {attention > 0 &&
                ` ${formatText(attention === 1 ? "{count} needs your attention in the list." : "{count} need your attention in the list.", { count: attention })}`}
            </p>
          )}
          <div className="button-row">
            <button
              type="button"
              className="primary"
              disabled={busy || (phase === "editing" && !ready.length)}
              onClick={() =>
                phase === "done" && !retry.length
                  ? onClose()
                  : void run(phase === "done" ? retry : ready)
              }
            >
              {busy
                ? "Uploading..."
                : phase === "done"
                  ? retry.length
                    ? formatText(
                        retry.length === 1
                          ? "Retry 1 plugin"
                          : "Retry {count} plugins",
                        { count: retry.length },
                      )
                    : "Done"
                  : rows.length > 1
                    ? formatText("Upload {count} plugins", {
                        count: ready.length,
                      })
                    : "Upload"}
            </button>
            {phase !== "done" && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </button>
            )}
            {busy && (
              <span role="status">
                {formatText("Uploading {current} of {total}…", progress)}
              </span>
            )}
            {!rows.length && <span>Choose a file to continue.</span>}
          </div>
        </UploadPageGroup>
      </div>
      {replacing && (
        <ConfirmationDialog
          confirmation={{
            title: "Replace existing plugin?",
            body: formatText(
              "A plugin named “{pluginName}” is already installed. This will overwrite the current version with your local copy.",
              {
                pluginName: replacing.message ?? "",
              },
            ),
            confirm: "Replace",
            danger: true,
            confirmFocus: "cancel",
            action: async () => {
              await run([replacing], true);
            },
          }}
          onClose={() => {
            if (ownsUpload()) setReplacing(undefined);
          }}
          onError={(error) => {
            if (ownsUpload()) setFailure(String(error));
          }}
        >
          <p className="plugin-upload-replace-note">
            {replaceNote[0]}
            <code>{replaceNote[1]}</code>
            {replaceNote[2]}
          </p>
        </ConfirmationDialog>
      )}
    </>
  );
  return pluginUploadViewView;
}
