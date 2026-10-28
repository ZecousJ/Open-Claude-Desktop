import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Routine, RoutineCapabilities } from "../../../shared/routines";
import {
  migrationCapabilities,
  type RoutineMigrationEligibility,
  type RoutineMigrationReason,
  type RoutineMigrationRequest,
  type RoutineMigrationResult,
} from "../../../shared/routine-migration";
import { useApp } from "../../app/AppContext";
import { useHost } from "../../host/HostContext";
import { formatText, t, useLocale } from "../../i18n";
import { lazyPiece } from "../../ui/lazy-piece";
import { Spinner } from "../../ui/Spinner";
import { requestScheduleConfirmation } from "./schedule-request";
import "./routine-migration.css";

const MigrationConfirm = lazyPiece(() => import("./RoutineMigrationConfirm"));
type Bridge = Window["desktop"] & {
  routineMigration?: (
    id: string,
    source?: "local" | "remote",
  ) => Promise<RoutineMigrationEligibility>;
  migrateRoutine?: (
    input: RoutineMigrationRequest,
  ) => Promise<RoutineMigrationResult>;
};
const reasons: Record<RoutineMigrationReason, string> = {
  unavailable: "Scheduled task migration is unavailable on this computer.",
  missing: "This scheduled task no longer exists.",
  paused: "Turn this task back on to use “{action}”.",
  running: "Another task is running. Try again when it finishes.",
  no_prompt: "Can’t move this task because its file couldn’t be read.",
  local_folders: "Can’t move this task because it uses local folders or files.",
  projects:
    "Can’t move this task yet. Moving would disconnect it from its projects. To run it in the cloud, create a new task instead.",
  space: "Can’t move this task because it’s linked to a project.",
  chrome: "Can’t move this task because Chrome permissions only run locally.",
  cwd: "Can’t move this task because it uses a local workspace.",
  dispatch_hook: "Can’t move this task because it has a computer trigger.",
  pattern_approvals:
    "Can’t move this task because it has local approval rules.",
  sub_hourly: "Can’t move this task because it runs more than once per hour.",
  custom_cron: "This task’s schedule can’t be moved to the cloud.",
  source: "This task type isn’t supported by the destination.",
  model: "This task’s model isn’t available at the destination.",
  not_origin: "This task wasn’t moved from this computer.",
  origin_missing: "The original task is no longer available on this computer.",
  expired_once: "This task’s scheduled time has passed.",
  timezone: "This task can’t move between computers with different time zones.",
};
function validEligibility(
  value: unknown,
): value is RoutineMigrationEligibility {
  if (!value || typeof value !== "object") return false;
  const result = value as RoutineMigrationEligibility;
  return (
    ["local", "remote"].includes(result.source) &&
    [result.toCloud, result.toLocal].every(
      (check) =>
        check &&
        typeof check.ok === "boolean" &&
        Array.isArray(check.reasons) &&
        (!check.ok || !check.reasons.length) &&
        check.reasons.every((reason) => Object.hasOwn(reasons, reason)),
    ) &&
    (result.pending === undefined || typeof result.pending === "boolean")
  );
}
function validResult(
  value: unknown,
  direction: RoutineMigrationRequest["direction"],
): value is RoutineMigrationResult {
  const result = value as RoutineMigrationResult | undefined;
  return Boolean(
    result &&
    typeof result.toId === "string" &&
    result.toId &&
    typeof result.fromId === "string" &&
    result.task?.id === result.toId &&
    result.history ===
      (direction === "to-cloud" ? "local-retained" : "cloud-deleted"),
  );
}

/** Source c97:6089–6112 fixes the saved host. The action below uses the
 * explicit migration protocol, with eligibility owned by the actual backend. */
