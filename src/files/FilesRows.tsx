import { ChevronRight, Folder, File as FileIcon } from "../ui/glyphs";
import { FileTypeIcon } from "../code-tools/FileTypeIcon";
import { t } from "../i18n";
import type { Listing } from "./FilesPanel";
import type { ProjectEntry } from "../../shared/project-files";

/** What FilesRows needs from FilesPanelView.tsx. */
export interface FilesRowsProps {
  active: string | undefined;
  listings: Record<string, Listing>;
  needle: string;
  open: Set<string>;
  openFile: (
    path: string,
    line?: number | undefined,
    keep?: boolean | undefined,
  ) => void;
  revealed: string | undefined;
  root: { state: "ready"; entries: ProjectEntry[]; truncated: boolean };
  rows: { entry: ProjectEntry; depth: number }[];
  toggleFolder: (folder: string) => void;
}

export function FilesRows({
  active,
  listings,
  needle,
  open,
  openFile,
  revealed,
  root,
  rows,
  toggleFolder,
}: FilesRowsProps) {
  return (
    <div role="tree" className="files-rows">
      {rows.map(({ entry, depth }) => {
        const listing = listings[entry.path];
        const folderOpen =
          entry.kind === "folder" && (open.has(entry.path) || !!needle);
        return (
          <div key={entry.path}>
            <button
              type="button"
              role="treeitem"
              aria-expanded={entry.kind === "folder" ? folderOpen : undefined}
              aria-selected={entry.path === active}
              data-revealed={entry.path === revealed || undefined}
              className="files-row"
              style={{ paddingInlineStart: 6 + depth * 12 }}
              title={entry.path}
              onClick={() =>
                entry.kind === "folder"
                  ? toggleFolder(entry.path)
                  : openFile(entry.path)
              }
              onDoubleClick={() => {
                if (entry.kind === "file")
                  openFile(entry.path, undefined, true);
              }}
            >
              {entry.kind === "folder" ? (
                <>
                  <ChevronRight
                    size={12}
                    className="files-caret"
                    data-open={folderOpen || undefined}
                  />
                  <Folder size={14} />
                </>
              ) : (
                <>
                  <FileTypeIcon
                    path={entry.path}
                    fallback={<FileIcon size={16} />}
                  />
                </>
              )}
              <span className="files-name" data-no-translate>
                {entry.name}
              </span>
            </button>
            {folderOpen && listing?.state === "loading" && (
              <p
                className="files-note inline"
                style={{ paddingInlineStart: 30 + depth * 12 }}
              >
                {t("Listing this folder")}
              </p>
            )}
            {folderOpen && listing?.state === "error" && (
              <p
                className="files-note inline"
                style={{ paddingInlineStart: 30 + depth * 12 }}
              >
                {t("Couldn’t read this folder.")}
              </p>
            )}
            {folderOpen &&
              !needle &&
              listing?.state === "ready" &&
              !listing.entries.length && (
                <p
                  className="files-note inline"
                  style={{ paddingInlineStart: 30 + depth * 12 }}
                >
                  {t("Folder is empty")}
                </p>
              )}
          </div>
        );
      })}
      {root.truncated && (
        <p className="files-note">
          {t("Some entries may not be listed. Keep typing to narrow.")}
        </p>
      )}
    </div>
  );
}
