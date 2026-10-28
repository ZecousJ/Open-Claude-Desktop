import type { TranscriptView } from "./transcript-view";
import { previewOrigin, previewOriginUnsafe } from "./preview-origin";
import { isLocalDevHost } from "./browser";

/**
 * Settings added with the long Settings pages (Account, General, Claude Code,
 * Cowork, System, Skills). Every field is optional so older settings files
 * load unchanged; `preferenceDefaults` gives the value an absent field means.
 */
import type {
  NotificationLevels,
  NotificationSound,
} from "./notification-levels";

/**
 * "What best describes your work?" (Settings → Account) and the onboarding's
 * "What kind of work do you do?" share one list: the original's work_function
 * roles in its order. The values are the original's, and the service stores the
 * same ones (backend internal/claudex/onboarding).
 */
export type WorkType =
  | "Product Management"
  | "Engineering"
  | "Human Resources"
  | "Finance"
  | "Marketing"
  | "Sales"
  | "Operations"
  | "Data Science"
  | "Design"
  | "Legal"
  | "Scientist"
  | "Student"
  | "Founder"
  | "Healthcare"
  | "Writer"
  | "Educator"
  | "Consultant"
  | "Researcher"
  | "SoftwareEngineer"
  | "Other";

export const workTypes: { value: WorkType; label: string }[] = [
  { value: "Product Management", label: "Product management" },
  { value: "Engineering", label: "Engineering" },
  { value: "Human Resources", label: "Human resources" },
  { value: "Finance", label: "Finance" },
  { value: "Marketing", label: "Marketing" },
  { value: "Sales", label: "Sales" },
  { value: "Operations", label: "Operations" },
  { value: "Data Science", label: "Data science" },
  { value: "Design", label: "Design" },
  { value: "Legal", label: "Legal" },
  { value: "Scientist", label: "Scientist" },
  { value: "Student", label: "Student" },
  { value: "Founder", label: "Founder" },
  { value: "Healthcare", label: "Healthcare" },
  { value: "Writer", label: "Writer" },
  { value: "Educator", label: "Educator" },
  { value: "Consultant", label: "Consultant" },
  { value: "Researcher", label: "Researcher" },
  { value: "SoftwareEngineer", label: "Software engineer" },
  { value: "Other", label: "Other" },
];

/** Claudex's earlier work types, read as the role that replaced each. */
const legacyWorkTypes: Record<string, WorkType> = {
  engineering: "SoftwareEngineer",
  design: "Design",
  product: "Product Management",
  data: "Data Science",
  research: "Researcher",
  marketing: "Marketing",
  sales: "Sales",
  operations: "Operations",
  finance: "Finance",
  legal: "Legal",
  education: "Educator",
  writing: "Writer",
  other: "Other",
};

/** A stored work type as a current one; an unknown one is none. */
export function normalizeWorkType(value: unknown): WorkType | undefined {
  if (typeof value !== "string") return undefined;
  if (workTypes.some((w) => w.value === value)) return value as WorkType;
  return Object.prototype.hasOwnProperty.call(legacyWorkTypes, value)
    ? legacyWorkTypes[value]
    : undefined;
}

/**
 * Settings → Claude Code → Appearance → Transcript text size: Small, Medium or
 * Large.
 */
export type TranscriptTextSize = "s" | "m" | "l";
/** Settings → Claude Code → Transcript width: Narrow, Medium, Wide. */
export type TranscriptWidth = "s" | "m" | "l";
/** Settings → Claude Code → Interface font. */
export type InterfaceFont = "anthropic" | "system" | "dyslexic";
/** Code syntax themes actually provided by this application. */
export type CodeLightTheme = "claudex-light" | "github-light";
export type CodeDarkTheme = "claudex-dark" | "github-dark";

/** Settings → Capabilities → Domain allowlist. */
export type EgressAllowlist = "none" | "packages" | "all";

export interface QuietHours {
  days: number[];
  start: string;
  end: string;
}

/**
 * A task's permission mode: Manual ("default") asks before anything beyond
 * reading and editing in its folders, Auto lets a reviewer model decide those
 * requests, Full access ("bypass") never asks.
 */
