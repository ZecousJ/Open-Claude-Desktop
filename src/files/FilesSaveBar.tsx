import { t } from "../i18n";
import { Code, Eye } from "../ui/glyphs";
import type { FileDocuments, FileDocument } from "./file-documents";
import type { FilePreviewKind, Listing } from "./FilesPanel";
import type { MenuPosition } from "../ui/Menu";
import type { FilePreferences } from "./file-preferences";

/** What FilesSaveBar needs from FilesPanelView.tsx. */
export interface FilesSaveBarProps {
  active: string;
  documents: FileDocuments;
  list: (folder: string) => void;
  listings: Record<string, Listing>;
  previewKind: FilePreviewKind | undefined;
  navigation: {
    run: (
      resume: () => void,
      paths?: string[] | undefined,
      scope?: "session" | "pane" | "tab" | undefined,
      cancel?: (() => void) | undefined,
    ) => void;
    busy: boolean;
    prompt: React.JSX.Element | undefined;
  };
  pathMenu: MenuPosition | undefined;
  preferences: FilePreferences;
  rendered: boolean;
  saveProblems: {
    conflict: string;
    missing: string;
    denied: string;
    "hook-config": string;
    failed: string;
  };
  setPathMenu: React.Dispatch<React.SetStateAction<MenuPosition | undefined>>;
  setSourceViews: React.Dispatch<React.SetStateAction<Set<string>>>;
  shown: FileDocument | undefined;
}

export function FilesSaveBar({
  active,
  documents,
  list,
  listings,
  previewKind,
  navigation,
  pathMenu,
  preferences,
  rendered,
  saveProblems,
  setPathMenu,
  setSourceViews,
  shown,
}: FilesSaveBarProps) {
  return (
    <div className="files-save-bar">
      <button
        type="button"
        className="files-path"
        aria-haspopup="menu"
        aria-expanded={!!pathMenu}
        title={active}
        data-no-translate
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setPathMenu({ left: rect.left, top: rect.bottom + 4 });
          const parent = active.includes("/")
            ? active.slice(0, active.lastIndexOf("/"))
            : "";
          if (!listings[parent]) list(parent);
        }}
      >
        {active}
      </button>
      <span className="files-save-gap" />
      {previewKind && (
        <button
          type="button"
          className="changes-icon-button"
          aria-label={rendered ? t("View source") : t("Preview")}
          title={rendered ? t("View source") : t("Preview")}
          onClick={() =>
            setSourceViews((current) => {
              const next = new Set(current);
              if (next.has(active)) next.delete(active);
              else next.add(active);
              return next;
            })
          }
        >
          {rendered ? <Code size={16} /> : <Eye size={16} />}
        </button>
      )}
      {shown?.state === "ready" &&
        ((shown.dirty && !preferences.autoSave) ||
          shown.problem ||
          shown.saving) && (
          <>
            {shown.problem && (
              <span role="alert">{t(saveProblems[shown.problem])}</span>
            )}
            {shown.saving && <span role="status">{t("Saving…")}</span>}
            {shown.problem && (
              <button
                className="secondary"
                disabled={shown.saving}
                onClick={() =>
                  navigation.run(() => {
                    documents.revert(active!);
                    void documents.open(active!, true);
                  }, [active!])
                }
              >
                {t("Reload file")}
              </button>
            )}
            <button
              className="files-cancel"
              disabled={shown.saving}
              onClick={() => documents.revert(active!)}
            >
              {t("Cancel")}
            </button>
            <button
              className="secondary"
              disabled={!shown.dirty || shown.saving}
              onClick={() => void documents.save(active!)}
            >
              {t("Save")}
            </button>
          </>
        )}
    </div>
  );
}
