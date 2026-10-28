import { ChatDeviceController } from "./chat-devices";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  AppEvent,
  Attachment,
  PublicAccount,
  Settings,
} from "../../shared/types";
import { webHost, type HostInfo } from "../../shared/host";
import { pendingPolicy, type ClientPolicy } from "../../shared/client-policy";
import type { GatewayRefusal } from "../../server/sub2api-errors";
import type { RequestLimits } from "../../server/operator-limits";
import {
  Listeners,
  type AppContext,
  type AppServices,
  type IpcHandle,
  type ReplyRated,
} from "../../electron/app/app-context";
import { Accounts } from "../../electron/account/accounts";
import { ArtifactLibrary } from "../../electron/artifacts/artifact-library";
import { ArtifactPopouts } from "../../electron/artifacts/artifact-popouts";
import { ArtifactShares } from "../../electron/artifacts/artifact-shares";
import { BackgroundHistory } from "../../electron/conversations/background-history";
import { Engine } from "../../electron/engine/engine";
import { EngineRegistry } from "../../electron/engine/engine-registry";
import { ProviderCredentials } from "../../electron/engine/provider-credentials";
import { ReplyFeedback } from "../../electron/conversations/reply-feedback";
import { remoteRequestLimits } from "../../electron/account/remote-mode";
import { type PolicyHost } from "../../electron/remote/host";
import { registerIpc } from "../../electron/ipc/index";
import { weeklyUsageTurns } from "../../electron/ipc/usage";
import { remoteAccountId } from "../../electron/sub2api/identity-support";
import { CloudStore, type StoreTransport } from "./cloud-store";
import { WebPreviews } from "./previews";
import { WebRemoteHost, type WebSession } from "./web-remote-host";
import { Scheduler } from "../../electron/routines/scheduler";
import {
  queryRoutineList,
  readRoutine,
} from "../../electron/routines/routine-query";
import type {
  ConnectorHost,
  McpConfigLike,
} from "../../electron/app/app-context";
import { ConnectorOAuth } from "./connector-oauth";
import { ConnectorTokens } from "./connectors";
import type { UserNetwork } from "./net-policy-compile";
import type { CloudEnvironmentConfig } from "../../shared/cloud-environments-api";
import { preference } from "../../shared/settings-extras";
import type { WorkingTreeHost } from "../../electron/git/working-tree";
import { type PrepareWorkspace } from "./code-workspace";
import type { Fetch } from "../../electron/sub2api/http";
import { routineMailer } from "../../electron/routines/routine-mail";
import {
  codeMailer,
  CodeEmailDispatcher,
} from "../../electron/account/code-email";
import { noWindows, NoIntegration, WebMcpConfig } from "./web-app-support";
import * as webContextActivate from "./web-context-activate";
import { installMethods } from "./install-methods";
import * as webContextCodeSessions from "./web-context-code-sessions";
import * as webContextSettings from "./web-context-settings";
import * as webContextLifecycle from "./web-context-lifecycle";

