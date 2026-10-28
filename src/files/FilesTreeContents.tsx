import { Search, X } from "../ui/glyphs";
import { t } from "../i18n";
import { FilesContentRows } from "./FilesContentRows";
import { FilesRows } from "./FilesRows";
import type { FilesBridge, Listing } from "./FilesPanel";
import type {
  ProjectSearchResult,
  ProjectEntry,
} from "../../shared/project-files";
import type { Conversation } from "../../shared/types";

/** What FilesTreeContents needs from FilesPanelView.tsx. */
export interface FilesTreeContentsProps {
  active: string | undefined;
  bridge: FilesBridge;
  contentQuery: string;
  contentResult: ProjectSearchResult | undefined;
  contentSearch: boolean;
  conversation: Conversation;
  filter: string;
  filterRef: React.RefObject<HTMLInputElement | null>;
  listings: Record<string, Listing>;
  needle: string;
  open: Set<string>;
  openFile: (
    path: string,
    line?: number | undefined,
    keep?: boolean | undefined,
  ) => void;
  panelRef: React.RefObject<HTMLElement | null>;
  revealed: string | undefined;
  root: Listing;
  rows: { entry: ProjectEntry; depth: number }[];
  searchFailed: boolean;
  searching: boolean;
  setFilter: React.Dispatch<React.SetStateAction<string>>;
  toggleFolder: (folder: string) => void;
}

export function FilesTreeContents({
  active,
  bridge,
  contentQuery,
  contentResult,
  contentSearch,
  conversation,
  filter,
  filterRef,
  listings,
  needle,
  open,
  openFile,
  panelRef,
  revealed,
  root,
  rows,
  searchFailed,
  searching,
  setFilter,
  toggleFolder,
}: FilesTreeContentsProps) {
  return (
    <div className="files-tree-contents">
      <div className="files-filter-box">
        <Search size={14} aria-hidden="true" />
        <input
          ref={filterRef}
          className="files-filter"
          type="text"
          value={filter}
          spellCheck={false}
          autoComplete="off"
          placeholder={
            bridge.searchProjectFiles
              ? t("Filter, or ? to search in files")
              : t("Filter files…")
          }
          aria-label={t("Filter files")}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && filter) {
              event.preventDefault();
              setFilter("");
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              panelRef.current
                ?.querySelector<HTMLElement>(".files-rows button")
                ?.focus();
            }
          }}
        />
        {filter && (
          <button
            type="button"
            aria-label={t("Clear filter")}
            onClick={() => {
              setFilter("");
              filterRef.current?.focus();
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>
      {contentSearch ? (
        <FilesContentRows
          contentQuery={contentQuery}
          contentResult={contentResult}
          openFile={openFile}
          searchFailed={searchFailed}
          searching={searching}
        />
      ) : !conversation.cwd ? (
        <p className="files-note">{t("Start the session to see its files")}</p>
      ) : !root || root.state === "loading" ? (
        <p className="files-note" role="status">
          {t("Listing this folder")}
        </p>
      ) : root.state === "error" ? (
        <p className="files-note" role="alert">
          {t("Couldn’t read this folder.")}
        </p>
      ) : !rows.length ? (
        <p className="files-note">
          {needle ? t("No matching files") : t("Folder is empty")}
        </p>
      ) : (
        <FilesRows
          active={active}
          listings={listings}
          needle={needle}
          open={open}
          openFile={openFile}
          revealed={revealed}
          root={root}
          rows={rows}
          toggleFolder={toggleFolder}
        />
      )}
    </div>
  );
}
