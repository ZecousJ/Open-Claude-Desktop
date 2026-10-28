/**
 * The GitHub connection calls (shared/github-api.ts) on the web: plain JSON
 * requests to the service's endpoints with the session's access token. The
 * service holds the GitHub token; the window only sees the connection's
 * state, repository names and branch names.
 */
import {
  githubRoutes,
  parseGitHubBranches,
  parseGitHubConnect,
  parseGitHubRepositories,
  parseGitHubStatus,
  type GitHubAPI,
} from "../github-api";
import type { WebTransport } from "./transport";

type Method = (...args: any[]) => Promise<unknown>;

const json = (body: unknown = {}): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function query(params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function createGitHubMethods(transport: Pick<WebTransport, "json">): {
  [
    K in Exclude<
      keyof GitHubAPI,
      | "githubCliStatus"
      | "githubReview"
      | "githubReviewThreads"
      | "githubReplyReviewThread"
      | "githubResolveReviewThread"
    >
  ]: Method;
} {
  // The issue and pull request reads load when a Code session first asks.
  const work = () =>
    import("./github-work").then((module) =>
      module.createGitHubWorkMethods(transport, githubRoutes),
    );
  return {
    githubIssues: async (input: Parameters<GitHubAPI["githubIssues"]>[0]) =>
      (await work()).githubIssues(input),
    githubIssue: async (input: Parameters<GitHubAPI["githubIssue"]>[0]) =>
      (await work()).githubIssue(input),
    githubPullRequest: async (
      input: Parameters<GitHubAPI["githubPullRequest"]>[0],
    ) => (await work()).githubPullRequest(input),
    githubPullRequestAction: async (
      input: Parameters<GitHubAPI["githubPullRequestAction"]>[0],
    ) => (await work()).githubPullRequestAction(input),
    githubStatus: async () =>
      parseGitHubStatus(await transport.json(githubRoutes.status).then(data)),
    githubConnect: async () =>
      parseGitHubConnect(
        await transport.json(githubRoutes.connect, json()).then(data),
      ),
    githubDisconnect: async () =>
      parseGitHubStatus(
        await transport
          .json(githubRoutes.status, { method: "DELETE" })
          .then(data),
      ),
    githubRepositories: async (input?: { query?: string; page?: number }) =>
      parseGitHubRepositories(
        await transport
          .json(
            githubRoutes.repositories +
              query({ query: input?.query?.trim(), page: input?.page }),
          )
          .then(data),
      ),
    githubBranches: async (input: {
      repository: string;
      query?: string;
      page?: number;
    }) =>
      parseGitHubBranches(
        await transport
          .json(
            githubRoutes.branches +
              query({
                repo: input.repository,
                query: input.query?.trim(),
                page: input.page,
              }),
          )
          .then(data),
      ),
  };
}

/** The value of the service's `{code, data}` answer. */
function data(body: unknown): unknown {
  const json = body as { data?: unknown } | undefined;
  return json && typeof json === "object" && "data" in json ? json.data : body;
}
