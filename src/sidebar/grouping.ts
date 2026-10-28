import { useContext, useEffect, useState } from "react";
import type { Conversation, Mode } from "../../shared/types";
import type { ConversationGroups } from "../../shared/collections-api";
import { AppContext } from "../app/AppContext";
import { currentLocale } from "../i18n";
import {
  chatGroupState,
  chatGroupStateLabels,
  chatGroupStateOrder,
} from "./chat-state-groups";
import { shownFolder } from "../../shared/session-folder";

/**
 * Group by in the recent list's filter menu. Chat offers Date, Type, Unread and
 * Custom groups; Code offers Date, Folder and Custom groups. State is not
 * offered: Claudex has no remote session states to group by.
 */
export type GroupBy =
  "none" | "date" | "type" | "unread" | "folder" | "custom" | "state";

export type RowGroup = { key: string; label: string; rows: Conversation[] };

const offered: Record<"chat" | "code", GroupBy[]> = {
  chat: ["date", "type", "unread", "custom", "state"],
  code: ["date", "folder", "custom"],
};

/** The grouping a surface uses; one it does not offer falls back to none. */
export const effectiveGroupBy = (mode: Mode, by: GroupBy): GroupBy =>
  offered[mode === "code" ? "code" : "chat"].includes(by) ? by : "none";

const day = 86_400_000;

/**
 * The day groups of Group by Date: Today, Yesterday, the five days before as a
 * short date ("Oct 10"), and Older.
 */
function dateBucket(time: number, now: number) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const then = new Date(time);
  then.setHours(0, 0, 0, 0);
  // Calendar days, so a daylight saving change doesn't shift a boundary.
  const ago = Math.max(0, Math.round((start.getTime() - then.getTime()) / day));
  if (ago === 0) return { key: "day-0", label: "Today" };
  if (ago === 1) return { key: "day-1", label: "Yesterday" };
  if (ago < 7)
    return {
      key: `day-${ago}`,
      label: new Intl.DateTimeFormat(currentLocale(), {
        month: "short",
        day: "numeric",
      }).format(then),
    };
  return { key: "older", label: "Older" };
}

const folderName = (cwd?: string) =>
  shownFolder(cwd)?.split(/[\\/]/).filter(Boolean).at(-1) ?? "No folder";

export const noGroups: ConversationGroups = { groups: [], members: {} };

/**
 * Splits already ordered rows into labelled groups, keeping the row order
 * within each group and ordering groups by their first row. Custom groups
 * follow the order the person created them in, with Ungrouped last; a
 * custom group with no rows is left out unless `showEmpty` says to keep its
 * heading (see `emptyGroupsShown`).
 */
