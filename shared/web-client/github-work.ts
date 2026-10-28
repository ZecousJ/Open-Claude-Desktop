/**
 * The issue and pull request calls of shared/github-api.ts on the web: the
 * service's read endpoints (internal/claudex/ghconn/work.go) with the
 * session's token. They load when a Code session first asks (the Import
 * GitHub issue list, the branch row), apart from the connection calls.
 */
import type {
  GitHubAPI,
  GitHubProblem,
  githubRoutes as Routes,
} from "../github-api";
import {
  parseGitHubIssue,
  parseGitHubIssues,
  parseGitHubPullRequest,
  parsePullRequestAction,
  validRepositoryName,
} from "../github-parse";
import type { WebTransport } from "./transport";

export function createGitHubWorkMethods(
  transport: Pick<WebTransport, "json">,
  // Passed in, so this module takes nothing at run time from the call list.
  githubRoutes: typeof Routes,
): Pick<
  GitHubAPI,
  | "githubIssues"
  | "githubIssue"
  | "githubPullRequest"
  | "githubPullRequestAction"
> {
  const get = (route: string, params: Record<string, string | number>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      if (value !== "") search.set(key, String(value));
    return transport.json(`${route}?${search}`).then(data);
  };
  return {
    githubIssues: async (input) => {
      const repository = input.repository ?? "";
      if (!validRepositoryName(repository)) return { items: [] };
      try {
        const body = await get(githubRoutes.issues, {
          repo: repository,
          query: input.query?.trim() ?? "",
        });
        return { items: parseGitHubIssues(body, repository) };
      } catch (error) {
        return { items: [], problem: problemOf(error) };
      }
    },
    githubIssue: async (input) => {
      if (!validRepositoryName(input.repository)) return null;
      try {
        const body = await get(githubRoutes.issue, {
          repo: input.repository,
          number: input.number,
        });
        return parseGitHubIssue(body, input.repository);
      } catch {
        return null;
      }
    },
    githubPullRequest: async (input) => {
      if (!validRepositoryName(input.repository)) return { pullRequest: null };
      try {
        const body = await get(githubRoutes.pull, {
          repo: input.repository,
          number: input.number,
        });
        return {
          pullRequest: parseGitHubPullRequest(body, input.repository),
        };
      } catch (error) {
        const problem = problemOf(error);
        // The service says 404 for a request this account can't see.
        return problem === "unavailable" &&
          (error as { status?: number }).status === 404
          ? { pullRequest: null }
          : { pullRequest: null, problem };
      }
    },
    githubPullRequestAction: async (input) => {
      if (!validRepositoryName(input.repository))
        return { ok: false, reason: "not_found" };
      try {
        const body = await transport
          .json(githubRoutes.pullAction, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              repo: input.repository,
              number: input.number,
              action: input.action,
              ...(input.headSha ? { head_sha: input.headSha } : {}),
              ...(input.mergeMethod ? { merge_method: input.mergeMethod } : {}),
            }),
          })
          .then(data);
        return parsePullRequestAction(body);
      } catch (error) {
        const problem = problemOf(error);
        const status = (error as { status?: number }).status;
        return {
          ok: false,
          reason:
            problem === "not-connected"
              ? "not_connected"
              : status === 404
                ? "not_found"
                : status === 429
                  ? "rate_limited"
                  : "unknown",
        };
      }
    },
  };
}

/** What a failed GitHub call means to the person (the connection's reasons). */
function problemOf(error: unknown): GitHubProblem {
  const code = (error as { code?: unknown } | undefined)?.code;
  const status = (error as { status?: unknown } | undefined)?.status;
  return code === "CLAUDEX_GITHUB_NOT_CONNECTED" ||
    code === "CLAUDEX_GITHUB_NOT_CONFIGURED"
    ? "not-connected"
    : status === 429
      ? "rate-limited"
      : "unavailable";
}

/** The value of the service's `{code, data}` answer. */
function data(body: unknown): unknown {
  const json = body as { data?: unknown } | undefined;
  return json && typeof json === "object" && "data" in json ? json.data : body;
}
