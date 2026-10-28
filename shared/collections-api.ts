import type { RoutineBrowserAPI } from "./routine-browser";
/**
 * Collection pages: routines on the local scheduler and the skills Customize
 * lists; R13-D adds custom sidebar groups, project knowledge files, a skill's
 * contents and a routine's run history. The routine fields (rule, description,
 * default model) are in `shared/routines.ts`; handlers go in
 * `electron/ipc/collections.ts`.
 */
import type {
  Routine,
  RoutineInput,
  RoutineAllowed,
  RoutineCapabilities,
  RoutineRepeat,
  RoutineRunQuery,
  RoutineRunPage,
  RoutineSchedulePreview,
  RoutineListResult,
  RoutineDetailResult,
  RoutineBackend,
} from "./routines";
import type { RoutineRun } from "./routine-labels";
import type { ScheduleProposal } from "./routine-proposals";
import type { FindingTriage, SecurityFindingsView } from "./security-review";
import { bridgeMethods } from "./bridge-methods";
import type { ProjectKnowledgePendingAPI } from "./project-knowledge-pending";
import type {
  CustomizeSearchAPI,
  CustomizeSkillProvenance,
} from "./customize-search";
import type { RoutineWorkspaceDiagnostics } from "./routine-workspace";
import type {
  RoutineMigrationEligibility,
  RoutineMigrationRequest,
  RoutineMigrationResult,
  RoutineMigrationImportInput,
  RoutineMigrationDeleteInput,
  RoutineMigrationDeleteResult,
  RoutineMigrationBeginInput,
  RoutineMigrationBeginResult,
  RoutineMigrationRestoreInput,
} from "./routine-migration";
import type {
  DirectorySubmission,
  DirectorySubmissionInput,
} from "./directory-submissions";

/** A skill as Customize lists it (the runtime's list plus when it changed). */
export interface CustomizeSkill {
  name: string;
  description: string;
  /** Its SKILL.md, as the agent runtime reports it. */
  path: string;
  /** user: added in Claudex; system: bundled with the agent; admin: the organization's; repo: the open project's. */
  scope: "user" | "repo" | "system" | "admin";
  enabled: boolean;
  /** When SKILL.md last changed; absent when it cannot be read. */
  editedAt?: number;
  /** Added by the person under the profile's skills folder, so it can be removed. */
  own: boolean;
  provenance?: CustomizeSkillProvenance;
}

/** A custom sidebar group. */
export interface ConversationGroup {
  id: string;
  name: string;
}

/** The account's groups in their order, and which group each conversation is in. */
export interface ConversationGroups {
  groups: ConversationGroup[];
  /** Conversation id → group id; a conversation is in at most one group. */
  members: Record<string, string>;
}

/** A file kept with a project for its chats to read. */
export interface KnowledgeFile {
  name: string;
  bytes: number;
  addedAt: number;
  source?: KnowledgeSource;
}

/** Bounded contents of a file in the current account's project. No disk paths. */
export type KnowledgePreview = { name: string; bytes: number } & (
  | { kind: "text"; text: string }
  | { kind: "pdf"; base64: string }
  | {
      kind: "unsupported";
      reason: "type" | "encoding" | "invalid-pdf" | "too-large";
    }
);

/** Provider outcomes, retained alongside the last successfully synced copy. */
export type KnowledgeSourceFailure =
  "reconnect" | "forbidden" | "not-found" | "resolution" | "temporary";
export interface KnowledgeSourceState {
  status: "idle" | "failed" | "inaccessible";
  failure?: KnowledgeSourceFailure;
  lastSyncedAt: number;
}

export type KnowledgeSource =
  KnowledgeRepositorySource | KnowledgeDriveSource | KnowledgeMcpSource;

/** A connected MCP server's resource (resources/list). */
export interface KnowledgeMcpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

/** A project file synced from an MCP resource (electron/project-knowledge-mcp.ts). */
export interface KnowledgeMcpSource extends KnowledgeSourceState {
  provider: "mcp";
  server: string;
  uri: string;
  name: string;
  title?: string;
  mimeType?: string;
}

export interface KnowledgeRepositorySource extends KnowledgeSourceState {
  provider: "github";
  repository: string;
  branch: string;
  path: string;
}

export interface KnowledgeDriveFile {
  id: string;
  title: string;
  url: string;
}

export interface KnowledgeDriveSource
  extends KnowledgeDriveFile, KnowledgeSourceState {
  provider: "gdrive";
  server: string;
}

