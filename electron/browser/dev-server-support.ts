/**
 * Dev servers of a Code session's folder (R8-B): the configurations in
 * `.claude/launch.json` (read-only fallback `.claudex/launch.json`), Detect
 * dev server, starting a configuration and waiting for its port, its logs,
 * stopping it, and local addresses printed in the session's Terminal.
 *
 * Starting runs a program on this computer outside Claude's sandbox, so:
 *
 * - each different command (folder, executable, arguments, variables) is
 *   approved once per session: by the person in the panel, or through the
 *   approval Claude's Browser tools ask for (package R8-C passes `approve`);
 *   a server that crashes or fails to start asks again;
 * - Claude can't start a dev server while a scheduled task runs the session
 *   (nobody is there to approve);
 * - the command never goes through a shell, its folder must stay inside the
 *   session's folder (symbolic links resolved), and the app's tokens and
 *   keys are removed from its environment;
 * - every server stops when its session is deleted, at sign-out and when
 *   the app quits.
 *
 * No Electron imports: tests run it under node with stand-ins.
 */
import { spawn as nodeSpawn, execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripAnsi } from "../../shared/launch-config";
import type { DevServerTiming } from "./dev-servers";

export const defaultTiming: DevServerTiming = {
  portTimeoutMs: 60_000,
  pollMs: 250,
  killGraceMs: 5_000,
  sweepMs: 30_000,
  detectedRecheckMs: 10_000,
};

export const logLimits = { lines: 2000, lineChars: 2048 } as const;

/**
 * The last lines a server printed (stdout and stderr together), without
 * colours; a carriage return keeps only what follows it, like a terminal.
 */
export class LogBuffer {
  private lines: string[] = [];
  private partial = new Map<string, string>();
  private decoders = new Map<string, StringDecoder>();
  constructor(private readonly max: number = logLimits.lines) {}
  write(stream: string, chunk: Buffer | string) {
    let decoder = this.decoders.get(stream);
    if (!decoder) {
      decoder = new StringDecoder("utf8");
      this.decoders.set(stream, decoder);
    }
    const text =
      (this.partial.get(stream) ?? "") +
      (typeof chunk === "string" ? chunk : decoder.write(chunk));
    const parts = text.split("\n");
    this.partial.set(stream, parts.pop() ?? "");
    for (const line of parts) this.push(line);
    const rest = this.partial.get(stream) ?? "";
    // A line that never ends (a progress bar) still stays bounded.
    if (rest.length > logLimits.lineChars * 4) {
      this.push(rest);
      this.partial.set(stream, "");
    }
  }
  /** A line from Claudex itself ("Exited with code 1"). */
  note(line: string) {
    this.flush();
    this.push(line);
  }
  flush() {
    for (const [stream, rest] of this.partial) {
      if (rest) this.push(rest);
      this.partial.set(stream, "");
    }
  }
  tail(count = this.max) {
    const pending = [...this.partial.values()]
      .filter(Boolean)
      .map((line) => this.clean(line));
    const all = [...this.lines, ...pending];
    return count >= all.length ? all : all.slice(all.length - count);
  }
  private clean(line: string) {
    let text = line.endsWith("\r") ? line.slice(0, -1) : line;
    const cr = text.lastIndexOf("\r");
    if (cr >= 0) text = text.slice(cr + 1);
    text = stripAnsi(text);
    return text.length > logLimits.lineChars
      ? text.slice(0, logLimits.lineChars) + "…"
      : text;
  }
  private push(line: string) {
    this.lines.push(this.clean(line));
    if (this.lines.length > this.max)
      this.lines.splice(0, this.lines.length - this.max);
  }
}

const secretName =
  /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_KEY|SESSION_KEY/i;

/**
 * The app's environment without secrets and without variables meant for
 * the app itself (CLAUDEX_*, CODEX_*, ELECTRON_*), as Codex's
 * shell_environment_policy removes them from commands.
 */
export function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (secretName.test(key)) continue;
    if (/^(?:CLAUDEX_|CODEX_|ELECTRON_|ANTHROPIC_|OPENAI_)/i.test(key))
      continue;
    out[key] = value;
  }
  return out;
}

