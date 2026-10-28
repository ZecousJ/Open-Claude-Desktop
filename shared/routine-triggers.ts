/**
 * What starts a scheduled task besides its schedule: a call to its fire address
 * with a token ("API"), or an event of a GitHub repository ("GitHub event"). A
 * task has at most one of each, and its schedule can be switched off when
 * another one starts it. Either of the two makes the task a Code task on the
 * web: it runs as a cloud session, on a repository when it names one.
 */
import type { RepositoryRef } from "./host";

/** A trigger's id: "trg_" and 24 base-62 characters, unguessable. */
export const routineTriggerIdPattern = /^trg_[0-9A-Za-z]{24}$/;

export interface RoutineApiTrigger {
  id: string;
  /**
   * The current token's last characters, set by the service when a token
   * is made; none while the task has no token (its API access is off).
   */
  tokenHint?: string;
}

/** How a GitHub event's field is compared (FILTER_OP_*). */
export type RoutineFilterOp =
  "in" | "not_in" | "starts_with" | "contains" | "matches" | "eq";
export interface RoutineGitHubFilter {
  /** A dotted path into the event's payload ("pull_request.base.ref"). */
  field: string;
  op: RoutineFilterOp;
  value: string;
}
export interface RoutineGitHubTrigger {
  id: string;
  /** "owner/name". */
  repository: string;
  /** The webhook events and actions it runs on ("pull_request.opened"). */
  events: string[];
  filters: RoutineGitHubFilter[];
}

/**
 * The events a GitHub trigger offers, by webhook, "pull_request.opened" by
 * default.
 */
export const routineGitHubEvents = [
  {
    value: "pull_request",
    actions: [
      "assigned",
      "auto_merge_disabled",
      "auto_merge_enabled",
      "closed",
      "converted_to_draft",
      "demilestoned",
      "dequeued",
      "edited",
      "enqueued",
      "labeled",
      "locked",
      "milestoned",
      "opened",
      "ready_for_review",
      "reopened",
      "review_request_removed",
      "review_requested",
      "synchronize",
      "unassigned",
      "unlabeled",
      "unlocked",
    ],
  },
  {
    value: "release",
    actions: [
      "created",
      "deleted",
      "edited",
      "prereleased",
      "published",
      "released",
      "unpublished",
    ],
  },
  {
    value: "issues",
    actions: [
      "assigned",
      "closed",
      "deleted",
      "demilestoned",
      "edited",
      "labeled",
      "locked",
      "milestoned",
      "opened",
      "pinned",
      "reopened",
      "transferred",
      "typed",
      "unassigned",
      "unlabeled",
      "unlocked",
      "unpinned",
      "untyped",
    ],
  },
] as const;
export const defaultGitHubEvents = ["pull_request.opened"];
const knownEvents = new Set<string>(
  routineGitHubEvents.flatMap((group) =>
    group.actions.map((action) => `${group.value}.${action}`),
  ),
);

/** The fields a filter can test, by webhook. */
export const routineFilterFields = {
  pull_request: [
    { value: "pr.author", type: "string" },
    { value: "pr.title", type: "string" },
    { value: "pr.body", type: "string" },
    { value: "pr.base_branch", type: "string" },
    { value: "pr.head_branch", type: "string" },
    { value: "pr.labels", type: "string-list" },
    { value: "pr.draft", type: "bool" },
    { value: "pr.merged", type: "bool" },
  ],
  release: [
    { value: "release.tag_name", type: "string" },
    { value: "release.target_commitish", type: "string" },
    { value: "release.name", type: "string" },
    { value: "release.draft", type: "bool" },
    { value: "release.prerelease", type: "bool" },
  ],
  issues: [
    { value: "issue.author", type: "string" },
    { value: "issue.title", type: "string" },
    { value: "issue.body", type: "string" },
    { value: "issue.state", type: "string" },
    { value: "issue.labels", type: "string-list" },
  ],
} as const;
export type RoutineFilterType = "string" | "string-list" | "bool";
/** The operators each kind of field takes. */
export const routineFilterOps: Record<RoutineFilterType, RoutineFilterOp[]> = {
  string: ["in", "not_in", "starts_with", "contains", "matches", "eq"],
  "string-list": ["in", "not_in"],
  bool: ["eq"],
};
export function routineFilterType(field: string): RoutineFilterType {
  for (const fields of Object.values(routineFilterFields))
    for (const known of fields) if (known.value === field) return known.type;
  return "string";
}

