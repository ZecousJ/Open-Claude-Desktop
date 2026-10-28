import {
  lazy,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppIcon } from "../ui/app-icon";
import { Spinner } from "../ui/Spinner";
import type {
  Conversation,
  DiffScope,
  WorkingTreeChanges,
} from "../../shared/types";
import { hideWhitespaceChanges, parseUnifiedDiff } from "../diff/diff-model";
import { type MenuPosition } from "../ui/Menu";
import {
  changedFileList,
  changedFileTree,
  changesRoot,
  conversationTurnChanges,
} from "./turn-changes";
import { usePaneExpandToggle } from "../app/pane-expand";
import { rememberedScope, rememberScope } from "./diff-scope";
import { threadElementId, useReviewThreads } from "./useReviewThreads";
import {
  dismissFinding,
  findingStatus,
  fixFindingPrompt,
  isDismissed,
  latestReviewFindings,
  markFixing,
  reopenFinding,
  useFindingState,
  type DiffFinding,
} from "../review/diff-findings";
import { sendSpoken } from "../app/composer-send";
import type { DiffFile } from "../diff/diff-model";
import { useChangesPanelActions } from "./useChangesPanelActions";

export const ImageCompareDialog = lazy(() => import("./ImageCompareDialog"));
import { menuEditors } from "../../shared/editors";
import { useInstalledEditors } from "../editors/useInstalledEditors";
import { AppContext } from "../app/AppContext";
import { ShortcutPlatform } from "../ui/Tooltip";
import { useHost } from "../host/HostContext";
import {
  filesByKind,
  isLargeDiff,
  separatedKinds,
  type SeparatedKind,
} from "./file-kinds";

/** The first line of each change (a run of added or removed lines), in reading order. */
export function changeStarts(root: HTMLElement) {
  return [
    ...root.querySelectorAll<HTMLElement>(
      '.diff-row[data-kind="add"], .diff-row[data-kind="del"]',
    ),
  ].filter((row) => {
    const before = row.previousElementSibling;
    return !(
      before instanceof HTMLElement &&
      before.classList.contains("diff-row") &&
      (before.dataset.kind === "add" || before.dataset.kind === "del")
    );
  });
}

export const CONTEXT_STEP = 20;
/** The file list's narrowest and widest (as a share of the panel). */
export const sideMin = 160;
export const sideMaxShare = 0.6;
/** Below this the diffs keep one column (Side by side "Needs a wider pane"). */
export const splitMinWidth = 640;

/**
 * Code "Changes" side panel: one collapsible diff per file and, on the left
 * (the list toggle), the changed files as a tree above the conversation's
 * turns. "All changes" is the folder's working tree against its branch
 * (read-only git queries in the main process); where the folder is not a Git
 * repository it is every turn's own changes, and a turn shows what that turn
 * changed, from the conversation's file changes (turn-changes.ts).
 *
 * In a repository the header's diff scope picks what "All changes" is: the
 * branch since it left its base branch (the default), only the uncommitted
 * changes, the branch against another base, or one of its commits. Loading, a
 * failed read and an empty answer show in the panel as the original's do.
 */
