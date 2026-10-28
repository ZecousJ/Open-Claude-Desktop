import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type Routine } from "../../../shared/routines";
import { repeatOf } from "../../../shared/routine-labels";
import { t } from "../../i18n";
import "./auto-disabled-routine.css";
import { AppContext } from "../../app/AppContext";

/** This reason is produced only by the existing execution-side cwd access
 * check in Scheduler.run. It is not evidence of a GitHub OAuth failure. */
export function AutoDisabledRoutineNotice({
  routine,
  disabled,
  onEdit,
  onRecover,
}: {
  routine: Routine;
  disabled: boolean;
  onEdit: () => void;
  onRecover?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  const repeat = repeatOf(routine);
  const onceAt = repeat.kind === "once" ? repeat.at : undefined;
  const app = useContext(AppContext);
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const scope = useMemo(
    () => ({}),
    [
      routine.id,
      routine.enabled,
      routine.endedReason,
      disabled,
      routine.cwd,
      routine.mode,
      routine.executionLocation,
      onceAt,
      routine.environment?.kind,
      routine.environment?.kind === "ssh"
        ? routine.environment.hostId
        : undefined,
      app?.accountId,
      app?.controllerScope,
      bridge,
    ],
  );
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const mounted = useRef(true);
  const pending = useRef<object | undefined>(undefined);
  useLayoutEffect(() => {
    pending.current = undefined;
    setBusy(false);
    setError("");
    setNow(Date.now());
  }, [scope]);
  useEffect(() => {
    if (
      routine.enabled ||
      routine.mode !== "code" ||
      routine.endedReason !== "auto_disabled_repo_access" ||
      onceAt === undefined ||
      onceAt <= now
    )
      return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(onceAt - now + 1, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [onceAt, now, routine.enabled, routine.mode, routine.endedReason]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (
    routine.mode !== "code" ||
    routine.enabled ||
    routine.endedReason !== "auto_disabled_repo_access"
  )
    return null;
  // Scheduler.run only produces this folder-access reason for a Code task
  // executing on this computer. Remote/SSH records do not prove a local folder
  // or GitHub OAuth failure.
  const localWorkspace =
    routine.executionLocation !== "remote" &&
    routine.environment?.kind !== "ssh" &&
    Boolean(routine.cwd);
  // Code detail does not offer Re-enable once the single scheduled time has
  // passed. Editing supplies a new time.
  const expiredOnce = onceAt !== undefined && onceAt <= now;
  const recover = async () => {
    if (
      !localWorkspace ||
      !onRecover ||
      pending.current === scope ||
      disabled ||
      (onceAt !== undefined && onceAt <= Date.now())
    )
      return;
    const current = () =>
      mounted.current &&
      latestScope.current === scope &&
      typeof window !== "undefined" &&
      window.desktop === bridge &&
      (!app?.currentController ||
        (app.currentController.current?.accountId === app.accountId &&
          app.currentController.current.controllerScope ===
            app.controllerScope));
    if (!current()) return;
    pending.current = scope;
    setBusy(true);
    setError("");
    try {
      await onRecover();
    } catch (reason) {
      if (current())
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (current()) {
        if (pending.current === scope) pending.current = undefined;
        setBusy(false);
      }
    }
  };
  return (
    <section className="routine-auto-disabled" role="alert">
      <h3>{t("This scheduled task was turned off")}</h3>
      {localWorkspace && (
        <p>
          {t(
            "Its workspace folder is missing or can’t be accessed. Restore access to the folder, then try again.",
          )}
        </p>
      )}
      {routine.lastError && <p data-no-translate>{routine.lastError}</p>}
      {expiredOnce && (
        <p>{t("Edit the schedule to turn this scheduled task back on.")}</p>
      )}
      {error && <p data-no-translate>{error}</p>}
      <div>
        <button
          type="button"
          className="secondary"
          disabled={disabled || busy}
          onClick={onEdit}
        >
          {t("Edit")}
        </button>
        {localWorkspace && !expiredOnce && onRecover && (
          <button
            type="button"
            className="secondary"
            disabled={disabled || busy}
            aria-busy={busy || undefined}
            onClick={() => void recover()}
          >
            {t(busy ? "Working…" : "Re-enable")}
          </button>
        )}
      </div>
    </section>
  );
}
