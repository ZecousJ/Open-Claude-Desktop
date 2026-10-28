import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Loading, a true empty result and a bridge failure are distinct menu states. */
export function useAddMenuResource<T>(
  read: (bridge: Window["desktop"]) => Promise<T[]>,
  account: string,
) {
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const scope = useMemo(
    () => ({ read, account, bridge }),
    [read, account, bridge],
  );
  type State = {
    scope: typeof scope;
    status: "pending" | "loaded" | "failed";
    rows: T[];
  };
  const [state, setState] = useState<State>({
    scope,
    status: "pending",
    rows: [],
  });
  const latest = useRef(scope);
  latest.current = scope;
  const live = useRef(false);
  const generation = useRef(0);
  const load = useCallback(() => {
    if (
      !live.current ||
      latest.current !== scope ||
      !bridge ||
      window.desktop !== bridge
    )
      return;
    const ticket = ++generation.current;
    const current = () =>
      live.current &&
      latest.current === scope &&
      window.desktop === bridge &&
      ticket === generation.current;
    setState({ scope, status: "pending", rows: [] });
    Promise.resolve()
      .then(() => read(bridge))
      .then(
        (rows) => {
          if (current())
            setState({ scope, status: "loaded", rows: rows ?? [] });
        },
        (error: unknown) => {
          // Menus show a fixed sentence; the cause goes to the log.
          if (current()) {
            console.error("Add menu list did not load:", error);
            setState({ scope, status: "failed", rows: [] });
          }
        },
      );
  }, [scope, bridge, read]);
  useEffect(() => {
    live.current = true;
    load();
    return () => {
      live.current = false;
      generation.current++;
    };
  }, [load]);
  // A source replacement is hidden during render, before the new effect runs.
  const visible: State =
    state.scope === scope ? state : { scope, status: "pending", rows: [] };
  return {
    account,
    status: visible.status,
    rows: visible.rows,
    reload: load,
  };
}
