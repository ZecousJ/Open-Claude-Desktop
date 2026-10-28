import { useRef, useState, type ReactNode } from "react";
import { Menu, type MenuEntry } from "../../ui/Menu";
import { IconButton } from "../../ui/Controls";
import { AppIcon } from "../../ui/app-icon";
import { t } from "../../i18n";
import {
  defaultGitHubEvents,
  newRoutineTriggerId,
} from "../../../shared/routine-triggers";
import { repositoryFullName } from "../../../shared/github-api";
import { repositoryRef } from "../../composer/code-repository";
import type { RoutineDraft } from "./routine-draft";
import { RoutineApiAccess } from "./RoutineApiAccess";
import { RoutineGitHubTrigger } from "./RoutineGitHubTrigger";

/**
 * The scheduled task's triggers: with its schedule alone, one row (Trigger, the
 * schedule's fields, + at its end); once another trigger is added, a card
 * headed "Trigger" with + and a row per trigger, each with its remove button. +
 * offers what the task has not got yet, each with a line saying what it does.
 * An API or GitHub event trigger makes the task a Code task (its runs are cloud
 * sessions). An API trigger's token is made when the task is saved, and while
 * it has one the trigger cannot be removed ("Delete the token to remove"). A
 * GitHub event trigger listens to the task's repository unless another is
 * picked.
 */
export function RoutineTriggerList({
  draft,
  busy,
  schedule,
  scheduleType,
  canAdd,
  onChange,
  baseMode,
}: {
  draft: RoutineDraft;
  busy: boolean;
  /** The schedule's fields (frequency, time…). */
  schedule: ReactNode;
  /** The inline row's trigger type (the one-trigger layout only). */
  scheduleType: ReactNode;
  /** Whether other triggers can be added (the web). */
  canAdd: boolean;
  onChange: (patch: Partial<RoutineDraft>) => void;
  /** The task's mode before a trigger made it a Code task. */
  baseMode: RoutineDraft["mode"];
}) {
  const add = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ left: number; top: number }>();
  const { triggers } = draft;
  const single = !triggers.api && !triggers.github;
  const others =
    Number(Boolean(triggers.api)) + Number(Boolean(triggers.github));
  const set = (next: RoutineDraft["triggers"]) =>
    onChange({
      triggers: next,
      // Another trigger runs the task as a Code task; without one it is
      // what it was made as, unless a repository keeps it Code.
      mode: next.api || next.github || draft.repository ? "code" : baseMode,
      // A cloud Code task runs unattended inside its environment's sandbox
      // and network rules ("Permissions set by environment").
      ...(next.api || next.github ? { permission: "auto" as const } : {}),
    });
  const entries: MenuEntry[] = [
    ...(!triggers.schedule
      ? [
          {
            label: "Schedule",
            description: "Run on a recurring cron schedule",
            icon: <AppIcon name="Clock" size={20} />,
            onSelect: () => set({ ...triggers, schedule: true }),
          },
        ]
      : []),
    {
      label: "GitHub event",
      description: "Run when a GitHub webhook event fires",
      icon: <AppIcon name="GitPullRequest" size={20} />,
      disabled: Boolean(triggers.github),
      title: triggers.github ? "Already added" : undefined,
      onSelect: () =>
        set({
          ...triggers,
          github: {
            id: newRoutineTriggerId(),
            repository: draft.repository
              ? (repositoryFullName(draft.repository.url) ?? "")
              : "",
            events: [...defaultGitHubEvents],
            filters: [],
          },
        }),
    },
    {
      label: "API",
      description: "Run when your own code calls it",
      icon: <AppIcon name="Code" size={20} />,
      disabled: Boolean(triggers.api),
      title: triggers.api ? "Already added" : undefined,
      onSelect: () => set({ ...triggers, api: { id: newRoutineTriggerId() } }),
    },
  ];
  const addButton = canAdd && (
    <IconButton
      ref={add}
      label="Add another trigger"
      className="task-trigger-add"
      menu
      expanded={Boolean(menu)}
      disabled={busy}
      onClick={() => {
        if (menu) return setMenu(undefined);
        const box = add.current!.getBoundingClientRect();
        setMenu({ left: box.right - 299, top: box.bottom + 6 });
      }}
    >
      <AppIcon name="Add" size={16} />
    </IconButton>
  );
  const remove = (onRemove: () => void, locked = false) => (
    <IconButton
      label={locked ? "Delete the token to remove" : "Remove trigger"}
      className="task-trigger-remove"
      disabled={busy || locked}
      onClick={onRemove}
    >
      <AppIcon name="Trash" size={16} />
    </IconButton>
  );
  return (
    <>
      {single ? (
        <div className="task-row task-trigger">
          <span>Trigger</span>
          <div className="task-row-fields">
            {scheduleType}
            {schedule}
          </div>
          {addButton}
        </div>
      ) : (
        <div className="task-triggers" role="group" aria-label={t("Trigger")}>
          <div className="task-triggers-head">
            <span>Trigger</span>
            {addButton}
          </div>
          {triggers.schedule && (
            <div className="task-trigger-item">
              <span className="task-trigger-name">
                <AppIcon name="Clock" size={16} />
                Schedule
              </span>
              <div className="task-row-fields">{schedule}</div>
              {remove(() => set({ ...triggers, schedule: false }), false)}
            </div>
          )}
          {triggers.github && (
            <RoutineGitHubTrigger
              trigger={triggers.github}
              busy={busy}
              creating={!draft.id}
              remove={remove(() =>
                set({
                  ...triggers,
                  github: undefined,
                  schedule: triggers.schedule || others === 1,
                }),
              )}
              onChange={(patch) =>
                onChange({
                  triggers: {
                    ...triggers,
                    github: { ...triggers.github!, ...patch },
                  },
                })
              }
              onRepository={(repository) =>
                onChange({
                  triggers: {
                    ...triggers,
                    github: {
                      ...triggers.github!,
                      repository: repository.fullName,
                    },
                  },
                  // The task's repository, when it has none yet.
                  ...(draft.repository
                    ? {}
                    : {
                        repository: repositoryRef(
                          repository.cloneUrl,
                          repository.defaultBranch,
                          repository.defaultBranch,
                        ),
                      }),
                })
              }
            />
          )}
          {triggers.api && (
            <div className="task-trigger-item task-trigger-api">
              <div className="task-trigger-line">
                <span className="task-trigger-name">
                  <AppIcon name="Code" size={16} />
                  API
                </span>
                {!draft.id && (
                  <span className="task-trigger-note">
                    {t("Token will be generated when you save.")}
                  </span>
                )}
                {remove(
                  () =>
                    set({
                      ...triggers,
                      api: undefined,
                      // The last trigger cannot go: the schedule comes back.
                      schedule: triggers.schedule || others === 1,
                    }),
                  Boolean(triggers.api.tokenHint),
                )}
              </div>
              {/* A saved task's trigger: its address and token. */}
              {draft.id && (
                <RoutineApiAccess
                  triggerId={triggers.api.id}
                  hint={triggers.api.tokenHint}
                  onHint={(tokenHint) =>
                    onChange({
                      triggers: {
                        ...triggers,
                        api: {
                          id: triggers.api!.id,
                          ...(tokenHint ? { tokenHint } : {}),
                        },
                      },
                    })
                  }
                />
              )}
            </div>
          )}
        </div>
      )}
      {menu && (
        <Menu
          label="Add another trigger"
          className="task-trigger-menu"
          width={299}
          position={menu}
          anchors={[add]}
          entries={entries}
          onClose={() => setMenu(undefined)}
        />
      )}
    </>
  );
}
