import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AppIcon } from "../../ui/app-icon";
import { IconButton } from "../../ui/Controls";
import { ChevronDown } from "../../ui/glyphs";
import { WithTooltip } from "../../ui/Tooltip";
import { lazyPiece } from "../../ui/lazy-piece";
import { t, tc, formatText } from "../../i18n";
import { api } from "../../desktop-api";
import { AppContext } from "../../app/AppContext";
import { Choice } from "./ScheduledTaskDialog";
import type {
  GitHubRepository,
  GitHubStatus,
} from "../../../shared/github-api";
import {
  chooseGitHubEvent,
  githubEventChoice,
  githubFilterFields,
  mergedPreset,
  newRoutineFilter,
  routineFilterOps,
  routineFilterType,
  routineGitHubEvents,
  type RoutineFilterOp,
  type RoutineGitHubFilter,
  type RoutineGitHubTrigger,
} from "../../../shared/routine-triggers";

const RepositoryMenu = lazyPiece(
  () => import("../../composer/RepositoryMenu"),
  "RepositoryMenu",
);

/** What each event action is called, the same under every webhook. */
const actionLabels: Record<string, string> = {
  assigned: "Assigned",
  auto_merge_disabled: "Auto-merge disabled",
  auto_merge_enabled: "Auto-merge enabled",
  closed: "Closed",
  converted_to_draft: "Converted to draft",
  demilestoned: "Removed from milestone",
  dequeued: "Removed from merge queue",
  edited: "Edited",
  enqueued: "Added to merge queue",
  labeled: "Labeled",
  locked: "Locked",
  milestoned: "Added to milestone",
  opened: "Opened",
  ready_for_review: "Ready for review",
  reopened: "Reopened",
  review_request_removed: "Review request removed",
  review_requested: "Review requested",
  synchronize: "Commits pushed",
  unassigned: "Unassigned",
  unlabeled: "Unlabeled",
  unlocked: "Unlocked",
  merged: "Merged",
  created: "Created",
  deleted: "Deleted",
  prereleased: "Pre-released",
  published: "Published",
  released: "Released",
  unpublished: "Unpublished",
  pinned: "Pinned",
  transferred: "Transferred",
  typed: "Type added",
  unpinned: "Unpinned",
  untyped: "Type removed",
};
const categoryLabels: Record<string, string> = {
  pull_request: "Pull request",
  release: "Release",
  issues: "Issue",
};
const allLabels: Record<string, string> = {
  pull_request: "All pull request events",
  release: "All release events",
  issues: "All issue events",
};
const fieldLabels: Record<string, string> = {
  "pr.author": "Author",
  "pr.title": "Title",
  "pr.body": "Body",
  "pr.base_branch": "Base branch",
  "pr.head_branch": "Head branch",
  "pr.labels": "Labels",
  "pr.draft": "Is draft",
  "pr.merged": "Is merged",
  "release.tag_name": "Tag name",
  "release.target_commitish": "Target branch",
  "release.name": "Release name",
  "release.draft": "Is draft",
  "release.prerelease": "Is prerelease",
  "issue.author": "Author",
  "issue.title": "Title",
  "issue.body": "Body",
  "issue.state": "State",
  "issue.labels": "Labels",
};
const opLabels: Record<RoutineFilterOp, string> = {
  in: "is one of",
  not_in: "is not one of",
  starts_with: "starts with",
  contains: "contains",
  matches: "matches regex (whole string)",
  eq: "equals",
};

const eventLabel = (category: string, action: string) =>
  formatText("{category}: {actions}", {
    category: t(categoryLabels[category] ?? category),
    actions: t(actionLabels[action] ?? action.replace(/_/g, " ")),
  });

/**
 * Every webhook, then each of its events; "Pull request: Merged" after Closed.
 */