export function groupRows(
  rows: Conversation[],
  by: GroupBy,
  now = Date.now(),
  custom: ConversationGroups = noGroups,
  showEmpty?: (groupId: string) => boolean,
  approvals: ReadonlySet<string> = new Set(),
): RowGroup[] {
  if (by === "none") return [{ key: "all", label: "", rows }];
  if (by === "state") {
    const groups = new Map<string, RowGroup>();
    for (const row of rows) {
      const state = chatGroupState(row, approvals);
      const group = groups.get(state) ?? {
        key: `chat-state-${state}`,
        label: chatGroupStateLabels[state],
        rows: [],
      };
      group.rows.push(row);
      groups.set(state, group);
    }
    return chatGroupStateOrder.flatMap((state) =>
      groups.get(state) ? [groups.get(state)!] : [],
    );
  }
  if (by === "custom") {
    const order = new Map(
      custom.groups.map((group, index) => [group.id, index]),
    );
    const buckets = custom.groups.map((group) => ({
      key: `group:${group.id}`,
      label: group.name,
      rows: [] as Conversation[],
    }));
    const ungrouped: RowGroup = {
      key: "ungrouped",
      label: "Ungrouped",
      rows: [],
    };
    for (const row of rows) {
      const index = order.get(custom.members[row.id] ?? "");
      (index === undefined ? ungrouped : buckets[index]).rows.push(row);
    }
    return [
      ...buckets.filter(
        (group, index) =>
          group.rows.length > 0 ||
          Boolean(showEmpty?.(custom.groups[index].id)),
      ),
      ...(ungrouped.rows.length ? [ungrouped] : []),
    ];
  }
  const label = (c: Conversation) => {
    if (by === "date") return dateBucket(c.updatedAt, now).label;
    if (by === "type") return c.mode === "cowork" ? "Tasks" : "Chats";
    if (by === "unread") return c.unread ? "Unread" : "Read";
    return folderName(c.cwd);
  };
  const groups = new Map<string, RowGroup>();
  for (const row of rows) {
    const name = label(row);
    const key =
      by === "folder"
        ? (row.cwd ?? "")
        : by === "date"
          ? dateBucket(row.updatedAt, now).key
          : name;
    const group = groups.get(key) ?? { key, label: name, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  const ordered = [...groups.values()];
  // Unread first regardless of recency, as the grouping exists to find them.
  if (by === "unread")
    ordered.sort(
      (a, b) => Number(b.key === "Unread") - Number(a.key === "Unread"),
    );
  return ordered;
}

// The account's custom groups, shared by every row, list and filter in the
// window. Changes come back from the main process as the whole state.
let current: ConversationGroups = noGroups;
let loaded: Promise<void> | undefined;
const listeners = new Set<(groups: ConversationGroups) => void>();

/** Stores the state the main process returned and tells every subscriber. */
export function setConversationGroups(next: ConversationGroups) {
  current = next;
  for (const listener of [...listeners]) listener(next);
  return next;
}

// Groups this window keeps showing while they are empty: one just made with New
// group…, and one whose conversation was just moved elsewhere.
const keptWhileEmpty = new Set<string>();

/** Keeps a group's heading in this window when nothing is left in it. */
export function keepGroupWhileEmpty(groupId: string) {
  keptWhileEmpty.add(groupId);
}

/** The groups as last stored, without subscribing. */
export const currentConversationGroups = () => current;

/** The group id that `next` has and `before` did not (the one just created). */
export function addedGroupId(
  before: ConversationGroups,
  next: ConversationGroups,
) {
  const known = new Set(before.groups.map((group) => group.id));
  return next.groups.find((group) => !known.has(group.id))?.id;
}

/**
 * Which custom groups with no row in the list still get their heading, with the
 * "Drag or move sessions here" line under it: Chat and Cowork always show every
 * group; Code shows an empty one when Show empty groups is on, or while this
 * window keeps it. `listed` holds the groups that have a row in the whole
 * filtered list, so a group whose rows are only past Show more is not drawn as
 * empty.
 */
export function emptyGroupsShown(
  mode: Mode,
  showEmptyGroups: boolean,
  listed: ReadonlySet<string>,
  unifiedChat = false,
) {
  return (groupId: string) =>
    !listed.has(groupId) &&
    ((!unifiedChat && mode !== "code") ||
      showEmptyGroups ||
      keptWhileEmpty.has(groupId));
}

/** Reads the groups again (after a sign-in or an account switch). */
export function reloadConversationGroups() {
  loaded = Promise.resolve()
    .then(() => window.desktop.listConversationGroups())
    .then((groups) => {
      if (groups) setConversationGroups(groups);
    })
    .catch(() => {
      // No groups file yet or no account: the sidebar shows no custom groups.
    });
  return loaded;
}

let loadedFor: string | undefined;

/** The custom groups; loads them once per signed-in account. */
export function useConversationGroups() {
  const accountId = useContext(AppContext)?.accountId;
  const [groups, setGroups] = useState(current);
  useEffect(() => {
    listeners.add(setGroups);
    setGroups(current);
    return () => {
      listeners.delete(setGroups);
    };
  }, []);
  useEffect(() => {
    if (loaded && loadedFor === accountId) return;
    loadedFor = accountId;
    current = noGroups;
    keptWhileEmpty.clear();
    setConversationGroups(noGroups);
    void reloadConversationGroups();
  }, [accountId]);
  return groups;
}
