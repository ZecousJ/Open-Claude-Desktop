import type { Settings } from "./types";
import { codeSandboxFor } from "./sandbox-policy";

/** Code permission modes in the order of the picker. */
export type PermissionMode =
  "auto" | "manual" | "acceptEdits" | "plan" | "bypass";
/**
 * The modes an administrator may restrict. Bypass permissions is the user's
 * own choice (Settings → Claude Code and its confirmation per folder), so no
 * policy, missing policy or offline state can turn it off.
 */
export type PolicyMode = Exclude<PermissionMode, "bypass">;
export const permissionModes: PermissionMode[] = [
  "auto",
  "manual",
  "acceptEdits",
  "plan",
  "bypass",
];
export const permissionModeTitles: Record<PermissionMode, string> = {
  auto: "Auto",
  manual: "Manual",
  acceptEdits: "Accept edits",
  plan: "Plan",
  bypass: "Bypass permissions",
};

/** File types the attachment picker offers; the operator may narrow the list. */
export const imageAttachmentTypes = ["png", "jpg", "jpeg", "webp", "gif"];
/** Documents: their text is read out and given to the model like a text file. */
export const documentAttachmentTypes = ["pdf", "docx", "pptx", "xlsx"];
export const attachmentTypes = [
  ...imageAttachmentTypes,
  ...documentAttachmentTypes,
  "txt",
  "md",
  "csv",
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "json",
  "yaml",
  "yml",
  "html",
  "css",
  "rs",
  "go",
  "java",
  "c",
  "cpp",
  "xml",
  "toml",
  "log",
];
/** Built-in ceilings: images are sent by path, text is inlined into the prompt, a document's text is read out of it. */
export const builtInAttachmentBytes = {
  image: 20 * 1024 * 1024,
  text: 2 * 1024 * 1024,
  document: 30 * 1024 * 1024,
};

/** What kind of attachment a file of this extension is. */
export function attachmentKind(
  extension: string,
): "image" | "document" | "text" {
  const e = extension.toLowerCase();
  return imageAttachmentTypes.includes(e)
    ? "image"
    : documentAttachmentTypes.includes(e)
      ? "document"
      : "text";
}

export interface PolicyLink {
  label: string;
  url: string;
}
export interface ClientUpdate {
  /** "required" when this build is older than the minimum supported version. */
  state: "available" | "required";
  currentVersion: string;
  latestVersion: string;
  downloadUrl?: string;
  /**
   * The service enforces the minimum version (its release information's
   * `enforced`). Absent: a required update is enforced, as before.
   */
  enforced?: boolean;
}
/** An administrator notice (Sub2API announcement, or the policy file for local accounts). */
export interface Announcement {
  id: string;
  title: string;
  /** Markdown. */
  content: string;
  /** Shown as a notice above the composer until read; otherwise only in What's new. */
  popup: boolean;
  createdAt: number;
  read: boolean;
}

/**
 * One MCP server the administrator allows. A rule with only a name allows the
 * server by name; otherwise it is bound to its definition, so a server with
 * the same name but another program or address is not allowed.
 */
export interface ConnectorRule {
  name: string;
  /** Local server: the program and its arguments, exactly. */
  command?: string;
  args?: string[];
  /** Remote server: the address, exactly. */
  url?: string;
  /**
   * Remote server: the start of its address (the service's `url_prefix`),
   * compared as normalized https addresses on a path boundary.
   */
  urlPrefix?: string;
}

/**
 * Memory (Chat and Cowork only). Absent: the service does not offer memory
 * (an older service), so the client shows no memory switches.
 */
export interface MemoryPolicy {
  /** Off: no memory is used or written; stored memory is kept. */
  enabled: boolean;
  /** "Search and reference chats" may be turned on. */
  searchChats: boolean;
  /** "Generate memory from chat history" may be turned on. */
  generate: boolean;
  /** The user's two switches start on until the user chooses. */
  defaultOn: boolean;
  /** The model that writes the summary; null for the catalog's default. Used only when the catalog lists it. */
  model: string | null;
}