export function ChangesPanel({
  conversation,
  onClose,
}: {
  conversation: Conversation;
  onClose: () => void;
  /** Kept for callers; a failed read now shows in the panel with Try again. */
  onError?: (error: unknown) => void;
}) {
  const [data, setData] = useState<WorkingTreeChanges>();
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [scope, setScopeState] = useState<DiffScope>(() =>
    rememberedScope(conversation.cwd),
  );
  const [context, setContext] = useState(3);
  // The panel opens on the diffs; the list comes with "Show files", which is
  // kept for the next time.
  const [showFiles, setShowFilesState] = useState(() => {
    try {
      return localStorage.getItem("changesShowFiles") === "true";
    } catch {
      return false;
    }
  });
  const setShowFiles: typeof setShowFilesState = (next) =>
    setShowFilesState((previous) => {
      const value = typeof next === "function" ? next(previous) : next;
      try {
        localStorage.setItem("changesShowFiles", String(value));
      } catch {
        /* Kept for this panel only. */
      }
      return value;
    });
  // The file list's width, kept for the next time.
  const [sideWidth, setSideWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("changesFileListWidth"));
      return saved >= sideMin ? saved : undefined;
    } catch {
      return undefined;
    }
  });
  const side = useRef<HTMLDivElement>(null);
  // "all", or the id of the turn whose own changes show.
  const [view, setView] = useState<string>("all");
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  // ⇧⌘\ expands or restores the card (src/app/pane-expand.ts).
  usePaneExpandToggle("changes", () => setExpanded((value) => !value));
  const [selected, setSelected] = useState<string>();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // The settings menu's display options.
  const [byFolder, setByFolder] = useState(true);
  // Separate test, build, and generated files: their sections start folded.
  const [separate, setSeparate] = useState(true);
  const [openKinds, setOpenKinds] = useState<Set<SeparatedKind>>(new Set());
  const [words, setWords] = useState(true);
  const [ignoreSpace, setIgnoreSpace] = useState(false);
  // Diff layout: Side by side needs a wider pane; a narrow one keeps one
  // column. Word wrap breaks long lines.
  const [sideBySide, setSideBySide] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [wideEnough, setWideEnough] = useState(true);
  const [menu, setMenu] = useState<MenuPosition>();
  // View image's dialog, and whether the folder is on this computer.
  const [imageFile, setImageFile] = useState<DiffFile>();
  const local =
    !conversation.environment || conversation.environment.kind === "local";
  // A file's right-click menu, on its tree row or its diff's header.
  const [fileMenu, setFileMenu] = useState<{
    path: string;
    position: MenuPosition;
  }>();

  const menuButton = useRef<HTMLButtonElement>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  const jump = useRef<() => void>(undefined);
  useEffect(() => () => jump.current?.(), []);
  const panel = useRef<HTMLElement>(null);
  const diffs = useRef<HTMLDivElement>(null);
  const goToButton = useRef<HTMLButtonElement>(null);
  const [goTo, setGoTo] = useState(false);
  /** The change the last F7 / ⇧F7 landed on. */
  const lastChange = useRef<HTMLElement | null>(null);
  const platform = useContext(ShortcutPlatform);
  const host = useHost();
  const app = useContext(AppContext);
  const editors = menuEditors(
    useInstalledEditors(host.kind === "desktop"),
    conversation.environment?.kind === "ssh",
  );
  const latest = conversation.turns.at(-1);
  // The pull request's review threads under their lines (desktop, gh).
  const review = useReviewThreads(
    conversation,
    host.kind === "desktop" &&
      local &&
      conversation.environment?.kind !== "ssh",
  );
  const openThreads = review.threads.filter((thread) => !thread.outdated);
  const unresolved = openThreads.filter((thread) => !thread.resolved);
  const threadNav = (id: string, step: -1 | 1) => {
    const at = unresolved.findIndex((thread) => thread.id === id);
    const target = at < 0 ? undefined : unresolved[at + step];
    return target
      ? () =>
          document
            .getElementById(threadElementId(target.id))
            ?.scrollIntoView({ block: "center", behavior: "smooth" })
      : undefined;
  };
  // The latest review's findings at their lines, until dismissed.
  useFindingState();
  const findings = latestReviewFindings(conversation).filter(
    (finding) =>
      finding.line !== undefined && !isDismissed(conversation.id, finding.id),
  );
  const openFindings = findings.filter(
    (finding) => findingStatus(conversation, finding.id) === "open",
  );
  const findingCard = (file: string) => (finding: DiffFinding) => {
    const at = openFindings.findIndex((value) => value.id === finding.id);
    const next = at < 0 ? undefined : openFindings[at + 1];
    const canSend = app && app.active?.id === conversation.id && !app.running;
    return {
      status: findingStatus(conversation, finding.id),
      onFix: canSend
        ? () => {
            markFixing(conversation.id, finding.id, conversation.turns.length);
            void sendSpoken(app, fixFindingPrompt(finding, file)).catch(() =>
              reopenFinding(conversation.id, finding.id),
            );
          }
        : undefined,
      onNext: next
        ? () =>
            document
              .getElementById(
                `review-finding-${next.id.replace(/[^A-Za-z0-9_-]/g, "")}`,
              )
              ?.scrollIntoView({ block: "center", behavior: "smooth" })
        : undefined,
      onDismiss: () => dismissFinding(conversation.id, finding.id),
    };
  };
  // Only the newest request may fill the panel; a slower older read is dropped.
  const request = useRef(0);
  const load = useCallback(() => {
    const id = ++request.current;
    return Promise.resolve()
      .then(() =>
        window.desktop.workingTreeChanges(conversation.id, context, scope),
      )
      .then(
        (next) => {
          if (id !== request.current) return;
          setData(next);
          setFailed(false);
        },
        () => {
          if (id === request.current) setFailed(true);
        },
      );
  }, [conversation.id, context, scope]);
  const retry = () => {
    setRetrying(true);
    void load().finally(() => setRetrying(false));
  };
  // A failed read tries again on its own a few times, then offers Try again.
  const [autoRetries, setAutoRetries] = useState(0);
  const autoRetrying = failed && autoRetries < 3;
  useEffect(() => {
    if (!failed) {
      setAutoRetries(0);
      return;
    }
    if (autoRetries >= 3) return;
    const timer = setTimeout(() => {
      setAutoRetries((n) => n + 1);
      void load();
    }, 5000);
    return () => clearTimeout(timer);
  }, [failed, autoRetries, load]);
  const setScope = (next: DiffScope) => {
    rememberScope(conversation.cwd, next);
    setScopeState(next);
    setSelected(undefined);
    setCollapsed(new Set());
  };
  // "Uncommitted changes" goes once nothing is left uncommitted.
  useEffect(() => {
    if (data?.scope === "uncommitted" && !data.dirty)
      setScope({ kind: "branch", base: scope.base });
  }, [data]);
  // Reload when opened, when more context is asked for, and when a turn settles.
  useEffect(() => {
    void load();
  }, [load, latest?.id, latest?.status, latest?.items.length]);
  // Parsed once per read, not on every selection or menu change.
  const gitFiles = useMemo(
    () => (data?.state === "ready" ? parseUnifiedDiff(data.diff) : []),
    [data?.state, data?.diff],
  );
  const turns = useMemo(
    () => conversationTurnChanges(conversation),
    [conversation.turns],
  );
  const turn = turns.find((value) => value.turnId === view);
  const fromGit = view === "all" && data?.state === "ready";
  // A repository lists its commits beside the tree (the original's
  // Commits); without one, the session's turns.
  const gitReady = data?.state === "ready" && Boolean(data.base);
  const files = useMemo(() => {
    const all = turn
      ? turn.files
      : fromGit
        ? gitFiles
        : turns.flatMap((value) => value.files);
    const shown = ignoreSpace
      ? all.flatMap((file) => hideWhitespaceChanges(file) ?? [])
      : all;
    if (!separate) return shown;
    // Source files first, then the separated sections' (the tree's order).
    const groups = filesByKind(shown);
    return [
      ...groups.source,
      ...separatedKinds.flatMap((kind) => groups[kind]),
    ];
  }, [turn, fromGit, gitFiles, turns, ignoreSpace, separate]);
  const kinds = useMemo(() => filesByKind(files), [files]);
  const separable = separatedKinds.some((kind) => kinds[kind].length > 0);
  const separated = separate && separable;
  const totals = useMemo(
    () =>
      files.reduce(
        (sum, file) => ({
          additions: sum.additions + file.additions,
          deletions: sum.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      ),
    [files],
  );
  const large = useMemo(() => isLargeDiff(files), [files]);
  // A large diff opens with every file folded (the original's rule).
  const foldedFor = useRef<string>(undefined);
  useEffect(() => {
    const identity = `${view}:${scope.kind}:${files.length}`;
    if (!large || foldedFor.current === identity) return;
    foldedFor.current = identity;
    setCollapsed(new Set(files.map((_, i) => `${view}:${i}`)));
  }, [large, files, view, scope.kind]);
  // A file changed in several turns appears once per change.
  const keyOf = (index: number) => `${view}:${index}`;
  const tree = useMemo(() => {
    const root = changesRoot(files, conversation.cwd);
    const build = (list: typeof files) =>
      byFolder ? changedFileTree(list, root) : changedFileList(list, root);
    if (!separated) return { source: build(files), sections: [] };
    return {
      source: build(kinds.source),
      sections: separatedKinds
        .filter((kind) => kinds[kind].length > 0)
        .map((kind) => ({
          kind,
          count: kinds[kind].length,
          paths: new Set(kinds[kind].map((file) => file.path)),
          nodes: build(kinds[kind]),
        })),
    };
  }, [files, kinds, separated, conversation.cwd, byFolder]);
  // What shows instead of diffs: the read still out, a failed read, or an
  // empty answer (the original's Changes empty states).
  const loading = view === "all" && !data && !failed;
  const broken = view === "all" && failed;
  const empty =
    files.length || loading || broken
      ? undefined
      : !conversation.turns.length
        ? {
            title:
              "The changes view works once this session starts. Send your first message to start it.",
          }
        : data?.state === "no-folder" && !turns.length
          ? { title: "Choose a folder to see its changes" }
          : data?.state === "not-git" && !turns.length
            ? {
                title: "Changes need a Git repository",
                body: "None was found for this session, or its folder couldn’t be reached.",
              }
            : fromGit && data?.scope === "uncommitted"
              ? { title: "No uncommitted changes" }
              : { title: "No changes to show" };
  const state = loading ? (
    <div className="changes-state">
      <Spinner
        inheritColor
        size={20}
        className="spin"
        label="Loading changes"
      />
    </div>
  ) : broken ? (
    <div className="changes-state" role="alert">
      <AppIcon name="Warning" size={20} strokeWidth={1.75} aria-hidden="true" />
      {autoRetrying ? (
        <span>Couldn’t load the changes. It will try again on its own.</span>
      ) : (
        <>
          <span>Couldn’t load the changes</span>
          <button
            className="small-action"
            aria-busy={retrying || undefined}
            disabled={retrying}
            onClick={retry}
          >
            Try again
          </button>
        </>
      )}
    </div>
  ) : empty && "body" in empty ? (
    <div className="changes-state">
      <span>{empty.title}</span>
      <p>{empty.body}</p>
    </div>
  ) : empty ? (
    <div className="changes-empty">{empty.title}</div>
  ) : undefined;
  const { changesPanelViewView } = useChangesPanelActions({
    app,
    byFolder,
    collapsed,
    conversation,
    data,
    diffs,
    editors,
    expanded,
    fileMenu,
    files,
    findingCard,
    findings,
    folded,
    fromGit,
    gitReady,
    goTo,
    goToButton,
    host,
    ignoreSpace,
    imageFile,
    jump,
    keyOf,
    large,
    lastChange,
    load,
    local,
    menu,
    menuButton,
    onClose,
    openKinds,
    openThreads,
    panel,
    platform,
    review,
    scope,
    sections,
    selected,
    separable,
    separate,
    setByFolder,
    setCollapsed,
    setContext,
    setExpanded,
    setFileMenu,
    setFolded,
    setGoTo,
    setIgnoreSpace,
    setImageFile,
    setMenu,
    setOpenKinds,
    setScope,
    setSelected,
    setSeparate,
    setShowFiles,
    setSideBySide,
    setSideWidth,
    setView,
    setWideEnough,
    setWords,
    setWrap,
    showFiles,
    side,
    sideBySide,
    sideWidth,
    state,
    threadNav,
    totals,
    tree,
    turns,
    view,
    wideEnough,
    words,
    wrap,
  });
  return changesPanelViewView;
}
