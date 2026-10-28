import { useEffect, useState } from "react";
import { useRoutineBrowserOwner } from "./routine-browser-owner";
import {
  isRoutineBrowserState,
  type RoutineBrowserState,
} from "../../../shared/routine-browser";
import type { Routine } from "../../../shared/routines";
import { routineErrorText } from "./routine-error-text";
import { X } from "../../ui/glyphs";
import { formatText, useLocale } from "../../i18n";
/** Source ccd3f68fe:3537–3646: real Browser inventory and Remove approval. */
export function RoutineBrowserPermissions({
  routine,
  readOnly = false,
}: {
  routine: Routine;
  readOnly?: boolean;
}) {
  const owner = useRoutineBrowserOwner(
    `routine-browser:${routine.id}:${routine.updatedAt}:${routine.executionLocation}:${readOnly}`,
  );
  if (
    typeof window === "undefined" ||
    typeof window.desktop?.routineBrowserPermissions !== "function"
  )
    return null;
  return (
    <OwnedRoutineBrowserPermissions
      key={owner.key}
      owner={owner}
      routine={routine}
      readOnly={readOnly}
    />
  );
}
function OwnedRoutineBrowserPermissions({
  routine,
  readOnly,
  owner,
}: {
  routine: Routine;
  readOnly: boolean;
  owner: ReturnType<typeof useRoutineBrowserOwner>;
}) {
  useLocale();
  const [state, setState] = useState<RoutineBrowserState>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!owner.current()) return;
    const operation = owner.capture("browser-read");
    let live = true;
    setError("");
    if (typeof operation.bridge.routineBrowserPermissions !== "function") {
      setState({
        status: "unsupported",
        message: "The built-in Browser is unavailable for this scheduled task.",
      });
      return;
    }
    void Promise.resolve()
      .then(() => {
        operation.assertCurrent();
        return operation.bridge.routineBrowserPermissions(
          routine.id,
          routine.executionLocation,
        );
      })
      .then((value) => {
        if (live && operation.current()) {
          if (!isRoutineBrowserState(value))
            throw new Error("The Browser returned an invalid approval list.");
          setState(value);
        }
      })
      .catch((failure) => {
        if (live && operation.current())
          setError(
            routineErrorText(
              failure instanceof Error ? failure.message : String(failure),
            ),
          );
      });
    return () => {
      live = false;
    };
  }, [owner.key, retry]);
  async function remove() {
    if (
      !state ||
      state.status !== "supported" ||
      state.readOnly ||
      readOnly ||
      busy ||
      !owner.current()
    )
      return;
    const operation = owner.capture("browser-remove");
    setBusy(true);
    setError("");
    try {
      await operation.bridge.clearRoutineBrowserPermissions(
        routine.id,
        routine.executionLocation,
      );
      if (operation.current()) setState({ ...state, grant: undefined });
    } catch (failure) {
      if (operation.current())
        setError(
          routineErrorText(
            failure instanceof Error ? failure.message : String(failure),
          ),
        );
    } finally {
      if (operation.current()) setBusy(false);
    }
  }
  return (
    <section className="routine-browser-permissions" aria-label="Browser">
      <h2>Browser</h2>
      {!state && !error && <p role="status">Loading…</p>}
      {state?.status === "unsupported" && <p>{state.message}</p>}
      {state?.status === "supported" &&
        (state.grant ? (
          <div className="always-allowed-list">
            <span>
              {state.grant.mode === "all-websites"
                ? "All websites"
                : formatText("{count} websites", {
                    count: state.grant.domains.length,
                  })}
            </span>
            {state.grant.mode === "domains" && (
              <p data-no-translate>{state.grant.domains.join(", ")}</p>
            )}
            {!readOnly && !state.readOnly && (
              <button
                type="button"
                aria-label="Remove approval"
                disabled={busy}
                onClick={() => void remove()}
              >
                <X size={12} />
              </button>
            )}
          </div>
        ) : (
          <p>Approvals you grant during a run appear here.</p>
        ))}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </button>
        </div>
      )}
    </section>
  );
}
