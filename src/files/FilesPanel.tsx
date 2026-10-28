import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Conversation } from "../../shared/types";
import type {
  ProjectEntry,
  ProjectFile,
  ProjectSearchResult,
} from "../../shared/project-files";
import { onFilesContentSearch } from "./files-search";
import { onFileOpenRequest } from "./file-open-request";
import { type MenuPosition } from "../ui/Menu";
import { lazyPiece } from "../ui/lazy-piece";
import { FileDocuments, type FileDocumentBridge } from "./file-documents";
import { useFilePreferences } from "./file-preferences";
import { useFileTreeResize } from "./file-tree-resize";
import { useTreeOnRight } from "./tree-position";
import { useFileNavigation } from "./useFileNavigation";
import { activeAfterFileClose, openFileTab } from "./file-tabs";
import type { FileEditorCache } from "./FileCodeEditor";
import type { EditorView } from "@codemirror/view";
import { usePaneExpandToggle } from "../app/pane-expand";
import "./files-panel.css";
import { filesPanelView } from "./FilesPanelView";

export type Listing =
  | { state: "loading" }
  | { state: "ready"; entries: ProjectEntry[]; truncated: boolean }
  | { state: "error" };
export const MarkdownDocument = lazyPiece(
  () => import("../artifacts/MarkdownDocument"),
  "MarkdownDocument",
);
export const ArtifactPreview = lazyPiece(
  () => import("../artifacts/ArtifactPreview"),
  "ArtifactPreview",
);
export const FileCodeEditor = lazyPiece(
  () => import("./FileCodeEditor"),
  "FileCodeEditor",
);

export interface FilesBridge extends FileDocumentBridge {
  listProjectFolder(
    id: string,
    folder: string,
  ): Promise<{ entries: ProjectEntry[]; truncated: boolean }>;
  readProjectFile(id: string, file: string): Promise<ProjectFile>;
  searchProjectFiles?(id: string, query: string): Promise<ProjectSearchResult>;
  /** Go to file: the folder's files matching what is typed. */
  mentionFiles?(
    scope: { conversationId: string },
    query: string,
  ): Promise<{ path: string; kind: "file" | "folder" }[]>;
}

export const baseName = (path: string) => path.split("/").at(-1) ?? path;

/** How a file can show besides its source: Markdown, or a sandboxed page. */
export type FilePreviewKind = "markdown" | "html" | "svg";

export function filePreviewKind(path: string): FilePreviewKind | undefined {
  if (/\.(md|mdx|markdown)$/i.test(path)) return "markdown";
  if (/\.html?$/i.test(path)) return "html";
  if (/\.svg$/i.test(path)) return "svg";
  return undefined;
}
const parents = (path: string) => {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
};

/** Literal content hits. */
export function contentMatchPreview(preview: string, query: string): ReactNode {
  if (!query) return preview;
  const text = preview.toLowerCase();
  const needle = query.toLowerCase();
  const parts: ReactNode[] = [];
  let start = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    parts.push(preview.slice(start, index));
    parts.push(
      <mark key={index}>{preview.slice(index, index + query.length)}</mark>,
    );
    start = index + query.length;
    index = text.indexOf(needle, start);
  }
  parts.push(preview.slice(start));
  return parts;
}

/** The tabs a Close menu keeps (the original's Close file, other, to the right, all). */
export function closeTabs(
  tabs: readonly string[],
  path: string,
  how: "file" | "others" | "right" | "all",
) {
  if (how === "all") return [];
  if (how === "others") return tabs.filter((tab) => tab === path);
  if (how === "right") return tabs.slice(0, tabs.indexOf(path) + 1);
  return tabs.filter((tab) => tab !== path);
}

/** The session file tree and CodeMirror tabs. Editing is admitted only for
 * a local, writable file with the conditional-write bridge. */
