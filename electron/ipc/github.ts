import { z } from "zod";
import { githubReview } from "../git/github-review";
import { githubReviewInput } from "../../shared/github-review-input";
import {
  githubMethods,
  pullRequestActions,
  type PullRequestAction,
} from "../../shared/github-api";
import { validRepositoryName } from "../../shared/github-parse";
import {
  listChatRepositories,
  listChatBranches,
} from "../git/github-repositories";
import type { AppContext, IpcHandle } from "../app/app-context";
import { workspaceRepository } from "../git/git-branch";
import {
  getReviewThreads,
  replyToReviewThread,
  resolveReviewThread,
} from "../git/review-threads";
import {
  getIssue,
  getPullRequest,
  listIssues,
  pullRequestAction,
  runGh,
} from "../git/github-cli";

const repository = z.string().max(140).refine(validRepositoryName);

/**
 * The hosted GitHub connection (shared/github-api.ts) belongs to the service.
 * Local Chat lists repositories and branches through the machine's GitHub CLI
 * sign-in.
 *
 * The issue and pull request calls are the exception: here they go through the
 * machine's GitHub CLI (electron/github-cli.ts), as the original app's do, the
 * branch row's changes to a pull request included. (On the web the page asks
 * the service instead.)
 */
export function registerGitHubHandlers(handle: IpcHandle, ctx: AppContext) {
  handle("githubReview", (raw: unknown) => {
    const input = githubReviewInput.parse(raw);
    return ctx.services.githubReview?.(input) ?? githubReview(input);
  });
  const refuse = () => {
    throw Error("GitHub repositories work in Claudex on the web.");
  };
  handle("githubStatus", async () => {
    const auth = await runGh(["auth", "status"]);
    return { configured: !auth.missing, connected: auth.code === 0 };
  });
  handle("githubConnect", refuse);
  handle("githubDisconnect", refuse);
  handle("githubRepositories", (raw: unknown) =>
    listChatRepositories(
      z
        .object({
          query: z.string().max(300).optional(),
          page: z.number().int().min(1).max(1000).optional(),
        })
        .optional()
        .parse(raw),
    ),
  );
  handle("githubBranches", (raw: unknown) =>
    listChatBranches(
      z
        .object({
          repository,
          query: z.string().max(300).optional(),
          page: z.number().int().min(1).max(1000).optional(),
        })
        .parse(raw),
    ),
  );
  handle("githubIssues", (raw: unknown) => {
    const input = z
      .object({
        repository: repository.optional(),
        folder: z.string().min(1).max(4096).optional(),
        query: z.string().max(300).optional(),
      })
      .strict()
      .parse(raw);
    let name = input.repository;
    if (!name && input.folder) {
      // Only a folder the person chose (or one already in use) is read.
      ctx.allowedFolder(input.folder);
      name = workspaceRepository(input.folder);
    }
    return name ? listIssues(name, input.query) : { items: [] };
  });
  handle("githubCliStatus", async () => {
    // The token is printed to stdout; only the exit status is kept.
    const result = await runGh(["auth", "token"]);
    return { installed: !result.missing, signedIn: result.code === 0 };
  });
  handle("githubReviewThreads", (raw: unknown) => {
    const input = z
      .object({ repository, number: z.number().int().min(1) })
      .strict()
      .parse(raw);
    return getReviewThreads(input.repository, input.number);
  });
  handle("githubReplyReviewThread", (raw: unknown) => {
    const input = z
      .object({
        threadId: z.string().min(1).max(200),
        body: z.string().trim().min(1).max(65536),
      })
      .strict()
      .parse(raw);
    return replyToReviewThread(input.threadId, input.body);
  });
  handle("githubResolveReviewThread", (raw: unknown) => {
    const input = z
      .object({ threadId: z.string().min(1).max(200) })
      .strict()
      .parse(raw);
    return resolveReviewThread(input.threadId);
  });
  handle("githubIssue", (raw: unknown) => {
    const input = z
      .object({ repository, number: z.number().int().min(1) })
      .strict()
      .parse(raw);
    return getIssue(input.repository, input.number);
  });
  handle("githubPullRequest", (raw: unknown) => {
    const input = z
      .object({ repository, number: z.number().int().min(1) })
      .strict()
      .parse(raw);
    return getPullRequest(input.repository, input.number);
  });
  handle("githubPullRequestAction", (raw: unknown) => {
    const input = z
      .object({
        repository,
        number: z.number().int().min(1),
        action: z.enum(
          pullRequestActions as [PullRequestAction, ...PullRequestAction[]],
        ),
        headSha: z
          .string()
          .regex(/^[0-9a-f]{7,64}$/i)
          .optional(),
        mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
      })
      .strict()
      .parse(raw);
    return pullRequestAction(input);
  });
  // Keeps this list and the bridge's in step.
  void githubMethods;
}
