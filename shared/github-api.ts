/**
 * The GitHub connection of Code on the web (package W-GITHUB): the state of
 * the signed-in user's connection, starting and ending it, and the
 * repositories and branches the repository picker lists.
 *
 * The service does the work (internal/claudex/ghconn): an administrator sets
 * up a GitHub OAuth App or GitHub App, a user connects their own account,
 * and a runner that prepares a Code session's workspace gets a short-lived
 * clone credential from the service (`github.clone` on the runner link). The
 * window never sees a token. The local desktop repository and branch
 * pickers use the machine's own GitHub CLI sign-in.
 */
import { bridgeMethods } from "./bridge-methods";

export interface GitHubStatus {
  /** An administrator set GitHub up on this service. */
  configured: boolean;
  connected: boolean;
  /** The connected account's login. */
  login?: string;
  avatarUrl?: string;
}

export interface GitHubRepository {
  /** "owner/name" */
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  /** The https address a session clones (no credentials in it). */
  cloneUrl: string;
}

export interface GitHubRepositoriesPage {
  items: GitHubRepository[];
  /** The page to ask for next, or null. A search never has one. */
  nextPage: number | null;
  /** A search looked at only the most recently pushed repositories. */
  truncated: boolean;
}

export interface GitHubBranch {
  name: string;
  protected: boolean;
}

export interface GitHubBranchesPage {
  defaultBranch: string;
  items: GitHubBranch[];
  nextPage: number | null;
  truncated: boolean;
}

/** One issue in the Import GitHub issue list. */
export interface GitHubIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  /** "owner/name" */
  repository: string;
  url: string;
  labels: string[];
}

/** An issue with what Claude reads when it is imported. */
export interface GitHubIssueDetail extends GitHubIssue {
  body: string;
  author: string;
  /** GitHub's `author_association` ("OWNER", "CONTRIBUTOR", "NONE"…). */
  authorAssociation: string;
}

/**
 * Why GitHub could not be asked, for a message the person can act on:
 * on the desktop the machine's GitHub CLI (`gh`) answers, on the web the
 * service's GitHub connection.
 */
export type GitHubProblem =
  | "cli-missing"
  | "cli-signed-out"
  | "not-connected"
  | "rate-limited"
  | "network"
  | "unavailable";

export interface GitHubIssuesResult {
  items: GitHubIssue[];
  problem?: GitHubProblem;
}

/**
 * A pull request's lifecycle: open, a draft, waiting in a merge queue, merged
 * or closed. What its glyph shows also weighs reviews and conflicts
 * (shared/pull-request-status.ts).
 */
export type PullRequestState =
  "open" | "draft" | "queued" | "merged" | "closed";

/** The state of a pull request's checks (its CI dot). */
export type PullRequestChecks =
  "passed" | "failed" | "pending" | "skipped" | "none";

/** How many of the head commit's checks are in each state. */
export interface PullRequestCheckCounts {
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
}

/** GitHub's review decision for the request. */
export type PullRequestReview =
  "approved" | "changesRequested" | "reviewRequired";

/** How a merge from Claudex lands (the repository's allowed method). */
export type PullRequestMergeMethod = "merge" | "squash" | "rebase";

export interface GitHubPullRequest {
  body?: string;
  number: number;
  url: string;
  /** "owner/name" */
  repository: string;
  title: string;
  state: PullRequestState;
  checks: PullRequestChecks;
  /** The head commit's checks counted by state; absent when unknown. */
  checkCounts?: PullRequestCheckCounts;
  /** The branch the request merges into, and the one it comes from. */
  baseRef: string;
  headRef: string;
  /** The head commit; a merge names it so a newer push is never merged unseen. */
  headSha?: string;
  review?: PullRequestReview;
  /** GitHub found conflicts with the base branch. */
  conflicting?: boolean;
  /**
   * GitHub's merge state, lower case: behind, blocked, clean, dirty, draft,
   * has_hooks, unknown or unstable.
   */
  mergeState?: string;
  /** Auto-merge is on: GitHub merges once checks and reviews pass. */
  autoMerge?: boolean;
  /** The base branch merges through a merge queue. */
  mergeQueue?: boolean;
  /** The repository allows auto-merge. */
  autoMergeAllowed?: boolean;
  /** The method a merge uses (the repository's default among the allowed). */
  mergeMethod?: PullRequestMergeMethod;
  /** The signed-in account may merge (write access to the repository). */
  canMerge?: boolean;
  additions?: number;
  deletions?: number;
  /** The first failing check's name. */
  failingCheck?: string;
  /** Review threads not resolved yet (the bar's comment count). */
  openReviewThreads?: number;
  /** …of which the last comment isn't the signed-in account's. */
  unansweredReviewThreads?: number;
  /** The newest comment of an open thread (a suggestion's stamp). */
  newestReviewComment?: number;
  /** The signed-in account opened the request. */
  viewerIsAuthor?: boolean;
}

