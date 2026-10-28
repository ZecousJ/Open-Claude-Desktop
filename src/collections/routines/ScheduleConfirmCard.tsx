import { useState } from "react";
import { CalendarClock, Folder } from "../../ui/glyphs";
import { Spinner } from "../../ui/Spinner";
import type { Settings } from "../../../shared/types";
import {
  routineLimitMessage,
  routinesOffMessage,
} from "../../../shared/routines";
import { repeatLabel } from "../../../shared/routine-labels";
import {
  proposeSchedule,
  type ScheduleProposal,
} from "../../../shared/routine-proposals";
import { currentLocale, useT } from "../../i18n";
import { usePolicy } from "../../policy/PolicyContext";
import { useHost } from "../../host/HostContext";
import { modelRows, sameChoice, type ModelChoice } from "./ModelPicker";
import {
  draftInput,
  draftRule,
  newDraft,
  type RoutineDraft,
} from "./routine-draft";
// Styles: routine-history.css, loaded with the Routines page.
import type { ScheduleRequest } from "./schedule-request";

export {
  onScheduleRequest,
  requestScheduleConfirmation,
  takeScheduleRequest,
  type ScheduleRequest,
} from "./schedule-request";

/**
 * The editor draft for a request: the schedule read from the description,
 * the composer's folder and model (Default when the composer had none).
 */
export function requestDraft(
  request: ScheduleRequest,
  settings: Settings,
  now: number,
  /** Code on this computer, or a Cowork task on the web. */
  mode: RoutineDraft["mode"] = "code",
  /** What the model made of the description; the words alone by default. */
  made?: ScheduleProposal,
): RoutineDraft {
  const proposal = made ?? proposeSchedule(request.description);
  const base = newDraft(now, {
    id: "schedule-command",
    name: proposal.name,
    description: proposal.prompt.slice(0, 200),
    instructions: proposal.prompt,
    repeat: proposal.repeat,
    icon: "commit",
  });
  const model: ModelChoice =
    request.providerId &&
    request.model &&
    settings.providers.some((p) => p.id === request.providerId)
      ? { providerId: request.providerId, model: request.model }
      : { default: true };
  // /schedule saves straight from its card: on Manually approve, as before
  // new tasks took Auto, so the administrator's switch can't refuse it.
  return { ...base, mode, cwd: request.cwd, model, permission: "default" };
}

/**
 * The confirmation `/schedule` shows before anything is saved: what will run,
 * when, where and on which model. Create routine saves it; Edit opens the full
 * editor with these values.
 */
export function ScheduleConfirmCard({
  draft,
  settings,
  count,
  onEdit,
  onCancel,
  onCreated,
}: {
  draft: RoutineDraft;
  settings: Settings;
  /** How many routines exist, for the administrator's limit. */
  count: number;
  onEdit: () => void;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const t = useT();
  const policy = usePolicy();
  // The web calls them scheduled tasks and runs them in the sandbox: no folder.
  const isWeb = useHost().kind === "web";
  // Whole sentences, so each language gets its own word order.
  const words = isWeb
    ? {
        confirm: "Confirm new task",
        title: "Create this task?",
        create: "Create task",
      }
    : {
        confirm: "Confirm new routine",
        title: "Create this routine?",
        create: "Create routine",
      };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const limit = policy.scheduledTasks.maxTasks;
  const blocked = !policy.scheduledTasks.enabled
    ? routinesOffMessage
    : limit !== null && count >= limit
      ? routineLimitMessage(limit)
      : !settings.providers.length
        ? "Add a model connection in Settings first."
        : undefined;
  const modelLabel = draft.model.default
    ? "Default"
    : (modelRows(settings.providers).find((row) =>
        sameChoice(row.choice, draft.model),
      )?.label ?? draft.model.model);
  const folder = draft.cwd?.split(/[\\/]/).filter(Boolean).at(-1);
  async function create() {
    setBusy(true);
    setError("");
    try {
      await window.desktop.saveSchedule(
        draftInput(draft, settings, Date.now()),
      );
      onCreated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  }
  return (
    <section className="schedule-confirm" aria-label={t(words.confirm)}>
      <header>
        <CalendarClock size={16} strokeWidth={1.6} aria-hidden="true" />
        <strong>{words.title}</strong>
      </header>
      <dl>
        <div>
          <dt>Name</dt>
          <dd>{draft.name}</dd>
        </div>
        <div>
          <dt>Runs</dt>
          <dd>{repeatLabel(draftRule(draft), currentLocale())}</dd>
        </div>
        {!isWeb && (
          <div>
            <dt>Folder</dt>
            <dd title={draft.cwd}>
              <Folder size={12} strokeWidth={1.6} aria-hidden="true" />
              {folder ?? "Default workspace"}
            </dd>
          </div>
        )}
        <div>
          <dt>Model</dt>
          <dd>{modelLabel}</dd>
        </div>
      </dl>
      <p className="schedule-confirm-prompt">{draft.prompt}</p>
      {(blocked || error) && (
        <p className="schedule-confirm-error" role="alert">
          {blocked ?? error}
        </p>
      )}
      <div className="routine-actions schedule-confirm-actions">
        <button type="button" className="routine-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="routine-cancel"
          disabled={Boolean(blocked)}
          onClick={onEdit}
        >
          Edit
        </button>
        <button
          type="button"
          className="routine-create"
          disabled={Boolean(blocked) || busy}
          onClick={() => void create()}
        >
          {busy && <Spinner inheritColor size={12} className="spin" />}
          {words.create}
        </button>
      </div>
    </section>
  );
}
