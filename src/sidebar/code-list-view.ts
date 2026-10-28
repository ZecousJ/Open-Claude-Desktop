import { lastActivityAt } from "../../shared/conversation-order";
import { useSyncExternalStore } from "react";
import type { Conversation } from "../../shared/types";
import type { ConversationGroups } from "../../shared/collections-api";
import { groupRows, type RowGroup } from "./grouping";
import { nestSidebarRows } from "./listFilter";
import { shownFolder } from "../../shared/session-folder";

/** Current session-list view: O14/shared-20:17480–17535,24528–24688. */
export type CodeListView = {
  groupBy: "none" | "date" | "status" | "folder" | "environment";
  sort: "updated" | "created" | "name";
  ascending: boolean;
  metadata: boolean;
  emptyGroups: boolean;
};
export const defaultCodeListView: CodeListView = {
  groupBy: "none",
  sort: "updated",
  ascending: false,
  metadata: false,
  emptyGroups: false,
};
export function parseCodeListView(raw?: string | null): CodeListView {
  let value: Partial<CodeListView> = {};
  try {
    const parsed = JSON.parse(raw ?? "null");
    if (parsed && typeof parsed === "object") value = parsed;
  } catch {
    /* Ignore an old or damaged preference. */
  }
  return {
    groupBy: ["none", "date", "status", "folder", "environment"].includes(
      value.groupBy ?? "",
    )
      ? value.groupBy!
      : "none",
    sort: ["updated", "created", "name"].includes(value.sort ?? "")
      ? value.sort!
      : "updated",
    ascending: value.ascending === true,
    metadata: value.metadata === true,
    emptyGroups: value.emptyGroups === true,
  };
}
export const isDefaultCodeListView = (view: CodeListView) =>
  (Object.keys(defaultCodeListView) as (keyof CodeListView)[]).every(
    (key) => view[key] === defaultCodeListView[key],
  );

const changed = "claudex-code-list-view";
const fallback = new Map<string, string>();
const keyFor = (accountId: string) =>
  `claudex.code-list-view.v1.${encodeURIComponent(accountId)}`;
export function readCodeListView(accountId: string): string | null {
  if (!accountId) return null;
  const key = keyFor(accountId);
  if (fallback.has(key)) return fallback.get(key)!;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function saveCodeListView(accountId: string, view: CodeListView) {
  if (!accountId) return;
  const key = keyFor(accountId),
    raw = JSON.stringify(view);
  try {
    window.localStorage.setItem(key, raw);
    fallback.delete(key);
  } catch {
    fallback.set(key, raw);
  }
  window.dispatchEvent(new window.Event(changed));
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key) fallback.delete(event.key);
    else fallback.clear();
    listener();
  };
  window.addEventListener(changed, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(changed, listener);
    window.removeEventListener("storage", storage);
  };
}
export function useCodeListView(accountId: string) {
  const raw = useSyncExternalStore(
    subscribe,
    () => readCodeListView(accountId),
    () => null,
  );
  return [
    parseCodeListView(raw),
    (next: CodeListView) => saveCodeListView(accountId, next),
  ] as const;
}

/** Sort before nesting: reversing the flattened tree would put children first. */
export function codeListRows(rows: Conversation[], view: CodeListView) {
  const direction = view.ascending ? 1 : -1;
  return nestSidebarRows(
    rows
      .filter((c) => c.mode === "code" && !c.archived && !c.pinned)
      .sort((a, b) => {
        const order =
          view.sort === "name"
            ? a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
            : view.sort === "created"
              ? a.createdAt - b.createdAt
              : lastActivityAt(a) - lastActivityAt(b);
        return direction * order || a.id.localeCompare(b.id);
      }),
  );
}

