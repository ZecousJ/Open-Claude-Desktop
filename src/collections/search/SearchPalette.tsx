import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CircleFadingPlus,
  FileText,
  FolderClosed,
  ListChecks,
  MessageCircle,
  Clock,
} from "../../ui/glyphs";
import { AppContext } from "../../app/AppContext";
import { controllerPaletteActions } from "./palette-actions";
import { AppIcon } from "../../ui/app-icon";
import type { Attachment, Conversation, Mode } from "../../../shared/types";
import { CodeIcon } from "../../ui/icons";
import { ShortcutPlatform } from "../../ui/Tooltip";
import {
  newActions,
  quickActions,
  palettePlaceholder,
  searchSections,
  markTerms,
  type SearchFilter,
  type SearchRow,
  type SearchSources,
  type PaletteAction,
} from "./search-model";
import { useDialogOverlay } from "../../ui/dialog-stack";
import { searchViewEvent, type SearchEntrypoint } from "./palette-events";
import { t, useLocale } from "../../i18n";
import { usePaletteSearch } from "./use-palette-search";
import { useZoneDrop } from "../../composer/drop-zones";
import { addFile } from "../../composer/attachment-input";
import { showToast } from "../../ui/toast-store";
import "./search.css";
import {
  filterPicker,
  filterSearchSources,
  paletteFilterOptions,
  paletteType,
  type PaletteFilters,
  type PaletteFilterOption,
} from "./search-filters";
import { useSearchPaletteActions } from "./useSearchPaletteActions";

const modeIcons = {
  chat: MessageCircle,
  cowork: ListChecks,
  code: CodeIcon,
} as const;

export function RowIcon({ row }: { row: SearchRow }) {
  // Current live palette draws the source glyph at 20px, including Code
  // and ChatAdd; stretching the old 16px SVG used the wrong optical size.
  if (row.kind === "action" && !row.mode)
    return (
      <AppIcon
        name={row.icon ?? "Settings"}
        size={20}
        className="search-source-icon"
      />
    );
  if (
    (row.kind === "conversation" && row.conversation.mode === "code") ||
    (row.kind === "action" && row.mode === "code")
  )
    return <AppIcon name="Code" size={20} className="search-source-icon" />;
  if (row.kind === "action" && row.mode === "chat")
    return <AppIcon name="ChatAdd" size={20} className="search-source-icon" />;
  const Icon =
    row.kind === "conversation"
      ? // Cowork is part of Chat now: its chats wear the chat glyph, as in
        // the sidebar.
        modeIcons[
          row.conversation.mode === "cowork" ? "chat" : row.conversation.mode
        ]
      : row.kind === "action"
        ? row.mode === "chat"
          ? CircleFadingPlus
          : modeIcons[row.mode ?? "chat"]
        : row.kind === "project"
          ? FolderClosed
          : row.kind === "routine"
            ? Clock
            : FileText;
  return <Icon size={20} className="search-source-icon" aria-hidden="true" />;
}

/**
 * ⌘K: Search over chats, tasks, sessions, projects, routines and artifacts with
 * ↑↓ / Enter, `/` for the next filter and → for a conversation's actions; Tab
 * switches to Compose, which starts a new chat, task or session from what is
 * typed. Only what Claudex has is listed: no New document / presentation /
 * design.
 */
