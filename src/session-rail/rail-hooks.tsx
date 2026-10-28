import { useEffect, useState } from "react";
import type { Conversation } from "../../shared/types";
import type { DevServerState } from "../../shared/browser";
import type { McpServerState } from "../../shared/settings-desktop-api";
import { codeEffortLabels } from "../../shared/code-effort";
import {
  permissionModeOf,
  permissionModeTitles,
} from "../../shared/client-policy";
import { formatText } from "../i18n";
import { api } from "../desktop-api";
import { useApp } from "../app/AppContext";
import { useModelCatalog } from "../composer/useComposerServices";
import { modelLabel } from "../composer/model/code-model-choices";
import { tokens } from "./RailParts";

/** Up to this many rows before Show more (Outputs: 5, Background tasks: 4). */
export function useShowMore<T>(items: T[], limit: number) {
  const [all, setAll] = useState(false);
  return {
    shown: all ? items : items.slice(0, limit),
    toggle:
      items.length > limit ? (
        <button
          type="button"
          className="rail-row interactive rail-more"
          onClick={() => setAll(!all)}
        >
          <span className="rail-row-label">
            {all ? "Show less" : "Show more"}
          </span>
        </button>
      ) : null,
  };
}

/** Codex compacts before a turn above the model's limit, and never later than 90% of the window. */
const soonTokens = 30_000;

export function compactHint(
  used: number,
  window: number | null,
  limit?: number,
) {
  if (!window) return undefined;
  const at = Math.min(limit ?? Infinity, Math.floor(window * 0.9));
  const left = at - used;
  if (!Number.isFinite(left)) return undefined;
  return left < soonTokens
    ? "Auto-compacts soon"
    : formatText("{tokens} until auto-compact", { tokens: tokens(left) });
}

/** The Composer's model, effort and permission pickers' current values. */
export function useSettingsRows(conversation: Conversation) {
  const app = useApp();
  const catalog = useModelCatalog();
  const settings = app.snapshot.settings;
  return {
    model: modelLabel(catalog, conversation.model),
    effort: codeEffortLabels[settings.codeEffort] ?? settings.codeEffort,
    permissions:
      permissionModeTitles[permissionModeOf(settings, conversation.cwd)],
  };
}

/** The MCP servers this computer runs (desktop), read when the rail opens and on focus. */
export function useConnectors() {
  const [servers, setServers] = useState<McpServerState[]>([]);
  useEffect(() => {
    let live = true;
    const read = () =>
      Promise.resolve(window.desktop?.mcpServers?.())
        .then((value) => live && setServers(value?.servers ?? []))
        .catch(() => live && setServers([]));
    void read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, []);
  return servers.filter((server) => server.state !== "disabled");
}

/**
 * An SSH session's host: its name and connection, as the Environment row's
 * trailing status shows it.
 */
export function useSshHost(hostId: string | undefined) {
  const [label, setLabel] = useState<string>();
  const [connection, setConnection] = useState<
    "connecting" | "reconnecting" | "disconnected" | "idle" | undefined
  >();
  useEffect(() => {
    if (!hostId) return;
    let live = true;
    const desktop = window.desktop;
    const show = (status: { state: string } | undefined) => {
      if (!live || !status) return;
      setConnection(
        status.state === "ready"
          ? undefined
          : status.state === "reconnecting"
            ? "reconnecting"
            : status.state === "error" || status.state === "needs-auth"
              ? "disconnected"
              : status.state === "idle"
                ? "idle"
                : "connecting",
      );
    };
    void Promise.resolve(desktop?.sshListHosts?.())
      .then((value) => {
        const host = value?.hosts.find((item) => item.id === hostId);
        if (live && host) setLabel(host.label || host.destination);
      })
      .catch(() => undefined);
    void Promise.resolve(desktop?.sshStatus?.(hostId))
      .then(show)
      .catch(() => undefined);
    const off = desktop?.onEvent?.((event) => {
      if (event.type === "ssh-status" && event.hostId === hostId)
        show(event.status);
    });
    return () => {
      live = false;
      off?.();
    };
  }, [hostId]);
  return { label, connection };
}

/** The session folder's dev servers (the Browser panel's), read when the rail opens. */
export function useServers(conversationId: string, enabled: boolean) {
  const [servers, setServers] = useState<DevServerState[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void Promise.resolve(api.browserState?.(conversationId))
      .then(
        (state) =>
          live &&
          setServers(state?.devServersAvailable ? state.devServers : []),
      )
      .catch(() => live && setServers([]));
    return () => {
      live = false;
    };
  }, [conversationId, enabled]);
  return servers;
}
