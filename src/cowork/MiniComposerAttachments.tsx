import { t } from "../i18n";
import { AppIcon } from "../ui/app-icon";
import { openImageGroup } from "../lightbox/open";

export interface MiniComposerFile {
  id: string;
  name: string;
  status: "uploading" | "done" | "error";
  preview?: string;
}

// Compact chips.
export function MiniComposerAttachments({
  files,
  onRemove,
}: {
  files: MiniComposerFile[];
  onRemove: (id: string) => void;
}) {
  if (!files.length) return null;
  return (
    <div className="mini-composer-attachments">
      {files.map((file) => (
        <div className="mini-composer-chip" key={file.id}>
          {file.preview && (
            <button
              type="button"
              aria-label={t("Preview image")}
              onClick={(event) =>
                openImageGroup(
                  event.currentTarget.closest(".mini-composer-attachments"),
                  event.currentTarget,
                  "img",
                  t("Attached image"),
                )
              }
            >
              <img src={file.preview} alt="" />
            </button>
          )}
          <span className="mini-composer-file-name">
            <bdi dir="auto">{file.name}</bdi>
          </span>
          {file.status === "uploading" && (
            <span
              role="status"
              aria-label={t("Uploading")}
              className="mini-composer-spinner"
            />
          )}
          {file.status === "error" && (
            <span className="mini-composer-file-error">{t("!")}</span>
          )}
          <button
            type="button"
            className="mini-composer-file-remove"
            aria-label={t("Remove file")}
            onClick={() => onRemove(file.id)}
          >
            <AppIcon name="X" />
          </button>
        </div>
      ))}
    </div>
  );
}