export function SearchPalette({
  mode = "chat",
  entrypoint = "default",
  onEntrypointChange,
  actions: providedActions,
  sources,
  loadRoutines,
  query,
  onQueryChange,
  onOpen,
  onNew,
  onCompose,
  onChooseFiles,
  onRename,
  onArchive,
  onDelete,
  onClose,
}: {
  mode?: Mode;
  entrypoint?: SearchEntrypoint;
  onEntrypointChange?: (entrypoint: SearchEntrypoint) => void;
  actions?: readonly PaletteAction[];
  sources: Omit<SearchSources, "routines">;
  loadRoutines: () => Promise<SearchSources["routines"]>;
  query: string;
  onQueryChange: (query: string) => void;
  onOpen: (row: Exclude<SearchRow, { kind: "action" }>) => void;
  onNew: (mode: Mode) => void;
  /** Starts the conversation; the palette closes once it is under way. */
  onCompose: (mode: Mode, text: string, files: Attachment[]) => void;
  onChooseFiles: () => Promise<Attachment[]>;
  onRename: (conversation: Conversation) => void;
  onArchive: (conversation: Conversation) => void;
  onDelete: (conversation: Conversation) => void;
  onClose: () => void;
}) {
  const locale = useLocale();
  const app = useContext(AppContext);
  const actions = useMemo(
    () =>
      (
        providedActions ?? [
          ...newActions.map((action): PaletteAction => ({
            ...action,
            mode: mode === "code" ? "code" : "chat",
            command: {
              type: "new-session",
              mode: mode === "code" ? "code" : "chat",
            },
          })),
          ...(mode === "code" ? [] : quickActions),
          ...controllerPaletteActions(app),
        ]
      ).map((action) => ({
        ...action,
        title: t(action.title),
        searchHints: action.searchHints?.map((hint) => t(hint)),
      })),
    [providedActions, app, mode, locale],
  );
  // SearchOverlay keeps this component mounted across owner changes. A
  // retired promise must not close the new palette or release its request.
  const owner = app?.controllerScope ?? app?.currentController ?? app;
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const actionScope = useMemo(
    () => ({
      owner,
      accountId: app?.accountId,
      controller: app?.currentController,
      bridge,
    }),
    [owner, app?.accountId, app?.currentController, bridge],
  );
  const latestActionScope = useRef(actionScope);
  latestActionScope.current = actionScope;
  type PendingAction = { scope: typeof actionScope; key: string };
  const [pendingRequest, setPendingRequest] = useState<PendingAction>();
  const pendingRequestRef = useRef<PendingAction | undefined>(undefined);
  const pendingAction =
    pendingRequest?.scope === actionScope ? pendingRequest.key : undefined;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const platform = useContext(ShortcutPlatform);
  const [view, setView] = useState<"search" | "compose">(() => {
    // The dedicated Search command may dispatch its event before this lazy
    // component mounts. Its entrypoint must also choose the initial view.
    if (entrypoint === "search") return "search";
    try {
      return localStorage.getItem("cmdk-mode") === "compose"
        ? "compose"
        : "search";
    } catch {
      return "search";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("cmdk-mode", view);
    } catch {}
  }, [view]);
  const [filter, setFilter] = useState<SearchFilter>("all");
  const [routines, setRoutines] = useState<SearchSources["routines"]>([]);
  const [filters, setFilters] = useState<PaletteFilters>({});
  const filterLabelId = useId();
  const picker = filterPicker(query);
  const filterOptions = picker
    ? paletteFilterOptions(picker, { ...sources, routines })
    : [];
  const chooseFilter = (option: PaletteFilterOption) => {
    if (!picker?.key && option.key !== "actions")
      onQueryChange(`${option.key}:`);
    else {
      if (option.key === "actions") onEntrypointChange?.("actions");
      else
        setFilters((current) => ({
          ...current,
          [option.key]: { value: option.value, label: option.label },
        }));
      onQueryChange("");
    }
    setActive(0);
    input.current?.focus();
  };
  const [active, setActiveIndex] = useState(0);
  const [activeKey, setActiveKey] = useState<string>();
  const [selectionContext, setSelectionContext] = useState({
    query,
    filter,
    entrypoint,
  });
  const setActive = (index: number) => {
    setActiveIndex(index);
    setActiveKey(undefined);
  };
  const [rowMenu, setRowMenu] = useState<Conversation>();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [target, setTarget] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const compose = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menuAnchor = useRef<HTMLElement | null>(null);
  const composeBox = useRef<HTMLDivElement>(null);
  const dropState = useZoneDrop(composeBox, {
    enabled: view === "compose",
    onDrop: (data) => {
      void Promise.all(Array.from(data.files).map(addFile))
        .then((attachments) =>
          setFiles((current) => [...current, ...attachments]),
        )
        .catch((error: unknown) =>
          showToast(error instanceof Error ? error.message : String(error)),
        );
    },
  });
  const deeper = usePaletteSearch(
    query,
    view === "search" && !picker && mode !== "code" && entrypoint !== "actions",
  );
  const placeholder = palettePlaceholder(
    entrypoint,
    mode,
    filter !== "all" || Object.keys(filters).length > 0,
  );
  const overlay = useDialogOverlay();
  // Closing gives the focus back to what had it (useDialogOverlay).
  // ⇧⌘K while the palette is open shows its Search view.
  useEffect(() => {
    const show = () => setView("search");
    addEventListener(searchViewEvent, show);
    return () => removeEventListener(searchViewEvent, show);
  }, []);

  useEffect(() => {
    let alive = true;
    loadRoutines()
      .then((value) => alive && setRoutines(value ?? []))
      .catch(() => alive && setRoutines([]));
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    (view === "search" ? input.current : compose.current)?.focus();
  }, [view]);
  const sections = useMemo(
    () =>
      searchSections(
        filterSearchSources({ ...sources, routines }, filters),
        query,
        paletteType(filters, filter),
        deeper.hits,
        mode === "code" || deeper.titlesOnly,
        mode,
        Object.keys(filters).length > 0,
        entrypoint,
        actions,
      ),
    [
      sources,
      routines,
      query,
      filter,
      filters,
      deeper.hits,
      deeper.titlesOnly,
      entrypoint,
      mode,
      actions,
    ],
  );
  const rows = sections.flatMap((section) => section.rows);
  const optionCount = picker ? filterOptions.length : rows.length;
  // Prop changes and async results can shrink the list before effects run.
  // Use a valid index in this render for ARIA, highlighting and Enter alike.
  const selectionChanged =
    selectionContext.query !== query ||
    selectionContext.filter !== filter ||
    selectionContext.entrypoint !== entrypoint;
  // Reset before commit, and anchor keyboard selection to the result identity
  // while asynchronous rows arrive.
  const anchorIndex =
    !selectionChanged && activeKey && !picker
      ? rows.findIndex((row) => row.key === activeKey)
      : -1;
  const activeIndex = Math.min(
    selectionChanged ? 0 : anchorIndex >= 0 ? anchorIndex : active,
    Math.max(0, optionCount - 1),
  );
  if (selectionChanged) {
    setSelectionContext({ query, filter, entrypoint });
    setActive(0);
  }
  useEffect(() => {
    if (active !== activeIndex) setActiveIndex(activeIndex);
    if (activeKey && anchorIndex < 0) setActiveKey(undefined);
  }, [active, activeIndex, activeKey, anchorIndex]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, entrypoint, optionCount]);

  // Escape closes the palette (or an open row menu first, which handles it).
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !rowMenu) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [rowMenu, onClose]);

  const actionScopeCurrent = (scope: typeof actionScope) => {
    if (
      !mounted.current ||
      latestActionScope.current !== scope ||
      (typeof window !== "undefined" && window.desktop !== scope.bridge)
    )
      return false;
    const current = scope.controller ? scope.controller.current : app;
    return (
      current?.accountId === scope.accountId &&
      (current?.controllerScope ?? current?.currentController ?? current) ===
        scope.owner
    );
  };
  const { searchPaletteViewView } = useSearchPaletteActions({
    actionScope,
    actionScopeCurrent,
    activeIndex,
    chooseFilter,
    compose,
    composeBox,
    deeper,
    dropState,
    entrypoint,
    files,
    filter,
    filterLabelId,
    filterOptions,
    filters,
    input,
    list,
    menuAnchor,
    mode,
    onArchive,
    onChooseFiles,
    onClose,
    onCompose,
    onDelete,
    onEntrypointChange,
    onNew,
    onOpen,
    onQueryChange,
    onRename,
    overlay,
    pendingAction,
    pendingRequestRef,
    picker,
    placeholder,
    platform,
    query,
    rowMenu,
    rows,
    sections,
    setActive,
    setActiveIndex,
    setActiveKey,
    setFiles,
    setFilter,
    setFilters,
    setPendingRequest,
    setRowMenu,
    setTarget,
    setText,
    setView,
    sources,
    target,
    text,
    view,
  });
  return searchPaletteViewView;
}

/** Found words in bold. */
export function Marked({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {markTerms(text, terms).map((part, index) =>
        part.match ? <strong key={index}>{part.text}</strong> : part.text,
      )}
    </>
  );
}