export function RoutineMigration({
  routine,
  capabilities,
  disabled = false,
  onMoved,
}: {
  routine: Routine;
  capabilities?: RoutineCapabilities;
  disabled?: boolean;
  onMoved?: (result: RoutineMigrationResult) => void;
}) {
  useLocale();
  const app = useApp();
  const fallbackHost = useHost();
  const host = app.host ?? fallbackHost;
  const bridge = window.desktop as Bridge;
  const available =
    host.kind === "desktop" &&
    host.capabilities.scheduledTasks &&
    app.policy.scheduledTasks.enabled &&
    typeof bridge?.routineCapabilities === "function" &&
    typeof bridge?.routineMigration === "function" &&
    typeof bridge?.migrateRoutine === "function";
  const source = routine.executionLocation ?? "local";
  const fingerprint = JSON.stringify(capabilities ?? null);
  const executionIdentity = JSON.stringify([
    routine.mode,
    routine.environment,
    routine.cwd,
    routine.projectId,
  ]);
  const lease = useMemo(
    () => ({
      accountId: app.accountId,
      bridge,
      scope: app.controllerScope,
      page: app.page,
      id: routine.id,
      createdAt: routine.createdAt,
      source,
    }),
    [
      app.accountId,
      bridge,
      app.controllerScope,
      app.page,
      routine.id,
      routine.createdAt,
      source,
      available,
      fingerprint,
      executionIdentity,
    ],
  );
  const live = useRef<{ lease: typeof lease; disabled: boolean } | undefined>({
    lease,
    disabled,
  });
  live.current = { lease, disabled };
  useLayoutEffect(() => {
    live.current = { lease, disabled };
    return () => {
      if (live.current?.lease === lease) live.current = undefined;
    };
  }, [lease]);
  const current = () => {
    if (
      live.current?.lease !== lease ||
      window.desktop !== bridge ||
      !available
    )
      return false;
    const controller = app.currentController?.current;
    return (
      !app.currentController ||
      Boolean(
        controller &&
        controller.accountId === lease.accountId &&
        controller.controllerScope === lease.scope &&
        controller.page === lease.page &&
        controller.policy.scheduledTasks.enabled &&
        (controller.host ?? host).kind === "desktop",
      )
    );
  };
  type Read = {
    lease: typeof lease;
    loading: boolean;
    eligibility?: RoutineMigrationEligibility;
    error?: boolean;
    supported?: boolean;
  };
  const [read, setRead] = useState<Read>({ lease, loading: available });
  const [attempt, setAttempt] = useState(0);
  const [dialog, setDialog] = useState<{
    lease: typeof lease;
    direction: RoutineMigrationRequest["direction"];
  }>();
  const [action, setAction] = useState<{
    lease: typeof lease;
    busy: boolean;
    error?: string;
  }>();
  const inFlight = useRef<
    { lease: typeof lease; operation: object } | undefined
  >(undefined);
  useEffect(() => {
    if (!available) return;
    let active = true;
    const valid = () => active && current();
    setRead((previous) => ({
      lease,
      loading: true,
      eligibility: previous.lease === lease ? previous.eligibility : undefined,
    }));
    void Promise.resolve()
      .then(async () => {
        if (!valid()) return;
        const caps = capabilities ?? (await bridge.routineCapabilities(source));
        if (!valid()) return;
        const migration = migrationCapabilities(caps);
        if (
          !migration ||
          !(
            migration.originLock ||
            (migration.import && migration.deleteHistory)
          )
        ) {
          setRead({ lease, loading: false, supported: false });
          return;
        }
        const result = await bridge.routineMigration!(routine.id, source);
        if (!valid()) return;
        if (!validEligibility(result))
          throw new Error("Invalid migration eligibility");
        setRead({
          lease,
          loading: false,
          eligibility: result,
          supported: true,
        });
      })
      .catch(() => {
        if (valid())
          setRead((previous) => ({
            lease,
            loading: false,
            error: true,
            supported:
              previous.lease === lease ? previous.supported : undefined,
            eligibility:
              previous.lease === lease ? previous.eligibility : undefined,
          }));
      });
    return () => {
      active = false;
    };
  }, [lease, available, attempt, routine.updatedAt]);
  const visible = read.lease === lease ? read : { lease, loading: available };
  const eligibility = visible.eligibility;
  const pending = Boolean(eligibility?.pending);
  const direction =
    pending && !eligibility?.toLocal.reasons.includes("not_origin")
      ? "to-local"
      : source === "remote"
        ? "to-local"
        : "to-cloud";
  const check =
    direction === "to-cloud" ? eligibility?.toCloud : eligibility?.toLocal;
  const activeDialog = dialog?.lease === lease ? dialog : undefined;
  const actionState = action?.lease === lease ? action : undefined;
  const busy = Boolean(actionState?.busy);
  const blocked =
    !check?.ok || visible.loading || visible.error || disabled || busy;
  const actionLabel =
    direction === "to-cloud" ? "Move to cloud" : "Move back to this computer";
  const why = check?.reasons
    .map((reason) => formatText(reasons[reason], { action: t(actionLabel) }))
    .join(" ");
  const close = () => {
    if (current() && inFlight.current?.lease !== lease) setDialog(undefined);
  };
  const move = async () => {
    if (
      !current() ||
      live.current?.disabled ||
      blocked ||
      inFlight.current?.lease === lease ||
      !activeDialog
    )
      return;
    const operation = {};
    inFlight.current = { lease, operation };
    setAction({ lease, busy: true });
    try {
      const result = await bridge.migrateRoutine!({
        id: routine.id,
        direction: activeDialog.direction,
      });
      if (!current()) return;
      if (
        !validResult(result, activeDialog.direction) ||
        result.fromId !== routine.id
      )
        throw new Error("Invalid migration result");
      requestScheduleConfirmation({
        description: "",
        openRoutineId: result.toId,
      });
      setDialog(undefined);
      app.setPage("scheduled");
      onMoved?.(result);
    } catch {
      if (!current()) return;
      setAction({
        lease,
        busy: false,
        error: t(
          activeDialog.direction === "to-cloud"
            ? "Couldn’t move this task to the cloud. You can try again."
            : "Couldn’t move this task back to this computer. You can try again.",
        ),
      });
      setAttempt((value) => value + 1);
    } finally {
      if (inFlight.current?.operation === operation)
        inFlight.current = undefined;
      if (current())
        setAction((previous) =>
          previous?.lease === lease ? { ...previous, busy: false } : previous,
        );
    }
  };
  if (
    !available ||
    visible.supported === false ||
    (source === "remote" && eligibility?.toLocal.reasons.includes("not_origin"))
  )
    return null;
  return (
    <section
      className="routine-migration"
      aria-busy={visible.loading || busy || undefined}
    >
      {visible.loading && !eligibility && (
        <p role="status">
          <Spinner size={12} />
          {t("Checking whether this task can move…")}
        </p>
      )}
      {visible.error && (
        <p role="alert">
          {t("Couldn’t check task migration. Try again.")}{" "}
          <button
            type="button"
            className="secondary"
            disabled={disabled || busy}
            onClick={() => {
              if (current()) setAttempt((value) => value + 1);
            }}
          >
            {t("Retry")}
          </button>
        </p>
      )}
      {eligibility && (
        <div className="routine-migration-row">
          <div>
            <h3>
              {t(
                pending
                  ? "Retry move"
                  : direction === "to-local"
                    ? "Now runs in the cloud"
                    : "Move to cloud",
              )}
            </h3>
            <p>
              {t(
                pending
                  ? "A previous move is unfinished. Retry to safely continue it."
                  : direction === "to-local"
                    ? "Moved from this computer. Moving it back deletes the cloud version."
                    : "Runs when this computer is asleep or offline",
              )}
            </p>
            {why && <p className="routine-migration-reason">{why}</p>}
          </div>
          <button
            type="button"
            className="secondary"
            disabled={Boolean(blocked)}
            onClick={() => {
              if (current() && !live.current?.disabled) {
                setAction(undefined);
                setDialog({ lease, direction });
              }
            }}
          >
            {t(pending ? "Retry move" : actionLabel)}
          </button>
        </div>
      )}
      {activeDialog && (
        <Suspense fallback={null}>
          <MigrationConfirm
            direction={activeDialog.direction}
            taskName={routine.name}
            busy={busy}
            error={actionState?.error}
            retry={pending || Boolean(actionState?.error)}
            disabled={Boolean(blocked && !busy)}
            onConfirm={() => void move()}
            onClose={close}
          />
        </Suspense>
      )}
    </section>
  );
}
