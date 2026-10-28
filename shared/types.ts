import type { PrivacyDataAPI } from "./privacy-data-api";
import type { DesktopExtensionsAPI } from "./desktop-extensions-api";
import type { DeepLink } from "./deep-links";
import type { DispatchAPI } from "./dispatch-api";
import type { CodeEmailAPI } from "./code-email-api";
import type { SettingsPreferences } from "./settings-extras";
import type { AgentMessageOrigin } from "./agent-messages";
import type { ProjectTools } from "./project-tools";
import type { SettingsAccountAPI } from "./settings-api";
import type {
  SettingsDesktopAPI,
  StorageCleanupEvent,
} from "./settings-desktop-api";
import type { ClientPolicy } from "./client-policy";
import type { PolicyAPI } from "./policy-api";
import type { UsageAPI, WeeklyUsageStatus } from "./usage-api";
import type { BillingAPI, BillingOrderStatus } from "./billing-api";
import type { ModelCatalogAPI } from "./model-catalog-api";
import type { VoiceAPI } from "./voice-api";
import type { DiagnosticsAPI } from "./diagnostics-api";
import type { EditCommandsAPI } from "./edit-commands-api";
import type { SupportBundleAPI } from "./support-bundle-api";
import type { OfficeAddinAPI, OfficeConnectedFile } from "./office-addin-api";
import type { CodeUsageAPI } from "./code-usage-api";
import type { ComposerAPI } from "./composer-api";
import type { AgentAPI } from "./agent-api";
import type { PanelsAPI } from "./panels-api";
import type { ArtifactsAPI } from "./artifacts-api";
import type { CollectionsAPI } from "./collections-api";
import type { ExternalLinksAPI } from "./external-links-api";
import type { SharingAPI, SharingEvent } from "./sharing-api";
import type {
  ConversationWindowClosedEvent,
  WindowsAPI,
  WindowVisibilityEvent,
} from "./windows-api";
import type { QuickEntryEvent } from "./quick-entry";
import type { MemoryAPI, MemoryChangedEvent } from "./memory-api";
import type {
  Citation,
  ResearchAPI,
  ResearchEvent,
  ResearchState,
  WebSource,
} from "./research-api";
import type { FaviconAPI } from "./favicon-api";
import type { SshAPI, SshEvent } from "./ssh-api";
import type { ComputerUseAPI, ComputerUseEvent } from "./computer-use-api";
import type { SimulatorsAPI } from "./simulators-api";
import type { CoworkAPI, CoworkFoldersEvent } from "./cowork-api";
import type { DeviceTrustAPI } from "./remote-devices";
import type {
  WorkspaceTrustAPI,
  WorkspaceTrustEvent,
} from "./workspace-trust-api";
import type { AppUpdateAPI, AppUpdateEvent } from "./app-update-api";
import type { BrowserAccounts, SignInAPI } from "./sign-in-api";
import type { ApiKeysAPI } from "./api-keys-api";
import type { AnnouncementsAPI } from "./announcements-api";
import type { AccountProfileAPI } from "./account-profile-api";
import type { OnboardingAPI } from "./onboarding-api";
import type { CloudSyncAPI } from "./cloud-sync-api";
import type {
  ChatDevicesAPI,
  ChatDeviceBinding,
  ChatDeviceOrigin,
} from "./chat-devices-api";
import type { CloudEnvironmentsAPI } from "./cloud-environments-api";
import type { EditorInfo, EditorKind } from "./editors";
import type { CloudContinueAPI } from "./cloud-continue-api";
import type { PullRequestAutoFix } from "./pr-autofix";
import type { UsageStatsAPI } from "./usage-stats-api";
import type { ServiceStatusAPI } from "./service-status-api";
import type { GitHubAPI } from "./github-api";
import type { LinearAPI } from "./linear-api";
import type { CloudSessionInfo, HostInfo, RepositoryRef } from "./host";
import type { SessionSetup } from "./session-setup";
// Usage types live in shared/usage-api.ts (package C4); re-exported for older imports.
export type {
  LimitReason,
  PlanUsage,
  PlanUsageWindow,
  WeeklyUsageStatus,
} from "./usage-api";
export type Mode = "chat" | "cowork" | "code";
export type Protocol = "responses" | "chat";
export type Theme = "light" | "dark" | "system";
export type CodeEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type ChatEffort = Exclude<CodeEffort, "ultra">;
export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  protocol: Protocol;
  model: string;
  models: string[];
  transcriptionModel?: string;
  hasApiKey?: boolean;
  /** Set when the models come from the operator's Sub2API service. */
  backend?: "sub2api";
  /**
   * The service groups this account's models come from when there are
   * several (MG): each model goes out with its group's device key and
   * protocol. Absent for a single group, which uses `protocol` and the
   * provider's own key. Holds no key, only where the key is kept.
   */
  routes?: ProviderRoute[];
}
/** One service group of a Sub2API account with several groups (MG). */
export interface ProviderRoute {
  groupId: number;
  groupName: string;
  protocol: Protocol;
  /** The key vault entry of this group's device key (the provider id for the plan group). */
  keyId: string;
  /** The plan group: its key is the provider's own. */
  primary: boolean;
  /** The models this group serves, as the gateway listed them for its key. */
  models: string[];
}
export interface Settings extends SettingsPreferences {
  theme: Theme;
  sidebarWidth: number;
  name: string;
  providers: Provider[];
  activeProviderId: string;
  effort: ChatEffort;
  codeEffort: CodeEffort;
  sandbox: "read-only" | "workspace-write";
  /** Code's sandbox; full access is Bypass permissions (Codex "Full access"). */
  codeSandbox: CodeSandbox;
  /** Folders where the user confirmed bypassing permissions. */
  bypassFolders?: string[];
  autoAcceptEdits: boolean;
  codePlanMode: boolean;
  instructions: string;
  mcpServers: Record<string, unknown>;
  /** Typeface for chat replies; the reference fonts need a local Claude installation. */
  chatFont?: ChatFont;
  /** "reduced" turns interface motion off regardless of the system setting. */
  motion?: "system" | "reduced";
  /** Monospace family tried before the built-in stack for code and terminals. */
  codeFont?: string;
  /** Sidebar navigation rows moved into More with Edit sidebar…. */
  hiddenNavItems?: string[];
}
export type ChatFont = "serif" | "sans" | "system" | "dyslexia";
export type CodeSandbox =
  "read-only" | "workspace-write" | "danger-full-access";