/** What a context needs from the runner around it. */
export interface WebRuntime {
  captureArtifactScreenshot?(html: string): Promise<string>;
  /** Base URL of the Claudex service for user APIs and the /v1 gateway. */
  serviceUrl: string;
  /** Runner state directory; users live in `<stateDir>/users/<id>`. */
  stateDir: string;
  /**
   * Readies a user's data folder before their context touches it (the
   * runner's disk quota mounts the user's volume there).
   */
  prepareUserData?(userId: number, profile: string): Promise<void>;
  cachePressure?(profile: string): boolean;
  providerServiceScript: string;
  /**
   * The codex executable Engine starts for this user: the sandbox launcher
   * (runner/src/sandbox) or, in development only, codex itself.
   */
  codexBinary(input: {
    userId: number;
    storeRoot: string;
    codexCache?: string;
    attachments: string;
    /** `<profile>/projects`: project knowledge files, mounted read-only. */
    projects: string;
    /**
     * An isolated space's own sandbox (docs/cloud-sync.md): its id, unique
     * per user and space; absent for the user's shared sandbox.
     */
    sandboxId?: string;
    cloudEnvironment?: CloudEnvironmentConfig;
  }): string;
  /** A space's sandbox stopped: what `codexBinary` opened for it closes. */
  releaseSandbox?(userId: number, sandboxId: string): void;
  /**
   * Restricted commands keep the sandbox's network: gVisor (the runsc
   * driver) limits it itself and cannot give a command its own (#22).
   */
  sandboxNetwork?: boolean;
  /** This build's version (shim `app.getVersion()`, service headers). */
  version: string;
  /** The webstore and key requests (the runner link). */
  transport: StoreTransport;
  /** The user's events leave here (event hub → link). */
  publish(userId: number, event: AppEvent): void;
  /** Called when a context closes itself (sign-out). */
  closed?(ctx: WebAppContext): void;
  /** Refuses a connector address the runner may not reach (connectors.ts). */
  connectorGuard?: (url: string) => Promise<void>;
  /**
   * The user's own network settings for their sandbox (Settings →
   * Capabilities), at activation and whenever they change; the runner
   * narrows its policy by them (net-policy.ts `userNetworkPolicy`).
   */
  network?(userId: number, user: UserNetwork): void;
  /**
   * The user's scheduled tasks are next due at `at` (undefined: none is):
   * the runner wakes the user then even with no page open (routine-wakes.ts).
   */
  wake?(userId: number, at: number | undefined): void;
  /** The host capabilities the web app shows (Snapshot.host). */
  host?: HostInfo;
  /**
   * Prepares a new Code session's folder (code-workspace.ts): the empty
   * folder by default; the GitHub package clones a repository into it.
   */
  prepareWorkspace?: PrepareWorkspace;
  /**
   * How the Changes panel reads a user's session folders: inside that
   * user's sandbox. Without it no folder can be read.
   */
  workingTree?: (input: {
    userId: number;
    storeRoot: string;
  }) => WorkingTreeHost;
  fetch?: Fetch;
  log?: (message: string) => void;
}