/**
 * Research mode (Chat). Absent (an older service): Research follows
 * `webSearch`, with the built-in cap.
 */
export interface ResearchPolicy {
  /** Always off when web search is off. */
  enabled: boolean;
  /** Models that can search X (grok) do so with web search and Research; off when web search is off. */
  xSearch: boolean;
  /** Most searches in one Research turn. */
  maxSearchesPerTurn: number;
}

/**
 * The built-in browser's agent tools (Code). The browser runs on this
 * computer, so the policy never locks it offline. Absent: allowed.
 */
export interface BrowserPolicy {
  /** Off: no Browser tools, button or panel. */
  enabled: boolean;
  /** The agent may act on sites other than local development addresses. */
  externalSites: boolean;
  /** The agent may run JavaScript in a page. */
  allowScript: boolean;
  /** The agent may start dev servers. */
  devServers: boolean;
  /** Domains (and their subdomains) the browser does not open. */
  blockedDomains: string[];
}

/**
 * Computer use. Absent (an older service) means off, like the pending,
 * offline and locked policies: it stays off until a service allows it.
 */
export interface ComputerUsePolicy {
  enabled: boolean;
  /** Full control of the screen besides app-by-app access. */
  allowFullControl: boolean;
  /** Apps (bundle ids or program names) computer use may never act on. */
  deniedApps: string[];
  /** Lowers the client's own action cap per turn; null keeps it. */
  maxActionsPerTurn: number | null;
}

/**
 * What the administrator allows this account to use, resolved for this
 * platform. There is no field for Bypass permissions: the user alone turns it
 * on (Settings → Claude Code), whatever the policy, offline or not.
 * Published fields keep their types; new fields are added as optional ones.
 */
export interface ClientPolicy {
  /** Allowed modes other than Bypass (see PolicyMode). */
  permissionModes: PolicyMode[];
  incognito: boolean;
  webSearch: boolean;
  /** New conversations start with web search on (where web search is allowed). */
  webSearchDefault: boolean;
  /** Dictation and voice mode. */
  voice: boolean;
  /** Adding, removing or changing MCP servers in Settings → Developer. */
  localMcpEditing: boolean;
  /** Organization policy for folder-based desktop extension installs. */
  developerModeEnabled?: boolean;
  desktopExtensionsEnabled?: boolean;
  developerMcpEnabled?: boolean;
  remoteImages: boolean;
  /** Hosts remote images may load from (`*.` for subdomains); null allows any. */
  remoteImageDomains: string[] | null;
  externalLinks: boolean;
  /** Hosts whose links still open with external links off (`*.` for subdomains). */
  trustedLinkDomains: string[];
  /** MCP servers (connectors) that may run; null allows any. */
  connectors: ConnectorRule[] | null;
  attachments: {
    /** Per-file ceiling below the built-in ones; null keeps them. */
    maxBytes: number | null;
    /** Allowed extensions, lower case; empty turns attachments off. */
    types: string[];
  };
  links: {
    help?: string;
    plans?: string;
    apps?: string;
    /** The usage banner's Get more usage page. */
    getMoreUsage?: string;
    /** Settings → Usage: Learn more about usage limits. */
    usageLearnMore?: string;
    learnMore: PolicyLink[];
  };
  /** The usage banner appears from this percent of a limit. */
  usageBanner: { warnPercent: number };
  /** The plan's name as the account menu shows it; null uses the plan (group) name. */
  planLabel: string | null;
  scheduledTasks: {
    enabled: boolean;
    /** Most scheduled tasks the account may keep; null for no limit. */
    maxTasks: number | null;
    approvalLifetimeDays?: number;
  };
  /** Approval cards offer "Always allow" for the session. */
  approvalsAlwaysAllow: boolean;
  memory?: MemoryPolicy;
  research?: ResearchPolicy;
  browser?: BrowserPolicy;
  /** SSH remote environments may be used. Absent: allowed. */
  sshRemote?: boolean;
  sshHostAllowlist?: string[];
  sshClientPath?: string;
  /** Dynamic workflows may run (the original's disableWorkflows). Absent: allowed. */
  workflows?: boolean;
  /** Initial workflow opt-in for the account, independent of an explicit user choice. */
  workflowsDefaultOn?: boolean;
  /**
   * Every workflow run is approved, also in a session that bypasses
   * permissions ("Your organization requires approval each time…").
   */
  workflowApprovalRequired?: boolean;
  /**
   * An https mirror that replaces https://registry.npmjs.org/ when the Codex
   * runtime is installed on a remote host; the built-in checksums still
   * apply. null or absent: the npm registry.
   */
  codexRuntimeMirror?: string | null;
  computerUse?: ComputerUsePolicy;
  /** The service's policy revision; 0 for a policy made on this computer. */
  revision: number;
  update?: ClientUpdate;
  /**
   * The service has not answered yet (signed in to a Sub2API account, first
   * start or offline). Only high-risk items are held back meanwhile.
   */
  pending?: true;
}