/** An event's fields, as the service reads them from the webhook. */
export type RoutineEventFields = Record<string, string | string[] | boolean>;

/** Whether one condition holds for the event's fields (whole-string regex). */
export function routineFilterMatches(
  filter: RoutineGitHubFilter,
  fields: RoutineEventFields,
): boolean {
  const value = fields[filter.field];
  if (value === undefined) return false;
  const wanted = filter.value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const values = Array.isArray(value) ? value : [String(value)];
  switch (filter.op) {
    case "in":
      return values.some((one) => wanted.includes(one));
    case "not_in":
      return !values.some((one) => wanted.includes(one));
    case "starts_with":
      return values.some((one) => one.startsWith(filter.value));
    case "contains":
      return values.some((one) => one.includes(filter.value));
    case "matches":
      try {
        const pattern = new RegExp(`^(?:${filter.value})$`);
        return values.some((one) => pattern.test(one));
      } catch {
        return false;
      }
    case "eq":
      return values.some((one) => one === filter.value.trim());
  }
}

/** Whether an event starts a task's GitHub trigger: one of its events,
 * every condition holding. */
export function routineGitHubMatches(
  trigger: RoutineGitHubTrigger,
  event: string,
  fields: RoutineEventFields,
): boolean {
  return (
    trigger.events.includes(event) &&
    trigger.filters.every((filter) => routineFilterMatches(filter, fields))
  );
}

export interface RoutineTriggers {
  /** Whether the schedule starts the task (it always can by Run now). */
  schedule: boolean;
  api?: RoutineApiTrigger;
  github?: RoutineGitHubTrigger;
}

/** The repository and environment a Code task on the web runs in. */
export interface RoutineCloudPlace {
  repository?: RepositoryRef;
  cloudEnvironmentId?: string;
}

/** A new trigger id (crypto.getRandomValues on both hosts). */
export function newRoutineTriggerId() {
  const alphabet =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  let id = "trg_";
  // 248 = 4 × 62: values above it are drawn again, so every character is even.
  for (let i = 0; i < bytes.length; i++) {
    let value = bytes[i];
    while (value >= 248) {
      const one = new Uint8Array(1);
      globalThis.crypto.getRandomValues(one);
      value = one[0];
    }
    id += alphabet[value % 62];
  }
  return id;
}

const filterOps = new Set<RoutineFilterOp>([
  "in",
  "not_in",
  "starts_with",
  "contains",
  "matches",
  "eq",
]);

/**
 * A saved task's triggers made sound: unknown shapes dropped, at most ten
 * filters, and the token hint taken from what was saved before (the
 * service owns it, a save never sets it).
 */
export function cleanRoutineTriggers(
  value: unknown,
  before?: RoutineTriggers,
): RoutineTriggers | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<RoutineTriggers>;
  const result: RoutineTriggers = { schedule: raw.schedule !== false };
  const api = raw.api as Partial<RoutineApiTrigger> | undefined;
  if (api && typeof api.id === "string" && routineTriggerIdPattern.test(api.id))
    result.api = {
      id: api.id,
      ...(before?.api?.id === api.id && before.api.tokenHint
        ? { tokenHint: before.api.tokenHint }
        : {}),
    };
  const github = raw.github as Partial<RoutineGitHubTrigger> | undefined;
  if (
    github &&
    typeof github.id === "string" &&
    routineTriggerIdPattern.test(github.id) &&
    typeof github.repository === "string" &&
    /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(github.repository) &&
    Array.isArray(github.events) &&
    github.events.some((event) => knownEvents.has(event))
  )
    result.github = {
      id: github.id,
      repository: github.repository,
      events: [
        ...new Set(github.events.filter((event) => knownEvents.has(event))),
      ],
      filters: (Array.isArray(github.filters) ? github.filters : [])
        .filter(
          (filter): filter is RoutineGitHubFilter =>
            !!filter &&
            typeof filter.field === "string" &&
            /^[\w.]{1,200}$/.test(filter.field) &&
            filterOps.has(filter.op) &&
            typeof filter.value === "string" &&
            filter.value.length <= 1000,
        )
        .slice(0, 10)
        .map(({ field, op, value }) => ({ field, op, value })),
    };
  return result;
}