export interface GitHubPullRequestResult {
  /** null when GitHub has no such request for this account. */
  pullRequest: GitHubPullRequest | null;
  problem?: GitHubProblem;
}

/**
 * What the branch row can change on a pull request: merge it, turn auto-merge
 * on or off, mark a draft ready for review, or convert it back to a draft.
 */
export type PullRequestAction =
  "merge" | "autoMergeOn" | "autoMergeOff" | "ready" | "draft";

export const pullRequestActions: readonly PullRequestAction[] = [
  "merge",
  "autoMergeOn",
  "autoMergeOff",
  "ready",
  "draft",
];

/** Why GitHub refused a change (shared/pull-request-status.ts words it). */
export type PullRequestActionReason =
  | "rate_limited"
  | "pr_closed"
  | "repo_disallows_auto_merge"
  | "already_mergeable"
  | "merge_method_not_allowed"
  | "no_branch_protection"
  | "stacked_pr"
  | "no_permission"
  | "workflow_scope"
  | "not_found"
  | "gh_unavailable"
  | "gh_auth"
  | "not_connected"
  | "already_in_state"
  | "head_moved"
  | "network"
  | "unknown";

export interface PullRequestActionResult {
  ok: boolean;
  /** The merge went into the merge queue instead of landing at once. */
  queued?: boolean;
  /** Why it failed. */
  reason?: PullRequestActionReason;
  /** GitHub's own words when the reason is unknown (cut short). */
  detail?: string;
}

/** A comment of a pull request review thread. */
export interface GitHubReviewComment {
  /** GitHub's node id. */
  id: string;
  databaseId?: number;
  author: string;
  avatarUrl?: string;
  body: string;
  url: string;
  /** The diff hunk the first comment was written on (it ends at the line). */
  diffHunk?: string;
}

/** A review thread on a pull request's line (Changes panel). */
export interface GitHubReviewThread {
  id: string;
  resolved: boolean;
  /** The lines moved on since (no current line). */
  outdated: boolean;
  path: string;
  /** The new file's line it ends at, and starts at for several lines. */
  line?: number;
  startLine?: number;
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  comments: GitHubReviewComment[];
}

export interface GitHubAPI {
  githubReview(
    input: import("./github-review").GitHubReviewRequest,
  ): Promise<import("./github-review").GitHubReviewResult>;
  githubStatus(): Promise<GitHubStatus>;
  /** The GitHub page to open to approve the app; it returns to /code. */
  githubConnect(): Promise<{ authorizeUrl: string }>;
  githubDisconnect(): Promise<GitHubStatus>;
  githubRepositories(input?: {
    query?: string;
    page?: number;
  }): Promise<GitHubRepositoriesPage>;
  githubBranches(input: {
    /** "owner/name" */
    repository: string;
    query?: string;
    page?: number;
  }): Promise<GitHubBranchesPage>;
  /**
   * Import GitHub issue: the repository's open issues. Without `query` the
   * ones the person is involved with; with it, any open issue matching the
   * text (or the number). On the desktop the machine's `gh` answers; on the
   * web the service does, with the connected account.
   */
  githubIssues(input: {
    /** "owner/name"; on the desktop it may be left out for `folder`. */
    repository?: string;
    /** Desktop: the task's folder, whose GitHub remote names the repository. */
    folder?: string;
    query?: string;
  }): Promise<GitHubIssuesResult>;
  /**
   * Desktop: whether the machine's GitHub CLI is installed and signed in
   * (`gh auth token`, whose output never leaves the main process). The +
   * menu's Import GitHub issue says why it's off when it isn't.
   */
  githubCliStatus(): Promise<{ installed: boolean; signedIn: boolean }>;
  /** One issue with its text; null when it can't be read. */
  githubIssue(input: {
    repository: string;
    number: number;
  }): Promise<GitHubIssueDetail | null>;
  /** A pull request's state and checks (the Code session's branch row). */
  githubPullRequest(input: {
    repository: string;
    number: number;
  }): Promise<GitHubPullRequestResult>;
  /**
   * Changes a pull request from the branch row: merge (with `headSha`, the
   * commit the person saw, so a newer push is never merged unseen),
   * auto-merge, ready for review or back to draft. The desktop
   * asks the machine's `gh`; the web asks the service.
   */
  /** A pull request's review threads (desktop, `gh`); null when they can't be read. */
  githubReviewThreads(input: {
    repository: string;
    number: number;
  }): Promise<GitHubReviewThread[] | null>;
  /** Reply on GitHub in a review thread; the new comment. */
  githubReplyReviewThread(input: {
    threadId: string;
    body: string;
  }): Promise<GitHubReviewComment>;
  /** Resolve a review thread. */
  githubResolveReviewThread(input: { threadId: string }): Promise<void>;
  githubPullRequestAction(input: {
    repository: string;
    number: number;
    action: PullRequestAction;
    headSha?: string;
    mergeMethod?: PullRequestMergeMethod;
  }): Promise<PullRequestActionResult>;
}

