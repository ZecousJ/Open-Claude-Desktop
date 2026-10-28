import type { DevServerState } from "../../shared/browser";
import { formatText, t } from "../i18n";
import type { MenuEntry } from "../ui/Menu";
import { devServerActive } from "./browser-model";

export interface DevServerActions {
  start: (server: DevServerState) => void;
  stop: (server: DevServerState) => void;
  open: (server: DevServerState) => void;
  stopAll: () => void;
  /** Shows or hides the logs drawer; absent when no server has logs. */
  toggleLogs?: () => void;
  add: () => void;
}

/** A row's tooltip: its port, Starting…, Failed to start or Not running. */
export function devServerTooltip(server: DevServerState) {
  if (server.status === "starting" || server.status === "awaiting-approval")
    return t("Starting…");
  if (server.status === "failed" || server.status === "crashed")
    return t("Failed to start");
  if (server.status === "running")
    return server.port ? `:${server.port}` : undefined;
  return t("Not running");
}

/**
 * The dev servers menu. Each server is a row named after it, checked while the
 * tab shows it, with its port, Starting…, Failed to start or Not running as its
 * tooltip, and an xxs Run or (red) Stop at its end, which → also presses.
 * Choosing a running server opens it; choosing one that is not running runs it.
 * Stop all servers (red) follows while any runs; with nothing configured the
 * menu says "No dev server configured". Add server and Show or Hide dev server
 * logs end it. A server only seen in terminal output can be opened but not run
 * or stopped from here.
 */
export function devServerEntries(
  servers: readonly DevServerState[],
  actions: DevServerActions,
  {
    showingUrl,
    logsOpen = false,
    rtl = false,
  }: { showingUrl?: string; logsOpen?: boolean; rtl?: boolean } = {},
): MenuEntry[] {
  const origin = (url?: string) => {
    try {
      return url ? new URL(url).origin : "";
    } catch {
      return "";
    }
  };
  const showing = origin(showingUrl);
  const rows: MenuEntry[] = servers.map((server): MenuEntry => {
    const active = devServerActive(server);
    const configured = server.source === "launch.json";
    const running = server.status === "running";
    const stop = active && configured;
    return {
      label: server.name,
      noTranslate: true,
      checked: Boolean(showing) && running && origin(server.url) === showing,
      tooltip: devServerTooltip(server),
      onSelect: running
        ? () => actions.open(server)
        : configured && !active
          ? () => actions.start(server)
          : undefined,
      trailing: configured
        ? {
            text: stop ? t("Stop") : t("Run"),
            label: formatText(stop ? "Stop {serverName}" : "Run {serverName}", {
              serverName: server.name,
            }),
            danger: stop,
            hint: t(
              stop
                ? rtl
                  ? "press left arrow to stop"
                  : "press right arrow to stop"
                : rtl
                  ? "press left arrow to run"
                  : "press right arrow to run",
            ),
            onAction: () =>
              stop ? actions.stop(server) : actions.start(server),
          }
        : undefined,
    };
  });
  const anyRunning = servers.some(
    (server) => server.source === "launch.json" && devServerActive(server),
  );
  return [
    { heading: t("Servers") },
    ...(rows.length
      ? rows
      : [
          { label: t("No dev server configured"), disabled: true } as MenuEntry,
        ]),
    ...(anyRunning
      ? [
          {
            label: t("Stop all servers"),
            danger: true,
            onSelect: actions.stopAll,
          },
        ]
      : []),
    { separator: true },
    { label: t("Add server"), onSelect: actions.add },
    ...(actions.toggleLogs
      ? [
          {
            label: logsOpen
              ? t("Hide dev server logs")
              : t("Show dev server logs"),
            onSelect: actions.toggleLogs,
          },
        ]
      : []),
  ];
}
