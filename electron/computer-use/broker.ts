import type {
  ComputerUseAccessRequest,
  ComputerUseActivity,
  ComputerUseAppRef,
  ComputerUseSettings,
  ComputerUseTier,
  ComputerUseToolResult,
  ControlCall,
} from "../../shared/computer-use";
import type { ComputerUsePolicy } from "../../shared/client-policy";
import type { Mode } from "../../shared/types";
import type { ComputerDriver, DriverApp, DriverMode } from "./driver-host";
import type { ScreenshotStore } from "./screenshots";
import * as brokerAccess from "./broker-access";
import { installMethods } from "./install-methods";
import * as brokerActions from "./broker-actions";
import * as brokerDispatch from "./broker-dispatch";

/** What the broker needs to know about a conversation. */
export interface BrokerConversation {
  mode: Mode;
  incognito: boolean;
  /** A reply is being generated. */
  running: boolean;
  /** The running (or last) turn's id. */
  turnId?: string;
  /** It runs on an SSH host, not this computer. */
  remote: boolean;
  /** Started by a routine, nobody watching. */
  unattended: boolean;
}

/** An app the broker can resolve a name to. */
export interface KnownApp extends ComputerUseAppRef {
  /** Where it is installed (for opening it and its icon). */
  path?: string;
}

export interface BrokerDeps {
  teach?: {
    show(
      step: import("../../shared/computer-use").ComputerUseTeachStep,
    ): Promise<"next" | "exit">;
    hide(): void;
    withClickThrough?<T>(work: () => Promise<T>): Promise<T>;
  };
  platform: "darwin" | "win32" | "linux";
  policy(): ComputerUsePolicy;
  settings(): ComputerUseSettings;
  /** A driver is installed for this platform. */
  driverInstalled(): boolean;
  /** macOS: Accessibility and Screen Recording both work; true elsewhere. */
  permissionsReady(): boolean;
  conversation(id: string): BrokerConversation | undefined;
  driver: ComputerDriver;
  screenshots: ScreenshotStore;
  /** Installed apps (for names that aren't running, icons and opening). */
  installedApps(): Promise<KnownApp[]>;
  icon?(app: KnownApp): Promise<string | undefined>;
  /** Opens an app; `background` keeps it behind the frontmost app. */
  openApp(app: KnownApp, background: boolean): Promise<void>;
  /** Tells the windows something changed. */
  emit: {
    request(request: ComputerUseAccessRequest): void;
    resolved(id: string): void;
    activity(activity: ComputerUseActivity | null): void;
  };
  /** Full control: hide other apps and show the indicator; `end` undoes both. */
  fullControl: {
    begin(
      conversationId: string,
      keep: KnownApp[],
      appName?: string,
    ): Promise<void>;
    update(appName?: string): void;
    end(unhide: boolean): Promise<void>;
  };
  clipboard: {
    read(): string | Promise<string>;
    write(text: string): void | Promise<void>;
  };
  now?(): number;
  /** How long an access request waits (default 10 minutes). */
  accessTimeoutMs?: number;
  /** The client's own action cap per turn (default 200). */
  maxActionsPerTurn?: number;
}

export interface Grant {
  app: KnownApp;
  tier: ComputerUseTier;
}

interface TurnState {
  turnId?: string;
  actions: number;
  halted: boolean;
}

interface PendingRequest {
  request: ComputerUseAccessRequest;
  finish(answer: { allow: string[] } | "deny"): void;
}

export class ComputerUseBroker {
  grants = new Map<string, Map<string, Grant>>();
  /** Clipboard access a conversation was allowed through request_access. */
  clipboardGrants = new Map<string, { read: boolean; write: boolean }>();
  turns = new Map<string, TurnState>();
  pending = new Map<string, PendingRequest>();
  /** Screenshot scale per conversation and app (model pixels → driver pixels). */
  scales = new Map<string, Map<string, number>>();
  control?: { conversationId: string; app?: KnownApp };
  activity: ComputerUseActivity | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  teachingPending = new Set<string>();
  appCache?: { at: number; apps: DriverApp[]; mode: DriverMode };
  /** Until when an Esc the driver presses for the model may still arrive. */
  ownEscapeUntil = 0;

  constructor(public deps: BrokerDeps) {}

  /**
   * The driver is pressing Esc for the model. With full control the driver
   * may post real key events, which the person's Esc shortcut would catch
   * and treat as Stop; the shortcut ignores those.
   */
  pressingEscape() {
    return this.now() < this.ownEscapeUntil;
  }

  now() {
    return this.deps.now?.() ?? Date.now();
  }

  // -------------------------------------------------------------------------
  // Availability.

  /** Why computer use can't run at all, or undefined when it can. */
  unavailableReason(): "policy" | "platform" | "driver" | undefined {
    if (this.deps.platform !== "darwin" && this.deps.platform !== "win32")
      return "platform";
    if (!this.deps.policy().enabled) return "policy";
    if (!this.deps.driverInstalled()) return "driver";
    return undefined;
  }

  /** Why computer use is off for a conversation, or undefined when it is on. */
  refusalFor(
    conversation: BrokerConversation | undefined,
    { permissions = true }: { permissions?: boolean } = {},
  ): string | undefined {
    const reason = this.unavailableReason();
    if (reason === "policy")
      return "Computer use is turned off by your administrator.";
    if (reason) return "Computer use isn't available on this computer.";
    if (!this.deps.settings().enabled)
      return "Computer use is turned off in Settings → System.";
    if (!conversation) return "This conversation can't use computer use.";
    if (conversation.mode === "chat")
      return "Computer use works in Code and Cowork conversations only.";
    if (conversation.remote)
      return "Computer use only works for conversations that run on this computer.";
    if (conversation.unattended) return "Routines can't use computer use.";
    if (permissions && !this.deps.permissionsReady())
      return "Claudex needs the Accessibility and Screen Recording permissions (Settings → System → Computer use).";
    return undefined;
  }

