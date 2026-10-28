/**
 * What the main process shares with each IPC domain and with the remote
 * mode host: the signed-in account's services, the window, the policy and
 * the ways to tell the window or other domains that something happened.
 *
 * Domains read it and don't change its members. `electron/main.ts` builds one AppContext and
 * `electron/ipc/index.ts` hands the same one to every `register*` function.
 * Account members (store, engine, credentials, …) are only valid while an
 * account is signed in: every IPC call except sign-in ones is refused before
 * that, and handlers must not keep a member across a sign-out.
 *
 * It also holds the app windows registry, the calling window, the engine
 * registry, remote folders, optional service slots and the account lifecycle
 * callbacks.
 */
import type { BrowserWindow, WebContents, WebPreferences } from "electron";
import type {
  AppEvent,
  Attachment,
  EnvironmentRef,
  PublicAccount,
  Settings,
} from "../../shared/types";
import type { ClientPolicy } from "../../shared/client-policy";
import type { ReplyRating } from "../../shared/diagnostics-api";
import type { GatewayRefusal } from "../../server/sub2api-errors";
import type { RequestLimits } from "../../server/operator-limits";
import type { Accounts } from "../account/accounts";
import type { ArtifactLibrary } from "../artifacts/artifact-library";
import type { ArtifactPopouts } from "../artifacts/artifact-popouts";
import type { ArtifactPreviews } from "../artifacts/artifact-previews";
import type { ArtifactShares } from "../artifacts/artifact-shares";
import type { BackgroundHistory } from "../conversations/background-history";
import type { DesktopIntegration } from "./desktop-integration";
import type { Engine } from "../engine/engine";
import type { EngineRegistry } from "../engine/engine-registry";
import type { ProviderCredentials } from "../engine/provider-credentials";
import type { RemoteHost } from "../remote/host";
import type { ReplyFeedback } from "../conversations/reply-feedback";
import type { Scheduler } from "../routines/scheduler";
import type { Store } from "../store/store";
import type { TerminalController } from "../terminal/terminal-controller";
import type { WorkingTreeHost } from "../git/working-tree";

/** Registers one bridge call (`app:<name>`); the sender and sign-in checks are done by main. */
export type IpcHandle = (name: string, fn: (...args: any[]) => any) => void;

/** A reply rating the person just stored (Settings → Privacy reporting reads it). */
export interface ReplyRated {
  conversationId: string;
  turnId: string;
  rating: ReplyRating | null;
}

/** What an app window shows: the main window, or one conversation (R2). */
export type AppWindowRole =
  | { kind: "main" }
  | { kind: "conversation"; conversationId: string }
  | { kind: "project"; projectId: string };

/**
 * The app's renderer windows: the main window and each separate
 * conversation window (R2). A registered window gets the main window's
 * protections (links leave the app only after the renderer confirms, no
 * navigation away from the app), its bridge calls are trusted, it receives
 * every pushed event, and it closes when the account signs out (conversation
 * windows) or the main window closes.
 */
export interface AppWindows {
  /** The main window while it is open. */
  main(): BrowserWindow | undefined;
  /** Every open app window, the main window first. */
  all(): BrowserWindow[];
  /** The role of an app window's contents; undefined for anything else. */
  roleOf(contents: WebContents): AppWindowRole | undefined;
  /** The app window with keyboard focus, if any. */
  focused(): BrowserWindow | undefined;
  /**
   * Adds a window the caller created with `webPreferences()`: guards it,
   * trusts it and sends it events until it closes.
   */
  register(win: BrowserWindow, role: AppWindowRole): void;
  /** The renderer settings every app window uses (same preload and sandbox). */
  webPreferences(): WebPreferences;
  /** Loads the renderer; `query` becomes the page's search string (`window=conversation&id=…`). */
  load(win: BrowserWindow, query?: Record<string, string>): Promise<void>;
  /** Sends an event to one app window only. */
  send(win: BrowserWindow, event: AppEvent): void;
  /** Closes every conversation window (sign-out, account switch). */
  closeConversationWindows(): void;
}

/**
 * Services a round-two package adds for other packages to read. Each slot's
 * type is an empty interface here: the owning package fills it in from its
 * own file with declaration merging, for example
 * `declare module "../app/app-context" { interface MemorySlot extends MemoryHooks {} }`,
 * and sets `ctx.services.memory` when its service starts (account services
 * in `onAccountActivated`, cleared in `onAccountDeactivating`).
 */
