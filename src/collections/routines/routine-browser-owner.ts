import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppContext } from "../../app/AppContext";
import type { DesktopAPI } from "../../../shared/types";

export interface RoutineBrowserOperation {
  readonly bridge: DesktopAPI;
  current(): boolean;
  assertCurrent(): void;
}
const retired =
  "This Browser operation belongs to a retired account or scheduled task. Open it again.";
let nextKey = 0;
/** One leaf's account, controller, bridge, browser origin and routine resource.
 * Channel tickets also prevent an older read from replacing a newer result. */
export function useRoutineBrowserOwner(resource: string) {
  const app = useContext(AppContext);
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const origin =
    typeof window === "undefined" ? undefined : window.location?.origin;
  const [revision, setRevision] = useState(0);
  const identity = useMemo(
    () => ({
      key: ++nextKey,
      bridge,
      origin,
      accountId: app?.accountId,
      controller: app?.currentController,
      scope: app?.controllerScope,
      resource,
      active: true,
    }),
    [
      bridge,
      origin,
      app?.accountId,
      app?.currentController,
      app?.controllerScope,
      resource,
      revision,
    ],
  );
  const latest = useRef(identity);
  latest.current = identity;
  const channels = useRef(new Map<string, number>());
  const current = () => {
    const actor = identity.controller?.current;
    return (
      identity.active &&
      latest.current === identity &&
      typeof window !== "undefined" &&
      window.desktop === identity.bridge &&
      window.location?.origin === identity.origin &&
      (!identity.controller ||
        (!!actor &&
          actor.accountId === identity.accountId &&
          actor.controllerScope === identity.scope))
    );
  };
  useLayoutEffect(() => {
    identity.active = true;
    return () => {
      identity.active = false;
    };
  }, [identity]);
  useEffect(() => {
    const unsubscribe = bridge?.onEvent((event) => {
      if (event.type !== "signed-out" && event.type !== "service-changed")
        return;
      identity.active = false;
      setRevision((value) => value + 1);
    });
    return () => {
      unsubscribe?.();
    };
  }, [identity, bridge]);
  return {
    key: identity.key,
    current,
    capture(channel = "mutation"): RoutineBrowserOperation {
      if (!current() || !bridge) throw Error(retired);
      const sequence = (channels.current.get(channel) ?? 0) + 1;
      channels.current.set(channel, sequence);
      const active = () =>
        current() && channels.current.get(channel) === sequence;
      return {
        bridge,
        current: active,
        assertCurrent() {
          if (!active()) throw Error(retired);
        },
      };
    },
  };
}
