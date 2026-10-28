/**
 * Which engine runs a conversation (R9): the local Codex engine, or the
 * one of an SSH host for a conversation whose `environment` is that host.
 *
 * The local engine is main's (`() => engine`); SSH engines are created on
 * first use with the local engine's arguments (`Engine.createPeer`) and an
 * `SshLauncher`, one per host. The registry tells the local engine about
 * its peers, so every call that names a conversation (send, retry, edit,
 * compact, steer, interrupt, approvals), whoever makes it, reaches the
 * engine that runs it.
 *
 * Package R9-S3 binds it once from the agent IPC domain (`bind`), which
 * brings the SSH service, the policy's runtime mirror and the account's
 * lifecycle:
 *  - an SSH engine stops when its host disconnects, when the administrator
 *    turns SSH off, when the account signs out, and after 10 minutes with
 *    nothing running or waiting (the connection itself stays);
 *  - messages written while a host was away wait in the account's outbox
 *    (electron/ssh/outbox.ts) and are sent once the host is ready again,
 *    also after a restart.
 */
import type {
  AppEvent,
  Conversation,
  EnvironmentRef,
} from "../../shared/types";
import type { SshServiceApi } from "../ipc/ssh";
import type { Engine } from "./engine";
import type { EngineLauncher, EnginePeers } from "./engine-types";
import { SshLauncher } from "../ssh/ssh-launcher";
import { Outbox, isOutboxTurn, waitingNote } from "../ssh/outbox";

/** What the registry needs from the app (AppContext, or a test's stand-in). */
export interface EngineRegistryBinding {
  /** The signed-in account's SSH service. */
  ssh(): SshServiceApi | undefined;
  /** userData (device id, runtime cache, control sockets). */
  readonly dataRoot: string;
  /** The administrator's Codex runtime mirror. */
  mirror?(): string | null | undefined;
  /** Refuses a folder the person did not choose in its environment. */
  allowedFolder?(
    folder: string | undefined,
    environment?: EnvironmentRef,
  ): void;
  push?(event: AppEvent): void;
  onEvent(cb: (event: AppEvent) => void): () => void;
  onAccountActivated?(cb: () => void): () => void;
  onAccountDeactivating?(cb: () => void | Promise<void>): () => void;
  /** Replaces the SSH launcher (tests). */
  launcher?(hostId: string): EngineLauncher;
  /**
   * An isolated space's sandbox (docs/cloud-sync.md, the cloud runner): the
   * command that starts Codex in it and the folder of its codex-home and
   * workspace. Without it spaces are not available.
   */
  space?(spaceId: string): {
    binary: string;
    root: string;
    environmentVariables?: Record<string, string>;
  };
  /** A space's engine stopped: its sandbox's resources may go. */
  spaceStopped?(spaceId: string): void;
  /** Spaces running at once for the account (default 3). */
  maxSpaces?: number;
  /** How long an idle space keeps running (default 15 minutes). */
  spaceIdleMs?: number;
  /** How long an idle SSH engine keeps running (default 10 minutes). */
  idleMs?: number;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_SPACE_IDLE_MS = 15 * 60_000;
const DEFAULT_MAX_SPACES = 3;

/** The registry's key of an environment's engine (spaces share the SSH map). */
const keyOf = (environment: Exclude<EnvironmentRef, { kind: "local" }>) =>
  environment.kind === "ssh"
    ? environment.hostId
    : `space:${environment.spaceId}`;

/** The registry that routes a local engine's conversations (see `bind`). */
const registries = new WeakMap<Engine, EngineRegistry>();

/** The registry bound to an account's local engine, if any. */
export function registryOf(engine: Engine | undefined) {
  return engine ? registries.get(engine) : undefined;
}

export class EngineRegistry {
  private remote = new Map<string, Engine>();
  private attached: Engine | undefined;
  private binding: EngineRegistryBinding | undefined;
  private unbind: (() => void)[] = [];
  private outboxes = new WeakMap<Engine, Outbox>();
  private idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly peers: EnginePeers = {
    forEnvironment: (environment) => this.forEnvironment(environment),
    all: () => this.all(),
  };

  constructor(private readonly local: () => Engine | undefined) {}

  /**
   * Brings the app's SSH service and lifecycle (once, from ipc/agent.ts).
   * Returns the function that undoes it.
   */
  bind(binding: EngineRegistryBinding): () => void {
    for (const stop of this.unbind.splice(0)) stop();
    this.binding = binding;
    this.unbind.push(binding.onEvent((event) => this.observe(event)));
    if (binding.onAccountActivated)
      this.unbind.push(
        binding.onAccountActivated(() => {
          this.attach();
          // After the other domains' activation (the SSH service starts there).
          setTimeout(() => this.restore(), 0);
        }),
      );
    this.attach();
    if (binding.onAccountDeactivating)
      this.unbind.push(binding.onAccountDeactivating(() => this.stopRemote()));
    return () => {
      for (const stop of this.unbind.splice(0)) stop();
      this.binding = undefined;
    };
  }

