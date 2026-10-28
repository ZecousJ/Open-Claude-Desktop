import type {
  SearchRow,
  SearchFilter,
  SearchSources,
  SearchSection,
} from "./search-model";
import { showToast } from "../../ui/toast-store";
import type { KeyboardEvent } from "react";
import { removeLastPaletteFilter } from "./search-filters";
import { paletteKey, composeTargets } from "./search-model";
import type {
  Conversation,
  Attachment,
  Mode,
  DesktopAPI,
  Project,
} from "../../../shared/types";
import type { PageMenuEntry } from "../PageMenu";
import { Pencil, Archive, Trash2 } from "../../ui/glyphs";
import { searchPaletteView } from "./SearchPaletteView";
import type { PaletteFilterOption, PaletteFilterKey } from "./search-filters";
import type { SearchEntrypoint } from "./palette-events";
import type { AppController } from "../../app/AppContext";
import type { ZoneDropState } from "../../composer/drop-zones";
import type { Routine } from "../../../shared/routines";
import type { Artifact } from "../../ui/ArtifactTypes";

/** What useSearchPaletteActions needs from SearchPalette.tsx. */
/** A request that waits on the palette (the component's own PendingAction). */
type PendingAction = {
  scope: UseSearchPaletteActionsKit["actionScope"];
  key: string;
};

export interface UseSearchPaletteActionsKit {
  actionScope: {
    owner: object | undefined;
    accountId: string | undefined;
    controller: React.RefObject<AppController | undefined> | undefined;
    bridge: DesktopAPI | undefined;
  };
  actionScopeCurrent: (scope: {
    owner: object | undefined;
    accountId: string | undefined;
    controller: React.RefObject<AppController | undefined> | undefined;
    bridge: DesktopAPI | undefined;
  }) => boolean;
  activeIndex: number;
  chooseFilter: (option: PaletteFilterOption) => void;
  compose: React.RefObject<HTMLTextAreaElement | null>;
  composeBox: React.RefObject<HTMLDivElement | null>;
  deeper: {
    hits:
      | {
          conversationId: string;
          title: string;
          mode: "chat" | "cowork" | "code";
          archived: boolean;
          updatedAt: number;
          projectId?: string | undefined;
          turnId?: string | undefined;
          snippet?: string | undefined;
        }[]
      | undefined;
    titlesOnly: boolean;
    pending: boolean;
  };
  dropState: ZoneDropState;
  entrypoint: SearchEntrypoint;
  files: Attachment[];
  filter: SearchFilter;
  filterLabelId: string;
  filterOptions: PaletteFilterOption[];
  filters: Partial<Record<PaletteFilterKey, { value: string; label: string }>>;
  input: React.RefObject<HTMLInputElement | null>;
  list: React.RefObject<HTMLDivElement | null>;
  menuAnchor: React.RefObject<HTMLElement | null>;
  mode: Mode;
  onArchive: (conversation: Conversation) => void;
  onChooseFiles: () => Promise<Attachment[]>;
  onClose: () => void;
  onCompose: (mode: Mode, text: string, files: Attachment[]) => void;
  onDelete: (conversation: Conversation) => void;
  onEntrypointChange: ((entrypoint: SearchEntrypoint) => void) | undefined;
  onNew: (mode: Mode) => void;
  onOpen: (
    row:
      | {
          key: string;
          kind: "conversation";
          title: string;
          conversation: Conversation;
          terms?: string[] | undefined;
          snippet?: string | undefined;
        }
      | { key: string; kind: "project"; title: string; project: Project }
      | { key: string; kind: "routine"; title: string; routine: Routine }
      | { key: string; kind: "artifact"; title: string; artifact: Artifact },
  ) => void;
  onQueryChange: (query: string) => void;
  onRename: (conversation: Conversation) => void;
  overlay: {
    "data-nested": string | undefined;
    "data-nested-open": string | undefined;
    ref: React.RefObject<HTMLDivElement | null>;
  };
  pendingAction: string | undefined;
  pendingRequestRef: React.RefObject<PendingAction | undefined>;
  picker: { key?: PaletteFilterKey | undefined; query: string } | undefined;
  placeholder:
    | "Search"
    | "Search sessions and projects"
    | "Search chats and projects"
    | "Search actions"
    | "Search or start a session"
    | "Search or start a chat";
  platform: string;
  query: string;
  rowMenu: Conversation | undefined;
  rows: SearchRow[];
  sections: SearchSection[];
  setActive: (index: number) => void;
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
  setActiveKey: React.Dispatch<React.SetStateAction<string | undefined>>;
  setFiles: React.Dispatch<React.SetStateAction<Attachment[]>>;
  setFilter: React.Dispatch<React.SetStateAction<SearchFilter>>;
  setFilters: React.Dispatch<
    React.SetStateAction<
      Partial<Record<PaletteFilterKey, { value: string; label: string }>>
    >
  >;
  setPendingRequest: React.Dispatch<
    React.SetStateAction<PendingAction | undefined>
  >;
  setRowMenu: React.Dispatch<React.SetStateAction<Conversation | undefined>>;
  setTarget: React.Dispatch<React.SetStateAction<number>>;
  setText: React.Dispatch<React.SetStateAction<string>>;
  setView: React.Dispatch<React.SetStateAction<"search" | "compose">>;
  sources: Omit<SearchSources, "routines">;
  target: number;
  text: string;
  view: "search" | "compose";
}

