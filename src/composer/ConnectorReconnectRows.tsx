import {
  useEffect,
  useRef,
  useState,
  useContext,
  type HTMLAttributes,
} from "react";
import { Skeleton, SkeletonGroup } from "../ui/Skeleton";
import { AppContext } from "../app/AppContext";
import type { ConversationToolOverrides } from "../../shared/conversation-tools";
import { connectorSessionEnabled } from "./connector-session-state";
import { Blocks, TriangleAlert } from "../ui/glyphs";
import { usePolicy } from "../policy/PolicyContext";
import { connectorAllowed } from "../../shared/client-policy-rules";
import type { McpServerState } from "../../shared/settings-desktop-api";
import {
  readConnectorServers,
  useConnectorOwner,
} from "../settings/connector-owner";
import { connectCustomConnector } from "../settings/tabs/connector-login";
import { useHostCapability } from "../host/HostContext";
import { formatText, t, useLocale } from "../i18n";
import { canReconnectConnector } from "./connector-auth";

export interface ConnectorReconnectRowsProps {
  servers: Record<string, unknown>;
  onToggle(name: string, enabled: boolean, status?: McpServerState): void;
  disabled?: boolean;
  disabledReason?: string;
  /** Chat uses conversation overrides; omit for Code's existing config value. */
  enabledOverrides?: Record<string, boolean>;
  toolOverrides?: ConversationToolOverrides;
  switchClass?: string;
  rowProps?: (index: number) => HTMLAttributes<HTMLButtonElement>;
  onError?: (error: unknown) => void;
}
/** Shared leaf for actual composer connector rows. No directory or plugin code. */
export function ConnectorReconnectRows({
  servers,
  onToggle,
  disabled = false,
  disabledReason,
  enabledOverrides,
  toolOverrides,
  switchClass = "composer-add-switch",
  rowProps,
  onError,
}: ConnectorReconnectRowsProps) {
  useLocale();
  const app = useContext(AppContext);
  const policy = usePolicy(),
    local = useHostCapability("localMcp");
  const entries = Object.entries(servers).filter(
    ([name, value]) =>
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      connectorAllowed(policy, name, value),
  );
  const owner = useConnectorOwner(
    JSON.stringify([entries, app?.activeId, app?.draftSession]),
  );
  const [snapshot, setSnapshot] = useState<{
    key: number;
    servers: McpServerState[];
  }>();
  const [error, setError] = useState<{ key: number; message: string }>();
  const [reading, setReading] = useState<number>();
  const [pending, setPending] = useState<{ key: number; name: string }>();
  const lock = useRef<number | undefined>(undefined);
  const currentSnapshot = snapshot?.key === owner.key ? snapshot.servers : [];
  const currentError = error?.key === owner.key ? error.message : undefined;
  const busy = pending?.key === owner.key ? pending.name : undefined;
  const load = async () => {
    if (!owner.current()) return;
    const operation = owner.capture("status");
    if (typeof operation.bridge.mcpServers !== "function") return;
    setReading(owner.key);
    setError(undefined);
    try {
      const result = await operation.bridge.mcpServers();
      if (!operation.current()) return;
      setSnapshot({ key: owner.key, servers: readConnectorServers(result) });
    } catch (reason) {
      if (!operation.current()) return;
      // The raw failure is for the log; the menu says the fixed sentence.
      console.error("Connector status did not load:", reason);
      setError({ key: owner.key, message: t("Couldn’t load connectors") });
    } finally {
      if (operation.current()) setReading(undefined);
    }
  };
  useEffect(() => {
    void load();
    if (!owner.current()) return;
    const operation = owner.capture("subscription");
    return operation.bridge.onEvent?.((event) => {
      if (!operation.current()) return;
      if (
        event.type === "settings" ||
        (event.type === "engine" && event.engine.state === "ready")
      )
        void load();
    });
  }, [owner.key]);
  const reconnect = async (name: string) => {
    if (disabled || lock.current === owner.key || !owner.current()) return;
    const operation = owner.capture("reconnect");
    lock.current = owner.key;
    setPending({ key: owner.key, name });
    setError(undefined);
    try {
      await connectCustomConnector(name, local, operation);
      if (!operation.current()) return;
      // OAuth opening is not authentication success. Re-read actual runtime status.
      await load();
    } catch (reason) {
      if (operation.current()) {
        setError({ key: owner.key, message: t("Failed to connect") });
        onError?.(reason);
      }
    } finally {
      if (lock.current === owner.key) lock.current = undefined;
      if (operation.current()) setPending(undefined);
    }
  };
  return (
    <>
      {entries.map(([name, config], index) => {
        const runtime = currentSnapshot.find((server) => server.name === name);
        const configured = (config as { enabled?: unknown }).enabled !== false;
        const enabled = connectorSessionEnabled(
          name,
          configured,
          enabledOverrides?.[name],
          toolOverrides,
          runtime,
        );
        const unknown =
          typeof window.desktop.mcpServers === "function" && !runtime;
        const toolsUnavailable =
          runtime?.state === "ready" &&
          runtime.toolList !== undefined &&
          !runtime.toolList.some((tool) => tool.enabled);
        const blocked =
          unknown ||
          toolsUnavailable ||
          (runtime?.state === "failed" &&
            !canReconnectConnector(
              runtime,
              config,
              typeof window.desktop.connectConnector === "function",
            ));
        const reconnectable =
          enabled &&
          canReconnectConnector(
            runtime,
            config,
            typeof window.desktop.connectConnector === "function",
          );
        return reconnectable ? (
          <button
            key={name}
            type="button"
            role="menuitem"
            {...rowProps?.(index)}
            title={disabled ? disabledReason : undefined}
            disabled={disabled || !!busy}
            onClick={() => void reconnect(name)}
            aria-label={formatText("Reconnect {name}", { name })}
          >
            <TriangleAlert />
            <span data-no-translate>{runtime?.displayName ?? name}</span>
            <span>{t(busy === name ? "Connecting…" : "Reconnect")}</span>
          </button>
        ) : (
          <button
            key={name}
            type="button"
            role="menuitemcheckbox"
            aria-checked={enabled}
            {...rowProps?.(index)}
            disabled={disabled || !!busy || blocked}
            title={
              disabled
                ? disabledReason
                : toolsUnavailable
                  ? t("This connector has no tools available")
                  : runtime?.state === "failed"
                    ? t("Failed to connect")
                    : blocked
                      ? t("Connector tools aren’t available yet.")
                      : undefined
            }
            onClick={() => {
              if (owner.current() && !blocked)
                onToggle(name, !enabled, runtime);
            }}
          >
            <Blocks />
            <span data-no-translate>{runtime?.displayName ?? name}</span>
            <span
              className={switchClass}
              data-enabled={enabled}
              aria-hidden="true"
            />
          </button>
        );
      })}
      {/* While the list is read: the live menu's loading row, and only where no
         connector row shows yet. */}
      {reading === owner.key &&
        snapshot?.key !== owner.key &&
        entries.length === 0 && (
          <SkeletonGroup className="composer-connector-loading" hold={false}>
            <Skeleton width={20} height={20} />
            <Skeleton width={96} height={16} />
          </SkeletonGroup>
        )}
      {currentError && (
        <div role="alert">
          <span>{currentError}</span>
          <button
            type="button"
            role="menuitem"
            disabled={reading === owner.key || !!busy}
            onClick={() => void load()}
          >
            {t("Try again")}
          </button>
        </div>
      )}
    </>
  );
}