/** Window commands reachable from the keyboard and the application menu. */
export type AppCommand =
  | "new-chat"
  | "incognito"
  /** ⌘K: opens the search palette, or closes it when it is open. */
  | "search"
  /** ⇧⌘K (Go ▸ Search…): opens the search palette on its Search view. */
  | "search-palette"
  /** Go ▸ an area: a new conversation on the sidebar's Chat or Code surface. */
  | "area-chat"
  | "area-code"
  /** The Dock menu's New Code Session ▸ a recent folder (with `folder`). */
  | "new-code-session-in"
  | "settings"
  | "customize-skills"
  | "scheduled-tasks"
  | "toggle-sidebar"
  | "shortcuts"
  | "back"
  | "forward"
  /** Go ▸ Previous and Next Chat, Task or Session: the neighbour in the sidebar's list. */
  | "previous-session"
  | "next-session"
  /** File ▸ Open Folder…: a new Code session in the folder that is chosen. */
  | "open-folder"
  /** File ▸ Open File…: a file chosen on this computer opens in the file viewer. */
  | "open-file"
  /** File ▸ Reopen Closed Session: the conversation or window closed last. */
  | "reopen-closed-session"
  /** View ▸ Terminal, Changes and Browser: the Code panes of the open session. */
  | "toggle-terminal"
  /** Ctrl+B: the Background tasks panel. */
  | "toggle-background"
  | "toggle-changes"
  | "toggle-browser"
  /** View ▸ Files (⇧⌘F): the Files pane of the open Code session. */
  | "toggle-files"
  | "find-in-files"
  | "close-context"
  /** View ▸ Side Chat (⌘;): the open conversation's side chat. */
  | "toggle-side-chat"
  /** View ▸ Close Pane: the file viewer, or the pane opened last. */
  | "close-pane"
  /** ⇧⌘\: the focused Code pane grows over the conversation, or back. */
  | "toggle-expand-pane"
  /** ⇧⌘S: the Browser's Select element starts, or stops. */
  | "browser-select-element"
  /** ⇧⌘X: sketch mode on the Browser's page starts, or asks to end. */
  | "browser-sketch"
  /** View ▸ Split View: a new session beside or below the focused pane. */
  | "split-new-right"
  | "split-new-below"
  /** Split View: the focus moves to the next or previous pane, or the neighbour in a direction. */
  | "split-focus-next"
  | "split-focus-previous"
  | "split-focus-left"
  | "split-focus-right"
  | "split-focus-up"
  | "split-focus-down"
  /** Split View ▸ Move: the focused pane takes the next cell in a direction. */
  | "split-move-left"
  | "split-move-right"
  | "split-move-up"
  | "split-move-down"
  /** Split View ▸ Close Split View: the focused pane. */
  | "split-close"
  /** The Browser pane's own keys (a new tab, the address bar, tab by number). */
  | "new-browser-tab"
  | "browser-focus-address"
  | "browser-next-tab"
  | "browser-previous-tab"
  | "browser-tab-1"
  | "browser-tab-2"
  | "browser-tab-3"
  | "browser-tab-4"
  | "browser-tab-5"
  | "browser-tab-6"
  | "browser-tab-7"
  | "browser-tab-8"
  | "browser-tab-9"
  /** Opens the conversation the command event names (a separate window's Return). */
  | "open-conversation";
/**
 * Where a Code conversation, project or routine runs: this computer, or a
 * host the person added under SSH connections (R9). Missing means local.
 */
export type EnvironmentRef =
  | { kind: "local" }
  | { kind: "ssh"; hostId: string }
  /**
   * An isolated space on the cloud runner (docs/cloud-sync.md): its own
   * sandbox, workspace and Codex home; one per Chat or Cowork conversation
   * and per GitHub repository. Set by the runner, never by a window.
   */
  | { kind: "space"; spaceId: string };

/** Runs on the machine that holds the conversation's files (not an SSH host). */
export const onThisMachine = (environment?: EnvironmentRef) =>
  !environment || environment.kind !== "ssh";
export interface Attachment {
  github?: import("./chat-github").ChatGitHubLink;
  id: string;
  name: string;
  path: string;
  kind: "image" | "text" | "document";
  size: number;
}
export interface GeneratedFile {
  capturedAt?: number;
  previousPath?: string;
  id: string;
  name: string;
  path: string;
  language: string;
  operation: "create" | "update" | "delete";
  state: "ready" | "unavailable" | "deleted";
  content?: string;
  digest?: string;
  bytes?: number;
  error?: string;
  /** Binary snapshot kept in the profile under its digest (images, PDF, Office). */
  blob?: boolean;
  mime?: string;
  /**
   * The file is past what a snapshot keeps (one file's limit or the turn's
   * budget): no content, no digest, `bytes` its size when known. The viewer
   * says so instead of an error line.
   */
  tooLarge?: boolean;
}
/** A cloud Code session's main repository (shared/session-git.ts). */
export interface SessionRepository {
  /** "owner/name" as the address spells it. */
  fullName: string;
  url: string;
}
/** The folder's git state a cloud Code session last reported. */
export interface SessionGitState {
  /** Uncommitted or untracked changes. */
  dirty: boolean;
  /** Commits on the branch the remote does not have. */
  unpushed: boolean;
  /**
   * The last commit the session's GitHub push tool sent, with the local
   * branch it came from. The folder's own remote-tracking refs do not move
   * when the runner pushes from outside the sandbox, so this is how a pushed
   * branch reads as pushed.
   */
  pushed?: { branch: string; sha: string };
  /** When the runner read it (ms since the epoch). */
  checkedAt: number;
}
/** The state of a pull request on GitHub, as the runner last read it. */
export type SessionPullRequestState =
  "open" | "draft" | "queued" | "merged" | "closed";
