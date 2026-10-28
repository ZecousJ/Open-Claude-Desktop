/**
 * A Code conversation's folder on an SSH host (R9): the Changes panel's
 * `git` queries, the `@` file list, the branch chip, generated file
 * snapshots and the terminal's shell, all run on the host.
 *
 * Every question is one fixed command: `git` with the Changes panel's safe
 * settings, or `/bin/sh -c '<fixed script>' sh <values…>`, where paths and
 * names only ever arrive as arguments ("$1", "$@"), never as shell text.
 * Two ways reach the host:
 *
 *  - the host's Codex app-server (`command/exec`), while its engine runs;
 *  - otherwise the SSH connection itself (`SshConnection.exec`, which sends
 *    the script base64-encoded, see remote-scripts.ts), so the Code home
 *    can show a branch and `@` files before the first message starts Codex.
 *
 * Nothing here ever touches this computer's files with a host's path.
 * The commands read only; they run without Codex's sandbox, like the
 * Changes panel's local `git` (on macOS hosts `git` is an xcrun shim that
 * fails inside it), and without the gateway token or API keys in their
 * environment.
 */
import type { MentionFile } from "../../shared/composer-api";
import type { WorkspaceGit } from "../../shared/code-usage-api";
import type {
  AppEvent,
  Conversation,
  EnvironmentRef,
} from "../../shared/types";
import type { Engine } from "../engine/engine";
import type { CodexRPC } from "../engine/rpc";
import type { SshServiceApi } from "../ipc/ssh";
import type { WorkspaceFs } from "../workspace/workspace-fs";
import {
  mentionFilesWith,
  mentionLimits,
  mentionSkippedFolders,
  parseFolderListing,
} from "../engine/composer-files";
import { FileTooLargeError } from "../artifacts/generated-files";
import { workspaceGitWith } from "../git/git-branch";
import {
  gitEnvironment,
  safeGitConfig,
  type GitRunner,
  type TreeEntry,
} from "../git/working-tree";
import { shQuote } from "./remote-scripts";

/** One command on the host. */
export interface RemoteCommand {
  argv: string[];
  /** An absolute folder on the host. */
  cwd?: string;
  /** Extra environment (names in capitals, values plain text). */
  env?: Record<string, string>;
  /** Default 30 seconds. */
  timeoutMs?: number;
  /** Default 4 MB of output. */
  maxOutput?: number;
}

/** Its outcome; `code` is null when it was stopped (time or output limit). */
export interface RemoteResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type RemoteRunner = (command: RemoteCommand) => Promise<RemoteResult>;

/** The host could not be asked (not connected, connection lost). */
export class RemoteUnavailableError extends Error {
  readonly transport = true;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_OUTPUT = 4 * 1024 * 1024;
/** Like the local `git`'s maxBuffer (working-tree.ts). */
const GIT_OUTPUT = 32_000_000;
/** Paths per script call (keeps the command line short). */
const BATCH = 200;
const MAX_REMOTE_FOLDER = 4096;
const envName = /^[A-Z_][A-Z0-9_]*$/;
/** Secrets of the app-server's own environment never reach these commands. */
const hiddenEnvironment = {
  CLAUDEX_GATEWAY_TOKEN: null,
  OPENAI_API_KEY: null,
  ANTHROPIC_API_KEY: null,
};

/**
 * An absolute folder or file path on the host: starts with "/", at most
 * 4096 characters, no NUL, line breaks or other control characters.
 */
export function checkHostPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.length > MAX_REMOTE_FOLDER ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error("This folder isn't a usable path on the SSH host.");
  return value;
}

function checkCommand(command: RemoteCommand) {
  if (!command.argv.length) throw new Error("Nothing to run.");
  for (const value of command.argv)
    if (value.includes("\0")) throw new Error("A value contains a NUL byte.");
  if (command.cwd !== undefined) checkHostPath(command.cwd);
  for (const [name, value] of Object.entries(command.env ?? {}))
    if (!envName.test(name) || value.includes("\0"))
      throw new Error("Invalid environment variable.");
}

