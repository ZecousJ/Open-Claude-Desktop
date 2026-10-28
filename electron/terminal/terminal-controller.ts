import fs from "node:fs";
import path from "node:path";
import type {
  AppEvent,
  Conversation,
  EnvironmentRef,
  TerminalSessionInfo,
} from "../../shared/types";
import type { Engine } from "../engine/engine";
import { registryOf } from "../engine/engine-registry";
import type { CodexRPC } from "../engine/rpc";
import type { Store } from "../store/store";
import {
  localShell,
  localShells,
  TerminalSessions,
  type TerminalShell,
} from "./terminal-sessions";
import {
  integrateLocalShell,
  integrateRemoteShell,
  writeShellIntegration,
} from "./terminal-shell-integration";
import { checkHostPath, remoteShell } from "../ssh/remote-workspace";

/**
 * Account-scoped lifecycle and conversation authorization for interactive
 * terminals.
 *
 * A terminal runs where its conversation runs (R9): through this computer's
 * Codex, or through an SSH host's (the engine registry's engine for the
 * conversation), in the conversation's folder there, with the host's login
 * shell. Each engine connection has its own set of tabs.
 */
export class TerminalController {
  private sessions = new Map<Engine, TerminalSessions>();
  /** Each host connection's login shell, asked once. */
  private shells = new WeakMap<CodexRPC, Promise<string>>();
  /** First tabs being opened, so two calls at once share one tab. */
  private opening = new Map<string, Promise<TerminalSessionInfo>>();
  constructor(
    private store: Store,
    private engine: Engine,
    private emit: (event: AppEvent) => void,
    private platform = process.platform,
  ) {}