export const githubMethods = bridgeMethods<GitHubAPI>({
  githubReview: true,
  githubStatus: true,
  githubConnect: true,
  githubDisconnect: true,
  githubRepositories: true,
  githubBranches: true,
  githubIssues: true,
  githubCliStatus: true,
  githubIssue: true,
  githubPullRequest: true,
  githubPullRequestAction: true,
  githubReviewThreads: true,
  githubReplyReviewThread: true,
  githubResolveReviewThread: true,
});

/** The service's endpoints, under the site (GET/POST/DELETE, bearer token). */
export const githubRoutes = {
  readRepository: "/api/v1/claudex/web/github/repository/read",
  status: "/api/v1/claudex/web/github",
  connect: "/api/v1/claudex/web/github/connect",
  repositories: "/api/v1/claudex/web/github/repos",
  branches: "/api/v1/claudex/web/github/branches",
  issues: "/api/v1/claudex/web/github/issues",
  issue: "/api/v1/claudex/web/github/issue",
  pull: "/api/v1/claudex/web/github/pull",
  /** POST {repository}: a push credential for the desktop's Continue in cloud. */
  pushGrant: "/api/v1/claudex/web/github/push-grant",
  pullAction: "/api/v1/claudex/web/github/pull/action",
  /**
   * POST {pulls: [{repo, number}]} (at most 40): each request's state, review
   * and `awaits_review` (open, not a draft, not yet answered by a reviewer),
   * which the phones' Ready for review filter reads. Requests GitHub cannot
   * answer for are left out of `states`.
   */
  pullStates: "/api/v1/claudex/web/github/pull/states",
} as const;

/** The `?github=` result the callback adds to /code when the user comes back. */
export type GitHubReturn = "connected" | "denied" | "failed";

export function parseGitHubReturn(value: unknown): GitHubReturn | undefined {
  return value === "connected" || value === "denied" || value === "failed"
    ? value
    : undefined;
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

export function parseGitHubStatus(value: unknown): GitHubStatus {
  const json = record(value);
  const login = text(json.login);
  const avatarUrl = text(json.avatar_url);
  return {
    configured: json.configured === true,
    connected: json.configured === true && json.connected === true,
    ...(login ? { login } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

export function parseGitHubConnect(value: unknown): { authorizeUrl: string } {
  const url = text(record(value).authorize_url);
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    // handled below
  }
  // The service builds this address; anything but https is not GitHub's page.
  if (!parsed || parsed.protocol !== "https:")
    throw new Error("The service did not return a GitHub address.");
  return { authorizeUrl: parsed.href };
}

function repository(value: unknown): GitHubRepository | undefined {
  const json = record(value);
  const fullName = text(json.full_name);
  const cloneUrl = text(json.clone_url);
  if (!fullName.includes("/") || !cloneUrl) return undefined;
  const name = text(json.name) || fullName.split("/")[1];
  return {
    fullName,
    name,
    owner: text(json.owner) || fullName.split("/")[0],
    private: json.private === true,
    description: text(json.description),
    defaultBranch: text(json.default_branch),
    cloneUrl,
  };
}

const nextPage = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 1
    ? value
    : null;

export function parseGitHubRepositories(
  value: unknown,
): GitHubRepositoriesPage {
  const json = record(value);
  const items = Array.isArray(json.items) ? json.items : [];
  return {
    items: items.flatMap((item) => repository(item) ?? []),
    nextPage: nextPage(json.next_page),
    truncated: json.truncated === true,
  };
}

export function parseGitHubBranches(value: unknown): GitHubBranchesPage {
  const json = record(value);
  const items = Array.isArray(json.items) ? json.items : [];
  return {
    defaultBranch: text(json.default_branch),
    items: items.flatMap((item) => {
      const b = record(item);
      const name = text(b.name);
      return name ? [{ name, protected: b.protected === true }] : [];
    }),
    nextPage: nextPage(json.next_page),
    truncated: json.truncated === true,
  };
}

/** "owner/name" of a github.com repository address, or undefined. */
export function repositoryFullName(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(parsed.pathname);
    return match ? `${match[1]}/${match[2]}` : undefined;
  } catch {
    return undefined;
  }
}
