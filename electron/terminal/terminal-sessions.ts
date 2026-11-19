import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CodexRPC } from "../engine/rpc";
import type { AppEvent, TerminalSessionInfo } from "../../shared/types";
import { createTerminalProcess, type TerminalProcessExecutor } from "./terminal-process";
import { CommandMarks, type TerminalShell } from "./terminal-shell-integration";
import { WindowsTerminalTree } from "./windows-terminal-tree";

export type { TerminalShell };
type TerminalSize = TerminalSessionInfo["size"];
export type TerminalStartOptions = {
  size?: TerminalSize;
  discardOnExit?: true;
};

const defaultSize: TerminalSize = { rows: 24, cols: 80 };

function terminalDimension(requested: number, fallback: number) {
  return Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 2), 1000)
    : fallback;
}

function terminalSize(
  requested: TerminalSize,
  fallback: TerminalSize,
): TerminalSize {
  return {
    rows: terminalDimension(requested.rows, fallback.rows),
    cols: terminalDimension(requested.cols, fallback.cols),
  };
}

interface Session extends TerminalSessionInfo {
  chunks: Buffer[];
  bytes: number;
  process?: ReturnType<typeof createTerminalProcess>;
  windowsTree?: WindowsTerminalTree;
  exit?: Promise<void>;
  exitConfirmed?: boolean;
  closing?: Promise<void>;
  /** Whether a command is running, from the shell's prompt marks. */
  marks: CommandMarks;
}
const OUTPUT_LIMIT = 1024 * 1024;
const CLOSE_TIMEOUT = 10_000;

/** This computer's shell: $SHELL (zsh or sh by default), Command Prompt on Windows. */
export function localShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): TerminalShell {
  if (platform === "win32")
    return { command: ["cmd.exe"], title: "Command Prompt" };
  const shell = env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  return {
    command: [shell, "-i"],
    title: shell.split("/").at(-1) || "Terminal",
  };
}

/** A shell a new terminal can start (the + button's Choose shell). */
export interface ShellOption {
  /** The program's path (or name on Windows). */
  id: string;
  name: string;
  command: string[];
}

const unixNames = new Set([
  "zsh",
  "bash",
  "fish",
  "sh",
  "dash",
  "ksh",
  "tcsh",
  "nu",
  "pwsh",
]);

/**
 * The shells on this computer: the account's own ($SHELL) first, then the
 * other known ones /etc/shells lists, once per name; on Windows Command
 * Prompt, Windows PowerShell, and PowerShell 7 and Git Bash when installed.
 */
export function localShells(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = fs.existsSync,
  read: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
): ShellOption[] {
  if (platform === "win32") {
    const out: ShellOption[] = [
      { id: "cmd.exe", name: "Command Prompt", command: ["cmd.exe"] },
      {
        id: "powershell.exe",
        name: "Windows PowerShell",
        command: ["powershell.exe", "-NoLogo"],
      },
    ];
    const programs = env.ProgramFiles ?? "C:\\Program Files";
    const pwsh = path.win32.join(programs, "PowerShell", "7", "pwsh.exe");
    if (exists(pwsh))
      out.push({ id: pwsh, name: "PowerShell", command: [pwsh, "-NoLogo"] });
    const gitBash = path.win32.join(programs, "Git", "bin", "bash.exe");
    if (exists(gitBash))
      out.push({ id: gitBash, name: "Git Bash", command: [gitBash, "-i"] });
    return out;
  }
  const own = localShell(platform, env).command[0];
  const listed = (() => {
    try {
      return read("/etc/shells")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("/"));
    } catch {
      return [];
    }
  })();
  const out: ShellOption[] = [];
  const names = new Set<string>();
  for (const program of [own, ...listed]) {
    const name = program.split("/").at(-1) ?? "";
    if (!name || names.has(name) || (program !== own && !unixNames.has(name)))
      continue;
    if (program !== own && !exists(program)) continue;
    names.add(name);
    out.push({ id: program, name, command: [program, "-i"] });
  }
  return out;
}