  /** The current local engine, told about its peers. */
  private attach(): Engine | undefined {
    const local = this.local();
    if (local !== this.attached) {
      // Another account signed in: the old one's SSH engines are gone.
      if (this.attached) {
        this.attached.peers = undefined;
        registries.delete(this.attached);
        void this.stopRemote();
      }
      this.attached = local;
    }
    if (local && this.binding) {
      local.peers = this.peers;
      registries.set(local, this);
    }
    return local;
  }

  /** The engine that runs the conversation (the local one for a local conversation). */
  forConversation(conversationId?: string): Engine {
    const local = this.attach();
    if (!local) throw new Error("Sign in to continue.");
    // Without the app's SSH service everything runs here.
    if (!conversationId || !this.binding) return local;
    const conversation = local["store"].conversations.find(
      (value: Conversation) => value.id === conversationId,
    );
    return this.forEnvironment(conversation?.environment);
  }

  /**
   * The engine running a conversation now, without starting one: the local
   * engine for a local conversation, the host's engine only while it exists.
   */
  running(conversationId: string): Engine | undefined {
    const local = this.attach();
    if (!local) return undefined;
    const conversation = local["store"].conversations.find(
      (value: Conversation) => value.id === conversationId,
    );
    const environment = conversation?.environment;
    if (!environment || environment.kind === "local") return local;
    return this.remote.get(keyOf(environment));
  }

  /** The engine of an environment; an SSH host's is created when needed. */
  forEnvironment(environment?: EnvironmentRef): Engine {
    const local = this.attach();
    if (!local) throw new Error("Sign in to continue.");
    if (!environment || environment.kind === "local") return local;
    const existing = this.remote.get(keyOf(environment));
    if (existing) {
      this.lastUsed.set(keyOf(environment), Date.now());
      return existing;
    }
    if (environment.kind === "space")
      return this.startSpace(local, environment);
    const binding = this.binding;
    if (!binding || !binding.ssh())
      throw new Error("SSH connections aren't available.");
    const hostId = environment.hostId;
    const launcher =
      binding.launcher?.(hostId) ??
      new SshLauncher({
        hostId,
        ssh: () => this.binding?.ssh(),
        dataRoot: binding.dataRoot,
        mirror: () => this.binding?.mirror?.(),
      });
    const engine = local.createPeer({
      environment: { kind: "ssh", hostId },
      launcher,
      outbox: this.outboxFor(local),
    });
    this.remote.set(hostId, engine);
    this.armIdle(hostId);
    return engine;
  }

  /** When each running space was last used (which one gives way at the limit). */
  private lastUsed = new Map<string, number>();

  /**
   * Starts a space's engine in its own sandbox. At the account's limit the
   * space unused longest that has nothing running gives way; with every one
   * busy the new one waits (an error the window shows).
   */
  private startSpace(
    local: Engine,
    environment: Extract<EnvironmentRef, { kind: "space" }>,
  ): Engine {
    const binding = this.binding;
    const sandbox = binding?.space?.(environment.spaceId);
    if (!binding || !sandbox)
      throw new Error("This conversation's space isn't available here.");
    const spaces = [...this.remote.keys()].filter((key) =>
      key.startsWith("space:"),
    );
    if (spaces.length >= (binding.maxSpaces ?? DEFAULT_MAX_SPACES)) {
      const idle = spaces
        .filter((key) => !this.remote.get(key)?.ownBusy())
        .sort(
          (a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0),
        );
      if (!idle.length)
        throw new Error(
          "Several of your conversations are running. Wait for one to finish and send again.",
        );
      void this.stopRemote(idle[0]);
    }
    const key = keyOf(environment);
    const engine = local.createPeer({
      environment,
      binary: sandbox.binary,
      root: sandbox.root,
      releaseEnvironment: () => this.stopRemote(key),
      environmentVariables: sandbox.environmentVariables,
    });
    this.remote.set(key, engine);
    this.lastUsed.set(key, Date.now());
    this.armIdle(key);
    return engine;
  }

  /** Every engine that is running for the signed-in account. */
  all(): Engine[] {
    const local = this.attach();
    return local ? [local, ...this.remote.values()] : [];
  }

  /** Some engine has a turn in progress. */
  isBusy(): boolean {
    return this.all().some((engine) =>
      typeof engine.ownBusy === "function" ? engine.ownBusy() : engine.isBusy(),
    );
  }

