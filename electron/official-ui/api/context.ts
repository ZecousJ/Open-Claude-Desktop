/**
 * What the API adapter reads from the running app: the signed-in account,
 * its settings and conversations, and the app's event stream. Kept behind
 * this interface so the adapter can run in the desktop main process now and
 * in the runner (for the web) later without touching the route code.
 */
import type http from "node:http";
import { createHash } from "node:crypto";
import type { ProjectMetadataPatch } from "../../../shared/project-access";
import type { ModelCatalog } from "../../../shared/model-catalog-api";
import type { mcpElicitationResponse } from "../../../shared/mcp-elicitation";
import type {
  AppEvent,
  Approval,
  Conversation,
  Project,
  PublicAccount,
  Settings,
} from "../../../shared/types";

export interface AdapterContext {
  designArtifacts?: {
    create(input: import("../design-creation").OfficialDesignCreationInput): Promise<{ slug: string }>;
  };
  codeLimitAutoResume?: import("../../engine/code-limit-auto-resume").CodeLimitAutoResume;
  deviceRegistryRequest?(request: import("./device-registry").DeviceRegistryRequest): Promise<unknown>;
  officialDesktopCloudCode?: import("./desktop-cloud-code").DesktopCloudCode;
  dispatch?: import("../../../shared/dispatch-api").OfficialDispatch;
  dispatchReceiver?: import("../../../shared/official-dispatch").DispatchReceiver;
  localRemoteControlStatus?(): ReturnType<import("../../remote-control/device-link").DeviceLink["remoteControlStatus"]> | undefined;
  officialRemoteControlOrigin?(): string | undefined;
  officialRemoteCode?: ReturnType<typeof import("../../../shared/official-remote-code-controller").createOfficialRemoteCodeController>;
  webSearchAllowed?(): boolean;
  apiManagement?: import("../../../shared/official-api-management").ApiManagement;
  serviceStatus?: import("../../../shared/service-status-api").ServiceStatusAPI["serviceStatus"];
  announcements?: import("../../../shared/announcements-api").OfficialAnnouncements;
  zecousMigration?: import("../../../shared/zecous-migration-api").OfficialZecousMigration;
  builtInBrowserSettingsAvailable?(): boolean;
  chromeExtension?: {
    status(): { enabled: boolean; bundlePath: string; connected: boolean };
    configure(enabled: boolean): Promise<{ enabled: boolean; bundlePath: string; connected: boolean }>;
    revealBundle(): Promise<void>;
    onStatusChanged?(listener: () => void): () => void;
  };
  remoteReachabilityPreferenceAvailable?(): boolean;
  codeLocalSandboxState?(): { available: boolean; policyLocked: boolean; windowsInstalled?: boolean };
  computerUseSettingsState?(): import("../../computer-use/service").ComputerUseSettingsState | undefined;
  computerUseActivity?(): import("../../../shared/computer-use").ComputerUseActivity | null;
  revokeComputerUseGrant?: (conversationId: string, appId: string) => Promise<void>;
  registerOfficialCodeArchiveHold?: (held: (id: string) => boolean) => () => void;
  officialCodeManualKeepAwake?(id: string): boolean;
  setOfficialCodeManualKeepAwake?(id: string, enabled: boolean): void;
  setOfficialCodeVisibility?: (window: import("electron").BrowserWindow, id: string, visible: boolean) => void;
  readOfficialCodeArchivePullRequests?: typeof import("../../conversations/auto-archive-pull-requests").readDesktopArchivePullRequests;
  localMcpConfig?(): string;
  onAccountDeactivating?(listener: () => void): () => void;
  documentRuntime?: string;
  /** The active desktop account's existing hosted publication service. */
  artifactPublishing?(): import("../../artifacts/hosted-shares").HostedShares | undefined;
  knowledgeOffer?(): ReturnType<typeof import("../../ipc/knowledge").loadKnowledgeOffer>;
  sideQuestionGateway?(conversation: Conversation, model: string, signal: AbortSignal): Promise<import("./side-question-gateway").SideQuestionGateway>;
  /** Installed only for the guarded Web runner's own Code history. */
  readonly officialCodeHistory?: boolean;
  readonly officialCodeTriggerModes?: readonly ("code" | "cowork")[];
  readonly officialCodeTriggerWrites?: boolean;
  officialCodeRoutineFireUrl?(triggerId: string): string;
  forwardOfficialCodeTrigger?(request: import("../../../shared/official-ui-web").OfficialUiReadRequest):
    Promise<import("../../../shared/official-ui-web").OfficialUiReadResponse | undefined>;
  readonly officialCodeRewindAvailable?: boolean;
  readonly officialCodeTerminalAvailable?: boolean;
  readonly officialCodeWorkspaceDiffAvailable?: boolean;
  officialCodeWorkspaceDirectory?(conversation: Conversation): string | undefined;
  officialCodeApprovals?(): readonly Approval[];
  officialCodeStopPersistence?: {
    confirmed(conversation: Conversation): boolean;
    confirm(conversation: Conversation): Promise<boolean>;
  };
  officialCodeHeldInputs?(conversationId: string): {
    unreadInputUuids: string[];
    sendsHeldAfterError: string[];
  } | undefined;
  officialCodeQueueInputs?(conversationId: string): import("../../../shared/official-code-followup").OfficialCodeQueueInput[] | undefined;
  officialCodeCommands?(conversationId: string): Promise<import("../../../shared/official-code-history").OfficialCodeCommand[]> | undefined;
  officialCodeAgentHistory?(conversationId: string, agentId: string, resume: boolean): Promise<Conversation | undefined>;
  officialCodeCommandControls?(id: string): import("../../../shared/official-code-approval").OfficialCodeApprovalControl[];
  officialCoworkApprovalControls?(id: string): import("../../../shared/official-code-approval").OfficialCodeApprovalControl[];
  readonly officialCoworkHistory?: boolean;
  readonly officialCoworkFollowupAvailable?: boolean;
  isCloudConversation?(id: string): boolean;
  captureOfficialOrganizationProjectChat?(): ((
    request: import("../../../shared/official-ui-web").OfficialUiReadRequest,
    signal: AbortSignal,
  ) => Promise<import("../../../shared/official-ui-web").OfficialUiReadResponse | undefined>) | undefined;
  isCloudProject?(id: string): boolean;
  readonly officialCodeUpload?: boolean;
  readonly officialChatUpload?: boolean;
  /** Native auxiliary completion through the active account's metered gateway. */
  completeCodeTitle?(
    prompt: Parameters<import("../../memory/completion").Completer>[0],
    options: import("../../memory/completion").CompletionOptions & { model?: string },
  ): Promise<string>;
  readModelPreference?(surface: string): import("../../../shared/model-catalog-api").ModelSelectorPreference;
  saveModelPreference?(surface: string, patch: { model?: string | null; thinking?: import("../../../shared/model-catalog-api").ModelSelectorPreference["thinking"] | null }): Promise<void>;

