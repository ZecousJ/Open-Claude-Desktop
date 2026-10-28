import {
  sideMin,
  sideMaxShare,
  changeStarts,
  splitMinWidth,
} from "./ChangesPanel";
import type { MenuEntry, MenuPosition } from "../ui/Menu";
import { formatText, t } from "../i18n";
import { showToast } from "../ui/toast-store";
import { reviewJump } from "./review-scroll";
import {
  clearDiffFile,
  diffFileEvent,
  pendingDiffFile,
  sameDiffFile,
} from "./diff-file-request";
import { stepChange, changesKeyCommand } from "./changes-keys";
import { useRef, useEffect } from "react";
import { isMacPlatform } from "../host/keys";
import { changesPanelView } from "./ChangesPanelView";
import { filesPaneAvailable } from "../files/files-model";
import { requestFileOpen } from "../files/file-open-request";
import {
  setTreePosition,
  treeOnRight,
  treePositions,
  treePositionText,
  useTreePosition,
} from "../files/tree-position";
import { usePaneSide } from "../app/pane-side";
import type {
  Conversation,
  WorkingTreeChanges,
  DiffScope,
} from "../../shared/types";
import type { DiffFile } from "../diff/diff-model";
import type { DiffFinding, FindingStatus } from "../review/diff-findings";
import type { AppController } from "../app/AppContext";
import type { EditorInfo } from "../../shared/editors";
import type { HostInfo } from "../../shared/host";
import type { GitHubReviewThread } from "../../shared/github-api";
import type { TreeNode, TurnChanges } from "./turn-changes";

/** What useChangesPanelActions needs from ChangesPanel.tsx. */
export interface UseChangesPanelActionsKit {
  app: AppController | undefined;
  byFolder: boolean;
  collapsed: Set<string>;
  conversation: Conversation;
  data: WorkingTreeChanges | undefined;
  diffs: React.RefObject<HTMLDivElement | null>;
  editors: EditorInfo[];
  expanded: boolean;
  fileMenu: { path: string; position: MenuPosition } | undefined;
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
  ignoreSpace: boolean;
  imageFile: DiffFile | undefined;
  jump: React.RefObject<(() => void) | undefined>;
  keyOf: (index: number) => string;
  large: boolean;
  lastChange: React.RefObject<HTMLElement | null>;
  load: () => Promise<void>;
  local: boolean;
  menu: MenuPosition | undefined;
  menuButton: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  openKinds: Set<"test" | "build" | "generated">;
  openThreads: GitHubReviewThread[];
  panel: React.RefObject<HTMLElement | null>;
  platform: string;
  review: { threads: GitHubReviewThread[]; reload: () => void };
  scope: DiffScope;
  sections: React.RefObject<Map<string, HTMLElement>>;
  selected: string | undefined;
  separable: boolean;
  separate: boolean;
  setByFolder: React.Dispatch<React.SetStateAction<boolean>>;
  setCollapsed: React.Dispatch<React.SetStateAction<Set<string>>>;
  setContext: React.Dispatch<React.SetStateAction<number>>;
  setExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  setFileMenu: React.Dispatch<
    React.SetStateAction<{ path: string; position: MenuPosition } | undefined>
  >;
  setFolded: React.Dispatch<React.SetStateAction<Set<string>>>;
  setGoTo: React.Dispatch<React.SetStateAction<boolean>>;
  setIgnoreSpace: React.Dispatch<React.SetStateAction<boolean>>;
  setImageFile: React.Dispatch<React.SetStateAction<DiffFile | undefined>>;
  setMenu: React.Dispatch<React.SetStateAction<MenuPosition | undefined>>;
  setOpenKinds: React.Dispatch<
    React.SetStateAction<Set<"test" | "build" | "generated">>
  >;
  setScope: (next: DiffScope) => void;
  setSelected: React.Dispatch<React.SetStateAction<string | undefined>>;
  setSeparate: React.Dispatch<React.SetStateAction<boolean>>;
  setShowFiles: React.Dispatch<React.SetStateAction<boolean>>;
  setSideBySide: React.Dispatch<React.SetStateAction<boolean>>;
  setSideWidth: React.Dispatch<React.SetStateAction<number | undefined>>;
  setView: React.Dispatch<React.SetStateAction<string>>;
  setWideEnough: React.Dispatch<React.SetStateAction<boolean>>;
  setWords: React.Dispatch<React.SetStateAction<boolean>>;
  setWrap: React.Dispatch<React.SetStateAction<boolean>>;
  showFiles: boolean;
  side: React.RefObject<HTMLDivElement | null>;
  sideBySide: boolean;
  sideWidth: number | undefined;
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
  turns: TurnChanges[];
  view: string;
  wideEnough: boolean;
  words: boolean;
  wrap: boolean;
}