export const taskPermissions = ["default", "auto", "bypass"] as const;
export type TaskPermission = (typeof taskPermissions)[number];

/** Settings → Claude Code → Dynamic workflows (electron/workflows). */
export interface WorkflowSettings {
  /** Off hides the Workflow tool; unset follows the account's default (on). */
  enabled?: boolean;
  /** Advisory agent count Claude aims for; unset is "medium". */
  size?: "small" | "medium" | "large" | "unrestricted";
  /** "ultracode" in a prompt opts that turn in; unset is on. */
  keywordTrigger?: boolean;
}

export interface SettingsPreferences {
  extensionAutoUpdates?: boolean;
  extensionBuiltInNode?: boolean;
  avatar?: number;
  avatarPhoto?: string;
  profilePhotoEnabled?: boolean;
  homeStarters?: import("./home-starters").HomeStarters;
  /** "What best describes your work?"; told to the model with the instructions. */
  workType?: WorkType;
  /** Notify when a reply finishes while the window is in the background. */
  notifyResponses?: boolean;
  /** Notify when a scheduled task finishes, fails or waits on an approval or a question. */
  notifySchedules?: boolean;
  /**
   * E-mail me about scheduled tasks (the original's routines.enable_email):
   * tasks that don't choose for themselves mail when a run ends.
   */
  notifySchedulesEmail?: boolean;
  /** Settings → Claude Code → Local sandbox (new local Code sessions). */
  codeLocalSandbox?: boolean;
  /** Settings → Claude Code → Strict sandbox mode (needs Local sandbox). */
  codeStrictSandbox?: boolean;
  /** Notify when a Code session needs approval while the window is in the background. */
  notifyCode?: boolean;
  /** Code approval banners, independent of completion/update notifications and local levels. */
  notifyCodePermissions?: boolean;
  /**
   * Code notifications: a Code session may notify the person of an
   * important update with its PushNotification tool
   * (shared/code-notifications.ts).
   */
  notifyCodeUpdates?: boolean;
  /** Email updates for eligible cloud Code sessions. */
  notifyCodeEmail?: boolean;
  /** "Allow bypass permissions mode": the user's own switch, never the administrator's. */
  allowBypassPermissions?: boolean;
  classifySessionStates?: boolean;
  ccPromptSuggestions?: boolean;
  ccNewTaskPrompt?: "ask" | "here" | "new_session";
  switchModelsOnFlag?: boolean;
  /**
   * Capabilities → Switch models when a message is flagged: Chat and Cowork
   * try another model when safeguards flag a message (the original's
   * enabled_model_auto_fallback, on unless turned off).
   */
  modelAutoFallback?: boolean;
  /** Default-on enabled_geolocation. */
  locationMetadata?: boolean;
  /** Claude Code → Archive inactive sessions: days without activity, 0 never. */
  autoArchiveDays?: 0 | 1 | 2 | 7 | 14 | 30;
  /** Claude Code → Output style: the style new Code sessions start with ("" default). */
  codeOutputStyle?: string;
  /**
   * Claude Code → Connect new sessions to Remote Control: new Code sessions
   * start reachable from the phone; the session's own switch can still turn it
   * off.
   */
  remoteControlNewSessions?: boolean;
  /**
   * The permission mode of tasks started from the home. Full access is
   * Claudex's third mode, kept by the owner.
   */
  taskPermission?: TaskPermission;
  /** Whether Cowork may run tasks that use this computer. */
  computerAccess?: boolean;
  /** Prevent idle sleep while a Code turn runs. */
  keepAwakeWhileCoding?: boolean;
  /** …also on battery power. */
  keepAwakeOnBattery?: boolean;
  workflows?: WorkflowSettings;
  /** Bounce the Dock icon / flash the taskbar when a session needs attention. */
  drawAttention?: boolean;
  /**
   * The desktop's banners about its sessions: Permission requests,
   * Questions and Task complete (shared/notification-levels.ts). Absent:
   * banners, with the old switches' explicit "off" carried over.
   */
  notificationLevels?: NotificationLevels;
  /** "Notification sound": the system sound, or none, for every banner. */
  notificationSound?: NotificationSound;
  /**
   * Settings → Capabilities → AI-powered artifacts: a Chat artifact may call
   * `window.claude.complete(prompt)`, answered by the account's model.
   */
  aiArtifacts?: boolean;
  /** Chat execution and file tools; independent of Code and Cowork. */
  chatExecution?: boolean;
  /** Chat artifact creation when execution is disabled. */
  artifacts?: boolean;
  capabilityTipState?: import("./chat-suggestions").ArtifactTipPacing;
  /**
   * Settings → Capabilities → Inline visualizations: Chat may draw charts
   * and diagrams in the reply itself (a `visualization` block).
   */
  inlineVisualizations?: boolean;
  /**
   * Settings → Capabilities → Tool access mode (the original's
   * tool_search_mode): "needed" lets a model that can search its tools load
   * connector tools when needed; "loaded" gives every model all of them up
   * front. Applies once the agent restarts, so to new conversations.
   */
  toolAccessMode?: "needed" | "loaded";
  connectorSearch?: boolean;
  /**
   * The design system in use (composer + menu → Design system): its id, or
   * "" for none. Chat and Cowork follow its guidelines when they make designs.
   */
  designSystem?: string;
  /**
   * The service group whose models the menus list for each provider
   * (sidebar → API): provider id → group id. A provider without an entry
   * uses the plan group when it is the provider's, else its first group.
   */
  apiGroups?: Record<string, number>;
  /**
   * The image model pictures are made with (sidebar → API → Image
   * generation); "" uses the drawing group's first model.
   */
  imageModel?: string;
  /** The interface language (a `shared/locales.ts` id); Simplified Chinese until chosen. */
  locale?: string;
  /**
   * Settings → Capabilities → Allow network egress (the web, where tasks run
   * in a server sandbox): whether the sandbox may reach the network at all.
   * The service's own level is the ceiling; this only narrows it.
   */
  networkEgress?: boolean;
  /**
   * …Domain allowlist: `packages` is the service's list of package managers,
   * `all` needs a service that allows every domain, `none` closes the network.
   */
  egressAllowlist?: EgressAllowlist;
  /** …Additional allowed domains (`example.com`, `*.example.com`). */
  egressDomains?: string[];
  /**
   * Settings → Time and focus → Break reminders: a nudge after this many
   * minutes of use in a row; 0 is off.
   */
  breakReminderMinutes?: number;
  /**
   * Settings → Time and focus → Quiet hours: on these days (0 Sunday … 6
   * Saturday) between `start` and `end` ("HH:MM", may cross midnight)
   * Claudex reminds you of the limit you set; you can dismiss it.
   */
  quietHours?: QuietHours;
  /** Instructions added to every Cowork task. */
  coworkInstructions?: string;
  /** Show Claudex in the menu bar (tray on Windows and Linux). */
  menuBar?: boolean;
  /** Prevent idle sleep while Claudex is open, so scheduled tasks can run. */
  keepAwake?: boolean;
  /** Global accelerator that brings Claudex forward with a new chat; "" for none. */
  quickAccessShortcut?: string;
  /** Quick access: double-tap Option/Alt, off, or a custom accelerator. */
  quickEntryShortcut?: string;
  quickEntryDictationShortcut?: string;
  /**
   * Starts or stops dictation in the composer being typed in: an accelerator,
   * "" for none.
   */
  dictationShortcut?: string;
  /** SKILL.md paths the user switched off; re-applied at every runtime start. */
  disabledSkills?: string[];
  /**
   * Settings → Privacy → Help improve Claudex: the user agrees that error
   * reports and reply feedback go to the Claudex service, once its
   * administrator collects them. Off until the user turns it on.
   */
  helpImproveClaudex?: boolean;
  /** Telemetry control. */
  disableNonessentialServices?: boolean;
  /**
   * Settings → Claude Code → Browser → Browser tools (R8): Claude may start
   * dev servers and drive the built-in browser in Code sessions. On unless
   * turned off; the administrator's `policy.browser.enabled` can still turn
   * it off.
   */
  browserTools?: boolean;
  /** Allow browser actions on any website without asking in new sessions. */
  allowAllBrowserActions?: boolean;
  /**
   * Links in Code sessions open in the built-in browser (the panel on the
   * right) instead of the default browser. On unless turned off, as in the
   * original desktop app.
   */
  browserOpenLinksInApp?: boolean;
  /**
   * Chat, Cowork and Code sessions on a GitHub repository run in the cloud
   * and show on the web too (docs/cloud-sync.md). On unless turned off.
   */
  cloudSync?: boolean;
  /**
   * The account's phones can open, continue, stop and approve this computer's
   * Code sessions while Claudex runs here. On unless turned off.
   */
  remoteControl?: boolean;
  dispatchOnboarded?: boolean;
  dispatchMobileNotifications?: boolean;
  /**
   * Folders the person added for Control from your phone: the only folders
   * a phone may start new Code sessions in (the web's "Add a folder to
   * Remote Control"). Adding one trusts it for Codex.
   */
  remoteFolders?: string[];
  /** Keep cookies: how long the built-in browser keeps cookies and logins. */
  browserKeepCookies?: BrowserKeepCookies;
  /**
   * Allowed sites: origins (`https://example.com`, `http://localhost:*`)
   * where Claude uses its Browser tools without asking. Added with "Always
   * allow this site"; removed in Settings.
   */
  browserAllowedSites?: string[];
  /** Auto-verify changes: Claude checks UI changes in the browser before finishing. */
  browserAutoVerify?: boolean;
  /**
   * Code home → Local ▾ → Edit local environment: .env text whose variables the
   * agent runtime starts with, so Code sessions on this computer see them. Read
   * when the runtime starts.
   */
  localEnvironmentVariables?: string;
  /**
   * Settings → Claude Code → Mobile simulators → iOS Simulator (desktop
   * bundle 2.31226.1, `claudeIosSimulatorAccessEnabled`): Claude gets its
   * simulator tools in Code sessions on a Mac. On unless turned off; you
   * can still use the simulator panel yourself when it is off.
   */
  iosSimulatorAccess?: boolean;
  /** …Android Emulator (`claudeAndroidEmulatorAccessEnabled`), on a Mac or Windows. */
  androidEmulatorAccess?: boolean;
  /**
   * The size of the conversation transcript's text, the Code composer's
   * prompt and a Markdown document's column (src/transcript-text-size.ts).
   */
  transcriptTextSize?: TranscriptTextSize;
  /** The widest the transcript and composer columns go: 768, 960 or 1280px. */
  transcriptWidth?: TranscriptWidth;
  preferredBrowser?: "built_in";
  /**
   * The face of the whole interface: Anthropic Sans (the reference face when a
   * local Claude installation lends it), the system's, or OpenDyslexic.
   */
  interfaceFont?: InterfaceFont;
  codeLightTheme?: CodeLightTheme;
  codeDarkTheme?: CodeDarkTheme;
  /**
   * Settings → Claude Code → Default transcript view: the view Code sessions
   * open in; a session's own Transcript view menu (or Ctrl+O) changes only that
   * session.
   */
  defaultTranscriptView?: TranscriptView;
  ccdThinkingSummaryOnDemand?: boolean;
  coworkThinkingMode?: "standard" | "extended";
  /**
   * Settings → Claude Code → Pull requests → Auto-archive after PR merge or
   * close: a Code session is archived once the pull request it made is merged
   * or closed. A session's own switch (the CI popover's) overrides it.
   */
  prAutoArchive?: boolean;
  /** …Open pull requests in browser: PR links skip the built-in browser. */
  prOpenInBrowser?: boolean;
  /**
   * …Create pull requests automatically: a cloud session opens a pull request
   * after a push without asking; Create as draft opens it as a draft.
   */
  prAutoCreate?: boolean;
  /** …Auto-fix pull requests: a session's new pull request is watched (electron/pr-autofix.ts). */
  prAutoFix?: boolean;
  prAutoCreateDraft?: boolean;
  /**
   * The folder chip's Worktree switch: new local Code sessions start in their
   * own worktree.
   */
  codeWorktree?: boolean;
  /**
   * Settings → Claude Code → Worktree location: empty keeps each session's
   * worktree inside its repository (.claude/worktrees); a folder holds them
   * as <folder>/<repository name>/<worktree>.
   */
  codeWorktreeLocation?: string;
  /** …Pull requests → Branch prefix: worktree branches are "<prefix>/<name>". */
  codeBranchPrefix?: string;
  /**
   * `/autocompact <tokens>`: Code sessions compact themselves once the
   * context holds this many tokens; 0 (`/autocompact auto`) keeps the model's
   * own limit from the service's catalog.
   */
  codeAutoCompactTokens?: number;
}