export interface KnowledgeRepositoryFile {
  name: string;
  sha: string;
  bytes: number;
}

export interface ProjectKnowledge {
  capabilities?: import("./project-access").ProjectCapabilities;
  pending?: import("./project-knowledge-pending").PendingKnowledgeFile[];
  uploadCapabilities?: import("./project-knowledge-pending").KnowledgeUploadCapabilities;
  files: KnowledgeFile[];
  /** Total size of the files. */
  bytes: number;
  /** The most a project can keep, in bytes. */
  limit: number;
  /** The largest single file, in bytes. */
  fileLimit: number;
}

/** Largest single knowledge file (10 MB, decimal as the page shows it). */
export const knowledgeFileLimit = 10_000_000;
/** Text files the agent can read as they are, and PDFs. */
export const knowledgeExtensions = [
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "svg",
  "mermaid",
  "css",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "java",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "go",
  "rs",
  "rb",
  "php",
  "swift",
  "kt",
  "sh",
  "sql",
  "toml",
  "ini",
  "log",
  "tex",
  "rst",
  "pdf",
];

/** A skill's SKILL.md and the other files in its folder. */
export interface SkillContents {
  /** SKILL.md without its front matter. */
  markdown: string;
  /** Paths relative to the skill's folder, with sizes. */
  files: { path: string; bytes: number }[];
  /** More files than were listed. */
  truncated: boolean;
}

/** A file of a skill's folder, for reading. */
export interface SkillFile {
  /** UTF-8 text, cut at the reading limit; empty for a binary file. */
  text: string;
  truncated: boolean;
  /** Not text (an image, an archive): only its name and size are shown. */
  binary: boolean;
}

/** A text file the person gave a design system as an example of their products. */
export interface DesignSource {
  name: string;
  /** UTF-8 text, cut at `designSourceLimit` characters. */
  text: string;
}

/** Limits of what a design system keeps (the store enforces them). */
export const designSourceLimit = 24_000;
export const designSourceCount = 20;
export const designSourcesTotal = 160_000;
export const designGuidelinesLimit = 60_000;
export const maxDesignSystems = 30;

/**
 * A design system (Settings → Design systems): the colours, type, spacing and
 * components Claude follows when it makes designs, pages, decks or
 * prototypes. It starts as a draft made from the person's description and
 * example files; Claude writes its guidelines from them, and the person may
 * edit those. The one chosen in the composer's + menu (`designSystem`
 * preference) is told to every new Chat and Cowork turn.
 */
export interface DesignSystem {
  id: string;
  name: string;
  /** "Company name and blurb (or name of design system)". */
  blurb: string;
  /** "Any other notes?". */
  notes: string;
  sources: DesignSource[];
  /** The system itself, as Markdown; empty until generated or imported. */
  guidelines: string;
  createdAt: number;
  updatedAt: number;
  /** When Claude last wrote (or the person imported) the guidelines. */
  generatedAt?: number;
}

/** What the page sends to create a design system (no `id`) or change one. */
export interface DesignSystemInput {
  id?: string;
  name: string;
  blurb?: string;
  notes?: string;
  sources?: DesignSource[];
  guidelines?: string;
}

/** A plugin marketplace the runtime has synced (Settings → Plugins → Discover). */
export interface PluginMarketplace {
  name: string;
  /** Its manifest, as the runtime reports it. */
  path: string;
  plugins: number;
  title?: string;
  source?: string;
  lastUpdated?: number;
  syncedCommit?: string;
  autoSync?: boolean;
  syncError?: string;
}

/** A plugin one of the marketplaces lists. */
export interface PluginEntry {
  /** `name@marketplace`. */
  id: string;
  name: string;
  /** The name shown; the plugin's own display name when it has one. */
  title: string;
  marketplace: string;
  marketplacePath: string;
  installed: boolean;
  enabled: boolean;
  /** Not blocked by the marketplace or the administrator. */
  installable: boolean;
  source: "git" | "local" | "other";
  /**
   * In the personal marketplace of this computer's home folder (the
   * person's own plugins, which Rename offers). Desktop only.
   */
  personal?: boolean;
  /** Only when the marketplace's listing carries one; `readPlugin` has the full text. */
  description?: string;
  developer?: string;
  /** Lower case, as the marketplace names it ("development", "security"). */
  category?: string;
  website?: string;
  /** The version its marketplace offers now (the plugin's own manifest). */
  availableVersion?: string;
  /** The version installed for the agent, when installed and known. */
  installedVersion?: string;
}

