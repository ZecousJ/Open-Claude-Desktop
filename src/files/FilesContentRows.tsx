import { t, formatText } from "../i18n";
import { FileTypeIcon } from "../code-tools/FileTypeIcon";
import { File as FileIcon } from "../ui/glyphs";
import { contentMatchPreview } from "./FilesPanel";
import type { ProjectSearchResult } from "../../shared/project-files";

/** What FilesContentRows needs from FilesPanelView.tsx. */
export interface FilesRowsBlockProps {
  contentQuery: string;
  contentResult: ProjectSearchResult | undefined;
  openFile: (
    path: string,
    line?: number | undefined,
    keep?: boolean | undefined,
  ) => void;
  searchFailed: boolean;
  searching: boolean;
}

export function FilesContentRows({
  contentQuery,
  contentResult,
  openFile,
  searchFailed,
  searching,
}: FilesRowsBlockProps) {
  return (
    <div className="files-rows" aria-live="polite">
      {!contentQuery ? (
        <p className="files-search-note">
          {t("Type after ? to search in files")}
        </p>
      ) : searching ? (
        <p className="files-search-note" role="status">
          {t("Searching files")}
        </p>
      ) : searchFailed ? (
        <p className="files-search-note" role="alert">
          {t("Couldn’t read this folder.")}
        </p>
      ) : !contentResult?.matches.length ? (
        <p className="files-search-note">{t("No matches in file contents")}</p>
      ) : (
        contentResult.matches.map((match, index, matches) => (
          <div key={`${match.path}:${match.line}`}>
            {(index === 0 || matches[index - 1].path !== match.path) && (
              <button
                type="button"
                className="files-row"
                onClick={() => openFile(match.path)}
              >
                <FileTypeIcon
                  path={match.path}
                  fallback={<FileIcon size={16} />}
                />
                <span className="files-name">{match.path}</span>
              </button>
            )}
            <button
              type="button"
              className="files-search-match"
              onClick={() => {
                openFile(match.path, match.line);
              }}
            >
              <span className="files-search-line">{match.line}</span>
              <span className="files-search-preview">
                {contentMatchPreview(match.preview.trim(), contentQuery)}
              </span>
            </button>
          </div>
        ))
      )}
      {contentResult?.truncated && (
        <p className="files-search-note">
          {contentResult.matches.length === 1
            ? t("Only 1 match is shown. Keep typing to narrow.")
            : formatText(
                "Only {count} matches are shown. Keep typing to narrow.",
                { count: contentResult.matches.length },
              )}
        </p>
      )}
    </div>
  );
}