  /** Native-only ordinary Code approvals, bound to exact requests and account activation. */
  codeCommandPermissions?: import("../code-command-permission-host").CodeCommandPermissionHost;
  respondToLocalCodeElicitation?(
    approval: Approval,
    response: NonNullable<ReturnType<typeof mcpElicitationResponse>>,
  ): void;
  /** Optional host-owned ordinary-command decline only; no generic approval fallback. */
  commandDeclines?: import("../command-decline-host").CommandDeclineHost;
  chatElicitation?: import("./chat-elicitation").ChatElicitationHost;
  chatComputerUse?: ReturnType<typeof import("./chat-computer-use").chatComputerUseHost>;
  readonly allowCompletionConnectorMetadata?: boolean;
  readonly chatPermissionModes?: readonly import("../../../shared/chat-permission-mode").ChatPermissionMode[];
  /** Transport byte budget for generated-file snapshots; native hosts use the snapshot limit. */
  generatedFileReadMaxBytes?: number;
  readWorkspaceDownload?(request: import("../../../shared/official-ui-web").OfficialUiReadRequest):
    Promise<import("../../../shared/official-ui-web").OfficialUiReadResponse | undefined>;
  authorizeMemoryAction?(action: import("../../../shared/official-memory-capability").OfficialMemoryAction): void;
  memoryResetAvailable?(): boolean;
  memoryGenerationAvailable?(): boolean;
  memoryPreferenceActions?(): import("../../../shared/official-memory-capability").OfficialMemoryPreferenceActions | undefined;
  readMemorySettings?(): Promise<import("../../../shared/memory-api").MemoryStatus | undefined>;
  melange?(discover?: boolean): Promise<import("../../memory/melange").Melange | undefined>;
  melangeSignal?(): AbortSignal | undefined;
  classicMelangeSources?(): Promise<readonly { scope: import("../../memory/types").MemoryScope; content: string }[]>;
  /** Installed only by a reviewed native host; identifiers are not content/path grants. */
  openStaticArtifactPreview?(selection: import("./static-artifact-preview").StaticArtifactSelection): Promise<{opened:true}>;
  /** Optional explicit executor attachment boundary; absent means unsupported. No legacy-send fallback. */
  prepareCompletionAttachments?(input: import("./completion-attachments").CompletionAttachmentInput): Promise<import("./completion-attachments").PreparedCompletionAttachment[]>;
  submitCompletionWithAttachments?(send: Record<string, unknown>, attachments: import("./completion-attachments").PreparedCompletionAttachment[]): Promise<Conversation>;
  /** Internal native upload receipt reader; absent on Web, never renderer-issued authority. */
  readConfirmedUpload?(conversationId: string, rowId: string): Promise<(import("../../cloud/upload-receipts").ConfirmedUploadReceipt & {data: Uint8Array}) | undefined>;
  /** Set only by createApiAdapter for its actually installed strict Chat completion transport. */
  readonly completionProtocol?: "text-chat-v1";
  readonly usageSummaryProtocol?: "readonly-v1";
  /** build/official-ui */
  root: string;
  account(): PublicAccount | undefined;
  readPluginOrganization?(target: import("../../../shared/official-plugin-organizations").OfficialPluginOrganizationTarget): Promise<unknown>;
  organizationProjects?: import("./organization-projects").OrganizationProjectService;
  setOrganizationPluginEnabled?(id: string, enabled: boolean): Promise<unknown>;
  removeOrganizationPlugin?(id: string): Promise<unknown>;
  readOrganizationPluginStates?(candidates: import("../../../shared/official-organization-catalog").OrganizationRuntimeCandidates):
    Promise<import("../../../shared/official-organization-catalog").OrganizationRuntimeStates | undefined>;
  readOrganizationPluginDetails?(id: string):
    Promise<Awaited<ReturnType<import("../../plugins/organization-plugins").OrganizationPlugins["details"]>> | undefined>;
  browserAccountsAvailable?(): boolean;
  locationMetadataAvailable?(): boolean;
  settings(): Settings;
  /** The agent-owned workspace, whose folders do not require an extra trust prompt. */
  defaultWorkspace?(): string;
  /** Desktop-only: mint and authorize a new empty Code workspace owned by the active account. */
  createScratchWorkspace?(): { cwd: string };
  /** Optional account-specific storage root for a multi-user host. */
  stateDirectory?(): string;
  codeSessionEnvironmentStore?(): import("../../store/store").Store;
  /** Stable for one activation, replaced when an account is signed out/reopened. */
  sessionIdentity?(): unknown;
  withOfficialApiScope?<T>(operation: () => T): T;
  /** False once a request's captured account has been retired. */
  isCurrent?(): boolean;
  /** A restricted host must not advertise mutations it does not expose. */
  readOnly?: boolean;
  spendLimitMutation?: {
    activationLease: string;
    current(): boolean;
    save?(limitUsd: number | null): Promise<import("../../../shared/billing-api").SpendLimit>;
  };
  officialCodeSettingsAvailable?: boolean;
  codeUltracodeAvailable?(providerId: string, model: string, conversationId?: string): boolean;
  officialCodeSettingsCloudLinked?(): boolean;
  refreshOfficialCodeSettings?(): Promise<void>;
  saveOfficialCodeSettings?(patch: import("../../../shared/official-code-settings").CodeSettingsPatch): Promise<boolean>;
  allowSkillCreation?: boolean;
  allowSkillUpload?: boolean;
  allowSkillDelete?: boolean;
  allowSkillVersionSave?: boolean;
  allowSkillToggle?: boolean;
  allowSkillCopyRename?: boolean;
  /** The active Web request can select an exact stored Chat leaf. */
  allowChatLeafSelection?: boolean;
  /** The host authorizes retrying a stored Chat response through its engine. */
  allowChatRetry?: boolean;
  /** The host authorizes a REST edit of the first stored Chat prompt. */
  allowChatRootEdit?: boolean;
  allowChatBulkDelete?: boolean;
  allowIncognitoDiscard?: boolean;
  /** A Web host can publish account-owned saved Chat revisions. */
  allowArtifactPublishing?: boolean;
  allowConversationSharing?: boolean;
  /** The active host can send Chat artifact review prompts. */
  allowChatArtifactReview?: boolean;
  /** The host can validate and persist the original rich quote action. */
  richQuoteActions?: boolean;
  /** A restricted host can permit the exact conversation-to-project action. */
  allowConversationProjectMove?: boolean;
  updateProjectMetadata?(projectId: string, patch: ProjectMetadataPatch): Promise<Project | undefined>;
  authorizeProjectMemoryUpdate?(projectId: string): boolean;
  createProject?(project: Project): Promise<Project>;
  deleteProject?(projectId: string): Promise<void>;
  allowProjectKnowledgeChanges?: boolean;
  /** Optional exact, per-request appearance permission; never authorizes other settings. */
  authorizeAppearanceSettings?(): Promise<void>;
  authorizeConnectorPreferences?(kind: "account" | "chat", pageId?: string): void;
  readonly allowCustomConnectorCreation?: boolean;
  readonly allowDirectorySubmissions?: boolean;
  readonly directoryTermsUrl?: string;
  connectorAuthPromptAvailable?(name: string, url: string): boolean;
  connectorAlwaysAllow?(): boolean;
  mcpAppToolbox?(): import("./mcp-app-toolbox").McpAppToolboxHost | undefined;
  remoteConnectorSkills?(): import("../../connectors/remote-skills").RemoteConnectorSkills | undefined;
  authorizeCustomConnector?(kind: "add" | "probe"): void;
  authorizeConnectorLifecycle?(target: import("../../../shared/official-ui-web").OfficialConnectorLifecycleTarget, name: string): void;
  chatConnectorChoicesForAction?(pageId: string): import("../../../shared/official-connector-preferences").OfficialToolPreferences | undefined;
  /** Atomic server-side font patch against the captured account; no general settings payload. */
  saveAppearanceLocale?(locale: string): Promise<void>;
  saveAppearanceFont?(
    font: import("../../../shared/types").ChatFont,
  ): Promise<void>;
  /** Reject unsupported message branches instead of silently sending at the leaf. */
  strictActionSemantics?: boolean;
  /** The account's conversations as the renderer's snapshot lists them (local and cloud merged). */
  listConversations(): Promise<Conversation[]>;
  conversationInventory?(): readonly import("../../../shared/web-docs").ConversationMeta[] | undefined;
  /** One conversation with its turns (a cloud conversation's turns come from the runner). */
  loadConversation(id: string): Promise<Conversation | undefined>;
  /** The app's event stream; returns the unsubscribe function. */
  onEvent(listener: (event: AppEvent) => void): () => void;
  createEmptyChat?(input: import("./chat-creation").EmptyChatInput): Promise<Conversation>;
  /** Calls an IPC handler by name (the renderer's `window.desktop` methods). */
  call(name: string, ...args: unknown[]): Promise<unknown>;
  /** Desktop-only calls that must stay on this computer rather than cloud routing. */
  localCall?(name: string, ...args: unknown[]): Promise<unknown>;
  /** Preserve the invoking native window across asynchronous host handlers. */
  withCallerWindow?<T>(window: unknown, operation: () => T): T;
  /** Desktop-only local sessions, excluding cloud-mirrored records. */
  localListConversations?(): Promise<Conversation[]>;
  localLoadConversation?(id: string): Promise<Conversation | undefined>;
  warmCodeSession?(conversation: Conversation): Promise<void>;
  sshCodeEnvironment?(conversation: Conversation): {
    remoteTarget: {
      kind: "ssh";
      sshHost: string;
      sshPort?: number;
      sshIdentityFile?: string;
      remoteCwd: string;
    };
    homePath?: string;
  } | undefined;
  reconnectSshCodeSession?(
    conversation: Conversation,
    trigger: "open" | "retry",
    canContinue: () => boolean,
  ): Promise<boolean>;
  /** The account's model catalog from the Claudex service (null before sign-in or without one). */
  modelCatalog(): Promise<ModelCatalog | null>;
  /** Reply ratings by JSON [conversationId, turnId] (electron/conversations/reply-feedback.ts). */
  ratings?(): Record<string, "up" | "down">;
  /** The renderer snapshot (settings, projects, ratings, …), local and cloud merged. */
  snapshot(fresh?: boolean): Promise<import("../../../shared/types").Snapshot>;
  /** Image helpers (Electron's nativeImage on the desktop); absent where none exist. */
  image?: {
    size(data: Buffer): { width: number; height: number } | undefined |
      Promise<{ width: number; height: number } | undefined>;
    /** A PNG no larger than `max` pixels on its long side; undefined when the bytes are not an image. */
    thumbnail?(data: Buffer, max: number): Buffer | undefined;
  };
  /** Opens Claudex's own top-up window on Add funds or Billing (the desktop); absent where there is none. */
  openCheckout?(view: "topup" | "billing"): void;
  appVersion: string;
  /** Desktop-local authorization for the isolated official document renderer. */
  documentPreviewToken?(): string;
  log(...args: unknown[]): void;
}

/** One organization per account, with a stable UUID derived from the account id. */
export function organizationUuid(accountId: string) {
  const hex = createHash("sha256")
    .update("claudex-official-ui-organization:" + accountId)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function reply(
  res: http.ServerResponse,
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(data));
  return true;
}

export function empty(res: http.ServerResponse, status = 204) {
  res.writeHead(status);
  res.end();
  return true;
}

export function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function readJson(req: http.IncomingMessage): Promise<any> {
  const body = await readBody(req);
  if (!body.length) return {};
  return JSON.parse(body.toString("utf8"));
}