export type CodePlace = {
  key: string;
  label: string;
  kind: "local" | "cloud" | "ssh" | "bridge";
  connected?: boolean;
};
/** Only explicit connection facts can say Connected/Offline. Missing is unknown. */
export function codePlace(c: Conversation): CodePlace {
  if (c.linkedToComputer || c.linkedComputerId)
    return {
      key: `bridge:${c.linkedComputerId ?? ""}`,
      kind: "bridge",
      label: c.linkedComputerName || "Remote Control",
      connected:
        c.linkedComputerOnline === false || c.linkedComputerAccess === false
          ? false
          : c.linkedComputerOnline === true && c.linkedComputerAccess === true
            ? true
            : undefined,
    };
  if (c.environment?.kind === "ssh")
    return { key: `ssh:${c.environment.hostId}`, kind: "ssh", label: "SSH" };
  if (c.environment?.kind === "space" || c.cloudEnvironmentId)
    return {
      key: `cloud:${c.cloudEnvironmentId ?? (c.environment?.kind === "space" ? c.environment.spaceId : "")}`,
      kind: "cloud",
      label: "Cloud",
    };
  return { key: "local", kind: "local", label: "This computer" };
}
const statusLabels = {
  blocked: "Needs input",
  review: "Ready for review",
  working: "Working",
  done: "Completed",
} as const;
export function codeSessionState(
  c: Conversation,
  approvals: ReadonlySet<string>,
) {
  if (approvals.has(c.id)) return "blocked";
  if (c.turns.some((t) => t.status === "inProgress")) return "working";
  if (c.sessionState === "blocked" || c.turns.at(-1)?.status === "failed")
    return "blocked";
  if (c.sessionState === "ready_for_review") return "review";
  return "done";
}
export type CodeRowGroup = RowGroup & {
  noTranslate?: boolean;
  hidePlace?: boolean;
};
/** Custom sections are independent of Group by, never lost when it is None. */
export function codeListGroups(
  rows: Conversation[],
  view: CodeListView,
  custom: ConversationGroups,
  showEmpty: (id: string) => boolean,
  approvals: ReadonlySet<string>,
  classify = true,
  now = Date.now(),
): CodeRowGroup[] {
  const customIds = new Set(custom.groups.map((g) => g.id));
  const own: Conversation[] = [],
    rest: Conversation[] = [];
  for (const c of rows)
    (customIds.has(custom.members[c.id] ?? "") ? own : rest).push(c);
  const sections = groupRows(own, "custom", now, custom, showEmpty);
  const by = view.groupBy === "status" && !classify ? "date" : view.groupBy;
  if (by === "none")
    return [...sections, { key: "ungrouped", label: "", rows: rest }];
  if (by === "date") return [...sections, ...groupRows(rest, by, now)];
  const buckets = new Map<string, CodeRowGroup>();
  for (const c of rest) {
    const place = codePlace(c),
      state = codeSessionState(c, approvals);
    const cwd = shownFolder(c.cwd);
    const folder = cwd?.split(/[\\/]/).filter(Boolean).at(-1);
    const key =
      by === "status"
        ? state
        : by === "folder"
          ? (cwd ?? place.key)
          : place.key;
    const label =
      by === "status"
        ? statusLabels[state]
        : by === "folder"
          ? (folder ?? place.label)
          : place.label;
    const bucket = buckets.get(key) ?? {
      key,
      label,
      rows: [],
      noTranslate:
        (by === "folder" && Boolean(folder)) ||
        (by === "environment" && Boolean(c.linkedComputerName)),
    };
    bucket.rows.push(c);
    buckets.set(key, bucket);
  }
  const built = [...buckets.values()];
  if (by === "folder" || by === "environment")
    for (const group of built)
      group.hidePlace =
        new Set(group.rows.map((c) => codePlace(c).key)).size === 1;
  if (by === "status")
    built.sort(
      (a, b) =>
        ["blocked", "review", "working", "done"].indexOf(a.key) -
        ["blocked", "review", "working", "done"].indexOf(b.key),
    );
  return [...sections, ...built];
}