/** The browser as a local account (or a policy that cannot be read) has it: it runs on this computer. */
const openBrowser: BrowserPolicy = {
  enabled: true,
  externalSites: true,
  allowScript: true,
  devServers: true,
  blockedDomains: [],
};

/** Nothing restricted: a local account without a policy file. */
export const openPolicy: ClientPolicy = {
  permissionModes: ["auto", "manual", "acceptEdits", "plan"],
  incognito: true,
  webSearch: true,
  webSearchDefault: false,
  voice: true,
  localMcpEditing: true,
  developerModeEnabled: true,
  remoteImages: true,
  remoteImageDomains: null,
  externalLinks: true,
  trustedLinkDomains: [],
  connectors: null,
  attachments: { maxBytes: null, types: [...attachmentTypes] },
  links: { learnMore: [] },
  usageBanner: { warnPercent: 80 },
  planLabel: null,
  scheduledTasks: { enabled: true, maxTasks: null },
  approvalsAlwaysAllow: true,
  memory: {
    enabled: true,
    searchChats: true,
    generate: true,
    defaultOn: false,
    model: null,
  },
  research: { enabled: true, xSearch: true, maxSearchesPerTurn: 30 },
  browser: { ...openBrowser },
  sshRemote: true,
  codexRuntimeMirror: null,
  computerUse: {
    enabled: true,
    allowFullControl: true,
    deniedApps: [],
    maxActionsPerTurn: null,
  },
  revision: 0,
};

/** Computer use while no service has allowed it. */
const computerUseOff: ComputerUsePolicy = {
  enabled: false,
  allowFullControl: false,
  deniedApps: [],
  maxActionsPerTurn: null,
};

/**
 * Before the service's policy arrives: changing which programs run on this
 * computer (local MCP servers) and computer use wait; everything else stays
 * usable (SSH, the browser, memory; the memory and SSH packages hold back
 * their own server writes and mirror downloads while `pending`).
 */
export const pendingPolicy: ClientPolicy = {
  ...openPolicy,
  localMcpEditing: false,
  developerModeEnabled: false,
  computerUse: computerUseOff,
  pending: true,
};

/**
 * Offline with no policy kept from an earlier answer: like the pending
 * policy, and only the MCP servers already configured may run (none can be
 * added). Bypass permissions stays the user's choice.
 */
export function offlinePolicy(
  settings: Pick<Settings, "mcpServers">,
): ClientPolicy {
  return {
    ...pendingPolicy,
    connectors: Object.keys(settings.mcpServers).map((name) => ({ name })),
  };
}