/** Keep cookies choices (the same values as `shared/browser.ts`). */
export type BrowserKeepCookies = "until-quit" | "always" | "per-session";

export const browserKeepCookiesOptions: {
  value: BrowserKeepCookies;
  label: string;
}[] = [
  { value: "until-quit", label: "Until quit" },
  { value: "always", label: "Shared" },
  { value: "per-session", label: "Per session" },
];

/** At most this many Allowed sites are kept. */
export const browserAllowedSitesLimit = 200;

/**
 * An Allowed sites entry: an http(s) origin without path, query or
 * credentials; the port may be `*` (`http://localhost:*`).
 */
export function allowedSiteValid(value: string) {
  return /^https?:\/\/(?:\[[0-9a-f:.]+\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(?:\*|[0-9]{1,5}))?$/i.test(
    value,
  );
}

/** Why a typed address can't join Allowed sites (the original's messages). */
export type AllowedSiteRefusal = "invalid" | "loopback" | "exists" | "full";

/**
 * The Allowed sites entry for a typed address: "example.com" is read as
 * https, a path or query is dropped and only the origin kept (the entries
 * are origins). Local development addresses never need an entry, and an
 * address already covered (exactly, or by an any-port entry) is refused.
 */
export function parseAllowedSite(
  input: string,
  existing: readonly string[],
): { site: string } | { refusal: AllowedSiteRefusal } {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    return { refusal: "invalid" };
  }
  const site = previewOrigin(url.href);
  if (!site || url.username || url.password || !allowedSiteValid(site))
    return { refusal: "invalid" };
  if (previewOriginUnsafe(site)) return { refusal: "full" };
  const host = new URL(site).hostname;
  if (isLocalDevHost(host)) return { refusal: "loopback" };
  const anyPort = `${url.protocol}//${host}:*`;
  if (
    existing.some((entry) => previewOrigin(entry) === site || entry === anyPort)
  )
    return { refusal: "exists" };
  if (existing.length >= browserAllowedSitesLimit) return { refusal: "full" };
  return { site };
}