/** A pull request a cloud Code session opened. */
export interface SessionPullRequest {
  /** "owner/name" */
  repository: string;
  number: number;
  url: string;
  title?: string;
  /** The branch it was opened from. */
  headRef?: string;
  state: SessionPullRequestState;
  /** When the runner last read its state (ms since the epoch). */
  checkedAt: number;
}
/** A Code session's own worktree (electron/code-worktree.ts). */
export interface SessionWorktree {
  /** The worktree's top folder. */
  path: string;
  branch: string;
  /** The repository's main checkout it was added to. */
  repository: string;
  /** The folder the session was started from. */
  origin: string;
  name: string;
}
export interface Item {
  display_content?: import("./message-resources").ToolDisplayContent;
  resource_links?: Omit<
    import("./message-resources").McpResourceLink,
    "type"
  >[];
  origin?: AgentMessageOrigin;
  generatedFiles?: GeneratedFile[];
  id: string;
  type: string;
  text?: string;
  content?: any[];
  summary?: string[];
  display_group?: {
    id: string;
    is_complete?: boolean;
    summary?: string;
    run?: {
      anchor_id: string;
      state: "working" | "settled" | "cancelled" | "failed";
      summary?: string;
      summary_source?: string;
      summary_language?: string;
      status_text?: string;
      status_text_lead?: string;
    };
  };
  command?: string;
  cwd?: string;
  status?: string;
  lifecycleStatus?: "inProgress" | "completed" | "failed" | "interrupted";
  aggregatedOutput?: string;
  changes?: { path: string; kind: any; diff: string }[];
  tool?: string;
  progress?: string;
  server?: string;
  result?: any;
  error?: any;
  /** What the model said a command does, from the tool call (R7). */
  description?: string;
  /** Pages a web search returned (R5). */
  sources?: WebSource[];
  /** Which built-in search produced `sources`. */
  searchTool?: "web_search" | "x_search";
  /** Spans of this message that cite a page (R5). */
  citations?: Citation[];
  [key: string]: any;
}
export interface Turn {
  /** Permission snapshot for an executing Code turn; later UI changes wait. */
  codePermissionMode?: import("./code-session-permissions").CodePermissionMode;
  capabilityTip?: {
    feature: import("./chat-suggestions").CapabilityTip;
    tier: 1 | 2;
  };
  notificationTrigger?: "ci-monitor";
  /** Stable CI event receipt, recorded before dispatch for acknowledgement recovery. */
  notificationKey?: string;
  postTurnSummary?: { is_noteworthy: boolean };
  coworkInstructions?: { global?: string; folder?: string };
  id: string;
  /**
   * The model this turn moved to after the one before was flagged by
   * safeguards (Capabilities / Claude Code → Switch models when a message
   * is flagged).
   */
  switchedTo?: string;
  /** A new session's worktree is being made (electron/code-worktree.ts). */
  worktreeStep?: "creating";
  responseGroupId?: string;
  promptGroupId?: string;
  promptVersionId?: string;
  prompt: string;
  attachments: Attachment[];
  items: Item[];
  status: "inProgress" | "completed" | "failed" | "interrupted";
  error?: string;
  /** The verbatim prompt parts sent to the model, when the host provides them. */
  rawOriginals?: string[];
  sendFailed?: boolean;
  /**
   * Why a turn ended early when that changes what the transcript offers:
   * "length" or "tool_use_limit" hit a turn limit (Continue),
   * "conversation_length_limit" filled a Chat, or "restart" was running
   * when the app closed.
   */
  stopReason?:
    | "length"
    | "tool_use_limit"
    | "conversation_length_limit"
    | "restart"
    | "usage_limit";
  usageHold?: { resetsAt: number | null };
  /** Codex's retry progress ("2/5") while it reconnects a dropped stream. */
  reconnecting?: string;
  /** What the retried failure was ("Rate limit reached. Retrying …"). */
  reconnectCause?: import("./turn-errors").RetryCause;
  createdAt: number;
  /** Output tokens generated in this turn (Code status line). */
  outputTokens?: number;
  outputTokenBase?: number;
  /** Uncached input tokens sent in this turn (Code usage statistics). */
  inputTokens?: number;
  inputTokenBase?: number;
  /** A Research turn's plan, progress and report (R4). */
  research?: ResearchState;
  /** A cloud Code session's start, in its first turn (shared/session-setup.ts). */
  setup?: SessionSetup;
}
export interface ConversationBranch {
  id: string;
  threadId?: string;
  turns: Turn[];
  providerId: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  visited: number;
}
/** Where a forked conversation came from (Fork session, Fork from here). */
export interface ConversationForkSource {
  conversationId: string;
  /** The source's last turn the fork kept. */
  turnId: string;
  title: string;
}
/**
 * Rewind to here: the turns a rewind set aside with the thread that held them,
 * so Undo rewind can bring them back (and Redo rewind set them aside again)
 * until the next message is sent. "pending" offers Undo rewind; "forward"
 * (after an undo) offers Redo.
 */
