import type { Conversation, Mode } from "../../shared/types";
import { sortedSidebarConversations } from "../../shared/conversation-order";
import type { GroupBy } from "./grouping";

/** Chat and Cowork share a sidebar; Code keeps its own, pinned rows included. */
export const surfaceModes: Record<Mode, Mode[]> = {
  chat: ["chat", "cowork"],
  cowork: ["chat", "cowork"],
  code: ["code"],
};

export type ListFilter = {
  /** Chat surface only: Chat, or Cowork ("Task" in the original). */
  type: "all" | "chat" | "cowork";
  status: "active" | "archived" | "all";
  /** Chat surface only: last activity within this many days. */
  activity: "all" | 1 | 3 | 7 | 30;
  sort: "activity" | "created" | "name";
  groupBy: GroupBy;
  /**
   * Code only: sessions on this computer or on SSH hosts (R9). Cloud, Remote
   * Control and Slack have no Claudex counterpart; with two environments one
   * choice covers every combination.
   */
  environment: "all" | "local" | "ssh";
  /**
   * Code's sidebar, grouped by custom group: headings of groups with nothing in
   * the list are shown too. Absent means off.
   */
  showEmptyGroups?: boolean;
  /**
   * Code's sidebar: a session with a pull request shows its state (the glyph
   * and "#12 · Approved") in place of the idle dot. Absent means on.
   */
  showPrStatus?: boolean;
};

export const defaultFilter: ListFilter = {
  type: "all",
  status: "active",
  activity: "all",
  sort: "activity",
  groupBy: "none",
  environment: "all",
  showEmptyGroups: false,
  showPrStatus: true,
};

/** Where a conversation runs, as the Environment filter names it. */
export const environmentKind = (c: Conversation): "local" | "ssh" =>
  c.environment?.kind === "ssh" ? "ssh" : "local";

/** The Environment filter (Code only) lets the conversation through. */
export const inEnvironment = (
  c: Conversation,
  mode: Mode,
  filter: ListFilter,
) =>
  mode !== "code" ||
  (filter.environment ?? "all") === "all" ||
  environmentKind(c) === filter.environment;

const day = 86_400_000;

/** Rows of one surface's recent list, filtered and ordered. */
export function recentRows(
  conversations: Conversation[],
  mode: Mode,
  filter: ListFilter,
  now = Date.now(),
) {
  const rows = conversations.filter(
    (c) =>
      surfaceModes[mode].includes(c.mode) &&
      (filter.status === "all" ||
        c.archived === (filter.status === "archived")) &&
      // Pinned rows have their own section unless archived ones are shown.
      (!c.pinned || c.archived) &&
      (mode === "code" || filter.type === "all" || c.mode === filter.type) &&
      (mode === "code" ||
        filter.activity === "all" ||
        now - c.updatedAt <= filter.activity * day) &&
      inEnvironment(c, mode, filter),
  );
  if (filter.sort === "name")
    return nestSidebarRows(
      rows.sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
      ),
    );
  if (filter.sort === "created")
    return nestSidebarRows(rows.sort((a, b) => b.createdAt - a.createdAt));
  // Last activity keeps the manual drag order on top of recency.
  return nestSidebarRows(sortedSidebarConversations(rows));
}

/** Keeps nested sessions directly below their parent and honors its fold state. */
export function nestSidebarRows(rows: Conversation[]): Conversation[] {
  const byParent = new Map<string | undefined, Conversation[]>();
  const ids = new Set(rows.map((row) => row.id));
  for (const row of rows) {
    const parent =
      row.parentSessionId && ids.has(row.parentSessionId)
        ? row.parentSessionId
        : undefined;
    const group = byParent.get(parent) ?? [];
    group.push(row);
    byParent.set(parent, group);
  }
  const result: Conversation[] = [];
  const visited = new Set<string>();
  const visit = (row: Conversation) => {
    if (visited.has(row.id)) return;
    visited.add(row.id);
    result.push(row);
    if (row.nestedSessionsHidden) return;
    for (const child of byParent.get(row.id) ?? []) visit(child);
  };
  for (const root of byParent.get(undefined) ?? []) visit(root);
  // Rows not reached from a top-level row: under a folded parent they stay
  // hidden; a broken chain (a loop) still shows, once.
  const byId = new Map(rows.map((row) => [row.id, row]));
  const folded = (row: Conversation) => {
    const seen = new Set<string>();
    for (
      let parent = row.parentSessionId && byId.get(row.parentSessionId);
      parent && !seen.has(parent.id);
      parent = parent.parentSessionId && byId.get(parent.parentSessionId)
    ) {
      seen.add(parent.id);
      if (parent.nestedSessionsHidden && visited.has(parent.id)) return true;
    }
    return false;
  };
  for (const row of rows) if (!folded(row)) visit(row);
  return result;
}

/**
 * Whether the row shows under its parent (nestSidebarRows): the parent is in
 * the same list, pinned with it or not.
 */
export function isNestedSidebarRow(
  row: Conversation,
  all: readonly Conversation[],
) {
  const parent =
    row.parentSessionId && all.find((c) => c.id === row.parentSessionId);
  return Boolean(
    parent && parent.id !== row.id && parent.pinned === row.pinned,
  );
}

export function pinnedRows(conversations: Conversation[], mode: Mode) {
  return nestSidebarRows(
    sortedSidebarConversations(
      conversations.filter(
        (c) => surfaceModes[mode].includes(c.mode) && c.pinned && !c.archived,
      ),
    ),
  );
}

/**
 * Rows a sidebar section shows at first, and how many more each "Show N more"
 * reveals.
 */
export const sidebarRowBatch = 20;

/**
 * How many recent rows the sidebar draws: Code shows `revealed` (20, then
 * 20 more per Show more); Chat and Cowork stop at 20 and leave the rest to
 * View all, with no Show more.
 */
export const recentRowsShown = (mode: Mode, revealed: number): number =>
  mode === "code" ? revealed : sidebarRowBatch;