  private conversation(id: string): Conversation {
    const conversation = this.store.conversation(id);
    if (conversation.archived)
      throw Error("Archived conversations cannot open a terminal.");
    return conversation;
  }
  /**
   * The engine that runs the conversation. An SSH conversation never falls
   * back to this computer's engine: its folder is on the host.
   */
  private engineOf(conversation: Conversation, start = true): Engine {
    const environment = conversation.environment;
    if (environment?.kind !== "ssh") return this.engine;
    // Typing into or resizing a tab never creates a host's engine.
    const registry = registryOf(this.engine);
    const engine = start
      ? registry?.forConversation(conversation.id)
      : registry?.running(conversation.id);
    const own = engine?.environment as EnvironmentRef | undefined;
    if (!engine || own?.kind !== "ssh" || own.hostId !== environment.hostId)
      throw Error("This conversation's SSH host isn't available.");
    return engine;
  }
  private remote(engine: Engine) {
    return (engine.environment as EnvironmentRef | undefined)?.kind === "ssh";
  }
  private async manager(conversation: Conversation): Promise<TerminalSessions> {
    const engine = this.engineOf(conversation);
    if (!engine.rpc || engine.state.state !== "ready") {
      const provider = this.store.settings.providers.find(
        (item) => item.id === this.store.settings.activeProviderId,
      );
      if (!provider) throw Error("No model connection is available.");
      await engine.ensure(provider);
    }
    const rpc = engine.rpc;
    if (!rpc) throw Error("Codex is not connected.");
    // Tabs of an SSH connection that ended (the host's engine restarted).
    for (const [other, stale] of this.sessions)
      if (other !== engine && this.remote(other) && stale.rpc !== other.rpc) {
        stale.reset();
        this.sessions.delete(other);
      }
    let sessions = this.sessions.get(engine);
    if (sessions?.rpc !== rpc) {
      sessions?.reset();
      sessions = new TerminalSessions(
        rpc,
        this.emit,
        this.remote(engine) ? this.platformOf(engine) : this.platform,
      );
      this.sessions.set(engine, sessions);
    }
    return sessions;
  }
  /** The platform an engine's commands run on (an SSH host's, or this one). */
  private platformOf(engine: Engine): NodeJS.Platform {
    if (!this.remote(engine)) return this.platform;
    const platform = (engine as unknown as { platform?: NodeJS.Platform })
      .platform;
    return platform === "darwin" ? "darwin" : "linux";
  }
  private current(conversation: Conversation): TerminalSessions {
    const engine = this.engineOf(conversation, false);
    const sessions = this.sessions.get(engine);
    if (
      !sessions ||
      sessions.rpc !== engine.rpc ||
      engine.state.state !== "ready"
    )
      throw Error("Terminal connection is no longer available.");
    return sessions;
  }
  private readOnly(conversation: Conversation, platform: NodeJS.Platform) {
    return (
      platform === "win32" ||
      (conversation.mode === "code"
        ? this.store.settings.codePlanMode ||
          this.store.settings.codeSandbox === "read-only"
        : this.store.settings.sandbox === "read-only")
    );
  }
  private create(
    conversation: Conversation,
    manager: TerminalSessions,
    shellId?: string,
  ): TerminalSessionInfo {
    const cwd =
      conversation.cwd ?? path.join(this.store.root, "terminal-workspace");
    if (!conversation.cwd) fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())
      throw Error("The conversation folder is no longer available.");
    return manager.start(
      conversation.id,
      cwd,
      this.readOnly(conversation, this.platform),
      this.localShell(shellId),
    );
  }
  /**
   * The shells a new tab can start with, and the one it starts with by
   * default; none for a conversation on an SSH host (its login shell).
   */
  shellChoices(conversationId: string) {
    const conversation = this.conversation(conversationId);
    if (conversation.environment?.kind === "ssh")
      return { shells: [], defaultId: "" };
    const shells = localShells(this.platform).map(({ id, name }) => ({
      id,
      name,
    }));
    return { shells, defaultId: shells[0]?.id ?? "" };
  }
  /**
   * This computer's shell, with the hooks that tell when a command runs
   * (terminal-shell-integration.ts); as it is when their files can't be
   * written.
   */
  private localShell(shellId?: string): TerminalShell {
    const chosen = shellId
      ? localShells(this.platform).find((option) => option.id === shellId)
      : undefined;
    const shell: TerminalShell = chosen
      ? { command: chosen.command, title: chosen.name, id: chosen.id }
      : localShell(this.platform);
    try {
      const dir = writeShellIntegration(
        path.join(this.store.root, "shell-integration"),
      );
      return integrateLocalShell(shell, dir);
    } catch {
      return shell;
    }
  }
  /**
   * A tab on an SSH host: the conversation's folder there (it has no other),
   * checked on the host, and the host account's login shell.
   */
  private async createRemote(
    conversation: Conversation,
    manager: TerminalSessions,
  ): Promise<TerminalSessionInfo> {
    const engine = this.engineOf(conversation);
    const label =
      (engine as unknown as { launcher?: { label?: string } }).launcher
        ?.label || "SSH host";
    if (!conversation.cwd)
      throw Error(`Choose a folder on ${label} to open a terminal.`);
    const cwd = checkHostPath(conversation.cwd);
    const metadata = await manager.rpc
      .call("fs/getMetadata", { path: cwd }, 15_000)
      .catch(() => undefined);
    if (!metadata?.isDirectory)
      throw Error("The conversation folder is no longer available.");
    let shell = this.shells.get(manager.rpc);
    if (!shell) {
      shell = remoteShell(manager.rpc);
      this.shells.set(manager.rpc, shell);
    }
    const program = await shell;
    const terminal = integrateRemoteShell({
      command: [program, "-i"],
      title: `${program.split("/").at(-1) || "sh"} — ${label}`,
    });
    return manager.start(
      conversation.id,
      cwd,
      this.readOnly(conversation, this.platformOf(engine)),
      terminal,
    );
  }
  private async open(
    conversation: Conversation,
    manager: TerminalSessions,
    shellId?: string,
  ) {
    return conversation.environment?.kind === "ssh"
      ? this.createRemote(conversation, manager)
      : this.create(conversation, manager, shellId);
  }
  async list(id: string) {
    const conversation = this.conversation(id);
    return (await this.manager(conversation)).list(conversation.id);
  }
  /** The conversation's tabs; the first one is opened when there are none. */
  async ensure(id: string) {
    const conversation = this.conversation(id),
      manager = await this.manager(conversation);
    const existing = manager.list(conversation.id);
    if (existing.length) return existing;
    let opening = this.opening.get(conversation.id);
    if (!opening) {
      opening = this.open(conversation, manager).finally(() =>
        this.opening.delete(conversation.id),
      );
      this.opening.set(conversation.id, opening);
    }
    await opening;
    return manager.list(conversation.id);
  }
  async start(id: string, shellId?: string) {
    const conversation = this.conversation(id);
    return this.open(conversation, await this.manager(conversation), shellId);
  }
  write(conversationId: string, id: string, deltaBase64: string) {
    const conversation = this.conversation(conversationId);
    return this.current(conversation).write(conversation.id, id, deltaBase64);
  }
  resize(conversationId: string, id: string, rows: number, cols: number) {
    const conversation = this.conversation(conversationId);
    return this.current(conversation).resize(conversation.id, id, rows, cols);
  }
  /**
   * The conversation's tabs where a command is still running. Never starts
   * an engine: with no live connection no tab is running anything.
   */
  busy(conversationId: string): string[] {
    const conversation = this.conversation(conversationId);
    let sessions: TerminalSessions;
    try {
      sessions = this.current(conversation);
    } catch {
      return [];
    }
    return sessions.busy(conversation.id);
  }
  close(conversationId: string, id: string) {
    const conversation = this.conversation(conversationId);
    return this.current(conversation).close(conversation.id, id);
  }
  async closeConversation(conversationId: string) {
    await Promise.allSettled(
      [...this.sessions.values()].map((sessions) =>
        sessions.closeConversation(conversationId),
      ),
    );
  }
  reset() {
    for (const sessions of this.sessions.values()) sessions.reset();
    this.sessions.clear();
  }
}