export const preferenceDefaults: Required<
  Omit<SettingsPreferences, "workType">
> = {
  extensionAutoUpdates: true,
  extensionBuiltInNode: true,
  avatar: 0,
  avatarPhoto: "",
  profilePhotoEnabled: false,
  homeStarters: {},
  notifyResponses: false,
  // Scheduled tasks is the only notification on by default.
  notifySchedules: true,
  notifySchedulesEmail: false,
  codeLocalSandbox: true,
  codeStrictSandbox: false,
  notifyCode: false,
  // Preserve existing approval banners until the person chooses this independent channel.
  notifyCodePermissions: true,
  notifyCodeUpdates: false,
  notifyCodeEmail: false,
  // On: Bypass stays available as it was; the original starts it off.
  allowBypassPermissions: true,
  classifySessionStates: true,
  ccPromptSuggestions: true,
  ccNewTaskPrompt: "ask",
  switchModelsOnFlag: true,
  modelAutoFallback: true,
  locationMetadata: true,
  autoArchiveDays: 0,
  codeOutputStyle: "",
  remoteControlNewSessions: true,
  taskPermission: "default",
  computerAccess: true,
  // On by default, as the original's "Keep computer awake while Claude works"
  // and "Keep awake on battery power".
  keepAwakeWhileCoding: true,
  keepAwakeOnBattery: true,
  // Dynamic workflows on, medium size, "ultracode" heard.
  workflows: {},
  drawAttention: false,
  // Banners for every kind, with the system sound; read through
  // shared/notification-levels.ts.
  notificationLevels: {},
  notificationSound: "system",
  // As on claude.ai: visualizations on; AI artifacts off, since every call an
  // artifact makes spends the account's quota.
  aiArtifacts: false,
  chatExecution: true,
  artifacts: true,
  capabilityTipState: { sessionsSinceLastShow: 0, ledger: {}, dismissed: [] },
  inlineVisualizations: true,
  toolAccessMode: "needed",
  connectorSearch: true,
  designSystem: "",
  apiGroups: {},
  imageModel: "",
  locale: "zh-CN",
  networkEgress: true,
  egressAllowlist: "packages",
  egressDomains: [],
  breakReminderMinutes: 0,
  quietHours: { days: [], start: "22:00", end: "07:00" },
  coworkInstructions: "",
  // On, as the original.
  menuBar: true,
  keepAwake: false,
  // Alt+Space off macOS (desktop client 2.37337.1: ERe, the default global
  // shortcut); macOS opens Quick Entry by the Option double tap and ignores it.
  quickAccessShortcut: "Alt+Space",
  quickEntryShortcut: "double-tap-option",
  quickEntryDictationShortcut: "off",
  dictationShortcut: "CommandOrControl+D",
  disabledSkills: [],
  helpImproveClaudex: false,
  disableNonessentialServices: false,
  // R8 design 5.1: Browser tools on (as the original), links in the default browser.
  browserTools: true,
  // Every site without a question, unless turned off in Settings; the
  // administrator's blocked domains and local-only policy still apply.
  allowAllBrowserActions: true,
  browserOpenLinksInApp: true,
  cloudSync: true,
  remoteControl: true,
  dispatchOnboarded: false,
  dispatchMobileNotifications: false,
  remoteFolders: [],
  browserKeepCookies: "until-quit",
  browserAllowedSites: [],
  browserAutoVerify: false,
  localEnvironmentVariables: "",
  iosSimulatorAccess: true,
  androidEmulatorAccess: true,
  transcriptTextSize: "m",
  transcriptWidth: "s",
  preferredBrowser: "built_in",
  interfaceFont: "anthropic",
  codeLightTheme: "claudex-light",
  codeDarkTheme: "claudex-dark",
  defaultTranscriptView: "normal",
  ccdThinkingSummaryOnDemand: true,
  coworkThinkingMode: "extended",
  prAutoArchive: false,
  prOpenInBrowser: false,
  prAutoCreate: false,
  prAutoFix: false,
  prAutoCreateDraft: false,
  codeWorktree: false,
  codeWorktreeLocation: "",
  codeBranchPrefix: "claude",
  codeAutoCompactTokens: 0,
};

/** A preference's effective value. */
export function preference<K extends keyof typeof preferenceDefaults>(
  settings: SettingsPreferences,
  key: K,
): (typeof preferenceDefaults)[K] {
  return (settings[key] ?? preferenceDefaults[key]) as any;
}

export const coworkInstructionsLimit = 10000;

/**
 * Profile lines added to the model's instructions, from Settings → Account
 * ("What should Claude call you?", "What best describes your work?");
 * empty when there is nothing to say.
 */
export function profileInstructions(
  settings: SettingsPreferences & { name?: string },
): string {
  const lines: string[] = [];
  // One line, without quotes that could end the sentence early.
  const name = (settings.name ?? "").replace(/[\s"“”]+/g, " ").trim();
  // Named, not greeted: a reply that opens with the name reads like a form
  // letter.
  if (name)
    lines.push(
      `The user's name is "${name.slice(0, 100)}". Use it only where a person naturally would; never open a reply with it.`,
    );
  const workType = normalizeWorkType(settings.workType);
  const work = workTypes.find((w) => w.value === workType);
  if (work && work.value !== "Other")
    lines.push(`The user's work: ${work.label.toLowerCase()}.`);
  return lines.join(" ");
}
