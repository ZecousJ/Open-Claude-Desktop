/**
 * The Changes panel's `git` queries for a cloud Code session, run inside the
 * user's sandbox (W-CODEENG: "working-tree data via sandbox exec"), never on
 * the runner host: a session's folder is written by the model, and a
 * repository's own config (clean filters, fsmonitor, hooks) would otherwise
 * run programs on the host.
 *
 * The sandbox is the driver's launcher for `/usr/bin/git` with the user's
 * workspace mounted read-only and no network. The two file reads the panel
 * needs on top (`entries`, `lineCounts`) stay on the host but never follow a
 * link and never open anything but a regular file.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  gitEnvironment,
  safeGitConfig,
  type GitRunner,
  type TreeEntry,
  type WorkingTreeHost,
} from "../../electron/git/working-tree";
import type { SandboxDriver, SandboxLimits } from "./sandbox/driver";
import { within } from "./sandbox/driver";

export interface SandboxGitInput {
  driver: SandboxDriver;
  userId: number | string;
  /** The user's store root (`<root>/workspace`, `<root>/codex-home`). */
  storeRoot: string;
  /** Runner-private directory (`<stateRoot>/<sandbox id>`). */
  stateRoot: string;
  /** The git program inside the sandbox (a system directory). */
  git?: string;
  limits?: SandboxLimits;
  /** Replaces the process spawner (tests). */
  run?: (
    file: string,
    args: string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; code: number }>;
}

const MAX_BUFFER = 32_000_000;

function execute(
  file: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
) {
  return new Promise<{ stdout: string; code: number }>((resolve, reject) => {
    execFile(
      file,
      args,
      { ...options, timeout: 30_000, maxBuffer: MAX_BUFFER },
      (error, stdout) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? -1
              : 0;
        if (code === -1) reject(error);
        else resolve({ stdout, code });
      },
    );
  });
}

/** A regular file's line count, without following links or blocking on pipes. */
async function safeLineCount(file: string, maxBytes: number) {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    const text = await handle.readFile("utf8");
    if (!text) return 0;
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** The working-tree reader of one user's cloud sessions. */
export function sandboxWorkingTree(input: SandboxGitInput): WorkingTreeHost {
  const workspace = path.join(input.storeRoot, "workspace");
  const home = path.join(input.storeRoot, "codex-home");
  const git = input.git ?? "/usr/bin/git";
  const run = input.run ?? execute;
  let launcher: string | undefined;
  // Path names may reach the workspace through a link (/var on macOS), and
  // paths from the sandbox are real paths.
  const inWorkspace = (folder: string) => {
    const resolved = path.resolve(folder);
    if (within(resolved, workspace)) return true;
    try {
      return within(resolved, fs.realpathSync(workspace));
    } catch {
      return false;
    }
  };
  const prepare = () => {
    if (launcher) return launcher;
    const id = `git-${String(input.userId).replace(/[^A-Za-z0-9_.-]/g, "_")}`;
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    launcher = input.driver.prepare({
      id,
      kind: "chat",
      stateDir: path.join(input.stateRoot, id),
      codexBinary: git,
      codexRoot: path.dirname(git),
      // The folder is read, never written; only HOME is writable.
      mounts: [
        { host: workspace, writable: false },
        { host: home, writable: true },
      ],
      cwd: workspace,
      env: {
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      limits: input.limits ?? { memoryMb: 256, pids: 64, cpus: 1 },
    }).binary;
    return launcher;
  };
  const runner: GitRunner = async (cwd, args, okCodes = [0]) => {
    if (!inWorkspace(cwd))
      throw new Error("This folder is outside the session workspace.");
    const { stdout, code } = await run(
      prepare(),
      ["-C", cwd, ...safeGitConfig, ...args],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          CODEX_HOME: home,
          ...gitEnvironment,
        },
      },
    );
    if (!okCodes.includes(code))
      throw new Error(`git ${args[0] ?? ""} failed (${code}).`);
    return stdout;
  };
  /** A path git named, when it lies in the workspace. */
  const inside = (top: string, file: string) => {
    const full = path.resolve(top, file);
    return inWorkspace(full) ? full : undefined;
  };
  return {
    git: runner,
    async entries(top, files) {
      const found = new Map<string, TreeEntry>();
      for (const file of files) {
        const full = inside(top, file);
        const stat = full
          ? await fs.promises.lstat(full).catch(() => undefined)
          : undefined;
        if (stat?.isFile()) found.set(file, { kind: "file", size: stat.size });
        else if (stat?.isSymbolicLink())
          found.set(file, { kind: "symlink", size: stat.size });
      }
      return found;
    },
    async lineCounts(top, files, maxBytes) {
      const counts: Record<string, number> = {};
      for (const file of files) {
        const full = inside(top, file);
        const count = full ? await safeLineCount(full, maxBytes) : undefined;
        if (count !== undefined) counts[file] = count;
      }
      return counts;
    },
  };
}

/** The reader when nothing may read a folder: every query fails as "not a repository". */
export const noWorkingTree: WorkingTreeHost = {
  async git() {
    throw new Error("The working tree can't be read here.");
  },
  async entries() {
    return new Map();
  },
  async lineCounts() {
    return {};
  },
};