/** Used when the operator's policy file cannot be read: nothing optional runs. */
export const lockedPolicy: ClientPolicy = {
  permissionModes: ["manual", "plan"],
  incognito: false,
  webSearch: false,
  webSearchDefault: false,
  voice: false,
  localMcpEditing: false,
  developerModeEnabled: false,
  remoteImages: false,
  remoteImageDomains: [],
  externalLinks: false,
  trustedLinkDomains: [],
  connectors: [],
  attachments: { maxBytes: null, types: [] },
  links: { learnMore: [] },
  usageBanner: { warnPercent: 80 },
  planLabel: null,
  scheduledTasks: { enabled: false, maxTasks: null },
  approvalsAlwaysAllow: false,
  memory: {
    enabled: false,
    searchChats: false,
    generate: false,
    defaultOn: false,
    model: null,
  },
  research: { enabled: false, xSearch: false, maxSearchesPerTurn: 30 },
  // The browser runs on this computer and is not locked (design R8 5.2).
  browser: { ...openBrowser },
  sshRemote: false,
  codexRuntimeMirror: null,
  computerUse: computerUseOff,
  revision: 0,
};

/** The built-in search cap of one Research turn (the service's default). */
export const defaultMaxSearchesPerTurn = 30;

/**
 * The Research policy in force: the service's, or for a service that sends
 * none, Research and X search follow web search. Web search off always
 * turns both off.
 */
export function researchPolicyOf(
  policy: Pick<ClientPolicy, "webSearch" | "research">,
): ResearchPolicy {
  const research = policy.research ?? {
    enabled: true,
    xSearch: true,
    maxSearchesPerTurn: defaultMaxSearchesPerTurn,
  };
  return policy.webSearch
    ? research
    : { ...research, enabled: false, xSearch: false };
}

/** The browser policy in force; a service that sends none allows the browser. */
export const browserPolicyOf = (policy: Pick<ClientPolicy, "browser">) =>
  policy.browser ?? openBrowser;

/**
 * Whether a host is one of the browser's blocked domains or under one
 * (`example.com` blocks `mail.example.com`; a leading `*.` means the same).
 */
export function browserHostBlocked(
  policy: Pick<ClientPolicy, "browser">,
  host: string,
) {
  const name = host.toLowerCase().replace(/\.$/, "");
  return browserPolicyOf(policy).blockedDomains.some((entry) => {
    const domain = entry.toLowerCase().replace(/^\*\./, "");
    return name === domain || name.endsWith(`.${domain}`);
  });
}

/** Whether SSH remote environments may be used (a service that sends nothing allows them). */
export const sshRemoteAllowed = (policy: Pick<ClientPolicy, "sshRemote">) =>
  policy.sshRemote !== false;

/** The computer-use policy in force; off unless a policy allows it. */
export const computerUsePolicyOf = (
  policy: Pick<ClientPolicy, "computerUse">,
): ComputerUsePolicy => policy.computerUse ?? computerUseOff;

type ModeSettings = Pick<
  Settings,
  | "codeSandbox"
  | "codePlanMode"
  | "autoAcceptEdits"
  | "bypassFolders"
  | "allowBypassPermissions"
>;

/** Whether the policy lets Code run in a mode; Bypass is never restricted. */
export const modeAllowed = (
  policy: Pick<ClientPolicy, "permissionModes">,
  mode: PermissionMode,
) => mode === "bypass" || policy.permissionModes.includes(mode);

/**
 * The mode Code runs in. With a folder, Bypass outside a confirmed folder
 * runs as Auto; without one, the stored choice is reported.
 */
export function permissionModeOf(
  settings: ModeSettings,
  cwd?: string | null,
): PermissionMode {
  if (settings.codePlanMode) return "plan";
  const sandbox =
    cwd === null
      ? settings.codeSandbox
      : codeSandboxFor({ ...settings, codePlanMode: false }, cwd ?? undefined);
  if (sandbox === "danger-full-access") return "bypass";
  if (settings.autoAcceptEdits) return "acceptEdits";
  return sandbox === "read-only" ? "manual" : "auto";
}

