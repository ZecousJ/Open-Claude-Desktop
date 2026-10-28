import { runGh, type GhRunner } from "./github-cli";
import { githubReviewInput } from "../../shared/github-review-input";
import {
  getReviewThreads,
  replyToReviewThread,
  resolveReviewThread,
} from "./review-threads";
import type {
  GitHubReviewRequest,
  GitHubReviewResult,
} from "../../shared/github-review";

// PR reads and writes. Checks must belong to this PR before rerun.
export async function githubReview(
  raw: GitHubReviewRequest,
  run: GhRunner = runGh,
): Promise<GitHubReviewResult> {
  const input = githubReviewInput.parse(raw);
  const base = `repos/${input.repository}`;
  const pull = `${base}/pulls/${input.number}`;
  const request = async (
    endpoint: string,
    method = "GET",
    payload?: object,
    paginate = false,
  ): Promise<any> => {
    const result = await run([
      "api",
      endpoint,
      "--method",
      method,
      ...(paginate ? ["--paginate", "--slurp"] : []),
      ...(payload
        ? Object.entries(payload).flatMap(([key, value]) => [
            typeof value === "number" ? "-F" : "-f",
            `${key}=${value}`,
          ])
        : []),
    ]);
    if (result.code !== 0)
      throw new Error(result.stderr.trim() || "GitHub request failed.");
    const value = result.stdout.trim() ? JSON.parse(result.stdout) : {};
    return paginate ? value.flat() : value;
  };
  const checks = async () => {
    const overview = await request(pull);
    if (!/^[a-f0-9]{40,64}$/i.test(overview.head?.sha))
      throw new Error("Invalid pull request head.");
    const pages = await request(
      `${base}/commits/${overview.head.sha}/check-runs?per_page=100`,
      "GET",
      undefined,
      true,
    );
    return pages.flatMap((page: any) => page.check_runs ?? []);
  };
  switch (input.action) {
    case "threads":
      return {
        threads:
          (await getReviewThreads(input.repository, input.number, run)) ?? [],
      };
    case "resolve":
    case "threadReply": {
      const threads = await getReviewThreads(
        input.repository,
        input.number,
        run,
      );
      if (!threads?.some((thread) => thread.id === input.threadId))
        throw new Error("This thread can't be resolved.");
      if (input.action === "threadReply")
        return {
          comment: await replyToReviewThread(input.threadId, input.body!, run),
        };
      await resolveReviewThread(input.threadId, run);
      return {};
    }
    case "files":
      return {
        files: await request(
          `${pull}/files?per_page=100`,
          "GET",
          undefined,
          true,
        ),
      };
    case "timeline":
      return {
        timeline: await request(
          `${base}/issues/${input.number}/timeline?per_page=100`,
          "GET",
          undefined,
          true,
        ),
      };
    case "comments":
      return {
        comments: await request(
          `${pull}/comments?per_page=100`,
          "GET",
          undefined,
          true,
        ),
      };
    case "checks":
      return { checks: await checks() };
    case "annotations":
    case "rerun": {
      if (!(await checks()).some((check: any) => check.id === input.checkRunId))
        throw new Error("Check is not part of this PR.");
      if (input.action === "annotations")
        return {
          annotations: await request(
            `${base}/check-runs/${input.checkRunId}/annotations?per_page=100`,
            "GET",
            undefined,
            true,
          ),
        };
      await request(`${base}/check-runs/${input.checkRunId}/rerequest`, "POST");
      return {};
    }
    case "comment":
      await request(`${pull}/comments`, "POST", {
        commit_id: input.commitSha,
        path: input.path,
        line: input.line,
        side: input.side ?? "RIGHT",
        body: input.body,
        ...(input.startLine !== undefined
          ? { start_line: input.startLine, start_side: input.side ?? "RIGHT" }
          : {}),
      });
      return {};
    case "reply":
      await request(`${pull}/comments/${input.commentId}/replies`, "POST", {
        body: input.body,
      });
      return {};
    case "review":
      await request(`${pull}/reviews`, "POST", {
        event: input.event,
        ...(input.body ? { body: input.body } : {}),
      });
      return {};
  }
}