export class WebAppContext implements AppContext {
  readonly userId: number;
  readonly dataRoot: string;
  readonly appVersion: string;
  readonly providerServiceScript: string;
  store!: CloudStore;
  engine!: Engine;
  readonly engines: EngineRegistry;
  activeAccount: PublicAccount | undefined;
  remote: WebRemoteHost | undefined;
  session!: WebSession;
  /** Scheduled-task e-mail for this user (electron/routine-mail.ts). */
  routineMail = routineMailer(
    () =>
      this.session
        ? {
            baseUrl: () => this.runtime.serviceUrl,
            authorized: (call) => this.session.authorized(call),
          }
        : undefined,
    (input, init) => (this.runtime.fetch ?? fetch)(input as string, init),
  );
  routineSources(): ("chat" | "code")[] {
    const cap = (this.runtime.host ?? webHost).capabilities;
    return [
      ...(cap.cloudCowork ? ["chat" as const] : []),
      ...(cap.cloudCode ? ["code" as const] : []),
    ];
  }
  routineEmailAvailable() {
    return this.routineMail.available();
  }
  codeMail = codeMailer(
    () =>
      this.session && !this.closed && !this.signedOut
        ? {
            baseUrl: () => this.runtime.serviceUrl,
            authorized: (call) => this.session.authorized(call),
          }
        : undefined,
    (input, init) => (this.runtime.fetch ?? fetch)(input as string, init),
  );
  codeEmails = new CodeEmailDispatcher({
    enabled: () =>
      !this.closed &&
      !this.signedOut &&
      (this.runtime.host ?? webHost).capabilities.cloudCode &&
      preference(this.store.settings, "notifyCodeEmail"),
    conversation: (id) =>
      this.store?.conversations.find((conversation) => conversation.id === id),
    persist: () => this.store.persistCodeEmailPreference(),
    send: (event) => this.codeMail.send(event),
    failed: () =>
      this.log(
        `claudex-runner: user ${this.userId}'s cloud Code email could not be sent`,
      ),
  });
  credentials!: ProviderCredentials;
  integrationTokens!: ConnectorTokens;
  readonly terminals = undefined;
  /** Scheduled tasks (Scheduled page): the desktop's scheduler on this user's profile. */
  scheduler: Scheduler | undefined = undefined;
  readonly mcpConfig: McpConfigLike = new WebMcpConfig(this);
  /** Settings → Connectors on the web: an address check and the bearer tokens. */
  connectors!: ConnectorHost;
  connectorTokens!: ConnectorTokens;
  connectorOAuth?: ConnectorOAuth;
  replyFeedback!: ReplyFeedback;
  backgroundHistory!: BackgroundHistory;
  artifactShares!: ArtifactShares;
  artifactLibrary!: ArtifactLibrary;
  readonly window = undefined;
  readonly appWindows = noWindows;
  readonly services: AppServices = {};
  accounts!: Accounts;
  readonly integration = new NoIntegration();
  readonly artifactPreviews: WebPreviews;
  readonly artifactPopouts: ArtifactPopouts;
  readonly selectedFolders = new Set<string>();
  readonly selectedAttachments = new Map<string, Attachment>();
  readonly remoteFolders = new Map<string, Set<string>>();
  /** Calls the IPC domains registered for this user (allow-listed by the dispatcher). */
  readonly handlers = new Map<string, (...args: any[]) => any>();
  /** Last call or event of this user (idle reclaim). */
  lastActive = Date.now();
  /** Tabs Go reports open for this user. */
  tabs = 0;
  /** Go said the user signed out: no new calls; closes once idle. */
  signedOut = false;
  closedFlag = false;
  policyHost?: PolicyHost;
  rendererBase?: Settings;
  usageTurns = weeklyUsageTurns(this);
  private readonly focusListeners = new Listeners<void>();
  readonly refusalListeners = new Listeners<GatewayRefusal>();
  readonly ratingListeners = new Listeners<ReplyRated>();
  private readonly eventListeners = new Listeners<AppEvent>();
  readonly settingsListeners = new Listeners<Settings>();
  readonly activatedListeners = new Listeners<PublicAccount>();
  readonly deactivatingListeners = new Listeners<void>();
  readonly log: (message: string) => void;
  deviceController?: ChatDeviceController;
  get chatDeviceController() {
    return (this.deviceController ??= new ChatDeviceController({
      accountScope: String(this.userId),
      root: this.store.root,
      trustScope: remoteAccountId(this.runtime.serviceUrl, this.userId),
      current: () => !this.closed,
      conversations: () => this.store.conversations,
      settings: () => this.store.settings,
      attachment: (id) => this.selectedAttachments.get(id),
      request: (op, body) =>
        this.runtime.transport.request(op, this.userId, body),
      push: (event) => this.push(event),
      release: (id) => this.engine.releaseRunner(id),
      save: async (conversation, options) => {
        const index = this.store.conversations.findIndex(
          (c) => c.id === conversation.id,
        );
        const previous =
          index < 0 ? undefined : this.store.conversations[index];
        if (index < 0) this.store.conversations.unshift(conversation);
        else this.store.conversations[index] = conversation;
        try {
          await this.store.persistChatBinding();
        } catch (error) {
          const current = this.store.conversations.findIndex(
            (c) => c.id === conversation.id,
          );
          if (
            !options?.retainOnFailure &&
            this.store.conversations[current] === conversation
          ) {
            if (previous) this.store.conversations[current] = previous;
            else this.store.conversations.splice(current, 1);
          }
          throw error;
        }
      },
    }));
  }

  private constructor(
    readonly runtime: WebRuntime,
    userId: number,
  ) {
    this.userId = userId;
    this.dataRoot = path.join(runtime.stateDir, "users", String(userId));
    fs.mkdirSync(this.dataRoot, { recursive: true, mode: 0o700 });
    this.appVersion = runtime.version;
    this.providerServiceScript = runtime.providerServiceScript;
    this.engines = new EngineRegistry(() => this.engine);
    this.artifactPreviews = new WebPreviews(userId);
    this.artifactPopouts = new ArtifactPopouts(this.artifactPreviews);
    this.log = runtime.log ?? ((message) => console.error(message));
  }

  /**
   * Opens a user's context: their identity, stored data, plan and key, the
   * engine (not started) and every allow-listed IPC handler.
   */
  static async open(
    runtime: WebRuntime,
    input: { userId: number; accessToken: string; register: RegisterHandlers },
  ): Promise<WebAppContext> {
    const ctx = new WebAppContext(runtime, input.userId);
    try {
      await ctx.activate(input.accessToken, input.register);
    } catch (error) {
      await ctx.close().catch(() => {});
      throw error;
    }
    return ctx;
  }

