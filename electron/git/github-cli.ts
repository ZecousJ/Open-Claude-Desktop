/**
 * GitHub for a Code session that works in a folder on this computer: the
 * Import GitHub issue list, an imported issue's text, a pull request's state
 * and checks, and the branch row's changes to it. The original asks GitHub
 * through the machine's own GitHub CLI sign-in; so does this, with `gh api`
 * (REST and GraphQL) and `gh pr` as the user, never a token of ours. Without
 * `gh`, or without a sign-in, the answer names the problem and the window says
 * what to do ("Set up the GitHub CLI…").
 *
 * Arguments go to `gh` as an array (no shell), and the repository is checked as
 * "owner/name" before it becomes part of a path.
 */
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { validRepositoryName } from "../../shared/github-parse";
import {
  type GitHubIssue,
  type GitHubIssueDetail,
  type GitHubIssuesResult,
  type GitHubProblem,
  type GitHubPullRequest,
  type GitHubPullRequestResult,
  type PullRequestAction,
  type PullRequestActionResult,
  type PullRequestMergeMethod,
  type PullRequestReview,
  type PullRequestState,
} from "../../shared/github-api";
import {
  actionDetail,
  actionReason,
  checksFromCounts,
  countChecks,
  type CheckEntry,
} from "../../shared/pull-request-status";

/** One `gh` run: the exit code and what it printed. */
export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
  /** `gh` is not installed (every candidate path was missing). */
  missing?: boolean;
}

export type GhRunner = (
  args: string[],
  outputLimit?: number,
) => Promise<GhResult>;

const timeoutMs = 20_000;
const maxBuffer = 8 * 1024 * 1024;

/** Where `gh` lives when the app was not started from a shell (a Dock launch). */
function candidates() {
  if (process.platform === "win32")
    return [
      "gh",
      "C:\\Program Files\\GitHub CLI\\gh.exe",
      path.join(
        os.homedir(),
        "AppData",
        "Local",
        "Programs",
        "GitHub CLI",
        "gh.exe",
      ),
    ];
  return [
    "gh",
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "/usr/bin/gh",
    "/snap/bin/gh",
    path.join(os.homedir(), ".local", "bin", "gh"),
  ];
}

let found: string | undefined;

function runOne(
  file: string,
  args: string[],
  outputLimit = maxBuffer,
): Promise<GhResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: outputLimit,
        windowsHide: true,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
          NO_COLOR: "1",
        },
      },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        if (code === "ENOENT")
          return resolve({ code: 127, stdout: "", stderr: "", missing: true });
        resolve({
          code: error ? (typeof code === "number" ? code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr || (error as Error | null)?.message || ""),
        });
      },
    );
  });
}

/** Runs `gh`, trying the places it is usually installed until one exists. */
export const runGh: GhRunner = async (args, outputLimit) => {
  if (found) return runOne(found, args, outputLimit);
  let last: GhResult = { code: 127, stdout: "", stderr: "", missing: true };
  for (const file of candidates()) {
    last = await runOne(file, args, outputLimit);
    if (!last.missing) {
      found = file;
      return last;
    }
  }
  return last;
};

/** What a failed `gh api` means: a request GitHub refused, or a setup problem. */
export function problemOf(result: GhResult): GitHubProblem | "not-found" {
  if (result.missing) return "cli-missing";
  const text = result.stderr;
  if (
    /gh auth login|not logged in|no oauth token|HTTP 401|Bad credentials/i.test(
      text,
    )
  )
    return "cli-signed-out";
  if (/HTTP 404|Not Found/i.test(text)) return "not-found";
  if (/rate limit/i.test(text)) return "rate-limited";
  if (
    /error connecting to|dial tcp|i\/o timeout|ETIMEDOUT|ENOTFOUND|could not resolve host/i.test(
      text,
    )
  )
    return "network";
  return "unavailable";
}

type Json = Record<string, any>;

type Reply =
  { ok: true; data: any } | { ok: false; problem: GitHubProblem | "not-found" };

/** `gh api` for a GET: the JSON it printed, or the problem. */
async function get(
  run: GhRunner,
  endpoint: string,
  fields: Record<string, string> = {},
): Promise<Reply> {
  const args = [
    "api",
    "--method",
    "GET",
    "-H",
    "Accept: application/vnd.github+json",
  ];
  for (const [key, value] of Object.entries(fields))
    args.push("-f", `${key}=${value}`);
  args.push(endpoint);
  const result = await run(args);
  if (result.code !== 0) return { ok: false, problem: problemOf(result) };
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, problem: "unavailable" };
  }
}