export interface ConversationRewind {
  variant: "pending" | "forward";
  /** How many turns stayed: the marker sits after them. */
  index: number;
  /** The thread holding the other side of the swap (none: a fresh start). */
  threadId?: string;
  turns: Turn[];
  at: number;
}
/** Where a handed-off session came from (Hand off to a new session). */
export interface ConversationHandOffSource {
  conversationId: string;
  /** The source's last turn when the note was written. */
  turnId: string;
  title: string;
}
/** A session this one was handed off to, shown under the turn it was handed off after. */
export interface ConversationHandOffRecord {
  conversationId: string;
  turnId: string;
  createdAt: number;
}
/** A conversation forked from this one, shown at the turn it was forked after. */
export interface ConversationForkRecord {
  conversationId: string;
  turnId: string;
  createdAt: number;
}
export interface Conversation {
  scheduledTaskSetup?: import("./scheduled-task-setup").ScheduledTaskSetupState;
  /** A genuine editable file paired with this idle/new Chat; no synthetic turn. */
  blankArtifact?: import("./blank-artifacts").BlankArtifact;
  artifactOutputKind?: import("./artifact-output").ArtifactOutputKind;
  backgroundTaskSuggestions?: import("./task-backlog").BackgroundTaskSuggestion[];
  importedCliSessionId?: string;
  importedHistory?: boolean;
  classifySessionStates?: boolean;
  sessionState?: "blocked" | "ready_for_review" | "done";
  promptSuggestion?: { turnId: string; text: string };
  capabilityTipChecked?: string;
  capabilityTipChecks?: number;
  sessionAuthors?: { viewerAccountUuid: string; ownerAccountUuid: string };
  effort?: CodeEffort;
  activeBranchId?: string;
  branchVisit?: number;
  savedBranches?: ConversationBranch[];
  id: string;
  threadId?: string;
  title: string;
  mode: Mode;
  webSearch?: boolean;
  connectorOverrides?: Record<string, boolean>;
  connectorToolOverrides?: import("./conversation-tools").ConversationToolOverrides;
  /** Connectors → Tool access for this conversation (shared/tool-search-mode.ts). */
  toolSearchMode?: import("./tool-search-mode").ToolSearchMode;
  projectId?: string;
  cwd?: string;
  additionalFolders?: string[];
  providerId: string;
  model: string;
  /** Code session goal and the number of completed turns checked against it. */
  goal?: {
    condition: string;
    setAt: number;
    iterations: number;
    lastReason?: string;
  };
  /** Output style applied from the next Code turn. */
  outputStyle?: string;
  /** Custom output styles saved for this session. */
  customOutputStyles?: Record<string, { name: string; prompt: string }>;
  pinned: boolean;
  /**
   * The session rail's Remote Control switch turned off for this session:
   * the account's phones don't list or open it, even with Control from your
   * phone on (electron/remote-control/device-methods.ts).
   */
  remoteControlOff?: boolean;
  /** Code permission choice for this session; account defaults remain independent. */
  codePermissionMode?: import("./code-session-permissions").CodePermissionMode;
  /** Monotonic permission revision; older acknowledgements do not replace newer events. */
  codePermissionRevision?: number;
  /**
   * Keep computer awake, only for this session (the session menu's switch,
   * the original's manualKeepAwake): while it is on, this computer does not
   * sleep, whether or not the session is working. Archiving turns it off.
   */
  keepAwake?: boolean;
  keptAwake?: { heldMs: number; endedAt: number };
  /**
   * A local Code session started with Worktree on runs in its own worktree
   * (electron/code-worktree.ts): `cwd` is inside it, `worktree.origin` is
   * the folder it was started from. `state` says what became of it after
   * the session was archived or deleted.
   */
  worktree?: SessionWorktree & { state?: "kept" | "deleted" };
  sidebarRank?: number;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  turns: Turn[];
  /**
   * The web snapshot cut its commands' long texts (shared/conversation-slim.ts);
   * `conversationTurns` gives the full turns, and the next full "conversation"
   * event replaces it whole.
   */
  slim?: boolean;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** Incognito chats live only in memory on an ephemeral Codex thread. */
  incognito?: boolean;
  /**
   * A scheduled task's run follows its saved permission, independently of the
   * home's mode. New routines ask; legacy runs without a saved mode retain full
   * access.
   */
  scheduledRun?: boolean;
  /**
   * The routine that started a scheduled run and the permission mode it was
   * saved with: Manual and Auto runs work in their folder and ask; a run
   * without a mode keeps full access. A follow-up in the run's conversation
   * keeps both.
   */
  scheduledTaskId?: string;
  linkedToComputer?: boolean;
  linkedComputerId?: string;
  linkedComputerName?: string;
  linkedComputerOnline?: boolean;
  linkedComputerAccess?: boolean;
  /** Confirmed V1 Chat routing; distinct from the legacy fixed Cowork link. */
  chatDeviceBinding?: ChatDeviceBinding;
  chatDeviceError?: string;
  /** Monotonic even when a device is cancelled, so late old polls cannot rebind. */
  chatDeviceRevision?: number;
  /** Device-local execution identity; never used as a cloud binding. */
  deviceChatOrigin?: ChatDeviceOrigin;
  /**
   * A cloud Chat's permission mode as the computer that sent its last
   * prompt chose it; without one the account's own setting applies.
   */
  senderPermission?: "default" | "auto" | "bypass";
  scheduledPermission?: "default" | "auto" | "bypass";
  /**
   * A task started from a prompt that came from outside Claudex (an address or
   * an artifact's prompt link, in a quick task window): it asks before using
   * new tools whatever the permission mode.
   */
  asksFirst?: boolean;
  /**
   * A local Code session started with Settings → Local sandbox off: its
   * commands run outside Codex's sandbox and every untrusted one asks first
   * (shared/sandbox-policy.ts codeTurnPermissions).
   */
  localSandboxOff?: true;
  /**
   * Started with Strict sandbox mode on: commands that can't run inside the
   * sandbox are refused, never run outside it or asked about.
   */
  strictSandbox?: true;
  /** Auto-fix for the session's pull request (shared/pr-autofix.ts). */
  prAutoFix?: PullRequestAutoFix;
  /**
   * Auto-archive for this session's pull request, when Claude set it
   * (set_pr_monitor); the window keeps the person's own choice itself.
   */
  prAutoArchive?: boolean;
  /**
   * A cloud Code session opens a pull request after a push without asking,
   * ready for review or as a draft (the sender's settings, last message).
   */
  autoPullRequest?: "ready" | "draft";
  /**
   * A cloud Code session whose repository is not in its folder yet (its
   * start failed or was stopped): its next message fetches it first.
   */
  pendingSetup?: RepositoryRef[];
  pendingSetupScript?: string;
  /**
   * Every repository of a cloud Code session with more than one, the main
   * one first; the others are folders inside its folder. Set by the runner
   * when the session starts (never by a window); the runner's GitHub tools
   * act on the others by name (runner/src/github-tools.ts).
   */
  sessionRepositories?: RepositoryRef[];
  /**
   * A cloud Code session's main repository, for lists and search ("owner/name"
   * and its address). Set when the session starts (never by a window).
   */
  repository?: SessionRepository;
  cloudEnvironmentId?: string;
  /**
   * The branch a cloud Code session works on, as the runner last read it from
   * the sandbox's folder (after each turn and each push). Missing until the
   * first read, and for a detached HEAD.
   */
  branch?: string;
  /**
   * What the runner last saw of the folder's git state (after each turn):
   * uncommitted changes and commits not on the remote. Only the runner
   * writes it (shared/session-git.ts).
   */
  gitState?: SessionGitState;
  /**
   * The pull requests the session opened with its GitHub tools, oldest first,
   * with the state the runner last read from GitHub.
   */
  pullRequests?: SessionPullRequest[];
  /** A reply finished while the chat was not shown, or Mark as unread. */
  unread?: boolean;
  /** Research mode is on for this Chat (R4). */
  research?: boolean;
  /** Where a Code conversation runs; missing means this computer (R9). */
  environment?: EnvironmentRef;
  /** Set on a conversation forked from another one. */
  forkedFrom?: ConversationForkSource;
  /** The session this session is nested under in the sidebar. */
  parentSessionId?: string;
  codeNewTask?: {
    id: string;
    text: string;
    attachments: Attachment[];
    providerId: string;
    model: string;
    effort?: CodeEffort;
  };
  /** Whether this session's nested sessions are hidden in the sidebar. */
  nestedSessionsHidden?: boolean;
  /**
   * The conversation lives in the cloud (the desktop's merged list): its
   * tools never run on this computer, so it has no Browser or terminal
   * here. Set by the desktop's cloud router, never stored.
   */
  cloudHosted?: boolean;
  /** Suppresses generated title offers for this session. */
  titleOffersSuppressed?: boolean;
  /**
   * The person named the session: a title that no longer fits is then
   * offered, not changed (a generated one is replaced as the work moves on).
   */
  titleSetByUser?: boolean;
  /** A host-generated title proposal. */
  titleOffer?: import("./title-offers").TitleOffer;
  titleOfferCheckedTurnId?: string;
  /** Set when the session was marked complete from its row menu. */
  completedAt?: number;
  /** Set after the runner was released; the next message may use another runner. */
  runnerReleasedAt?: number;
  /** The conversations forked from this one. */
  forks?: ConversationForkRecord[];
  /** Set on a session that started from another one's handoff note. */
  handedOffFrom?: ConversationHandOffSource;
  /** The sessions this one was handed off to. */
  handOffs?: ConversationHandOffRecord[];
  /** The last rewind, while it can still be undone or redone. */
  rewind?: ConversationRewind;
}
export interface Project {
  /** Host-written receipt for safe retries of initial context creation. */
  creationReceipt?: { operationId: string; digest: string };
  /** Host-owned access; renderer updates cannot change these capabilities. */
  capabilities?: import("./project-access").ProjectCapabilities;
  id: string;
  /** Persisted access metadata. Current stores create account-private projects.
   * Unknown/future values are preserved; only explicit "private" labels the UI. */
  visibility?: unknown;
  kind?: "chat" | "local" | "code";
  name: string;
  description: string;
  instructions: string;
  tools?: ProjectTools;
  cwd?: string;
  /**
   * The project's other folders on this computer, after `cwd` (the first
   * one); a project has up to 16 in all (shared/project-folders.ts).
   */
  additionalFolders?: string[];
  createdAt: number;
  /** Where the project's Code conversations run; missing means this computer (R9). */
  environment?: EnvironmentRef;
  /** Pinned projects lead the Projects list. */
  pinned?: boolean;
  icon?: string;
  color?: string;
  defaultModel?: string;
  defaultProviderId?: string;
  defaultEffort?: ChatEffort;
  isStarterProject?: boolean;
  /** Archived projects leave the list for its Archived tab. */
  archivedAt?: number;
}
export type ScheduleFrequency = "hourly" | "daily" | "weekly";
export interface ScheduleInput {
  id?: string;
  name: string;
  prompt: string;
  mode: "code" | "cowork";
  cwd?: string;
  /** The project the routine is listed under on the project's page. */
  projectId?: string;
  providerId: string;
  model: string;
  frequency: ScheduleFrequency;
  nextRunAt: number;
  enabled: boolean;
  /** Where the routine runs; missing means this computer (R9). */
  environment?: EnvironmentRef;
}
export interface Schedule extends ScheduleInput {
  id: string;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastRunStatus?:
    "starting" | "running" | "completed" | "failed" | "interrupted";
  lastError?: string;
  conversationId?: string;
}
export interface Approval {
  id: string | number;
  conversationId: string;
  method: string;
  params: any;
}
export interface SavedArtifact {
  libraryId: string;
  sharedArtifactToken?: string;
  name: string;
  language: string;
  content: string;
  createdAt: number;
  originConversationId?: string;
}
export interface ArtifactLibraryState {
  version: 1;
  copies: SavedArtifact[];
  pinned: string[];
}
export interface Snapshot {
  artifactLibrary: ArtifactLibraryState;
  dismissedBackgroundTasks: string[];
  artifactShares: ArtifactShareInfo[];
  settings: Settings;
  conversations: Conversation[];
  projects: Project[];
  /** Optional partial-cloud read state; absent on legacy/local snapshots.
   * cached means a successful cloud catalogue exists, even when empty. */
  projectCatalog?: { status: "ready" | "failed"; cached: boolean };
  engine: {
    state: "stopped" | "ready" | "starting" | "error";
    version?: string;
    error?: string;
  };
  approvals: Approval[];
  platform: string;
  replyFeedback: Record<string, "up" | "down">;
  /** Why no model can be used (a Sub2API balance, plan or key problem), in plain English. */
  modelUnavailable?: string;
  /**
   * What this host can do (shared/host.ts). The desktop leaves it out: a
   * missing host is the build surface's default (`resolveHost`).
   */
  host?: HostInfo;
  /** The account's cloud sandboxes (web only; see the "cloud-session" event). */
  cloudSessions?: CloudSessionInfo[];
}
export interface PublicAccount {
  id: string;
  email: string;
  name: string;
  legacyArtifactOwner?: boolean;
  /** The Sub2API plan (subscription group) name, when the service assigns one. */
  plan?: string;
  /** Signed in through the operator's Sub2API service. */
  remote?: boolean;
}
/** What the Sub2API service allows on the sign-in screen. */
export interface RemoteSignInPolicy {
  siteName: string;
  registrationEnabled: boolean;
  /** Registration needs a code sent to the email address. */
  emailVerification: boolean;
  /** Registration needs an invitation code. */
  invitationCode: boolean;
  /** Registration accepts an optional promo code. */
  promoCode: boolean;
  /** The service asks for a captcha this app cannot show. */
  captchaRequired: boolean;
  /** Registration is limited to these email domains (empty: any). */
  emailDomains: string[];
  /** The public settings could not be read. */
  unavailable?: string;
  /** "Forgot password?" is offered (Sub2API `password_reset_enabled`). */
  passwordReset?: boolean;
  /**
   * Signing in with a code sent by email is offered: the administrator
   * turned it on and the service can send email (Claudex extension).
   */
  emailCodeLogin?: boolean;
  /** Passkey sign-in is offered (web only: the browser runs the ceremony). */
  passkey?: boolean;
  /**
   * Continue with Google is offered (LOGIN-GOOGLE): the web button's client
   * id on the web, the desktop client's on the desktop.
   */
  googleClientId?: string;
  /** The privacy policy the sign-in small print links to. */
  privacyPolicyUrl?: string;
  /** Backend mode: only administrators may sign in. */
  backendMode?: boolean;
}
export interface RegisterExtras {
  verifyCode?: string;
  invitationCode?: string;
  promoCode?: string;
}
/** Sign-in paused for an authenticator code; the challenge stays in the main process. */
export interface TwoFactorChallenge {
  twoFactorRequired: true;
  maskedEmail: string;
}
export interface AuthStatus {
  serviceOrigin?: string;
  /** False on a desktop with no service chosen yet: sign-in asks for its address. */
  serviceConfigured?: boolean;
  account?: PublicAccount;
  hasAccounts: boolean;
  remote?: RemoteSignInPolicy;
  /** A password was accepted and an authenticator code is awaited. */
  twoFactorPending?: boolean;
  /**
   * Signed out on the web: the accounts used in this browser (the sign-in
   * page's "Choose an account") and whether an account is being added.
   */
  browserAccounts?: BrowserAccounts;
}
export interface UsageRecord {
  id: string;
  at: number;
  providerId: string;
  model: string;
  protocol: "chat" | "responses";
  durationMs: number;
  statusCode: number;
  usageKnown: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}