  requestLimitsFor(accountId: string): RequestLimits {
    return remoteRequestLimits(this.dataRoot, accountId);
  }
  /** Where isolated spaces live (docs/cloud-sync.md). */
  get spacesRoot() {
    return path.join(this.store.root, "spaces");
  }
  /** A space's folder, holding its codex-home and workspace. */
  spaceRoot(spaceId: string) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(spaceId))
      throw new Error("The space id is not valid.");
    return path.join(this.spacesRoot, spaceId);
  }
  /** A space's folder, made if missing, without preparing its sandbox. */
  spaceFolder(spaceId: string) {
    const root = this.spaceRoot(spaceId);
    for (const name of ["workspace", "codex-home"])
      fs.mkdirSync(path.join(root, name), { recursive: true, mode: 0o700 });
    return root;
  }
  /** The sandbox's workspace folder; Code sessions live inside it. */
  get workspace() {
    return path.join(this.store.root, "workspace");
  }
  engineFor(_conversationId?: string) {
    return this.engines.forConversation(_conversationId);
  }
  callerWindow() {
    return undefined;
  }
  noActive() {
    if (this.engines.isBusy())
      throw new Error("Wait for or stop the running task first.");
  }
  requestLimits(): RequestLimits {
    return this.requestLimitsFor(this.activeAccount!.id);
  }
  windowSettings(): Settings {
    this.rendererBase = this.publicSettings();
    return this.rendererBase;
  }
  settingsChanged() {
    if (!this.activeAccount) return;
    this.push({ type: "settings", settings: this.windowSettings() });
    this.settingsListeners.emit(this.store.settings);
  }
  async deactivate() {
    await this.close();
  }
  policy(): ClientPolicy {
    return this.policyHost?.current() ?? pendingPolicy;
  }
  refreshPolicy() {
    void this.policyHost?.source.refresh();
  }
  push(event: AppEvent) {
    this.codeEmails.observe(event);
    this.eventListeners.emit(event);
    this.runtime.publish(this.userId, event);
  }
  onWindowFocus(cb: () => void) {
    return this.focusListeners.add(cb);
  }
  onAccountActivated(cb: (account: PublicAccount) => void) {
    const remove = this.activatedListeners.add(cb);
    const account = this.activeAccount;
    if (account)
      queueMicrotask(() => {
        if (this.activeAccount === account) cb(account);
      });
    return remove;
  }
  onAccountDeactivating(cb: () => void | Promise<void>) {
    return this.deactivatingListeners.add(cb);
  }
  onRefusal(cb: (refusal: GatewayRefusal) => void) {
    return this.refusalListeners.add(cb);
  }
  onReplyRated(cb: (rating: ReplyRated) => void) {
    return this.ratingListeners.add(cb);
  }
  onEvent(cb: (event: AppEvent) => void) {
    return this.eventListeners.add(cb);
  }
  onSettingsChanged(cb: (settings: Settings) => void) {
    return this.settingsListeners.add(cb);
  }

  // ---- Runner side

  /** A tab of this user gained focus (presence from Go). */
  focused() {
    this.focusListeners.emit();
  }
  /** The newest access token of the user (every relayed call brings one). */
  setAccessToken(token: string) {
    this.session?.setAccessToken(token);
  }
  get closed() {
    return this.closedFlag;
  }
  /** Some engine of the user runs a turn. */
  busy() {
    return (
      !!this.engine && (this.engines.isBusy() || !!this.scheduler?.pendingWork)
    );
  }
  /** The engine's codex runs (it holds memory). */
  engineRunning() {
    return !!this.engine && this.engine.state.state !== "stopped";
  }
  /** Stops the engine (idle or evicted); the next turn starts it again. */
  async stopEngine() {
    if (this.engine && !this.busy()) {
      await this.engines.stopRemote();
      await this.engine.stop();
    }
  }
  lastCacheCheck = 0;
  activeSpaces = new Set<string>();
}

export interface WebAppContext {
  codeEmailStatus: OmitThisParameter<
    typeof webContextLifecycle.codeEmailStatus
  >;
  me: OmitThisParameter<typeof webContextLifecycle.me>;
  allowedFolder: OmitThisParameter<typeof webContextLifecycle.allowedFolder>;
  reclaimCaches: OmitThisParameter<typeof webContextLifecycle.reclaimCaches>;
  close: OmitThisParameter<typeof webContextLifecycle.close>;
}
installMethods(WebAppContext.prototype, webContextLifecycle);

