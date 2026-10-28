/**
 * Where the renderer runs: the Electron desktop app or the web app served by
 * the Claudex service (docs/architecture.md).
 *
 * Two things describe a host:
 * - `surface`, a build constant, picks layout variants (window chrome, the
 *   sidebar head, keyboard shortcuts). It never changes at run time.
 * - `HostInfo.capabilities`, sent with the snapshot (`Snapshot.host`), decide
 *   which features have an entry point. A control whose capability is off is
 *   not shown at all; this is not ClientPolicy, which shows a feature as
 *   turned off by the administrator.
 *
 * On the desktop every local capability is on and nothing changes. Round-two
 * packages check the matching capability where they add a desktop-only entry
 * point (`useHost().capabilities.popOutWindows`, …).
 */

export type HostSurface = "desktop" | "web";

export interface HostCapabilities {
  /** Choose, reveal and work in folders on this computer. */
  localFolders: boolean;
  /** Code conversations that run in a local folder (the Local environment). */
  localCode: boolean;
  /** Terminal panel and background terminals on this computer. */
  localTerminal: boolean;
  /** Local (stdio) MCP servers and the MCP configuration file. */
  localMcp: boolean;
  /** Code's Browser panel and dev servers (R8). */
  browserPanel: boolean;
  /** SSH remote environments (R9). */
  ssh: boolean;
  /** Computer use (R10). */
  computerUse: boolean;
  /** A conversation or artifact in its own window (R2). */
  popOutWindows: boolean;
  /** Window buttons and the draggable title area. */
  windowChrome: boolean;
  /** Start at login, quick-access shortcut, tray, data folder, storage. */
  systemIntegration: boolean;
  /** Restart the Codex engine from the app. */
  engineRestart: boolean;
  /** The app's own update check and download. */
  appUpdates: boolean;
  /** Cowork running in a cloud sandbox (web). */
  cloudCowork: boolean;
  /** Code running in a cloud sandbox with a repository (web). */
  cloudCode: boolean;
  /**
   * Adding, removing and switching tools of remote (https) MCP connectors
   * from Settings → Connectors without a local configuration file: the
   * web's runner keeps them, and their bearer tokens, for the user.
   */
  customConnectors: boolean;
  /**
   * Scheduled tasks: on the desktop the local scheduler; on the web the
   * runner's, which wakes the user when one is due (needs Cowork or Code
   * to run the task in).
   */
  scheduledTasks: boolean;
  /** Protocol feature: must be advertised by the actual main/runner backend. */
  codeSessionPermissions?: boolean;
}

export type HostCapability = keyof HostCapabilities;

/** How far a cloud environment's sandbox may reach on the network. */
export type CloudNetworkLevel = "none" | "trusted" | "custom" | "full";

/**
 * A cloud environment a Code session runs in (web). The runner reports the
 * initial ones it offers; saved profiles are edited through CloudEnvironmentsAPI.
 */
export interface CloudEnvironment {
  id: string;
  /** What the environment chip says ("Default"). */
  name: string;
  /** The sandbox's network level, as the runner enforces it. */
  network: CloudNetworkLevel;
  /** The environment a new session starts in. */
  isDefault: boolean;
}

/** The cloud permission modes (the composer footer's pickers). */
export type CloudPermissionMode =
  "auto" | "manual" | "acceptEdits" | "plan" | "bypass";

/** What the cloud runner offers to Code and Cowork sessions (web). */
export interface CloudHostInfo {
  environments: CloudEnvironment[];
  /** The permission modes the sandbox supports; the picker lists only these. */
  permissionModes: CloudPermissionMode[];
}

/** Where a new Code session's repository comes from (cloned by the runner). */
export interface RepositoryRef {
  /** An https address of a git repository. */
  url: string;
  /**
   * A branch or tag; or a ref outside refs/heads and refs/tags (such as the
   * one Continue in cloud uploads a session's work to), or a commit, which
   * is fetched after the clone. The default branch when missing.
   */
  ref?: string;
  /**
   * The local branch a ref outside refs/heads or a commit is checked out
   * as (Continue in cloud: the desktop's branch); detached when missing.
   */
  branch?: string;
}

export interface HostInfo {
  kind: HostSurface;
  capabilities: HostCapabilities;
  /**
   * The web: how far the service lets a task's sandbox reach on the network
   * (its ceiling; Settings → Capabilities can only narrow it).
   */
  sandboxNetwork?: CloudNetworkLevel;
  /** The runner's cloud environments and modes; only reported on the web. */
  cloud?: CloudHostInfo;
}

export const desktopHost: HostInfo = Object.freeze({
  kind: "desktop",
  capabilities: Object.freeze({
    localFolders: true,
    localCode: true,
    localTerminal: true,
    localMcp: true,
    browserPanel: true,
    ssh: true,
    computerUse: true,
    popOutWindows: true,
    windowChrome: true,
    systemIntegration: true,
    engineRestart: true,
    appUpdates: true,
    cloudCowork: false,
    cloudCode: false,
    customConnectors: true,
    scheduledTasks: true,
    codeSessionPermissions: false,
  }),
}) as HostInfo;

/**
 * The web app before the service says more: nothing that needs this
 * computer, and no cloud Cowork or Code until the service turns them on.
 */
export const webHost: HostInfo = Object.freeze({
  kind: "web",
  capabilities: Object.freeze({
    localFolders: false,
    localCode: false,
    localTerminal: false,
    localMcp: false,
    browserPanel: false,
    ssh: false,
    computerUse: false,
    popOutWindows: false,
    windowChrome: false,
    systemIntegration: false,
    engineRestart: false,
    appUpdates: false,
    cloudCowork: false,
    cloudCode: false,
    customConnectors: false,
    scheduledTasks: false,
    codeSessionPermissions: false,
  }),
}) as HostInfo;

