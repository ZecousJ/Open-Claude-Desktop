import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppContext } from "../app/AppContext";
import type { DesktopAPI } from "../../shared/types";

export interface ConnectorOperation {
  readonly bridge: DesktopAPI;
  current(): boolean;
  assertCurrent(): void;
}
const retired =
  "This connector operation belongs to a retired account or connector. Open it again.";
let nextKey = 0;
/** One leaf's account, controller, bridge, browser origin and connector resource.
 * Channel tickets also prevent an older read from replacing a newer result. */
export function useConnectorOwner(resource: string) {
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
      typeof identity.origin === "string" &&
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
    const unsubscribe = bridge?.onEvent?.((event) => {
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
    capture(channel = "mutation"): ConnectorOperation {
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

/** Reject malformed transport data before a leaf treats it as authoritative. */
export function readConnectorServers(
  value: unknown,
): import("../../shared/settings-desktop-api").McpServerState[] {
  const rows = (value as { servers?: unknown } | null)?.servers;
  const states = new Set([
    "starting",
    "ready",
    "failed",
    "cancelled",
    "stopped",
    "disabled",
  ]);
  const auth = new Set(["unsupported", "notLoggedIn", "bearerToken", "oAuth"]);
  if (
    !Array.isArray(rows) ||
    new Set(rows.map((row) => row?.name)).size !== rows.length ||
    !rows.every(
      (row) =>
        row &&
        typeof row === "object" &&
        typeof row.name === "string" &&
        row.name.length > 0 &&
        row.name.length <= 500 &&
        states.has(row.state) &&
        Number.isSafeInteger(row.tools) &&
        row.tools >= 0 &&
        (row.url === undefined || typeof row.url === "string") &&
        (row.displayName === undefined ||
          typeof row.displayName === "string") &&
        (row.authStatus === undefined || auth.has(row.authStatus)),
    )
  )
    throw Error("The connector returned an invalid server list.");
  return rows;
}

/** Transfer an authorized child action before dismissing its leaf. The new
 * operation belongs to the parent's lifetime and target, not the unmounting
 * child's current() closure. A retired source can never authorize a handoff. */
export function handoffConnectorOperation(
  parent: Pick<ReturnType<typeof useConnectorOwner>, "current" | "capture">,
  source: ConnectorOperation | undefined,
  resourceCurrent: () => boolean,
  channel = "connection",
): ConnectorOperation | undefined {
  if (!parent.current() || (source && !source.current())) return;
  const operation = parent.capture(channel);
  if (source && source.bridge !== operation.bridge) return;
  const current = () => {
    try {
      return operation.current() && resourceCurrent();
    } catch {
      return false;
    }
  };
  return {
    bridge: operation.bridge,
    current,
    assertCurrent() {
      if (!current()) throw Error(retired);
    },
  };
}

/** The parent inventory keeps its last real result on retry failure and never
 * re-reads through a replacement bridge from an old poll/event callback. */
export function useConnectorServerList(
  owner: ReturnType<typeof useConnectorOwner>,
  onError: (error: unknown) => void,
  interval: number,
) {
  const [value, setValue] =
    useState<import("../../shared/settings-desktop-api").McpServers>();
  const [failed, setFailed] = useState(false);
  const reporter = useRef(onError);
  const reported = useRef(false);
  reporter.current = onError;
  const load = async () => {
    if (!owner.current()) return;
    const operation = owner.capture("parent-mcp-read");
    try {
      const result = await operation.bridge.mcpServers();
      if (!operation.current()) return;
      readConnectorServers(result);
      setValue(result);
      setFailed(false);
      reported.current = false;
    } catch (error) {
      if (operation.current()) {
        setFailed(true);
        if (!reported.current) {
          reported.current = true;
          reporter.current(error);
        }
      }
    }
  };
  const reload = useRef(load);
  reload.current = load;
  useEffect(() => {
    if (!owner.current()) return;
    void load();
    const timer = setInterval(() => {
      if (owner.current()) void reload.current();
    }, interval);
    const operation = owner.capture("parent-mcp-events");
    const off = operation.bridge.onEvent((event) => {
      if (
        operation.current() &&
        (event.type === "settings" || event.type === "engine")
      )
        void reload.current();
    });
    return () => {
      clearInterval(timer);
      off();
    };
  }, [owner.key, interval]);
  return { value, failed, retry: () => void reload.current() };
}