export interface WebAppContext {
  publicSettings: OmitThisParameter<typeof webContextSettings.publicSettings>;
  registerCoreHandlers: OmitThisParameter<
    typeof webContextSettings.registerCoreHandlers
  >;
  snapshot: OmitThisParameter<typeof webContextSettings.snapshot>;
  saveSettings: OmitThisParameter<typeof webContextSettings.saveSettings>;
}
installMethods(WebAppContext.prototype, webContextSettings);

export interface WebAppContext {
  spaceStopped: OmitThisParameter<typeof webContextCodeSessions.spaceStopped>;
  inSpaceWorkspace: OmitThisParameter<
    typeof webContextCodeSessions.inSpaceWorkspace
  >;
  spaceSandbox: OmitThisParameter<typeof webContextCodeSessions.spaceSandbox>;
  prepareCodeSession: OmitThisParameter<
    typeof webContextCodeSessions.prepareCodeSession
  >;
  stageCodeSession: OmitThisParameter<
    typeof webContextCodeSessions.stageCodeSession
  >;
  refetchCodeSession: OmitThisParameter<
    typeof webContextCodeSessions.refetchCodeSession
  >;
  discardCodeSession: OmitThisParameter<
    typeof webContextCodeSessions.discardCodeSession
  >;
}
installMethods(WebAppContext.prototype, webContextCodeSessions);

export interface WebAppContext {
  activate: OmitThisParameter<typeof webContextActivate.activate>;
  userNetwork: OmitThisParameter<typeof webContextActivate.userNetwork>;
  startScheduler: OmitThisParameter<typeof webContextActivate.startScheduler>;
}
installMethods(WebAppContext.prototype, webContextActivate);

/** The main process's calls a context implements itself (registerCoreHandlers). */
export const coreHandlerNames = [
  "captureArtifactScreenshot",
  "snapshot",
  "conversationTurns",
  "searchConversations",
  "saveSettings",
  "setReplyFeedback",
];

/** Registers a user's IPC handlers (the dispatcher's allow-listed handle). */
export type RegisterHandlers = (ctx: WebAppContext) => void;

/** registerIpc and the core calls for one context, through `handle`. */
export function registerWebHandlers(ctx: WebAppContext, handle: IpcHandle) {
  ctx.registerCoreHandlers(handle);
  registerIpc((name, handler) => {
    // The runner's scheduler executes in the cloud, never on the browser's computer.
    if (name === "querySchedules") {
      handle(name, () =>
        queryRoutineList(
          ctx as unknown as import("../../electron/app/app-context").AppContext,
          "remote",
        ),
      );
      return;
    }
    if (name === "readSchedule") {
      handle(name, (raw: unknown) =>
        readRoutine(
          ctx as unknown as import("../../electron/app/app-context").AppContext,
          "remote",
          z.string().min(1).max(500).parse(raw),
        ),
      );
      return;
    }
    if (name === "modelCatalog") {
      handle(
        name,
        () => (ctx.remote?.ready && ctx.remote.modelCatalog()) || null,
      );
      return;
    }
    if (
      name !== "captureArtifactScreenshot" &&
      name !== "deleteStoredCodeSessions" &&
      !["chatDevices", "sendOnChatDevice", "setChatDevice"].includes(name)
    )
      handle(name, (...args) =>
        ctx.chatDeviceController.route(name, args, () =>
          Promise.resolve(handler(...args)),
        ),
      );
  }, ctx);
  handle("chatDevices", () => ctx.chatDeviceController.directory());
  handle("sendOnChatDevice", (input) => ctx.chatDeviceController.send(input));
  handle("setChatDevice", (input) => ctx.chatDeviceController.select(input));
  handle("deleteStoredCodeSessions", async () => {
    if (
      ctx.store.conversations.some(
        (conversation) =>
          conversation.mode === "code" &&
          conversation.turns.some((turn) => turn.status === "inProgress"),
      )
    )
      throw new Error("Stop the task first.");
    await ctx.store.deleteStoredCodeSessions();
    ctx.push({ type: "resync" });
  });
}
