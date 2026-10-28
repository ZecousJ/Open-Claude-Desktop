import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppContext } from "../app/AppContext";
import { checkConnectionNow } from "../app/connection";

export interface ProjectCatalogRead {
  status: "ready" | "pending" | "failed";
  cached: boolean;
  /** The current failed source remains failed while its retry is pending. */
  failed?: boolean;
  retry(): void;
}

/** A snapshot can succeed locally while its first cloud projects read fails.
 * Retrying uses the window's registered snapshot/resync, not another catalogue. */
export function useProjectCatalogState(): ProjectCatalogRead {
  const app = useContext(AppContext);
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const scope = useMemo(
    () => ({
      account: app?.accountId,
      controller: app?.controllerScope,
      bridge,
    }),
    [app?.accountId, app?.controllerScope, bridge],
  );
  const latest = useRef({ app, scope });
  latest.current = { app, scope };
  const live = useRef(false);
  const generation = useRef(0);
  const inFlight = useRef<typeof scope | undefined>(undefined);
  const [busy, setBusy] = useState<typeof scope>();
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
      inFlight.current = undefined;
    };
  }, [scope]);
  const metadata = app?.snapshot.projectCatalog;
  return {
    status: busy === scope ? "pending" : (metadata?.status ?? "ready"),
    cached: metadata?.cached ?? false,
    failed: metadata?.status === "failed",
    retry() {
      const actor = app;
      const current = () => {
        const now = latest.current;
        const controller = now.app?.currentController
          ? now.app.currentController.current
          : now.app;
        return (
          live.current &&
          now.scope === scope &&
          window.desktop === bridge &&
          controller?.accountId === scope.account &&
          controller?.controllerScope === scope.controller
        );
      };
      if (!actor || !bridge || inFlight.current === scope || !current()) return;
      const ticket = ++generation.current;
      inFlight.current = scope;
      setBusy(scope);
      void Promise.resolve()
        .then(() => {
          if (current() && ticket === generation.current)
            return checkConnectionNow();
        })
        .catch((error) => {
          if (current() && ticket === generation.current) actor.report(error);
        })
        .finally(() => {
          if (current() && ticket === generation.current) setBusy(undefined);
          if (inFlight.current === scope) inFlight.current = undefined;
        });
    },
  };
}