/** Interactive terminals belong to one signed-in account and one Codex connection. */
export class TerminalSessions {
  private sessions = new Map<string, Session>();
  private notification = (message: any) => {
    if (message.method !== "command/exec/outputDelta") return;
    const { processId, deltaBase64 } = message.params ?? {};
    const session = this.sessions.get(processId);
    if (!session || typeof deltaBase64 !== "string") return;
    const payload = Buffer.from(deltaBase64, "base64");
    const bytes = session.process?.read(payload) ?? payload;
    if (!bytes.length) return;
    session.chunks.push(bytes);
    session.bytes += bytes.length;
    while (session.bytes > OUTPUT_LIMIT) {
      const first = session.chunks[0];
      const overflow = session.bytes - OUTPUT_LIMIT;
      if (first.length <= overflow) {
        session.chunks.shift();
        session.bytes -= first.length;
      } else {
        session.chunks[0] = first.subarray(overflow);
        session.bytes -= overflow;
      }
    }
    session.sequence++;
    this.emit({
      type: "terminal-output",
      id: session.id,
      conversationId: session.conversationId,
      deltaBase64: bytes.toString("base64"),
      sequence: session.sequence,
    });
    if (session.marks.feed(bytes)) this.busyChanged(session);
  };
  /** Tells the window a command started or ended in a tab. */
  private busyChanged(session: Session) {
    session.busy = session.marks.busy;
    this.emit({
      type: "terminal-busy",
      id: session.id,
      conversationId: session.conversationId,
      busy: session.busy === true,
    });
  }
  constructor(
    readonly rpc: CodexRPC,
    private emit: (event: AppEvent) => void,
    private platform = process.platform,
    private executeProcess: TerminalProcessExecutor = async command => {
      await rpc.call("command/exec", {
        command,
        timeoutMs: 5000,
        outputBytesCap: 4096,
        sandboxPolicy: { type: "dangerFullAccess" },
      }, 6000);
    },
    private localProcessId?: number,
  ) {
    rpc.on("notification", this.notification);
  }
  list(conversationId: string): TerminalSessionInfo[] {
    return [...this.sessions.values()]
      .filter((session) => session.conversationId === conversationId)
      .map(({ chunks, bytes, marks, process, windowsTree, exit, exitConfirmed, closing, ...session }) => ({
        ...session,
        outputBase64: Buffer.concat(chunks, bytes).toString("base64"),
      }));
  }
  /**
   * The conversation's tabs where a command is still running, as far as
   * their shells' marks tell (a tab whose shell prints none is not listed).
   */
  busy(conversationId: string): string[] {
    return [...this.sessions.values()]
      .filter(
        (session) =>
          session.conversationId === conversationId &&
          session.running &&
          session.marks.busy === true,
      )
      .map((session) => session.id);
  }
  /**
   * Starts a terminal tab in `cwd`. `shell` names the program and the tab's
   * title when it is not this computer's own shell (an SSH host's, R9).
   */
  start(
    conversationId: string,
    cwd: string,
    readOnly: boolean,
    shell: TerminalShell = localShell(this.platform),
    options?: TerminalStartOptions,
  ): TerminalSessionInfo {
    if (this.sessions.size >= 12)
      throw Error("Close a terminal tab before starting another.");
    const id = randomUUID();
    const size = terminalSize(options?.size ?? defaultSize, defaultSize);
    const info: TerminalSessionInfo = {
      id,
      conversationId,
      title: shell.title,
      ...(shell.id ? { shell: shell.id } : {}),
      cwd,
      size,
      running: true,
      outputBase64: "",
      sequence: 0,
    };
    const windowsTree = this.localProcessId && this.platform === "win32"
      ? new WindowsTerminalTree(this.localProcessId)
      : undefined;
    const session: Session = {
      ...info,
      chunks: [],
      bytes: 0,
      marks: new CommandMarks(),
      windowsTree,
      process: createTerminalProcess(this.platform, id, shell.command, this.executeProcess),
    };
    this.sessions.set(id, session);
    // Codex refuses an interactive (streamed) command inside the Windows
    // sandbox ("streaming command/exec is not supported with windows
    // sandbox"), and its Linux sandbox starts the command in a new session
    // (bubblewrap --new-session): the shell has no controlling terminal, so
    // it has no job control and Ctrl+C reaches the sandbox helper instead,
    // which ends with the whole shell (owner report, 2026-10-30: any Ctrl+C
    // in an SSH host's terminal showed "Shell exited"). This computer's own
    // terminal is the person's shell, as in any terminal, so on Windows and
    // on Linux (this computer or an SSH host) it runs outside the sandbox;
    // on macOS the seatbelt wraps the shell in place and it keeps the
    // terminal, so a read-only tab and an SSH host's tab keep theirs.
    const ownWindowsShell =
      this.platform === "win32" &&
      localShells("win32").some(
        (option) => option.command[0] === shell.command[0],
      );
    const unsandboxed = ownWindowsShell || this.platform === "linux";
    const policy = unsandboxed
      ? { type: "dangerFullAccess" }
      : readOnly
        ? { type: "readOnly", networkAccess: false }
        : {
            type: "workspaceWrite",
            writableRoots: [cwd],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          };
    const finish = async (result: { exitCode?: number; error?: string }) => {
      session.exitConfirmed = result.error === undefined;
      if (!this.sessions.has(id) || session.closing) return;
      if (result.error !== undefined || (result.exitCode ?? 0) >= 128)
        await this.clean(session).catch(() => {});
      if (!this.sessions.has(id) || session.closing) return;
      windowsTree?.dispose();
      session.running = false;
      session.busy = undefined;
      if (options?.discardOnExit) this.sessions.delete(id);
      this.emit({ type: "terminal-exit", id, conversationId, ...result });
    };
    session.exit = this.rpc
      .call(
        "command/exec",
        {
          command: windowsTree?.command(shell.command) ?? session.process?.command ?? shell.command,
          processId: id,
          tty: true,
          streamStdin: true,
          streamStdoutStderr: true,
          disableTimeout: true,
          disableOutputCap: true,
          cwd,
          size,
          sandboxPolicy: policy,
          env: {
            ...shell.env,
            CLAUDEX_GATEWAY_TOKEN: null,
            OPENAI_API_KEY: null,
            ANTHROPIC_API_KEY: null,
          },
        },
        24 * 60 * 60 * 1000,
      )
      .then(
        (result: { exitCode: number }) => finish({ exitCode: result.exitCode }),
        (error: unknown) => finish({ error: error instanceof Error ? error.message : String(error) }),
      );
    return info;
  }
  private owned(conversationId: string, id: string) {
    const session = this.sessions.get(id);
    if (!session || session.conversationId !== conversationId)
      throw Error("Terminal tab was not found in this conversation.");
    return session;
  }
  async write(conversationId: string, id: string, deltaBase64: string) {
    const session = this.owned(conversationId, id);
    if (!session.running || session.closing) throw Error("This terminal has exited.");
    const bytes = Buffer.from(deltaBase64, "base64");
    if (
      !bytes.length ||
      bytes.length > 65536 ||
      bytes.toString("base64") !== deltaBase64
    )
      throw Error("Invalid terminal input.");
    if (session.marks.input(bytes)) this.busyChanged(session);
    await this.rpc.call(
      "command/exec/write",
      { processId: id, deltaBase64 },
      10000,
    );
  }
  async resize(conversationId: string, id: string, rows: number, cols: number) {
    const session = this.owned(conversationId, id);
    if (!session.running || session.closing) return;
    const size = terminalSize({ rows, cols }, session.size);
    await this.rpc.call("command/exec/resize", { processId: id, size }, 10000);
    session.size = size;
  }
  async close(conversationId: string, id: string) {
    const session = this.owned(conversationId, id);
    session.closing ??= this.finishClose(session).finally(() => {
      session.closing = undefined;
    });
    return session.closing;
  }
  private async finishClose(session: Session) {
    if (session.running) {
      const stoppedTree = await this.clean(session);
      try {
        if (!stoppedTree)
          await this.rpc.call("command/exec/terminate", { processId: session.id }, CLOSE_TIMEOUT);
      } catch (error) {
        if (!session.exitConfirmed) throw error;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          session.exit,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(Error("Terminal exit could not be confirmed.")), CLOSE_TIMEOUT);
            timer.unref();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (!session.exitConfirmed)
        throw Error("Terminal exit could not be confirmed.");
    }
    session.windowsTree?.dispose();
    if (this.sessions.delete(session.id) && session.running)
      this.emit({ type: "terminal-exit", id: session.id, conversationId: session.conversationId });
  }
  private async clean(session: Session): Promise<boolean> {
    if (session.windowsTree) return session.windowsTree.stopJobs();
    await session.process?.clean();
    return false;
  }
  async closeConversation(conversationId: string) {
    await Promise.allSettled(
      [...this.sessions.values()]
        .filter((item) => item.conversationId === conversationId)
        .map((item) => this.close(conversationId, item.id)),
    );
  }
  async reset(scope: "account" | "connection" = "account") {
    this.rpc.off("notification", this.notification);
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    if (scope === "account") this.emit({ type: "terminal-reset" });
    await Promise.allSettled(sessions.map(async (session) => {
      const { id, conversationId, windowsTree, running, exitConfirmed } = session;
      if (scope === "connection" && running)
        this.emit({
          type: "terminal-exit",
          id,
          conversationId,
          error: "The terminal connection was closed.",
        });
      const stoppedTree = !exitConfirmed && await this.clean(session).catch(() => false);
      windowsTree?.dispose();
      if (running && !stoppedTree)
        await this.rpc.call("command/exec/terminate", { processId: id }, 3000).catch(() => {});
    }));
  }
}
