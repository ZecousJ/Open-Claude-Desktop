import { t, useT } from "../../i18n";
import { useSharedConversations } from "../shared/shared-ids";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Archive,
  Check,
  Eye,
  EyeOff,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "../../ui/glyphs";
import { AppIcon } from "../../ui/app-icon";
import type { Conversation, Mode, Project } from "../../../shared/types";
import { defaultFilter, type ListFilter } from "../../sidebar/listFilter";
import {
  effectiveGroupBy,
  groupRows,
  useConversationGroups,
} from "../../sidebar/grouping";
import { useHost } from "../../host/HostContext";
import { coworkAvailable } from "../../home/home-mode";
import { historyLabels } from "../../sidebar/recents-labels";
import { type PageMenuEntry } from "../PageMenu";
import {
  historyNoun,
  historyRepositoryName,
  matchesHistoryTitle,
  historyTabFor,
  historyTabRows,
  sortSearchResults,
  type HistorySearchSort,
  type HistoryTab,
} from "./history-rows";
import { ProjectSearchText } from "../projects/ProjectChatSearch";
import { selectionActions } from "./bulk-actions";
import { useHistorySearch } from "./use-history-search";
import "../collections.css";
import "./history.css";
import { historyPageView } from "./HistoryPageView";

/** The Projects glyph of the row menu, as the selection toolbar's. */
const ProjectsGlyph = ({ size }: { size?: number }) => (
  <AppIcon name="Projects" size={size} />
);

export function HistoryRowText({
  title,
  snippet,
  query,
  accessories,
}: {
  title: string;
  snippet?: string;
  query: string;
  /** Badges that follow the title on its own line (the Archived badge). */
  accessories?: ReactNode;
}) {
  return (
    <span className="history-title">
      <span className="history-title-head">
        <span className="history-title-line" data-no-translate>
          {title ? (
            <ProjectSearchText text={title} query={query} />
          ) : (
            <span className="history-untitled">{t("Untitled")}</span>
          )}
        </span>
        {accessories}
      </span>
      {snippet && (
        <span className="history-snippet" data-no-translate>
          <ProjectSearchText text={snippet} query={query} />
        </span>
      )}
    </span>
  );
}

