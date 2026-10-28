import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppContext } from "../app/AppContext";
import type { DesktopAPI } from "../../shared/types";
import type { TabProps } from "./context";

/** A private Settings read belongs to its bridge/account/controller. */
export function useAccountRead<T>(
  read: (bridge: DesktopAPI) => Promise<T>,
  valid: (value: unknown) => value is T,
  onError: TabProps["onError"],
  watchDevices = false,
  enabled = true,
) {
  const app = useContext(AppContext);
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const owner = useMemo(
    () => ({
      bridge,
      enabled,
      accountId: app?.accountId,
      scope: app?.controllerScope,
      ref: app?.currentController,
    }),
    [
      bridge,
      enabled,
      app?.accountId,
      app?.controllerScope,
      app?.currentController,
    ],
  );
  const latest = useRef(owner);
  latest.current = owner;
  const live = useRef(true);
  const serial = useRef(0);
  const [result, setResult] = useState<{
    owner: typeof owner;
    value?: T;
    state: "loading" | "ready" | "failed";
  }>({ owner, state: "loading" });
  const current = () => {
    const actor = owner.ref ? owner.ref.current : app;
    return (
      live.current &&
      owner.enabled &&
      latest.current === owner &&
      window.desktop === owner.bridge &&
      app?.currentController === owner.ref &&
      (!app ||
        (!!actor &&
          actor.accountId === owner.accountId &&
          actor.controllerScope === owner.scope))
    );
  };
  const reload = async () => {
    if (!owner.bridge || !current()) return;
    const request = ++serial.current;
    setResult({ owner, state: "loading" });
    try {
      const value = await read(owner.bridge);
      if (!current() || request !== serial.current) return;
      if (!valid(value)) throw new Error("Invalid account response");
      setResult({ owner, state: "ready", value });
    } catch (error) {
      if (!current() || request !== serial.current) return;
      setResult({ owner, state: "failed" });
      onError(error);
    }
  };
  useEffect(() => {
    live.current = true;
    if (enabled) void reload();
    const unsubscribe =
      enabled && watchDevices
        ? owner.bridge?.onEvent?.((event) => {
            if (
              current() &&
              (event.type === "devices-changed" ||
                event.type === "service-changed")
            )
              void reload();
          })
        : undefined;
    return () => {
      live.current = false;
      serial.current++;
      unsubscribe?.();
    };
  }, [owner, watchDevices]);
  const shown = !enabled
    ? { owner, state: "ready" as const, value: undefined as T | undefined }
    : result.owner === owner
      ? result
      : { owner, state: "loading" as const, value: undefined as T | undefined };
  return {
    value: shown.value,
    loading: shown.state === "loading",
    failed: shown.state === "failed",
    owner,
    current,
    reload,
    setValue: (value: T) => {
      if (current()) {
        serial.current++;
        setResult({ owner, state: "ready", value });
      }
    },
  };
}
