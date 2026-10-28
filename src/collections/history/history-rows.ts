import type { Conversation, Mode } from "../../../shared/types";
import {
  defaultFilter,
  inEnvironment,
  surfaceModes,
  type ListFilter,
} from "../../sidebar/listFilter";

const day = 86_400_000;

/** Scoped Code search covers titles only. */
export function matchesHistoryTitle(conversation: Conversation, query: string) {
  return conversation.title
    .toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase());
}

/** Local sessions fall back to their folder name. */
export function historyRepositoryName(
  conversation: Conversation,
  repository?: string,
) {
  return (
    conversation.repository?.fullName ||
    repository ||
    conversation.cwd?.split(/[\\/]/).filter(Boolean).at(-1)
  );
}

/** The row's attention dot. */
export function historyNeedsAttention(
  conversation: Conversation,
  awaiting: boolean,
) {
  const pullRequestState =
    conversation.mode === "code"
      ? conversation.pullRequests?.at(-1)?.state
      : undefined;
  const settled =
    pullRequestState === "merged" || pullRequestState === "closed";
  return (
    !conversation.archived &&
    (awaiting ||
      conversation.sessionState === "blocked" ||
      conversation.sessionState === "ready_for_review" ||
      conversation.turns.some((turn) => turn.status === "inProgress") ||
      conversation.turns.at(-1)?.status === "failed" ||
      Boolean(conversation.turns.length && conversation.unread && !settled))
  );
}

/** Matched message context. */
export function historySnippet(conversation: Conversation, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return undefined;
  for (const turn of conversation.turns) {
    for (const text of [
      turn.prompt,
      ...turn.items.map((item) => item.text ?? ""),
    ]) {
      const at = text.toLocaleLowerCase().indexOf(needle);
      if (at < 0) continue;
      const start = Math.max(0, at - 40);
      const end = Math.min(text.length, at + needle.length + 40);
      return `${start ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
    }
  }
  return undefined;
}

/** What one row is called: Code lists sessions, Chat and Cowork list chats. */
export const historyNoun = (mode: Mode) =>
  mode === "code" ? "session" : "chat";

/** Whether a conversation's title, prompts or replies contain the query. */
export function matchesQuery(c: Conversation, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (c.title.toLowerCase().includes(needle)) return true;
  return c.turns.some(
    (t) =>
      t.prompt.toLowerCase().includes(needle) ||
      t.items.some((i) => i.text?.toLowerCase().includes(needle)),
  );
}

/**
 * The full history of one surface for the "Chats and tasks" page: the same
 * filter menu as the sidebar list, but pinned conversations stay in their
 * place and Last activity is plain recency (no manual sidebar order).
 */
export function historyRows(
  conversations: Conversation[],
  mode: Mode,
  filter: ListFilter,
  query = "",
  now = Date.now(),
) {
  const rows = conversations.filter(
    (c) =>
      !c.incognito &&
      surfaceModes[mode].includes(c.mode) &&
      (filter.status === "all" ||
        c.archived === (filter.status === "archived")) &&
      (mode === "code" || filter.type === "all" || c.mode === filter.type) &&
      (mode === "code" ||
        filter.activity === "all" ||
        now - c.updatedAt <= filter.activity * day) &&
      inEnvironment(c, mode, filter) &&
      matchesQuery(c, query),
  );
  if (filter.sort === "name")
    return rows.sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
    );
  if (filter.sort === "created")
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  return rows.sort(
    (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
  );
}

/**
 * Shift-click selection: every row between the last clicked row and this
 * one takes the clicked row's new state.
 */
export function rangeSelection(
  order: string[],
  selected: ReadonlySet<string>,
  anchor: string | undefined,
  target: string,
  extend: boolean,
): Set<string> {
  const next = new Set(selected);
  const select = !selected.has(target);
  const from = anchor === undefined ? -1 : order.indexOf(anchor);
  const to = order.indexOf(target);
  if (!extend || from < 0 || to < 0) {
    if (select) next.add(target);
    else next.delete(target);
    return next;
  }
  const [start, end] = from < to ? [from, to] : [to, from];
  for (const id of order.slice(start, end + 1))
    if (select) next.add(id);
    else next.delete(id);
  return next;
}

/**
 * The hub's tab-style filter: Active, Shared and Archived for chats and tasks;
 * Code's sessions page has Active and Archived. All (Active) is what is not
 * archived; Shared is the chats with a live link, archived or not; Archived is
 * the archive.
 */
export type HistoryTab = "all" | "shared" | "archived";

export function historyTabs(
  mode: Mode,
): { value: HistoryTab; label: string }[] {
  return mode === "code"
    ? [
        { value: "all", label: "Active" },
        { value: "archived", label: "Archived" },
      ]
    : [
        { value: "all", label: "Active" },
        { value: "shared", label: "Shared" },
        { value: "archived", label: "Archived" },
      ];
}

/** A tab the surface does not offer (Shared on Code's page) reads as All. */
export function historyTabFor(mode: Mode, tab: HistoryTab): HistoryTab {
  return historyTabs(mode).some((t) => t.value === tab) ? tab : "all";
}

/** The rows of one tab: `shared` holds the ids of the chats with a live link. */
export function historyTabRows(
  conversations: Conversation[],
  mode: Mode,
  tab: HistoryTab,
  shared: ReadonlySet<string>,
  {
    sort = "activity",
    query = "",
    now = Date.now(),
  }: {
    sort?: ListFilter["sort"];
    query?: string;
    now?: number;
  } = {},
) {
  const status: ListFilter["status"] =
    tab === "archived" ? "archived" : tab === "shared" ? "all" : "active";
  const rows = historyRows(
    conversations,
    mode,
    { ...defaultFilter, status, sort },
    query,
    now,
  );
  return tab === "shared" ? rows.filter((c) => shared.has(c.id)) : rows;
}

/** The page's search sort: Type or Date. */
export type HistorySearchSort = "type" | "date";

/**
 * Search results in the order the sort picks: Type puts the conversations
 * whose title matches before those matched only by their messages, each
 * newest first; Date is newest first.
 */
export function sortSearchResults(
  rows: Conversation[],
  query: string,
  sort: HistorySearchSort,
) {
  const newest = (a: Conversation, b: Conversation) =>
    b.updatedAt - a.updatedAt;
  if (sort === "date") return [...rows].sort(newest);
  const needle = query.trim().toLowerCase();
  const titled = rows
    .filter((c) => c.title.toLowerCase().includes(needle))
    .sort(newest);
  const rest = rows
    .filter((c) => !c.title.toLowerCase().includes(needle))
    .sort(newest);
  return [...titled, ...rest];
}

/** What an empty tab says. */
export function historyTabEmptyText(
  mode: Mode,
  tab: HistoryTab,
  filtered = false,
) {
  if (tab === "shared") return "Links you share will show up here.";
  // Chat and Cowork's archive with nothing narrowing it: "No archived tasks."
  if (tab === "archived" && mode !== "code" && !filtered)
    return "No archived tasks.";
  return historyEmptyText(mode, tab === "archived");
}

/**
 * What an empty list says: Code's sessions, or Chat and Cowork's activity, and
 * the archive's own line.
 */
export function historyEmptyText(mode: Mode, archived: boolean) {
  if (mode === "code")
    return archived
      ? "Archived sessions will show up here."
      : "Sessions you start will show up here.";
  return archived ? "Nothing archived yet." : "No activity yet.";
}