export function HistoryRepositoryText({
  conversation,
}: {
  conversation: Conversation;
}) {
  const [repository, setRepository] = useState<string>();
  useEffect(() => {
    setRepository(undefined);
    if (conversation.repository || !conversation.cwd) return;
    let live = true;
    void Promise.resolve()
      .then(() => window.desktop.codeGitStatus(conversation.id))
      .then((status) => {
        if (live) setRepository(status.repository);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [
    conversation.id,
    conversation.cwd,
    conversation.repository,
    conversation.updatedAt,
  ]);
  const name = historyRepositoryName(conversation, repository);
  return name ? (
    <span className="history-repository" data-no-translate>
      {name}
    </span>
  ) : null;
}

/**
 * "Chats and tasks": every conversation of the current surface with its last
 * activity. Search filters the list in place, tabs under the title pick Active,
 * Shared or Archived, and Select turns rows into checkboxes for selection
 * actions.
 */
export function HistoryPage({
  mode,
  conversations,
  projects,
  onNewChat,
  onOpenConversation,
  onArchive,
  onDelete,
  onRename,
  onMoveToProject,
  onUpdateSelection,
  onConfirmArchive,
  approvalIds = new Set<string>(),
}: {
  mode: Mode;
  conversations: Conversation[];
  projects: Project[];
  onNewChat: () => void;
  onOpenConversation: (conversation: Conversation) => void;
  /** Resolves with the ids that could not be changed; never rejects. */
  onArchive: (ids: string[], archived: boolean) => Promise<string[]>;
  /** Asks first; `done` gets the ids that could not be deleted. */
  onDelete: (ids: string[], done: (failed: string[]) => void) => void;
  onRename: (conversation: Conversation) => void;
  onMoveToProject?: (
    rows: Conversation[],
    done: (failed: string[]) => void,
  ) => void;
  onUpdateSelection: (
    ids: string[],
    patch: { pinned?: boolean; unread?: boolean },
  ) => Promise<string[]>;
  onConfirmArchive: (ids: string[], done: (failed: string[]) => void) => void;
  approvalIds?: ReadonlySet<string>;
}) {
  useT();
  const host = useHost();
  const hub = coworkAvailable(host);
  const kind = "both";
  // Only the sort is read from it: the tabs replaced the filter menu.
  const [filter, setFilter] = useState<ListFilter>(defaultFilter);
  const [chosenTab, setTab] = useState<HistoryTab>("all");
  const tab = historyTabFor(mode, chosenTab);
  const tabsId = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [searchSort, setSearchSort] = useState<HistorySearchSort>("type");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const anchor = useRef<string>(undefined);
  const headingId = useId();
  // Chats with a live link carry a Shared tag, except on the Shared tab.
  const { ids: shared, pending: sharedPending } = useSharedConversations(
    mode !== "code",
  );
  const now = Date.now();
  const {
    query: searchQuery,
    results: searchHits,
    error: searchError,
    pending: searchPending,
    retry: retrySearch,
  } = useHistorySearch(query, mode, tab, conversations);
  const snippets = new Map(
    searchHits.map((hit) => [hit.conversationId, hit.snippet]),
  );
  const rows = useMemo(() => {
    const listed = historyTabRows(conversations, mode, tab, shared, {
      sort: filter.sort,
      query: "",
      now,
    }).filter(
      (conversation) =>
        kind === "both" ||
        conversation.mode === (kind === "tasks" ? "cowork" : "chat"),
    );
    return searchQuery
      ? sortSearchResults(
          listed.filter((conversation) =>
            mode === "code"
              ? matchesHistoryTitle(conversation, searchQuery)
              : searchHits.some(
                  (hit) => hit.conversationId === conversation.id,
                ),
          ),
          searchQuery,
          searchSort,
        )
      : listed;
  }, [
    conversations,
    mode,
    tab,
    shared,
    filter.sort,
    searchQuery,
    searchSort,
    kind,
    searchHits,
  ]);
  // The Shared tab waits for the list of links before it says it is empty.
  const loading = (tab === "shared" && sharedPending) || searchPending;
  // Rows render a page at a time as the list scrolls.
  const [shown, setShown] = useState(pageSize);
  useEffect(() => setShown(pageSize), [query, filter, tab, mode]);
  const more = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = more.current;
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          setShown((count) => count + pageSize);
      },
      { rootMargin: "400px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [rows.length > shown, shown]);
  const [rowMenu, setRowMenu] = useState<Conversation>();
  const rowMenuAnchor = useRef<HTMLElement | null>(null);
  const customGroups = useConversationGroups();
  const groups = groupRows(
    rows.slice(0, shown),
    effectiveGroupBy(mode, filter.groupBy),
    now,
    customGroups,
  );
  const order = rows.map((c) => c.id);
  // Rows that left the list (deleted, filtered out) leave the selection too.
  useEffect(() => {
    const listed = new Set(order);
    setSelected((current) => {
      const kept = new Set([...current].filter((id) => listed.has(id)));
      return kept.size === current.size ? current : kept;
    });
  }, [order.join()]);
  const endSelection = () => {
    setSelecting(false);
    setSelected(new Set());
    anchor.current = undefined;
  };
  /** After a bulk action: leave Select, or keep only the rows that failed. */
  const settle = (failed: string[]) => {
    if (!failed.length) return endSelection();
    setSelected(new Set(failed));
    anchor.current = undefined;
  };
  useEffect(() => {
    if (!selecting) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector(".overlay"))
        endSelection();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [selecting]);
  const chosen = rows.filter((c) => selected.has(c.id));
  const allArchived = chosen.length > 0 && chosen.every((c) => c.archived);
  const actions = selectionActions(chosen, approvalIds);
  // Code's page is "Sessions"; Chat and Cowork's is "Recents" once they are one
  // home (src/sidebar/recents-labels.ts).
  const labels = historyLabels(mode, hub, kind);
  const title = labels.title;
  const noun = historyNoun(mode);

  async function archive() {
    if (!chosen.length || busy) return;
    if (
      !allArchived &&
      chosen.some((conversation) => conversation.mode === "cowork")
    ) {
      onConfirmArchive(
        chosen
          .filter(
            (conversation) =>
              conversation.mode === "cowork" && !conversation.archived,
          )
          .map((conversation) => conversation.id),
        settle,
      );
      return;
    }
    setBusy(true);
    try {
      settle(
        await onArchive(
          chosen.map((c) => c.id),
          !allArchived,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function updateSelection(
    ids: string[],
    patch: { pinned?: boolean; unread?: boolean },
  ) {
    if (!ids.length || busy) return;
    setBusy(true);
    try {
      await onUpdateSelection(ids, patch);
    } finally {
      setBusy(false);
    }
  }
  const historyPageViewView = historyPageView({
    actions,
    allArchived,
    anchor,
    approvalIds,
    archive,
    busy,
    chosen,
    endSelection,
    groups,
    headingId,
    host,
    kind,
    labels,
    loading,
    mode,
    more,
    noun,
    now,
    onDelete,
    onMoveToProject,
    onNewChat,
    onOpenConversation,
    order,
    query,
    retrySearch,
    rowEntries,
    rowMenu,
    rowMenuAnchor,
    rows,
    searchError,
    searchQuery,
    searchSort,
    selected,
    selecting,
    setQuery,
    setRowMenu,
    setSearchSort,
    setSelected,
    setSelecting,
    setTab,
    settle,
    shared,
    shown,
    snippets,
    tab,
    tabsId,
    title,
    updateSelection,
  });
  return historyPageViewView;

  /**
   * A row's menu, in the live order: Select, Pin, Mark as read, Rename, Add to
   * project, Archive, Delete, with the keys p, u, r, a and d.
   */
  function rowEntries(c: Conversation): PageMenuEntry[] {
    const own = selectionActions([c], approvalIds);
    return [
      {
        label: "Select",
        icon: Check,
        onSelect: () => {
          setSelecting(true);
          setSelected(new Set([c.id]));
          anchor.current = c.id;
        },
      },
      { separator: true },
      ...(own.pin.length
        ? [
            {
              label: own.pinned ? "Unpin" : "Pin",
              icon: own.pinned ? PinOff : Pin,
              hint: "p",
              onSelect: () =>
                void updateSelection([c.id], { pinned: !own.pinned }),
            },
          ]
        : []),
      ...(own.read.length
        ? [
            {
              label: own.unread ? "Mark as read" : "Mark as unread",
              icon: own.unread ? Eye : EyeOff,
              hint: "u",
              onSelect: () =>
                void updateSelection([c.id], { unread: !own.unread }),
            },
          ]
        : []),
      {
        label: "Rename",
        icon: Pencil,
        hint: "r",
        onSelect: () => onRename(c),
      },
      ...(onMoveToProject && own.movable.length
        ? [
            {
              label: own.project ? "Change project" : "Add to project",
              icon: ProjectsGlyph,
              onSelect: () => onMoveToProject([c], () => {}),
            },
          ]
        : []),
      c.archived
        ? {
            label: "Unarchive",
            icon: Archive,
            hint: "a",
            onSelect: () => void onArchive([c.id], false),
          }
        : {
            label: "Archive",
            icon: Archive,
            hint: "a",
            onSelect: () => void onArchive([c.id], true),
          },
      { separator: true },
      {
        label: "Delete",
        icon: Trash2,
        danger: true,
        hint: "d",
        onSelect: () => onDelete([c.id], () => {}),
      },
    ];
  }
}

/** Rows added each time the list scrolls near its end. */
const pageSize = 60;