const eventOptions = (): [string, string][] =>
  routineGitHubEvents.flatMap((group) => [
    [group.value, t(allLabels[group.value])] as [string, string],
    ...group.actions.flatMap((action): [string, string][] => [
      [`${group.value}.${action}`, eventLabel(group.value, action)],
      ...(group.value === "pull_request" && action === "closed"
        ? [
            [mergedPreset, eventLabel("pull_request", "merged")] as [
              string,
              string,
            ],
          ]
        : []),
    ]),
  ]);

/** A mix of events, as the trigger's row names it. */
function eventsSummary(events: readonly string[]) {
  const groups = new Map<string, string[]>();
  for (const event of events) {
    const [category, action = ""] = event.split(".");
    groups.set(category, [...(groups.get(category) ?? []), action]);
  }
  return [...groups]
    .map(([category, actions]) =>
      eventLabel(
        category,
        actions.map((action) => t(actionLabels[action] ?? action)).join(", "),
      ),
    )
    .join("; ");
}

/**
 * A GitHub event trigger's row: its name, the repository it listens to and its
 * remove button; once a repository is chosen, a card under it with the event,
 * the filter's conditions (field, operator, value, remove), the run limit
 * warning while nothing narrows it, and who the runs act as.
 */
export function RoutineGitHubTrigger({
  trigger,
  busy,
  creating,
  remove,
  onChange,
  onRepository,
}: {
  trigger: RoutineGitHubTrigger;
  busy: boolean;
  /** A task not saved yet: says whose account the runs act as. */
  creating: boolean;
  remove: ReactNode;
  onChange: (patch: Partial<RoutineGitHubTrigger>) => void;
  onRepository: (repository: GitHubRepository) => void;
}) {
  const email = useContext(AppContext)?.accountEmail;
  const choice = githubEventChoice(trigger);
  const fields = githubFilterFields(trigger.events);
  const filters = trigger.filters;
  const setFilter = (index: number, next: RoutineGitHubFilter) =>
    onChange({
      filters: filters.map((one, at) => (at === index ? next : one)),
    });
  return (
    <div
      className={`task-trigger-item task-trigger-github${trigger.repository ? " with-card" : ""}`}
    >
      <div className="task-trigger-line">
        <span className="task-trigger-name">
          <AppIcon name="GitPullRequest" size={16} />
          GitHub event
        </span>
        <RepositoryChoice
          repository={trigger.repository}
          disabled={busy}
          onChoose={onRepository}
        />
        {remove}
      </div>
      {trigger.repository && (
        <div className="routine-github-card">
          <div className="routine-github-row">
            <span>{tc("webhook", "Event")}</span>
            <Choice
              label={tc("webhook", "Event")}
              value={choice ?? ""}
              options={eventOptions()}
              triggerText={choice ? undefined : eventsSummary(trigger.events)}
              minMenuWidth={240}
              caretSize={16}
              className="routine-github-select"
              disabled={busy}
              onChange={(value) => onChange(chooseGitHubEvent(trigger, value))}
            />
          </div>
          <div className="routine-github-filter">
            <div className="routine-github-filter-head">
              <span>Filter</span>
              <IconButton
                label={
                  filters.length
                    ? "Add another condition"
                    : "Add a filter condition"
                }
                className="routine-github-icon"
                disabled={busy || filters.length >= 10}
                onClick={() =>
                  onChange({
                    filters: [...filters, newRoutineFilter(fields[0].value)],
                  })
                }
              >
                <AppIcon name="Add" size={20} />
              </IconButton>
            </div>
            {filters.map((filter, index) => (
              <FilterRow
                key={index}
                filter={filter}
                fields={fields}
                disabled={busy}
                onChange={(next) => setFilter(index, next)}
                onRemove={() =>
                  onChange({ filters: filters.filter((_, at) => at !== index) })
                }
              />
            ))}
          </div>
          {!filters.length && (
            <p className="routine-github-warning">
              {t(
                "Fires on every matching event, which can use up your run limits quickly. Add a filter to narrow it down.",
              )}
            </p>
          )}
          {creating && email && (
            <WithTooltip
              label={t(
                "Sessions fire with your Claudex settings, CLAUDE.md, and skills.",
              )}
            >
              {(props) => (
                <p className="routine-github-runs-as" {...props}>
                  {formatText("Runs as {email}", { email })}
                </p>
              )}
            </WithTooltip>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One condition: field, operator, value and its remove button; a regex says it
 * matches the whole string.
 */
function FilterRow({
  filter,
  fields,
  disabled,
  onChange,
  onRemove,
}: {
  filter: RoutineGitHubFilter;
  fields: ReturnType<typeof githubFilterFields>;
  disabled: boolean;
  onChange: (next: RoutineGitHubFilter) => void;
  onRemove: () => void;
}) {
  const type = routineFilterType(filter.field);
  const list = (op: RoutineFilterOp) => op === "in" || op === "not_in";
  return (
    <div className="routine-github-clause">
      <div className="routine-github-clause-line">
        <Choice
          label="Field"
          value={filter.field}
          options={fields.map(
            (field) =>
              [field.value, t(fieldLabels[field.value] ?? field.value)] as [
                string,
                string,
              ],
          )}
          caretSize={16}
          className="routine-github-select routine-github-field"
          disabled={disabled}
          onChange={(field) => {
            if (field !== filter.field) onChange(newRoutineFilter(field));
          }}
        />
        <Choice
          label="Operator"
          value={filter.op}
          options={routineFilterOps[type].map(
            (op) => [op, t(opLabels[op])] as [RoutineFilterOp, string],
          )}
          minMenuWidth={200}
          caretSize={16}
          className="routine-github-select routine-github-op"
          disabled={disabled}
          onChange={(op) =>
            onChange({
              ...filter,
              op,
              // A list and a single value don't carry over.
              value: list(op) === list(filter.op) ? filter.value : "",
            })
          }
        />
        {type === "bool" ? (
          <Choice
            label="Value"
            value={filter.value === "false" ? "false" : "true"}
            options={[
              ["true", t("true")],
              ["false", t("false")],
            ]}
            caretSize={16}
            className="routine-github-select routine-github-value"
            disabled={disabled}
            onChange={(value) => onChange({ ...filter, value })}
          />
        ) : (
          <input
            className={`routine-github-value${filter.op === "matches" ? " regex" : ""}`}
            aria-label={t("Value")}
            placeholder={list(filter.op) ? t("Comma-separated values") : ""}
            value={filter.value}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) =>
              onChange({ ...filter, value: event.target.value })
            }
            onKeyDown={(event) => {
              // Enter keeps the value; it does not create the task.
              if (event.key === "Enter") event.preventDefault();
            }}
          />
        )}
        <IconButton
          label="Remove condition"
          className="routine-github-icon"
          disabled={disabled}
          onClick={onRemove}
        >
          <AppIcon name="Trash" size={20} />
        </IconButton>
      </div>
      {filter.op === "matches" && (
        <span className="routine-github-hint">
          {t("Anchored regex — matches the whole string.")}
        </span>
      )}
    </div>
  );
}

/** The repository the trigger listens to, chosen from the GitHub list. */
function RepositoryChoice({
  repository,
  disabled,
  onChoose,
}: {
  repository: string;
  disabled: boolean;
  onChoose: (repository: GitHubRepository) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<GitHubStatus>();
  useEffect(() => {
    if (!open || status) return;
    void api
      .githubStatus()
      .then(setStatus)
      .catch(() => setStatus({ configured: false, connected: false }));
  }, [open]);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="task-select routine-github-select routine-github-repository"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={repository ? undefined : t("Select a repository")}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span data-no-translate={repository ? true : undefined}>
          {repository || t("Select a repository")}
        </span>
        <ChevronDown size={16} strokeWidth={1.6} />
      </button>
      {open && (
        <RepositoryMenu
          status={status}
          left={anchor.current?.getBoundingClientRect().left ?? 0}
          anchor={anchor}
          chosen={repository || undefined}
          noRepository={false}
          onChoose={(chosen) => {
            if (chosen) onChoose(chosen);
            setOpen(false);
          }}
          onStatus={setStatus}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