/** Set by the build: vite.config.ts ("desktop") or the web build ("web"). */
declare const __CLAUDEX_SURFACE__: HostSurface | undefined;

/** The surface this bundle was built for. Keep the literal visible to the
 * bundler so native-only paths are removed from the web's initial download.
 * Node (main process/tests) has no build constant and defaults to desktop. */
export const surface: HostSurface =
  typeof __CLAUDEX_SURFACE__ !== "undefined" && __CLAUDEX_SURFACE__ === "web"
    ? "web"
    : "desktop";

/**
 * Capabilities that need the Electron shell itself. The web app never has
 * them, whatever a snapshot says.
 */
export const shellOnlyCapabilities: readonly HostCapability[] = Object.freeze([
  "windowChrome",
  "popOutWindows",
  "systemIntegration",
  "appUpdates",
]);

/** The default host of a surface. */
export function hostFor(kind: HostSurface): HostInfo {
  return kind === "web" ? webHost : desktopHost;
}

/**
 * The host a window uses: the surface's defaults, with what the snapshot
 * reports on top. The surface is the build's; a snapshot cannot turn the
 * web app into the desktop app or back. Capabilities the snapshot leaves out
 * (an older service) keep the surface's default; values that are not
 * booleans are ignored, and so is turning on a shell-only capability on the
 * web.
 */
export function resolveHost(
  kind: HostSurface,
  reported?: {
    capabilities?: Partial<HostCapabilities>;
    sandboxNetwork?: unknown;
  } | null,
): HostInfo {
  const base = hostFor(kind);
  const cloud =
    kind === "web"
      ? cloudInfoFrom(
          (reported as { cloud?: unknown } | null | undefined)?.cloud,
        )
      : undefined;
  // The web's sandbox network ceiling, when it is one of the known levels.
  const sandboxNetwork =
    kind === "web" &&
    typeof reported?.sandboxNetwork === "string" &&
    networkLevels.includes(reported.sandboxNetwork)
      ? (reported.sandboxNetwork as CloudNetworkLevel)
      : undefined;
  const extra = {
    ...(cloud ? { cloud } : {}),
    ...(sandboxNetwork ? { sandboxNetwork } : {}),
  };
  const given = reported?.capabilities;
  if (!given || typeof given !== "object")
    return Object.keys(extra).length ? { ...base, ...extra } : base;
  const capabilities = { ...base.capabilities };
  let changed = false;
  for (const key of Object.keys(capabilities) as HostCapability[]) {
    const value = given[key];
    if (kind === "web" && shellOnlyCapabilities.includes(key)) continue;
    if (typeof value === "boolean" && value !== capabilities[key]) {
      capabilities[key] = value;
      changed = true;
    }
  }
  if (!changed && !Object.keys(extra).length) return base;
  return { kind, capabilities, ...extra };
}

const networkLevels: readonly string[] = ["none", "trusted", "custom", "full"];
const permissionModes: readonly string[] = [
  "auto",
  "manual",
  "acceptEdits",
  "plan",
  "bypass",
];

/** The cloud part of a reported host, keeping only well-formed entries. */
export function cloudInfoFrom(value: unknown): CloudHostInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { environments?: unknown; permissionModes?: unknown };
  const environments: CloudEnvironment[] = [];
  if (Array.isArray(raw.environments))
    for (const item of raw.environments.slice(0, 20)) {
      const entry = item as Partial<CloudEnvironment> | null;
      if (
        entry &&
        typeof entry.id === "string" &&
        entry.id &&
        typeof entry.name === "string" &&
        entry.name &&
        typeof entry.network === "string" &&
        networkLevels.includes(entry.network)
      )
        environments.push({
          id: entry.id.slice(0, 100),
          name: entry.name.slice(0, 100),
          network: entry.network,
          isDefault: entry.isDefault === true,
        });
    }
  const modes: CloudPermissionMode[] = [];
  if (Array.isArray(raw.permissionModes))
    for (const mode of raw.permissionModes)
      if (
        typeof mode === "string" &&
        permissionModes.includes(mode) &&
        !modes.includes(mode as CloudPermissionMode)
      )
        modes.push(mode as CloudPermissionMode);
  if (!environments.length && !modes.length) return undefined;
  return { environments, permissionModes: modes };
}

/** The environment a new session starts in, if the runner reports any. */
export function defaultCloudEnvironment(
  cloud: CloudHostInfo | undefined,
): CloudEnvironment | undefined {
  return (
    cloud?.environments.find((environment) => environment.isDefault) ??
    cloud?.environments[0]
  );
}

/**
 * Where a cloud sandbox is in its life (web; W-RUN-design §3). `queued`
 * waits for capacity (`queuePosition`), `provisioning` and `setup` start it,
 * `ready` and `idle` wait for work, `running` has a turn, `stopped` was
 * released and resumes on the next turn, `archived` is gone for good.
 */
export type CloudSessionState =
  | "queued"
  | "provisioning"
  | "setup"
  | "ready"
  | "running"
  | "idle"
  | "stopped"
  | "archived"
  | "error";

/** A cloud sandbox's state, as the web app shows it. */
export interface CloudSessionInfo {
  /**
   * The Code conversation the sandbox belongs to; absent for the account's
   * shared Chat and Cowork sandbox.
   */
  conversationId?: string;
  state: CloudSessionState;
  /** Place in the queue (1 is next) while `queued`. */
  queuePosition?: number;
  /** Why the sandbox is in `error`, in plain English. */
  message?: string;
  /** When the state changed (ms since the epoch). */
  updatedAt?: number;
}
