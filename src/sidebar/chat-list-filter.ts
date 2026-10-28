import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { defaultFilter, type ListFilter } from "./listFilter";

/**
 * The Chat sidebar's type, status, activity, sort and grouping are kept for the
 * next start, as the original keeps recentsTypeFilter, recentsStatusFilter,
 * coworkActivityDays, sortByByMode and groupByByMode in dframe-store. Code's
 * own view is code-list-view.ts. Per account, in this browser or app.
 */
const keys = ["type", "status", "activity", "sort", "groupBy"] as const;
type Kept = Pick<ListFilter, (typeof keys)[number]>;

const types = ["all", "chat", "cowork"];
const statuses = ["active", "archived", "all"];
const activities = ["all", 1, 3, 7, 30];
const sorts = ["activity", "created", "name"];
const groupings = [
  "none",
  "date",
  "type",
  "unread",
  "folder",
  "custom",
  "state",
];

const storageKey = (accountId: string) =>
  `claudex.chat-list-filter.v1.${encodeURIComponent(accountId)}`;

export function parseChatFilter(raw?: string | null): ListFilter {
  let value: Partial<Record<keyof Kept, unknown>> = {};
  try {
    const parsed = JSON.parse(raw ?? "null");
    if (parsed && typeof parsed === "object") value = parsed;
  } catch {
    /* Ignore an old or damaged preference. */
  }
  const pick = <K extends keyof Kept>(
    key: K,
    allowed: readonly unknown[],
  ): Kept[K] =>
    allowed.includes(value[key])
      ? (value[key] as Kept[K])
      : (defaultFilter[key] as Kept[K]);
  return {
    ...defaultFilter,
    type: pick("type", types),
    status: pick("status", statuses),
    activity: pick("activity", activities),
    sort: pick("sort", sorts),
    groupBy: pick("groupBy", groupings),
  };
}

function read(accountId: string) {
  if (!accountId) return defaultFilter;
  try {
    return parseChatFilter(window.localStorage.getItem(storageKey(accountId)));
  } catch {
    return defaultFilter;
  }
}

function save(accountId: string, filter: ListFilter) {
  if (!accountId) return;
  const kept: Kept = {
    type: filter.type,
    status: filter.status,
    activity: filter.activity,
    sort: filter.sort,
    groupBy: filter.groupBy,
  };
  try {
    window.localStorage.setItem(storageKey(accountId), JSON.stringify(kept));
  } catch {
    /* No storage: the choice lasts until the window closes. */
  }
}

/** useState for the Chat list's filter, kept per account across starts. */
export function useChatListFilter(
  accountId: string,
): [ListFilter, Dispatch<SetStateAction<ListFilter>>] {
  const [state, setState] = useState(() => ({
    accountId,
    filter: read(accountId),
  }));
  let current = state;
  // Another account signed in: its own choice.
  if (state.accountId !== accountId) {
    current = { accountId, filter: read(accountId) };
    setState(current);
  }
  useEffect(() => {
    save(current.accountId, current.filter);
  }, [current]);
  const setFilter: Dispatch<SetStateAction<ListFilter>> = useCallback(
    (action) =>
      setState((previous) => ({
        accountId: previous.accountId,
        filter: typeof action === "function" ? action(previous.filter) : action,
      })),
    [],
  );
  return [current.filter, setFilter];
}
