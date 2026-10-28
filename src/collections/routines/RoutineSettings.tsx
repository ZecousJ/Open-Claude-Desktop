import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CloudOff, ChevronDown } from "../../ui/glyphs";
import { Toggle } from "../../settings/controls";
import { surface, type HostSurface } from "../../../shared/host";
import {
  askNotificationPermission,
  permissionRefusal,
} from "../../app/web-notifications";
import type { RoutineDraft } from "./routine-draft";
import type { RoutineCapabilities } from "../../../shared/routines";
import { t } from "../../i18n";
import "./routine-settings.css";
import { RoutineAdvancedTabs } from "./RoutineAdvancedTabs";
import type { Project } from "../../../shared/types";

/**
 * Exact-time jitter is local-only; web schedules always use the remote runner.
 * Web-bridge-methods.ts:216.
 */
export function routineHasExactTime(
  draft: Pick<RoutineDraft, "kind" | "executionLocation">,
  hostSurface: HostSurface = surface,
) {
  return (
    hostSurface !== "web" &&
    draft.executionLocation !== "remote" &&
    draft.kind !== "manual" &&
    draft.kind !== "once"
  );
}

/** A rejected/malformed capability query is not an unsupported capability. */
export function validRoutineCapabilities(
  value: unknown,
): value is RoutineCapabilities {
  if (!value || typeof value !== "object") return false;
  const next = value as Record<string, unknown>;
  return (
    typeof next.remote === "boolean" &&
    typeof next.email === "boolean" &&
    typeof next.slack === "boolean" &&
    (next.computerName === undefined || typeof next.computerName === "string")
  );
}