export interface UsageTotals {
  requests: number;
  successful: number;
  failed: number;
  unmetered: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}
export type UsageRange = "all" | "30d" | "7d";
export interface UsageDaily {
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}
export interface UsageHour {
  hour: number;
  requests: number;
}
export interface UsageSummary {
  range: UsageRange;
  total: UsageTotals;
  models: Array<UsageTotals & { providerId: string; model: string }>;
  daily: UsageDaily[];
  hours: UsageHour[];
}
export interface AgentTranscript {
  truncated?: boolean;
  model: string;
  context: string;
  items: Item[];
  status: "running" | "completed" | "failed" | "stopped";
  toolUses: number;
  currentAction?: string;
}
export interface BackgroundTerminalInfo {
  conversationId: string;
  itemId: string;
  processId: string;
  command: string;
  cwd: string;
}
/**
 * What the Changes panel compares: the branch's changes since it left a base
 * branch (`base`, else the repository's default), only what isn't committed, or
 * one commit of the branch. `base` also picks the commits listed.
 */
export type DiffScope =
  | { kind: "branch"; base?: string }
  | { kind: "uncommitted"; base?: string }
  | { kind: "commit"; sha: string; base?: string };
/** A commit of the branch that its base lacks (`git log base..HEAD`). */
export interface GitCommit {
  sha: string;
  shortSha: string;
  /** The first line of its message; empty when it has none. */
  subject: string;
  /** Its author's name. */
  author?: string;
  /** When it was committed (ms since the epoch). */
  at?: number;
}
/** A Code folder's changes for the Changes panel, untracked files included. */
export interface WorkingTreeChanges {
  state: "ready" | "not-git" | "no-folder";
  /** Branch (or short commit) the working tree is compared with. */
  base?: string;
  diff: string;
  /** Current line counts, so the panel knows where hidden lines remain. */
  lineCounts: Record<string, number>;
  truncated?: boolean;
  /** The scope the diff answers (a commit that is gone reads as "branch"). */
  scope?: DiffScope["kind"];
  /** The base branch "All changes" uses unless another is picked. */
  defaultBase?: string;
  /** The checked-out branch; absent when HEAD is detached or has no commit. */
  branch?: string;
  /** Where the diff ends when it isn't the working tree: a commit's short id. */
  head?: string;
  /** The working tree has changes that aren't committed. */
  dirty?: boolean;
  /**
   * The branch couldn't be compared with its base (no common commit, a
   * shallow clone): only the uncommitted changes are shown.
   */
  baseUnknown?: boolean;
  /** The branch's commits since the base, newest first (at most 500). */
  commits?: GitCommit[];
}
export interface TerminalSessionInfo {
  id: string;
  conversationId: string;
  title: string;
  /** The shell it runs, when chosen from this computer's (Choose shell). */
  shell?: string;
  cwd: string;
  running: boolean;
  /**
   * Whether a command is running in the tab, read from its shell's prompt
   * marks; absent while the shell has printed none (or prints none at all).
   */
  busy?: boolean;
  outputBase64: string;
  sequence: number;
}
export type AppEvent =
  | {
      type: "simulator-frame";
      kind: import("./simulators").SimulatorKind;
      id: string;
      frame: import("./simulators").SimulatorScreen | null;
    }
  | {
      type: "device-event";
      deviceId: string;
      event: import("./remote-devices").DeviceAppEvent;
    }
  | { type: "devices-changed" }
  /** Claude opened a page in a Code session's Browser: show the panel. */
  | { type: "browser-reveal"; conversationId: string }
  | {
      type: "terminal-output";
      id: string;
      conversationId: string;
      deltaBase64: string;
      sequence: number;
    }
  | {
      type: "terminal-exit";
      id: string;
      conversationId: string;
      exitCode?: number;
      error?: string;
    }
  /** A command started (`busy`) or ended in a terminal tab. */
  | {
      type: "terminal-busy";
      id: string;
      conversationId: string;
      busy: boolean;
    }
  | { type: "terminal-reset" }
  | { type: "artifact-shares"; shares: ArtifactShareInfo[] }
  | { type: "conversation"; conversation: Conversation }
  /**
   * One turn of a conversation the window already has changed (reserved for
   * the web, where sending the whole conversation for every change costs too
   * much; the desktop sends "conversation"). `conversation` carries the
   * conversation's other changed fields (title, updatedAt, …); a window that
   * does not have the conversation waits for the next full event.
   */
  | {
      type: "conversation-turn";
      conversationId: string;
      turn: Turn;
      conversation?: Partial<Omit<Conversation, "id" | "turns">>;
    }
  /** A cloud sandbox changed state (web; `Snapshot.cloudSessions`). */
  | { type: "cloud-session"; session: CloudSessionInfo }
  /**
   * The event stream reconnected and events may have been missed (web: the
   * bridge's WebSocket resumed past its buffer). The window reads the
   * snapshot again and replaces what it shows.
   */
  | { type: "resync" }
  /**
   * The web bridge's event stream went down or came back. While it is down a
   * running reply shows "Connection lost" and Check now (never sent on the
   * desktop, whose engine is local).
   */
  | { type: "stream-connection"; connected: boolean }
  | { type: "approval"; approval: Approval; reAlert?: boolean }
  | { type: "approval-resolved"; id: string | number }
  /**
   * A side chat's answer so far (askSideChat): the whole text up to now, not
   * the new part, so a window that missed an event, or a relay that keeps
   * only the newest copy, still shows the right text. The call's own result
   * is the final answer.
   */
  | {
      type: "side-chat-text";
      conversationId: string;
      sideChatId: string;
      text: string;
    }
  | { type: "schedules"; schedules: Schedule[] }
  | { type: "engine"; engine: Snapshot["engine"] }
  /**
   * `conversationId` goes with "open-conversation", `folder` with
   * "new-code-session-in".
   */
  | {
      type: "command";
      command: AppCommand;
      conversationId?: string;
      folder?: string;
    }
  | { type: "connector-link"; connector: string }
  /** A claudex:// link opened from outside (shared/deep-links.ts). */
  | { type: "deep-link"; link: DeepLink }
  /** The window entered or left full screen (macOS hides its traffic lights). */
  | { type: "full-screen"; active: boolean }
  | {
      type: "weekly-usage";
      status: WeeklyUsageStatus | null;
      /** The usage couldn't be read (the tray says Usage unavailable). */
      unavailable?: true;
    }
  /** Settings the main process changed (MCP configuration file, skills, policy). */
  | { type: "settings"; settings: Settings }
  /**
   * The administrator's policy changed. `revision` is the service's policy
   * revision when it has one (also `policy.revision`).
   */
  | { type: "policy"; policy: ClientPolicy; revision?: number }
  /**
   * The service ended this device's session: all devices were signed out,
   * this device was removed, or the session expired. The window returns to
   * the sign-in screen and shows `message`.
   */
  | {
      type: "signed-out";
      reason:
        "revoked" | "device-revoked" | "session-expired" | "password-changed";
      message: string;
    }
  /** A payment order started from Settings → Billing changed state. */
  | { type: "billing-order"; orderId: number; status: BillingOrderStatus }
  /**
   * The service's plan, models, voice or reporting settings changed (a new
   * bootstrap); windows showing them read them again.
   */
  | { type: "service-changed" }
  | { type: "auth-issue"; issue: import("./auth-issue").AuthIssue | null }
  /**
   * The computer slept from `suspendedAt` and woke at `wakeAt` (desktop): a
   * Code session it interrupted shows the sleep band.
   */
  | { type: "slept"; suspendedAt: number; wakeAt: number }
  /** A link clicked inside an artifact preview, to confirm before opening. */
  | { type: "external-link"; url: string }
  | { type: "edit-command"; command: import("./edit-commands-api").EditCommand }
  | { type: "support-bundle-requested" }
  | { type: "routed-link-confirm"; requestId: string; url: string }
  | { type: "office-addin-files"; files: OfficeConnectedFile[] }
  /** A Code conversation's Browser panel changed (R8; the full state is `BrowserState`). */
  | { type: "browser"; state: BrowserEventState }
  | WindowVisibilityEvent
  | { type: "layout-command"; command: import("./window-layout").LayoutCommand }
  | ConversationWindowClosedEvent
  /** Quick Entry's prompt for the main window (shared/quick-entry.ts). */
  | QuickEntryEvent
  | MemoryChangedEvent
  | ResearchEvent
  | SshEvent
  | ComputerUseEvent
  | import("./desktop-notifications").NotificationActionEvent
  | { type: "email-sign-in-link"; link: import("./email-link").EmailLink }
  | CoworkFoldersEvent
  | WorkspaceTrustEvent
  | SharingEvent
  | StorageCleanupEvent
  /** Claudex's own update. */
  | AppUpdateEvent;
