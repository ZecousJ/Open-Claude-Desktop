import { currentLocale, formatText } from "../../i18n";
import {
  isCompletedOnce,
  routineDispatchAt,
  routineSections,
  type Routine,
} from "../../../shared/routines";
import { repeatOf } from "../../../shared/routine-labels";

/**
 * The filter menu's groups, as the original's. Completed one-time tasks are not
 * a status: the sort menu's Include completed shows them.
 */
export interface RoutineFilter {
  source?: "all" | "chat" | "code";
  /** Where the task runs; the group shows once tasks can run elsewhere. */
  runsOn:
    | "all"
    | "local"
    | "ssh"
    | "remote"
    | "cloud"
    | "this-computer"
    | "another-computer"
    | "local-only";
  /** Recurring tasks start by themselves, one-time ones once. */
  schedule: "all" | "recurring" | "once";
  status: "all" | "active" | "paused" | "auto-disabled" | "on-hold";
}
export type RoutineSort = "next" | "name" | "edited";

export const defaultRoutineFilter: RoutineFilter = {
  source: "all",
  runsOn: "all",
  schedule: "all",
  status: "all",
};

const sourceOf = (routine: Routine) =>
  routine.listMetadata?.source ??
  (routine.mode === "code"
    ? "code"
    : routine.mode === "cowork"
      ? "chat"
      : undefined);

export interface RoutineFilterCapabilities {
  cloud?: boolean;
  thisComputer?: boolean;
  sources?: ("chat" | "code")[];
  statuses?: ("active" | "paused" | "auto-disabled" | "on-hold")[];
  onHold?: (routine: Routine) => boolean;
}

/** Source-specific host metadata has precedence over legacy location fields. */
export const routineHostOf = (routine: Routine) =>
  routine.listMetadata?.host ??
  (routine.executionLocation === "remote"
    ? "cloud"
    : routine.environment?.kind === "ssh"
      ? "ssh"
      : undefined);

export function offeredRoutineFilters(
  rows: Routine[],
  capabilities: boolean | RoutineFilterCapabilities = false,
) {
  const supported: RoutineFilterCapabilities =
    typeof capabilities === "boolean" ? { cloud: capabilities } : capabilities;
  const sources = new Set([
    ...rows.map(sourceOf),
    ...(supported.sources ?? []),
  ]);
  const hosts = new Set<Exclude<RoutineFilter["runsOn"], "all">>();
  for (const row of rows) {
    const known = routineHostOf(row);
    if (known) hosts.add(known);
  }
  if (supported.cloud) hosts.add("cloud");
  if (supported.thisComputer) hosts.add("this-computer");
  const autoDisabled =
    supported.statuses?.includes("auto-disabled") ||
    rows.some((row) => !row.enabled && Boolean(row.endedReason));
  const onHold =
    supported.statuses?.includes("on-hold") ||
    rows.some(
      (row) =>
        row.enabled && Boolean(row.connectionHold || supported.onHold?.(row)),
    );
  return {
    sources: (["all", "chat", "code"] as const).filter(
      (source) => source === "all" || sources.has(source),
    ),
    hosts: (
      [
        "all",
        "cloud",
        "this-computer",
        "another-computer",
        "local-only",
        "ssh",
      ] as const
    ).filter((host) => host === "all" || hosts.has(host)),
    statuses: (
      ["all", "active", "paused", "auto-disabled", "on-hold"] as const
    ).filter((status) =>
      status === "auto-disabled"
        ? autoDisabled
        : status === "on-hold"
          ? onHold
          : true,
    ),
  };
}

export function routineAttention(
  routine: Routine,
  conversations: import("../../../shared/types").Conversation[],
  approvals: import("../../../shared/types").Approval[],
) {
  const summary = routine.listMetadata?.attention;
  const ids = new Set(summary?.conversationIds ?? []);
  if (routine.conversationId) ids.add(routine.conversationId);
  for (const conversation of conversations)
    if (conversation.scheduledTaskId === routine.id) ids.add(conversation.id);
  return {
    unread: Boolean(
      summary?.unread || conversations.some((c) => ids.has(c.id) && c.unread),
    ),
    awaiting: Boolean(
      summary?.awaiting || approvals.some((a) => ids.has(a.conversationId)),
    ),
    failed: Boolean(summary?.failed),
  };
}

