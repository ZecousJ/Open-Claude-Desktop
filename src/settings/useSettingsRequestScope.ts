import { useContext, useLayoutEffect, useMemo, useRef } from "react";
import { AppContext } from "../app/AppContext";
import type { DesktopAPI } from "../../shared/types";

let nextScope = 0;
export interface SettingsRequestScope {
  bridge: DesktopAPI | undefined;
  current(): boolean;
}

/** UI work belongs to its rendered account and controller, even before a
 * changed controller ref or bridge has caused another React render. */
export function useSettingsRequestScope() {
  const app = useContext(AppContext);
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const accountId = app?.accountId;
  const controllerScope = app?.controllerScope;
  const controllerRef = app?.currentController;
  const owner = useMemo(
    () => ({ key: ++nextScope }),
    [bridge, accountId, controllerScope, controllerRef],
  );
  const rendered = useRef(app);
  rendered.current = app;
  const mounted = useRef<typeof owner | undefined>(undefined);
  useLayoutEffect(() => {
    mounted.current = owner;
    return () => {
      if (mounted.current === owner) mounted.current = undefined;
    };
  }, [owner]);
  const capture = (): SettingsRequestScope => ({
    bridge,
    current: () => {
      if (
        mounted.current !== owner ||
        typeof window === "undefined" ||
        window.desktop !== bridge
      )
        return false;
      const latest = rendered.current;
      if (
        latest?.accountId !== accountId ||
        latest?.controllerScope !== controllerScope ||
        latest?.currentController !== controllerRef
      )
        return false;
      if (!app) return !latest;
      const current = controllerRef ? controllerRef.current : latest;
      return (
        !!current &&
        current.accountId === accountId &&
        current.controllerScope === controllerScope
      );
    },
  });
  return { key: owner.key, capture };
}
export type SettingsScopeOwner = ReturnType<typeof useSettingsRequestScope>;