/** The mode a turn actually runs in, from the sandbox the platform left it. */
export function runningMode(
  settings: Pick<Settings, "codePlanMode" | "autoAcceptEdits">,
  sandbox: Settings["codeSandbox"],
): PermissionMode {
  if (settings.codePlanMode) return "plan";
  if (sandbox === "danger-full-access") return "bypass";
  if (sandbox === "read-only") return "manual";
  return settings.autoAcceptEdits ? "acceptEdits" : "auto";
}

/** The settings a mode stands for (Bypass also needs its folder confirmed). */
export function modeSettings(
  mode: Exclude<PermissionMode, "bypass">,
): Pick<Settings, "codeSandbox" | "autoAcceptEdits" | "codePlanMode"> {
  return {
    codeSandbox:
      mode === "manual" || mode === "plan" ? "read-only" : "workspace-write",
    autoAcceptEdits: mode === "acceptEdits",
    codePlanMode: mode === "plan",
  };
}

const fallbackOrder: PolicyMode[] = ["auto", "manual", "plan", "acceptEdits"];
/**
 * Moves a stored mode the administrator no longer allows to the first allowed
 * one (never to Bypass, never away from it). Returns undefined when nothing
 * needs to change.
 */
export function settingsWithinPolicy<T extends ModeSettings>(
  settings: T,
  policy: Pick<ClientPolicy, "permissionModes">,
): T | undefined {
  const current = permissionModeOf(settings, null);
  if (modeAllowed(policy, current)) return undefined;
  const next =
    fallbackOrder.find((mode) => policy.permissionModes.includes(mode)) ??
    "manual";
  return { ...settings, ...modeSettings(next) };
}

export const modeRefusal = (mode: PolicyMode) =>
  `Your administrator doesn't allow ${permissionModeTitles[mode]} mode.`;

/** Why MCP servers cannot be added or changed right now. */
export const mcpEditingRefusal = (policy: Pick<ClientPolicy, "pending">) =>
  policy.pending
    ? "MCP servers can be changed once Claudex reaches your service."
    : "Your administrator has turned off adding MCP servers.";

export type McpMap = Record<string, unknown>;
const withoutEnabled = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  // `tools` holds the per-tool approval modes (Always allow / Needs approval):
  // choices about asking, not edits of the server; the engine drops "approve"
  // while the administrator requires approving each request.
  const {
    enabled: _enabled,
    tools: _tools,
    ...rest
  } = value as Record<string, unknown>;
  return rest;
};
/** Only the connector switches (`enabled`, tool approvals) changed, no server was added, removed or edited. */
export function onlyConnectorSwitches(before: McpMap, after: McpMap) {
  const names = Object.keys(before);
  if (
    names.length !== Object.keys(after).length ||
    !names.every((name) => name in after)
  )
    return false;
  return names.every(
    (name) =>
      JSON.stringify(withoutEnabled(before[name])) ===
      JSON.stringify(withoutEnabled(after[name])),
  );
}

/** Why the administrator's policy refuses a settings change, if it does. */
export function settingsRefusal(
  before: ModeSettings & { mcpServers: McpMap },
  after: ModeSettings & { mcpServers: McpMap },
  policy: ClientPolicy,
): string | undefined {
  const mode = permissionModeOf(after, null);
  if (mode !== permissionModeOf(before, null) && !modeAllowed(policy, mode))
    return modeRefusal(mode as PolicyMode);
  if (
    !policy.localMcpEditing &&
    !onlyConnectorSwitches(before.mcpServers, after.mcpServers)
  )
    return mcpEditingRefusal(policy);
  return undefined;
}

export const sameList = (a: unknown, b: string[] | undefined) =>
  JSON.stringify(Array.isArray(a) ? a : []) === JSON.stringify(b ?? []);
