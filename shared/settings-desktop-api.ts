/**
 * Bridge calls behind the desktop and developer Settings pages: System, Cowork
 * files, Developer (MCP servers), Skills and the Windows sandbox. Handlers are
 * in `electron/ipc/settings-desktop.ts` and `electron/ipc/skills.ts`.
 */
import { bridgeMethods } from "./bridge-methods";
import type { SkillUploadCapabilities } from "./customize-search";
import type { InstallSkillOptions } from "./skill-upload";
import type { SkillImportFile, SkillImportOutcome } from "./skill-import";
import type { NotificationAuthorizationAPI } from "./desktop-notifications";
import type { McpSettingsAPI } from "./settings-mcp-api";

/**
 * Settings → System → Storage: the space Claudex uses on this computer in the
 * official four areas. "Cowork tasks" are Claudex's Chat and Cowork
 * conversations, "Code sessions" its Code conversations; Claudex makes no
 * worktrees, so the Code area has none.
 */
export interface StorageUsage {
  computedAt: number;
  /** Some folders couldn't be read, so the sizes are a lower bound. */
  incomplete: boolean;
  /** The account's data folder (Open folder). */
  folder: string;
  cowork: {
    /** Chat and Cowork conversations saved on this computer. */
    count: number;
    /** Of them, Chat conversations (the official "chats"). */
    chatCount: number;
    /** The conversations' records and agent session history. */
    historyBytes: number;
    /** Attachments, generated files and computer use screenshots. */
    filesBytes: number;
    pluginsAndSkillsBytes: number;
    /** The folder Chat and Cowork work in when no folder is chosen. */
    workspaceBytes: number;
    /** Everything else in the account's folder (settings, projects, memory, older history). */
    otherBytes: number;
    /** Conversations with no activity in the last `olderThanDays` days. */
    stale: { olderThanDays: number; count: number; bytes: number };
  };
  code: {
    sessionCount: number;
    /** The sessions' records, agent session history and files. */
    historyBytes: number;
    /** The folder terminals of sessions without a folder start in. */
    scratchBytes: number;
  };
  runtime: {
    /** Agent runtime versions downloaded for SSH hosts. */
    versionCount: number;
    bytes: number;
  };
  app: {
    webCacheBytes: number;
    browserPanesBytes: number;
    logsBytes: number;
    otherCachesBytes: number;
  };
}

/** Free up space… (Cowork tasks) or Clean up inactive sessions… (Code). */
export type StorageCleanupKind = "cowork" | "code";
/** "Inactive for at least" 30, 60 or 90 days. */
export type StorageCleanupWindow = 30 | 60 | 90;

export interface StorageCleanupExample {
  title: string;
  bytes: number;
}

/** What a cleanup would delete; `token` confirms exactly this plan. */
export interface StorageCleanupPreview {
  token: string;
  kind: StorageCleanupKind;
  olderThanDays: number;
  /** Conversations it deletes. */
  count: number;
  /** Of them, Chat conversations. */
  chatCount: number;
  /** Space freed. */
  bytes: number;
  /** Up to five of them, most recently active first. */
  examples: StorageCleanupExample[];
  /** Inactive by their record but changed on this computer since, so left alone. */
  unverifiedCount: number;
  /** Code: of them, sessions whose worktree is still on disk (Remove takes those). */
  worktreeCount?: number;
}

/**
 * `expired`: the preview is older than ten minutes or a newer one replaced
 * it; `already-running`: a cleanup is still finishing.
 */
export type StorageCleanupError = "expired" | "already-running";

export interface StorageCleanupPreviewResult {
  preview?: StorageCleanupPreview;
  errorCode?: StorageCleanupError;
}

export interface StorageCleanupResult {
  deletedCount: number;
  /** Code without deleting the sessions: the worktrees removed. */
  worktreesRemoved?: number;
  /** Left as they are: in use, pinned or changed since the preview. */
  skippedCount: number;
  failedCount: number;
  /** Of the failures, ones whose files another program had open. */
  failedInUseCount: number;
  cancelled: boolean;
  errorCode?: StorageCleanupError;
}

/** How far the running cleanup got: `done` of `total` conversations reached. */
export interface StorageCleanupEvent {
  type: "storage-cleanup-progress";
  done: number;
  total: number;
}

/** The question Clear cache and restart… asks, in the window's language. */
export interface ClearCacheQuestion {
  message: string;
  detail: string;
  cancel: string;
  confirm: string;
}

