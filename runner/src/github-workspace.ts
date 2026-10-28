/**
 * Clones a Code session's repository with a credential the service leases
 * for that one clone (W-GITHUB, backend/backend/internal/claudex/ghconn).
 *
 * `withGitHubClone` wraps the runner's `prepareWorkspace` hook
 * (runner/src/code-workspace.ts): the wrapped hook makes the session's empty
 * folder, then this asks the service for `github.clone` on the runner link,
 * runs `git clone` on the runner (outside the sandbox) and drops the
 * credential.
 *
 * The credential never touches the session's folder or the sandbox:
 * - it reaches git only through the environment of the one child process, by
 *   a throw-away GIT_ASKPASS script in a private temp folder (never in argv,
 *   never in the remote URL, so `.git/config` holds a plain https address);
 * - the temp folder is removed when the clone ends, whatever the outcome;
 * - the clone is cut off when the lease expires;
 * - git's own messages are scrubbed of it before they are shown, and nothing
 *   here logs it.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RepositoryRef } from "../../shared/host";
import { createHash } from "node:crypto";
import {
  askpass,
  parseCloneGrant,
  scrub,
  type CloneGrant,
} from "../../shared/git-lease";
import type { StoreTransport } from "./cloud-store";
import { SetupError, type SetupFailure } from "../../shared/session-setup";
import {
  excludeExtraRepositories,
  extraRepositoryFolders,
} from "./code-workspace";

/**
 * The space a repository's sessions share: "r-" and the start of the
 * address's hash (lower case, without a trailing slash or ".git").
 */
export function repositorySpaceId(url: string) {
  return `r-${createHash("sha256")
    .update(
      url
        .toLowerCase()
        .replace(/\/+$/, "")
        .replace(/\.git$/, ""),
    )
    .digest("hex")
    .slice(0, 24)}`;
}

// The lease and its helpers are shared with the desktop's push
// (shared/git-lease.ts); the runner's callers keep importing them here.
export { askpass, parseCloneGrant, scrub, type CloneGrant };

export interface GitRun {
  argv: string[];
  env: Record<string, string>;
  signal: AbortSignal;
}
export type RunGit = (run: GitRun) => Promise<{ code: number; stderr: string }>;

export const runGit: RunGit = ({ argv, env, signal }) =>
  new Promise((resolve) => {
    execFile(
      "git",
      argv,
      { env, signal, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, _stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : 1;
        resolve({
          code,
          stderr:
            String(stderr) ||
            (signal.aborted
              ? "The clone took too long."
              : error?.message || ""),
        });
      },
    );
  });

/** The longest a clone may take, whatever the lease says. */
const maxCloneMs = 10 * 60_000;

/**
 * git's words for a repository host it could not reach (DNS, connection,
 * TLS, a 5xx answer, a cut transfer, the time limit): the transcript says
 * "Unable to connect to repository" for these, "Session couldn't start" for
 * the rest (a missing repository or branch, no access).
 */
const unreachable =
  /could not resolve host|failed to connect|connection (?:timed out|reset|refused)|operation timed out|timed out|returned error: 5\d\d|early eof|rpc failed|ssl|tls|gnutls|network is unreachable|took too long/i;

export function cloneFailure(stderr: string): SetupFailure {
  return unreachable.test(stderr) ? "upstream" : "failed";
}

export interface GitHubCloneOptions<S extends { userId: number }> {
  /** The runner link's requests (`github.clone`). */
  transport: StoreTransport;
  /** Makes the session's folder (the runner's default hook). */
  base: (session: S, repository?: RepositoryRef) => Promise<{ cwd: string }>;
  runGit?: RunGit;
  tempRoot?: string;
  now?: () => number;
}

/** Empties a session folder that holds no work yet (a failed or cut clone). */
function emptyFolder(cwd: string) {
  for (const entry of fs.existsSync(cwd) ? fs.readdirSync(cwd) : [])
    fs.rmSync(path.join(cwd, entry), { recursive: true, force: true });
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
}

/**
 * A ref `git clone --branch` can't take: one outside refs/heads and
 * refs/tags (Continue in cloud uploads a session's work to its own), or a
 * commit's full name.
 */
export function pinnedRef(ref: string) {
  return (
    /^[0-9a-f]{40}$/.test(ref) ||
    (ref.startsWith("refs/") &&
      !ref.startsWith("refs/heads/") &&
      !ref.startsWith("refs/tags/"))
  );
}

/**
 * Clones a session's repositories into its folder, which it empties first
 * (only a session whose start never finished is fetched again): the main
 * one into the folder, the others added to the session into folders inside
 * it (runner/src/code-workspace.ts `extraRepositoryFolders`), one leased
 * credential each. A failure leaves the folder empty and throws a
 * SetupError naming the kind of failure.
 */