/** Runs commands through the host's Codex app-server (`command/exec`). */
export function rpcRunner(
  rpc: Pick<CodexRPC, "call" | "connected">,
): RemoteRunner {
  return async (command) => {
    checkCommand(command);
    const timeoutMs = command.timeoutMs ?? DEFAULT_TIMEOUT;
    try {
      const result = await rpc.call(
        "command/exec",
        {
          command: command.argv,
          cwd: command.cwd ?? null,
          env: { ...command.env, ...hiddenEnvironment },
          timeoutMs,
          outputBytesCap: command.maxOutput ?? DEFAULT_OUTPUT,
          sandboxPolicy: { type: "dangerFullAccess" },
        },
        timeoutMs + 5_000,
      );
      return {
        code: typeof result?.exitCode === "number" ? result.exitCode : null,
        stdout: typeof result?.stdout === "string" ? result.stdout : "",
        stderr: typeof result?.stderr === "string" ? result.stderr : "",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The app-server went away: the host can't be asked right now.
      if (!rpc.connected) throw new RemoteUnavailableError(message);
      return { code: null, stdout: "", stderr: message };
    }
  };
}

/** What the connection runner needs from an SSH connection. */
export interface ExecConnection {
  exec(
    script: string,
    options?: { timeoutMs?: number; maxOutput?: number },
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

/**
 * Runs commands through the SSH connection: `cd` to the folder, set the
 * environment, `exec` the command, every value single-quoted.
 */
export function connectionRunner(connection: ExecConnection): RemoteRunner {
  return async (command) => {
    checkCommand(command);
    const lines: string[] = [];
    for (const name of Object.keys(hiddenEnvironment))
      lines.push(`unset ${name}`);
    for (const [name, value] of Object.entries(command.env ?? {}))
      lines.push(`${name}=${shQuote(value)}; export ${name}`);
    if (command.cwd !== undefined)
      lines.push(`cd -- ${shQuote(command.cwd)} 2>/dev/null || exit 125`);
    lines.push(`exec ${command.argv.map(shQuote).join(" ")}`);
    try {
      return await connection.exec(lines.join("\n"), {
        timeoutMs: command.timeoutMs ?? DEFAULT_TIMEOUT,
        maxOutput: command.maxOutput ?? DEFAULT_OUTPUT,
      });
    } catch (error) {
      throw new RemoteUnavailableError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}

/** `/bin/sh -c <script> sh <args…>`: the values stay arguments. */
function shell(script: string, args: string[]) {
  return ["/bin/sh", "-c", script, "sh", ...args];
}

/** Reads a file inside a folder: exit codes are explained by `readRefusal`. */
export const READ_FILE_SCRIPT = [
  `root=$(cd -- "$1" 2>/dev/null && pwd -P) || exit 3`,
  `d=$(cd -- "$(dirname -- "$2")" 2>/dev/null && pwd -P) || exit 4`,
  `t=$d/$(basename -- "$2")`,
  `if [ "$root" != / ]; then case $d/ in "$root"/*) ;; *) exit 5 ;; esac; fi`,
  `if [ -L "$t" ]; then exit 6; fi`,
  `[ -e "$t" ] || exit 4`,
  `[ -f "$t" ] || exit 6`,
  `s=$(wc -c < "$t" | tr -d ' ') || exit 7`,
  `[ "$s" -le "$3" ] || exit 8`,
  `printf 'size=%s\\n' "$s"`,
  `head -c "$3" < "$t" | base64`,
].join("\n");

function readRefusal(code: number | null) {
  switch (code) {
    case 3:
      return "The conversation folder is no longer available.";
    case 4:
      return "This file no longer exists.";
    case 5:
      return "This file resolves outside the conversation workspace.";
    case 6:
      return "Only regular files can be previewed.";
    case 8:
      return "The generated file is too large to preview.";
    default:
      return "The generated file could not be read.";
  }
}

/** "<index> l 0" for a link, "<index> f <size>" for a regular file. */
export const ENTRIES_SCRIPT = [
  `i=0`,
  `for f in "$@"; do`,
  `  i=$((i+1))`,
  `  if [ -L "$f" ]; then printf '%s l 0\\n' "$i"`,
  `  elif [ -f "$f" ]; then printf '%s f %s\\n' "$i" "$(wc -c < "$f" | tr -d ' ')"`,
  `  fi`,
  `done`,
].join("\n");

/**
 * "<index> <lines>" for each regular file up to $1 bytes; lines as the
 * local count has them (a last line without a newline counts).
 */
export const LINE_COUNT_SCRIPT = [
  `max=$1; shift`,
  `i=0`,
  `for f in "$@"; do`,
  `  i=$((i+1))`,
  `  if [ -L "$f" ] || [ ! -f "$f" ]; then continue; fi`,
  `  s=$(wc -c < "$f" | tr -d ' ')`,
  `  [ "$s" -le "$max" ] || continue`,
  `  printf '%s %s\\n' "$i" "$(awk 'END { print NR }' < "$f")"`,
  `done`,
].join("\n");

/** The `@` listing: "d./path" and "f./path" records, NUL-terminated. */
export function listFolderScript() {
  const skipped = mentionSkippedFolders
    .map((name) => `-name ${shQuote(name)}`)
    .join(" -o ");
  // Folders, then files: one find each, with `-exec … +` at the top level
  // (BusyBox find prints nothing for `-exec … +` inside parentheses; found
  // by the R9-S7 end-to-end test on an Alpine host).
  const find = (type: "d" | "f") =>
    `find . -mindepth 1 -maxdepth ${mentionLimits.depth}` +
    ` \\( -type d \\( ${skipped} \\) -prune \\)` +
    ` -o -type ${type} -exec printf '${type}%s\\0' {} +`;
  return [
    `cd -- "$1" 2>/dev/null || exit 3`,
    `{ ${find("d")}; ${find("f")}; } 2>/dev/null | head -c ${LISTING_BYTES}`,
  ].join("\n");
}
const LISTING_BYTES = 4 * 1024 * 1024;

/** Reads "<index> <rest>" lines back into the paths they name. */
function byIndex(output: string, files: string[]) {
  const found = new Map<string, string[]>();
  for (const line of output.split("\n")) {
    const [index, ...rest] = line.trim().split(" ");
    const file = files[Number(index) - 1];
    if (file !== undefined && rest.length) found.set(file, rest);
  }
  return found;
}

/**
 * The folder of an SSH conversation (see the file comment). `runner` picks
 * the way to the host for each question, and throws RemoteUnavailableError
 * when there is none.
 */
export class RemoteWorkspace implements WorkspaceFs {
  readonly environment: EnvironmentRef;
  constructor(
    readonly hostId: string,
    readonly label: string,
    private readonly runner: () => RemoteRunner,
  ) {
    this.environment = { kind: "ssh", hostId };
  }

  private run(command: RemoteCommand) {
    return this.runner()(command);
  }

  readonly git: GitRunner = async (cwd, args, okCodes = [0]) => {
    const result = await this.run({
      argv: ["git", ...safeGitConfig, ...args],
      cwd: checkHostPath(cwd),
      env: gitEnvironment,
      maxOutput: GIT_OUTPUT,
    });
    if (result.code !== null && okCodes.includes(result.code))
      return result.stdout;
    throw Object.assign(
      new Error(
        result.stderr.trim().split("\n")[0] ||
          `git exited with ${result.code ?? "an error"}`,
      ),
      { code: result.code },
    );
  };

  async entries(top: string, files: string[]) {
    const found = new Map<string, TreeEntry>();
    for (let start = 0; start < files.length; start += BATCH) {
      const batch = files.slice(start, start + BATCH);
      const result = await this.run({
        argv: shell(ENTRIES_SCRIPT, batch),
        cwd: checkHostPath(top),
      });
      if (result.code !== 0) continue;
      for (const [file, [kind, size]] of byIndex(result.stdout, batch)) {
        const bytes = Number(size);
        if ((kind === "f" || kind === "l") && Number.isSafeInteger(bytes))
          found.set(file, {
            kind: kind === "f" ? "file" : "symlink",
            size: bytes,
          });
      }
    }
    return found;
  }

  async lineCounts(top: string, files: string[], maxBytes: number) {
    const counts: Record<string, number> = {};
    for (let start = 0; start < files.length; start += BATCH) {
      const batch = files.slice(start, start + BATCH);
      const result = await this.run({
        argv: shell(LINE_COUNT_SCRIPT, [String(maxBytes), ...batch]),
        cwd: checkHostPath(top),
        timeoutMs: 60_000,
      });
      if (result.code !== 0) continue;
      for (const [file, [lines]] of byIndex(result.stdout, batch)) {
        const count = Number(lines);
        if (Number.isSafeInteger(count) && count >= 0) counts[file] = count;
      }
    }
    return counts;
  }

  async isDirectory(folder: string) {
    const result = await this.run({
      argv: shell(`[ -d "$1" ]`, [checkHostPath(folder)]),
    });
    return result.code === 0;
  }

  /** Every file and folder under `root`, relative (links are left out). */
  async listFolder(root: string): Promise<MentionFile[]> {
    const result = await this.run({
      argv: shell(listFolderScript(), [checkHostPath(root)]),
      maxOutput: LISTING_BYTES + 1024,
      timeoutMs: 30_000,
    });
    if (result.code === 3)
      throw new Error("The conversation folder is no longer available.");
    return parseFolderListing(result.stdout);
  }

  mentionFiles(root: string, query: string) {
    return mentionFilesWith(`ssh:${this.hostId}\0${root}`, query, () =>
      this.listFolder(root),
    );
  }

  workspaceGit(folder: string): Promise<WorkspaceGit> {
    return workspaceGitWith(this.git, checkHostPath(folder));
  }

  /**
   * A regular file inside `cwd` (not a link, not resolving outside it), up
   * to `maxBytes`; a message the file card shows otherwise.
   */
  readonly readFileInside = async (
    cwd: string,
    file: string,
    maxBytes: number,
  ): Promise<Buffer> => {
    const limit = Math.max(0, Math.floor(maxBytes));
    const result = await this.run({
      argv: shell(READ_FILE_SCRIPT, [
        checkHostPath(cwd),
        checkHostPath(file),
        String(limit),
      ]),
      maxOutput: Math.ceil(limit * 1.4) + 4096,
      timeoutMs: 60_000,
    });
    if (result.code === 8) throw new FileTooLargeError();
    if (result.code !== 0) throw new Error(readRefusal(result.code));
    const newline = result.stdout.indexOf("\n");
    const size = Number(
      /^size=(\d+)$/.exec(result.stdout.slice(0, newline))?.[1] ?? NaN,
    );
    const data = Buffer.from(result.stdout.slice(newline + 1), "base64");
    if (!Number.isSafeInteger(size) || data.length !== size)
      throw new Error("The file changed while preparing its preview.");
    return data;
  };

  async writeFileInside(
    cwd: string,
    file: string,
    bytes: Buffer,
    authorize?: () => void,
  ) {
    checkHostPath(cwd);
    checkHostPath(file);
    const script = [
      `root=$(cd -- "$1" && pwd -P) || exit 3`,
      `parent=$(cd -- "$(dirname -- "$2")" && pwd -P) || exit 4`,
      `case "$parent/" in "$root/"*) ;; *) exit 5 ;; esac`,
      `target=$parent/$(basename -- "$2")`,
      `[ ! -L "$target" ] || exit 6`,
      `if [ -e "$target" ]; then [ -f "$target" ] || exit 6; fi`,
      `mktemp "$parent/.claudex-restore.XXXXXXXX" || exit 7`,
    ].join("\n");
    authorize?.();
    const prepared = await this.run({ argv: shell(script, [cwd, file]) });
    if (prepared.code !== 0) throw new Error(readRefusal(prepared.code));
    const temporary = checkHostPath(prepared.stdout.trim());
    try {
      for (let offset = 0; offset < bytes.length; offset += 24000) {
        authorize?.();
        const result = await this.run({
          argv: shell(`printf '%s' "$2" | base64 -d >> "$1"`, [
            temporary,
            bytes.subarray(offset, offset + 24000).toString("base64"),
          ]),
        });
        if (result.code !== 0) throw new Error(readRefusal(result.code));
      }
      authorize?.();
      const committed = await this.run({
        argv: shell(
          [
            `root=$(cd -- "$1" && pwd -P) || exit 3`,
            `parent=$(cd -- "$(dirname -- "$2")" && pwd -P) || exit 4`,
            `case "$parent/" in "$root/"*) ;; *) exit 5 ;; esac`,
            `[ "$(dirname -- "$3")" = "$parent" ] || exit 5`,
            `target=$parent/$(basename -- "$2")`,
            `[ ! -L "$target" ] && [ ! -L "$3" ] && [ -f "$3" ] || exit 6`,
            `if [ -e "$target" ]; then [ -f "$target" ] || exit 6; fi`,
            `mv -f -- "$3" "$target"`,
          ].join("\n"),
          [cwd, file, temporary],
        ),
      });
      if (committed.code !== 0) throw new Error(readRefusal(committed.code));
    } finally {
      await this.run({ argv: ["rm", "-f", "--", temporary] }).catch(() => {});
    }
  }
}

/** Where to find the account's engines and SSH connections. */
export interface RemoteSources {
  /** Every running engine (EngineRegistry.all). */
  engines(): readonly Engine[];
  ssh(): SshServiceApi | undefined;
}

/** The engine of a host while its Codex runs and answers. */
export function readyEngine(
  engines: readonly Engine[],
  hostId: string,
): Engine | undefined {
  return engines.find((engine) => {
    const environment = engine.environment as EnvironmentRef | undefined;
    return (
      environment?.kind === "ssh" &&
      environment.hostId === hostId &&
      !!engine.rpc &&
      engine.state.state === "ready"
    );
  });
}

/** The host's folder, asked through its Codex when it runs, else through SSH. */
export function remoteWorkspace(
  sources: RemoteSources,
  hostId: string,
): RemoteWorkspace {
  const service = sources.ssh();
  const label = service?.hosts.get(hostId)?.label ?? "the SSH host";
  return new RemoteWorkspace(hostId, label, () => {
    const ssh = sources.ssh();
    if (!ssh || !ssh.allowed())
      throw new RemoteUnavailableError("SSH connections aren't available.");
    if (!ssh.hosts.get(hostId))
      throw new RemoteUnavailableError("That SSH connection no longer exists.");
    const engine = readyEngine(sources.engines(), hostId);
    if (engine?.rpc) return rpcRunner(engine.rpc);
    const connection = ssh.existing(hostId);
    const state = connection?.status.state;
    if (
      connection &&
      (state === "ready" || state === "starting" || state === "installing")
    )
      return connectionRunner(connection);
    throw new RemoteUnavailableError(
      state === "reconnecting"
        ? `Reconnecting to ${label}…`
        : `Connect to ${label} first.`,
    );
  });
}

/**
 * The login shell of the host's account for a terminal tab (`$SHELL`, else
 * /bin/sh), asked once per Codex connection.
 */
export async function remoteShell(
  rpc: Pick<CodexRPC, "call" | "connected">,
): Promise<string> {
  const result = await rpcRunner(rpc)({
    argv: shell(`printf '%s' "\${SHELL:-}"`, []),
    timeoutMs: 10_000,
  });
  const value = result.code === 0 ? result.stdout.trim() : "";
  return /^\/[\w./+-]{1,255}$/.test(value) ? value : "/bin/sh";
}

/** What the generated files watcher needs from the app. */
export interface GeneratedFilesSources extends RemoteSources {
  readonly store: {
    readonly root: string;
    readonly conversations: Conversation[];
    flush(): void;
  };
  push(event: AppEvent): void;
  onEvent(cb: (event: AppEvent) => void): () => void;
}

/** A change completed longer ago than this is history: never read again. */
export const FRESH_MS = 60_000;