export interface SystemState {
  quickEntryDictation?: boolean;
  customQuickEntryDictationShortcut?: boolean;
  /** null where the platform has no login items (Linux). */
  runOnStartup: boolean | null;
  /** Accelerators Quick access can use on this platform. */
  shortcutChoices: string[];
  nativeQuickEntry?: { status: "supported" | "unsupported" };
  /** "unsupported": a Linux desktop without tray icons. */
  trayIcon?: "supported" | "unsupported";
  dataFolder: string;
  /**
   * This computer's name, as a project's folder line shows it ("On
   * {deviceName}"); absent from hosts that do not report it.
   */
  deviceName?: string;
}

export interface McpServerState {
  transport?: "sse" | "streamable-http";
  displayName?: string;
  name: string;
  connectorId?: import("./starter-integrations").StarterConnectorId;
  /** `disabled`: switched off in the configuration (`"enabled": false`) or the Connectors menu. */
  state: "starting" | "ready" | "failed" | "cancelled" | "stopped" | "disabled";
  error?: string;
  tools: number;
  /** Each tool the server offers (and ones switched off), for Connectors → Tools. */
  toolList?: McpToolState[];
  /** How many of its tools were chosen Always allow (the Connectors page offers to forget them). */
  alwaysAllowed?: number;
  /**
   * How the runtime signs in to a remote server: `notLoggedIn` offers
   * Connect (OAuth in the browser), `oAuth` is signed in.
   */
  authStatus?: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";
  lastConnectedAt?: number;
  desktopExtension?: boolean;
  /** The configured command line, when the server is a local program. */
  command?: string;
  url?: string;
}

export interface McpToolState {
  name: string;
  description: string;
  /** False when listed in the server's `disabled_tools`. */
  enabled: boolean;
  /**
   * The tool's approval mode in the configuration: `approve` never asks
   * (Always allow), `prompt` always asks; unset follows the runtime's
   * default, shown as Needs approval.
   */
  approval?: "approve" | "prompt";
  /**
   * What the server says the tool does: `readOnly` when its annotations call it
   * read-only, `write` when it has annotations that do not, unset when it has
   * none.
   */
  access?: "readOnly" | "write";
}

/** Settings → Connectors → Tool permissions: what a tool does when Claudex wants to use it. */
export type ConnectorToolPermission = "allow" | "ask" | "block";

/** Settings → Connectors → Add custom connector. */
export interface CustomConnector {
  replaceName?: string;
  name: string;
  displayName?: string;
  clientId?: string;
  clientSecret?: string;
  transport?: "sse" | "streamable-http";
  connectorId?: import("./starter-integrations").StarterConnectorId;
  /** https://…, or http:// on this computer. */
  url: string;
  /** The environment variable with a bearer token (the token itself is never stored). */
  bearerTokenEnvVar?: string;
  /**
   * The web: the server's bearer token, kept on the runner (never in the
   * settings, never sent back to the page) and added to the server's
   * requests as an Authorization header.
   */
  bearerToken?: string;
}

export interface McpServers {
  servers: McpServerState[];
  /** Why the configuration file's last edit was not applied. */
  configError?: string;
  /** The file Edit config opens. */
  configPath: string;
}