export function gitHubFetcher(
  options: Pick<
    GitHubCloneOptions<{ userId: number }>,
    "transport" | "runGit" | "tempRoot" | "now"
  >,
) {
  const run = options.runGit ?? runGit;
  const now = options.now ?? Date.now;
  return async (
    userId: number,
    repositories: readonly RepositoryRef[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    emptyFolder(cwd);
    try {
      const [main, ...more] = repositories;
      if (!main) return;
      await clone(userId, main, cwd, signal);
      const folders = extraRepositoryFolders(cwd, more);
      for (const [index, other] of more.entries())
        await clone(userId, other, folders[index]!, signal);
      excludeExtraRepositories(cwd, folders);
    } catch (error) {
      emptyFolder(cwd);
      if (error instanceof SetupError || !(error instanceof Error)) throw error;
      // The service's refusal keeps its own error (and CLAUDEX_ code).
      throw Object.assign(error, { failure: cloneFailure(error.message) });
    }
  };
  async function clone(
    userId: number,
    repository: RepositoryRef,
    cwd: string,
    signal?: AbortSignal,
  ) {
    const grant = parseCloneGrant(
      await options.transport.request("github.clone", userId, {
        url: repository.url,
        ...(repository.ref ? { ref: repository.ref } : {}),
      }),
    );
    const budget = Math.min(maxCloneMs, grant.expiresAt - now());
    if (budget <= 0) throw new Error("The clone credential expired.");
    signal?.throwIfAborted();
    const temp = fs.mkdtempSync(
      path.join(options.tempRoot ?? os.tmpdir(), "claudex-clone-"),
    );
    fs.chmodSync(temp, 0o700);
    try {
      const helper = path.join(temp, "askpass.sh");
      fs.writeFileSync(helper, askpass, { mode: 0o700 });
      const ref = grant.ref ?? repository.ref;
      // A ref git's clone can't check out (Continue in cloud's upload, a
      // commit) is fetched after it.
      const pinned = Boolean(ref && pinnedRef(ref));
      const timeout = AbortSignal.timeout(budget);
      const base = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: temp,
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      };
      const env = {
        ...base,
        GIT_ASKPASS: helper,
        CLAUDEX_GIT_USERNAME: grant.username,
        CLAUDEX_GIT_TOKEN: grant.token,
      };
      // Stop in the transcript ends the clone too.
      const stop = signal ? AbortSignal.any([timeout, signal]) : timeout;
      const step = async (argv: string[], stepEnv: Record<string, string>) => {
        const result = await run({ argv, env: stepEnv, signal: stop });
        if (result.code === 0) return;
        const said = scrub(result.stderr, [grant.token]) || "git failed";
        throw new SetupError(
          `Couldn't clone ${grant.repository}: ${said}`,
          timeout.aborted ? "upstream" : cloneFailure(said),
        );
      };
      await step(
        [
          "-c",
          "credential.helper=",
          "clone",
          "--quiet",
          ...(ref && !pinned ? ["--branch", ref] : []),
          ...(pinned ? ["--no-checkout"] : []),
          "--",
          grant.url,
          cwd,
        ],
        env,
      );
      if (ref && pinned) {
        await step(
          [
            "-C",
            cwd,
            "-c",
            "credential.helper=",
            "fetch",
            "--quiet",
            "--no-tags",
            "origin",
            ref,
          ],
          env,
        );
        await step(
          [
            "-C",
            cwd,
            "checkout",
            "--quiet",
            ...(repository.branch ? ["-B", repository.branch] : ["--detach"]),
            "FETCH_HEAD",
          ],
          base,
        );
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

/**
 * A new session's folder, made at once, and the clone that fills it, run
 * later (the engine runs it in the session's first turn, so the session
 * opens before the repository is there). Without a repository there is
 * nothing to fetch.
 */
export function stagedGitHubClone<S extends { userId: number }>(
  options: GitHubCloneOptions<S>,
) {
  const fetchInto = gitHubFetcher(options);
  return async (
    session: S,
    repository?: RepositoryRef,
    more: RepositoryRef[] = [],
  ): Promise<{
    cwd: string;
    fetch?: (signal?: AbortSignal) => Promise<void>;
  }> => {
    const folder = await options.base(session, repository);
    if (!repository) return folder;
    return {
      cwd: folder.cwd,
      fetch: (signal) =>
        fetchInto(session.userId, [repository, ...more], folder.cwd, signal),
    };
  };
}

/**
 * The `prepareWorkspace` hook that clones the session's repositories (the
 * main one, then those added to the session) before it returns. Without a
 * repository it is `base` alone.
 */
export function withGitHubClone<S extends { userId: number }>(
  options: GitHubCloneOptions<S>,
) {
  const staged = stagedGitHubClone(options);
  return async (
    session: S,
    repository?: RepositoryRef,
    more: RepositoryRef[] = [],
  ): Promise<{ cwd: string }> => {
    const { cwd, fetch } = await staged(session, repository, more);
    if (!fetch) return { cwd };
    try {
      await fetch();
      return { cwd };
    } catch (error) {
      // The session never starts: its new folder goes with it (the
      // dispatcher only learns a folder once it is prepared).
      fs.rmSync(cwd, { recursive: true, force: true });
      throw error;
    }
  };
}
