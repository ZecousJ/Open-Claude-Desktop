import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Routine, RoutineSourceState } from "../../shared/routines";
import { readRoutineList } from "../collections/routines/useRoutineQuery";

/** Share the list's typed source health and retain successful rows during retry.
 * Legacy bridges remain supported without inventing source acknowledgements. */
export function useTaskSchedules(
  accountId: string,
  enabled: boolean,
  onError: (error: unknown) => void,
  controllerScope?: unknown,
  sessionScope?: unknown,
  remote = false,
) {
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const scope = useMemo(
    () => ({
      accountId,
      bridge,
      controllerScope,
      sessionScope,
      enabled,
      remote,
    }),
    [accountId, bridge, controllerScope, sessionScope, enabled, remote],
  );
  const current = useRef<typeof scope | undefined>(scope);
  current.current = scope;
  useLayoutEffect(() => {
    current.current = scope;
    return () => {
      if (current.current === scope) current.current = undefined;
    };
  }, [scope]);
  type State = {
    scope: typeof scope;
    rows?: Routine[];
    pending: boolean;
    error: boolean;
    sourceFailures?: RoutineSourceState[];
  };
  const [state, setState] = useState<State>({
    scope,
    pending: enabled,
    error: false,
  });
  const [attempt, setAttempt] = useState(0);
  const report = useRef(onError);
  report.current = onError;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let receivedEvent = false;
    const valid = () =>
      live && current.current === scope && window.desktop === bridge;
    setState((previous) => ({
      scope,
      rows: previous.scope === scope ? previous.rows : undefined,
      pending: true,
      error: previous.scope === scope ? previous.error : false,
      sourceFailures:
        previous.scope === scope ? previous.sourceFailures : undefined,
    }));
    const accept = (rows: unknown) => {
      if (!Array.isArray(rows))
        throw new Error("Couldn’t load scheduled tasks");
      return rows as Routine[];
    };
    void Promise.resolve()
      .then(() => {
        if (!valid()) return;
        if (!bridge) throw new Error("Couldn’t load scheduled tasks");
        return readRoutineList(bridge, remote);
      })
      .then((result) => {
        if (!valid() || receivedEvent || !result) return;
        const failures = result.sources.filter(
          (source) => source.status !== "ready",
        );
        const failed = new Set(failures.map((source) => source.source));
        setState((previous) => {
          const retained =
            previous.scope === scope
              ? (previous.rows ?? []).filter((row) =>
                  failed.has(row.executionLocation ?? "local"),
                )
              : [];
          const rows = [
            ...result.tasks,
            ...retained.filter(
              (old) =>
                !result.tasks.some(
                  (row) =>
                    row.id === old.id &&
                    row.executionLocation === old.executionLocation,
                ),
            ),
          ];
          return {
            scope,
            rows,
            pending: false,
            error: failures.length > 0,
            sourceFailures: failures,
          };
        });
      })
      .catch((error) => {
        if (!valid() || receivedEvent) return;
        setState((previous) => ({
          scope,
          rows: previous.scope === scope ? previous.rows : undefined,
          pending: false,
          error: true,
        }));
        report.current(error);
      });
    const unsubscribe =
      typeof bridge?.onEvent === "function"
        ? bridge.onEvent((event) => {
            if (!valid()) return;
            if (event.type === "resync") {
              receivedEvent = true;
              setAttempt((value) => value + 1);
              return;
            }
            if (event.type !== "schedules") return;
            try {
              const rows = accept(event.schedules);
              receivedEvent = true;
              if (typeof bridge?.querySchedules === "function") {
                // A row event contains no per-source health acknowledgement.
                // Keep any failed source visible until the typed read settles.
                setState((previous) => {
                  const failed = new Set(
                    (previous.sourceFailures ?? []).map(
                      (source) => source.source,
                    ),
                  );
                  const retained =
                    previous.scope === scope
                      ? (previous.rows ?? []).filter((row) =>
                          failed.has(row.executionLocation ?? "local"),
                        )
                      : [];
                  return {
                    ...previous,
                    scope,
                    rows: [
                      ...rows,
                      ...retained.filter(
                        (old) =>
                          !rows.some(
                            (row) =>
                              row.id === old.id &&
                              row.executionLocation === old.executionLocation,
                          ),
                      ),
                    ],
                    pending: true,
                  };
                });
                setAttempt((value) => value + 1);
                return;
              }
              setState({ scope, rows, pending: false, error: false });
            } catch (error) {
              setState((previous) => ({
                scope,
                rows: previous.scope === scope ? previous.rows : undefined,
                pending: false,
                error: true,
              }));
              report.current(error);
            }
          })
        : undefined;
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [scope, enabled, attempt]);
  const visible =
    state.scope === scope && enabled
      ? state
      : { rows: undefined, pending: enabled, error: false, sourceFailures: [] };
  return {
    ...visible,
    retry: () => {
      if (current.current === scope && enabled && window.desktop === bridge)
        setAttempt((value) => value + 1);
    },
  };
}
