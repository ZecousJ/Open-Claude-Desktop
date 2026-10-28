import { McpConnectionLogs } from "../connectors/mcp-connection-logs";
import { chatSuggestionsExtension } from "./chat-suggestions";
import { codeNotificationsExtension } from "./code-notifications";
import { CapabilityTipJudge } from "./capability-tips";
import {
  eligibleCapabilityTips,
  tipAvailability,
} from "../../shared/capability-tips";
import { connectorSearchExtension } from "../connectors/connector-search";
import { StartTiming } from "../app/start-timing";
import { GeneratedBlobs } from "../artifacts/generated-blobs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderServiceClient } from "./provider-service-client";
import type { AgentPromptEvent } from "../../server/agent-prompt-observer";
import type { GatewayRefusal } from "../../server/sub2api-errors";
import { UsageLedger } from "../conversations/usage-ledger";
import { CodexRPC } from "./rpc";
import { SideChats } from "./side-chats";
import { GatewaySignals } from "./gateway-signals";
import {
  SshWorkspaceTrustStore,
  sshWorkspaceTrustFile,
} from "../workspace/workspace-trust";
import { Store } from "../store/store";
import { gatewayCompleter } from "../memory/completion";
import { TitleOfferGenerator } from "./title-offers";
import { CodeSessionAssistance } from "./code-session-assistance";
import { WindowsSandbox } from "../workspace/windows-sandbox";
import type { RequestLimits } from "../../server/operator-limits";
import { pendingPolicy, type ClientPolicy } from "../../shared/client-policy";
import type {
  AppEvent,
  Approval,
  Attachment,
  Conversation,
  EnvironmentRef,
  Snapshot,
  Turn,
  UsageRange,
} from "../../shared/types";
import { type ModelContextLimits } from "../../shared/agent-api";
import type { RoutineAllowed } from "../../shared/routines";
import { EngineExtensions, type EngineExtension } from "./engine-extensions";
import { PendingItemPatches } from "./item-patches";
import {
  sameEnvironment,
  EngineOptions,
  EnginePeers,
  WorkflowThreadListener,
} from "./engine-types";
import {
  localEgress,
  localEgressSupported,
  type LocalEgress,
} from "../../shared/local-egress";
import * as engineLifecycle from "./engine-lifecycle";
import { installMethods } from "./install-methods";
import type {} from "./engine-method-types";
import * as engineTurnSetup from "./engine-turn-setup";
import * as engineSend from "./engine-send";
import * as engineEvents from "./engine-events";
import * as engineApprovals from "./engine-approvals";
import * as engineHistory from "./engine-history";
import * as engineHandoff from "./engine-handoff";
import * as engineTrust from "./engine-trust";
import * as engineAgents from "./engine-agents";
import * as engineGuards from "./engine-guards";
import * as engineStatus from "./engine-status";
export class Engine {
  rpc?: CodexRPC;
  gateway?: ProviderServiceClient;
  state: Snapshot["engine"] = { state: "stopped" };
  /**
   * The scheduler's "Always allowed" lists, set by whoever owns the scheduler:
   * a routine's run answers a listed request without asking, and an "Always
   * allow" chosen during a run is added to its routine's list.
   */
  routineApprovals?: {
    isUnattended?(conversation: Conversation): boolean;
    holdForConnection?(
      taskId: string,
      hold: import("../../shared/task-connection-hold").TaskConnectionHold,
    ): void;
    allowed(taskId: string): RoutineAllowed[];
    allow(taskId: string, entry: RoutineAllowed): void;
  };
  /** This engine's open requests; `approvals` adds the other engines' (R9). */
  ownApprovals: Approval[] = [];
  /** Every open approval request of the account's engines. */
  get approvals(): Approval[] {
    const others = (this.peers?.all() ?? []).filter((peer) => peer !== this);
    return [
      ...this.ownApprovals,
      ...others.flatMap((peer) => peer.ownApprovals),
    ];
  }
  set approvals(value: Approval[]) {
    this.ownApprovals = value;
  }
  /**
   * The account's other engines (R9-S3, set by EngineRegistry on the local
   * engine): a call about a conversation that runs elsewhere goes there.
   */
  peers?: EnginePeers;
  /** Whether the next start may ask the person questions (SSH sign-in). */
  interactiveStart = true;
  /** The outbox delivery in progress (SSH engines). */
  delivering?: Promise<void>;
  starting?: Promise<void>;
  providerId = "";
  loaded = new Set<string>();
  newTaskChecks = new Set<string>();
  routes = new Map<string, string>();
  /** What the gateway reports beside Codex's own events (gateway-signals.ts). */
  signals = new GatewaySignals({
    target: (threadId) => this.signalTarget(threadId),
    patchItem: (c, threadId, itemId, patch) =>
      this.patchItem(c, threadId, itemId, patch),
    changed: (c) => this.changed(c),
    gatewaySignal: (signal, target) =>
      this.extensions.gatewaySignal(signal, target),
    remote: () => Boolean(this.launcher),
    runningThread: () => this.runningThread(),
    imageFolder: () =>
      path.join(this.spaceRoot, "codex-home", "generated_images"),
  });
  /** Side chats and the handoff note, on ephemeral forks (side-chats.ts). */
  sides = new SideChats({
    rpc: () => this.rpc,
    gateway: () => this.gateway,
    store: () => this.store,
    policy: () => this.policy(),
    lastRefusal: () => this.lastRefusal,
    emit: (event) => this.emit(event),
    assertModel: (provider, model) => this.assertModel(provider, model),
    ensure: (provider) => this.ensure(provider),
    threadOptions: (c, provider, model, mode, project) =>
      this.threadOptions(c, provider, model, mode, project),
    loaded: (threadId) => this.loaded.has(threadId),
    ensureThread: (c, options) => this.ensureThread(c, options),
  });
  titleOffers: TitleOfferGenerator;
  sessionAssistance: CodeSessionAssistance;
  capabilityTips: CapabilityTipJudge;
  capabilityTipHost = {
    localFolders: true,
    cloudCowork: false,
    scheduledTasks: true,
  };
  capabilityTipMemory: () =>
    import("../../shared/memory-api").MemoryStatus | undefined = () =>
    undefined;
  safeguardModels = new Map<string, string[]>();
  /** The Code switch belongs to this host: local on desktop, cloud on web. */
  codeSafeguardScope: "local" | "cloud" = "local";
  /** Workflow agents' threads (electron/workflows) and who listens to each. */
  workflowThreads = new Map<string, WorkflowThreadListener>();
  agentRoutes = new Map<string, string>();
  pendingAgentPrompts = new Map<
    string,
    Pick<AgentPromptEvent, "message" | "model">
  >();
  pendingSend = false;
  /**
   * The turn a send shows before the engine is ready (early send): it is
   * not the engine's work yet, so it neither blocks a start nor is
   * interrupted by the stop a start begins with.
   */
  earlyTurn?: Turn;
  /** Stops the repository fetch of a cloud session's start (interrupt). */
  setupAbort?: { conversationId: string; abort: AbortController };
  notificationTimer = new Map<string, NodeJS.Timeout>();
  intentionalStop = false;
  windowsSandbox: WindowsSandbox;
  private usageLedger: UsageLedger;
  /** The last Sub2API refusal; its wording replaces the agent's generic HTTP error on the failed turn. */
  lastRefusal?: GatewayRefusal & { at: number };
  /** Why no model can be used right now (a Sub2API balance, plan or key problem). */
  unavailableReason?: string;
  /**
   * Restricted commands keep the engine's own network (the web runner,
   * whose sandbox limits the network itself: turnSandboxPolicy). The policy
   * then goes with every turn.
   */
  sandboxNetwork = false;
  /**
   * Chat's code on this computer reaches the network as Settings →
   * Capabilities allows (shared/local-egress.ts). Set by the desktop only.
   */
  localEgress = false;
  /** The running agent's config.toml has the egress profile. */
  startedEgressProfile = false;
  /** What this computer's Chat code may reach, when the desktop applies it. */
  egress(): LocalEgress {
    return this.localEgress &&
      !this.launcher &&
      !this.sandboxNetwork &&
      localEgressSupported(process.platform)
      ? localEgress(this.store.settings)
      : { kind: "off" };
  }
  /** The administrator's policy, read again for every check. */
  policy: () => ClientPolicy = () => pendingPolicy;
  /**
   * Context limits for a model (E0); the remote host binds this to the
   * service's model catalog. undefined keeps Codex's own limits (it compacts
   * at 90% of the window it knows for the model).
   */
  modelLimits: (
    providerId: string,
    model: string,
  ) => ModelContextLimits | undefined = () => undefined;
  /**
   * The device keys of an account's other service groups that could not be
   * stored encrypted, by vault entry (MG); handed to the gateway at start
   * like the provider's own session key. The remote host binds it.
   */
  groupKeys: (providerId: string) => Record<string, string> = () => ({});
  /** The limits key each loaded native thread was started or resumed with. */
  threadLimits = new Map<string, string>();
  /** Steered messages Codex has not handed to the model yet, by client id. */
  steers = new Map<
    string,
    { turnId: string; text: string; attachments: Attachment[] }
  >();
  /** The MCP servers, extension environment and config the running agent was started with. */
  startedMcp = "";
  /**
   * Round-two feature hooks (S1): instructions, dynamic tools, per-thread MCP
   * servers, thread config and extra writable folders. Feature packages add
   * to it from their own register functions.
   */
  readonly extensions = new EngineExtensions();
  /**
   * Extensions every peer (an isolated space's engine, the web runner) gets
   * too when it is created: the GitHub tools of a cloud Code session.
   */
  peerExtensions: EngineExtension[] = [];
  /** Item fields from gateway signals that arrived before their item. */
  pendingPatches = new PendingItemPatches(512);
  /**
   * The gateway asks the model to describe every shell command (R7). Off
   * leaves the tool schemas as Codex sends them.
   */
  describeTools = true;
  /**
   * A model's built-in search abilities from the service's model catalog;
   * undefined when the catalog says nothing (R45). Bound by the host.
   */
  searchCapabilities: (
    providerId: string,
    model: string,
  ) => { xSearch?: boolean } | undefined = () => undefined;
  /**
   * The image model every picture is made with (sidebar → API); "" keeps
   * each request's own. Bound by the host.
   */
  imageModel: () => string = () => "";
  /** The request options last sent to the running gateway. */
  sentRequestOptions = "";
  constructor(
    public store: Store,
    public binary: string,
    public secret: (id: string) => string,
    public emit: (event: AppEvent) => void,
    public serviceScript = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../dist-server/provider-service.cjs",
    ),
    public vaultKey?: string,
    public vaultRoot?: string,
    public limits?: RequestLimits,
    public onRefusal?: (refusal: GatewayRefusal) => void,
    readonly options: EngineOptions = {},
  ) {
    // Hosts are Linux or macOS: the Windows sandbox is this computer's only.
    this.windowsSandbox = new WindowsSandbox(
      store.root,
      options.launcher ? "linux" : process.platform,
    );
    this.usageLedger = new UsageLedger(store.root);
    this.titleOffers = new TitleOfferGenerator(
      (conversation) =>
        gatewayCompleter(async () => {
          const endpoint = this.gatewayEndpoint();
          if (
            !endpoint ||
            this.providerId !== conversation.providerId ||
            this.policy().update?.state === "required"
          )
            return undefined;
          return { ...endpoint, model: conversation.model };
        }),
      (id) =>
        this.store.conversations.find((conversation) => conversation.id === id),
      (conversation) => this.changed(conversation, true),
    );
    this.extensions.add(chatSuggestionsExtension());
    this.extensions.add(codeNotificationsExtension(() => this.store.settings));
    this.extensions.add(connectorSearchExtension(() => this.store.settings));
    this.capabilityTips = new CapabilityTipJudge(
      (conversation) =>
        gatewayCompleter(async () => {
          const endpoint = this.gatewayEndpoint();
          if (
            !endpoint ||
            this.providerId !== conversation.providerId ||
            this.policy().update?.state === "required"
          )
            return undefined;
          return { ...endpoint, model: conversation.model };
        }),
      (id) =>
        this.store.conversations.find((conversation) => conversation.id === id),
      (conversation) =>
        eligibleCapabilityTips(conversation, this.store.settings, {
          ...tipAvailability(
            this.capabilityTipHost,
            this.store.projects.some((project) => !project.archivedAt),
          ),
          scheduledTasks:
            this.capabilityTipHost.scheduledTasks &&
            this.policy().scheduledTasks.enabled,
          memory: this.capabilityTipMemory(),
          incognito: this.policy().incognito,
          fileUploads: this.policy().attachments.types.length > 0,
          screenshots: this.policy().attachments.types.some((type) =>
            ["png", "jpg", "jpeg", "webp", "gif"].includes(type),
          ),
        }),
      (conversation) => this.changed(conversation, true),
    );
    this.sessionAssistance = new CodeSessionAssistance(
      () => this.store.settings,
      (conversation) =>
        gatewayCompleter(async () => {
          const endpoint = this.gatewayEndpoint();
          if (
            !endpoint ||
            this.providerId !== conversation.providerId ||
            this.policy().update?.state === "required"
          )
            return undefined;
          return { ...endpoint, model: conversation.model };
        }),
      (id) =>
        this.store.conversations.find((conversation) => conversation.id === id),
      (conversation) => this.changed(conversation, true),
    );
    this.indexAgentRoutes();
  }
  /**
   * The window's id for a Codex request. Every app-server numbers its own
   * requests, so an SSH engine's carry the host (R9): "ssh:<host>:<id>",
   * and an isolated space's its space: "space:<id>:<id>".
   */
  approvalId(requestId: string | number): string | number {
    const environment = this.environment;
    if (environment.kind !== "ssh" && environment.kind !== "space")
      return requestId;
    const owner =
      environment.kind === "ssh"
        ? `ssh:${environment.hostId}`
        : `space:${environment.spaceId}`;
    const id = `${owner}:${typeof requestId}:${requestId}`;
    this.requestIds.set(id, requestId);
    return id;
  }
  /** The app-server's own id for a request (see approvalId). */
  requestIdOf(id: string | number): string | number {
    return typeof id === "string" ? (this.requestIds.get(id) ?? id) : id;
  }
  /** Window ids of an SSH engine's requests → the app-server's ids. */
  requestIds = new Map<string, string | number>();
  /** Where this engine runs its conversations. */
  get environment(): EnvironmentRef {
    return this.options.environment ?? { kind: "local" };
  }
  /** A conversation this engine runs (its environment is this engine's). */
  owns(c: Pick<Conversation, "environment">) {
    return sameEnvironment(c.environment, this.environment);
  }
  /** The folder of this engine's `codex-home` and default `workspace`. */
  get spaceRoot() {
    return this.options.root ?? this.store.root;
  }
  /** CODEX_HOME on this computer (its config.toml records trusted projects). */
  get codexHome() {
    return path.join(this.spaceRoot, "codex-home");
  }
  async resumeSessionRequest(
    method: "thread/list" | "thread/read",
    params: object,
  ) {
    const provider = this.store.settings.providers.find(
      (entry) => entry.id === this.store.settings.activeProviderId,
    );
    if (!provider) throw new Error("The model service is unavailable.");
    await this.ensure(provider);
    return this.rpc!.call(method, params);
  }
  /** The folder a session without a folder of its own runs in. */
  get defaultWorkspace() {
    return path.join(this.spaceRoot, "workspace");
  }
  /**
   * The web runner's sandboxes: every folder a session opens is trusted in
   * Codex, so its own `.codex/` config, hooks and rules load (the official
   * cloud sessions ask nothing). Set by the runner; peers follow it.
   */
  trustEveryWorkspace = false;
  /** The SSH host this engine runs on, if any. */
  get sshHostId() {
    return this.environment.kind === "ssh"
      ? this.environment.hostId
      : undefined;
  }
  /** The trusted projects of an SSH host's Codex, kept on this computer. */
  get sshTrust() {
    return this.sshHostId
      ? new SshWorkspaceTrustStore(sshWorkspaceTrustFile(this.store.root))
      : undefined;
  }
  /** Folders on the host already found trusted by this engine. */
  readonly trustedRemoteFolders = new Set<string>();
  /** The launcher of an engine that runs on another computer (R9). */
  get launcher() {
    return this.options.launcher;
  }
  /** The platform the agent runs on. */
  get platform(): NodeJS.Platform {
    return this.launcher?.platform ?? process.platform;
  }
  /**
   * Another engine of the account with the same constructor arguments, for
   * conversations in `options.environment` (R9-S3, EngineRegistry). It reads
   * this engine's policy, model limits and switches; its events are this
   * engine's except the engine status (the window's status is this
   * computer's engine; an SSH host reports through ssh-status).
   */
  createPeer(options: EngineOptions): Engine {
    const emit = this.emit;
    const peer = new Engine(
      this.store,
      this.binary,
      this.secret,
      (event) => {
        if (event.type !== "engine") emit(event);
      },
      this.serviceScript,
      this.vaultKey,
      this.vaultRoot,
      this.limits,
      this.onRefusal,
      options,
    );
    peer.policy = () => this.policy();
    peer.mcpMaintenance = () => this.mcpMaintenance?.() ?? false;
    peer.modelLimits = (providerId, model) =>
      this.modelLimits(providerId, model);
    peer.groupKeys = (providerId) => this.groupKeys(providerId);
    peer.searchCapabilities = (providerId, model) =>
      this.searchCapabilities(providerId, model);
    peer.imageModel = () => this.imageModel();
    for (const extension of this.peerExtensions) peer.extensions.add(extension);
    Object.defineProperty(peer, "describeTools", {
      get: () => this.describeTools,
      set: () => {},
    });
    Object.defineProperty(peer, "unavailableReason", {
      get: () => this.unavailableReason,
      set: () => {},
    });
    Object.defineProperty(peer, "sandboxNetwork", {
      get: () => this.sandboxNetwork,
      set: () => {},
    });
    Object.defineProperty(peer, "trustEveryWorkspace", {
      get: () => this.trustEveryWorkspace,
      set: () => {},
    });
    Object.defineProperty(peer, "codeSafeguardScope", {
      get: () => this.codeSafeguardScope,
      set: () => {},
    });
    return peer;
  }
  usageSummary(range: UsageRange = "all") {
    return this.usageLedger.summary(range);
  }
  status(value: Snapshot["engine"]) {
    this.state = value;
    this.emit({ type: "engine", engine: value });
  }
  /** Native package maintenance blocks new starts and turns across account peers. */
  mcpMaintenance?: () => boolean;
  /** Extra request headers of a connector, by name (the web's bearer tokens). */
  connectorHeaders?: (name: string) => Record<string, string> | undefined;
  /** Installed only by the native owner. Undefined means no protected package launch. */
  mcpRuntimeConfig?: (
    name: string,
    raw: Record<string, unknown>,
  ) => Record<string, unknown> | undefined;
  mcpRuntimeSecrets?: () => readonly string[];
  mcpNodeExecutable?: string;
  mcpLaunchConfig?: (
    name: string,
    entry: Record<string, unknown>,
  ) => Record<string, unknown> | undefined;
  readonly retainedMcpSecrets = new Set<string>();
  /** MCP servers' startup state from the runtime (Settings → Developer). */
  readonly mcpStartup = new Map<string, { status: string; error?: string }>();
  /** Redacted, bounded connection events for this account only. */
  readonly mcpLogs = new McpConnectionLogs(
    () => this.store.settings.mcpServers,
  );
  /** The last start's steps (ms), for the send that waited on it. */
  startSteps: string[] | undefined;
  /** Sends waiting for their first output, by thread. */
  firstOutput = new Map<string, StartTiming>();
  private generatedBlobs?: GeneratedBlobs;
  /** Binary snapshots of generated files, kept in the profile. */
  get blobs() {
    return (this.generatedBlobs ??= new GeneratedBlobs(this.store.root));
  }
  /**
   * "Always allow" on a connector tool's approval: Codex keeps it in its own
   * config.toml, which Claudex writes anew at every start, so the tool's
   * `approval_mode = "approve"` is kept in the connector's settings too
   * (Settings → Connectors lists and forgets it). The running agent already
   * has it, so this does not restart it.
   */
  onMcpServersRemembered?: () => void;
  /** Questions the app itself asks (not Codex): their answers resolve here. */
  appApprovals = new Map<string | number, (result: any) => void>();
}

installMethods(Engine.prototype, engineStatus);

installMethods(Engine.prototype, engineGuards);

installMethods(Engine.prototype, engineAgents);

installMethods(Engine.prototype, engineTrust);

installMethods(Engine.prototype, engineHandoff);

installMethods(Engine.prototype, engineHistory);

installMethods(Engine.prototype, engineApprovals);

installMethods(Engine.prototype, engineEvents);

installMethods(Engine.prototype, engineSend);

installMethods(Engine.prototype, engineTurnSetup);

installMethods(Engine.prototype, engineLifecycle);
