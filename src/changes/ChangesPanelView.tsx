import { WithTooltip } from "../ui/Tooltip";
import {
  List,
  EllipsisVertical,
  Minimize2,
  Maximize2,
  X,
  ChevronRight,
} from "../ui/glyphs";
import { DiffScopeMenu } from "./DiffScopeMenu";
import { t, formatText } from "../i18n";
import { GoToFile } from "./GoToFile";
import { Suspense } from "react";
import { ImageCompareDialog, sideMin, CONTEXT_STEP } from "./ChangesPanel";
import { TreeRows } from "./ChangesTreeRows";
import { Menu } from "../ui/Menu";
import { kindLabels } from "./file-kinds";
import { CommitsList } from "./CommitsList";
import { displayPrompt } from "../../shared/pr-display";
import { ChangedFileSection } from "./ChangedFileSection";
import { findingsOn } from "../review/diff-findings";
import { isImagePath } from "./image-path";
import type {
  Conversation,
  WorkingTreeChanges,
  DiffScope,
} from "../../shared/types";
import type { MenuPosition, MenuEntry } from "../ui/Menu";
import type { DiffFile } from "../diff/diff-model";
import type { DiffFinding, FindingStatus } from "../review/diff-findings";
import type { TreeNode, TurnChanges } from "./turn-changes";
import type { HostInfo } from "../../shared/host";
import type { GitHubReviewThread } from "../../shared/github-api";

/** What changesPanelView needs from ChangesPanel.tsx. */
export interface ChangesPanelViewKit {
  /** The file list on the pane's right (File list position). */
  listOnRight: boolean;
  collapsed: Set<string>;
  conversation: Conversation;
  data: WorkingTreeChanges | undefined;
  diffs: React.RefObject<HTMLDivElement | null>;
  expanded: boolean;
  fileMenu: { path: string; position: MenuPosition } | undefined;
  fileMenuEntries: (path: string) => MenuEntry[];
  files: DiffFile[];
  findingCard: (file: string) => (finding: DiffFinding) => {
    status: FindingStatus;
    onFix: (() => void) | undefined;
    onNext: (() => void | undefined) | undefined;
    onDismiss: () => void;
  };
  findings: DiffFinding[];
  folded: Set<string>;
  fromGit: boolean;
  gitReady: boolean;
  goTo: boolean;
  goToButton: React.RefObject<HTMLButtonElement | null>;
  host: HostInfo;
  imageFile: DiffFile | undefined;
  keyOf: (index: number) => string;
  large: boolean;
  load: () => Promise<void>;
  local: boolean;
  menu: MenuPosition | undefined;
  menuButton: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  openFileMenu: (
    path: string,
    event: React.MouseEvent<Element, MouseEvent>,
  ) => void;
  /** Opens a file in the session's file pane, when the session has one. */
  openFile: ((path: string) => void) | undefined;
  /** A path as the session folder names it (relative inside it). */
  relativePath: (path: string) => string;
  openKinds: Set<"test" | "build" | "generated">;
  openThreads: GitHubReviewThread[];
  panel: React.RefObject<HTMLElement | null>;
  resizeSide: (width: number) => void;
  reveal: (path: string) => void;
  review: { threads: GitHubReviewThread[]; reload: () => void };
  scope: DiffScope;
  sections: React.RefObject<Map<string, HTMLElement>>;
  selectedPath: string | undefined;
  setCollapsed: React.Dispatch<React.SetStateAction<Set<string>>>;
  setContext: React.Dispatch<React.SetStateAction<number>>;
  setExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  setFileMenu: React.Dispatch<
    React.SetStateAction<{ path: string; position: MenuPosition } | undefined>
  >;
  setFolded: React.Dispatch<React.SetStateAction<Set<string>>>;
  setGoTo: React.Dispatch<React.SetStateAction<boolean>>;
  setImageFile: React.Dispatch<React.SetStateAction<DiffFile | undefined>>;
  setMenu: React.Dispatch<React.SetStateAction<MenuPosition | undefined>>;
  setOpenKinds: React.Dispatch<
    React.SetStateAction<Set<"test" | "build" | "generated">>
  >;
  setScope: (next: DiffScope) => void;
  setShowFiles: React.Dispatch<React.SetStateAction<boolean>>;
  setView: React.Dispatch<React.SetStateAction<string>>;
  settings: MenuEntry[];
  showFiles: boolean;
  side: React.RefObject<HTMLDivElement | null>;
  sideWidth: number | undefined;
  split: boolean;
  state: React.JSX.Element | undefined;
  threadNav: (id: string, step: 1 | -1) => (() => void | undefined) | undefined;
  totals: { additions: number; deletions: number };
  tree: {
    source: TreeNode[];
    sections: {
      kind: "test" | "build" | "generated";
      count: number;
      paths: Set<string>;
      nodes: TreeNode[];
    }[];
  };
  treeKeys: (event: React.KeyboardEvent<HTMLElement>) => void;
  turns: TurnChanges[];
  view: string;
  words: boolean;
  wrap: boolean;
}