/**
 * What every Browser panel state carries. Package R8-A defines the whole
 * state (`BrowserState`, shared/browser.ts), which must stay assignable to
 * this; the panel reads the event's state as its own type.
 */
export interface BrowserEventState {
  conversationId: string;
  /** Grows with every change, so a window drops an older state. */
  version: number;
}
/**
 * Calls every window needs (accounts, snapshot, settings, conversations,
 * projects, window controls). New calls go in a domain's
 * `shared/<domain>-api.ts` interface, which DesktopAPI extends below.
 */
export interface CoreDesktopAPI {
  listResumableSessions: import("./resume-sessions").ResumeSessionsAPI["listResumableSessions"];
  probeImportableCliSessions(): Promise<{ count: number }>;
  importAllCliSessions(): Promise<{ imported: number; skipped: number }>;
  previewResumeSession: import("./resume-sessions").ResumeSessionsAPI["previewResumeSession"];
  resumeSession: import("./resume-sessions").ResumeSessionsAPI["resumeSession"];
  /** Read-only stored history search, optionally project-scoped, including unloaded transcript text. */
  searchConversations(
    query: string,
    options?: import("./history-search").HistorySearchOptions,
  ): Promise<{ results: import("./history-search").HistorySearchHit[] }>;
  authStatus(): Promise<AuthStatus>;
  registerAccount(
    email: string,
    password: string,
    name: string,
    extras?: RegisterExtras,
  ): Promise<PublicAccount>;
  loginAccount(
    email: string,
    password: string,
  ): Promise<PublicAccount | TwoFactorChallenge>;
  completeTwoFactor(code: string): Promise<PublicAccount>;
  cancelTwoFactor(): Promise<void>;
  sendVerificationCode(email: string): Promise<{ countdown: number }>;
  logoutAccount(): Promise<AuthStatus>;
  /** Signs out every device of a Sub2API account, this one included. */
  revokeAllSessions(): Promise<AuthStatus>;
  /** With `html`, the clipboard holds the text and its rich-text form. */
  copyText(text: string, html?: string): Promise<void>;
  copyImage(dataUrl: string): Promise<void>;
  /** Capture the focused app surface for artifact previews. */
  snapshot(): Promise<Snapshot>;
  /** A conversation's full turns and saved branches (for a `slim` one). */
  conversationTurns(
    conversationId: string,
  ): Promise<Pick<Conversation, "turns" | "savedBranches">>;
  saveSettings(settings: Settings): Promise<Settings>;
  send(input: {
    scheduledTaskSetup?: import("./scheduled-task-setup").ScheduledTaskSetupIntent;
    blankArtifactRevision?: import("./blank-artifacts").BlankArtifactRevision;
    /** New Code session output intent, without altering its visible prompt. */
    artifactOutputKind?: import("./artifact-output").ArtifactOutputKind;
    codePermissionMode?: import("./code-session-permissions").CodePermissionMode;
    /** A computer's Chat permission mode, sent with a prompt for the cloud. */
    taskPermission?: "default" | "auto" | "bypass";
    effort?: CodeEffort;
    thinkingSummariesWanted?: boolean;
    thinkingMode?: "standard" | "extended";
    conversationId?: string;
    text: string;
    mode: Mode;
    webSearch?: boolean;
    connectorOverrides?: Record<string, boolean>;
    connectorToolOverrides?: import("./conversation-tools").ConversationToolOverrides;
    toolSearchMode?: import("./tool-search-mode").ToolSearchMode;
    /** Start a new Chat in Research mode (R4). */
    research?: boolean;
    projectId?: string;
    cwd?: string;
    additionalFolders?: string[];
    attachments: Attachment[];
    providerId: string;
    model: string;
    incognito?: boolean;
    /** Where a new Code conversation runs (R9); ignored for existing ones. */
    environment?: EnvironmentRef;
    /**
     * Web Code: the repository a new cloud session starts with (the runner
     * clones it into the session's workspace). Ignored for existing ones.
     */
    repository?: RepositoryRef;
    cloudEnvironmentId?: string;
    /**
     * Web Code: every repository of a new cloud session when it has more
     * than one, `repository` first; the others are cloned inside its folder.
     */
    repositories?: RepositoryRef[];
    /** A new Cowork task from an outside prompt (Conversation.asksFirst). */
    asksFirst?: boolean;
    /** Desktop: a new local Code session in its own worktree. */
    worktree?: boolean;
    /** …starting from this local branch (else the folder's HEAD). */
    worktreeBranch?: string;
    /**
     * Settings → Claude Code → Create pull requests automatically (and
     * Create as draft), sent with each Code message: a cloud session opens
     * a pull request after a push without asking.
     */
    autoPullRequest?: "ready" | "draft";
  }): Promise<Conversation>;
  editPrompt(
    conversationId: string,
    turnId: string,
    text: string,
    providerId: string,
    model: string,
  ): Promise<Conversation>;
  selectPromptVersion(
    conversationId: string,
    turnId: string,
    versionTurnId: string,
  ): Promise<Conversation>;
  retryResponse(
    conversationId: string,
    turnId: string,
    providerId: string,
    model: string,
  ): Promise<Conversation>;
  discardTurn(conversationId: string, turnId: string): Promise<Conversation>;
  selectReplyVersion(
    conversationId: string,
    turnId: string,
    versionTurnId: string,
  ): Promise<Conversation>;
  interrupt(id: string): Promise<void>;
  updateConversation(
    id: string,
    patch: {
      sessionAuthors?: {
        viewerAccountUuid: string;
        ownerAccountUuid: string;
      } | null;
      title?: string;
      thinkingSummariesWanted?: boolean;
      thinkingMode?: "standard" | "extended";
      pinned?: boolean;
      archived?: boolean;
      projectId?: string | null;
      unread?: boolean;
      connectorOverrides?: Record<string, boolean>;
      connectorToolOverrides?: import("./conversation-tools").ConversationToolOverrides;
      toolSearchMode?: import("./tool-search-mode").ToolSearchMode;
      /** The session rail's Remote Control switch (false hides it from the phones). */
      remoteControl?: boolean;
      codePermissionMode?: import("./code-session-permissions").CodePermissionMode;
      /** Keep computer awake for this Code session (the session menu's switch). */
      keepAwake?: boolean;
      /** Archived because its pull request merged: its worktree's pushed branch is deleted. */
      prMerged?: boolean;
      /** The CI popover's Auto-fix CI and Address comments (shared/pr-autofix.ts). */
      prAutoFix?: { ci: boolean; comments: boolean };
      /** The CI popover's Auto-archive for this session. */
      prAutoArchive?: boolean;
      /**
       * The session's model (Code session menu "Change model", the live
       * bundle's setSessionModel): both together, applied from the next
       * message. A running turn is not interrupted.
       */
      providerId?: string;
      model?: string;
      goal?: {
        condition: string;
        setAt: number;
        iterations: number;
        lastReason?: string;
      } | null;
      outputStyle?: string;
      customOutputStyles?: Record<string, { name: string; prompt: string }>;
      cwd?: string;
      additionalFolders?: string[];
      parentSessionId?: string | null;
      nestedSessionsHidden?: boolean;
      titleOffersSuppressed?: boolean;
      titleOffer?: { proposedTitle: string; at: number } | null;
      titleOfferResponse?: import("./title-offers").TitleOfferResponse;
      completedAt?: number | null;
      runnerReleasedAt?: number | null;
    },
  ): Promise<Conversation>;
  /** Pause the session and release its runner for other work. */
  releaseRunner(id: string): Promise<Conversation>;
  /** Ends an incognito chat: stops it and forgets it and its thread. */
  discardIncognito(id: string): Promise<void>;
  /** Opens a conversation's working folder in Finder / File Explorer. */
  revealConversationFolder(id: string): Promise<void>;
  /**
   * Show in Finder for a file a Code session wrote in its folder; false
   * when it is no longer there (deleted or moved).
   */
  revealConversationFile(id: string, file: string): Promise<boolean>;
  /** The Files pane: one folder of a local Code session (relative path, "" for its root). */
  listProjectFolder(
    id: string,
    folder: string,
  ): Promise<{
    entries: import("./project-files").ProjectEntry[];
    truncated: boolean;
  }>;
  /** The Files pane: a file of a local Code session for the viewer. */
  readProjectFile(
    id: string,
    file: string,
  ): Promise<import("./project-files").ProjectFile>;
  /** A user editor save, confined to the local Code session and conditional on its read hash. */
  writeProjectFile(
    id: string,
    file: string,
    content: string,
    expectedRevision: string,
  ): Promise<import("./project-files").ProjectWriteResult>;
  searchProjectFiles(
    id: string,
    query: string,
  ): Promise<import("./project-files").ProjectSearchResult>;
  /** The editors Open in ▸ can use on this computer (shared/editors.ts). */
  installedEditors(): Promise<EditorInfo[]>;
  /** Opens a Code session's folder in an editor; false when it couldn't. */
  /** Opens the session's folder, or one file of it (`file`, relative), in an editor. */
  openConversationInEditor(
    id: string,
    editor: EditorKind,
    file?: string,
  ): Promise<boolean>;
  setConversationWebSearch(
    id: string,
    enabled: boolean,
    providerId?: string,
    model?: string,
  ): Promise<Conversation>;
  reorderConversations(input: {
    sourceId: string;
    targetId?: string;
    section: "pinned" | "recent";
    position: "before" | "after";
  }): Promise<Conversation[]>;
  deleteConversation(id: string): Promise<void>;
  saveProject(
    project: Project,
    creation?: import("./project-access").ProjectCreationOptions,
  ): Promise<Project>;
  readProject(
    id: string,
  ): Promise<import("./project-access").ProjectReadResult>;
  projectCreationCapabilities(): Promise<
    import("./project-access").ProjectCreationCapabilities
  >;
  deleteProject(id: string): Promise<void>;
  /** Picks one folder; `title` names what it is for (the dialog's title). */
  chooseFolder(title?: string): Promise<string | null>;
  /** Picks one or more folders (a project's Add a folder); empty when cancelled. */
  chooseFolders(title?: string): Promise<string[]>;
  chooseAttachments(): Promise<Attachment[]>;
  approve(id: string | number, result: any): Promise<void>;
  exportConversation(id: string): Promise<string | null>;
  revealConversationExport(file: string): Promise<boolean>;
  restartEngine(): Promise<void>;
  windowAction(
    action: "minimize" | "maximize" | "close" | "caption",
    /** "caption": the colours of Windows' own caption buttons, from the page under them. */
    colors?: { background: string; symbol: string },
  ): Promise<void>;
  onEvent(callback: (event: AppEvent) => void): () => void;
}
/**
 * The preload bridge (`window.desktop`): the core calls plus every domain's
 * `shared/<domain>-api.ts` interface. The preload script exposes the same
 * lists, so a domain adds a call without editing this file.
 */