/** Settings rows. */
export function RoutineSettings({
  draft,
  onChange,
  disabled = false,
  projects,
  baseMode,
}: {
  draft: RoutineDraft;
  onChange: (patch: Partial<RoutineDraft>) => void;
  disabled?: boolean;
  /** The web: General picks the project of a Chat task. */
  projects?: readonly Project[];
  /** The web: what the task is when nothing makes it a Code task. */
  baseMode?: RoutineDraft["mode"];
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [capabilitiesByLocation, setCapabilities] = useState(
    () => new Map<string, RoutineCapabilities>(),
  );
  const [attempt, setAttempt] = useState(0);
  const context = draft.executionLocation ?? "default";
  const [capabilityRequest, setCapabilityRequest] = useState<{
    context: string;
    loading: boolean;
    error?: string;
  }>({ context, loading: true });
  const capabilities = capabilitiesByLocation.get(context);
  const loadingCapabilities =
    capabilityRequest.context !== context || capabilityRequest.loading;
  const capabilityError =
    capabilityRequest.context === context ? capabilityRequest.error : undefined;
  const mounted = useRef(true);
  const notificationRevision = useRef(0);
  const notificationContext = JSON.stringify([
    draft.id,
    context,
    draft.notifyOnCompletion,
    disabled,
  ]);
  const previousContext = useRef(notificationContext);
  if (previousContext.current !== notificationContext) {
    previousContext.current = notificationContext;
    notificationRevision.current++;
  }
  const latest = useRef({ draft, capabilities, onChange, disabled });
  latest.current = { draft, capabilities, onChange, disabled };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      notificationRevision.current++;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setCapabilityRequest({ context, loading: true });
    void Promise.resolve()
      .then(() => window.desktop.routineCapabilities(draft.executionLocation))
      .then((value: unknown) => {
        if (!current) return;
        if (!validRoutineCapabilities(value))
          throw new Error(t("Couldn’t load task settings. Try again."));
        setCapabilities((known) => new Map(known).set(context, value));
        setCapabilityRequest({ context, loading: false });
      })
      .catch((reason: unknown) => {
        if (current)
          setCapabilityRequest({
            context,
            loading: false,
            error: reason instanceof Error ? reason.message : String(reason),
          });
      });
    return () => {
      current = false;
    };
  }, [draft.executionLocation, attempt]);
  const panelId = useId();
  const channelsId = useId();
  const localFolder =
    !draft.id && Boolean(draft.cwd) && draft.executionLocation !== "remote";
  const push = draft.notifyOnCompletion?.push ?? true;
  const notifyOn =
    push ||
    !!(capabilities?.email !== false && draft.notifyOnCompletion?.email) ||
    !!(capabilities?.slack !== false && draft.notifyOnCompletion?.slack);
  const setPush = async (checked: boolean) => {
    if (latest.current.disabled || !mounted.current) return;
    const revision = ++notificationRevision.current;
    if (checked && surface === "web") {
      const refusal = permissionRefusal(await askNotificationPermission());
      if (
        !mounted.current ||
        latest.current.disabled ||
        revision !== notificationRevision.current
      )
        return;
      if (refusal) {
        setError(refusal);
        return;
      }
    }
    if (
      !mounted.current ||
      latest.current.disabled ||
      revision !== notificationRevision.current
    )
      return;
    setError(undefined);
    const {
      draft: currentDraft,
      capabilities: currentCapabilities,
      onChange: change,
    } = latest.current;
    change({
      notifyOnCompletion: {
        push: checked,
        email:
          currentCapabilities?.email !== false
            ? (currentDraft.notifyOnCompletion?.email ?? false)
            : false,
        slack:
          currentCapabilities?.slack !== false
            ? (currentDraft.notifyOnCompletion?.slack ?? false)
            : false,
      },
    });
  };
  const setNotifyOn = async (checked: boolean) => {
    if (latest.current.disabled || !mounted.current) return;
    if (!checked) {
      notificationRevision.current++;
      setError(undefined);
      latest.current.onChange({
        notifyOnCompletion: { push: false, email: false, slack: false },
      });
    } else await setPush(true);
  };
  const notifications = (
    <>
      {loadingCapabilities && <p role="status">Loading…</p>}
      <div className="routine-setting-row">
        <span>
          <span className="routine-setting-title">
            Notify me when this task finishes
          </span>
          <span className="routine-setting-description">
            Claudex will send you a one-line summary when each run completes —
            only when there’s something worth telling you for tasks that watch
            for a condition.
          </span>
        </span>
        <Toggle
          label="Notify me when this task finishes"
          checked={notifyOn}
          controls={notifyOn ? channelsId : undefined}
          disabled={disabled}
          onChange={(checked) => void setNotifyOn(checked)}
        />
      </div>
      {notifyOn && (
        <div
          id={channelsId}
          role="group"
          aria-label="Notifications"
          className="routine-notification-channels"
        >
          <label>
            <input
              type="checkbox"
              disabled={disabled}
              checked={push}
              onChange={(event) => void setPush(event.target.checked)}
            />
            Push notification
          </label>
          {capabilities?.email && (
            <label>
              <input
                type="checkbox"
                disabled={disabled}
                checked={draft.notifyOnCompletion?.email ?? false}
                onChange={(event) => {
                  notificationRevision.current++;
                  onChange({
                    notifyOnCompletion: {
                      push,
                      email: event.target.checked,
                      slack: draft.notifyOnCompletion?.slack ?? false,
                    },
                  });
                }}
              />
              Email
            </label>
          )}
          {capabilities?.slack && (
            <label>
              <input
                type="checkbox"
                disabled={disabled}
                checked={draft.notifyOnCompletion?.slack ?? false}
                onChange={(event) => {
                  notificationRevision.current++;
                  onChange({
                    notifyOnCompletion: {
                      push,
                      email: capabilities.email
                        ? (draft.notifyOnCompletion?.email ?? false)
                        : false,
                      slack: event.target.checked,
                    },
                  });
                }}
              />
              Slack
            </label>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="task-error">
          {error}
        </p>
      )}
    </>
  );
  return (
    <div
      className="routine-settings"
      aria-busy={loadingCapabilities || undefined}
    >
      {routineHasExactTime(draft) && (
        <div className="routine-setting-row routine-exact-time">
          <span>
            <span className="routine-setting-title">Run at exact time</span>
            <span className="routine-setting-description">
              By default, scheduled tasks use a randomized delay of several
              minutes for server performance.
            </span>
          </span>
          <Toggle
            label="Run at exact time"
            disabled={disabled}
            checked={draft.disableJitter ?? true}
            onChange={(disableJitter) => onChange({ disableJitter })}
          />
        </div>
      )}
      <button
        type="button"
        className="routine-advanced-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        Advanced settings
        <ChevronDown
          size={16}
          style={{ transform: open ? "rotate(180deg)" : undefined }}
        />
      </button>
      {capabilityError && (
        <p role="alert" className="task-error">
          <span>
            {t("Couldn’t load task settings. Try again.")}
            {capabilityError !== t("Couldn’t load task settings. Try again.")
              ? ` ${capabilityError}`
              : ""}
          </span>{" "}
          <button
            type="button"
            className="secondary"
            disabled={disabled || loadingCapabilities}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry
          </button>
        </p>
      )}
      {open && (
        <div id={panelId} className="routine-advanced-panel">
          {surface === "web" ? (
            <RoutineAdvancedTabs
              draft={draft}
              onChange={onChange}
              disabled={disabled}
              projects={projects}
              baseMode={baseMode ?? draft.mode}
              notifications={notifications}
            />
          ) : (
            notifications
          )}
        </div>
      )}
      {surface === "desktop" && capabilities?.remote && (
        <div className="routine-setting-row routine-location">
          <span>
            <span className="routine-setting-title routine-location-title">
              <CloudOff size={14} aria-hidden="true" />
              Only on this computer
              <span className="routine-advanced-badge">Advanced</span>
            </span>
            <span className="routine-setting-description">
              {localFolder
                ? "This task will run on your computer because it uses a local folder. Remove the folder to run it in the cloud."
                : draft.id
                  ? "Where a task runs can’t be changed after it’s created."
                  : "Only runs while your computer is on. Use this if the task needs access to local files or desktop extensions."}
            </span>
          </span>
          <Toggle
            label="Only on this computer"
            disabled={disabled || localFolder || Boolean(draft.id)}
            checked={draft.executionLocation !== "remote"}
            onChange={(local) => {
              if (
                !latest.current.disabled &&
                !latest.current.draft.id &&
                !localFolder
              )
                latest.current.onChange({
                  executionLocation: local ? "local" : "remote",
                });
            }}
          />
        </div>
      )}
    </div>
  );
}
