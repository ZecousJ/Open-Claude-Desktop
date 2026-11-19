import { t } from "../i18n";
import type { ReactNode } from "react";
import type { Props } from "./BlankArtifactEditor";
import type { useBlankArtifactDocument } from "./useBlankArtifact";

export function BlankArtifactWorkspace({
  source,
  renderEditor,
}: {
  source: ReturnType<typeof useBlankArtifactDocument>;
  renderEditor: (
    props: Pick<Props, "content" | "onChange" | "readOnly" | "status">,
  ) => ReactNode;
}) {
  const showSaveStatus =
    !source.error &&
    !source.conflict &&
    (!source.dirty || source.saving || !source.readOnly);
  return (
    <>
      {source.waiting && (
        <div className="blank-editor-error" role="status">
          <span>
            {t("Changes are still being saved. Try again in a moment.")}
          </span>
          <button type="button" onClick={source.cancelNavigation}>
            {t("Keep editing")}
          </button>
        </div>
      )}
      {Boolean(source.error) && (
        <div className="blank-editor-error" role="alert">
          <span>
            {source.error instanceof Error
              ? source.error.message
              : t("Couldn’t load this.")}
          </span>
          <button type="button" onClick={source.retry}>
            {t("Retry")}
          </button>
          {source.dirty && (
            <button type="button" onClick={source.reload}>
              {t("Reload saved version")}
            </button>
          )}
        </div>
      )}
      {source.conflict && (
        <div className="blank-editor-error" role="alert">
          <span>
            {t("The saved file changed. Your unsaved edits are still here.")}
          </span>
          <button type="button" onClick={source.reload}>
            {t("Reload saved version")}
          </button>
        </div>
      )}
      {source.loading ? (
        <div className="blank-editor-loading" role="status">
          {t("Loading artifact…")}
        </div>
      ) : (
        source.document &&
        source.content !== undefined &&
        renderEditor({
          content: source.content,
          onChange: source.change,
          readOnly: source.readOnly,
          status: showSaveStatus
            ? source.saving || source.dirty
              ? t("Saving…")
              : t("Saved")
            : "",
        })
      )}
    </>
  );
}