export interface AppServices {
  readPullRequestAutoFix?: (
    repository: string,
    number: number,
  ) => Promise<ReturnType<typeof import("../git/pr-autofix").autoFixFacts>>;
  githubReview?: (
    input: import("../../shared/github-review").GitHubReviewRequest,
  ) => Promise<import("../../shared/github-review").GitHubReviewResult>;
  dispatch?: {
    status(): {
      id: string;
      online: boolean;
      cause?: "sign_in" | "network" | "retry" | "update";
    };
    retry?(): void;
    call(method: string, args: unknown[]): Promise<unknown>;
  };
  readChatGitHub?: (
    input: import("../../shared/chat-github").ChatGitHubRead,
  ) => Promise<unknown>;
  /** R3-S4: the signed-in account's memory service. */
  memory?: MemorySlot;
  /** R1-C: hosted shares of the signed-in account. */
  sharing?: SharingSlot;
  /** R8-A: the embedded Browser panels. */
  browser?: BrowserSlot;
  /** R10-M: the computer-use broker. */
  computerUse?: ComputerUseSlot;
  /** R11-A: Cowork folder grants. */
  coworkFolders?: CoworkFoldersSlot;
  /** R9-S1: SSH hosts and connections. */
  ssh?: SshSlot;
  /** R2-B: the separate conversation windows. */
  chatWindows?: ChatWindowsSlot;
  /**
   * Web: where the Changes panel reads a folder (the runner's sandbox).
   * Missing on the desktop, which reads the conversation's own folder.
   */
  workingTree?: WorkingTreeHost;
  /**
   * Web: makes or deletes a scheduled task's API token with the service
   * (routine.api-token); the desktop has none.
   */
  routineApiToken?: (
    triggerId: string,
    action: "generate" | "delete",
  ) => Promise<{ token?: string; hint?: string }>;
  /**
   * Web: makes ("set") or removes a scheduled task's repository webhook with
   * the user's GitHub connection (github.hook).
   */
  routineGitHubHook?: (
    triggerId: string,
    action: "set" | "delete",
    hook?: { repository: string; events: string[] },
  ) => Promise<unknown>;
}
/* Filled in by the owning packages (see AppServices). */
export interface MemorySlot {}
export interface SharingSlot {}
export interface BrowserSlot {}
export interface ComputerUseSlot {}
export interface CoworkFoldersSlot {}
export interface SshSlot {}
export interface ChatWindowsSlot {}

/** The part of the MCP configuration file the Connectors calls use. */
export interface McpConfigLike {
  readonly path: string;
  error?: string;
  ensure(): void;
  /** Re-reads the file after an edit made outside (the web has no file). */
  reload?(): void;
  update(servers: Record<string, unknown>): void;
}

export interface ConnectorHost {
  beginLogin?(
    name: string,
    resource: string,
    returnUrl: string,
  ): Promise<string>;
  completeLogin?(state: string, code: string): Promise<string>;
  getToken?(name: string): string | undefined;
  fetch?: typeof fetch;
  /** Refuses an address the runner may not reach (not https, private, internal). */
  assertUrl(url: string): Promise<void>;
  /** Keeps (or with undefined, forgets) a connector's bearer token. */
  setToken(name: string, token: string | undefined): void;
}

export interface AppContext {
  readonly integrationTokens?: {
    get(name: string): string | undefined;
    set(name: string, token: string | undefined): void;
  };
  // The signed-in account and its services.
  readonly store: Store;
  /** The local engine. A conversation's own engine is `engineFor(id)` (R9). */
  readonly engine: Engine;
  /** Every engine of the signed-in account (local, and SSH hosts after R9-S3). */
  readonly engines: EngineRegistry;
  readonly activeAccount: PublicAccount | undefined;
  /** The Sub2API session, plan and device key; undefined for local accounts. */
  readonly remote: RemoteHost | undefined;
  readonly credentials: ProviderCredentials;
  readonly terminals: TerminalController | undefined;
  readonly scheduler: Scheduler | undefined;
  readonly replyFeedback: ReplyFeedback;
  readonly backgroundHistory: BackgroundHistory;
  readonly artifactShares: ArtifactShares;
  readonly artifactLibrary: ArtifactLibrary;
  /** Developer → Edit config: the MCP servers as a file in the profile. */
  readonly mcpConfig: McpConfigLike | undefined;
  /**
   * The web runner's part of Settings → Connectors: it checks a connector's
   * address and keeps its bearer token (the desktop uses a configuration
   * file and an environment variable instead).
   */
  readonly connectors?: ConnectorHost;

  // The app, whoever is signed in.
  /**
   * The app window whose bridge call is running (so dialogs open over the
   * window that asked), the main window outside a call. Use
   * `appWindows.main()` for the main window itself and `push` for events.
   */
  readonly window: BrowserWindow | undefined;
  /** The main window and the separate conversation windows (R2). */
  readonly appWindows: AppWindows;
  /** Optional services round-two packages share (R1–R11). */
  readonly services: AppServices;
  /** userData: key vault, limits.json, policy.json, the local account registry. */
  readonly dataRoot: string;
  /** This build's version (`app.getVersion()`), for update checks and service headers. */
  readonly appVersion: string;
  /** The provider service child's script (dictation, read aloud, model lists). */
  readonly providerServiceScript: string;
  readonly accounts: Accounts;
  readonly integration: DesktopIntegration;
  readonly artifactPreviews: ArtifactPreviews;
  readonly artifactPopouts: ArtifactPopouts;
  /** Folders and attachments the person chose with a picker in this session. */
  readonly selectedFolders: Set<string>;
  readonly selectedAttachments: Map<string, Attachment>;
  /** Remote folders the person chose on each SSH host (host id → paths), this session (R9). */
  readonly remoteFolders: Map<string, Set<string>>;

