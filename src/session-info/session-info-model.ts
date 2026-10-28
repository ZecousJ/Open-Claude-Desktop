import type { Conversation } from "../../shared/types";
import type { AppEnvironment } from "../../shared/app-update-api";
import type { McpServerState } from "../../shared/settings-desktop-api";
import { formatText } from "../i18n";

/**
 * Session info, the card /status posts in a Code transcript: three groups of
 * rows. Session: Desktop app, Model (with effort), Permissions, Started and the
 * Session ID (cut to eight characters, copyable; the full ID in the copied
 * report, with the Desktop session ID). Environment: Host (an SSH host), Folder
 * (the home folder as "~"), Additional folders, MCP servers (by state) and
 * Sandbox. Account: Signed in as.
 */
export interface InfoRow {
  id: string;
  label: string;
  value: string;
  /** The whole value, when `value` is shortened (the tooltip and the copy). */
  fullValue?: string;
  hint?: string;
  copyable?: boolean;
  /** Only in the copied report, not on the card. */
  reportOnly?: boolean;
}
export interface InfoGroup {
  id: string;
  label: string;
  rows: InfoRow[];
}

/** "~/…" for a path inside the home folder. */
export function homeRelative(path: string, home?: string) {
  if (!home) return path;
  return path === home || path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path;
}

/** A long ID shows its first eight characters and an ellipsis. */
export const shortId = (id: string) =>
  id.length > 14 ? `${id.slice(0, 8)}…` : id;

const platformName = (platform: string) =>
  platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform;

/** MCP servers by state: "2 connected · 1 failed", or None. */
export function mcpSummary(servers: McpServerState[]) {
  if (!servers.length) return "None";
  const count = (test: (server: McpServerState) => boolean) =>
    servers.filter(test).length;
  const parts = [
    [
      count((s) => s.state === "ready" && s.authStatus !== "notLoggedIn"),
      "{n} connected",
    ],
    [
      count((s) => s.state === "ready" && s.authStatus === "notLoggedIn"),
      "sign-in",
    ],
    [count((s) => s.state === "starting"), "{n} connecting"],
    [count((s) => s.state === "failed"), "{n} failed"],
    [count((s) => s.state === "disabled" || s.state === "stopped"), "{n} off"],
  ] as const;
  const known = parts.reduce((sum, [n]) => sum + n, 0);
  const shown = parts
    .filter(([n]) => n > 0)
    .map(([n, text]) =>
      text === "sign-in"
        ? formatText(n === 1 ? "{n} needs sign-in" : "{n} need sign-in", { n })
        : formatText(text, { n }),
    );
  if (servers.length > known)
    shown.push(formatText("{n} other", { n: servers.length - known }));
  return shown.join(" · ");
}

export function sessionInfoGroups({
  conversation: c,
  environment,
  model,
  effort,
  permissions,
  sandboxOn,
  sshHost,
  additionalFolders = [],
  mcp,
  account,
  when,
}: {
  conversation: Conversation;
  environment?: AppEnvironment;
  model: string;
  effort?: string;
  permissions: string;
  sandboxOn: boolean;
  sshHost?: string;
  additionalFolders?: string[];
  mcp?: McpServerState[];
  account?: string;
  /** Formats a time for "You · {when}". */
  when: (ms: number) => string;
}): InfoGroup[] {
  const session: InfoRow[] = [];
  if (environment)
    session.push({
      id: "desktopApp",
      label: "Desktop app",
      value: `${environment.version} · ${platformName(environment.platform)} ${environment.osVersion} (${environment.arch})`,
    });
  session.push({
    id: "model",
    label: "Model",
    value: [model, effort].filter(Boolean).join(" · "),
  });
  session.push({ id: "permissions", label: "Permissions", value: permissions });
  const started =
    c.scheduledRun || c.scheduledTaskId
      ? "Scheduled task · {when}"
      : c.forkedFrom
        ? "Forked · {when}"
        : "You · {when}";
  session.push({
    id: "started",
    label: "Started",
    value: formatText(started, { when: when(c.createdAt) }),
    fullValue: formatText(started, {
      when: new Date(c.createdAt).toISOString(),
    }),
  });
  const sessionId = c.threadId ?? c.id;
  session.push({
    id: "sessionId",
    label: "Session ID",
    value: shortId(sessionId),
    fullValue: sessionId,
    copyable: true,
  });
  if (c.threadId && c.threadId !== c.id)
    session.push({
      id: "desktopSessionId",
      label: "Desktop session ID",
      value: c.id,
      reportOnly: true,
    });

  const place: InfoRow[] = [];
  if (sshHost)
    place.push({
      id: "host",
      label: "Host",
      value: formatText("SSH · {host}", { host: sshHost }),
    });
  const home = sshHost ? undefined : environment?.home;
  // A session in its own worktree: Folder is where it started, Worktree where
  // it works.
  const origin = c.worktree?.origin ?? c.cwd;
  if (origin)
    place.push({
      id: "folder",
      label: "Folder",
      value: homeRelative(origin, home),
      fullValue: origin,
    });
  if (c.worktree && c.cwd && c.cwd !== origin)
    place.push({
      id: "worktree",
      label: "Worktree",
      value: homeRelative(c.cwd, home),
      fullValue: c.cwd,
    });
  if (additionalFolders.length)
    place.push({
      id: "extraFolders",
      label: "Additional folders",
      value: additionalFolders
        .map((folder) => homeRelative(folder, home))
        .join(", "),
      fullValue: additionalFolders.join(", "),
    });
  if (mcp)
    place.push({ id: "mcp", label: "MCP servers", value: mcpSummary(mcp) });
  place.push({
    id: "sandbox",
    label: "Sandbox",
    value: sandboxOn ? "On" : "Off",
  });

  const groups: InfoGroup[] = [
    { id: "session", label: "Session", rows: session },
    { id: "environment", label: "Environment", rows: place },
  ];
  if (account)
    groups.push({
      id: "account",
      label: "Account",
      rows: [{ id: "account", label: "Signed in as", value: account }],
    });
  return groups;
}

/** The copied report: a heading, then each group's rows as a list. */
export function sessionInfoReport(groups: InfoGroup[], generatedAt: string) {
  const lines = [
    formatText("Claudex Code session info ({generatedAt})", { generatedAt }),
  ];
  for (const group of groups) {
    if (!group.rows.length) continue;
    lines.push("", `${group.label}:`);
    for (const row of group.rows)
      lines.push(
        `- ${row.label}: ${row.fullValue ?? row.value}${row.hint ? ` (${row.hint})` : ""}`,
      );
  }
  return lines.join("\n");
}