/** PATH entries of `first`, then those of `second` not already present. */
export function mergePath(
  first: string | undefined,
  second: string | undefined,
  separator: string,
) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of [first, second])
    for (const entry of (list ?? "").split(separator))
      if (entry && !seen.has(entry)) {
        seen.add(entry);
        out.push(entry);
      }
  return out.join(separator);
}

let loginPath: Promise<string | undefined> | undefined;

/**
 * The PATH the person's login shell sets up (Homebrew, nvm, asdf …): apps
 * opened from the Dock or Finder only get the system default. Asked once,
 * five seconds at most; undefined on Windows or when the shell fails.
 */
export function loginShellPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (platform === "win32") return Promise.resolve(undefined);
  loginPath ??= new Promise((resolve) => {
    const shell = env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
    const marker = "__CLAUDEX_PATH__";
    execFile(
      shell,
      ["-ilc", `printf '\\n${marker}%s${marker}\\n' "$PATH"`],
      {
        timeout: 5_000,
        env: { ...scrubEnv(env), TERM: "dumb" },
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (_error, stdout) => {
        const match = String(stdout ?? "").match(
          new RegExp(`${marker}(.*?)${marker}`),
        );
        resolve(match?.[1] || undefined);
      },
    );
  });
  return loginPath;
}

/** Whether something accepts TCP connections on the port at 127.0.0.1 or [::1]. */
export function localPortOpen(port: number, timeoutMs = 1_000) {
  const attempt = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      const done = (open: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  return attempt("127.0.0.1").then((open) => open || attempt("::1"));
}

// Windows: .cmd and .bat files (npm, pnpm, yarn) only run through cmd.exe.
const cmdMeta = /([()\][%!^"`<>&|;, *?])/g;

/** An argument quoted for cmd.exe /s /c (the rules cross-spawn uses). */
export function quoteWindowsArg(arg: string, doubleEscape: boolean) {
  let value = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  value = `"${value}"`.replace(cmdMeta, "^$1");
  return doubleEscape ? value.replace(cmdMeta, "^$1") : value;
}

/**
 * How to spawn `executable` on Windows: an .exe directly, a .cmd or .bat
 * through cmd.exe with every argument quoted. The executable is looked up
 * in PATH with PATHEXT.
 */
export function windowsCommand(
  executable: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  exists: (file: string) => boolean = (file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  },
): { command: string; args: string[]; verbatim: boolean } {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const extKey = Object.keys(env).find(
    (key) => key.toUpperCase() === "PATHEXT",
  );
  const exts = ((extKey && env[extKey]) || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  const hasExt = /\.[A-Za-z0-9]+$/.test(executable);
  const candidates = /[\\/]/.test(executable)
    ? [path.win32.resolve(cwd, executable)]
    : ((pathKey && env[pathKey]) || "")
        .split(";")
        .filter(Boolean)
        .map((dir) => path.win32.join(dir, executable));
  let resolved: string | undefined;
  for (const base of candidates) {
    for (const file of hasExt ? [base] : exts.map((ext) => base + ext))
      if (exists(file)) {
        resolved = file;
        break;
      }
    if (resolved) break;
  }
  const target = resolved ?? executable;
  if (!/\.(?:cmd|bat)$/i.test(target))
    return { command: target, args, verbatim: false };
  const line = [target, ...args]
    .map((arg, index) =>
      index === 0
        ? `"${arg}"`.replace(cmdMeta, "^$1")
        : quoteWindowsArg(arg, true),
    )
    .join(" ");
  return {
    command: env.ComSpec || env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    verbatim: true,
  };
}

export function defaultKill(platform: NodeJS.Platform) {
  return (pid: number, signal: NodeJS.Signals) => {
    if (platform === "win32") {
      try {
        nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        }).on("error", () => {});
      } catch {
        // Already gone.
      }
      return;
    }
    try {
      // The server's process group: npm and the node it started, and so on.
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
  };
}

export function lower(name: string) {
  return name.trim().toLowerCase();
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