  /** Refuses a folder the person did not choose in its environment. */
  allowedFolder(folder: string | undefined, environment?: EnvironmentRef) {
    if (!this.binding?.allowedFolder)
      throw new Error("SSH connections aren't available.");
    this.binding.allowedFolder(folder, environment);
  }

  /** The account's outbox (one per local engine, so per profile). */
  private outboxFor(local: Engine): Outbox {
    let outbox = this.outboxes.get(local);
    if (!outbox) {
      outbox = new Outbox(local["store"].root);
      this.outboxes.set(local, outbox);
    }
    return outbox;
  }

  /** Stops one host's engine, or every SSH engine. */
  async stopRemote(hostId?: string): Promise<void> {
    const ids = hostId === undefined ? [...this.remote.keys()] : [hostId];
    await Promise.allSettled(
      ids.map(async (id) => {
        const engine = this.remote.get(id);
        this.remote.delete(id);
        clearTimeout(this.idleTimers.get(id));
        this.idleTimers.delete(id);
        this.lastUsed.delete(id);
        await engine?.stop();
        if (engine && id.startsWith("space:"))
          this.binding?.spaceStopped?.(id.slice("space:".length));
      }),
    );
  }

  /** Stops an SSH engine that has had nothing to do for a while. */
  private armIdle(hostId: string) {
    clearTimeout(this.idleTimers.get(hostId));
    const timer = setTimeout(
      () => {
        this.idleTimers.delete(hostId);
        const engine = this.remote.get(hostId);
        if (!engine) return;
        const local = this.attached;
        const waiting = local
          ? this.outboxFor(local).list(hostId).length > 0
          : false;
        if (engine.ownBusy() || waiting) this.armIdle(hostId);
        else void this.stopRemote(hostId);
      },
      hostId.startsWith("space:")
        ? (this.binding?.spaceIdleMs ?? DEFAULT_SPACE_IDLE_MS)
        : (this.binding?.idleMs ?? DEFAULT_IDLE_MS),
    );
    timer.unref?.();
    this.idleTimers.set(hostId, timer);
  }

  private observe(event: AppEvent) {
    if (event.type === "conversation") {
      const environment = event.conversation.environment;
      if (
        environment &&
        environment.kind !== "local" &&
        this.remote.has(keyOf(environment))
      )
        this.armIdle(keyOf(environment));
      return;
    }
    if (event.type !== "ssh-status") return;
    const { hostId, status } = event;
    if (
      status.state === "idle" ||
      (status.state === "error" && status.code === "policy-disabled")
    ) {
      // Disconnected on purpose, removed, or turned off by the administrator.
      if (this.remote.has(hostId)) void this.stopRemote(hostId);
      return;
    }
    if (status.state === "ready") void this.deliver(hostId);
  }

  /** Sends what waited for a host that is ready again. */
  private async deliver(hostId: string) {
    const local = this.attach();
    if (!local || !this.binding) return;
    if (!this.outboxFor(local).list(hostId).length) return;
    try {
      await this.forEnvironment({ kind: "ssh", hostId }).deliverOutbox();
    } catch (error) {
      console.error(
        "SSH outbox:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * After sign-in (or a restart): messages still in the outbox show as
   * waiting again, and their hosts are reached in the background (no
   * questions; a host that needs a password waits for the person).
   */
  restore() {
    const local = this.attach();
    const binding = this.binding;
    if (!local || !binding) return;
    const store = local["store"];
    const outbox = this.outboxFor(local);
    const ssh = binding.ssh();
    outbox.prune((entry) => {
      const conversation = store.conversations.find(
        (c: Conversation) => c.id === entry.conversationId,
      );
      return (
        !!conversation?.turns.some((t) => t.id === entry.id) &&
        (!ssh || !!ssh.hosts.get(entry.hostId))
      );
    });
    const hosts = new Set<string>();
    for (const entry of outbox.list()) {
      const conversation: Conversation = store.conversation(
        entry.conversationId,
      );
      const turn = conversation.turns.find((t) => t.id === entry.id);
      if (!turn || !isOutboxTurn(turn)) continue;
      // The store marked it stopped by the restart; it still waits.
      turn.status = "inProgress";
      delete turn.stopReason;
      turn.reconnecting = waitingNote(
        ssh?.hosts.get(entry.hostId)?.label ?? "the SSH host",
      );
      binding.push?.({
        type: "conversation",
        conversation: structuredClone(conversation),
      });
      hosts.add(entry.hostId);
    }
    if (hosts.size) store.flush();
    if (!ssh?.allowed()) return;
    for (const hostId of hosts)
      void ssh.connect(hostId, false).catch(() => {
        // The host stays unreachable; the messages keep waiting.
      });
  }
}