  /** Computer use is on for this conversation (the engine offers the tools only then). */
  enabledFor(conversationId: string) {
    // Missing macOS permissions still offer the tools: request_access asks
    // the person to grant them.
    return !this.refusalFor(this.deps.conversation(conversationId), {
      permissions: false,
    });
  }

  // -------------------------------------------------------------------------
  // Calls.

  /** Handles one tool call from the adapter of `conversationId`. */
  handle(
    conversationId: string,
    call: ControlCall,
  ): Promise<ComputerUseToolResult> {
    return this.run(conversationId, call);
  }

  /**
   * Runs driver work one call at a time (the driver has one process); a
   * call waiting for the person's answer doesn't hold others up.
   */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => {});
    return run;
  }

  setActivity(activity: ComputerUseActivity | null) {
    this.activity = activity;
    this.deps.emit.activity(activity);
  }

  currentActivity() {
    return this.activity;
  }

  // -------------------------------------------------------------------------
  // Turns and stopping.

  /** A turn ended (finished, failed or interrupted): withdraw requests, give the screen back. */
  async turnEnded(conversationId: string) {
    for (const pending of [...this.pending.values()])
      if (pending.request.conversationId === conversationId)
        pending.finish("deny");
    if (this.control?.conversationId === conversationId)
      await this.releaseControl();
    if (this.activity?.conversationId === conversationId)
      this.setActivity(null);
  }

  /** The person pressed Stop (or Esc): no more actions in this turn. */
  async stop(conversationId?: string) {
    const target =
      conversationId ??
      this.control?.conversationId ??
      this.activity?.conversationId;
    if (!target) return;
    const conversation = this.deps.conversation(target);
    const turn = this.turn(
      target,
      conversation?.turnId ?? this.turns.get(target)?.turnId,
    );
    turn.halted = true;
    await this.turnEnded(target);
  }

  /** Forgets a conversation (deleted, or its chat ended). */
  async forget(conversationId: string) {
    await this.turnEnded(conversationId);
    this.grants.delete(conversationId);
    this.clipboardGrants.delete(conversationId);
    this.turns.delete(conversationId);
    this.scales.delete(conversationId);
  }

  /** Sign-out or quit: deny everything waiting, give the screen back, stop the driver. */
  async dispose() {
    for (const pending of [...this.pending.values()]) pending.finish("deny");
    await this.releaseControl();
    this.setActivity(null);
    this.grants.clear();
    this.clipboardGrants.clear();
    this.turns.clear();
    this.scales.clear();
    await this.deps.driver.stop();
  }

  /** Settings or policy changed: drop grants for apps that are now denied, leave full control if no longer allowed. */
  async settingsChanged() {
    for (const grants of this.grants.values())
      for (const [key, grant] of grants)
        if (this.deniedBy(grant.app)) grants.delete(key);
    if (
      this.control &&
      (!this.deps.policy().allowFullControl ||
        this.refusalFor(this.deps.conversation(this.control.conversationId)))
    )
      await this.releaseControl();
    if (this.unavailableReason() || !this.deps.settings().enabled) {
      for (const pending of [...this.pending.values()]) pending.finish("deny");
      if (this.activity) this.setActivity(null);
    }
  }
}

export interface ComputerUseBroker {
  run: OmitThisParameter<typeof brokerDispatch.run>;
  turn: OmitThisParameter<typeof brokerDispatch.turn>;
  mode: OmitThisParameter<typeof brokerDispatch.mode>;
  dispatch: OmitThisParameter<typeof brokerDispatch.dispatch>;
  driverApps: OmitThisParameter<typeof brokerDispatch.driverApps>;
  refOf: OmitThisParameter<typeof brokerDispatch.refOf>;
  resolve: OmitThisParameter<typeof brokerDispatch.resolve>;
  deniedBy: OmitThisParameter<typeof brokerDispatch.deniedBy>;
  grantsOf: OmitThisParameter<typeof brokerDispatch.grantsOf>;
  granted: OmitThisParameter<typeof brokerDispatch.granted>;
}
installMethods(ComputerUseBroker.prototype, brokerDispatch);

export interface ComputerUseBroker {
  preview: OmitThisParameter<typeof brokerActions.preview>;
  clipboard: OmitThisParameter<typeof brokerActions.clipboard>;
  target: OmitThisParameter<typeof brokerActions.target>;
  scale: OmitThisParameter<typeof brokerActions.scale>;
  act: OmitThisParameter<typeof brokerActions.act>;
  finish: OmitThisParameter<typeof brokerActions.finish>;
}
installMethods(ComputerUseBroker.prototype, brokerActions);

export interface ComputerUseBroker {
  listApps: OmitThisParameter<typeof brokerAccess.listApps>;
  listGranted: OmitThisParameter<typeof brokerAccess.listGranted>;
  ask: OmitThisParameter<typeof brokerAccess.ask>;
  requestAccess: OmitThisParameter<typeof brokerAccess.requestAccess>;
  askPermissions: OmitThisParameter<typeof brokerAccess.askPermissions>;
  answer: OmitThisParameter<typeof brokerAccess.answer>;
  requests: OmitThisParameter<typeof brokerAccess.requests>;
  requestFullControl: OmitThisParameter<typeof brokerAccess.requestFullControl>;
  releaseControl: OmitThisParameter<typeof brokerAccess.releaseControl>;
}
installMethods(ComputerUseBroker.prototype, brokerAccess);