export function useChangesPanelActions(kit: UseChangesPanelActionsKit) {
  const {
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
  } = kit;
  const selectedPath = selected
    ? files[Number(selected.split(":").pop())]?.path
    : undefined;
  /**
   * The tree's keys: ↑ ↓ Home End move; → opens a folder or steps into it; ←
   * closes it or steps out to its folder; Enter and Space act on the row.
   */
  const treeKeys = (event: React.KeyboardEvent<HTMLElement>) => {
    const rows = [
      ...event.currentTarget.querySelectorAll<HTMLElement>("[data-tree-row]"),
    ];
    if (!rows.length) return;
    const current = rows.indexOf(document.activeElement as HTMLElement);
    const row = rows[current];
    const level = Number(row?.getAttribute("aria-level") ?? 1);
    const focus = (index: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, index))];
      target.focus();
      target.scrollIntoView({ block: "nearest" });
    };
    switch (event.key) {
      case "ArrowDown":
        focus(current + 1);
        break;
      case "ArrowUp":
        focus(current < 0 ? rows.length - 1 : current - 1);
        break;
      case "Home":
        focus(0);
        break;
      case "End":
        focus(rows.length - 1);
        break;
      case "ArrowRight":
        if (row?.getAttribute("aria-expanded") === "false") row.click();
        else if (row?.getAttribute("aria-expanded") === "true")
          focus(current + 1);
        else return;
        break;
      case "ArrowLeft": {
        if (row?.getAttribute("aria-expanded") === "true") {
          row.click();
          break;
        }
        for (let i = current - 1; i >= 0; i--)
          if (Number(rows[i].getAttribute("aria-level")) < level) {
            focus(i);
            break;
          }
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };
  const resizeSide = (width: number) => {
    const total = panel.current?.getBoundingClientRect().width ?? 800;
    const next = Math.round(
      Math.max(sideMin, Math.min(width, total * sideMaxShare)),
    );
    setSideWidth(next);
    try {
      localStorage.setItem("changesFileListWidth", String(next));
    } catch {}
  };
  const openFileMenu = (path: string, event: React.MouseEvent) => {
    event.preventDefault();
    setFileMenu({
      path,
      position: { left: event.clientX, top: event.clientY },
    });
  };
  /** The file's place in the session folder, as the file pane names it. */
  const relativePath = (path: string) => {
    const cwd = conversation.cwd?.replace(/\\/g, "/").replace(/\/+$/, "");
    return cwd && path.startsWith(`${cwd}/`)
      ? path.slice(cwd.length + 1)
      : path;
  };
  // The diff's Open file: the file in the session's file pane.
  const openFile =
    app && filesPaneAvailable(conversation)
      ? (path: string) => {
          requestFileOpen(conversation.id, relativePath(path));
          app.setArtifact(undefined);
          app.toolPanels.setPanel("files");
        }
      : undefined;
  const fileMenuEntries = (path: string): MenuEntry[] => {
    const cwd = conversation.cwd?.replace(/\\/g, "/").replace(/\/+$/, "");
    const relative = relativePath(path);
    const absolute =
      /^([A-Za-z]:)?\//.test(path) || !cwd ? path : `${cwd}/${path}`;
    return [
      ...editors.map((editor) => ({
        label: formatText("Open in {editor}", { editor: editor.name }),
        onSelect: () =>
          void window.desktop
            .openConversationInEditor(conversation.id, editor.kind, relative)
            .catch(app?.report),
      })),
      ...(editors.length ? [{ separator: true } as const] : []),
      {
        label: "Attach as context",
        onSelect: () =>
          window.dispatchEvent(
            new CustomEvent("claudex:attach-path", {
              detail: { conversationId: conversation.id, path: relative },
            }),
          ),
      },
      {
        label: "Copy path",
        onSelect: () =>
          void navigator.clipboard
            .writeText(absolute)
            .catch(() => showToast(t("Couldn’t copy to the clipboard."))),
      },
      ...(openFile
        ? [
            { separator: true } as const,
            { label: "Open file", onSelect: () => openFile(path) },
          ]
        : []),
    ];
  };
  const reveal = (path: string) => {
    const index = files.findIndex((file) => file.path === path);
    if (index < 0) return;
    const key = keyOf(index);
    setSelected(key);
    setCollapsed((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    // The file's diff scrolls into place and rings once (review-scroll.ts).
    const section = sections.current.get(key);
    jump.current?.();
    jump.current = section ? reviewJump(section) : undefined;
  };
  // A file row in the transcript asked for this file (diff-file-request.ts).
  useEffect(() => {
    const open = () => {
      const path = pendingDiffFile(conversation.id);
      const file =
        path === undefined
          ? undefined
          : files.find((entry) => sameDiffFile(path, entry.path));
      if (!file) return;
      clearDiffFile();
      reveal(file.path);
    };
    open();
    window.addEventListener(diffFileEvent, open);
    return () => window.removeEventListener(diffFileEvent, open);
  });
  /** F7 / ⌥F5 and ⇧F7 / ⇧⌥F5: the next or previous change, centred. */
  const stepToChange = (direction: 1 | -1) => {
    const scroller = diffs.current;
    if (!scroller) return;
    const starts = changeStarts(scroller);
    const box = scroller.getBoundingClientRect();
    const tops = starts.map(
      (row) => row.getBoundingClientRect().top - box.top + scroller.scrollTop,
    );
    const last = lastChange.current;
    const lastBox = last?.isConnected
      ? last.getBoundingClientRect()
      : undefined;
    const lastShown =
      lastBox && lastBox.bottom > box.top && lastBox.top < box.bottom
        ? starts.indexOf(last!)
        : -1;
    const index = stepChange(tops, direction, {
      last: lastShown >= 0 ? lastShown : undefined,
      viewTop: scroller.scrollTop,
    });
    if (index === undefined) return;
    const row = starts[index];
    lastChange.current = row;
    scroller.scrollTop =
      tops[index] - scroller.clientHeight / 2 + row.offsetHeight / 2;
  };
  const keys = useRef({
    files: files.length,
    toggleFiles: () => setShowFiles((value) => !value),
    stepToChange,
  });
  keys.current = {
    files: files.length,
    toggleFiles: () => setShowFiles((value) => !value),
    stepToChange,
  };
  // The panel's keys: ⇧⌘Y and ⌘P while the panel is open, F7 and ⌥F5 while the
  // focus is in it.
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = changesKeyCommand(event, {
        mac: isMacPlatform(platform ?? navigator.platform),
        app: host.kind === "desktop",
        linux: /linux/i.test(platform ?? navigator.platform),
      });
      if (!command) return;
      const now = keys.current;
      if (command === "file-list") {
        if (!now.files) return;
        event.preventDefault();
        if (!event.repeat) now.toggleFiles();
      } else if (command === "go-to-file") {
        if (!now.files) return;
        event.preventDefault();
        setGoTo(true);
      } else {
        if (!panel.current?.contains(document.activeElement)) return;
        event.preventDefault();
        now.stepToChange(command === "next-change" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [platform, host.kind]);
  useEffect(() => {
    const element = diffs.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWideEnough(entry.contentRect.width >= splitMinWidth),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [state === undefined, showFiles]);
  const split = sideBySide && wideEnough;
  const treePosition = useTreePosition();
  const listOnRight = treeOnRight(treePosition, usePaneSide());
  const settings: MenuEntry[] = files.length
    ? [
        {
          label: "Show files",
          checked: showFiles,
          keepOpen: true,
          onSelect: () => setShowFiles(!showFiles),
        },
        // Where the list sits, shared with the Files pane's tree.
        {
          label: "File list position",
          value: treePositionText(treePosition),
          submenu: treePositions.map((choice) => ({
            label: treePositionText(choice),
            noTranslate: true,
            checked: choice === treePosition,
            checkedRole: "radio" as const,
            keepOpen: true,
            onSelect: () => setTreePosition(choice),
          })),
        },
        {
          label: "Group files by folder",
          checked: byFolder,
          keepOpen: true,
          onSelect: () => setByFolder(!byFolder),
        },
        ...(separable
          ? [
              {
                label: "Separate test, build, and generated files",
                checked: separate,
                keepOpen: true,
                onSelect: () => setSeparate(!separate),
              },
            ]
          : []),
        { separator: true },
        {
          label: "Collapse all files",
          onSelect: () => setCollapsed(new Set(files.map((_, i) => keyOf(i)))),
        },
        {
          label: "Expand all files",
          disabled: large,
          title: large
            ? "This diff is too large to expand at once. Select a file to expand it."
            : undefined,
          onSelect: () => setCollapsed(new Set()),
        },
        { separator: true },
        {
          label: "Side by side",
          checked: sideBySide,
          keepOpen: true,
          value:
            sideBySide && !wideEnough ? t("Needs a wider pane") : undefined,
          onSelect: () => setSideBySide(!sideBySide),
        },
        {
          label: "Word wrap",
          checked: wrap,
          keepOpen: true,
          onSelect: () => setWrap(!wrap),
        },
        {
          label: "Highlight changed words",
          checked: words,
          keepOpen: true,
          onSelect: () => setWords(!words),
        },
        {
          label: "Hide whitespace changes",
          checked: ignoreSpace,
          keepOpen: true,
          onSelect: () => setIgnoreSpace(!ignoreSpace),
        },
        { separator: true },
      ]
    : [];
  const changesPanelViewView = changesPanelView({
    listOnRight,
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
  });
  return { changesPanelViewView } as const;
}