export interface PluginCatalog {
  marketplaces: PluginMarketplace[];
  /** By title. */
  plugins: PluginEntry[];
  /** Marketplaces that could not be read, with the runtime's reason. */
  loadErrors: string[];
}

/** What a plugin brings, from its own files. */
export interface PluginDetails {
  description: string;
  skills: { name: string; description?: string }[];
  apps: { name: string; description?: string }[];
  mcpServers: { name: string }[];
  hooks: number;
}

export interface PluginInstallResult {
  /** Connected apps the plugin uses that still need signing in. */
  appsNeedingAuth: string[];
}

export interface CollectionsAPI
  extends CustomizeSearchAPI, ProjectKnowledgePendingAPI, RoutineBrowserAPI {
  listDirectorySubmissions(): Promise<DirectorySubmission[]>;
  listApprovedDirectory(): Promise<
    import("./directory-submissions").ApprovedDirectoryEntry[]
  >;
  saveDirectorySubmission(
    input: DirectorySubmissionInput,
    submit: boolean,
  ): Promise<DirectorySubmission>;
  deleteDirectorySubmission(id: string): Promise<void>;
  verifyDirectorySubmissionTools(serverName: string): Promise<string[]>;
  /** Skills for Customize; empty while the agent runtime is not running. */
  customizeSkills(): Promise<CustomizeSkill[]>;
  listSchedules(): Promise<Routine[]>;
  querySchedules(): Promise<RoutineListResult>;
  readSchedule(
    id: string,
    source?: RoutineBackend,
  ): Promise<RoutineDetailResult>;
  routineCapabilities(
    location?: "local" | "remote",
  ): Promise<RoutineCapabilities>;
  routineWorkspace(id: string): Promise<RoutineWorkspaceDiagnostics>;
  routineMigration(
    id: string,
    source?: RoutineBackend,
  ): Promise<RoutineMigrationEligibility>;
  migrateRoutine(
    input: RoutineMigrationRequest,
  ): Promise<RoutineMigrationResult>;
  beginRoutineMigration(
    input: RoutineMigrationBeginInput,
  ): Promise<RoutineMigrationBeginResult>;
  restoreRoutineMigration(
    input: RoutineMigrationRestoreInput,
  ): Promise<Routine>;
  importRoutineMigration(input: RoutineMigrationImportInput): Promise<Routine>;
  deleteRoutineMigration(
    input: RoutineMigrationDeleteInput,
  ): Promise<RoutineMigrationDeleteResult>;
  /**
   * Creates or updates a routine. Refused for a new one while the
   * administrator has turned routines off or the account is at its limit.
   */
  saveSchedule(schedule: RoutineInput): Promise<Routine>;
  deleteSchedule(id: string): Promise<void>;
  /** Starts a run now; refused while the administrator has turned routines off. */
  runSchedule(id: string): Promise<Routine>;
  /**
   * Web: makes a new token for the task's API trigger (the previous one
   * stops working) or deletes it, which turns its API access off. The token
   * comes back once; the task keeps only its last characters.
   */
  routineApiToken(
    triggerId: string,
    action: "generate" | "delete",
  ): Promise<{ token?: string; hint?: string }>;
  /** The routine's most recent runs, newest first (up to routineRunLimit). */
  routineRuns(id: string): Promise<RoutineRun[]>;
  routineRunsPage(id: string, query?: RoutineRunQuery): Promise<RoutineRunPage>;
  routineSchedulePreview(
    repeat: RoutineRepeat,
    location?: "local" | "remote",
  ): Promise<RoutineSchedulePreview>;
  removeRoutineApproval(id: string, entry: RoutineAllowed): Promise<boolean>;
  markRoutineRunRead(id: string, runId: string): Promise<void>;
  /**
   * A security-review routine's findings, best first, with the runs that
   * finished since the last call read into the list (shared/security-review.ts).
   */
  securityFindings(routineId: string): Promise<SecurityFindingsView>;
  /** Marks a finding fixed, dismisses it with a reason, or opens it again. */
  triageSecurityFinding(
    routineId: string,
    findingId: string,
    triage: FindingTriage,
  ): Promise<SecurityFindingsView>;
  /**
   * Has the account's model turn a sentence ("every weekday at 8, summarize my
   * email") into a task: its name, instructions and schedule. Falls back to
   * reading the schedule from the words when no model answers.
   */
  proposeScheduledTask(description: string): Promise<ScheduleProposal>;

  /** A group lasts until it is deleted, empty or not. */
  listConversationGroups(): Promise<ConversationGroups>;
  /**
   * "New group…": adds a group, and moves the conversation into it when one
   * is given (Move to group); without one the group starts empty (a group
   * heading's menu).
   */
  createConversationGroup(
    name: string,
    conversationId?: string | null,
  ): Promise<ConversationGroups>;
  /** Moves a conversation into a group, or out of its group with null. */
  moveConversationToGroup(
    conversationId: string,
    groupId: string | null,
  ): Promise<ConversationGroups>;
  /** Rename group, from a group's heading in the sidebar. */
  renameConversationGroup(
    groupId: string,
    name: string,
  ): Promise<ConversationGroups>;
  /** Delete group: its conversations stay, ungrouped. */
  deleteConversationGroup(groupId: string): Promise<ConversationGroups>;

  listProjectKnowledge(projectId: string): Promise<ProjectKnowledge>;
  readProjectKnowledge(
    projectId: string,
    name: string,
  ): Promise<KnowledgePreview>;
  listProjectKnowledgeRepositories(projectId: string): Promise<string[]>;
  listProjectKnowledgeRepositoryFiles(
    projectId: string,
    repository: string,
    branch: string,
  ): Promise<KnowledgeRepositoryFile[]>;
  addProjectKnowledgeRepositoryFiles(
    projectId: string,
    repository: string,
    files: KnowledgeRepositoryFile[],
    branch?: string,
  ): Promise<ProjectKnowledge>;
  syncProjectKnowledge(
    projectId: string,
    name: string,
  ): Promise<ProjectKnowledge>;
  /** Connected remote MCP servers that list resources. */
  listProjectKnowledgeMcpServers(projectId: string): Promise<string[]>;
  listProjectKnowledgeMcpResources(
    projectId: string,
    server: string,
    query?: string,
  ): Promise<KnowledgeMcpResource[]>;
  /** A pasted URL resolved through the server (resources/read). */
  resolveProjectKnowledgeMcpUrl(
    projectId: string,
    server: string,
    url: string,
  ): Promise<KnowledgeMcpResource>;
  addProjectKnowledgeMcpResource(
    projectId: string,
    server: string,
    resource: KnowledgeMcpResource,
  ): Promise<ProjectKnowledge>;
  listProjectKnowledgeDriveConnectors(projectId: string): Promise<string[]>;
  searchProjectKnowledgeDrive(
    projectId: string,
    server: string,
    query: string,
  ): Promise<KnowledgeDriveFile[]>;
  addProjectKnowledgeDriveFiles(
    projectId: string,
    server: string,
    files: KnowledgeDriveFile[],
  ): Promise<ProjectKnowledge>;
  /** Asks for files and copies them into the project; unchanged when cancelled. */
  addProjectKnowledge(projectId: string): Promise<ProjectKnowledge>;
  /** Copies files the page already read (the web's file picker) into the project. */
  addProjectKnowledgeFiles(
    projectId: string,
    files: { name: string; data: Uint8Array }[],
  ): Promise<ProjectKnowledge>;
  /** Saves pasted text as a file in the project. */
  addProjectKnowledgeText(
    projectId: string,
    file: { name: string; text: string },
  ): Promise<ProjectKnowledge>;
  removeProjectKnowledge(
    projectId: string,
    name: string | string[],
  ): Promise<ProjectKnowledge>;

  /** A skill the runtime lists: its instructions and the files in its folder. */
  readSkill(path: string): Promise<SkillContents>;
  /** One file of a listed skill's folder, as text (the Contents tab). */
  readSkillFile(path: string, file: string): Promise<SkillFile>;

  /** The account's design systems, newest first. */
  listDesignSystems(): Promise<DesignSystem[]>;
  /** Creates a design system (no `id`) or changes one; the name is required. */
  saveDesignSystem(input: DesignSystemInput): Promise<DesignSystem>;
  deleteDesignSystem(id: string): Promise<void>;
  /**
   * Has the account's model write the guidelines from the description, notes
   * and example files, replacing any it had.
   */
  generateDesignSystem(id: string): Promise<DesignSystem>;

  /**
   * The plugins in the marketplaces the agent runtime has synced, and which
   * are installed. Refused while no connection can start the runtime.
   */
  listPlugins(): Promise<PluginCatalog>;
  /** Chunked archive transfer; staging and installs belong to this account. */
  uploadPlugin(
    input: import("./plugin-upload").PluginUploadCommand,
  ): Promise<import("./plugin-upload").PluginUploadResult>;
  readPlugin(id: string): Promise<PluginDetails>;
  /** Installs from its marketplace; its skills and servers apply to new turns. */
  installPlugin(id: string): Promise<PluginInstallResult>;
  uninstallPlugin(id: string): Promise<void>;
  /** A GitHub `owner/repo` or an https Git address; the runtime clones it. */
  addPluginMarketplace(source: string): Promise<void>;
  removePluginMarketplace(name: string): Promise<void>;
  /** Fetches every marketplace's latest listing. */
  upgradePluginMarketplaces(name?: string): Promise<void>;
  setPluginMarketplaceAutoSync(name: string, enabled: boolean): Promise<void>;
  /**
   * Duplicate plugin: copies a plugin whose files are on this computer into the
   * personal marketplace (~/plugins and ~/.agents/plugins/marketplace.json, the
   * agent runtime's own convention) as `copy.name`, then installs the copy. A
   * taken name is refused with `pluginNameTaken`. Desktop only.
   */
  duplicatePlugin(
    id: string,
    copy: PluginCopy,
  ): Promise<PluginInstallResult & { id: string }>;
  /**
   * Rename plugin: for a plugin of the personal marketplace
   * (`PluginEntry.personal`). Its files take the new name or display name; an
   * installed one is installed again under its new id and keeps its settings
   * and on/off state. Answers the new id. Refusals use the live wording
   * (`pluginNameTaken`, `renameSameName`, `pluginGone`). Desktop only.
   */
  renamePlugin(
    id: string,
    to: PluginCopy,
  ): Promise<PluginInstallResult & { id: string }>;
}