export function changesPanelView(kit: ChangesPanelViewKit) {
  const {
    collapsed,
    conversation,
    data,
    diffs,
    expanded,
    fileMenu,
    fileMenuEntries,
    files,
    findingCard,
    findings,
    folded,
    fromGit,
    gitReady,
    goTo,
    goToButton,
    host,
    imageFile,
    keyOf,
    large,
    load,
    local,
    menu,
    menuButton,
    onClose,
    openFileMenu,
    openFile,
    relativePath,
    openKinds,
    openThreads,
    panel,
    resizeSide,
    reveal,
    review,
    scope,
    sections,
    selectedPath,
    setCollapsed,
    setContext,
    setExpanded,
    setFileMenu,
    setFolded,
    setGoTo,
    setImageFile,
    setMenu,
    setOpenKinds,
    setScope,
    setShowFiles,
    setView,
    settings,
    showFiles,
    side,
    sideWidth,
    split,
    state,
    threadNav,
    totals,
    tree,
    treeKeys,
    turns,
    view,
    words,
    wrap,
    listOnRight,
  } = kit;
  // The list's toggle leads the bar, or comes before its end buttons when the
  // list is on the right. It shows with nothing to list too.
  const listToggle = (
    <WithTooltip
      label={showFiles ? "Hide files" : "Show files"}
      shortcut={
        host.kind === "desktop" ? ["mod", "shift", "Y"] : ["ctrl", "shift", "Y"]
      }
      placement="above"
    >
      {(tip) => (
        <button
          {...tip}
          className="changes-icon-button"
          aria-label={showFiles ? "Hide files" : "Show files"}
          aria-pressed={showFiles}
          onClick={() => setShowFiles(!showFiles)}
        >
          <List size={16} strokeWidth={1.75} />
        </button>
      )}
    </WithTooltip>
  );
  const changesPanelViewView = (
    <aside
      ref={panel}
      className={`work-panel changes-panel${expanded ? " expanded" : ""}`}
      aria-label="Changes"
    >
      <header>
        {!listOnRight && listToggle}
        {fromGit && data?.state === "ready" && data.base && (
          <DiffScopeMenu
            conversationId={conversation.id}
            data={data}
            scope={scope}
            onScope={setScope}
          />
        )}
        <span className="changes-header-gap" />
        {listOnRight && listToggle}
        {files.length > 0 && (
          <span className="changes-totals">
            <span>
              {files.length === 1
                ? t("1 file")
                : formatText("{count} files", { count: files.length })}
            </span>
            <span className="changes-add">+{totals.additions}</span>
            <span className="changes-del">−{totals.deletions}</span>
          </span>
        )}
        {files.length > 0 && (
          <GoToFile
            files={files}
            open={goTo}
            onOpenChange={setGoTo}
            onPick={reveal}
            buttonRef={goToButton}
          />
        )}
        <button
          ref={menuButton}
          className="changes-icon-button"
          aria-label="Changes settings"
          aria-expanded={Boolean(menu)}
          onClick={() => {
            const box = menuButton.current?.getBoundingClientRect();
            setMenu(
              menu || !box
                ? undefined
                : { right: innerWidth - box.right, top: box.bottom + 4 },
            );
          }}
        >
          <EllipsisVertical size={16} strokeWidth={1.75} />
        </button>
        <button
          className="changes-icon-button"
          aria-label={expanded ? "Collapse" : "Expand"}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button
          className="changes-icon-button"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      {imageFile && (
        <Suspense fallback={null}>
          <ImageCompareDialog
            conversationId={conversation.id}
            file={imageFile}
            scope={scope}
            onClose={() => setImageFile(undefined)}
          />
        </Suspense>
      )}
      {fileMenu && (
        <Menu
          label={fileMenu.path}
          position={fileMenu.position}
          width={220}
          entries={fileMenuEntries(fileMenu.path)}
          onClose={() => setFileMenu(undefined)}
        />
      )}
      {menu && (
        <Menu
          label="Changes settings"
          width={260}
          position={menu}
          anchors={[menuButton]}
          entries={[
            ...settings,
            { label: "Refresh", onSelect: () => void load() },
          ]}
          onClose={() => setMenu(undefined)}
        />
      )}
      {state !== undefined && !turns.length ? (
        state
      ) : (
        <div
          className="changes-body"
          data-files={showFiles || undefined}
          data-list-right={listOnRight || undefined}
        >
          {showFiles && (
            <div
              ref={side}
              className="changes-side"
              style={sideWidth ? { flexBasis: sideWidth } : undefined}
            >
              <div
                className="changes-tree u-scroll-fade-y"
                role="tree"
                aria-label={t("Changed files")}
                tabIndex={0}
                onKeyDown={treeKeys}
                onFocus={(event) => {
                  // Tabbing in lands on the current file, else the first row.
                  if (event.target !== event.currentTarget) return;
                  (
                    event.currentTarget.querySelector<HTMLElement>(
                      '[data-tree-row][aria-selected="true"]',
                    ) ??
                    event.currentTarget.querySelector<HTMLElement>(
                      "[data-tree-row]",
                    )
                  )?.focus();
                }}
              >
                <TreeRows
                  nodes={tree.source}
                  depth={0}
                  prefix=""
                  folded={folded}
                  selected={selectedPath}
                  onFold={(id) =>
                    setFolded((current) => {
                      const next = new Set(current);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                  onOpen={reveal}
                  onMenu={openFileMenu}
                />
                {tree.sections.map((section, index) => {
                  const holdsSelected =
                    selectedPath !== undefined &&
                    section.paths.has(selectedPath);
                  const open = openKinds.has(section.kind) || holdsSelected;
                  return (
                    <div
                      key={section.kind}
                      className="changes-kind"
                      data-separated={
                        index > 0 || tree.source.length > 0 || undefined
                      }
                    >
                      <button
                        className="changes-file-row changes-kind-row"
                        role="treeitem"
                        aria-level={1}
                        tabIndex={-1}
                        data-tree-row=""
                        aria-expanded={open}
                        onClick={() =>
                          setOpenKinds((current) => {
                            const next = new Set(current);
                            if (open) next.delete(section.kind);
                            else next.add(section.kind);
                            return next;
                          })
                        }
                      >
                        <ChevronRight
                          size={12}
                          strokeWidth={1.75}
                          className="changes-kind-caret"
                          data-open={open || undefined}
                        />
                        <span className="changes-kind-label">
                          {kindLabels[section.kind]}
                        </span>
                        <span className="changes-kind-count">
                          {section.count}
                        </span>
                      </button>
                      {open && (
                        <TreeRows
                          nodes={section.nodes}
                          depth={1}
                          prefix={`#${section.kind}`}
                          folded={folded}
                          selected={selectedPath}
                          onFold={(id) =>
                            setFolded((current) => {
                              const next = new Set(current);
                              if (next.has(id)) next.delete(id);
                              else next.add(id);
                              return next;
                            })
                          }
                          onOpen={reveal}
                          onMenu={openFileMenu}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
              {gitReady ? (
                <CommitsList
                  commits={data!.commits ?? []}
                  scope={scope}
                  dirty={Boolean(data!.dirty)}
                  onScope={(next) => {
                    setView("all");
                    setScope(next);
                  }}
                />
              ) : (
                <nav
                  className="changes-turns u-scroll-fade-y"
                  aria-label="Turns"
                >
                  <button
                    className="changes-turn-row"
                    aria-current={view === "all" || undefined}
                    onClick={() => setView("all")}
                  >
                    <span className="changes-turn-title">All changes</span>
                  </button>
                  {[...turns].reverse().map((value) => (
                    <button
                      key={value.turnId}
                      className="changes-turn-row"
                      aria-current={view === value.turnId || undefined}
                      title={displayPrompt(value.prompt)}
                      onClick={() => setView(value.turnId)}
                    >
                      <span className="changes-turn-title" data-no-translate>
                        {displayPrompt(value.prompt).split("\n")[0] || "…"}
                      </span>
                      <span className="changes-turn-meta">
                        <span className="changes-add">+{value.additions}</span>
                        <span className="changes-del">−{value.deletions}</span>
                        <span>
                          {value.files.length === 1
                            ? "1 file"
                            : `${value.files.length} files`}
                        </span>
                      </span>
                    </button>
                  ))}
                </nav>
              )}
            </div>
          )}
          {showFiles && (
            <WithTooltip
              label="Hide files"
              shortcut={
                host.kind === "desktop"
                  ? ["mod", "shift", "Y"]
                  : ["ctrl", "shift", "Y"]
              }
              detail="Drag to resize"
            >
              {(tip) => (
                <div
                  {...tip}
                  className="changes-resize"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t("Resize file list")}
                  aria-valuenow={Math.round(
                    side.current?.getBoundingClientRect().width ?? sideMin,
                  )}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                      return;
                    event.preventDefault();
                    const now =
                      side.current?.getBoundingClientRect().width ?? sideMin;
                    resizeSide(
                      now +
                        (event.key === "ArrowRight" ? 16 : -16) *
                          (listOnRight ? -1 : 1),
                    );
                  }}
                  onPointerDown={(event) => {
                    tip.onPointerDown?.();
                    const start = event.clientX;
                    const from =
                      side.current?.getBoundingClientRect().width ?? sideMin;
                    let moved = false;
                    const move = (next: PointerEvent) => {
                      if (Math.abs(next.clientX - start) > 2) moved = true;
                      if (moved)
                        resizeSide(
                          from +
                            (next.clientX - start) * (listOnRight ? -1 : 1),
                        );
                    };
                    const up = () => {
                      window.removeEventListener("pointermove", move);
                      window.removeEventListener("pointerup", up);
                      // A click without a drag hides the list.
                      if (!moved) setShowFiles(false);
                    };
                    window.addEventListener("pointermove", move);
                    window.addEventListener("pointerup", up);
                  }}
                />
              )}
            </WithTooltip>
          )}
          <div ref={diffs} className="changes-diffs" tabIndex={-1}>
            {large && collapsed.size > 0 && state === undefined && (
              <div className="changes-large-note" role="status">
                Files are collapsed for large diffs. Select a file to expand it.
              </div>
            )}
            {fromGit && data?.baseUnknown && data.scope === "branch" && (
              <div className="changes-warning" role="status">
                Couldn’t compare this branch’s commits with its base, so only
                uncommitted changes are shown.
              </div>
            )}
            {state !== undefined
              ? state
              : files.map((file, index) => {
                  const key = keyOf(index);
                  return (
                    <ChangedFileSection
                      key={key}
                      file={file}
                      lineCount={
                        fromGit ? data?.lineCounts[file.path] : undefined
                      }
                      collapsed={collapsed.has(key)}
                      words={words}
                      split={split}
                      wrap={wrap}
                      onMenu={(event) => openFileMenu(file.path, event)}
                      displayPath={relativePath(file.path)}
                      onOpenFile={
                        openFile && file.status !== "deleted"
                          ? () => openFile(file.path)
                          : undefined
                      }
                      conversationId={
                        fromGit && !split ? conversation.id : undefined
                      }
                      threads={
                        fromGit
                          ? openThreads.filter(
                              (thread) => thread.path === file.path,
                            )
                          : undefined
                      }
                      canApply={host.kind === "desktop" && local}
                      onThreadsChanged={review.reload}
                      threadNav={threadNav}
                      findings={
                        fromGit ? findingsOn(findings, file.path) : undefined
                      }
                      findingCard={findingCard(file.path)}
                      onViewImage={
                        host.kind === "desktop" &&
                        fromGit &&
                        local &&
                        isImagePath(file.path)
                          ? () => setImageFile(file)
                          : undefined
                      }
                      sectionRef={(node) => {
                        if (node) sections.current.set(key, node);
                        else sections.current.delete(key);
                      }}
                      onToggle={() =>
                        setCollapsed((current) => {
                          const next = new Set(current);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                      onMore={
                        fromGit
                          ? () => setContext((value) => value + CONTEXT_STEP)
                          : undefined
                      }
                    />
                  );
                })}
            {fromGit && data?.truncated && (
              <p className="changes-note">
                Some files are too large or too many to show.
              </p>
            )}
          </div>
        </div>
      )}
    </aside>
  );
  return changesPanelViewView;
}
