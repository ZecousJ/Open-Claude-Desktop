import type { ReactNode } from "react";
import {
  Folder,
  List,
  File as FileIcon,
  X,
  Search,
  Minimize2,
  Maximize2,
} from "../ui/glyphs";
import { t, formatText } from "../i18n";
import { Spinner } from "../ui/Spinner";
import {
  baseName,
  MarkdownDocument,
  FileCodeEditor,
  ArtifactPreview,
  type FilePreviewKind,
} from "./FilesPanel";
import { Suspense } from "react";
import type { MenuEntry, MenuPosition } from "../ui/Menu";
import { moveFileTab, nextFileTab } from "./file-tabs";
import { FileTypeIcon } from "../code-tools/FileTypeIcon";
import { FilesSettings } from "./FilesSettings";
import { ResizeHandle } from "../ui/ResizeHandle";
import { Menu } from "../ui/Menu";
import type { FilesBridge, Listing } from "./FilesPanel";
import type {
  ProjectSearchResult,
  ProjectEntry,
} from "../../shared/project-files";
import type { Conversation } from "../../shared/types";
import type { FileDocuments, FileDocument } from "./file-documents";
import type { EditorView } from "@codemirror/view";
import type { FileEditorCache } from "./FileCodeEditor";
import type { FilePreferences } from "./file-preferences";
import { FilesSaveBar } from "./FilesSaveBar";
import { FilesTreeContents } from "./FilesTreeContents";

/** What filesPanelView needs from FilesPanel.tsx. */
export interface FilesPanelViewKit {
  activateFile: (path: string, focus?: boolean) => void;
  active: string | undefined;
  bridge: FilesBridge;
  close: (path: string, how: "file" | "others" | "right" | "all") => void;
  contentQuery: string;
  contentResult: ProjectSearchResult | undefined;
  contentSearch: boolean;
  conversation: Conversation;
  currentTabs: React.RefObject<string[]>;
  documents: FileDocuments;
  editor: React.RefObject<EditorView | undefined>;
  editorCache: FileEditorCache;
  expanded: boolean;
  files: Readonly<Record<string, FileDocument>>;
  filter: string;
  filterRef: React.RefObject<HTMLInputElement | null>;
  focusFilter: () => void;
  focusedTab: string | undefined;
  jumpToLine: (view: EditorView) => void;
  keepFile: (path: string) => void;
  list: (folder: string) => void;
  listings: Record<string, Listing>;
  /** What the file can show besides its source. */
  previewKind: FilePreviewKind | undefined;
  menu: { path: string; position: MenuPosition } | undefined;
  navigation: {
    run: (
      resume: () => void,
      paths?: string[],
      scope?: "session" | "pane" | "tab",
      cancel?: (() => void) | undefined,
    ) => void;
    busy: boolean;
    prompt: React.JSX.Element | undefined;
  };
  needle: string;
  onClose: () => void;
  open: Set<string>;
  openFile: (path: string, line?: number | undefined, keep?: boolean) => void;
  panelRef: React.RefObject<HTMLElement | null>;
  pathMenu: MenuPosition | undefined;
  preferences: FilePreferences;
  preview: string | undefined;
  /** The file shows rendered (its preview) instead of its source. */
  rendered: boolean;
  reveal: (path: string) => void;
  revealed: string | undefined;
  root: Listing;
  rows: { entry: ProjectEntry; depth: number }[];
  searchFailed: boolean;
  searching: boolean;
  setExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  setFilter: React.Dispatch<React.SetStateAction<string>>;
  setFocusedTab: React.Dispatch<React.SetStateAction<string | undefined>>;
  setMenu: React.Dispatch<
    React.SetStateAction<{ path: string; position: MenuPosition } | undefined>
  >;
  setPathMenu: React.Dispatch<React.SetStateAction<MenuPosition | undefined>>;
  setPreferences: (patch: Partial<FilePreferences>) => void;
  setSourceViews: React.Dispatch<React.SetStateAction<Set<string>>>;
  setTabs: React.Dispatch<React.SetStateAction<string[]>>;
  setTreeOpen: React.Dispatch<React.SetStateAction<boolean>>;
  shown: FileDocument | undefined;
  tabRefs: React.RefObject<Map<string, HTMLDivElement>>;
  tabs: string[];
  tabsId: string;
  toggleFolder: (folder: string) => void;
  tree: {
    body: React.RefObject<HTMLDivElement | null>;
    width: number;
    dragging: boolean;
    edgeDrag: boolean;
    props: (edge: boolean) => {
      dragging: boolean;
      "aria-valuenow": number;
      "aria-valuemin": number;
      "aria-valuemax": number;
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
      onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
      onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
      onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
      onLostPointerCapture: (e: React.PointerEvent<HTMLDivElement>) => void;
      onStep: (step: number) => void;
      onActivate: () => void;
      onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
    };
  };
  treeOpen: boolean;
  /** The tree on the pane's right (File tree position, tree-position.ts). */
  onRight: boolean;
}

