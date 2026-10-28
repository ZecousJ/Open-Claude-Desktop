/**
 * What a cloud Code session records about its repository (shared/types.ts:
 * Conversation.repository, .branch, .gitState, .pullRequests), so lists on
 * every client can show and search it without asking the sandbox: the branch
 * and the folder's git state after each turn, and the pull requests the
 * session opened with its GitHub tools, with the state GitHub last gave.
 *
 * Only the runner writes these (a window never does). The folder is read with
 * the same read-only sandboxed `git` the Changes panel uses
 * (runner/src/sandbox-git.ts); GitHub is asked through the service
 * (`github.api`), which holds the user's token.
 */
import fs from "node:fs";
import path from "node:path";
import { pickRemote } from "../../electron/git/code-git";
import {
  isTransportError,
  type WorkingTreeHost,
} from "../../electron/git/working-tree";
import {
  parsePullRequestUrl,
  taggedPullRequests,
} from "../../shared/pull-request";
import {
  pullRequestIsLive,
  repositoryFullName,
  sessionRepositoryOf,
} from "../../shared/session-git";
import type {
  Conversation,
  SessionGitState,
  SessionPullRequest,
  SessionPullRequestState,
  Turn,
} from "../../shared/types";
import type { StoreTransport } from "./cloud-store";

/** What `git` said about a session's folder. */
export interface GitFacts {
  /** Undefined for a detached HEAD. */
  branch?: string;
  head?: string;
  dirty: boolean;
  /** Commits on HEAD the branch's remote copy does not have. */
  unpushed: boolean;
}

/**
 * Reads the folder: branch, uncommitted changes and whether HEAD has commits
 * the remote lacks. `pushed` is the last commit the GitHub push tool sent.
 * Undefined when the folder is not a repository.
 */