export interface SettingsDesktopAPI
  extends NotificationAuthorizationAPI, McpSettingsAPI {
  storageUsage(): Promise<StorageUsage>;
  /**
   * Clear cache and restart…: asks with the system's dialog, then clears
   * the web caches and restarts; false when the person cancelled.
   */
  clearCacheAndRestart(question: ClearCacheQuestion): Promise<boolean>;
  /** What deleting the conversations inactive for `days` days would free. */
  previewStorageCleanup(
    kind: StorageCleanupKind,
    days: StorageCleanupWindow,
  ): Promise<StorageCleanupPreviewResult>;
  /**
   * Deletes what the preview with `token` listed, checking each one again;
   * progress arrives as `storage-cleanup-progress` events. Code sessions are
   * deleted only with `deleteSessions` (the official cleanup otherwise
   * removes worktrees, which Claudex doesn't make).
   */
  runStorageCleanup(
    token: string,
    options?: { deleteSessions?: boolean },
  ): Promise<StorageCleanupResult>;
  /** Stops the running cleanup after the conversation it is deleting. */
  cancelStorageCleanup(): Promise<void>;
  systemState(): Promise<SystemState>;
  openQuickEntry(): Promise<void>;
  setRunOnStartup(enabled: boolean): Promise<SystemState>;
  revealDataFolder(): Promise<void>;
  /** Opens the MCP configuration file in the system editor; edits apply when saved. */
  openMcpConfig(): Promise<void>;
  installUnpackedExtension(): Promise<string | null>;
  installExtension(file?: {
    name: string;
    data: Uint8Array;
  }): Promise<string | null>;
  openExtensionsFolder(): Promise<void>;
  openExtensionSettingsFolder(): Promise<void>;
  extensionTools(): Promise<
    { name: string; versions: string[]; builtInVersion: string | null }[]
  >;
  mcpServers(): Promise<McpServers>;
  listMcp(): Promise<any[]>;
  listSkills(): Promise<any[]>;
  saveSkill(skill: {
    name: string;
    description: string;
    instructions: string;
  }): Promise<void>;
  setSkillEnabled(path: string, enabled: boolean): Promise<void>;
  /** Copies a skill folder (with SKILL.md) chosen by the user; its name, or null. */
  uploadSkill(): Promise<string | null>;
  skillUploadCapabilities(): Promise<SkillUploadCapabilities>;
  /** Upload a skill page: .md, .zip or .skill files; answers the names added. */
  installSkillFiles(
    files: { name: string; data: Uint8Array }[],
    options?: InstallSkillOptions,
  ): Promise<string[]>;
  importSkillFiles(files: SkillImportFile[]): Promise<SkillImportOutcome[]>;
  deleteSkill(path: string): Promise<void>;
  /**
   * Duplicate skill: copies a listed skill into the user's own skills under
   * `name` (lower case, digits, hyphens); answers the name. A taken name is
   * refused with `skillNameTaken`.
   */
  duplicateSkill(path: string, name: string): Promise<string>;
  /** Rename skill, for one of the user's own; answers the new name. */
  renameSkill(path: string, name: string): Promise<string>;
  revealSkill(path: string): Promise<void>;
  setupWindowsSandbox(): Promise<{ ready: boolean; message: string }>;
  /** Opens the app menu at a point in the window (≡ on Windows and Linux). */
  showAppMenu(x: number, y: number): Promise<void>;
  /** Adds a remote MCP server; refused when the policy does not allow it. */
  addCustomConnector(connector: CustomConnector): Promise<McpServers>;
  probeConnector(
    url: string,
    name?: string,
    transport?: "sse" | "streamable-http",
  ): Promise<{ authRequired: boolean }>;
  /** Removes a connector from the configuration (Disconnect). */
  removeConnector(name: string): Promise<McpServers>;
  /** Turns one of a connector's tools on or off. */
  setConnectorTool(
    name: string,
    tool: string,
    enabled: boolean,
  ): Promise<McpServers>;
  /**
   * Sets a connector tool's permission: Always allow (never asks), Needs
   * approval (asks each time) or Blocked (never offered). Always allow is
   * refused when the administrator turned persistent grants off.
   */
  setConnectorToolPermission(
    name: string,
    tool: string,
    permission: ConnectorToolPermission,
  ): Promise<McpServers>;
  /**
   * Forgets the "Always allow" choices made for connector tools: one
   * connector's, or every connector's when no name is given.
   */
  forgetConnectorApprovals(name?: string): Promise<McpServers>;
  /** Starts the runtime's OAuth sign-in for a remote connector in the browser. */
  connectConnector(name: string, returnUrl?: string): Promise<string | void>;
  completeConnectorLogin(state: string, code: string): Promise<string>;
}

export const settingsDesktopMethods = bridgeMethods<SettingsDesktopAPI>({
  readMcpLogs: true,
  discoverLocalMcp: true,
  importLocalMcp: true,
  getNotificationAuthorizationStatus: true,
  requestNotificationAuthorization: true,
  openNotificationSettings: true,
  supportsNotificationActions: true,
  showDesktopNotification: true,
  setProjectPromptsWaiting: true,
  storageUsage: true,
  clearCacheAndRestart: true,
  previewStorageCleanup: true,
  runStorageCleanup: true,
  cancelStorageCleanup: true,
  systemState: true,
  openQuickEntry: true,
  setRunOnStartup: true,
  revealDataFolder: true,
  openMcpConfig: true,
  installUnpackedExtension: true,
  installExtension: true,
  openExtensionsFolder: true,
  openExtensionSettingsFolder: true,
  extensionTools: true,
  mcpServers: true,
  listMcp: true,
  listSkills: true,
  saveSkill: true,
  setSkillEnabled: true,
  uploadSkill: true,
  installSkillFiles: true,
  skillUploadCapabilities: true,
  importSkillFiles: true,
  deleteSkill: true,
  duplicateSkill: true,
  renameSkill: true,
  revealSkill: true,
  setupWindowsSandbox: true,
  showAppMenu: true,
  addCustomConnector: true,
  probeConnector: true,
  removeConnector: true,
  setConnectorTool: true,
  setConnectorToolPermission: true,
  forgetConnectorApprovals: true,
  connectConnector: true,
  completeConnectorLogin: true,
});