/** Where a task runs, for the Runs on filter. */
export const runsOnOf = (routine: Routine): RoutineFilter["runsOn"] =>
  routine.executionLocation === "remote"
    ? "remote"
    : routine.environment?.kind === "ssh"
      ? "ssh"
      : "local";

export const isManual = (routine: Routine) =>
  repeatOf(routine).kind === "manual";

/** The Yours tab after search, filter and sort. */
export function visibleRoutines(
  routines: Routine[],
  query: string,
  filter: RoutineFilter,
  sort: RoutineSort,
  /** Whether a task is on hold (Computer access off). */
  onHold: (routine: Routine) => boolean = () => false,
): Routine[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = routines.filter((routine) => {
    const text =
      `${routine.name} ${routine.description ?? ""} ${routine.prompt}`.toLowerCase();
    if (!words.every((word) => text.includes(word))) return false;
    if (
      filter.source &&
      filter.source !== "all" &&
      sourceOf(routine) !== filter.source
    )
      return false;
    const kind = repeatOf(routine).kind;
    if (
      filter.runsOn !== "all" &&
      (filter.runsOn === "local" || filter.runsOn === "remote"
        ? runsOnOf(routine) !== filter.runsOn
        : routineHostOf(routine) !== filter.runsOn)
    )
      return false;
    if (
      filter.schedule !== "all" &&
      (filter.schedule === "once"
        ? kind !== "once"
        : kind === "manual" || kind === "once")
    )
      return false;
    const autoDisabled = !routine.enabled && Boolean(routine.endedReason);
    const held =
      routine.enabled && Boolean(routine.connectionHold || onHold(routine));
    if (filter.status === "active" && (!routine.enabled || held)) return false;
    if (
      filter.status === "paused" &&
      (routine.enabled || autoDisabled || isCompletedOnce(routine))
    )
      return false;
    if (filter.status === "auto-disabled" && !autoDisabled) return false;
    if (filter.status === "on-hold" && !held) return false;
    return true;
  });
  const byName = (a: Routine, b: Routine) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  // Paused, completed and manual routines have no upcoming run; they follow the rest.
  const upcoming = (routine: Routine) =>
    routine.enabled && !isManual(routine)
      ? routineDispatchAt(routine)
      : Infinity;
  return rows.sort((a, b) =>
    sort === "name"
      ? byName(a, b)
      : sort === "edited"
        ? b.updatedAt - a.updatedAt || byName(a, b)
        : upcoming(a) - upcoming(b) || byName(a, b),
  );
}

/** "Sep 29, 9:00 AM" */
export const runTime = (timestamp: number) =>
  new Date(timestamp).toLocaleString(currentLocale(), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** Relative calendar dates. */
export function cardRunTime(
  timestamp: number,
  now = Date.now(),
  approximate = false,
  direction: "future" | "past" = "future",
) {
  const date = new Date(timestamp);
  const today = new Date(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const time = `${approximate ? "~" : ""}${date.toLocaleTimeString(
    currentLocale(),
    {
      hour: "numeric",
      minute: "2-digit",
    },
  )}`;
  if (date.toDateString() === today.toDateString())
    return formatText("today at {time}", { time });
  if (direction === "future" && date.toDateString() === tomorrow.toDateString())
    return formatText("tomorrow at {time}", { time });
  if (direction === "past" && date.toDateString() === yesterday.toDateString())
    return formatText("yesterday at {time}", { time });
  return formatText("{date} at {time}", {
    date: date.toLocaleDateString(currentLocale(), {
      month: "short",
      day: "numeric",
      ...(date.getFullYear() === today.getFullYear()
        ? {}
        : { year: "numeric" }),
    }),
    time,
  });
}

/** Empty search/filter copy. */
export function noMatchText(
  searching: boolean,
  filtering: boolean,
  _web: boolean,
) {
  if (searching && filtering)
    return "No scheduled tasks match your search and filters.";
  if (searching) return "No scheduled tasks match your search.";
  return "No scheduled tasks match these filters.";
}

/** The list split into what is listed first and the Completed section after it. */
export function listSections(rows: Routine[]) {
  const { completed } = routineSections(rows);
  return {
    main: rows.filter((routine) => !completed.includes(routine)),
    completed,
  };
}