export function filesPanelView(kit: FilesPanelViewKit) {
  const {
    activateFile,
    active,
    bridge,
    close,
    contentQuery,
    contentResult,
    contentSearch,
    conversation,
    currentTabs,
    documents,
    editor,
    editorCache,
    expanded,
    files,
    filter,
    filterRef,
    focusFilter,
    focusedTab,
    jumpToLine,
    keepFile,
    list,
    listings,
    previewKind,
    menu,
    navigation,
    needle,
    onClose,
    open,
    openFile,
    panelRef,
    pathMenu,
    preferences,
    preview,
    rendered,
    reveal,
    revealed,
    root,
    rows,
    searchFailed,
    searching,
    setExpanded,
    setFilter,
    setFocusedTab,
    setMenu,
    setPathMenu,
    setPreferences,
    setSourceViews,
    setTabs,
    setTreeOpen,
    shown,
    tabRefs,
    tabs,
    tabsId,
    toggleFolder,
    tree,
    treeOpen,
    onRight,
  } = kit;
  let body: ReactNode;
  if (!active)
    body = (
      <div className="files-empty files-welcome">
        <Folder size={24} strokeWidth={1.5} aria-hidden="true" />
        <span>{t("Open files appear here")}</span>
        <small>
          {t(
            "Pick a file in the tree, or click a file path in the conversation.",
          )}
        </small>
      </div>
    );
  else if (!shown || shown.state === "loading")
    body = (
      <p className="files-empty" role="status" aria-label={t("Loading…")}>
        <Spinner inheritColor size={14} className="spin" aria-hidden="true" />
        {formatText("Reading {file}", { file: baseName(active) })}
      </p>
    );
  else if (shown.state === "error")
    body = (
      <p className="files-empty" role="alert">
        {shown.message}
      </p>
    );
  else if (shown.file.tooLarge)
    body = (
      <p className="files-empty">
        {formatText(
          "The file is too large to preview. Maximum size is {limit} MB.",
          {
            limit: Math.round((shown.file.limitBytes ?? 0) / 1048576),
          },
        )}
      </p>
    );
  else if (shown.file.binary || shown.file.invalidEncoding)
    body = (
      <p className="files-empty">{t("This file type can’t be previewed.")}</p>
    );
  else if (rendered && previewKind !== "markdown")
    // An HTML or SVG file as a page, in the same sandboxed frame as an
    // artifact (the original's "sandbox" view).
    body = (
      <Suspense
        fallback={
          <p className="files-empty" role="status">
            <Spinner size={14} />
          </p>
        }
      >
        <ArtifactPreview
          artifact={{
            id: `file:${conversation.id}:${active}`,
            name: baseName(active),
            filename: baseName(active),
            language: previewKind ?? "html",
            content: shown.value,
            surface: "file",
            conversationId: conversation.id,
            // Its stylesheets and scripts beside it run inline (ArtifactPreview).
            sourcePath: active,
          }}
          refresh={0}
          onError={() => {}}
          onDownload={() => {}}
        />
      </Suspense>
    );
  else if (rendered)
    body = (
      <Suspense
        fallback={
          <p className="files-empty" role="status">
            <Spinner size={14} />
          </p>
        }
      >
        <MarkdownDocument text={shown.value} asDocument />
      </Suspense>
    );
  else
    body = (
      <Suspense
        fallback={
          <p className="files-empty" role="status">
            <Spinner
              inheritColor
              size={14}
              className="spin"
              aria-hidden="true"
            />
          </p>
        }
      >
        <FileCodeEditor
          key={active}
          path={active}
          cacheKey={active}
          value={shown.value}
          reload={shown.reload}
          editable={documents.writable(active)}
          preferences={preferences}
          cache={editorCache}
          canCache={() => currentTabs.current.includes(active)}
          onChange={(value) => {
            keepFile(active);
            documents.edit(active, value);
          }}
          onSave={(reason) =>
            void (reason === "blur"
              ? documents.saveOnBlur(active)
              : documents.save(active))
          }
          onEscape={() => {
            if (!preferences.autoSave) documents.revert(active);
          }}
          onViewReady={(view) => {
            editor.current = view;
            if (view) jumpToLine(view);
          }}
        />
      </Suspense>
    );
  const tabIds = (path: string) => `${tabsId}-${encodeURIComponent(path)}`;
  const saveProblems = {
    conflict: "The file changed on disk. Reload it before saving your changes.",
    missing: "This file no longer exists on disk.",
    denied: "You don’t have permission to save this file.",
    "hook-config": "Changes to package hook configuration can’t be saved here.",
    failed: "Couldn’t save this file. Your changes are still in the editor.",
  };

  const tabMenu = (path: string): MenuEntry[] => {
    const index = tabs.indexOf(path);
    return [
      ...(preview === path
        ? [{ label: "Keep open", onSelect: () => keepFile(path) }]
        : []),
      { label: "Close file", onSelect: () => close(path, "file") },
      {
        label: "Close other files",
        disabled: tabs.length < 2,
        onSelect: () => close(path, "others"),
      },
      {
        label: "Close files to the right",
        disabled: index === tabs.length - 1,
        onSelect: () => close(path, "right"),
      },
      { label: "Close all files", onSelect: () => close(path, "all") },
      { separator: true },
      { label: "Reveal in file tree", onSelect: () => reveal(path) },
    ];
  };

  // The tree's toggle leads the bar, or comes before the bar's end buttons when
  // the tree is on the right.
  const treeToggle = (
    <button
      type="button"
      className="changes-icon-button"
      aria-label={treeOpen ? t("Hide file tree") : t("Show file tree")}
      title={treeOpen ? t("Hide file tree") : t("Show file tree")}
      aria-pressed={treeOpen}
      onClick={() => setTreeOpen(!treeOpen)}
    >
      <List size={16} strokeWidth={1.75} />
    </button>
  );
  const filesPanelViewView = (
    <aside
      ref={panelRef}
      tabIndex={-1}
      className={`work-panel files-panel${expanded ? " expanded" : ""}`}
      aria-label={t("Files")}
    >
      <header>
        {!onRight && treeToggle}
        {tabs.length > 0 && (
          <div
            className="files-tabs"
            role="tablist"
            aria-label={t("Open files")}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                setFocusedTab(undefined);
            }}
          >
            {tabs.map((path) => (
              <div
                key={path}
                ref={(node) => {
                  if (node) tabRefs.current.set(path, node);
                  else tabRefs.current.delete(path);
                }}
                id={tabIds(path)}
                aria-controls={`${tabIds(path)}-panel`}
                aria-describedby={`${tabsId}-instructions`}
                data-preview={preview === path || undefined}
                data-dirty={
                  (files[path]?.state === "ready" && files[path].dirty) ||
                  undefined
                }
                className="files-tab"
                role="tab"
                aria-label={baseName(path)}
                aria-selected={path === active}
                title={path}
                tabIndex={path === (focusedTab ?? active) ? 0 : -1}
                onFocus={() => setFocusedTab(path)}
                onClick={() => activateFile(path)}
                onDoubleClick={() => keepFile(path)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({
                    path,
                    position: { left: event.clientX, top: event.clientY },
                  });
                }}
                onKeyDown={(event) => {
                  if (
                    event.target !== event.currentTarget ||
                    event.nativeEvent.isComposing ||
                    event.repeat
                  )
                    return;
                  const mod = event.ctrlKey || event.metaKey;
                  if (
                    mod &&
                    event.shiftKey &&
                    !event.altKey &&
                    (event.key === "ArrowLeft" || event.key === "ArrowRight")
                  ) {
                    event.preventDefault();
                    const rtl = document.documentElement.dir === "rtl";
                    setTabs((tabs) =>
                      moveFileTab(
                        tabs,
                        path,
                        event.key === (rtl ? "ArrowLeft" : "ArrowRight")
                          ? 1
                          : -1,
                      ),
                    );
                  } else if (!mod && !event.altKey && !event.shiftKey) {
                    if (event.key === "Delete" || event.key === "Backspace") {
                      event.preventDefault();
                      close(path, "file");
                    } else {
                      const next = nextFileTab(
                        tabs,
                        path,
                        event.key,
                        document.documentElement.dir === "rtl",
                      );
                      if (next) {
                        event.preventDefault();
                        setFocusedTab(next);
                        tabRefs.current.get(next)?.focus();
                      } else if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        activateFile(path);
                      }
                    }
                  }
                }}
              >
                <FileTypeIcon path={path} fallback={<FileIcon size={16} />} />
                <span data-no-translate>{baseName(path)}</span>
                <button
                  type="button"
                  className="files-tab-close"
                  tabIndex={-1}
                  aria-label={formatText("Close {name}", {
                    name: baseName(path),
                  })}
                  onClick={(event) => {
                    event.stopPropagation();
                    close(path, "file");
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {!tabs.length && <strong className="files-title">{t("Files")}</strong>}
        {!tabs.length && <span className="changes-header-gap" />}
        <button
          type="button"
          className="changes-icon-button"
          aria-label={t("Go to file or search")}
          title={t("Go to file or search")}
          onClick={focusFilter}
        >
          <Search size={16} />
        </button>
        {onRight && treeToggle}
        <FilesSettings
          preferences={preferences}
          onChange={setPreferences}
          treeOpen={treeOpen}
          onTreeChange={setTreeOpen}
          writable={
            !!bridge.writeProjectFile &&
            (!conversation.environment ||
              conversation.environment.kind === "local")
          }
        />
        <button
          type="button"
          className="changes-icon-button"
          aria-label={expanded ? t("Collapse") : t("Expand")}
          title={expanded ? t("Collapse") : t("Expand")}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button
          type="button"
          className="changes-icon-button"
          aria-label={t("Close")}
          title={t("Close")}
          onClick={() => navigation.run(onClose, undefined, "pane")}
        >
          <X size={16} />
        </button>
      </header>
      <div
        className={`files-body${onRight ? " tree-right" : ""}`}
        ref={tree.body}
      >
        {treeOpen && (
          <nav
            className="files-tree"
            aria-label={t("File tree")}
            style={{ width: tree.width }}
          >
            <FilesTreeContents
              active={active}
              bridge={bridge}
              contentQuery={contentQuery}
              contentResult={contentResult}
              contentSearch={contentSearch}
              conversation={conversation}
              filter={filter}
              filterRef={filterRef}
              listings={listings}
              needle={needle}
              open={open}
              openFile={openFile}
              panelRef={panelRef}
              revealed={revealed}
              root={root}
              rows={rows}
              searchFailed={searchFailed}
              searching={searching}
              setFilter={setFilter}
              toggleFolder={toggleFolder}
            />
            {!tree.edgeDrag && (
              <ResizeHandle
                className="files-tree-divider"
                label={t("Resize file tree")}
                {...tree.props(false)}
              />
            )}
          </nav>
        )}
        {(!treeOpen || tree.edgeDrag) && (
          <ResizeHandle
            className="files-tree-edge"
            label={t("Resize file tree")}
            {...tree.props(true)}
          />
        )}
        <section className="files-view" aria-label={t("Open files")}>
          <span className="sr-only" id={`${tabsId}-instructions`}>
            {t("Press Delete or Backspace to close the file")}.{" "}
            {t(
              "Press Control+Shift+Left Arrow or Right Arrow to move the file",
            )}
          </span>
          {active && (
            <FilesSaveBar
              active={active}
              documents={documents}
              list={list}
              listings={listings}
              previewKind={previewKind}
              navigation={navigation}
              pathMenu={pathMenu}
              preferences={preferences}
              rendered={rendered}
              saveProblems={saveProblems}
              setPathMenu={setPathMenu}
              setSourceViews={setSourceViews}
              shown={shown}
            />
          )}
          <div
            className="files-content"
            role="tabpanel"
            id={active ? `${tabIds(active)}-panel` : undefined}
            aria-labelledby={active ? tabIds(active) : undefined}
            aria-busy={navigation.busy || undefined}
          >
            {body}
          </div>
        </section>
      </div>
      {navigation.prompt}
      {pathMenu && active && (
        <Menu
          label={baseName(active)}
          entries={(() => {
            const parent = active.includes("/")
              ? active.slice(0, active.lastIndexOf("/"))
              : "";
            const listing = listings[parent];
            return listing?.state === "ready"
              ? listing.entries
                  .filter((entry) => entry.kind === "file")
                  .map((entry) => ({
                    label: entry.name,
                    noTranslate: true,
                    checked: entry.path === active,
                    icon: (
                      <FileTypeIcon
                        path={entry.path}
                        fallback={<FileIcon size={16} />}
                      />
                    ),
                    onSelect: () => openFile(entry.path),
                  }))
              : [{ label: t("Listing this folder"), disabled: true }];
          })()}
          position={pathMenu}
          width={240}
          onClose={() => setPathMenu(undefined)}
        />
      )}
      {menu && (
        <Menu
          label={baseName(menu.path)}
          entries={tabMenu(menu.path)}
          position={menu.position}
          width={220}
          onClose={() => setMenu(undefined)}
        />
      )}
    </aside>
  );
  return filesPanelViewView;
}