/** Whether nothing starts the task but Run now. */
export function routineHasNoTrigger(triggers: RoutineTriggers | undefined) {
  return !!triggers && !triggers.schedule && !triggers.api && !triggers.github;
}

/** Where the task's fire address answers, under the service's origin. */
export function routineFirePath(triggerId: string) {
  return `/api/v1/claudex/routines/${triggerId}/fire`;
}

/** The webhooks a trigger's events come by ("pull_request.opened" →
 * "pull_request"). */
export function githubWebhooks(events: readonly string[]): string[] {
  return [...new Set(events.map((event) => event.split(".")[0]))].sort();
}

/** The "Pull request: Merged" choice: closed pull requests that merged. */
export const mergedPreset = "preset:pr_merged";
const mergedFilter: RoutineGitHubFilter = {
  field: "pr.merged",
  op: "eq",
  value: "true",
};
export function isMergedPreset(
  trigger: Pick<RoutineGitHubTrigger, "events" | "filters">,
) {
  return (
    trigger.events.length === 1 &&
    trigger.events[0] === "pull_request.closed" &&
    trigger.filters.length === 1 &&
    trigger.filters[0].field === mergedFilter.field &&
    trigger.filters[0].op === mergedFilter.op &&
    trigger.filters[0].value.trim() === mergedFilter.value
  );
}

/** The webhook a trigger's events belong to ("pull_request"). */
export function githubEventCategory(events: readonly string[]) {
  return events[0]?.split(".")[0] ?? "pull_request";
}

/** What the trigger's event choice shows: the merged preset, a whole
 * webhook ("pull_request"), one event, or undefined when it is a mix. */
export function githubEventChoice(
  trigger: Pick<RoutineGitHubTrigger, "events" | "filters">,
): string | undefined {
  if (isMergedPreset(trigger)) return mergedPreset;
  if (trigger.events.length === 1) return trigger.events[0];
  const group = routineGitHubEvents.find(
    (one) => one.value === githubEventCategory(trigger.events),
  );
  return group &&
    trigger.events.length === group.actions.length &&
    group.actions.every((action) =>
      trigger.events.includes(`${group.value}.${action}`),
    )
    ? group.value
    : undefined;
}

/**
 * The events and filters after choosing an event: a whole webhook takes all its
 * actions, the merged preset its condition, and a change of webhook (or leaving
 * the preset) clears the conditions, whose fields belong to the webhook.
 */
export function chooseGitHubEvent(
  trigger: Pick<RoutineGitHubTrigger, "events" | "filters">,
  choice: string,
): Pick<RoutineGitHubTrigger, "events" | "filters"> {
  if (choice === mergedPreset)
    return { events: ["pull_request.closed"], filters: [{ ...mergedFilter }] };
  const group = routineGitHubEvents.find((one) => one.value === choice);
  const events = group
    ? group.actions.map((action) => `${group.value}.${action}`)
    : [choice];
  const keep =
    githubEventCategory(trigger.events) === githubEventCategory(events) &&
    !isMergedPreset(trigger);
  return { events, filters: keep ? trigger.filters : [] };
}

/** A new condition on a field: its first operator, true for a switch. */
export function newRoutineFilter(field: string): RoutineGitHubFilter {
  const type = routineFilterType(field);
  return {
    field,
    op: routineFilterOps[type][0],
    value: type === "bool" ? "true" : "",
  };
}

/** The fields a trigger's conditions can test, by its webhook. */
export function githubFilterFields(events: readonly string[]) {
  const category = githubEventCategory(events);
  return category === "release"
    ? routineFilterFields.release
    : category === "issues"
      ? routineFilterFields.issues
      : routineFilterFields.pull_request;
}