const labelNames = (labels: unknown): string[] =>
  Array.isArray(labels)
    ? labels.flatMap((label) =>
        typeof label === "string"
          ? [label]
          : typeof label?.name === "string"
            ? [label.name]
            : [],
      )
    : [];

function issueOf(repository: string, item: Json): GitHubIssue | undefined {
  if (
    typeof item?.number !== "number" ||
    typeof item.title !== "string" ||
    typeof item.html_url !== "string"
  )
    return undefined;
  return {
    number: item.number,
    title: item.title,
    state: String(item.state).toLowerCase() === "closed" ? "closed" : "open",
    repository,
    url: item.html_url,
    labels: labelNames(item.labels),
  };
}

/** The search text of the list: the person's own, else what involves them. */
export function issueSearch(repository: string, query: string | undefined) {
  const text = (query ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  return `repo:${repository} is:issue is:open ${text || "involves:@me"}`;
}

export async function listIssues(
  repository: string,
  query: string | undefined,
  run: GhRunner = runGh,
): Promise<GitHubIssuesResult> {
  if (!validRepositoryName(repository)) return { items: [] };
  const number = /^#?(\d{1,9})$/.exec((query ?? "").trim())?.[1];
  const [search, direct] = await Promise.all([
    get(run, "search/issues", {
      q: issueSearch(repository, query),
      per_page: "50",
    }),
    number
      ? get(run, `repos/${repository}/issues/${number}`)
      : Promise.resolve(undefined),
  ]);
  // A setup problem is the same for both calls; a missing issue is not one.
  if (!search.ok && search.problem !== "not-found")
    return { items: [], problem: search.problem };
  const items: GitHubIssue[] = [];
  // An issue named by its number comes first (the search finds text, not numbers).
  if (direct?.ok && !direct.data?.pull_request) {
    const issue = issueOf(repository, direct.data);
    if (issue && issue.state === "open") items.push(issue);
  }
  if (search.ok && Array.isArray(search.data?.items))
    for (const item of search.data.items) {
      if (item?.pull_request) continue;
      const issue = issueOf(repository, item);
      if (issue && !items.some((have) => have.number === issue.number))
        items.push(issue);
    }
  return { items };
}

export async function getIssue(
  repository: string,
  number: number,
  run: GhRunner = runGh,
): Promise<GitHubIssueDetail | null> {
  if (
    !validRepositoryName(repository) ||
    !Number.isInteger(number) ||
    number < 1
  )
    return null;
  const reply = await get(run, `repos/${repository}/issues/${number}`);
  if (!reply.ok || reply.data?.pull_request) return null;
  const issue = issueOf(repository, reply.data);
  if (!issue) return null;
  return {
    ...issue,
    body: typeof reply.data.body === "string" ? reply.data.body : "",
    author:
      typeof reply.data.user?.login === "string" ? reply.data.user.login : "",
    authorAssociation:
      typeof reply.data.author_association === "string"
        ? reply.data.author_association
        : "",
  };
}

/**
 * One GraphQL read gives what the branch row shows: the lifecycle, the review
 * decision, conflicts and GitHub's merge state, auto-merge and the merge queue,
 * the head commit's checks, and what a merge from here may do (the account's
 * access, the methods the repository allows).
 */
export const pullRequestQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission
    autoMergeAllowed
    mergeCommitAllowed
    squashMergeAllowed
    rebaseMergeAllowed
    viewerDefaultMergeMethod
    pullRequest(number: $number) {
      number url title body state isDraft merged viewerDidAuthor
      mergeable mergeStateStatus reviewDecision
      isInMergeQueue isMergeQueueEnabled
      additions deletions baseRefName headRefName headRefOid
      autoMergeRequest { enabledAt }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion }
        ... on StatusContext { context state }
      } } } } } }
      reviewThreads(first: 100) { nodes {
        isResolved
        comments(last: 1) { nodes { databaseId viewerDidAuthor } }
      } }
    }
  }
}`;

const writeAccess = new Set(["ADMIN", "MAINTAIN", "WRITE"]);

/** The method a merge uses: the account's default when allowed, else squash, merge, rebase. */
export function mergeMethodOf(repo: Json): PullRequestMergeMethod {
  const allowed: Record<PullRequestMergeMethod, boolean> = {
    squash: repo.squashMergeAllowed !== false,
    merge: repo.mergeCommitAllowed !== false,
    rebase: repo.rebaseMergeAllowed !== false,
  };
  const preferred = String(
    repo.viewerDefaultMergeMethod ?? "",
  ).toLowerCase() as PullRequestMergeMethod;
  if (allowed[preferred]) return preferred;
  return (
    (["squash", "merge", "rebase"] as const).find((m) => allowed[m]) ?? "squash"
  );
}

const reviewOf = (value: unknown): PullRequestReview | undefined =>
  value === "APPROVED"
    ? "approved"
    : value === "CHANGES_REQUESTED"
      ? "changesRequested"
      : value === "REVIEW_REQUIRED"
        ? "reviewRequired"
        : undefined;

const lineCount = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;

/** The branch row's pull request from the GraphQL answer's repository. */
export function pullRequestFromGraphQL(
  repository: string,
  repo: Json | null | undefined,
): GitHubPullRequest | null {
  const pull = repo?.pullRequest;
  if (!repo || typeof pull?.number !== "number" || typeof pull.url !== "string")
    return null;
  const merged = pull.merged === true || pull.state === "MERGED";
  const state: PullRequestState = merged
    ? "merged"
    : pull.state === "CLOSED"
      ? "closed"
      : pull.isInMergeQueue === true
        ? "queued"
        : pull.isDraft === true
          ? "draft"
          : "open";
  const mergeState =
    typeof pull.mergeStateStatus === "string"
      ? pull.mergeStateStatus.toLowerCase()
      : undefined;
  const contexts: unknown =
    pull.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes;
  // A request that is no longer open has no running checks to show.
  const live = state !== "merged" && state !== "closed";
  const counts =
    live && Array.isArray(contexts)
      ? countChecks(contexts as CheckEntry[])
      : undefined;
  const headSha =
    typeof pull.headRefOid === "string" &&
    /^[0-9a-f]{7,64}$/i.test(pull.headRefOid)
      ? pull.headRefOid
      : undefined;
  const review = reviewOf(pull.reviewDecision);
  // The first failing check's name (the Fix the failing checks suggestion).
  const failing =
    live && Array.isArray(contexts)
      ? (
          contexts as (CheckEntry & { name?: unknown; context?: unknown })[]
        ).find((entry) => countChecks([entry]).failed > 0)
      : undefined;
  const failingCheck =
    typeof failing?.name === "string"
      ? failing.name
      : typeof failing?.context === "string"
        ? failing.context
        : undefined;
  // Review threads still open; the ones whose last word isn't the viewer's
  // wait on them.
  const threads: unknown = pull.reviewThreads?.nodes;
  const open = Array.isArray(threads)
    ? (threads as Json[]).filter((thread) => thread?.isResolved === false)
    : undefined;
  const lastOf = (thread: Json) => thread?.comments?.nodes?.[0];
  const unanswered = open?.filter(
    (thread) => lastOf(thread)?.viewerDidAuthor !== true,
  );
  const newestComment = open
    ?.map((thread) => lastOf(thread)?.databaseId)
    .filter((id): id is number => typeof id === "number")
    .sort((a, b) => b - a)[0];
  const additions = lineCount(pull.additions);
  const deletions = lineCount(pull.deletions);
  return {
    number: pull.number,
    url: pull.url,
    repository,
    title: typeof pull.title === "string" ? pull.title : "",
    body: typeof pull.body === "string" ? pull.body : "",
    state,
    checks: counts ? checksFromCounts(counts) : "none",
    ...(counts ? { checkCounts: counts } : {}),
    baseRef: typeof pull.baseRefName === "string" ? pull.baseRefName : "",
    headRef: typeof pull.headRefName === "string" ? pull.headRefName : "",
    ...(headSha ? { headSha } : {}),
    ...(review ? { review } : {}),
    conflicting: pull.mergeable === "CONFLICTING" || mergeState === "dirty",
    ...(mergeState ? { mergeState } : {}),
    autoMerge: Boolean(pull.autoMergeRequest),
    mergeQueue: pull.isMergeQueueEnabled === true,
    autoMergeAllowed: repo.autoMergeAllowed === true,
    mergeMethod: mergeMethodOf(repo),
    canMerge: writeAccess.has(String(repo.viewerPermission)),
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
    ...(failingCheck ? { failingCheck } : {}),
    ...(open ? { openReviewThreads: open.length } : {}),
    ...(unanswered ? { unansweredReviewThreads: unanswered.length } : {}),
    ...(newestComment !== undefined
      ? { newestReviewComment: newestComment }
      : {}),
    ...(typeof pull.viewerDidAuthor === "boolean"
      ? { viewerIsAuthor: pull.viewerDidAuthor }
      : {}),
  };
}

export async function getPullRequest(
  repository: string,
  number: number,
  run: GhRunner = runGh,
): Promise<GitHubPullRequestResult> {
  if (
    !validRepositoryName(repository) ||
    !Number.isInteger(number) ||
    number < 1
  )
    return { pullRequest: null };
  const [owner, name] = repository.split("/");
  const result = await run([
    "api",
    "graphql",
    "-f",
    `query=${pullRequestQuery}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${number}`,
  ]);
  if (result.code !== 0) {
    const problem = problemOf(result);
    // GraphQL names a request it can't find ("Could not resolve to a PullRequest").
    return problem === "not-found" ||
      /Could not resolve to a/i.test(result.stderr)
      ? { pullRequest: null }
      : { pullRequest: null, problem };
  }
  try {
    const repo = JSON.parse(result.stdout)?.data?.repository;
    return { pullRequest: pullRequestFromGraphQL(repository, repo) };
  } catch {
    return { pullRequest: null, problem: "unavailable" };
  }
}

export interface PullRequestActionInput {
  repository: string;
  number: number;
  action: PullRequestAction;
  headSha?: string;
  mergeMethod?: PullRequestMergeMethod;
}

/**
 * The `gh` command for a change from the branch row. A merge names the head
 * commit the person saw (`--match-head-commit`), so GitHub refuses one that
 * moved since; auto-merge and merges use the repository's method.
 */
export function pullRequestActionArgs(input: PullRequestActionInput): string[] {
  const target = [String(input.number), "--repo", input.repository];
  const method = `--${input.mergeMethod ?? "squash"}`;
  switch (input.action) {
    case "merge":
      return [
        "pr",
        "merge",
        ...target,
        method,
        ...(input.headSha ? ["--match-head-commit", input.headSha] : []),
      ];
    case "autoMergeOn":
      return ["pr", "merge", ...target, "--auto", method];
    case "autoMergeOff":
      return ["pr", "merge", ...target, "--disable-auto"];
    case "ready":
      return ["pr", "ready", ...target];
    case "draft":
      return ["pr", "ready", ...target, "--undo"];
  }
}

export async function pullRequestAction(
  input: PullRequestActionInput,
  run: GhRunner = runGh,
): Promise<PullRequestActionResult> {
  if (
    !validRepositoryName(input.repository) ||
    !Number.isInteger(input.number) ||
    input.number < 1 ||
    (input.headSha !== undefined && !/^[0-9a-f]{7,64}$/i.test(input.headSha))
  )
    return { ok: false, reason: "not_found" };
  const result = await run(pullRequestActionArgs(input));
  if (result.code === 0)
    return {
      ok: true,
      // A required merge queue takes the request instead of merging it.
      ...(input.action === "merge" &&
      /merge queue/i.test(result.stdout + result.stderr)
        ? { queued: true }
        : {}),
    };
  if (result.missing) return { ok: false, reason: "gh_unavailable" };
  if (problemOf(result) === "cli-signed-out")
    return { ok: false, reason: "gh_auth" };
  const reason = actionReason(result.stderr);
  const detail = reason === "unknown" ? actionDetail(result.stderr) : undefined;
  return { ok: false, reason, ...(detail ? { detail } : {}) };
}

/**
 * The open pull request a folder's checked-out branch has (the Code home's
 * Next steps: failing checks, review comments to answer); null when none.
 */
export async function pullRequestForBranch(
  repository: string,
  branch: string,
  run: GhRunner = runGh,
): Promise<GitHubPullRequest | null> {
  if (
    !validRepositoryName(repository) ||
    !/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/.test(branch)
  )
    return null;
  const list = await run([
    "pr",
    "list",
    "--repo",
    repository,
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "number",
    "--limit",
    "1",
  ]);
  if (list.code !== 0) return null;
  let number: unknown;
  try {
    number = JSON.parse(list.stdout)?.[0]?.number;
  } catch {
    return null;
  }
  if (typeof number !== "number") return null;
  return (await getPullRequest(repository, number, run)).pullRequest;
}