/** The copy Duplicate plugin makes: its name and, when typed, its display name. */
export interface PluginCopy {
  /** Lower case, digits and hyphens (`pluginSlug` of what was typed). */
  name: string;
  displayName?: string;
}

export const collectionsMethods = bridgeMethods<CollectionsAPI>({
  customizeSearch: true,
  customizeSkills: true,
  listSchedules: true,
  querySchedules: true,
  readSchedule: true,
  routineCapabilities: true,
  routineBrowserPermissions: true,
  clearRoutineBrowserPermissions: true,
  routineWorkspace: true,
  routineMigration: true,
  migrateRoutine: true,
  beginRoutineMigration: true,
  restoreRoutineMigration: true,
  importRoutineMigration: true,
  deleteRoutineMigration: true,
  saveSchedule: true,
  deleteSchedule: true,
  runSchedule: true,
  routineApiToken: true,
  routineRuns: true,
  routineRunsPage: true,
  routineSchedulePreview: true,
  removeRoutineApproval: true,
  markRoutineRunRead: true,
  securityFindings: true,
  triageSecurityFinding: true,
  proposeScheduledTask: true,
  listConversationGroups: true,
  createConversationGroup: true,
  moveConversationToGroup: true,
  renameConversationGroup: true,
  deleteConversationGroup: true,
  listProjectKnowledge: true,
  stageProjectKnowledgeFiles: true,
  previewProjectKnowledgeEncoding: true,
  confirmProjectKnowledgeEncoding: true,
  removeProjectKnowledgePending: true,
  readProjectKnowledge: true,
  listProjectKnowledgeRepositories: true,
  listProjectKnowledgeRepositoryFiles: true,
  addProjectKnowledgeRepositoryFiles: true,
  syncProjectKnowledge: true,
  listProjectKnowledgeMcpServers: true,
  listProjectKnowledgeMcpResources: true,
  resolveProjectKnowledgeMcpUrl: true,
  addProjectKnowledgeMcpResource: true,
  listProjectKnowledgeDriveConnectors: true,
  searchProjectKnowledgeDrive: true,
  addProjectKnowledgeDriveFiles: true,
  addProjectKnowledge: true,
  addProjectKnowledgeFiles: true,
  addProjectKnowledgeText: true,
  removeProjectKnowledge: true,
  readSkill: true,
  readSkillFile: true,
  listDesignSystems: true,
  saveDesignSystem: true,
  deleteDesignSystem: true,
  generateDesignSystem: true,
  listPlugins: true,
  uploadPlugin: true,
  listDirectorySubmissions: true,
  listApprovedDirectory: true,
  saveDirectorySubmission: true,
  deleteDirectorySubmission: true,
  verifyDirectorySubmissionTools: true,
  readPlugin: true,
  installPlugin: true,
  uninstallPlugin: true,
  addPluginMarketplace: true,
  removePluginMarketplace: true,
  upgradePluginMarketplaces: true,
  setPluginMarketplaceAutoSync: true,
  duplicatePlugin: true,
  renamePlugin: true,
});