export interface DesktopAPI
  extends
    CoreDesktopAPI,
    PrivacyDataAPI,
    DesktopExtensionsAPI,
    CodeEmailAPI,
    SettingsAccountAPI,
    SettingsDesktopAPI,
    PolicyAPI,
    UsageAPI,
    BillingAPI,
    ModelCatalogAPI,
    VoiceAPI,
    DiagnosticsAPI,
    EditCommandsAPI,
    SupportBundleAPI,
    OfficeAddinAPI,
    CodeUsageAPI,
    ComposerAPI,
    AgentAPI,
    PanelsAPI,
    ArtifactsAPI,
    CollectionsAPI,
    ExternalLinksAPI,
    SharingAPI,
    WindowsAPI,
    MemoryAPI,
    ResearchAPI,
    FaviconAPI,
    SshAPI,
    ComputerUseAPI,
    CoworkAPI,
    DeviceTrustAPI,
    WorkspaceTrustAPI,
    AppUpdateAPI,
    SignInAPI,
    GitHubAPI,
    LinearAPI,
    ApiKeysAPI,
    AnnouncementsAPI,
    OnboardingAPI,
    CloudSyncAPI,
    ChatDevicesAPI,
    CloudEnvironmentsAPI,
    CloudContinueAPI,
    UsageStatsAPI,
    ServiceStatusAPI,
    SimulatorsAPI,
    AccountProfileAPI,
    DispatchAPI {}
export interface ArtifactShareInput {
  identity: string;
  title: string;
  language: string;
  content: string;
  screenshot?: string;
}
export interface ArtifactShareInfo {
  screenshotUrl?: string;
  identity: string;
  visibility: "private" | "link";
  showInList: boolean;
  url?: string;
  /** "public": a hosted link anyone can open (R1); "local" or missing: this app only. */
  scope?: "local" | "public";
  /** The hosted page's address when `scope` is "public". */
  publicUrl?: string;
}
declare global {
  interface Window {
    desktop: DesktopAPI;
  }
}
