import { z } from "zod";
import { parsePullRequestUrl } from "../../shared/pull-request";
import { repositoryFullName } from "../../shared/session-git";
import type { SessionPullRequest } from "../../shared/types";

const pullRequest = z.object({
  number: z.number().int().positive(),
  html_url: z.string(),
  title: z.string().min(1),
  state: z.literal("open"),
  draft: z.boolean(),
  head_ref: z.string(),
  head_repository: z.string(),
  base_ref: z.string(),
  created_at: z.string().optional(),
});
const lookupResponse = z.object({ pull_request: pullRequest.nullable() });

export type GitHubPullRequest = z.infer<typeof pullRequest>;

export interface GitHubPullRequestCoordinates {
  url: string;
  head: string;
  headRepository: string;
  base: string;
}

type GitHubRequest = (body: Record<string, unknown>) => Promise<unknown>;

function confirmPullRequest(
  pr: GitHubPullRequest,
  { url, head, headRepository, base }: GitHubPullRequestCoordinates,
) {
  const ref = parsePullRequestUrl(pr.html_url);
  if (
    !ref ||
    ref.host !== new URL(url).host ||
    ref.repository.toLowerCase() !== repositoryFullName(url)?.toLowerCase() ||
    ref.number !== pr.number ||
    pr.head_ref !== head ||
    pr.head_repository.toLowerCase() !== headRepository.toLowerCase() ||
    pr.base_ref !== base
  )
    throw Error("GitHub did not confirm the pull request coordinates.");
  return pr;
}

export async function findOpenGitHubPullRequest(
  github: GitHubRequest,
  coordinates: GitHubPullRequestCoordinates,
) {
  const { pull_request: pr } = lookupResponse.parse(
    await github({ ...coordinates, action: "pr.byHead" }),
  );
  return pr ? confirmPullRequest(pr, coordinates) : undefined;
}

export async function createGitHubPullRequest(
  github: GitHubRequest,
  coordinates: GitHubPullRequestCoordinates,
  details: { title: string; body: string; draft: boolean },
) {
  const pr = pullRequest.parse(
    await github({ ...coordinates, ...details, action: "pr.create" }),
  );
  return confirmPullRequest(pr, coordinates);
}

export function gitHubPullRequestMetadata(
  pr: GitHubPullRequest,
  repository: string,
  own: boolean,
): Omit<SessionPullRequest, "checkedAt"> {
  const createdAt = pr.created_at ? Date.parse(pr.created_at) : NaN;
  return {
    repository,
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    headRef: pr.head_ref,
    headRepository: pr.head_repository,
    baseRef: pr.base_ref,
    state: pr.draft ? "draft" : "open",
    ...(Number.isFinite(createdAt) && { createdAt }),
    ...(own && { own, openedBySession: true }),
  };
}