export function useSearchPaletteActions(kit: UseSearchPaletteActionsKit) {
  const {
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
  } = kit;
  const activate = (row: SearchRow | undefined) => {
    if (
      !row ||
      !actionScopeCurrent(actionScope) ||
      pendingRequestRef.current?.scope === actionScope
    )
      return;
    if (row.kind !== "action") {
      onOpen(row);
      return;
    }
    if (row.command.type === "new-session") {
      onNew(row.command.mode);
      return;
    }
    try {
      const result = row.command.execute();
      if (row.keepsPaletteOpen) {
        onQueryChange("");
        input.current?.focus();
        if (result instanceof Promise)
          void result.catch((error: unknown) => {
            if (actionScopeCurrent(actionScope))
              showToast(error instanceof Error ? error.message : String(error));
          });
      } else if (result instanceof Promise) {
        const request = { scope: actionScope, key: row.key };
        pendingRequestRef.current = request;
        setPendingRequest(request);
        void result
          .catch((error: unknown) => {
            if (actionScopeCurrent(actionScope))
              showToast(error instanceof Error ? error.message : String(error));
          })
          .finally(() => {
            if (
              !actionScopeCurrent(actionScope) ||
              pendingRequestRef.current !== request
            )
              return;
            pendingRequestRef.current = undefined;
            setPendingRequest(undefined);
            onClose();
          });
      } else onClose();
    } catch (error) {
      if (actionScopeCurrent(actionScope))
        showToast(error instanceof Error ? error.message : String(error));
    }
  };
  const openRowMenu = (index: number) => {
    const row = rows[index];
    if (row?.kind !== "conversation") return;
    menuAnchor.current =
      list.current?.querySelector<HTMLElement>(
        `[data-index="${index}"] .search-row-more`,
      ) ?? null;
    setActive(index);
    setRowMenu(row.conversation);
  };
  const searchKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (picker) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive(
          filterOptions.length
            ? (activeIndex + step + filterOptions.length) % filterOptions.length
            : 0,
        );
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (filterOptions[activeIndex])
          chooseFilter(filterOptions[activeIndex]);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onQueryChange("");
      }
      return;
    }
    if (
      event.key === "Backspace" &&
      !query &&
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229 &&
      !event.repeat
    ) {
      if (entrypoint === "actions") {
        event.preventDefault();
        onEntrypointChange?.("default");
        setActive(0);
        return;
      }
      const next = removeLastPaletteFilter(filters);
      if (next !== filters) {
        event.preventDefault();
        setFilters(next);
        setActive(0);
        return;
      }
    }
    const command = paletteKey(
      {
        key: event.key,
        shift: event.shiftKey,
        alt: event.altKey,
        query,
        caretAtEnd: event.currentTarget.selectionStart === query.length,
      },
      { active: activeIndex, rows, filter },
    );
    if (!command) return;
    event.preventDefault();
    if (command.type === "move") {
      setActiveIndex(command.to);
      setActiveKey(rows[command.to]?.key);
    } else if (command.type === "activate") activate(rows[activeIndex]);
    else if (command.type === "compose") setView("compose");
    else if (command.type === "filter") setFilter(command.to);
    else if (command.type === "filter-menu") onQueryChange("/");
    else openRowMenu(activeIndex);
  };
  const send = () => {
    if (!text.trim() && !files.length) return;
    const targets = composeTargets(mode);
    const chosen = targets[Math.min(target, targets.length - 1)];
    onCompose(chosen.mode === "code" ? "code" : "chat", text, files);
  };
  const attach = () =>
    void onChooseFiles()
      .then(
        (chosen) =>
          chosen?.length && setFiles((current) => [...current, ...chosen]),
      )
      .catch(() => {});
  const composeKeys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const singleLine = !text.includes("\n");
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      send();
    } else if (
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      singleLine
    ) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const count = composeTargets(mode).length;
      setTarget((index) => (index + step + count) % count);
    } else if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      setView("search");
    } else if (
      event.key.toLowerCase() === "u" &&
      (event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault();
      attach();
    }
  };

  const rowEntries = (c: Conversation): PageMenuEntry[] => [
    { label: "Rename", icon: Pencil, onSelect: () => onRename(c) },
    {
      label: c.archived ? "Unarchive" : "Archive",
      icon: Archive,
      onSelect: () => onArchive(c),
    },
    { separator: true },
    {
      label: "Delete",
      icon: Trash2,
      danger: true,
      onSelect: () => onDelete(c),
    },
  ];
  const searchPaletteViewView = searchPaletteView({
    activate,
    activeIndex,
    attach,
    chooseFilter,
    compose,
    composeBox,
    composeKeys,
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
    onClose,
    onEntrypointChange,
    onQueryChange,
    openRowMenu,
    overlay,
    pendingAction,
    picker,
    placeholder,
    platform,
    query,
    rowEntries,
    rowMenu,
    rows,
    searchKeys,
    sections,
    send,
    targets: composeTargets(mode),
    setActive,
    setFiles,
    setFilter,
    setFilters,
    setRowMenu,
    setTarget,
    setText,
    setView,
    sources,
    target,
    text,
    view,
  });
  return { searchPaletteViewView } as const;
}