export function FilesPanel({
  conversation,
  bridge,
  accountId = "local",
  onClose,
}: {
  conversation: Conversation;
  bridge: FilesBridge;
  accountId?: string;
  onClose: () => void;
}) {
  const id = conversation.id;
  const [treeOpen, setTreeOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set([""]));
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const [contentResult, setContentResult] = useState<ProjectSearchResult>();
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [selectedLine, setSelectedLine] = useState<{ line: number }>();
  const contentSearch = filter.startsWith("?") && !!bridge.searchProjectFiles;
  const contentQuery = contentSearch ? filter.slice(1).trim() : "";
  const [tabs, setTabs] = useState<string[]>([]);
  const currentTabs = useRef(tabs);
  currentTabs.current = tabs;
  const [active, setActive] = useState<string>();
  const [preview, setPreview] = useState<string>();
  const [focusedTab, setFocusedTab] = useState<string>();
  const [sourceViews, setSourceViews] = useState<Set<string>>(new Set());
  const [pathMenu, setPathMenu] = useState<MenuPosition>();
  const [preferences, setPreferences] = useFilePreferences(accountId);
  const documents = useMemo(
    () =>
      new FileDocuments(id, {
        readProjectFile: (session, path) =>
          bridge.readProjectFile(session, path),
        writeProjectFile:
          (!conversation.environment ||
            conversation.environment.kind === "local") &&
          bridge.writeProjectFile
            ? (session, path, value, revision) =>
                bridge.writeProjectFile!(session, path, value, revision)
            : undefined,
      }),
    [id, bridge, accountId, conversation.environment?.kind],
  );
  const files = useSyncExternalStore(
    documents.subscribe,
    documents.snapshot,
    documents.snapshot,
  );
  const editorCache = useMemo<FileEditorCache>(() => new Map(), [documents]);
  const editor = useRef<EditorView | undefined>(undefined);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const tabsId = useId();
  const navigation = useFileNavigation(documents, preferences.autoSave, () =>
    editor.current?.focus(),
  );
  const onRight = useTreeOnRight();
  const tree = useFileTreeResize(accountId, treeOpen, setTreeOpen, onRight);
  useEffect(() => {
    documents.activate();
    return () => documents.dispose();
  }, [documents]);
  useEffect(
    () => documents.setAutoSave(preferences.autoSave),
    [documents, preferences.autoSave],
  );
  useEffect(() => {
    if (!preferences.previewTabs) setPreview(undefined);
  }, [preferences.previewTabs]);
  const [revealed, setRevealed] = useState<string>();
  const [menu, setMenu] = useState<{ path: string; position: MenuPosition }>();
  const alive = useRef(true);
  const panelRef = useRef<HTMLElement>(null);
  const focusFilter = () => {
    setTreeOpen(true);
    requestAnimationFrame(() => {
      filterRef.current?.focus();
      filterRef.current?.select();
    });
  };
  useEffect(
    () =>
      onFilesContentSearch(id, () => {
        setTreeOpen(true);
        setFilter((value) =>
          value.startsWith("?") ? value : `?${value.trim()}`,
        );
        requestAnimationFrame(() => {
          const input = filterRef.current;
          input?.focus();
          if (input && input.value.length > 1)
            input.setSelectionRange(1, input.value.length);
        });
      }),
    [id],
  );
  useEffect(() => {
    let cancelled = false;
    setContentResult(undefined);
    setSearchFailed(false);
    setSearching(Boolean(contentQuery));
    if (!contentQuery || !bridge.searchProjectFiles) return;
    const timer = setTimeout(() => {
      void bridge.searchProjectFiles!(id, contentQuery).then(
        (result) => {
          if (!cancelled) {
            setContentResult(result);
            setSearching(false);
          }
        },
        () => {
          if (!cancelled) {
            setSearchFailed(true);
            setSearching(false);
          }
        },
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, contentQuery, bridge]);
  const jumpToLine = (view: EditorView) => {
    if (!selectedLine) return;
    const line = view.state.doc.line(
      Math.max(1, Math.min(view.state.doc.lines, selectedLine.line)),
    );
    view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
  };
  useEffect(() => {
    if (editor.current) jumpToLine(editor.current);
  }, [active, selectedLine]);
  // ⌘P Go to file and ⇧⌘Y the file tree, while the pane has the focus
  // (the shortcuts list's "in changes or files").
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!panelRef.current?.contains(document.activeElement)) return;
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "p" && !event.shiftKey) {
        event.preventDefault();
        focusFilter();
      } else if (key === "y" && event.shiftKey) {
        event.preventDefault();
        setTreeOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  }, [id]);
  usePaneExpandToggle("files", () => setExpanded((value) => !value));
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const list = (folder: string) => {
    setListings((current) => ({ ...current, [folder]: { state: "loading" } }));
    void bridge.listProjectFolder(id, folder).then(
      ({ entries, truncated }) =>
        alive.current &&
        setListings((current) => ({
          ...current,
          [folder]: { state: "ready", entries, truncated },
        })),
      () =>
        alive.current &&
        setListings((current) => ({
          ...current,
          [folder]: { state: "error" },
        })),
    );
  };
  useEffect(() => {
    if (conversation.cwd) list("");
  }, [id, conversation.cwd]);

  const toggleFolder = (folder: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(folder)) next.delete(folder);
      else {
        next.add(folder);
        if (!listings[folder] || listings[folder].state === "error")
          list(folder);
      }
      return next;
    });
  };

  const focusTab = (path: string | undefined) =>
    requestAnimationFrame(() => {
      if (path) tabRefs.current.get(path)?.focus();
      else panelRef.current?.focus();
    });
  const keepFile = (path: string) =>
    setPreview((current) => (current === path ? undefined : current));
  const activateFile = (path: string, focus = false) =>
    navigation.run(
      () => {
        setActive(path);
        setSelectedLine(undefined);
        if (focus) focusTab(path);
      },
      active && active !== path ? [active] : [],
    );
  const openFile = (path: string, line?: number, keep = false) =>
    navigation.run(
      () => {
        const next = openFileTab(
          tabs,
          path,
          preview,
          preferences.previewTabs,
          keep,
        );
        for (const removed of tabs.filter((old) => !next.tabs.includes(old))) {
          documents.close(removed);
          editorCache.delete(removed);
        }
        setSelectedLine(line ? { line } : undefined);
        setTabs(next.tabs);
        setPreview(next.preview);
        setActive(path);
        void documents.open(path);
      },
      active && active !== path ? [active] : [],
    );

  // A diff's Open file asks for a file (file-open-request.ts): it opens
  // kept, not as the preview tab.
  const openLatest = useRef(openFile);
  openLatest.current = openFile;
  useEffect(
    () =>
      onFileOpenRequest(id, (path) =>
        openLatest.current(path, undefined, true),
      ),
    [id],
  );
  const close = (path: string, how: "file" | "others" | "right" | "all") => {
    const next = closeTabs(tabs, path, how);
    const removed = tabs.filter((tab) => !next.includes(tab));
    navigation.run(() => {
      const focused = panelRef.current
        ?.querySelector(".files-tabs")
        ?.contains(document.activeElement);
      const nextActive = activeAfterFileClose(tabs, next, active);
      setTabs(next);
      setActive(nextActive);
      setFocusedTab((current) =>
        focused
          ? nextActive
          : current && removed.includes(current)
            ? undefined
            : current,
      );
      if (preview && removed.includes(preview)) setPreview(undefined);
      for (const removedPath of removed) {
        documents.close(removedPath);
        editorCache.delete(removedPath);
      }
      if (focused) focusTab(nextActive);
    }, removed);
  };

  const reveal = (path: string) => {
    setTreeOpen(true);
    setFilter("");
    setOpen((current) => {
      const next = new Set(current);
      for (const folder of parents(path)) {
        next.add(folder);
        if (!listings[folder]) list(folder);
      }
      return next;
    });
    setRevealed(path);
  };

  const needle = filter.trim().toLowerCase();
  const rows = useMemo(() => {
    const out: { entry: ProjectEntry; depth: number }[] = [];
    const walk = (folder: string, depth: number) => {
      const listing = listings[folder];
      if (listing?.state !== "ready") return;
      for (const entry of listing.entries) {
        const matches = !needle || entry.name.toLowerCase().includes(needle);
        if (entry.kind === "folder") {
          const before = out.length;
          out.push({ entry, depth });
          if (open.has(entry.path) || needle) walk(entry.path, depth + 1);
          // Filtering keeps a folder only for its matches (or its own name).
          if (needle && !matches && out.length === before + 1) out.pop();
        } else if (matches) out.push({ entry, depth });
      }
    };
    walk("", 0);
    return out;
  }, [listings, open, needle]);

  const root = listings[""];
  const shown = active ? files[active] : undefined;
  const previewKind = active ? filePreviewKind(active) : undefined;
  // Markdown and SVG open rendered, HTML as its source; the eye or code button
  // flips the file's view (sourceViews holds the flipped files).
  const rendered =
    !!previewKind && sourceViews.has(active!) === (previewKind === "html");
  const filesPanelViewView = filesPanelView({
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
  });
  return filesPanelViewView;
}
