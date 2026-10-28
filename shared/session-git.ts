/**
 * What a cloud Code session knows about its repository, branch and pull
 * requests (Conversation.repository, .branch, .gitState, .pullRequests). The
 * runner writes them (runner/src/session-git.ts); the lists read them: the
 * phones' Code list matches a search against the title, repository and
 * branch (official `session_list_search_a11y`), and its "Ready for review"
 * filter is `isReviewReady`.
 *
 * The official app asks its service for a session's status bucket
 * (review_ready among them) and keeps no rule on the phone. Claudex keeps the
 * facts on the session and decides here, the same way on every client:
 * a finished session whose work is not on GitHub yet, or whose pull request
 * is still open, is waiting for a review.
 */
import type {
  Conversation,
  SessionPullRequest,
  SessionPullRequestState,
  SessionRepository,
} from "./types";
import type { RepositoryRef } from "./host";

/** "owner/name" of a repository address (https only; the last two parts). */
export function repositoryFullName(url: string): string | undefined {
  let pathname: string;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return undefined;
    pathname = parsed.pathname;
  } catch {
    return undefined;
  }
  const parts = pathname
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2) return undefined;
  const owner = parts.at(-2)!;
  const name = parts.at(-1)!;
  return `${owner}/${name}`;
}

/** The session's main repository as the lists show it. */
export function sessionRepositoryOf(
  ref: Pick<RepositoryRef, "url">,
): SessionRepository | undefined {
  const fullName = repositoryFullName(ref.url);
  return fullName ? { fullName, url: ref.url.trim() } : undefined;
}

/** Pull request states that are still waiting for GitHub (not merged or closed). */
export const livePullRequestStates: readonly SessionPullRequestState[] = [
  "open",
  "draft",
  "queued",
];

export const pullRequestIsLive = (pr: Pick<SessionPullRequest, "state">) =>
  livePullRequestStates.includes(pr.state);

/** The newest pull request the session opened. */
export function latestPullRequest(
  conversation: Pick<Conversation, "pullRequests">,
): SessionPullRequest | undefined {
  return conversation.pullRequests?.at(-1);
}

/**
 * A Code session is ready for review when it is not archived, is not running
 * and its last turn completed, and either it left work that is not merged
 * (uncommitted changes, commits GitHub does not have) or the last pull
 * request it opened is still open. A session whose pull request was merged or
 * closed and whose folder is clean has nothing left to review.
 */
export function isReviewReady(
  conversation: Pick<
    Conversation,
    "archived" | "turns" | "gitState" | "pullRequests"
  >,
): boolean {
  if (conversation.archived) return false;
  const last = conversation.turns.at(-1);
  if (last?.status !== "completed") return false;
  const pr = latestPullRequest(conversation);
  if (pr && pullRequestIsLive(pr)) return true;
  const state = conversation.gitState;
  return Boolean(state && (state.dirty || state.unpushed));
}

/** The text a list search looks at: title, repository and branch. */
export function sessionSearchText(
  conversation: Pick<Conversation, "title" | "repository" | "branch">,
): string[] {
  return [
    conversation.title,
    conversation.repository?.fullName ?? "",
    conversation.branch ?? "",
  ];
}

/** Whether a Code list search (case-insensitive substring) matches a session. */
export function sessionMatchesSearch(
  conversation: Pick<Conversation, "title" | "repository" | "branch">,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return sessionSearchText(conversation).some((text) =>
    text.toLowerCase().includes(needle),
  );
}

/** A branch name that is safe to put on the clipboard as given (non-empty). */
export const sessionBranchName = (
  conversation: Pick<Conversation, "branch">,
): string | undefined => conversation.branch?.trim() || undefined;