  /**
   * Refuses a folder the person did not choose or already use. A folder on
   * an SSH host must be one chosen on that host (`remoteFolders`).
   */
  allowedFolder(folder?: string, environment?: EnvironmentRef): void;
  /**
   * An isolated space's sandbox (the cloud runner, docs/cloud-sync.md): the
   * command that starts Codex in it and the folder of its codex-home and
   * workspace. Absent on the desktop.
   */
  spaceSandbox?(spaceId: string): {
    binary: string;
    root: string;
    environmentVariables?: Record<string, string>;
  };
  /** A space's engine stopped (its sandbox's network listener closes). */
  spaceStopped?(spaceId: string): void;
  /**
   * A space's folder without starting anything (moving a conversation in,
   * shared/cloud-sync-api.ts). Absent on the desktop.
   */
  spaceFolder?(spaceId: string): string;
  /** The service can e-mail this account about its scheduled tasks. */
  routineEmailAvailable?(): Promise<boolean>;
  /** Sources the current executing scheduler can actually run. */
  routineSources?(): ("chat" | "code")[];
  /** Whether this runner can email its own cloud Code session owner. */
  codeEmailStatus?(): Promise<
    import("../../shared/code-email-api").CodeEmailStatus
  >;
  /** The engine that runs the conversation (the local one until R9-S3). */
  engineFor(conversationId?: string): Engine;
  /**
   * The app window whose bridge call is running, for dialog parents; the
   * main window outside a call.
   */
  callerWindow(): BrowserWindow | undefined;
  /** Refuses while a turn is running (on any engine). */
  noActive(): void;
  /**
   * The operator's limits.json for the signed-in account as written (the
   * engine of a Sub2API account drops its token caps; the service meters).
   */
  requestLimits(): RequestLimits;
  /** The settings as the window sees them (no keys, no provider addresses). */
  publicSettings(): Settings;
  /**
   * The settings for a reply that hands them to the window: the window's next
   * save is merged against exactly these.
   */
  windowSettings(): Settings;
  /** Sends the window settings the main process changed. */
  settingsChanged(): void;
  /** Stops everything using the profile and signs out. */
  deactivate(): Promise<void>;

  /** The administrator's policy now; never waits for the network. */
  policy(): ClientPolicy;
  /** Reads the policy again in the background; a change arrives as a "policy" event. */
  refreshPolicy(): void;
  /** Sends an event to every app window (`window.desktop.onEvent`). */
  push(event: AppEvent): void;
  /** Runs `cb` each time an app window gains focus; returns the unsubscribe. */
  onWindowFocus(cb: () => void): () => void;
  /**
   * Runs `cb` once an account is signed in and its store, engine and policy
   * are ready (sign-in, restore, account switch). A saved session is
   * restored before the domains register, so `cb` also runs right away (in
   * a microtask) when an account is already signed in.
   */
  onAccountActivated(cb: (account: PublicAccount) => void): () => void;
  /**
   * Runs `cb` when the signed-in account is about to sign out, before its
   * engine stops; sign-out waits for a returned promise (keep it short).
   */
  onAccountDeactivating(cb: () => void | Promise<void>): () => void;
  /** Runs `cb` for each gateway refusal the engine reports. */
  onRefusal(cb: (refusal: GatewayRefusal) => void): () => void;
  /** Runs `cb` after a reply rating was stored. */
  onReplyRated(cb: (rating: ReplyRated) => void): () => void;
  /**
   * Runs `cb` for every event sent to the window (conversation updates from
   * the engine, approvals, policy, …), for main-process observers such as
   * diagnostics. Callbacks must be quick and must not throw.
   */
  onEvent(cb: (event: AppEvent) => void): () => void;
  /**
   * Runs `cb` after the signed-in account's stored settings changed: a save
   * from the window (Settings pages, composer options) or a change the main
   * process made (the MCP configuration file, a policy that moved a mode).
   * Diagnostics (C7), for example, drops its queue as soon as the person
   * turns consent off. Callbacks must be quick and must not throw.
   */
  onSettingsChanged(cb: (settings: Settings) => void): () => void;
}

/** A set of callbacks, for the `on*` members of AppContext. */
export class Listeners<T> {
  private callbacks = new Set<(value: T) => void>();
  add(cb: (value: T) => void) {
    this.callbacks.add(cb);
    return () => {
      this.callbacks.delete(cb);
    };
  }
  /** Calls each callback and waits for the promises they return; failures are logged. */
  async emitAsync(value: T) {
    const results = await Promise.allSettled(
      [...this.callbacks].map(async (cb) => cb(value)),
    );
    for (const result of results)
      if (result.status === "rejected")
        console.error(
          "Listener failed:",
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        );
  }
  /** Calls each callback; one that throws is logged and does not stop the others. */
  emit(value: T) {
    for (const cb of [...this.callbacks])
      try {
        cb(value);
      } catch (error) {
        console.error(
          "Listener failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
  }
}