export async function readGitFacts(
  cwd: string,
  host: WorkingTreeHost,
  pushed?: SessionGitState["pushed"],
): Promise<GitFacts | undefined> {
  // A query that fails reads as an empty answer, unless the host itself failed.
  const ask = (top: string, args: string[], okCodes: number[] = [0, 1]) =>
    host
      .git(top, args, okCodes)
      .then((out) => out.trim())
      .catch((error) => {
        if (isTransportError(error)) throw error;
        return "";
      });
  let top: string;
  try {
    top = (await host.git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    if (isTransportError(error)) throw error;
    return undefined;
  }
  if (!top) return undefined;
  const branch =
    (await ask(top, ["symbolic-ref", "--short", "-q", "HEAD"])) || undefined;
  const head =
    (await ask(top, ["rev-parse", "--verify", "-q", "HEAD"])) || undefined;
  const dirty = Boolean(
    await ask(top, ["status", "--porcelain", "--untracked-files=normal"], [0]),
  );
  if (!head) return { branch, dirty, unpushed: false };
  if (pushed && pushed.sha === head && pushed.branch === branch)
    return { branch, head, dirty, unpushed: false };
  const remote = pickRemote(
    await ask(top, ["config", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"]),
  );
  if (!remote) return { branch, head, dirty, unpushed: false };
  const count = async (range: string) =>
    Number(await ask(top, ["rev-list", "--count", range])) || 0;
  // The branch's remote copy, when there is one: commits it lacks.
  if (branch) {
    const tracking = `refs/remotes/${remote.name}/${branch}`;
    if (await ask(top, ["rev-parse", "--verify", "-q", tracking]))
      return {
        branch,
        head,
        dirty,
        unpushed: (await count(`${tracking}..HEAD`)) > 0,
      };
  }
  // A branch never pushed: it has work to push when it is ahead of the
  // remote's default branch.
  let base = "";
  const origin = await ask(top, [
    "symbolic-ref",
    "--short",
    "-q",
    `refs/remotes/${remote.name}/HEAD`,
  ]);
  if (origin.startsWith(`${remote.name}/`)) base = origin;
  if (!base)
    for (const guess of ["main", "master"])
      if (
        await ask(top, [
          "rev-parse",
          "--verify",
          "-q",
          `refs/remotes/${remote.name}/${guess}`,
        ])
      ) {
        base = `${remote.name}/${guess}`;
        break;
      }
  return {
    branch,
    head,
    dirty,
    unpushed: base ? (await count(`${base}..HEAD`)) > 0 : false,
  };
}

/** Writes what `git` said onto the conversation; true when anything changed. */
export function applyGitFacts(
  conversation: Conversation,
  facts: GitFacts,
  now = Date.now(),
) {
  const before = JSON.stringify([
    conversation.branch,
    conversation.gitState?.dirty,
    conversation.gitState?.unpushed,
    conversation.gitState?.pushed,
  ]);
  if (facts.branch) conversation.branch = facts.branch;
  else delete conversation.branch;
  const pushed = conversation.gitState?.pushed;
  conversation.gitState = {
    dirty: facts.dirty,
    unpushed: facts.unpushed,
    ...(pushed ? { pushed } : {}),
    checkedAt: now,
  };
  return (
    before !==
    JSON.stringify([
      conversation.branch,
      conversation.gitState.dirty,
      conversation.gitState.unpushed,
      conversation.gitState.pushed,
    ])
  );
}

/** A commit hash. */
const sha = /^[0-9a-f]{40}$/;

/**
 * The commit a local branch points at, read from the folder's own files
 * (loose ref, else packed-refs); the repository is the one `ownRepository`
 * already vetted.
 */
export function branchCommit(gitDir: string, branch: string) {
  try {
    const loose = fs
      .readFileSync(path.join(gitDir, "refs", "heads", branch), "utf8")
      .trim();
    if (sha.test(loose)) return loose;
  } catch {
    // packed below
  }
  try {
    for (const line of fs
      .readFileSync(path.join(gitDir, "packed-refs"), "utf8")
      .split(/\r?\n/)) {
      const [id, ref] = line.split(" ");
      if (ref === `refs/heads/${branch}` && id && sha.test(id)) return id;
    }
  } catch {
    // not packed
  }
  return undefined;
}

/** Notes a successful push: the branch's commit is on GitHub. */
export function recordPush(
  conversation: Conversation,
  branch: string,
  commit: string | undefined,
  now = Date.now(),
) {
  if (!commit) return;
  const state: SessionGitState = conversation.gitState ?? {
    dirty: false,
    unpushed: false,
    checkedAt: now,
  };
  conversation.gitState = {
    ...state,
    pushed: { branch, sha: commit },
    unpushed: conversation.branch === branch ? false : state.unpushed,
    checkedAt: now,
  };
}

/** The state of a pull request as the service summarises GitHub's answer. */
export function pullRequestState(api: unknown): SessionPullRequestState {
  const v = (api && typeof api === "object" ? api : {}) as Record<
    string,
    unknown
  >;
  if (v.merged === true) return "merged";
  if (v.state === "closed") return "closed";
  if (v.draft === true) return "draft";
  return "open";
}

/** Adds (or updates) a pull request the session opened. */
export function recordPullRequest(
  conversation: Conversation,
  pr: Omit<SessionPullRequest, "checkedAt">,
  now = Date.now(),
) {
  const list = conversation.pullRequests ?? [];
  const key = (p: { repository: string; number: number }) =>
    `${p.repository.toLowerCase()}#${p.number}`;
  const at = list.findIndex((p) => key(p) === key(pr));
  const next: SessionPullRequest = { ...pr, checkedAt: now };
  if (at >= 0) list[at] = { ...list[at], ...next };
  else list.push(next);
  // Keep the newest few; a session that opens dozens needs no more.
  conversation.pullRequests = list.slice(-20);
}

/** The pull request GitHub's answer to `pr.create` / `pr.get` describes. */
export function pullRequestFromApi(
  api: unknown,
  fallback: { repository?: string; headRef?: string } = {},
): Omit<SessionPullRequest, "checkedAt"> | undefined {
  if (!api || typeof api !== "object") return undefined;
  const v = api as Record<string, unknown>;
  const url = typeof v.html_url === "string" ? v.html_url : "";
  const ref = parsePullRequestUrl(url);
  const number = typeof v.number === "number" ? v.number : ref?.number;
  const repository = ref?.repository ?? fallback.repository;
  if (!number || !repository || !url) return undefined;
  return {
    repository,
    number,
    url,
    ...(typeof v.title === "string" && v.title ? { title: v.title } : {}),
    ...(typeof v.head_ref === "string" && v.head_ref
      ? { headRef: v.head_ref }
      : fallback.headRef
        ? { headRef: fallback.headRef }
        : {}),
    state: pullRequestState(v),
  };
}

/** The GitHub repository address a pull request address belongs to. */
const repositoryUrlOf = (prUrl: string) => prUrl.replace(/\/pull\/\d+.*$/, "");

/** Reads the state of every pull request that can still change. */
export async function refreshPullRequests(
  conversation: Conversation,
  transport: Pick<StoreTransport, "request">,
  userId: number,
  now = Date.now(),
) {
  let changed = false;
  for (const pr of (conversation.pullRequests ?? []).filter(
    pullRequestIsLive,
  )) {
    let answer: unknown;
    try {
      answer = await transport.request("github.api", userId, {
        url: repositoryUrlOf(pr.url),
        action: "pr.get",
        number: pr.number,
      });
    } catch {
      // GitHub or the service is unavailable: the last state stands.
      continue;
    }
    const next = pullRequestFromApi(answer, pr);
    if (!next) continue;
    if (next.state !== pr.state || (next.title ?? "") !== (pr.title ?? ""))
      changed = true;
    const { checkedAt: _old, ...rest } = pr;
    recordPullRequest(conversation, { ...rest, ...next }, now);
  }
  return changed;
}

/**
 * Pull requests the model reported in a `<pr-created>` tag of this turn that
 * the session's own repository holds and that are not recorded yet (the
 * request already existed, so `create_pull_request` refused and the model
 * named it). Returns whether any was added.
 */
export async function adoptTaggedPullRequests(
  conversation: Conversation,
  turn: Turn,
  transport: Pick<StoreTransport, "request">,
  userId: number,
  now = Date.now(),
) {
  const own = new Set(
    [
      conversation.repository?.fullName,
      ...(conversation.sessionRepositories ?? []).map((r) =>
        repositoryFullName(r.url),
      ),
    ]
      .filter((name): name is string => Boolean(name))
      .map((name) => name.toLowerCase()),
  );
  let added = false;
  for (const item of turn.items) {
    if (item.type !== "agentMessage" || typeof item.text !== "string") continue;
    for (const ref of taggedPullRequests(item.text)) {
      if (ref.host !== "github.com" || !own.has(ref.repository.toLowerCase()))
        continue;
      const known = conversation.pullRequests?.some(
        (pr) =>
          pr.number === ref.number &&
          pr.repository.toLowerCase() === ref.repository.toLowerCase(),
      );
      if (known) continue;
      let answer: unknown;
      try {
        answer = await transport.request("github.api", userId, {
          url: repositoryUrlOf(ref.url),
          action: "pr.get",
          number: ref.number,
        });
      } catch {
        continue;
      }
      const pr = pullRequestFromApi(answer, { repository: ref.repository });
      if (!pr) continue;
      recordPullRequest(conversation, pr, now);
      added = true;
    }
  }
  return added;
}

/** The repository a session's folder was made for, when the conversation lacks it. */
export function repositoryFromOrigin(origin: string | undefined) {
  return origin ? sessionRepositoryOf({ url: origin }) : undefined;
}
